/**
 * Transactional email templates. Table-based, inline-styled HTML that renders
 * in every mainstream client, plus a plain-text part.
 */
import { env } from '../../config/env.js';
import { MARK } from './brand.js';

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
  template: string;
  /** Inline images (the logo, see brand.ts), referenced from the HTML as cid:… */
  attachments?: { filename: string; path: string; cid: string; contentType: string }[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function layout(params: { heading: string; intro: string; cta?: { label: string; url: string }; code?: string; outro?: string }): string {
  const name = escapeHtml(env.APP_NAME);
  const button = params.cta
    ? `<tr><td style="padding:8px 0 24px"><a href="${escapeHtml(params.cta.url)}" style="display:inline-block;padding:14px 28px;border-radius:12px;background:#6d28d9;background-image:linear-gradient(135deg,#7c3aed,#a21caf);color:#ffffff;font-weight:600;text-decoration:none;font-family:Helvetica,Arial,sans-serif">${escapeHtml(params.cta.label)}</a></td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#0b1020;padding:32px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#111827;border:1px solid #1f2937;border-radius:20px;padding:32px;font-family:Helvetica,Arial,sans-serif;color:#e5e7eb">
<tr><td style="font-size:13px;letter-spacing:4px;color:#22d3ee;padding-bottom:24px">${MARK.logo}<span style="display:none">${name.toUpperCase()}</span></td></tr>
<tr><td style="font-size:24px;font-weight:700;color:#ffffff;padding-bottom:12px">${escapeHtml(params.heading)}</td></tr>
${MARK.greeting}
<tr><td style="font-size:15px;line-height:24px;color:#d1d5db;padding-bottom:24px">${escapeHtml(params.intro)}</td></tr>
${params.code ? `<tr><td style="padding:4px 0 24px"><span style="display:inline-block;padding:14px 22px;border-radius:12px;background:#0b1020;border:1px solid #374151;font-family:Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:10px;color:#ffffff">${escapeHtml(params.code)}</span></td></tr>` : ''}
${button}
${params.outro ? `<tr><td style="font-size:13px;line-height:20px;color:#9ca3af">${escapeHtml(params.outro)}</td></tr>` : ''}
</table></td></tr>
${MARK.footer}
</table></body></html>`;
}

export function passwordResetMail(url: string): RenderedMail {
  const intro = `Someone asked to reset the password for your ${env.APP_NAME} account. The link works once and expires in 30 minutes.`;
  const outro = "If you didn't ask for this, ignore this email; your password stays the same.";
  return {
    template: 'password_reset',
    subject: `Reset your ${env.APP_NAME} password`,
    html: layout({ heading: 'Reset your password', intro, cta: { label: 'Choose a new password', url }, outro }),
    text: `${intro}\n\n${url}\n\n${outro}`,
  };
}

export function signupCodeMail(code: string): RenderedMail {
  const intro = `Use this code to confirm your email and finish creating your ${env.APP_NAME} account. It expires in 10 minutes.`;
  const outro = "If you didn't start signing up, ignore this email: no account is created without the code.";
  return {
    template: 'signup_code',
    subject: `${code} is your ${env.APP_NAME} sign-up code`,
    html: layout({ heading: 'Your sign-up code', intro, code, outro }),
    text: `Your sign-up code: ${code}\n\n${intro}\n\n${outro}`,
  };
}

export function emailCodeMail(code: string): RenderedMail {
  const intro = `Use this code to confirm your email address on ${env.APP_NAME}. It expires in 10 minutes.`;
  const outro = "If you didn't ask for this, ignore this email.";
  return {
    template: 'email_code',
    subject: `${code} is your ${env.APP_NAME} confirmation code`,
    html: layout({ heading: 'Confirm your email', intro, code, outro }),
    text: `Your confirmation code: ${code}\n\n${intro}\n\n${outro}`,
  };
}

/** To the user: the team replied to (or resolved) their ticket. */
export function supportUpdateMail(params: { name: string; number: number; subject: string; heading: string; message: string; url: string }): RenderedMail {
  const intro = `Hi ${params.name}, ${params.message}`;
  return {
    template: 'support_update',
    subject: `[#${params.number}] ${params.subject}`,
    html: layout({ heading: params.heading, intro, cta: { label: `Open ticket #${params.number}`, url: params.url }, outro: 'Reply on the ticket page; replying to this email does not reach us.' }),
    text: `${intro}\n\nOpen the ticket: ${params.url}`,
  };
}

/** To the super admins: a new ticket, or a user's reply on one. */
export function supportStaffMail(params: { kind: 'new' | 'reply'; number: number; subject: string; category: string; from: string; email: string; body: string; url: string }): RenderedMail {
  const heading = params.kind === 'new' ? `New ticket #${params.number}` : `Reply on ticket #${params.number}`;
  const intro = `${params.from} (${params.email}) ${params.kind === 'new' ? `opened a ${params.category.toLowerCase()} ticket` : 'replied'}: “${params.subject}”. ${params.body.slice(0, 600)}${params.body.length > 600 ? '…' : ''}`;
  return {
    template: 'support_staff',
    subject: `${env.APP_NAME} support: ${heading}: ${params.subject}`,
    html: layout({ heading, intro, cta: { label: 'Open in the console', url: params.url } }),
    text: `${intro}\n\n${params.url}`,
  };
}

export function newUserMail(params: { name: string; email: string; role: string; total: number; url: string }): RenderedMail {
  const heading = `New sign-up: ${params.name}`;
  const intro = `A new account was created and its email confirmed: ${params.name} (${params.email}), signed up as ${params.role.toLowerCase()}. That makes ${params.total.toLocaleString('en')} accounts in total.`;
  return {
    template: 'new_user',
    subject: `${env.APP_NAME}: new sign-up, ${params.name}`,
    html: layout({ heading, intro, cta: { label: 'Open the user', url: params.url } }),
    text: `${intro}\n\n${params.url}`,
  };
}

export function verifyEmailMail(url: string, bonus: number): RenderedMail {
  const intro = `Confirm this is your email address to finish setting up your ${env.APP_NAME} account${bonus > 0 ? ` and get your ${bonus.toLocaleString('en')} welcome tokens` : ''}. The link expires in 48 hours.`;
  const outro = "If you didn't create this account, ignore this email.";
  return {
    template: 'verify_email',
    subject: `Confirm your email for ${env.APP_NAME}`,
    html: layout({ heading: 'Confirm your email', intro, cta: { label: 'Confirm my email', url }, outro }),
    text: `${intro}\n\n${url}\n\n${outro}`,
  };
}

export function mfaResetMail(url: string): RenderedMail {
  const intro = `A request was made to remove two-factor authentication from your ${env.APP_NAME} account because the authenticator app is unavailable. Confirming signs you out everywhere; you will set up a new authenticator at your next sign-in. The link expires in 30 minutes.`;
  const outro = "If you didn't ask for this, someone knows your password: ignore this email and reset your password now.";
  return {
    template: 'mfa_reset',
    subject: `Confirm two-factor reset for ${env.APP_NAME}`,
    html: layout({ heading: 'Reset two-factor authentication', intro, cta: { label: 'Confirm 2FA reset', url }, outro }),
    text: `${intro}\n\n${url}\n\n${outro}`,
  };
}

export function llmAlarmMail(params: { usedPercent: number; alarmPercent: number; balance: number; funded: number; url: string; test?: boolean }): RenderedMail {
  const fmt = (value: number): string => value.toLocaleString('en');
  const heading = params.test ? 'Test: LLM token alarm' : `${params.usedPercent}% of the LLM token wallet is used`;
  const intro = `${params.test ? 'This is a test of the alarm. ' : ''}${env.APP_NAME} has used ${fmt(Math.max(0, params.funded - params.balance))} of the ${fmt(params.funded)} LLM tokens you recorded (alarm set at ${params.alarmPercent}%). ${fmt(params.balance)} tokens remain. Buy more credit from your provider, then record it on the launch guard page so the alarm recalibrates.`;
  const outro = 'Calls are not blocked when the wallet runs out, so provider charges can exceed what you recorded.';
  return {
    template: 'llm_alarm',
    subject: `${params.test ? '[Test] ' : ''}${env.APP_NAME}: LLM token wallet ${params.usedPercent}% used`,
    html: layout({ heading, intro, cta: { label: 'Open launch guard', url: params.url }, outro }),
    text: `${intro}\n\n${params.url}\n\n${outro}`,
  };
}

/* ------------------------------------------------------------------ cloud storage */

export function storageExpiringMail(params: { pack: string; endsOn: string; daysLeft: number; usedLabel: string; freeLabel: string; url: string }): RenderedMail {
  const heading = `Your ${params.pack} storage ends ${params.daysLeft <= 1 ? 'tomorrow' : `in ${params.daysLeft} days`}`;
  const intro = `Your paid cloud storage (${params.pack}) ends on ${params.endsOn}. You are using ${params.usedLabel}; the free allowance is ${params.freeLabel}. Renew it so your saved videos, photos and films stay backed up. If it lapses and you are over the free allowance, the oldest generated files are deleted after a short grace period.`;
  const outro = 'Prefer not to renew? Download what you want to keep and delete it from your storage page before the date above.';
  return {
    template: 'storage_expiring',
    subject: `${env.APP_NAME}: ${heading.toLowerCase()}`,
    html: layout({ heading, intro, cta: { label: 'Renew storage', url: params.url }, outro }),
    text: `${intro}\n\n${params.url}\n\n${outro}`,
  };
}

export function storageOverQuotaMail(params: { usedLabel: string; quotaLabel: string; overLabel: string; deleteOn: string; url: string }): RenderedMail {
  const heading = 'Your cloud storage is over its limit';
  const intro = `You are using ${params.usedLabel} of ${params.quotaLabel} (${params.overLabel} over). Buy more storage, or download and delete files, before ${params.deleteOn}. After that date the oldest generated files (takes, renders, creations) are deleted automatically until you are back within your allowance. Your own uploads are never deleted automatically.`;
  return {
    template: 'storage_over_quota',
    subject: `${env.APP_NAME}: storage over its limit, action needed by ${params.deleteOn}`,
    html: layout({ heading, intro, cta: { label: 'Buy storage or free up space', url: params.url } }),
    text: `${intro}\n\n${params.url}`,
  };
}

export function storagePurgedMail(params: { files: number; freedLabel: string; usedLabel: string; quotaLabel: string; url: string }): RenderedMail {
  const heading = 'Old generated files were removed';
  const intro = `Your storage stayed over its limit past the grace period, so ${params.files} of the oldest generated file(s) (${params.freedLabel}) were deleted. You now use ${params.usedLabel} of ${params.quotaLabel}. Buy storage to keep more of your work backed up.`;
  return {
    template: 'storage_purged',
    subject: `${env.APP_NAME}: ${params.files} old file(s) removed from your storage`,
    html: layout({ heading, intro, cta: { label: 'Open storage', url: params.url } }),
    text: `${intro}\n\n${params.url}`,
  };
}

export function testMail(credentialLabel: string): RenderedMail {
  const intro = `This is a test message from ${env.APP_NAME}, sent through the SMTP account "${credentialLabel}". If you can read it, outgoing mail works.`;
  return {
    template: 'smtp_test',
    subject: `${env.APP_NAME} SMTP test`,
    html: layout({ heading: 'SMTP is working', intro }),
    text: intro,
  };
}

export function kycDecisionMail(params: { approved: boolean; level: number; reason?: string; url: string }): RenderedMail {
  const what = params.level === 3 ? 'business' : 'identity';
  const heading = params.approved ? `Your ${what} is verified` : `We could not verify your ${what} yet`;
  const intro = params.approved
    ? `Thanks for verifying. Your ${env.APP_NAME} account is now at verification level ${params.level}, and everything that needs it is open to you.`
    : `We reviewed your documents and need you to fix something before we can verify you: ${params.reason ?? 'the documents could not be read'}. Upload them again from Verification in your dashboard.`;
  const outro = 'Your documents are private: only the reviewer sees them, through links that expire in minutes. ID numbers are never stored.';
  return {
    template: params.approved ? 'kyc_approved' : 'kyc_rejected',
    subject: `${env.APP_NAME}: ${heading.toLowerCase()}`,
    html: layout({ heading, intro, cta: { label: params.approved ? 'Open your dashboard' : 'Upload again', url: params.url }, outro }),
    text: `${intro}\n\n${params.url}\n\n${outro}`,
  };
}

export function dataRequestClosedMail(params: { type: string; status: 'DONE' | 'REJECTED'; response: string; url: string }): RenderedMail {
  const heading = params.status === 'DONE' ? 'Your data request is complete' : 'About your data request';
  const intro = `Your ${params.type.toLowerCase()} request has been answered: ${params.response}`;
  const outro = 'If you are not satisfied with this answer, you can complain to the Nigeria Data Protection Commission (NDPC).';
  return {
    template: 'data_request_closed',
    subject: `${env.APP_NAME}: ${heading.toLowerCase()}`,
    html: layout({ heading, intro, cta: { label: 'See Privacy & data', url: params.url }, outro }),
    text: `${intro}\n\n${params.url}\n\n${outro}`,
  };
}

/* ------------------------------------------------------------------ music video: artist upload link */

export function artistIntakeMail(params: { project: string; from: string; song: boolean; photos: number; notes: boolean; url: string }): RenderedMail {
  const parts = [params.song ? 'the song' : '', params.photos ? `${params.photos} photo${params.photos === 1 ? '' : 's'}` : '', params.notes ? 'notes and details' : ''].filter(Boolean);
  const heading = `${params.from} sent the music video material`;
  const intro = `${params.from} filled in the upload link for “${params.project}”${parts.length ? ` and sent ${parts.join(', ')}` : ''}. The link is now closed: open the project to review it and use it. To collect again, reopen the link (that clears what was sent).`;
  return {
    template: 'artist_intake',
    subject: `${env.APP_NAME}: ${params.from} sent the material for “${params.project}”`,
    html: layout({ heading, intro, cta: { label: 'Open the project', url: params.url } }),
    text: `${intro}\n\n${params.url}`,
  };
}

/* ------------------------------------------------------------------ super admin: AI provider errors */

export function aiErrorMail(params: { service: string; endpoint: string; error: string; where: string; count: number; since: string; url: string }): RenderedMail {
  const heading = `AI error: ${params.service}`;
  const repeat = params.count > 1 ? ` It happened ${params.count} times since ${params.since} (this email is sent at most once every 15 minutes per service and error).` : '';
  const intro = `${params.service} returned an error (${params.endpoint}) during ${params.where}: ${params.error}.${repeat}`;
  const outro = 'Check the provider’s balance, keys and status page. Users saw the job fail; tokens held for it are released.';
  return {
    template: 'ai_error',
    subject: `${env.APP_NAME}: ${params.service} error${params.count > 1 ? ` (×${params.count})` : ''}`,
    html: layout({ heading, intro, cta: { label: 'Open the admin console', url: params.url }, outro }),
    text: `${intro}\n\n${params.url}\n\n${outro}`,
  };
}
