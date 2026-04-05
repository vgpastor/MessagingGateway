import type { FastifyInstance } from 'fastify';

export interface MetricsControllerDeps {
  getMetrics: () => Promise<string>;
  contentType: string;
}

export async function metricsController(fastify: FastifyInstance, deps: MetricsControllerDeps): Promise<void> {
  fastify.get('/metrics', {
    schema: { hide: true },
  }, async (_request, reply) => {
    const metrics = await deps.getMetrics();
    return reply
      .header('content-type', deps.contentType)
      .send(metrics);
  });
}
