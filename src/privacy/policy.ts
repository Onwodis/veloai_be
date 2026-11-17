/**
 * The privacy notice the app shows (NDPR): what we process, why, on what lawful
 * basis, for how long, and the user's rights. One source for the public
 * Privacy page, the sign-up notice and the consent records (policy versions).
 *
 * Bump a version when its text changes materially: consents recorded against an
 * older version are shown as "accepted an earlier version".
 */
export const POLICY_VERSIONS = { TERMS: '2026-11-15', PRIVACY: '2026-11-15' } as const;

export type Purpose = 'TERMS' | 'PRIVACY' | 'AGE' | 'MARKETING' | 'PRODUCT_RESEARCH' | 'LIKENESS';
export type LawfulBasis = 'CONTRACT' | 'CONSENT' | 'LEGAL_OBLIGATION' | 'LEGITIMATE_INTEREST';

export interface PurposeInfo {
  purpose: Purpose;
  label: string;
  required: boolean;
  lawfulBasis: LawfulBasis;
  description: string;
}

/** What a user agrees to (required at sign-up) or opts into (optional, changeable any time). */
export const PURPOSES: PurposeInfo[] = [
  { purpose: 'TERMS', label: 'Terms of service', required: true, lawfulBasis: 'CONTRACT', description: 'The agreement for using the platform.' },
  { purpose: 'PRIVACY', label: 'Privacy notice', required: true, lawfulBasis: 'CONTRACT', description: 'How your personal data is processed (this notice).' },
  { purpose: 'AGE', label: 'I am 18 or older', required: true, lawfulBasis: 'LEGAL_OBLIGATION', description: 'Accounts are for adults only.' },
  { purpose: 'MARKETING', label: 'Product news and offers by email', required: false, lawfulBasis: 'CONSENT', description: 'Occasional emails about new features and offers. Unsubscribe any time.' },
  { purpose: 'PRODUCT_RESEARCH', label: 'Help improve the product', required: false, lawfulBasis: 'CONSENT', description: 'Anonymous usage patterns used to improve features. Never sold.' },
  { purpose: 'LIKENESS', label: 'Use my photos for my own likeness', required: false, lawfulBasis: 'CONSENT', description: 'Your photos are used only to make videos of you, in your projects. Withdraw any time; the derived data is deleted.' },
];

export interface ProcessingRow {
  data: string;
  why: string;
  lawfulBasis: LawfulBasis;
  retention: string;
}

/** The processing table on the Privacy page. */
export const PROCESSING: ProcessingRow[] = [
  { data: 'Account: name, email, date of birth, gender, password hash', why: 'To create and secure your account', lawfulBasis: 'CONTRACT', retention: 'While your account is open, then 30 days' },
  { data: 'Security: sign-in times, IP address, device, 2FA events', why: 'To protect your account and detect fraud', lawfulBasis: 'LEGITIMATE_INTEREST', retention: '12 months' },
  { data: 'Payments: amounts, references (card details stay with the payment provider)', why: 'To sell tokens and storage, keep accounts', lawfulBasis: 'LEGAL_OBLIGATION', retention: '6 years (tax law)' },
  { data: 'Your content: songs, photos, videos, scripts and what the engine makes', why: 'To make what you ask for', lawfulBasis: 'CONTRACT', retention: 'Until you delete it or the storage plan ends' },
  { data: 'Likeness: photos of you and the profile made from them', why: 'To make videos of you, only in your projects', lawfulBasis: 'CONSENT', retention: 'Until you withdraw consent or delete it' },
  { data: 'Identity verification: legal name, country, phone, ID type, ID document and selfie', why: 'To allow commercial use and prevent fraud (KYC)', lawfulBasis: 'LEGAL_OBLIGATION', retention: '5 years after the account closes; ID numbers are never stored, only a fingerprint' },
  { data: 'Support conversations', why: 'To help you', lawfulBasis: 'LEGITIMATE_INTEREST', retention: '2 years' },
];

export const RIGHTS: { right: string; how: string }[] = [
  { right: 'Access and a copy of your data', how: 'Request it from Privacy & data; we answer within 30 days.' },
  { right: 'Correction', how: 'Edit your profile, or ask us to correct anything you cannot edit.' },
  { right: 'Deletion', how: 'Ask for your account and data to be deleted (records the law makes us keep are kept until their time ends).' },
  { right: 'Withdraw consent', how: 'Switch any optional consent off in Privacy & data at any time.' },
  { right: 'Object or restrict', how: 'Ask us to stop or limit a use of your data.' },
  { right: 'Complain', how: 'To the Nigeria Data Protection Commission (NDPC) if you are not satisfied with our answer.' },
];

export const purposeInfo = (purpose: Purpose): PurposeInfo => PURPOSES.find((item) => item.purpose === purpose)!;
export const policyVersionFor = (purpose: Purpose): string => (purpose === 'TERMS' ? POLICY_VERSIONS.TERMS : POLICY_VERSIONS.PRIVACY);
