import { appRootPath } from "../utilities/app-root";
import { Cache } from "./cache";
import { ProjectGraph, Task } from '@nrwl/devkit';
import { DefaultTasksRunnerOptions } from "./default-tasks-runner";
import { getCommandArgs, getOutputs } from "./utils";
import { output } from "../utilities/output";
import { ChildProcess, fork } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { Workspaces } from "@nrwl/tao/src/shared/workspace";

export class ForkProcess {
  workspaceRoot = appRootPath;

  private readonly processes: ChildProcess[] = [];

  constructor(
    private readonly options: DefaultTasksRunnerOptions,
    private readonly cache: Cache,
    private readonly projectGraph: ProjectGraph,
    private readonly initiatingProject: string | undefined
  ) {
    this.setupOnProcessExitListener();
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

  fork(task: Task) {
    return this.pipeOutputCapture(task)
      ? this.forkProcessPipeOutputCapture(task)
      : this.forkProcessDirectOutputCapture(task);
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
        const args = getCommandArgs(task);
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
            if (this.cache.shouldCacheTask(outputPath, code)) {
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
        const args = getCommandArgs(task);
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
          if (this.cache.shouldCacheTask(outputPath, code)) {
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

  private signalToCode(signal: string) {
    if (signal === 'SIGHUP') return 128 + 1;
    if (signal === 'SIGINT') return 128 + 2;
    if (signal === 'SIGTERM') return 128 + 15;
    return 128;
  }

  private pipeOutputCapture(task: Task) {
    try {
      return this.readExecutor(task).schema.outputCapture === 'pipe';
    } catch (e) {
      return false;
    }
  }

  private readExecutor(task: Task) {
    const p = this.projectGraph.nodes[task.target.project];
    const b = p.data.targets[task.target.target].executor;
    const [nodeModule, executor] = b.split(':');

    const w = new Workspaces(this.workspaceRoot);
    return w.readExecutor(nodeModule, executor);
  }
}

function parseEnv(path: string) {
  try {
    const envContents = readFileSync(path);
    return dotenv.parse(envContents);
  } catch (e) {}
}
