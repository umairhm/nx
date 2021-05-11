import { Workspaces } from '@nrwl/tao/src/shared/workspace';
import { ChildProcess, fork } from 'child_process';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import type { ProjectGraph, Task, TaskGraph } from '@nrwl/devkit';
import { appRootPath } from '../utilities/app-root';
import { output, TaskCacheStatus } from '../utilities/output';
import { Cache, TaskWithCachedResult } from './cache';
import { DefaultTasksRunnerOptions } from './default-tasks-runner';
import { AffectedEventType } from './tasks-runner';
import { getOutputs, unparse } from './utils';
import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';
import {
  BatchCompleteMessage,
  BatchMessage,
  BatchMessageType,
  BatchTasksMessage,
} from './batch-messages';
import { TaskGraphCreator } from './task-graph-creator';
import { Hasher } from '../core/hasher/hasher';

interface Batch {
  executorName: string;
  taskGraph: TaskGraph;
}

export class TaskOrchestrator {
  workspaceRoot = appRootPath;

  workspace = new Workspaces(this.workspaceRoot);
  cache = new Cache(this.options);
  timings: { [target: string]: { start: number; end: number } } = {};
  completedTasks: {
    [id: string]: 'success' | 'failure' | 'skipped' | 'cache';
  } = {};
  inProgressTasks: {
    [id: string]: boolean;
  } = {};
  private startedTasks = new Set<string>();
  private notScheduledTaskGraph: TaskGraph;
  scheduledTasks: string[] = [];
  waitingForTasks: Function[] = [];
  reverseTaskDeps: Record<string, string[]> = {};

  private processes: ChildProcess[] = [];

  constructor(
    private readonly hasher: Hasher,
    private readonly taskGraphCreator: TaskGraphCreator,
    private readonly initiatingProject: string | undefined,
    private readonly projectGraph: ProjectGraph,
    private readonly taskGraph: TaskGraph,
    private readonly options: DefaultTasksRunnerOptions,
    private readonly hideCachedOutput: boolean
  ) {
    this.setupOnProcessExitListener();
  }

  async run() {
    this.reverseTaskDeps = this.calculateReverseDeps(this.taskGraph);
    this.notScheduledTaskGraph = this.taskGraph;
    await this.scheduleNextTasks();
    performance.mark('task-execution-begins');
    const res = await this.runTasks();
    performance.mark('task-execution-ends');
    performance.measure(
      'command-execution',
      'task-execution-begins',
      'task-execution-ends'
    );
    this.cache.removeOldCacheRecords();
    return res;
  }

  private canBeScheduled(task: Task) {
    return this.allDepsAreSuccessful(task.id);
  }

  private async scheduleNextTasks() {
    if (process.env.NX_BATCH_MODE === 'true') {
      this.scheduleBatches();
    }
    for (let root of this.notScheduledTaskGraph.roots) {
      await this.scheduleTask(root);
    }
  }

  private calculateReverseDeps(taskGraph: TaskGraph): Record<string, string[]> {
    const reverseTaskDeps: Record<string, string[]> = {};
    Object.keys(taskGraph.tasks).forEach((t) => {
      reverseTaskDeps[t] = [];
    });

    Object.keys(taskGraph.dependencies).forEach((taskId) => {
      taskGraph.dependencies[taskId].forEach((d) => {
        reverseTaskDeps[d].push(taskId);
      });
    });

    return reverseTaskDeps;
  }

  private nextBatch(): Batch {
    return this.scheduledBatches.length > 0
      ? this.scheduledBatches.pop()
      : null;
  }

  private nextTask() {
    if (this.scheduledTasks.length > 0) {
      return this.taskGraph.tasks[this.scheduledTasks.pop()];
    } else {
      return null;
    }
  }

  private async complete(
    taskResults: {
      taskId: string;
      status: 'success' | 'failure' | 'skipped' | 'cache';
    }[]
  ) {
    for (const { taskId, status } of taskResults) {
      if (this.completedTasks[taskId] === undefined) {
        this.completedTasks[taskId] = status;

        if (status === 'failure' || status === 'skipped') {
          this.notScheduledTaskGraph = removeTasksFromTaskGraph(
            this.notScheduledTaskGraph,
            this.reverseTaskDeps[taskId]
          );
          await this.complete(
            this.reverseTaskDeps[taskId].map((id) => ({
              taskId: id,
              status: 'skipped',
            }))
          );
        }
      }
    }
    await this.scheduleNextTasks();
    // release blocked threads
    this.waitingForTasks.forEach((f) => f(null));
    this.waitingForTasks.length = 0;
  }

