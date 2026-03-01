export const contactRefSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    displayName: { type: 'string' as const },
  },
  required: ['id'] as const,
};

export const contentSummarySchema = {
  type: 'object' as const,
  properties: {
    type: {
      type: 'string' as const,
      enum: [
        'text', 'image', 'audio', 'video', 'document',
        'location', 'contact', 'sticker', 'reaction',
        'status_update', 'system', 'unknown',
      ],
    },
    preview: { type: 'string' as const },
    hasMedia: { type: 'boolean' as const },
  },
  required: ['type', 'hasMedia'] as const,
};

export const gatewayMetadataSchema = {
  type: 'object' as const,
  properties: {
    receivedAt: { type: 'string' as const, format: 'date-time' },
    adapterId: { type: 'string' as const },
    rawPayloadRef: { type: 'string' as const },
    account: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' as const },
        alias: { type: 'string' as const },
        owner: { type: 'string' as const },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
      },
      required: ['id', 'alias', 'owner', 'tags'] as const,
    },
  },
  required: ['receivedAt', 'adapterId', 'account'] as const,
};

export const unifiedEnvelopeSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    accountId: { type: 'string' as const },
    channel: { type: 'string' as const, enum: ['whatsapp', 'telegram', 'email', 'sms'] },
    direction: { type: 'string' as const, enum: ['inbound', 'outbound'] },
    timestamp: { type: 'string' as const, format: 'date-time' },
    conversationId: { type: 'string' as const },
    sender: contactRefSchema,
    recipient: contactRefSchema,
    contentSummary: contentSummarySchema,
    channelPayload: { type: 'object' as const, additionalProperties: true },
    gateway: gatewayMetadataSchema,
  },
  required: [
    'id', 'accountId', 'channel', 'direction', 'timestamp',
    'conversationId', 'sender', 'recipient', 'contentSummary',
    'channelPayload', 'gateway',
  ] as const,
};

export const sendMessageBodySchema = {
  type: 'object' as const,
  properties: {
    from: {
      type: 'string' as const,
      description: 'Account ID to send from (e.g. "wa-samur")',
    },
    routing: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string' as const },
        owner: { type: 'string' as const },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
      },
      description: 'Routing criteria (used if "from" is not provided)',
    },
    to: {
      type: 'string' as const,
      description: 'Recipient identifier (phone number, email, chat ID, etc.)',
    },
    content: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string' as const,
          enum: ['text', 'image', 'audio', 'video', 'document', 'location'],
        },
        body: { type: 'string' as const },
        mediaUrl: { type: 'string' as const },
        mimeType: { type: 'string' as const },
        fileName: { type: 'string' as const },
        caption: { type: 'string' as const },
        latitude: { type: 'number' as const },
        longitude: { type: 'number' as const },
      },
      required: ['type'] as const,
    },
    replyToMessageId: { type: 'string' as const },
    metadata: {
      type: 'object' as const,
      additionalProperties: true,
      properties: {
        source: { type: 'string' as const },
        correlationId: { type: 'string' as const },
      },
    },
  },
  required: ['to', 'content'] as const,
  examples: [
    {
      from: 'wa-samur',
      to: '+34612345678',
      content: {
        type: 'text',
        body: 'Alerta: nuevo DEA registrado en tu zona',
      },
      metadata: {
        source: 'deamap',
        correlationId: 'abc-123',
      },
    },
  ],
};

export const messageResultSchema = {
  type: 'object' as const,
  properties: {
    messageId: { type: 'string' as const },
    status: {
      type: 'string' as const,
      enum: ['queued', 'sent', 'delivered', 'read', 'played', 'failed', 'unknown'],
    },
    timestamp: { type: 'string' as const, format: 'date-time' },
    providerMessageId: { type: 'string' as const },
    error: { type: 'string' as const },
  },
  required: ['messageId', 'status', 'timestamp'] as const,
};

export const accountResponseSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    alias: { type: 'string' as const },
    channel: { type: 'string' as const, enum: ['whatsapp', 'telegram', 'email', 'sms'] },
    provider: { type: 'string' as const },
    status: { type: 'string' as const, enum: ['active', 'suspended', 'auth_expired', 'error', 'unchecked'] },
    identity: { type: 'object' as const, additionalProperties: true },
    metadata: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string' as const },
        environment: { type: 'string' as const },
        webhookPath: { type: 'string' as const },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
      },
    },
  },
  required: ['id', 'alias', 'channel', 'provider', 'status'] as const,
};

export const errorResponseSchema = {
  type: 'object' as const,
  properties: {
    error: { type: 'string' as const },
    code: { type: 'string' as const },
    message: { type: 'string' as const },
  },
  required: ['error', 'message'] as const,
};

export const createAccountBodySchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const, minLength: 1, description: 'Unique account identifier (e.g. "wa-samur")' },
    alias: { type: 'string' as const, minLength: 1, description: 'Human-readable name' },
    channel: { type: 'string' as const, enum: ['whatsapp', 'telegram', 'email', 'sms'] },
    provider: {
      type: 'string' as const,
      enum: ['wwebjs-api', 'evolution-api', 'meta-cloud-api', 'telegram-bot-api', 'brevo', 'ses', 'twilio', 'messagebird'],
    },
    identity: { type: 'object' as const, additionalProperties: true, description: 'Channel-specific identity (e.g. phoneNumber for WhatsApp)' },
    credentialsRef: { type: 'string' as const, minLength: 1, description: 'Reference to credentials in env vars' },
    providerConfig: { type: 'object' as const, additionalProperties: true },
    metadata: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string' as const, minLength: 1 },
        environment: { type: 'string' as const, enum: ['production', 'staging'] },
        webhookPath: { type: 'string' as const },
        rateLimit: {
          type: 'object' as const,
          properties: {
            maxPerMinute: { type: 'number' as const },
            maxPerDay: { type: 'number' as const },
          },
        },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
      },
      required: ['owner'] as const,
    },
  },
  required: ['id', 'alias', 'channel', 'provider', 'credentialsRef', 'metadata'] as const,
};

export const updateAccountBodySchema = {
  type: 'object' as const,
  properties: {
    alias: { type: 'string' as const, minLength: 1 },
    provider: {
      type: 'string' as const,
      enum: ['wwebjs-api', 'evolution-api', 'meta-cloud-api', 'telegram-bot-api', 'brevo', 'ses', 'twilio', 'messagebird'],
    },
    identity: { type: 'object' as const, additionalProperties: true },
    credentialsRef: { type: 'string' as const, minLength: 1 },
    providerConfig: { type: 'object' as const, additionalProperties: true },
    status: { type: 'string' as const, enum: ['active', 'suspended', 'auth_expired', 'error', 'unchecked'] },
    metadata: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string' as const },
        environment: { type: 'string' as const, enum: ['production', 'staging'] },
        webhookPath: { type: 'string' as const },
        rateLimit: {
          type: 'object' as const,
          properties: {
            maxPerMinute: { type: 'number' as const },
            maxPerDay: { type: 'number' as const },
          },
        },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
      },
    },
  },
};
