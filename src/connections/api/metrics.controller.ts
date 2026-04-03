import type { FastifyInstance } from 'fastify';
import { registry } from '../../infrastructure/metrics/prometheus.js';

export async function metricsController(fastify: FastifyInstance): Promise<void> {
  fastify.get('/metrics', {
    schema: { hide: true },
  }, async (_request, reply) => {
    const metrics = await registry.metrics();
    return reply
      .header('content-type', registry.contentType)
      .send(metrics);
  });
}
