/**
 * The mail module's last step, applied to every email in sendMail(): the app's logo at the top,
 * a greeting with the recipient's first name, and a footer naming the address it was sent to with a
 * reminder to check spam. Templates (templates.ts) only leave markers; filling them here means every
 * email is branded and addressed the same way, whoever sends it.
 *
 * Logo: always the app's wordmark (data/brand/mail-logo.png), attached to the message itself as an
 * inline image (cid), so it shows without depending on a public URL (dev's WEB_APP_URL is localhost,
 * and many clients block remote images). The text part and clients that drop inline images fall
 * back to the alt text.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import { sql } from '../../studio/sql.js';
import { logger } from '../../utils/logger.js';
import type { RenderedMail } from './templates.js';

export const MARK = { logo: '<!--mail:logo-->', greeting: '<!--mail:greeting-->', footer: '<!--mail:footer-->' } as const;

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const LOGO_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'brand', 'mail-logo.png');
const LOGO_CID = 'app-logo@mail';
const hasLogoFile = existsSync(LOGO_FILE);
if (!hasLogoFile) logger.warn({ file: LOGO_FILE }, 'mail logo file missing: emails link the hosted logo instead');

/** The logo in an email: the attached file (cid), else the copy the web app hosts. */
function logoSource(): { src: string; attachment: NonNullable<RenderedMail['attachments']>[number] | null } {
  if (hasLogoFile) return { src: `cid:${LOGO_CID}`, attachment: { filename: 'logo.png', path: LOGO_FILE, cid: LOGO_CID, contentType: 'image/png' } };
  return { src: `${env.WEB_APP_URL.replace(/\/+$/, '')}/brand/logo-still.png`, attachment: null };
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
  const { src: logo, attachment } = logoSource();
  const name = await firstName(to);
  const appName = escapeHtml(env.APP_NAME);
  const hello = name ? `Hi ${name},` : 'Hi there,';
  const html = mail.html
    .replace(
      MARK.logo,
      `<img src="${escapeHtml(logo)}" alt="${appName}" width="240" height="45" style="display:block;width:240px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;color:#22d3ee;font-size:16px;letter-spacing:3px">`,
    )
    .replace(MARK.greeting, `<tr><td style="font-size:15px;line-height:24px;color:#e5e7eb;padding-bottom:8px">${escapeHtml(hello)}</td></tr>`)
    .replace(
      MARK.footer,
      `<tr><td style="padding:20px 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#6b7280;text-align:center">` +
        `This email was sent to <span style="color:#9ca3af">${escapeHtml(to)}</span> by ${appName}.<br>${escapeHtml(SPAM_TIP)}</td></tr>`,
    );
  const text = `${hello}\n\n${mail.text}\n\n--\nThis email was sent to ${to} by ${env.APP_NAME}.\n${SPAM_TIP}`;
  return { ...mail, html, text, attachments: [...(mail.attachments ?? []), ...(attachment && html.includes(`cid:${LOGO_CID}`) ? [attachment] : [])] };
}
