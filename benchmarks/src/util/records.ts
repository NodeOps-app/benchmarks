import type { TaskResultRecord } from '@benchsdk/client';

/**
 * Platform records arrive in completion order, while the legacy result files
 * list iterations in launch order, so every legacy bridge orders records by
 * `taskIndex` before mapping them.
 */
export function byTaskIndex(records: TaskResultRecord[]): TaskResultRecord[] {
  return [...records].sort((a, b) => a.taskIndex - b.taskIndex);
}
