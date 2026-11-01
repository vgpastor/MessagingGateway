import type { FastifyRequest } from 'fastify';
import { redactUrl } from './redact-url.js';

/** Same shape as Fastify's default request serializer, with API keys in the URL redacted. */
export const requestSerializers = {
  req: (request: FastifyRequest) => ({
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  }),
};
