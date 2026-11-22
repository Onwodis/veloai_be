/**
 * Object storage on Cloudflare R2 (S3-compatible).
 *
 * Layout (every key is scoped by workspace):
 *   workspaces/<workspaceId>/projects/<projectId>/source/<file>     original upload
 *   workspaces/<workspaceId>/projects/<projectId>/audio.mp3          extracted audio
 *   workspaces/<workspaceId>/projects/<projectId>/reels/<reelId>.mp4 rendered reel
 *   workspaces/<workspaceId>/projects/<projectId>/reels/<reelId>.jpg thumbnail
 *
 * Browser uploads: with UPLOAD_RELAY (default) every "presigned" URL is a
 * signed link to this API's relay (PUT /api/v1/uploads/:token), which streams
 * the bytes into R2, so the bucket needs no CORS rule. With UPLOAD_RELAY=false
 * browsers PUT straight to R2 (needs the bucket CORS rule). Downloads use
 * short-lived presigned GETs unless a public bucket URL is configured.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  type CORSRule,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { track, untrack, untrackPrefix } from '../storage/ledger.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

/** 16 MiB parts: R2 needs ≥5 MiB (except the last); 10,000 parts cap → 160 GiB. */
export const PART_SIZE = 16 * 1024 * 1024;
const PRESIGN_SECONDS = 60 * 60;

let client: S3Client | null = null;

function bucket(): string {
  if (!env.R2_ENABLED || !env.CF_R2_BUCKET_NAME) {
    throw new AppError(503, 'INTERNAL_ERROR', 'Storage is not configured. Set the CF_R2_* variables in the API .env.');
  }
  return env.CF_R2_BUCKET_NAME;
}

export function s3(): S3Client {
  bucket();
  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${env.CF_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.CF_R2_ACCESS_KEY_ID ?? '', secretAccessKey: env.CF_R2_SECRET_ACCESS_KEY ?? '' },
    // R2 doesn't support the newer default CRC checksums on presigned parts.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

export const keys = {
  project: (workspaceId: string, projectId: string): string => `workspaces/${workspaceId}/projects/${projectId}`,
  source: (workspaceId: string, projectId: string, fileName: string): string =>
    `${keys.project(workspaceId, projectId)}/source/${fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)}`,
  audio: (workspaceId: string, projectId: string): string => `${keys.project(workspaceId, projectId)}/audio.mp3`,
  reel: (workspaceId: string, projectId: string, reelId: string, ext: 'mp4' | 'jpg'): string => `${keys.project(workspaceId, projectId)}/reels/${reelId}.${ext}`,
  /** AI video studio: workspaces/<ws>/studio/<projectId>/… */
  studio: (workspaceId: string, projectId: string): string => `workspaces/${workspaceId}/studio/${projectId}`,
  studioAsset: (workspaceId: string, projectId: string, assetId: string, fileName: string): string =>
    `${keys.studio(workspaceId, projectId)}/assets/${assetId}-${fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}`,
  studioTake: (workspaceId: string, projectId: string, takeId: string, file: 'keyframe.png' | 'frame.png' | 'video.mp4' | 'thumb.jpg' | 'audio.m4a' | 'audio.wav'): string =>
    `${keys.studio(workspaceId, projectId)}/takes/${takeId}/${file}`,
  studioOutput: (workspaceId: string, projectId: string, stamp: string, ext: 'mp4' | 'jpg'): string => `${keys.studio(workspaceId, projectId)}/final/${stamp}.${ext}`,
  /** Per-user files: users/<userId>/… (counted against that user's storage). */
  user: (userId: string): string => `users/${userId}`,
  likenessAsset: (userId: string, assetId: string, fileName: string): string => `users/${userId}/likeness/${assetId}-${fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}`,
  likenessDerived: (userId: string, file: string): string => `users/${userId}/likeness/derived/${file}`,
  /** Trained likeness weights: platform-held, not counted against the user's storage. */
  likenessWeights: (userId: string, stamp: string): string => `system/likeness/${userId}/${stamp}.safetensors`,
  likenessTrainingSet: (userId: string, stamp: string): string => `system/likeness/${userId}/${stamp}-images.zip`,
  creationSource: (userId: string, id: string, fileName: string): string => `users/${userId}/uploads/${id}-${fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}`,
  creation: (userId: string, id: string, file: 'output.png' | 'output.mp4' | 'thumb.jpg' | 'keyframe.png'): string => `users/${userId}/creations/${id}/${file}`,
};

/* ------------------------------------------------------------------ upload relay */

interface RelayGrant {
  /** Object key. */
  k: string;
  /** Required Content-Type (single PUT). */
  t?: string;
  /** Multipart: upload id + part number. */
  u?: string;
  p?: number;
  /** Max bytes accepted. */
  m: number;
  /** Expiry (unix ms). */
  e: number;
}

const relayKey = (): Buffer => createHmac('sha256', env.JWT_ACCESS_SECRET).update('upload-relay-v1').digest();
const relaySign = (payload: string): string => createHmac('sha256', relayKey()).update(payload).digest('base64url');

function relayUrl(grant: Omit<RelayGrant, 'e'>): string {
  const payload = Buffer.from(JSON.stringify({ ...grant, e: Date.now() + PRESIGN_SECONDS * 1000 })).toString('base64url');
  // Without API_PUBLIC_URL the link is a path: the web app sends it to its own API address. (A
  // localhost fallback here broke every upload in production, where the API is not on localhost.)
  const base = env.API_PUBLIC_URL ? env.API_PUBLIC_URL.replace(/\/+$/, '') : '';
  return `${base}/api/v1/uploads/${payload}.${relaySign(payload)}`;
}

/** Verifies a relay token (HMAC, constant-time) and returns what it allows. */
export function readRelayToken(token: string): RelayGrant {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw AppError.badRequest('Malformed upload link');
  const expected = Buffer.from(relaySign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw AppError.forbidden('This upload link is not valid');
  const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RelayGrant;
  if (Date.now() > grant.e) throw AppError.forbidden('This upload link has expired; start the upload again');
  return grant;
}

/** Streams one relayed upload (whole object or one multipart part) into R2. Returns the ETag. */
export async function relayUpload(grant: RelayGrant, body: Readable, contentType: string | undefined, contentLength: number | undefined): Promise<string> {
  if (contentLength !== undefined && contentLength > grant.m) throw new AppError(413, 'BAD_REQUEST', 'The file is larger than this upload allows');
  let seen = 0;
  // Enforce the size limit on the actual bytes, not just the header.
  const limited = body.pipe(
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;
        callback(seen > grant.m ? new AppError(413, 'BAD_REQUEST', 'The file is larger than this upload allows') : null, chunk);
      },
    }),
  );
  if (grant.u && grant.p) {
    if (contentLength === undefined) throw new AppError(411, 'BAD_REQUEST', 'Content-Length is required');
    const result = await s3().send(new UploadPartCommand({ Bucket: bucket(), Key: grant.k, UploadId: grant.u, PartNumber: grant.p, Body: limited, ContentLength: contentLength }));
    return result.ETag ?? '';
  }
  if (grant.t && contentType && contentType.split(';')[0]!.trim().toLowerCase() !== grant.t.toLowerCase()) throw AppError.badRequest(`Send the file with Content-Type ${grant.t}`);
  const result = await new Upload({ client: s3(), params: { Bucket: bucket(), Key: grant.k, Body: limited, ContentType: grant.t ?? contentType }, partSize: PART_SIZE, queueSize: 3 }).done();
  return result.ETag ?? '';
}

