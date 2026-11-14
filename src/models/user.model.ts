/**
 * User domain types and the single projection allowed to leave the API.
 *
 * Controllers return `PublicUser`, never a raw Prisma row, so fields such as
 * `passwordHash` or `failedLoginCount` cannot leak through a new endpoint.
 */
import type { Prisma } from '@prisma/client';
import { env } from '../config/env.js';

export const ROLES = ['CREATOR', 'PARTNER', 'ADMIN', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** Roles an admin may hand out. SUPER_ADMIN only ever comes from the env seed. */
export const ASSIGNABLE_ROLES = ['CREATOR', 'PARTNER', 'ADMIN'] as const;

export function isPlatformAdmin(role: Role): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

export const WORKSPACE_ROLES = ['OWNER', 'EDITOR', 'VIEWER'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Prisma `select` that yields exactly the public user shape. */
export const publicUserSelect = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  lastLoginAt: true,
  createdAt: true,
  totpEnabledAt: true,
  avatarKey: true,
  gender: true,
  dateOfBirth: true,
  memberships: {
    select: {
      role: true,
      workspace: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.UserSelect;

type PublicUserRow = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

export interface PublicWorkspace {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  lastLoginAt: string | null;
  createdAt: string;
  mfaEnabled: boolean;
  /**
   * Profile picture: an absolute URL (public R2 bucket) or an API path such
   * as /api/v1/avatars/<userId>/<file>.webp to resolve against the API origin.
   * Null when the user has none (the UI shows initials).
   */
  avatarUrl: string | null;
  /** Null for accounts created before sign-up asked. */
  gender: 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY' | null;
  /** YYYY-MM-DD. */
  dateOfBirth: string | null;
  workspaces: PublicWorkspace[];
}

/** Where a stored avatar is served from. Keys are immutable (new upload → new key). */
export function avatarUrl(key: string | null): string | null {
  if (!key) return null;
  if (env.CF_R2_PUBLIC_URL) return `${env.CF_R2_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
  // avatars/<userId>/<file>.webp → /api/v1/avatars/<userId>/<file>.webp
  return `/api/v1/${key}`;
}

export function toPublicUser(row: PublicUserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarUrl: avatarUrl(row.avatarKey),
    gender: row.gender,
    dateOfBirth: row.dateOfBirth?.toISOString().slice(0, 10) ?? null,
    role: row.role,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    mfaEnabled: row.totpEnabledAt !== null,
    workspaces: row.memberships.map((membership) => ({
      ...membership.workspace,
      role: membership.role,
    })),
  };
}
