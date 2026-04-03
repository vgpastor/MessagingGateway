import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../core/accounts/channel-account.repository.js';
import type { ProviderLookupPort } from '../../core/providers/provider-lookup.port.js';
import { errorResponseSchema } from './schemas.js';

export interface GroupsControllerDeps {
  accountRepository: ChannelAccountRepository;
  providerRegistry: ProviderLookupPort;
}

const groupParticipantSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    isAdmin: { type: 'boolean' as const },
    isSuperAdmin: { type: 'boolean' as const },
  },
  required: ['id', 'isAdmin', 'isSuperAdmin'] as const,
};

const groupInfoSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    name: { type: 'string' as const },
    description: { type: 'string' as const },
    participants: { type: 'array' as const, items: groupParticipantSchema },
    createdAt: { type: 'string' as const },
    createdBy: { type: 'string' as const },
    isAnnouncement: { type: 'boolean' as const },
  },
  required: ['id', 'name', 'participants', 'isAnnouncement'] as const,
};

const idParamsSchema = {
  type: 'object' as const,
  properties: { id: { type: 'string' as const } },
  required: ['id'] as const,
};

const groupIdParamsSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    groupId: { type: 'string' as const },
  },
  required: ['id', 'groupId'] as const,
};

export async function groupsController(
  fastify: FastifyInstance,
  deps: GroupsControllerDeps,
): Promise<void> {

  // GET /api/v1/accounts/:id/groups — list all groups
  fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/groups', {
    schema: {
      description: 'List all groups for a connected account',
      tags: ['Groups'],
      params: idParamsSchema,
      response: {
        200: { type: 'array' as const, items: groupInfoSchema },
        400: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const account = await deps.accountRepository.findById(request.params.id);

    if (!account) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${request.params.id}' not found`,
      });
    }

    const manager = deps.providerRegistry.getConnectionManager(account.provider);
    if (!manager || !manager.getGroups) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'GROUPS_NOT_SUPPORTED',
        message: `Provider '${account.provider}' does not support group listing.`,
      });
    }

    if (!manager.hasConnection(account.id)) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'NOT_CONNECTED',
        message: `Account '${account.id}' is not connected. Call POST /api/v1/accounts/${account.id}/connect first.`,
      });
    }

    const groups = await manager.getGroups(account.id);
    return groups;
  });

  // GET /api/v1/accounts/:id/groups/:groupId — get group info + participants
  fastify.get<{ Params: { id: string; groupId: string } }>('/api/v1/accounts/:id/groups/:groupId', {
    schema: {
      description: 'Get detailed info for a specific group including participants',
      tags: ['Groups'],
      params: groupIdParamsSchema,
      response: {
        200: groupInfoSchema,
        400: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const account = await deps.accountRepository.findById(request.params.id);

    if (!account) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account '${request.params.id}' not found`,
      });
    }

    const manager = deps.providerRegistry.getConnectionManager(account.provider);
    if (!manager || !manager.getGroupInfo) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'GROUPS_NOT_SUPPORTED',
        message: `Provider '${account.provider}' does not support group queries.`,
      });
    }

    if (!manager.hasConnection(account.id)) {
      return reply.status(400).send({
        error: 'Bad Request',
        code: 'NOT_CONNECTED',
        message: `Account '${account.id}' is not connected. Call POST /api/v1/accounts/${account.id}/connect first.`,
      });
    }

    const group = await manager.getGroupInfo(account.id, request.params.groupId);

    if (!group) {
      return reply.status(404).send({
        error: 'Not Found',
        code: 'GROUP_NOT_FOUND',
        message: `Group '${request.params.groupId}' not found for account '${account.id}'.`,
      });
    }

    return group;
  });
}