/**
 * One-shot upload URL for photos, songs and videos. The browser must send the
 * same Content-Type. Relay link by default (no bucket CORS needed).
 */
export async function presignPut(key: string, contentType: string, maxBytes = 2 * 1024 ** 3): Promise<string> {
  if (env.UPLOAD_RELAY) return relayUrl({ k: key, t: contentType, m: maxBytes });
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn: PRESIGN_SECONDS });
}

/* ------------------------------------------------------------------ multipart upload */

export async function startMultipart(key: string, contentType: string, size: number): Promise<{ uploadId: string; partSize: number; parts: { partNumber: number; url: string }[] }> {
  const { UploadId } = await s3().send(new CreateMultipartUploadCommand({ Bucket: bucket(), Key: key, ContentType: contentType }));
  if (!UploadId) throw new AppError(502, 'INTERNAL_ERROR', 'Storage did not start the upload');
  const count = Math.max(1, Math.ceil(size / PART_SIZE));
  const parts = await Promise.all(
    Array.from({ length: count }, async (_, index) => ({
      partNumber: index + 1,
      url: env.UPLOAD_RELAY
        ? relayUrl({ k: key, u: UploadId, p: index + 1, m: PART_SIZE + 1024 * 1024 })
        : await getSignedUrl(s3(), new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId, PartNumber: index + 1 }), { expiresIn: PRESIGN_SECONDS }),
    })),
  );
  return { uploadId: UploadId, partSize: PART_SIZE, parts };
}

export async function completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
  await s3().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
    }),
  );
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  await s3()
    .send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }))
    .catch((error: unknown) => logger.warn({ err: error, key }, 'abort multipart failed'));
}

/* ------------------------------------------------------------------ objects */

export async function headObject(key: string): Promise<{ size: number; contentType: string | undefined } | null> {
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: head.ContentLength ?? 0, contentType: head.ContentType };
  } catch (error) {
    if ((error as { name?: string }).name === 'NotFound') return null;
    throw error;
  }
}

export async function downloadToFile(key: string, filePath: string): Promise<void> {
  const object = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  await pipeline(object.Body as Readable, createWriteStream(filePath));
}

/** Server-side upload of a generated file; counted in the owner's storage (see storage/ledger.ts). */
export async function uploadFile(key: string, filePath: string, contentType: string): Promise<void> {
  await new Upload({
    client: s3(),
    params: { Bucket: bucket(), Key: key, Body: createReadStream(filePath), ContentType: contentType, CacheControl: 'private, max-age=31536000, immutable' },
    partSize: PART_SIZE,
    queueSize: 3,
  }).done();
  await track(key, (await stat(filePath)).size);
}

