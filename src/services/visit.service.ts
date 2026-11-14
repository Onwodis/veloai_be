/**
 * Site visit tracking: one row per device per UTC day.
 *
 * The web app keeps a random device id (localStorage + cookie) and a
 * "last counted day" flag, so it sends at most one beacon per day. The
 * unique (visitorId, day) index makes the count exact even if a beacon is
 * repeated: repeats only bump `pageViews`. `firstVisit` marks the first
 * day a device was ever seen.
 */
import { prisma } from '../config/database.js';
import type { RequestMeta } from './securityEvent.service.js';

export interface VisitInput {
  visitorId: string;
  path: string;
  referrer?: string | undefined;
}

export async function recordVisit(input: VisitInput, meta: RequestMeta, userId: string | null): Promise<{ firstVisit: boolean; counted: boolean }> {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const seenBefore = await prisma.siteVisit.findFirst({
    where: { visitorId: input.visitorId, day: { lt: day } },
    select: { id: true },
  });

  const existingToday = await prisma.siteVisit.findUnique({
    where: { visitorId_day: { visitorId: input.visitorId, day } },
    select: { id: true, firstVisit: true },
  });

  if (existingToday) {
    await prisma.siteVisit.update({
      where: { id: existingToday.id },
      data: { pageViews: { increment: 1 }, ...(userId ? { userId } : {}) },
    });
    return { firstVisit: existingToday.firstVisit, counted: false };
  }

  const firstVisit = seenBefore === null;
  await prisma.siteVisit
    .create({
      data: {
        visitorId: input.visitorId,
        day,
        firstVisit,
        userId,
        path: input.path.slice(0, 512),
        referrer: input.referrer?.slice(0, 512) ?? null,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    })
    .catch(async (error: unknown) => {
      // Two beacons raced on the unique index; the other one counted it.
      if ((error as { code?: string }).code !== 'P2002') throw error;
    });
  return { firstVisit, counted: true };
}