  private async scheduleTask(taskId: string) {
    const task = this.taskGraph.tasks[taskId];
    if (!this.inProgressTasks[taskId] && this.canBeScheduled(task)) {
      this.inProgressTasks[taskId] = true;
      const { value, details } = await this.hashTask(task);
      task.hash = value;
      task.hashDetails = details;

      this.notScheduledTaskGraph = removeTasksFromTaskGraph(
        this.notScheduledTaskGraph,
        [taskId]
      );
      this.scheduledTasks.push(taskId);
      // TODO vsavkin: remove the if statement after Nx 14 is out
      if (this.options.lifeCycle.scheduleTask) {
        this.options.lifeCycle.scheduleTask(task);
      }
    }
  }

  private allDepsAreSuccessful(taskId: string) {
    for (let t of this.taskGraph.dependencies[taskId]) {
      if (
        this.completedTasks[t] !== 'success' &&
        this.completedTasks[t] !== 'cache'
      )
        return false;
    }
    return true;
  }

  private allDepsAreCompleted(taskId: string) {
    for (let t of this.taskGraph.dependencies[taskId]) {
      if (this.completedTasks[t] === undefined) return false;
    }
    return true;
  }

  private async hashTask(task: Task) {
    const hasher = this.customHasher(task);
    if (hasher) {
      return hasher(task, this.taskGraph, this.hasher);
    } else {
      return this.hasher.hashTaskWithDepsAndContext(task);
    }
  }

