import { z } from 'zod';

const channelTypes = ['whatsapp', 'telegram', 'email', 'sms'] as const;

const providerTypes = [
  'wwebjs-api',
  'evolution-api',
  'meta-cloud-api',
  'telegram-bot-api',
  'brevo',
  'ses',
  'twilio',
  'messagebird',
] as const;

const whatsappIdentitySchema = z.object({
  phoneNumber: z.string(),
  wid: z.string().optional(),
});

const telegramIdentitySchema = z.object({
  botId: z.string().optional(),
  botUsername: z.string(),
});

const emailIdentitySchema = z.object({
  address: z.string().email(),
  domain: z.string().optional(),
});

const smsIdentitySchema = z.object({
  phoneNumber: z.string(),
  senderId: z.string().optional(),
});

const rateLimitSchema = z.object({
  maxPerMinute: z.number().positive(),
  maxPerDay: z.number().positive(),
});

const accountSchema = z.object({
  id: z.string().min(1),
  alias: z.string().min(1),
  channel: z.enum(channelTypes),
  provider: z.enum(providerTypes),
  status: z.enum(['active', 'suspended', 'auth_expired', 'error']).default('active'),
  identity: z.union([
    whatsappIdentitySchema,
    telegramIdentitySchema,
    emailIdentitySchema,
    smsIdentitySchema,
  ]),
  credentialsRef: z.string().min(1),
  providerConfig: z.record(z.string(), z.unknown()).default({}),
  metadata: z.object({
    owner: z.string().min(1),
    environment: z.enum(['production', 'staging']).default('production'),
    webhookPath: z.string().optional(),
    rateLimit: rateLimitSchema.optional(),
    tags: z.array(z.string()).default([]),
  }),
});

export const accountsConfigSchema = z.object({
  accounts: z.array(accountSchema).min(1),
});

export type AccountsConfigInput = z.input<typeof accountsConfigSchema>;
export type AccountsConfigOutput = z.output<typeof accountsConfigSchema>;