/** Small in-memory upload (avatars). */
export async function uploadBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
  await track(key, body.length);
}

export async function deleteObject(key: string): Promise<void> {
  await s3()
    .send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
    .catch((error: unknown) => logger.warn({ err: error, key }, 'object delete failed'));
  await untrack(key);
}

/** Streams an object (for API-proxied public files such as avatars). Null if missing. */
export async function getObjectStream(key: string): Promise<{ body: Readable; contentType: string | undefined; size: number | undefined } | null> {
  try {
    const object = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return { body: object.Body as Readable, contentType: object.ContentType, size: object.ContentLength };
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return null;
    throw error;
  }
}

/**
 * A byte range of an object (or all of it), for streaming video through the API
 * (public view links: the browser seeks with Range requests; the storage URL is never shown).
 */
export async function getObjectRange(
  key: string,
  range?: string,
): Promise<{ body: Readable; contentType: string | undefined; length: number | undefined; contentRange: string | undefined; total: number | undefined } | null> {
  try {
    const object = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, ...(range ? { Range: range } : {}) }));
    const total = object.ContentRange ? Number(object.ContentRange.split('/')[1]) : object.ContentLength;
    return { body: object.Body as Readable, contentType: object.ContentType, length: object.ContentLength, contentRange: object.ContentRange, total };
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'NoSuchKey') return null;
    if (name === 'InvalidRange') throw Object.assign(new Error('Range not satisfiable'), { status: 416 });
    throw error;
  }
}

/**
 * A short-lived signed URL, ALWAYS signed (never the public bucket URL): for
 * private files such as identity documents. Expires in `seconds` (default 5 min).
 * With `downloadName` the browser saves it under that name instead of showing it.
 */
export async function privateReadUrl(key: string, seconds = 300, downloadName?: string): Promise<string> {
  const disposition = downloadName ? `attachment; filename="${downloadName.replace(/[^\w .-]+/g, '_')}"` : 'inline';
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentDisposition: disposition }), { expiresIn: seconds });
}

/**
 * Copies an object inside the bucket (server side, no download): used when a
 * scene is duplicated with its video, so each copy owns its own files.
 */
export async function copyObject(from: string, to: string): Promise<void> {
  await s3().send(new CopyObjectCommand({ Bucket: bucket(), CopySource: `${bucket()}/${encodeURIComponent(from).replace(/%2F/g, '/')}`, Key: to }));
  const head = await headObject(to);
  if (head) await track(to, head.size);
}

/** URL a browser can play/download. Public bucket URL when configured, else a signed GET. */
export async function readUrl(key: string, downloadName?: string): Promise<string> {
  if (env.CF_R2_PUBLIC_URL && !downloadName) return `${env.CF_R2_PUBLIC_URL.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ...(downloadName ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/[^A-Za-z0-9._ -]/g, '_')}"` } : {}),
    }),
    { expiresIn: PRESIGN_SECONDS },
  );
}

/** Deletes every object under a prefix (a project's files). */
export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    const objects = (page.Contents ?? []).flatMap((item) => (item.Key ? [{ Key: item.Key }] : []));
    if (objects.length) {
      await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: objects, Quiet: true } }));
      deleted += objects.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  await untrackPrefix(prefix);
  return deleted;
}

/** Every object under a prefix with its size (storage backfill / reconciliation). */
export async function listObjects(prefix: string): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents ?? []) if (item.Key) out.push({ key: item.Key, size: item.Size ?? 0 });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/* ------------------------------------------------------------------ setup */

/**
 * Makes sure browsers on the web origins can PUT upload parts and read the
 * ETag header (needed to complete multipart uploads). Merges with any CORS
 * rules already on the bucket rather than replacing them.
 */
export async function ensureBucketCors(): Promise<'unchanged' | 'updated'> {
  const origins = env.CORS_ORIGINS;
  let rules: CORSRule[] = [];
  try {
    rules = (await s3().send(new GetBucketCorsCommand({ Bucket: bucket() }))).CORSRules ?? [];
  } catch (error) {
    if (!['NoSuchCORSConfiguration', 'NoSuchCors'].includes((error as { name?: string }).name ?? '')) throw error;
  }
  const covered = origins.every((origin) =>
    rules.some((rule) => (rule.AllowedOrigins?.includes(origin) || rule.AllowedOrigins?.includes('*')) && rule.AllowedMethods?.includes('PUT') && rule.ExposeHeaders?.some((h) => h.toLowerCase() === 'etag')),
  );
  if (covered) return 'unchanged';
  await s3().send(
    new PutBucketCorsCommand({
      Bucket: bucket(),
      CORSConfiguration: {
        CORSRules: [
          ...rules,
          { AllowedOrigins: origins, AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
        ],
      },
    }),
  );
  return 'updated';
}

export async function checkBucket(): Promise<void> {
  await s3().send(new HeadBucketCommand({ Bucket: bucket() }));
}