  private async runTasks() {
    const takeFromQueue = async () => {
      // completed all the tasks
      if (
        this.scheduledBatches.length === 0 &&
        this.scheduledTasks.length === 0 &&
        Object.keys(this.notScheduledTaskGraph.tasks).length === 0
      ) {
        return null;
      }

      const doNotSkipCache =
        this.options.skipNxCache === false ||
        this.options.skipNxCache === undefined;

      const batch = this.nextBatch();
      if (batch) {
        const rest: Task[] = [];

        for (const rootTask of batch.taskGraph.roots.map(
          (rootTaskId) => this.taskGraph.tasks[rootTaskId]
        )) {
          const { value, details } = await this.hashTask(rootTask);
          rootTask.hash = value;
          rootTask.hashDetails = details;
        }

        for (const task of Object.values(batch.taskGraph.tasks)) {
          const cachedResult = await this.cache.get(task);

          if (cachedResult && cachedResult.code === 0 && doNotSkipCache) {
            await this.applyCachedResult({ task, cachedResult });
          } else {
            rest.push(task);
          }
        }

        if (rest.length < 1) {
          return takeFromQueue();
        }

        if ('startTasks' in this.options.lifeCycle) {
          this.options.lifeCycle.startTasks(rest);
        } else {
          for (const task of rest) {
            if (!this.startedTasks.has(task.id)) {
              this.storeStartTime(task);
              this.options.lifeCycle.startTask(task);
              this.startedTasks.add(task.id);
            }
          }
        }

        const taskGraph = this.taskGraphCreator.createTaskGraph(rest);
        const batchResult = await this.runBatchWithAWorker({
          executorName: batch.executorName,
          taskGraph,
        });
        const batchResultEntries = Object.entries(batchResult.results);

        for (const [taskId, result] of batchResultEntries) {
          const task = this.taskGraph.tasks[taskId];
          this.storeEndTime(task);

          const code = result.success ? 0 : -1;
          const outputPath = this.cache.temporaryOutputPath(task);

          const taskOutputs = getOutputs(this.projectGraph.nodes, task);
          if (this.shouldCacheTask(outputPath, code)) {
            const { value, details } = await this.hashTask(task);
            task.hash = value;
            task.hashDetails = details;
            await this.cache.put(
              task,
              result.terminalOutput,
              taskOutputs,
              code
            );
          }
          this.cache.recordOutputsHash(taskOutputs, task.hash);
          if (!('endTasks' in this.options.lifeCycle)) {
            this.options.lifeCycle.endTask(task, code);
          }
        }
        if ('endTasks' in this.options.lifeCycle) {
          this.options.lifeCycle.endTasks(
            batchResultEntries.map(([taskId, result]) => ({
              task: this.taskGraph.tasks[taskId],
              code: result.success ? 0 : -1,
            }))
          );
        }
        await this.complete(
          batchResultEntries.map(([taskId, taskResult]) => ({
            taskId,
            status: taskResult.success ? 'success' : 'failure',
          }))
        );
        const notRunRoots = taskGraph.roots.filter(
          (rootTaskId) => !batchResult.results[rootTaskId]
        );
        if (notRunRoots.length > 0) {
          throw new Error(
            'Batch Executors MUST run all roots of the task graph'
          );
        }
        const notRunTasks = Object.keys(taskGraph.tasks)
          .filter((taskId) => !batchResult.results[taskId])
          .map((taskId) => this.taskGraph.tasks[taskId]);
        if (notRunTasks.length > 0) {
          this.scheduledBatches.push({
            executorName: batch.executorName,
            taskGraph: this.taskGraphCreator.createTaskGraph(notRunTasks),
          });
        }
        return takeFromQueue();
      }
      const task = this.nextTask();
      if (!task) {
        // block until some other task completes, then try again
        return new Promise((res) => this.waitingForTasks.push(res)).then(
          takeFromQueue
        );
      }

      const cachedResult = await this.cache.get(task);
      if (cachedResult && cachedResult.code === 0 && doNotSkipCache) {
        await this.applyCachedResult({ task, cachedResult });

        return takeFromQueue();
      }

      this.storeStartTime(task);
      try {
        const code = this.pipeOutputCapture(task)
          ? await this.forkProcessPipeOutputCapture(task)
          : await this.forkProcessDirectOutputCapture(task);

        this.storeEndTime(task);
        await this.complete([
          {
            taskId: task.id,
            status: code === 0 ? 'success' : 'failure',
          },
        ]);
        return takeFromQueue();
      } catch {
        await this.complete([
          {
            taskId: task.id,
            status: 'failure',
          },
        ]);
        return takeFromQueue();
      }
    };

    const wait = [];
    // // initial seeding
    const maxParallel = this.options.parallel
      ? this.options.maxParallel || 3
      : 1;
    for (let i = 0; i < maxParallel; ++i) {
      wait.push(takeFromQueue());
    }

    await Promise.all(wait);

    return Object.keys(this.completedTasks).map((taskId) => {
      if (this.completedTasks[taskId] === 'cache') {
        return {
          task: this.taskGraph.tasks[taskId],
          type: AffectedEventType.TaskCacheRead,
          success: true,
        };
      } else if (this.completedTasks[taskId] === 'success') {
        return {
          task: this.taskGraph.tasks[taskId],
          type: AffectedEventType.TaskComplete,
          success: true,
        };
      } else if (this.completedTasks[taskId] === 'failure') {
        return {
          task: this.taskGraph.tasks[taskId],
          type: AffectedEventType.TaskComplete,
          success: false,
        };
      } else if (this.completedTasks[taskId] === 'skipped') {
        return {
          task: this.taskGraph.tasks[taskId],
          type: AffectedEventType.TaskDependencyFailed,
          success: false,
        };
      }
    });
  }

  private runBatchWithAWorker({ executorName, taskGraph }: Batch) {
    const workerPath = join(__dirname, './batch-worker.js');
    const worker = new Worker(workerPath);

    const message: BatchTasksMessage = {
      type: BatchMessageType.Tasks,
      taskGraph,
      executorName,
    };
    worker.postMessage(message);

    return new Promise<BatchCompleteMessage>((res) => {
      worker.on('message', (message: BatchMessage) => {
        switch (message.type) {
          case BatchMessageType.Complete: {
            res(message);
            worker.terminate();
          }
        }
      });
    });
  }

