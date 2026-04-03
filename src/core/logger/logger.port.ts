/**
 * Logger port — all layers use this abstraction.
 * Never import console, pino, or fastify.log directly.
 *
 * Supports structured logging with context objects and child loggers.
 */
export interface Logger {
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
  debug(msg: string, context?: Record<string, unknown>): void;

  /** Create a child logger with fixed context fields */
  child(context: Record<string, unknown>): Logger;
}

/**
 * Global logger instance — set once at startup via setGlobalLogger().
 * All code uses getLogger() to get the current instance.
 */
let globalLogger: Logger = createConsoleLogger();

export function getLogger(): Logger {
  return globalLogger;
}

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger;
}

/** Fallback console-based logger (used before Pino is initialized) */
function createConsoleLogger(): Logger {
  return {
    info: (msg, ctx) => console.log(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    warn: (msg, ctx) => console.warn(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    error: (msg, ctx) => console.error(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    debug: (msg, ctx) => console.debug(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    child: (context) => ({
      info: (msg, ctx) => console.log(ctx ? `${msg} ${JSON.stringify({ ...context, ...ctx })}` : `${msg} ${JSON.stringify(context)}`),
      warn: (msg, ctx) => console.warn(ctx ? `${msg} ${JSON.stringify({ ...context, ...ctx })}` : `${msg} ${JSON.stringify(context)}`),
      error: (msg, ctx) => console.error(ctx ? `${msg} ${JSON.stringify({ ...context, ...ctx })}` : `${msg} ${JSON.stringify(context)}`),
      debug: (msg, ctx) => console.debug(ctx ? `${msg} ${JSON.stringify({ ...context, ...ctx })}` : `${msg} ${JSON.stringify(context)}`),
      child: (childCtx) => createConsoleLogger().child({ ...context, ...childCtx }),
    }),
  };
}
