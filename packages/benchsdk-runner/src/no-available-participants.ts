/**
 * Thrown when every selected participant was env-gated out, i.e. none of their
 * `requiredEnvVars` are set. This is a "nothing to do" outcome rather than a
 * failure — a benchmark job for a provider whose credentials aren't provisioned
 * should skip, not go red — so callers are expected to exit 0 on it.
 */
export class NoAvailableParticipantsError extends Error {
  readonly skipped: { name: string; missing: string[] }[];

  constructor(skipped: { name: string; missing: string[] }[]) {
    super(
      `No participants have their required env vars set — nothing to run${
        skipped.length > 0 ? ` (skipped: ${skipped.map((s) => s.name).join(', ')})` : ''
      }.`,
    );
    this.name = 'NoAvailableParticipantsError';
    this.skipped = skipped;
  }
}
