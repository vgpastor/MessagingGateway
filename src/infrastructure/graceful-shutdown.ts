import { getLogger } from '../core/logger/logger.port.js';

/** Hard limit for the whole shutdown. The container stop timeout must leave room for it (`stop_grace_period`). */
export const SHUTDOWN_TOTAL_MS = 10_000;

/** Kept from the inbound step so that what the queue could not store still reaches the failed log in time. */
const WRITE_OFF_RESERVE_MS = 500;

export interface ShutdownStep {
  name: string;
  /** Longest this step may hold the shutdown back. It gets less if the total limit is closer. */
  maxMs: number;
  run: (budgetMs: number) => unknown;
}

export interface GatewayShutdownDeps {
  /** Stops accepting requests. Its pending requests are not waited for beyond the step's budget. */
  server: { close(): Promise<unknown> };
  stopSchedules(): void;
  /** Closes provider connections WITHOUT logging out: the next start resumes the same sessions. */
  closeProviders(): Promise<void>;
  inbound: { drain(timeoutMs: number): Promise<void> };
  webhooks: { drain(): Promise<void> };
  store?: { close(): Promise<void> };
}

/** What a gateway does on its way out, in order. The budgets add up to {@link SHUTDOWN_TOTAL_MS}. */
export function gatewayShutdownSteps(deps: GatewayShutdownDeps): ShutdownStep[] {
  return [
    {
      name: 'stop accepting requests',
      maxMs: 2_000,
      run: () => {
        deps.stopSchedules();
        return deps.server.close();
      },
    },
    { name: 'close provider connections', maxMs: 1_000, run: () => deps.closeProviders() },
    {
      name: 'drain the inbound queue',
      maxMs: 4_000,
      run: (budgetMs) => deps.inbound.drain(Math.max(budgetMs - WRITE_OFF_RESERVE_MS, 0)),
    },
    { name: 'drain webhooks', maxMs: 2_000, run: () => deps.webhooks.drain() },
    { name: 'close the message store', maxMs: 1_000, run: () => deps.store?.close() },
  ];
}

export interface GracefulShutdown {
  /** Whether a signal has already started the shutdown. */
  readonly started: boolean;
  /**
   * Runs the steps in order and exits, with 0 only if all went well. A second call while it runs
   * runs nothing. `failed` makes the exit code non-zero whatever the steps do, even on that second call.
   */
  run(signal: string, options?: { failed?: boolean }): Promise<void>;
}

export function createGracefulShutdown(
  steps: ShutdownStep[],
  options: { totalMs?: number; exit?: (code: number) => void } = {},
): GracefulShutdown {
  const totalMs = options.totalMs ?? SHUTDOWN_TOTAL_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;
  let failed = false;

  return {
    get started() {
      return started;
    },

    async run(signal, options) {
      const logger = getLogger();
      failed ||= options?.failed === true;
      if (started) {
        logger.warn('Already shutting down, signal ignored', { signal });
        return;
      }
      started = true;
      logger.info('Shutting down gracefully...', { signal });

      const deadline = Date.now() + totalMs;
      const hardStop = setTimeout(() => {
        logger.error('Shutdown limit reached, exiting now', { totalMs });
        exit(1);
      }, totalMs);

      let clean = true;
      for (const step of steps) {
        const budgetMs = Math.min(step.maxMs, deadline - Date.now());
        try {
          await withinBudget(step, budgetMs);
        } catch (err) {
          clean = false;
          logger.error('Shutdown step failed', { step: step.name, error: err instanceof Error ? err.message : String(err) });
        }
      }

      clearTimeout(hardStop);
      logger.info('Shutdown complete', { clean });
      exit(clean && !failed ? 0 : 1);
    },
  };
}

/**
 * Whatever escapes every handler ends the process, since its state can no longer be trusted. It goes through
 * the shutdown, so that what was accepted is not lost; before there is one there is nothing to save.
 */
export function exitOnCrash(
  getShutdown: () => GracefulShutdown | undefined,
  options: { target?: Pick<NodeJS.EventEmitter, 'on'>; exit?: (code: number) => void } = {},
): void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const crashed = (event: string) => (err: unknown) => {
    getLogger().error(`Crash: ${event}`, {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const shutdown = getShutdown();
    if (shutdown) void shutdown.run(event, { failed: true });
    else exit(1);
  };

  target.on('unhandledRejection', crashed('unhandledRejection'));
  target.on('uncaughtException', crashed('uncaughtException'));
}

async function withinBudget(step: ShutdownStep, budgetMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => step.run(budgetMs)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${budgetMs} ms`)), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
