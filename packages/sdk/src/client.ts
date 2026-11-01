import type {
  ClientConfig, Account, CreateAccountInput, UpdateAccountInput,
  SendMessageCommand, MessageResult, WebhookConfig, WebhookConfigInput,
  HealthStatus, GatewayError, GroupInfo, MessageQuery, MessageQueryResult,
  MessageStats, UnifiedEnvelope, ConversationContext, MessagesAfterResult,
  MediaDownload,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class GatewayApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayApiError';
  }
}

/** Turns an error response into the error the client throws. */
async function toApiError(response: Response): Promise<GatewayApiError> {
  const error = await response.json().catch(() => ({
    error: 'Unknown',
    code: 'UNKNOWN',
    message: `HTTP ${response.status}`,
  })) as GatewayError;
  return new GatewayApiError(response.status, error.code, error.message);
}

export class MessagingGatewayClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  public readonly accounts: AccountsApi;
  public readonly webhooks: WebhooksApi;
  public readonly groups: GroupsApi;
  public readonly messages: MessagesApi;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
      this.headers['X-API-Key'] = config.apiKey;
    }
    this.accounts = new AccountsApi(this);
    this.webhooks = new WebhooksApi(this);
    this.groups = new GroupsApi(this);
    this.messages = new MessagesApi(this);
  }

  /** Send a message through an account or via routing rules */
  async send(command: SendMessageCommand): Promise<MessageResult> {
    return this.post<MessageResult>('/api/v1/messages/send', command);
  }

  /** Get message delivery status */
  async getMessageStatus(messageId: string, accountId: string): Promise<MessageResult> {
    return this.get<MessageResult>(`/api/v1/messages/${messageId}/status?accountId=${accountId}`);
  }

  /** Mark a message as read */
  async markAsRead(messageId: string, accountId: string): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>(`/api/v1/messages/${messageId}/read`, { accountId });
  }

  /** Health check */
  async health(): Promise<HealthStatus> {
    return this.get<HealthStatus>('/health');
  }

  // ── Internal HTTP methods ───────────────────────────────────

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async getText(path: string): Promise<string> {
    const response = await this.getResponse(path);
    return response.text();
  }

  /** GET that leaves the body to the caller. Throws on an error status, except the `expected` ones. */
  async getResponse(path: string, expected: readonly number[] = []): Promise<Response> {
    const response = await this.fetch('GET', path);
    if (!response.ok && !expected.includes(response.status)) throw await toApiError(response);
    return response;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetch(method, path, body);
    if (!response.ok) throw await toApiError(response);
    return response.json() as Promise<T>;
  }

  /** The timeout covers the whole exchange, reading the body included. */
  private fetch(method: string, path: string, body?: unknown): Promise<Response> {
    const options: RequestInit = {
      method,
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    return fetch(`${this.baseUrl}${path}`, options);
  }
}

// ── Accounts sub-API ──────────────────────────────────────────

class AccountsApi {
  constructor(private readonly client: MessagingGatewayClient) {}

  async list(filters?: { channel?: string; owner?: string }): Promise<Account[]> {
    const params = new URLSearchParams();
    if (filters?.channel) params.set('channel', filters.channel);
    if (filters?.owner) params.set('owner', filters.owner);
    const qs = params.toString();
    return this.client.get<Account[]>(`/api/v1/accounts${qs ? `?${qs}` : ''}`);
  }

  async get(id: string): Promise<Account> {
    return this.client.get<Account>(`/api/v1/accounts/${id}`);
  }

  async create(input: CreateAccountInput): Promise<Account> {
    return this.client.post<Account>('/api/v1/accounts', input);
  }

  async update(id: string, input: UpdateAccountInput): Promise<Account> {
    return this.client.put<Account>(`/api/v1/accounts/${id}`, input);
  }

  async delete(id: string): Promise<{ deleted: boolean; accountId: string }> {
    return this.client.del<{ deleted: boolean; accountId: string }>(`/api/v1/accounts/${id}`);
  }

  async connect(id: string): Promise<Account> {
    return this.client.post<Account>(`/api/v1/accounts/${id}/connect`);
  }

  async disconnect(id: string): Promise<{ accountId: string; status: string }> {
    return this.client.post<{ accountId: string; status: string }>(`/api/v1/accounts/${id}/disconnect`);
  }

  async requestPairingCode(id: string, phoneNumber?: string): Promise<{ accountId: string; pairingCode: string }> {
    return this.client.post<{ accountId: string; pairingCode: string }>(
      `/api/v1/accounts/${id}/pair`,
      phoneNumber ? { phoneNumber } : {},
    );
  }

  async health(id: string): Promise<{ accountId: string; status: string; credentialsConfigured: boolean; detail?: string }> {
    return this.client.get(`/api/v1/accounts/${id}/health`);
  }
}

// ── Webhooks sub-API ──────────────────────────────────────────

class WebhooksApi {
  constructor(private readonly client: MessagingGatewayClient) {}

  async list(): Promise<WebhookConfig[]> {
    return this.client.get<WebhookConfig[]>('/api/v1/webhooks');
  }

  async get(accountId: string): Promise<WebhookConfig> {
    return this.client.get<WebhookConfig>(`/api/v1/accounts/${accountId}/webhook`);
  }

