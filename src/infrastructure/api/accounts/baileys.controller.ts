import type { FastifyInstance } from 'fastify';
import type { ChannelAccountRepository } from '../../../domain/accounts/channel-account.repository.js';
import { baileysSocketManager } from '../../../adapters/whatsapp/baileys/baileys-socket.manager.js';
import { parseBaileysConfig } from '../../../adapters/whatsapp/baileys/baileys.types.js';
import { errorResponseSchema } from '../schemas.js';

interface BaileysControllerDeps {
  accountRepository: ChannelAccountRepository;
}

export async function baileysController(
  fastify: FastifyInstance,
  deps: BaileysControllerDeps,
): Promise<void> {

  // GET /accounts/:accountId/baileys/status — connection status + QR if available
  fastify.get<{ Params: { accountId: string } }>(
    '/accounts/:accountId/baileys/status',
    {
      schema: {
        description: 'Get Baileys connection status and QR code for authentication',
        tags: ['Accounts'],
        params: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              status: { type: 'string', enum: ['disconnected', 'connecting', 'connected'] },
              qr: { type: 'string', description: 'QR code data string (use a QR library to render it)' },
            },
            required: ['accountId', 'status'],
          },
          404: errorResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accountId } = request.params;

      const account = await deps.accountRepository.findById(accountId);
      if (!account) {
        return reply.status(404).send({
          error: 'Not Found',
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      if (account.provider !== 'baileys') {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'NOT_BAILEYS',
          message: `Account '${accountId}' is not a Baileys provider account`,
        });
      }

      // If not yet connected, start connecting
      if (!baileysSocketManager.hasSocket(accountId)) {
        const config = parseBaileysConfig(account.providerConfig);
        await baileysSocketManager.connect(accountId, config);
      }

      return {
        accountId,
        status: baileysSocketManager.getConnectionStatus(accountId),
        qr: baileysSocketManager.getLastQr(accountId),
      };
    },
  );

  // POST /accounts/:accountId/baileys/pair — request pairing code
  fastify.post<{ Params: { accountId: string }; Body: { phoneNumber?: string } }>(
    '/accounts/:accountId/baileys/pair',
    {
      schema: {
        description:
          'Request a pairing code for Baileys authentication. ' +
          'Enter this code in WhatsApp > Linked Devices > Link with phone number.',
        tags: ['Accounts'],
        params: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        body: {
          type: 'object',
          properties: {
            phoneNumber: {
              type: 'string',
              description: 'Phone number with country code (e.g. "+14155550004"). If omitted, uses the number from account identity.',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              pairingCode: { type: 'string', description: 'Enter this code in WhatsApp to link the device' },
            },
            required: ['accountId', 'pairingCode'],
          },
          404: errorResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accountId } = request.params;

      const account = await deps.accountRepository.findById(accountId);
      if (!account) {
        return reply.status(404).send({
          error: 'Not Found',
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      if (account.provider !== 'baileys') {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'NOT_BAILEYS',
          message: `Account '${accountId}' is not a Baileys provider account`,
        });
      }

      const phoneNumber = request.body?.phoneNumber
        ?? (account.identity?.channel === 'whatsapp' ? account.identity.phoneNumber : undefined);

      if (!phoneNumber) {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'MISSING_PHONE',
          message: 'Phone number is required. Provide it in the request body or configure it in the account identity.',
        });
      }

      // Ensure socket is connecting (with QR disabled since we use pairing code)
      if (!baileysSocketManager.hasSocket(accountId)) {
        const config = parseBaileysConfig(account.providerConfig);
        await baileysSocketManager.connect(accountId, { ...config, printQRInTerminal: false });
      }

      try {
        const pairingCode = await baileysSocketManager.requestPairingCode(accountId, phoneNumber);

        fastify.log.info(
          { accountId, phoneNumber },
          'Baileys pairing code requested',
        );

        return {
          accountId,
          pairingCode,
        };
      } catch (error) {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'PAIRING_FAILED',
          message: error instanceof Error ? error.message : 'Failed to request pairing code',
        });
      }
    },
  );

  // POST /accounts/:accountId/baileys/logout — disconnect and clear session
  fastify.post<{ Params: { accountId: string } }>(
    '/accounts/:accountId/baileys/logout',
    {
      schema: {
        description: 'Logout and disconnect a Baileys account',
        tags: ['Accounts'],
        params: {
          type: 'object',
          properties: { accountId: { type: 'string' } },
          required: ['accountId'],
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['accountId', 'status'],
          },
          404: errorResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { accountId } = request.params;

      const account = await deps.accountRepository.findById(accountId);
      if (!account) {
        return reply.status(404).send({
          error: 'Not Found',
          code: 'ACCOUNT_NOT_FOUND',
          message: `Account '${accountId}' not found`,
        });
      }

      if (account.provider !== 'baileys') {
        return reply.status(400).send({
          error: 'Bad Request',
          code: 'NOT_BAILEYS',
          message: `Account '${accountId}' is not a Baileys provider account`,
        });
      }

      await baileysSocketManager.disconnect(accountId);

      fastify.log.info({ accountId }, 'Baileys account disconnected');

      return {
        accountId,
        status: 'disconnected',
      };
    },
  );
}
