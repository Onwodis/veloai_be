/**
 * Workspace access checks. Every workspace-scoped route resolves membership
 * through here so tenancy rules live in one place.
 */
import type { WorkspaceRole } from '@prisma/client';
import { prisma } from '../config/database.js';
import { AppError } from '../utils/AppError.js';

/**
 * Returns the caller's role in the workspace, or throws 404 when they are not
 * a member (404 rather than 403 so workspace ids cannot be probed).
 * When `allowed` is given, members with any other role get 403.
 */
export async function requireMembership(
  userId: string,
  workspaceId: string,
  allowed?: readonly WorkspaceRole[],
): Promise<WorkspaceRole> {
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!member) throw AppError.notFound('Workspace');
  if (allowed && !allowed.includes(member.role)) {
    throw AppError.forbidden('Only the workspace owner can manage billing');
  }
  return member.role;
}
