/**
 * Self-service profile (any signed-in user).
 *
 *   PATCH  /api/v1/me/profile        { displayName?, gender?, dateOfBirth? (YYYY-MM-DD) }
 *   PUT    /api/v1/me/avatar         raw image body (image/webp|png|jpeg, ≤ 2 MB);
 *                                    the web app resizes to 256×256 WebP first
 *   DELETE /api/v1/me/avatar         back to initials
 *
 *   GET    /api/v1/avatars/:userId/:file   public avatar proxy (used when the
 *                                          R2 bucket has no public URL)
 *
 * Avatar keys are random per upload, so URLs are immutable and cache forever;
 * the previous object is deleted after the new one is saved.
 */
import { randomBytes } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { dateOfBirth, gender } from '../models/auth.schemas.js';
import { authenticate, requireAuth } from '../middleware/authenticate.js';
import { validate, validBody, validParams } from '../middleware/validate.js';
import { getPublicUserOrThrow } from '../services/auth.service.js';
import { portraitsForFirstPhoto } from '../billing/portraits.js';
import { deleteObject, getObjectStream, uploadBuffer } from '../services/storage.service.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const;
type ImageType = (typeof TYPES)[number];
const EXT: Record<ImageType, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Trust the bytes, not the header: check each format's file signature. */
function sniff(buffer: Buffer): ImageType | null {
  if (buffer.length < 12) return null;
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return null;
}

const profileSchema = z
  .strictObject({
    displayName: z.string().trim().min(2, { error: 'At least 2 characters' }).max(80).optional(),
    gender: gender.optional(),
    dateOfBirth: dateOfBirth.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { error: 'Nothing to update' });
const avatarParams = z.strictObject({ userId: z.uuid(), file: z.string().regex(/^[a-f0-9]{16}\.(webp|png|jpg)$/) });

export const profileRouter: Router = Router();
profileRouter.use(authenticate);

profileRouter.patch('/profile', validate({ body: profileSchema }), async (req: Request, res: Response) => {
  const { userId } = requireAuth(req);
  const body = validBody(req, profileSchema);
  await prisma.user.update({
    where: { id: userId },
    data: {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.gender !== undefined ? { gender: body.gender } : {}),
      ...(body.dateOfBirth !== undefined ? { dateOfBirth: body.dateOfBirth } : {}),
    },
  });
  res.json({ user: await getPublicUserOrThrow(userId) });
});

profileRouter.put('/avatar', express.raw({ type: [...TYPES], limit: MAX_BYTES }), async (req: Request, res: Response) => {
  const { userId } = requireAuth(req);
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw AppError.badRequest('Send the image as the request body with Content-Type image/webp, image/png or image/jpeg (max 2 MB)');
  }
  const type = sniff(body);
  if (!type) throw AppError.badRequest('That file is not a WebP, PNG or JPEG image');

  const key = `avatars/${userId}/${randomBytes(8).toString('hex')}.${EXT[type]}`;
  await uploadBuffer(key, body, type);
  const previous = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
  await prisma.user.update({ where: { id: userId }, data: { avatarKey: key } });
  // Professional portraits: made at once from the FIRST photo (a later photo keeps the set). Never blocks the upload.
  if (!previous?.avatarKey) void portraitsForFirstPhoto(userId, key).catch((error: unknown) => logger.warn({ err: error, userId }, 'portraits not queued'));
  if (previous?.avatarKey) await deleteObject(previous.avatarKey);
  logger.info({ userId, bytes: body.length, type }, 'avatar updated');
  res.json({ user: await getPublicUserOrThrow(userId) });
});

profileRouter.delete('/avatar', async (req: Request, res: Response) => {
  const { userId } = requireAuth(req);
  const previous = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
  await prisma.user.update({ where: { id: userId }, data: { avatarKey: null } });
  if (previous?.avatarKey) await deleteObject(previous.avatarKey);
  res.json({ user: await getPublicUserOrThrow(userId) });
});

export const avatarRouter: Router = Router();
avatarRouter.get('/:userId/:file', validate({ params: avatarParams }), async (_req: Request, res: Response) => {
  const { userId, file } = validParams(res, avatarParams);
  const object = await getObjectStream(`avatars/${userId}/${file}`);
  if (!object) throw AppError.notFound('Avatar');
  res.setHeader('Content-Type', object.contentType ?? 'image/webp');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (object.size) res.setHeader('Content-Length', String(object.size));
  object.body.pipe(res);
});
