import type { TaskGraph } from '@nrwl/devkit';

export enum BatchMessageType {
  Tasks,
  Complete,
}

export interface BatchTasksMessage {
  type: BatchMessageType.Tasks;
  executorName: string;
  taskGraph: TaskGraph;
}

export interface BatchCompleteMessage {
  type: BatchMessageType.Complete;
  /**
   * Results of running the batch. Mapped from task id to results
   */
  results: Record<string, { success: true; terminalOutput: string }>;
}

export type BatchMessage = BatchTasksMessage | BatchCompleteMessage;
