/**
 * User administration (platform ADMIN only; enforced in the routes).
 */
import { prisma } from '../config/database.js';
import type { Prisma } from '@prisma/client';
import type { ListUsersQuery } from '../models/auth.schemas.js';
import { publicUserSelect, toPublicUser, type PublicUser, type Role } from '../models/user.model.js';
import { AppError } from '../utils/AppError.js';
import { recordSecurityEvent, type RequestMeta } from './securityEvent.service.js';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export async function listUsers(query: ListUsersQuery): Promise<Paginated<PublicUser>> {
  const where: Prisma.UserWhereInput = query.search
    ? {
        OR: [
          { email: { contains: query.search, mode: 'insensitive' } },
          { displayName: { contains: query.search, mode: 'insensitive' } },
        ],
      }
    : {};

  const [total, rows] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: publicUserSelect,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return {
    items: rows.map(toPublicUser),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export async function updateUserRole(
  actorId: string,
  targetId: string,
  role: Role,
  meta: RequestMeta,
): Promise<PublicUser> {
  if (actorId === targetId) {
    // Prevents an admin from accidentally locking themselves out of admin.
    throw AppError.badRequest('You cannot change your own role');
  }

  const existing = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true } });
  if (!existing) {
    throw AppError.notFound('User');
  }
  if (existing.role === 'SUPER_ADMIN') {
    throw AppError.forbidden('The super admin role is managed through server configuration');
  }

  const row = await prisma.user.update({
    where: { id: targetId },
    data: { role },
    select: publicUserSelect,
  });

  // Live sessions carry the old role in their access tokens; end them so the
  // new role takes effect on next sign-in rather than after token expiry.
  await prisma.refreshToken.updateMany({
    where: { userId: targetId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'role_changed' },
  });

  await recordSecurityEvent('ROLE_CHANGED', meta, targetId, {
    actorId,
    from: existing.role,
    to: role,
  });
  return toPublicUser(row);
}
