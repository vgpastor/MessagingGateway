import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import { redactUrl } from './redact-url.js';

/**
 * Silences only Fastify's per-request "incoming request" / "request completed" lines, which print
 * the raw URL (a `?token=` key would leak). Our own `onResponse` hook logs a redacted access line.
 *
 * Fastify's error logs (default error handler, serializer, stream and writeHead errors) stay on:
 * they only log the request through the redacting `req` serializer.
 */
export class QuietRequestLogController extends LogController {
  override incomingRequest(): void {
    // Replaced by the redacted access log in the onResponse hook.
  }

  override requestCompleted(): void {
    // Replaced by the redacted access log in the onResponse hook.
  }

  /** The stock message embeds the raw URL, so log it redacted. */
  override routeNotFound(request: FastifyRequest, _reply: FastifyReply): void {
    request.log.info(`Route ${request.raw.method}:${redactUrl(request.raw.url ?? '')} not found`);
  }
}
