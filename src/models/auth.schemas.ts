/**
 * Request payload contracts (zod). Every route validates through these before
 * a controller sees the data.
 */
import { z } from 'zod';
import { ASSIGNABLE_ROLES } from './user.model.js';

const email = z
  .email({ error: 'Enter a valid email address' })
  .max(254)
  .transform((value) => value.trim().toLowerCase());

/**
 * 12–128 characters with at least one letter and one digit. Length matters
 * more than composition (NIST 800-63B); the upper bound caps hashing cost.
 */
const newPassword = z
  .string()
  .min(12, { error: 'Password must be at least 12 characters' })
  .max(128, { error: 'Password must be at most 128 characters' })
  .regex(/[A-Za-z]/, { error: 'Password must contain a letter' })
  .regex(/\d/, { error: 'Password must contain a number' });

export const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY'] as const;
export const gender = z.enum(GENDERS, { error: 'Choose a gender option' });

/** Minimum age to hold an account (KEEP IN SYNC with fe/src/utils/validation.ts). */
export const MIN_AGE = 18;

/** Whole years between a YYYY-MM-DD birth date and today (UTC). */
function ageOn(birth: Date, today = new Date()): number {
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = today.getUTCMonth() < birth.getUTCMonth() || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** YYYY-MM-DD → Date at UTC midnight; must be a real date, MIN_AGE-120 years ago. */
export const dateOfBirth = z
  .string({ error: 'Enter your date of birth' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Enter your date of birth' })
  .transform((value, ctx) => {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: 'custom', message: 'That date does not exist' });
      return z.NEVER;
    }
    const age = ageOn(date);
    if (age < MIN_AGE) {
      ctx.addIssue({ code: 'custom', message: `You must be at least ${MIN_AGE} to sign up` });
      return z.NEVER;
    }
    if (age > 120) {
      ctx.addIssue({ code: 'custom', message: 'Check the year of your date of birth' });
      return z.NEVER;
    }
    return date;
  });

/**
 * What the user agreed to at sign-up (NDPR). Terms, privacy and age must be
 * accepted; the rest are optional and default to off (never pre-ticked).
 */
export const signupConsents = z.strictObject({
  terms: z.literal(true, { error: 'Accept the terms of service to continue' }),
  privacy: z.literal(true, { error: 'Accept the privacy notice to continue' }),
  age: z.literal(true, { error: 'Confirm you are 18 or older' }),
  marketing: z.boolean().default(false),
  productResearch: z.boolean().default(false),
});

/** One part of a person's name (first or last). */
const namePart = (label: string) =>
  z
    .string()
    .transform((value) => value.replace(/[\u0000-\u001F\u007F<>]/g, '').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, { error: `Enter your ${label}` }).max(60));

export const signupCodeSchema = z.strictObject({ email });

export const registerSchema = z.strictObject({
  email,
  password: newPassword,
  firstName: namePart('first name'),
  lastName: namePart('last name'),
  /** The 6-digit code emailed by POST /auth/register/code. */
  emailCode: z.string().trim().regex(/^\d{6}$/, { error: 'Enter the 6-digit code from the email' }),
  role: z.enum(['CREATOR', 'PARTNER']).default('CREATOR'),
  gender,
  dateOfBirth,
  consents: signupConsents,
});

export const loginSchema = z.strictObject({
  email,
  // Existing passwords are not re-checked against today's policy.
  password: z.string().min(1).max(128),
});

export const sessionParamsSchema = z.strictObject({
  sessionId: z.uuid(),
});

export const userIdParamsSchema = z.strictObject({
  userId: z.uuid(),
});

export const updateRoleSchema = z.strictObject({
  role: z.enum(ASSIGNABLE_ROLES),
});

/* ------------------------------------------------------------------ 2FA */

const totpCode = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, { error: 'Enter the 6-digit code from your authenticator app' }));

const challengeToken = z.string().min(20).max(2048);

export const mfaChallengeSchema = z.strictObject({ challengeToken });

export const mfaCodeSchema = z.strictObject({ challengeToken, code: totpCode });

export const mfaRecoverySchema = z.strictObject({
  challengeToken,
  recoveryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{5}-?[A-Z0-9]{5}$/, { error: 'Recovery codes look like ABCDE-12345' }),
});

export const regenerateCodesSchema = z.strictObject({ code: totpCode });

/* ------------------------------------------------------------------ resets */

export const forgotPasswordSchema = z.strictObject({ email });

export const resetPasswordSchema = z.strictObject({
  token: z.string().min(20).max(256),
  password: newPassword,
});

export const emailTokenSchema = z.strictObject({ token: z.string().min(20).max(256) });

export const listUsersQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
