/**
 * Role-based access control.
 *
 * Usage: `router.get('/users', authenticate, authorize('ADMIN'), handler)`.
 * Must be mounted after `authenticate`. SUPER_ADMIN passes every check;
 * `authorize('SUPER_ADMIN')` admits only the super admin.
 */
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../models/user.model.js';
import { AppError } from '../utils/AppError.js';

export function authorize(...allowed: readonly [Role, ...Role[]]) {
  const permitted = new Set<Role>(allowed);
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      throw AppError.unauthenticated();
    }
    if (req.auth.role !== 'SUPER_ADMIN' && !permitted.has(req.auth.role)) {
      throw AppError.forbidden();
    }
    next();
  };
}
