import type {
  ClientConfig, Account, CreateAccountInput, UpdateAccountInput,
  SendMessageCommand, MessageResult, WebhookConfig, WebhookConfigInput,
  HealthStatus, GatewayError, GroupInfo, MessageQuery, MessageQueryResult,
  MessageStats, UnifiedEnvelope, ConversationContext,
} from './types.js';

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

export class MessagingGatewayClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  public readonly accounts: AccountsApi;
  public readonly webhooks: WebhooksApi;
  public readonly groups: GroupsApi;
  public readonly messages: MessagesApi;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
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
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, { method: 'GET', headers: this.headers });
    if (!response.ok) {
      const error = await response.json().catch(() => ({
        error: 'Unknown',
        code: 'UNKNOWN',
        message: `HTTP ${response.status}`,
      })) as GatewayError;
      throw new GatewayApiError(response.status, error.code, error.message);
    }
    return response.text();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: this.headers,
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const error = await response.json().catch(() => ({
        error: 'Unknown',
        code: 'UNKNOWN',
        message: `HTTP ${response.status}`,
      })) as GatewayError;
      throw new GatewayApiError(response.status, error.code, error.message);
    }

    return response.json() as Promise<T>;
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

  async get(messageId: string): Promise<UnifiedEnvelope> {
    return this.client.get<UnifiedEnvelope>(`/api/v1/messages/${messageId}`);
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

  async export(options?: { accountId?: string; format?: 'csv' | 'json'; since?: string }): Promise<string | UnifiedEnvelope[]> {
    const params = new URLSearchParams();
    if (options?.accountId) params.set('accountId', options.accountId);
    if (options?.format) params.set('format', options.format);
    if (options?.since) params.set('since', options.since);
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
