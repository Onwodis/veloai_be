/**
 * Admin user-management handlers.
 */
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate.js';
import { validBody, validParams, validQuery } from '../middleware/validate.js';
import { listUsersQuerySchema, updateRoleSchema, userIdParamsSchema } from '../models/auth.schemas.js';
import * as userService from '../services/user.service.js';
import { requestMeta } from '../utils/request.js';

export async function list(_req: Request, res: Response): Promise<void> {
  res.json(await userService.listUsers(validQuery(res, listUsersQuerySchema)));
}

export async function updateRole(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const { userId } = validParams(res, userIdParamsSchema);
  const { role } = validBody(req, updateRoleSchema);
  const user = await userService.updateUserRole(auth.userId, userId, role, requestMeta(req));
  res.json({ user });
}
