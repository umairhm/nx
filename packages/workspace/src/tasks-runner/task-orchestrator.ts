import { Workspaces } from '@nrwl/tao/src/shared/workspace';
import { join } from 'path';
import type { ProjectGraph, Task, TaskGraph } from '@nrwl/devkit';
import { appRootPath } from '../utilities/app-root';
import { Cache, TaskWithCachedResult } from './cache';
import { DefaultTasksRunnerOptions } from './default-tasks-runner';
import { AffectedEventType } from './tasks-runner';
import { calculateReverseDeps, getOutputs } from './utils';
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
import { ForkProcess } from './fork-process';
import { ApplyCachedResults } from './apply-cached-results';

interface Batch {
  executorName: string;
  taskGraph: TaskGraph;
}

interface CompletedTasks {
  [id: string]: "success" | "failure" | "skipped" | "cache";
}

export class TaskOrchestrator {
  workspaceRoot = appRootPath;
  workspace = new Workspaces(this.workspaceRoot);
  timings: { [target: string]: { start: number; end: number } } = {};
  completedTasks: CompletedTasks = {};
  inProgressTasks: {
    [id: string]: boolean;
  } = {};
  private startedTasks = new Set<string>();
  private notScheduledTaskGraph: TaskGraph;
  scheduledTasks: string[] = [];
  waitingForTasks: Function[] = [];
  reverseTaskDeps: Record<string, string[]> = calculateReverseDeps(
    this.taskGraph
  );
  cache = new Cache(this.options);

  private readonly forkProcess = new ForkProcess(
    this.options,
    this.cache,
    this.projectGraph,
    this.initiatingProject
  );

  private readonly applyCachedResults = new ApplyCachedResults(
    this.options,
    this.hideCachedOutput,
    this.cache,
    this.projectGraph,
    this.initiatingProject
  );

  constructor(
    private readonly hasher: Hasher,
    private readonly taskGraphCreator: TaskGraphCreator,
    private readonly initiatingProject: string | undefined,
    private readonly projectGraph: ProjectGraph,
    private readonly taskGraph: TaskGraph,
    private readonly options: DefaultTasksRunnerOptions,
    private readonly hideCachedOutput: boolean
  ) {}

  async run() {
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
            await this.applyCachedResultsForTask({ task, cachedResult });
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
          if (this.cache.shouldCacheTask(outputPath, code)) {
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
        await this.applyCachedResultsForTask({ task, cachedResult });

        return takeFromQueue();
      }

      this.storeStartTime(task);
      try {
        const code = await this.forkProcess.fork(task);

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

    return convertToTaskRunnerOutput(this.taskGraph, this.completedTasks);
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

  private async applyCachedResultsForTask(t: TaskWithCachedResult) {
    this.storeStartTime(t.task);
    this.applyCachedResults.apllyForTask(t);
    this.storeEndTime(t.task);

    await this.complete([
      {
        taskId: t.task.id,
        status: 'cache',
      },
    ]);
  }

  protected storeStartTime(t: Task) {
    this.timings[`${t.target.project}:${t.target.target}`] = {
      start: new Date().getTime(),
      end: undefined,
    };
  }

  protected storeEndTime(t: Task) {
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

function convertToTaskRunnerOutput(taskGraph: TaskGraph, completedTasks: CompletedTasks) {
  return Object.keys(completedTasks).map((taskId) => {
    if (completedTasks[taskId] === 'cache') {
      return {
        task: taskGraph.tasks[taskId],
        type: AffectedEventType.TaskCacheRead,
        success: true,
      };
    } else if (completedTasks[taskId] === 'success') {
      return {
        task: taskGraph.tasks[taskId],
        type: AffectedEventType.TaskComplete,
        success: true,
      };
    } else if (completedTasks[taskId] === 'failure') {
      return {
        task: taskGraph.tasks[taskId],
        type: AffectedEventType.TaskComplete,
        success: false,
      };
    } else if (completedTasks[taskId] === 'skipped') {
      return {
        task: taskGraph.tasks[taskId],
        type: AffectedEventType.TaskDependencyFailed,
        success: false,
      };
    }
  });
}
