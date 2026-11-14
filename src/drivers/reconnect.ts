/**
 * Exponential-backoff reconnection, shared by drivers.
 */

/** Reconnection configuration */
export interface ReconnectConfig {
  enabled?: boolean;
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
}

/**
 * Schedules reconnection attempts and reports them as
 * `reconnect:scheduled|attempting|success|error|failed` events.
 */
export class ReconnectPolicy {
  readonly config: Required<ReconnectConfig>;
  attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ReconnectConfig | undefined, private readonly emit: (event: string, data: unknown) => unknown) {
    this.config = {
      enabled: config?.enabled ?? true,
      maxAttempts: config?.maxAttempts ?? 10,
      initialDelay: config?.initialDelay ?? 1000,
      maxDelay: config?.maxDelay ?? 30000,
      backoffFactor: config?.backoffFactor ?? 2,
    };
  }

  get scheduled(): boolean {
    return this.timer !== null;
  }

  /**
   * Schedule `attempt` after the next backoff delay. If it fails and
   * `shouldRetry()` still holds, the next attempt is scheduled.
   */
  schedule(attempt: () => Promise<void>, shouldRetry: () => boolean): void {
    if (this.timer) return;
    if (this.attempts >= this.config.maxAttempts) {
      this.emit('reconnect:failed', { attempts: this.attempts, maxAttempts: this.config.maxAttempts });
      return;
    }
    const delay = Math.min(
      this.config.initialDelay * Math.pow(this.config.backoffFactor, this.attempts),
      this.config.maxDelay,
    );
    this.attempts++;
    this.emit('reconnect:scheduled', { attempt: this.attempts, maxAttempts: this.config.maxAttempts, delay });

    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit('reconnect:attempting', { attempt: this.attempts, maxAttempts: this.config.maxAttempts });
      attempt().then(
        () => this.emit('reconnect:success', { attempts: this.attempts }),
        (error) => this.failed(error, attempt, shouldRetry),
      );
    }, delay);
  }

  /** Report a failed (re)connection and retry if allowed. */
  failed(error: unknown, attempt: () => Promise<void>, shouldRetry: () => boolean): void {
    this.emit('reconnect:error', { error, attempt: this.attempts });
    if (this.config.enabled && shouldRetry()) this.schedule(attempt, shouldRetry);
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (!enabled) this.cancel();
  }

  configure(options: Partial<ReconnectConfig>): void {
    for (const key of ['maxAttempts', 'initialDelay', 'maxDelay', 'backoffFactor'] as const) {
      if (options[key] !== undefined) this.config[key] = options[key]!;
    }
    if (options.enabled !== undefined) this.setEnabled(options.enabled);
  }

  snapshot(): Required<ReconnectConfig> & { attempts: number; scheduled: boolean } {
    return { ...this.config, attempts: this.attempts, scheduled: this.scheduled };
  }
}
