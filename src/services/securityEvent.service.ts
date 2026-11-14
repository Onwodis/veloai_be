/**
 * Append-only security audit trail.
 *
 * Recording is best-effort: an audit write failure is logged loudly but never
 * turns a successful login into a 500.
 */
import { prisma } from '../config/database.js';
import type { Prisma, SecurityEventType } from '@prisma/client';
import { logger } from '../utils/logger.js';

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export async function recordSecurityEvent(
  type: SecurityEventType,
  meta: RequestMeta,
  userId: string | null,
  metadata?: Prisma.InputJsonObject,
): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        type,
        userId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        ...(metadata ? { metadata } : {}),
      },
    });
  } catch (error) {
    logger.error({ err: error, type, userId }, 'failed to record security event');
  }
}
