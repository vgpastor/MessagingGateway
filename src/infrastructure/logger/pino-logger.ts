import pino from 'pino';
import type { Logger } from '../../core/logger/logger.port.js';

/**
 * Pino-based Logger implementation.
 * Structured JSON in production, pretty-printed in development.
 */
export function createPinoLogger(options: {
  level?: string;
  pretty?: boolean;
}): Logger {
  const pinoInstance = pino({
    level: options.level ?? 'info',
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });

  return wrapPino(pinoInstance);
}

function wrapPino(instance: pino.Logger): Logger {
  return {
    info: (msg, ctx) => ctx ? instance.info(ctx, msg) : instance.info(msg),
    warn: (msg, ctx) => ctx ? instance.warn(ctx, msg) : instance.warn(msg),
    error: (msg, ctx) => ctx ? instance.error(ctx, msg) : instance.error(msg),
    debug: (msg, ctx) => ctx ? instance.debug(ctx, msg) : instance.debug(msg),
    child: (context) => wrapPino(instance.child(context)),
  };
}
