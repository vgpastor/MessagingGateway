import type { FastifyInstance } from 'fastify';
import type { MessageRouterService } from '../../../domain/routing/message-router.service.js';
import type { SendMessageCommand } from '../../../domain/messaging/outbound-message.js';
import { DomainError } from '../../../domain/errors.js';
import { sendMessageBodySchema, messageResultSchema, errorResponseSchema } from '../schemas.js';

interface SendControllerDeps {
  messageRouter: MessageRouterService;
}

export async function sendController(
  fastify: FastifyInstance,
  deps: SendControllerDeps,
): Promise<void> {
  fastify.post('/api/v1/messages/send', {
    schema: {
      description: 'Send a message through a specific account or via routing rules',
      tags: ['Messaging'],
      body: sendMessageBodySchema,
      response: {
        200: messageResultSchema,
        400: errorResponseSchema,
        404: errorResponseSchema,
        500: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      from?: string;
      routing?: { channel?: string; owner?: string; tags?: string[] };
      to: string;
      content: { type: string; body?: string; mediaUrl?: string; mimeType?: string; fileName?: string; caption?: string; latitude?: number; longitude?: number };
      replyToMessageId?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.from && !body.routing) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'MISSING_ROUTING',
        message: 'Either "from" (account ID) or "routing" criteria must be provided',
      });
    }

    const command: SendMessageCommand = {
      fromAccountId: body.from,
      routing: body.routing,
      to: body.to,
      content: {
        type: body.content.type as SendMessageCommand['content']['type'],
        body: body.content.body,
        mediaUrl: body.content.mediaUrl,
        mimeType: body.content.mimeType,
        fileName: body.content.fileName,
        caption: body.content.caption,
        latitude: body.content.latitude,
        longitude: body.content.longitude,
      },
      replyToMessageId: body.replyToMessageId,
      metadata: body.metadata,
    };

    try {
      const result = await deps.messageRouter.send(command);
      return result;
    } catch (error) {
      if (error instanceof DomainError) {
        const statusCode = error.code === 'ACCOUNT_NOT_FOUND' ? 404 : 400;
        return reply.status(statusCode).send({
          error: error.code,
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });
}
