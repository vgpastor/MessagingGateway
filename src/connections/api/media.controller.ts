import type { FastifyInstance } from 'fastify';
import type { MediaFileReader } from '../../core/inbound/media-service.js';
import type { MessageStorePort } from '../../core/persistence/message-store.port.js';
import { errorResponseSchema } from './schemas.js';

interface MediaControllerDeps {
  messageStore: Pick<MessageStorePort, 'findById'>;
  mediaStore: MediaFileReader;
}

const mediaPendingSchema = {
  type: 'object' as const,
  properties: { status: { type: 'string' as const, enum: ['pending'] } },
  required: ['status'] as const,
};

const mediaGoneSchema = {
  type: 'object' as const,
  properties: {
    status: { type: 'string' as const, enum: ['skipped', 'expired'] },
    skipReason: { type: 'string' as const, enum: ['too_large', 'download_failed'] },
  },
  required: ['status'] as const,
};

export async function mediaController(fastify: FastifyInstance, deps: MediaControllerDeps): Promise<void> {
  fastify.get<{ Params: { id: string } }>('/api/v1/media/:id', {
    schema: {
      description:
        'Download the media of a stored message (the `media.url` of its envelope). ' +
        '200 streams the file; 202 while it is still being downloaded; 410 when it was skipped or has expired.',
      tags: ['Messages'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 202: mediaPendingSchema, 404: errorResponseSchema, 410: mediaGoneSchema },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const envelope = await deps.messageStore.findById(id);
    const media = envelope && 'media' in envelope.content ? envelope.content.media : undefined;
    if (!envelope || !media?.status) {
      return reply.status(404).send({ error: 'Not Found', code: 'MEDIA_NOT_FOUND', message: `No media for message ${id}` });
    }

    if (media.status === 'pending') return reply.status(202).send({ status: 'pending' });
    if (media.status !== 'ready') {
      return reply.status(410).send({ status: media.status, ...(media.skipReason ? { skipReason: media.skipReason } : {}) });
    }

    const file = await deps.mediaStore.open(id, envelope.accountId);
    // Marked ready but the file is gone (purged by retention): the media has expired.
    if (!file) return reply.status(410).send({ status: 'expired' });

    // The type comes from the stored file's extension, never from the sender-supplied mimetype.
    return reply
      .header('Content-Type', file.mimeType)
      .header('Content-Length', file.size)
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.stream);
  });
}
