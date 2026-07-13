import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MattermostHealthChecker } from '../../../src/integrations/mattermost/api-v4/mattermost.health-checker.js';
import type { ChannelAccount } from '../../../src/core/accounts/channel-account.js';

vi.mock('../../../src/integrations/shared/http.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../../src/integrations/shared/http.js';
const mockFetch = vi.mocked(fetchWithTimeout);

function makeAccount(overrides?: Partial<ChannelAccount>): ChannelAccount {
  return {
    id: 'mm-test',
    alias: 'Mattermost Test',
    channel: 'mattermost',
    provider: 'mattermost',
    status: 'active',
    identity: { channel: 'mattermost' },
    credentialsRef: 'MM_TEST',
    credentials: 'test-bot-token',
    providerConfig: { serverUrl: 'https://mm.example.com' },
    metadata: { owner: 'test', environment: 'production', tags: [] },
    ...overrides,
  };
}

function mockResponse(ok: boolean, status: number, body?: unknown) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('MattermostHealthChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return unchecked when token is missing', async () => {
    const checker = new MattermostHealthChecker();
    const result = await checker.validate(makeAccount({ credentials: undefined }));
    expect(result.status).toBe('unchecked');
    expect(result.credentialsConfigured).toBe(false);
  });

  it('should return unchecked when serverUrl is missing', async () => {
    const checker = new MattermostHealthChecker();
    const result = await checker.validate(makeAccount({ providerConfig: {} }));
    expect(result.status).toBe('unchecked');
    expect(result.credentialsConfigured).toBe(false);
  });

  it('should return active with identity on 200', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(true, 200, { id: 'bot-001', username: 'testbot', is_bot: true }),
    );

    const checker = new MattermostHealthChecker();
    const result = await checker.validate(makeAccount());

    expect(result.status).toBe('active');
    expect(result.credentialsConfigured).toBe(true);
    expect(result.discoveredIdentity).toEqual({
      channel: 'mattermost',
      botId: 'bot-001',
      botUsername: 'testbot',
    });
  });

  it('should return active without identity on JSON parse failure', async () => {
    const badResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error('invalid json')),
    } as unknown as Response;
    mockFetch.mockResolvedValueOnce(badResponse);

    const checker = new MattermostHealthChecker();
    const result = await checker.validate(makeAccount());

    expect(result.status).toBe('active');
    expect(result.credentialsConfigured).toBe(true);
    expect(result.discoveredIdentity).toBeUndefined();
  });

  it('should return auth_expired on 401', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(false, 401));

    const checker = new MattermostHealthChecker();
    const result = await checker.validate(makeAccount());

    expect(result.status).toBe('auth_expired');
    expect(result.credentialsConfigured).toBe(true);
  });

  it('should return auth_expired on 403', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(false, 403));

    const checker = new MattermostHealthChecker();
    const result = await checker.validate(makeAccount());

    expect(result.status).toBe('auth_expired');
    expect(result.credentialsConfigured).toBe(true);
  });

  it('should return error on other HTTP failures', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(false, 500));

    const checker = new MattermostHealthChecker();
    const result = await checker.validate(makeAccount());

    expect(result.status).toBe('error');
    expect(result.credentialsConfigured).toBe(true);
    expect(result.detail).toBe('HTTP 500');
  });

  it('should call /api/v4/users/me with Bearer auth', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(true, 200, { id: 'bot-001', username: 'testbot' }),
    );

    const checker = new MattermostHealthChecker();
    await checker.validate(makeAccount());

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://mm.example.com/api/v4/users/me');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-bot-token' });
  });
});