  private async applyCachedResult(t: TaskWithCachedResult) {
    this.storeStartTime(t.task);
    this.options.lifeCycle.startTask(t.task);
    const outputs = getOutputs(this.projectGraph.nodes, t.task);
    const shouldCopyOutputsFromCache = this.cache.shouldCopyOutputsFromCache(
      t,
      outputs
    );
    if (shouldCopyOutputsFromCache) {
      this.cache.copyFilesFromCache(t.task.hash, t.cachedResult, outputs);
    }
    if (
      (!this.initiatingProject ||
        this.initiatingProject === t.task.target.project) &&
      !this.hideCachedOutput
    ) {
      const args = this.getCommandArgs(t.task);
      output.logCommand(
        `nx ${args.join(' ')}`,
        shouldCopyOutputsFromCache
          ? TaskCacheStatus.RetrievedFromCache
          : TaskCacheStatus.MatchedExistingOutput
      );
      process.stdout.write(t.cachedResult.terminalOutput);
    }
    this.options.lifeCycle.endTask(t.task, t.cachedResult.code);
    this.storeEndTime(t.task);
    await this.complete([
      {
        taskId: t.task.id,
        status: 'cache',
      },
    ]);
  }

  private storeStartTime(t: Task) {
    this.timings[`${t.target.project}:${t.target.target}`] = {
      start: new Date().getTime(),
      end: undefined,
    };
  }

  private storeEndTime(t: Task) {
    this.timings[
      `${t.target.project}:${t.target.target}`
    ].end = new Date().getTime();
  }

  private getExecutorName(task: Task): string {
    return this.projectGraph.nodes[task.target.project].data.targets[
      task.target.target
    ].executor;
  }

  private getExecutorSchema(task: Task) {
    const [nodeModule, executorName] = this.getExecutorName(task).split(':');
    return this.workspace.readExecutor(nodeModule, executorName);
  }

  private pipeOutputCapture(task: Task) {
    try {
      return this.readExecutor(task).schema.outputCapture === 'pipe';
    } catch (e) {
      return false;
    }
  }

  private customHasher(task: Task) {
    try {
      const f = this.readExecutor(task).hasherFactory;
      return f ? f() : null;
    } catch (e) {
      console.error(e);
      throw new Error(`Unable to load hasher for task "${task.id}"`);
    }
  }

  private readExecutor(task: Task) {
    const p = this.projectGraph.nodes[task.target.project];
    const b = p.data.targets[task.target.target].executor;
    const [nodeModule, executor] = b.split(':');

    const w = new Workspaces(this.workspaceRoot);
    return w.readExecutor(nodeModule, executor);
  }

  private forkProcessPipeOutputCapture(task: Task) {
    const taskOutputs = getOutputs(this.projectGraph.nodes, task);
    const outputPath = this.cache.temporaryOutputPath(task);
    return new Promise((res, rej) => {
      try {
        this.options.lifeCycle.startTask(task);
        const forwardOutput = this.shouldForwardOutput(outputPath, task);
        const env = this.envForForkedProcess(
          task,
          undefined,
          forwardOutput,
          process.env.FORCE_COLOR === undefined
            ? 'true'
            : process.env.FORCE_COLOR
        );
        const args = this.getCommandArgs(task);
        const commandLine = `nx ${args.join(' ')}`;

        if (forwardOutput) {
          output.logCommand(commandLine);
        }
        this.cache.removeRecordedOutputsHashes(taskOutputs);
        const p = fork(this.getCommand(), args, {
          stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
          env,
        });
        this.processes.push(p);
        let out = [];
        let outWithErr = [];
        p.stdout.on('data', (chunk) => {
          if (forwardOutput) {
            process.stdout.write(chunk);
          }
          out.push(chunk.toString());
          outWithErr.push(chunk.toString());
        });
        p.stderr.on('data', (chunk) => {
          if (forwardOutput) {
            process.stderr.write(chunk);
          }
          outWithErr.push(chunk.toString());
        });

        p.on('exit', (code, signal) => {
          if (code === null) code = this.signalToCode(signal);
          // we didn't print any output as we were running the command
          // print all the collected output|
          if (!forwardOutput) {
            output.logCommand(commandLine);
            process.stdout.write(outWithErr.join(''));
          }
          if (outputPath) {
            const terminalOutput = outWithErr.join('');
            writeFileSync(outputPath, terminalOutput);
            if (this.shouldCacheTask(outputPath, code)) {
              this.cache
                .put(task, terminalOutput, taskOutputs, code)
                .then(() => {
                  this.cache.recordOutputsHash(taskOutputs, task.hash);
                  this.options.lifeCycle.endTask(task, code);
                  res(code);
                })
                .catch((e) => {
                  rej(e);
                });
            } else {
              this.cache.recordOutputsHash(taskOutputs, task.hash);
              this.options.lifeCycle.endTask(task, code);
              res(code);
            }
          } else {
            this.cache.recordOutputsHash(taskOutputs, task.hash);
            this.options.lifeCycle.endTask(task, code);
            res(code);
          }
        });
      } catch (e) {
        console.error(e);
        rej(e);
      }
    });
  }

