import { NON_RETRYABLE_ERRORS, NonRetryableErrorType } from './types';

/**
 * Error de negocio que devuelve un componente (p.ej. Payment Session Manager
 * dice "sin autoridad suficiente"). Las activities lo convierten en un
 * ApplicationFailure no reintentable; cualquier otro error se reintenta.
 */
export class DomainError extends Error {
  constructor(
    public readonly type: NonRetryableErrorType,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function isNonRetryableType(type: string | undefined | null): type is NonRetryableErrorType {
  return !!type && (NON_RETRYABLE_ERRORS as readonly string[]).includes(type);
}
