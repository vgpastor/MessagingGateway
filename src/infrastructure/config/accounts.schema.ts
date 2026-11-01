import { z } from 'zod';
import { hasRequiredCredentials, MISSING_CREDENTIALS_MESSAGE } from '../../core/accounts/channel-account.js';

const channelTypes = ['whatsapp', 'telegram', 'email', 'sms'] as const;

const providerTypes = [
  'wwebjs-api',
  'evolution-api',
  'meta-cloud-api',
  'baileys',
  'telegram-bot-api',
  'brevo',
  'ses',
  'twilio',
  'messagebird',
] as const;

/** WhatsApp and SMS as one: a union keeps its first match, so with two schemas the fields of the second would be dropped. */
const phoneIdentitySchema = z.object({
  phoneNumber: z.string(),
  wid: z.string().optional(),
  senderId: z.string().optional(),
});

const telegramIdentitySchema = z.object({
  botId: z.string().optional(),
  botUsername: z.string(),
});

const emailIdentitySchema = z.object({
  address: z.string().email(),
  domain: z.string().optional(),
});

const identitySchema = z.union([phoneIdentitySchema, telegramIdentitySchema, emailIdentitySchema]);

const statusSchema = z.enum(['active', 'suspended', 'auth_expired', 'error', 'unchecked']);

const conversationsSchema = z.union([z.literal('*'), z.array(z.string())]);

const rateLimitSchema = z.object({
  maxPerMinute: z.number().positive(),
  maxPerDay: z.number().positive(),
});

const accountSchema = z.object({
  // It names a folder on disk: with '..' or a separator the credentials would land elsewhere. Starting with a letter or digit rules out every dot-only name.
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Only letters, digits, ".", "-" and "_", starting with a letter or digit'),
  alias: z.string().min(1),
  channel: z.enum(channelTypes),
  provider: z.enum(providerTypes),
  status: statusSchema.default('unchecked'),
  identity: identitySchema.optional(),
  credentialsRef: z.string().min(1).optional(),
  credentials: z.string().min(1).optional(),
  providerConfig: z.record(z.string(), z.unknown()).default({}),
  conversations: conversationsSchema.default('*'),
  metadata: z.object({
    owner: z.string().min(1),
    environment: z.enum(['production', 'staging']).default('production'),
    webhookPath: z.string().optional(),
    rateLimit: rateLimitSchema.optional(),
    tags: z.array(z.string()).default([]),
  }),
}).refine(hasRequiredCredentials, { message: MISSING_CREDENTIALS_MESSAGE });

/**
 * A partial update of an account. Written out instead of `partial()`: in zod 4 a default also
 * applies inside an optional field, so changing the alias alone would reset the status and the conversations.
 */
const accountUpdateSchema = z.strictObject({
  alias: z.string().min(1).optional(),
  provider: z.enum(providerTypes).optional(),
  status: statusSchema.optional(),
  identity: identitySchema.optional(),
  credentialsRef: z.string().min(1).optional(),
  credentials: z.string().min(1).optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  conversations: conversationsSchema.optional(),
  metadata: z.object({
    owner: z.string().min(1).optional(),
    environment: z.enum(['production', 'staging']).optional(),
    webhookPath: z.string().optional(),
    rateLimit: rateLimitSchema.optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
});

export const accountsConfigSchema = z.object({
  accounts: z.array(accountSchema).min(0),
});

export { accountSchema, accountUpdateSchema };

export type AccountsConfigInput = z.input<typeof accountsConfigSchema>;
export type AccountsConfigOutput = z.output<typeof accountsConfigSchema>;
