import type { DefineStepOptions, RunWorkerContext } from '@benchsdk/client';
import type { LogBuffer } from './log-buffer.js';

/**
 * Runs `fn` through both the platform step reporter and the local log buffer,
 * so failures show up in both places without duplicating the try/catch at
 * every call site.
 */
export async function loggedStep<T>(
  ctx: RunWorkerContext,
  logBuffer: LogBuffer,
  name: string,
  fn: () => Promise<T> | T,
  options?: DefineStepOptions,
): Promise<T> {
  try {
    const result = await ctx.step(name, fn, options);
    logBuffer.step(ctx.taskIndex, name, {});
    return result;
  } catch (error) {
    logBuffer.step(ctx.taskIndex, name, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
