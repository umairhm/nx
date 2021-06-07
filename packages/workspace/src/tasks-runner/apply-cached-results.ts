import { DefaultTasksRunnerOptions } from './default-tasks-runner';
import { Cache, TaskWithCachedResult } from './cache';
import { ProjectGraph } from '@nrwl/devkit';
import { getCommandArgs, getOutputs } from './utils';
import { output } from '../utilities/output';
import { TaskCacheStatus } from '../utilities/output';

export class ApplyCachedResults {
  constructor(
    private readonly options: DefaultTasksRunnerOptions,
    private readonly hideCachedOutput: boolean,
    private readonly cache: Cache,
    private readonly projectGraph: ProjectGraph,
    private readonly initiatingProject: String
  ) {}

  apllyForTask(t: TaskWithCachedResult) {
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
      const args = getCommandArgs(t.task);
      output.logCommand(
        `nx ${args.join(' ')}`,
        shouldCopyOutputsFromCache
          ? TaskCacheStatus.RetrievedFromCache
          : TaskCacheStatus.MatchedExistingOutput
      );
      process.stdout.write(t.cachedResult.terminalOutput);
    }
    this.options.lifeCycle.endTask(t.task, t.cachedResult.code);
  }
}
