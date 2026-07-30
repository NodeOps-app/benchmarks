/**
 * Accumulates one text log per worker across a task's steps, uploaded once as a
 * `coordinator.log` artifact. Used by the runner's manual `round` mode, where
 * `client.runWorker` (which owns log upload in `participant` mode) is not in
 * play.
 */
export interface StepOutcome {
  stdout?: string;
  stderr?: string;
  error?: string;
}

export class LogBuffer {
  private readonly lines: string[] = [];

  step(taskIndex: number, stepName: string, outcome: StepOutcome): void {
    const header = `[task ${taskIndex}] ${stepName}`;
    this.lines.push(`${new Date().toISOString()} ${header}`);
    if (outcome.stdout?.trim()) {
      this.lines.push(indent(outcome.stdout));
    }
    if (outcome.stderr?.trim()) {
      this.lines.push(indent(outcome.stderr, 'stderr: '));
    }
    if (outcome.error) {
      this.lines.push(indent(outcome.error, 'error: '));
    }
  }

  /** Appends a free-form narration line (backs the task context's `log`). */
  line(message: string, meta?: Record<string, unknown>): void {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    this.lines.push(`${new Date().toISOString()} ${message}${suffix}`);
  }

  isEmpty(): boolean {
    return this.lines.length === 0;
  }

  toText(): string {
    return this.lines.join('\n') + '\n';
  }
}

function indent(text: string, prefix = ''): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => `  ${prefix}${line}`)
    .join('\n');
}
