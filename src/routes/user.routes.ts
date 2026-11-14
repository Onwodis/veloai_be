/**
 * /api/v1/users — platform administration (ADMIN role only).
 *
 *   GET   /                 paginated, searchable user list
 *   PATCH /:userId/role     change a user's platform role
 */
import { Router } from 'express';
import * as users from '../controllers/user.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { listUsersQuerySchema, updateRoleSchema, userIdParamsSchema } from '../models/auth.schemas.js';

export const userRouter: Router = Router();

userRouter.use(authenticate, authorize('ADMIN'));

userRouter.get('/', validate({ query: listUsersQuerySchema }), users.list);
userRouter.patch(
  '/:userId/role',
  validate({ params: userIdParamsSchema, body: updateRoleSchema }),
  users.updateRole,
);