  async set(accountId: string, config: WebhookConfigInput): Promise<WebhookConfig> {
    return this.client.put<WebhookConfig>(`/api/v1/accounts/${accountId}/webhook`, config);
  }

  async delete(accountId: string): Promise<{ deleted: boolean; accountId: string }> {
    return this.client.del<{ deleted: boolean; accountId: string }>(`/api/v1/accounts/${accountId}/webhook`);
  }
}

// ── Groups sub-API ───────────────────────────────────────────

class GroupsApi {
  constructor(private readonly client: MessagingGatewayClient) {}

  async list(accountId: string): Promise<GroupInfo[]> {
    return this.client.get<GroupInfo[]>(`/api/v1/accounts/${accountId}/groups`);
  }

  async get(accountId: string, groupId: string): Promise<GroupInfo> {
    return this.client.get<GroupInfo>(`/api/v1/accounts/${accountId}/groups/${groupId}`);
  }
}

// ── Messages sub-API ─────────────────────────────────────────

class MessagesApi {
  constructor(private readonly client: MessagingGatewayClient) {}

  async query(filters?: MessageQuery): Promise<MessageQueryResult> {
    const params = new URLSearchParams();
    if (filters) {
      if (filters.accountId) params.set('accountId', filters.accountId);
      if (filters.channel) params.set('channel', filters.channel);
      if (filters.conversationId) params.set('conversationId', filters.conversationId);
      if (filters.senderId) params.set('senderId', filters.senderId);
      if (filters.contentType) params.set('contentType', filters.contentType);
      if (filters.direction) params.set('direction', filters.direction);
      if (filters.since) params.set('since', filters.since);
      if (filters.until) params.set('until', filters.until);
      if (filters.limit !== undefined) params.set('limit', String(filters.limit));
      if (filters.offset !== undefined) params.set('offset', String(filters.offset));
    }
    const qs = params.toString();
    return this.client.get<MessageQueryResult>(`/api/v1/messages${qs ? `?${qs}` : ''}`);
  }

  /**
   * Catch-up read of inbound messages by per-account sequence: everything for
   * `accountId` with `accountSeq > afterAccountSeq`, oldest first. Use it after
   * a reconnect or when a gap in `accountSeq` is detected; keep calling with
   * `nextAfterAccountSeq` until it is `null`.
   */
  async after(accountId: string, afterAccountSeq: number, limit = 500): Promise<MessagesAfterResult> {
    const params = new URLSearchParams({
      accountId,
      afterAccountSeq: String(afterAccountSeq),
      limit: String(limit),
    });
    return this.client.get<MessagesAfterResult>(`/api/v1/messages?${params.toString()}`);
  }

  async get(messageId: string): Promise<UnifiedEnvelope> {
    return this.client.get<UnifiedEnvelope>(`/api/v1/messages/${messageId}`);
  }

  /**
   * Media of a stored message. Only `status: 'ready'` carries the file; `pending` means try again
   * later, and `skipped` or `expired` that it will never be there. A message with no media throws (404).
   */
  async media(messageId: string): Promise<MediaDownload> {
    const response = await this.client.getResponse(`/api/v1/media/${encodeURIComponent(messageId)}`, [410]);
    if (response.status !== 200) return response.json() as Promise<MediaDownload>;
    return {
      status: 'ready',
      data: await response.arrayBuffer(),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async search(query: string, options?: { accountId?: string; limit?: number }): Promise<MessageQueryResult> {
    const params = new URLSearchParams({ q: query });
    if (options?.accountId) params.set('accountId', options.accountId);
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    return this.client.get<MessageQueryResult>(`/api/v1/messages/search?${params.toString()}`);
  }

  async analytics(options?: { accountId?: string; since?: string; until?: string }): Promise<MessageStats> {
    const params = new URLSearchParams();
    if (options?.accountId) params.set('accountId', options.accountId);
    if (options?.since) params.set('since', options.since);
    if (options?.until) params.set('until', options.until);
    const qs = params.toString();
    return this.client.get<MessageStats>(`/api/v1/messages/analytics${qs ? `?${qs}` : ''}`);
  }

  /** Up to 1000 messages per call (the gateway's cap): use `offset` for the rest. */
  async export(options?: { accountId?: string; format?: 'csv' | 'json'; since?: string; limit?: number; offset?: number }): Promise<string | UnifiedEnvelope[]> {
    const params = new URLSearchParams();
    if (options?.accountId) params.set('accountId', options.accountId);
    if (options?.format) params.set('format', options.format);
    if (options?.since) params.set('since', options.since);
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    const qs = params.toString();
    const url = `/api/v1/messages/export${qs ? `?${qs}` : ''}`;

    if (options?.format === 'csv') {
      return this.client.getText(url);
    }

    const result = await this.client.get<MessageQueryResult>(url);
    return result.messages;
  }

  async conversationContext(
    conversationId: string,
    options?: { limit?: number; since?: string; accountId?: string; format?: 'openai' | 'raw' },
  ): Promise<ConversationContext> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.since) params.set('since', options.since);
    if (options?.accountId) params.set('accountId', options.accountId);
    if (options?.format) params.set('format', options.format);
    const qs = params.toString();
    return this.client.get<ConversationContext>(`/api/v1/conversations/${conversationId}/context${qs ? `?${qs}` : ''}`);
  }
}
