import type {
  ClientConfig, Account, CreateAccountInput, UpdateAccountInput,
  SendMessageCommand, MessageResult, WebhookConfig, WebhookConfigInput,
  HealthStatus, GatewayError,
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

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
      this.headers['X-API-Key'] = config.apiKey;
    }
    this.accounts = new AccountsApi(this);
    this.webhooks = new WebhooksApi(this);
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