  private forkProcessDirectOutputCapture(task: Task) {
    const taskOutputs = getOutputs(this.projectGraph.nodes, task);
    const outputPath = this.cache.temporaryOutputPath(task);
    return new Promise((res, rej) => {
      try {
        this.options.lifeCycle.startTask(task);
        const forwardOutput = this.shouldForwardOutput(outputPath, task);
        const env = this.envForForkedProcess(
          task,
          outputPath,
          forwardOutput,
          undefined
        );
        const args = this.getCommandArgs(task);
        const commandLine = `nx ${args.join(' ')}`;

        if (forwardOutput) {
          output.logCommand(commandLine);
        }
        this.cache.removeRecordedOutputsHashes(taskOutputs);
        const p = fork(this.getCommand(), args, {
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          env,
        });
        this.processes.push(p);
        p.on('exit', (code, signal) => {
          if (code === null) code = this.signalToCode(signal);
          // we didn't print any output as we were running the command
          // print all the collected output
          if (!forwardOutput) {
            output.logCommand(commandLine);
            const terminalOutput = this.readTerminalOutput(outputPath);
            if (terminalOutput) {
              process.stdout.write(terminalOutput);
            } else {
              console.error(
                `Nx could not find process's output. Run the command without --parallel.`
              );
            }
          }
          // we don't have to worry about this statement. code === 0 guarantees the file is there.
          if (this.shouldCacheTask(outputPath, code)) {
            this.cache
              .put(task, this.readTerminalOutput(outputPath), taskOutputs, code)
              .then(() => {
                this.cache.recordOutputsHash(taskOutputs, task.hash);
                this.options.lifeCycle.endTask(task, code);
                res(code);
              })
              .catch((e) => {
                rej(e);
              });
          } else {
            this.cache.recordOutputsHash(taskOutputs, task.hash);
            this.options.lifeCycle.endTask(task, code);
            res(code);
          }
        });
      } catch (e) {
        console.error(e);
        rej(e);
      }
    });
  }

  private readTerminalOutput(outputPath: string) {
    try {
      return readFileSync(outputPath).toString();
    } catch (e) {
      return null;
    }
  }

  private shouldCacheTask(outputPath: string | null, code: number) {
    // TODO: vsavkin make caching failures the default in Nx 12.1
    if (process.env.NX_CACHE_FAILURES == 'true') {
      return outputPath;
    } else {
      return outputPath && code === 0;
    }
  }

  private envForForkedProcess(
    task: Task,
    outputPath: string,
    forwardOutput: boolean,
    forceColor: string
  ) {
    const envsFromFiles = {
      ...parseEnv('.env'),
      ...parseEnv('.local.env'),
      ...parseEnv('.env.local'),
      ...parseEnv(`${task.projectRoot}/.env`),
      ...parseEnv(`${task.projectRoot}/.local.env`),
      ...parseEnv(`${task.projectRoot}/.env.local`),
    };

    const env: NodeJS.ProcessEnv = {
      ...envsFromFiles,
      FORCE_COLOR: forceColor,
      ...process.env,
      NX_TASK_HASH: task.hash,
      NX_INVOKED_BY_RUNNER: 'true',
      NX_WORKSPACE_ROOT: this.workspaceRoot,
    };

    if (outputPath) {
      env.NX_TERMINAL_OUTPUT_PATH = outputPath;
      if (this.options.captureStderr) {
        env.NX_TERMINAL_CAPTURE_STDERR = 'true';
      }
      // TODO: remove this once we have a reasonable way to configure it
      if (task.target.target === 'test') {
        env.NX_TERMINAL_CAPTURE_STDERR = 'true';
      }
      if (forwardOutput) {
        env.NX_FORWARD_OUTPUT = 'true';
      }
    }
    return env;
  }

