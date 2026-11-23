/**
 * The mail module's last step, applied to every email in sendMail(): the app's logo at the top,
 * a greeting with the recipient's first name, and a footer naming the address it was sent to with a
 * reminder to check spam. Templates (templates.ts) only leave markers; filling them here means every
 * email is branded and addressed the same way, whoever sends it.
 *
 * Logo: the super admin's generated logo when one is live (its pale version, the emails are dark),
 * else the built-in wordmark from the web app's /images. The address must be public and permanent
 * (an email is opened days later), so a private/signed storage link is never used.
 */
import { env } from '../../config/env.js';
import { sql } from '../../studio/sql.js';
import { logger } from '../../utils/logger.js';
import type { RenderedMail } from './templates.js';

export const MARK = { logo: '<!--mail:logo-->', greeting: '<!--mail:greeting-->', footer: '<!--mail:footer-->' } as const;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

let logoCache: { url: string; at: number } | null = null;

/** Public, permanent URL of the logo for emails (cached for 5 minutes). */
async function logoUrl(): Promise<string> {
  if (logoCache && Date.now() - logoCache.at < 5 * 60_000) return logoCache.url;
  let url = `${env.WEB_APP_URL.replace(/\/+$/, '')}/images/velo-nav-dark.png`;
  try {
    const { activeLogoKey } = await import('../../marketing/brandLogo.js');
    const key = await activeLogoKey();
    if (key && env.CF_R2_PUBLIC_URL) url = `${env.CF_R2_PUBLIC_URL.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  } catch (error) {
    logger.warn({ err: error }, 'mail logo: using the built-in logo');
  }
  logoCache = { url, at: Date.now() };
  return url;
}

/** The recipient's first name when the address belongs to an account (sign-up codes go to people without one yet). */
async function firstName(to: string): Promise<string | null> {
  try {
    const [row] = await sql<{ firstName: string | null; displayName: string | null }[]>`
      SELECT first_name, display_name FROM users WHERE lower(email) = lower(${to}) LIMIT 1`;
    const name = (row?.firstName ?? row?.displayName ?? '').trim().split(/\s+/)[0] ?? '';
    return name.length > 0 ? name.slice(0, 40) : null;
  } catch {
    return null;
  }
}

export const SPAM_TIP = "Can't find our emails? Check your spam or junk folder and mark us as \"Not spam\" so the next ones reach your inbox.";

/** Fills the markers: logo, "Hi {name}," and the footer (sent to / spam tip). Text part too. */
export async function personalize(to: string, mail: RenderedMail): Promise<RenderedMail> {
  const [logo, name] = await Promise.all([logoUrl(), firstName(to)]);
  const appName = escapeHtml(env.APP_NAME);
  const hello = name ? `Hi ${name},` : 'Hi there,';
  const html = mail.html
    .replace(
      MARK.logo,
      `<img src="${escapeHtml(logo)}" alt="${appName}" height="36" style="display:block;height:36px;width:auto;max-width:220px;border:0;outline:none;text-decoration:none;color:#22d3ee;font-size:16px;letter-spacing:3px">`,
    )
    .replace(MARK.greeting, `<tr><td style="font-size:15px;line-height:24px;color:#e5e7eb;padding-bottom:8px">${escapeHtml(hello)}</td></tr>`)
    .replace(
      MARK.footer,
      `<tr><td style="padding:20px 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#6b7280;text-align:center">` +
        `This email was sent to <span style="color:#9ca3af">${escapeHtml(to)}</span> by ${appName}.<br>${escapeHtml(SPAM_TIP)}</td></tr>`,
    );
  const text = `${hello}\n\n${mail.text}\n\n--\nThis email was sent to ${to} by ${env.APP_NAME}.\n${SPAM_TIP}`;
  return { ...mail, html, text };
}
