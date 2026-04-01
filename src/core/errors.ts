export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AccountUnavailableError extends DomainError {
  constructor(accountId: string, reason?: string) {
    super(
      `Account '${accountId}' is unavailable${reason ? `: ${reason}` : ''}`,
      'ACCOUNT_UNAVAILABLE',
    );
  }
}

export class AccountNotFoundError extends DomainError {
  constructor(accountId: string) {
    super(`Account '${accountId}' not found`, 'ACCOUNT_NOT_FOUND');
  }
}

export class InvalidPayloadError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_PAYLOAD');
  }
}

export class ProviderError extends DomainError {
  constructor(
    provider: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(`Provider '${provider}' error: ${message}`, 'PROVIDER_ERROR');
  }
}

export class AdapterNotFoundError extends DomainError {
  constructor(provider: string) {
    super(`No adapter registered for provider '${provider}'`, 'ADAPTER_NOT_FOUND');
  }
}

export class SignatureValidationError extends DomainError {
  constructor() {
    super('Webhook signature validation failed', 'SIGNATURE_INVALID');
  }
}