  private shouldForwardOutput(outputPath: string | undefined, task: Task) {
    if (!outputPath) return true;
    if (!this.options.parallel) return true;
    if (task.target.project === this.initiatingProject) return true;
    return false;
  }

  private getCommand() {
    const cli = require.resolve(`@nrwl/cli/lib/run-cli.js`, {
      paths: [this.workspaceRoot],
    });
    return `${cli}`;
  }

  private getCommandArgs(task: Task) {
    const args: string[] = unparse(task.overrides || {});

    const config = task.target.configuration
      ? `:${task.target.configuration}`
      : '';

    return [
      'run',
      `${task.target.project}:${task.target.target}${config}`,
      ...args,
    ];
  }

  private setupOnProcessExitListener() {
    process.on('SIGINT', () => {
      this.processes.forEach((p) => {
        p.kill('SIGTERM');
      });
      // we exit here because we don't need to write anything to cache.
      process.exit();
    });
    process.on('SIGTERM', () => {
      this.processes.forEach((p) => {
        p.kill('SIGTERM');
      });
      // no exit here because we expect child processes to terminate which
      // will store results to the cache and will terminate this process
    });
    process.on('SIGHUP', () => {
      this.processes.forEach((p) => {
        p.kill('SIGTERM');
      });
      // no exit here because we expect child processes to terminate which
      // will store results to the cache and will terminate this process
    });
  }

  private signalToCode(signal: string) {
    if (signal === 'SIGHUP') return 128 + 1;
    if (signal === 'SIGINT') return 128 + 2;
    if (signal === 'SIGTERM') return 128 + 15;
    return 128;
  }

  private processTaskForBatches(
    batches: Record<string, TaskGraph>,
    task: Task,
    rootExecutorName: string,
    isRoot: boolean
  ) {
    const executorName = this.getExecutorName(task);
    if (rootExecutorName !== executorName) {
      return;
    }

    if (!this.getExecutorSchema(task).batchImplementationFactory) {
      return;
    }

    const batch = (batches[rootExecutorName] =
      batches[rootExecutorName] ??
      ({
        tasks: {},
        dependencies: {},
        roots: [],
      } as TaskGraph));

    batch.tasks[task.id] = task;
    batch.dependencies[task.id] = this.taskGraph.dependencies[task.id];
    if (isRoot) {
      batch.roots.push(task.id);
    }

    for (const dep of this.reverseTaskDeps[task.id]) {
      const depTask = this.taskGraph.tasks[dep];
      this.processTaskForBatches(batches, depTask, rootExecutorName, false);
    }
  }

  private scheduledBatches: Batch[] = [];

  private scheduleBatch({ executorName, taskGraph }: Batch) {
    // Create a new task graph without the tasks that are being scheduled as part of this batch
    this.notScheduledTaskGraph = removeTasksFromTaskGraph(
      this.notScheduledTaskGraph,
      Object.keys(taskGraph.tasks)
    );

    this.scheduledBatches.push({ executorName, taskGraph });
  }

  private scheduleBatches() {
    const batchMap: Record<string, TaskGraph> = {};
    for (const root of this.notScheduledTaskGraph.roots) {
      const rootTask = this.notScheduledTaskGraph.tasks[root];
      if (this.canBeScheduled(rootTask)) {
        const executorName = this.getExecutorName(rootTask);
        this.processTaskForBatches(batchMap, rootTask, executorName, true);
      }
    }
    for (const [executorName, taskGraph] of Object.entries(batchMap)) {
      this.scheduleBatch({ executorName, taskGraph });
    }
  }
}

function removeTasksFromTaskGraph(graph: TaskGraph, ids: string[]): TaskGraph {
  const tasks = {};
  const dependencies = {};
  const removedSet = new Set(ids);
  for (let taskId of Object.keys(graph.tasks)) {
    if (!removedSet.has(taskId)) {
      tasks[taskId] = graph.tasks[taskId];
      dependencies[taskId] = graph.dependencies[taskId].filter(
        (depTaskId) => !removedSet.has(depTaskId)
      );
    }
  }
  return {
    tasks,
    dependencies: dependencies,
    roots: Object.keys(dependencies).filter(
      (k) => dependencies[k].length === 0
    ),
  };
}

function parseEnv(path: string) {
  try {
    const envContents = readFileSync(path);
    return dotenv.parse(envContents);
  } catch (e) {}
}
