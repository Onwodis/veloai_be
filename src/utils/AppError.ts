/**
 * Operational error type.
 *
 * Anything thrown as an `AppError` is an expected failure (bad credentials,
 * missing resource, forbidden action) whose message is safe to show the
 * client. Every other thrown value is treated as a bug: logged in full and
 * answered with a generic 500.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'TOKEN_REUSE_DETECTED'
  | 'CSRF_REJECTED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYMENTS_UNAVAILABLE'
  | 'MFA_CHALLENGE_INVALID'
  | 'MFA_CODE_INVALID'
  | 'MAIL_UNAVAILABLE'
  | 'INSUFFICIENT_TOKENS'
  | 'DAILY_CAP'
  | 'STORAGE_FULL'
  | 'PAYMENT_FAILED'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static unauthenticated(message = 'Authentication required'): AppError {
    return new AppError(401, 'UNAUTHENTICATED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static notFound(resource = 'Resource'): AppError {
    return new AppError(404, 'NOT_FOUND', `${resource} not found`);
  }

  static conflict(message: string): AppError {
    return new AppError(409, 'CONFLICT', message);
  }
}
