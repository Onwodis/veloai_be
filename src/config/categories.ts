/**
 * Industry focus of a project (migration 026). Every project picks one at
 * creation; projects without one are OTHERS; ANONYMOUS is a deliberate choice
 * for work the creator doesn't want classified. KEEP IN SYNC with
 * fe/src/utils/categories.ts and the CHECK constraint.
 */
import { z } from 'zod';

export const PROJECT_CATEGORIES = [
  'ENTERTAINMENT', 'MUSIC', 'RELIGION', 'EDUCATION', 'MEDICINE', 'HEALTH', 'FITNESS', 'SPORTS', 'TECHNOLOGY', 'REAL_ESTATE',
  'BUSINESS', 'FINANCE', 'ECOMMERCE', 'ADVERTISEMENT', 'COMEDY', 'HACKATHON', 'FASHION', 'BEAUTY', 'FOOD', 'TRAVEL',
  'AUTOMOTIVE', 'GAMING', 'POLITICS', 'NEWS', 'NONPROFIT', 'FAMILY', 'KIDS', 'EVENTS', 'AGRICULTURE', 'ENERGY',
  'LEGAL', 'GOVERNMENT', 'ART', 'FILM', 'PODCAST', 'LIFESTYLE', 'ANONYMOUS', 'OTHERS',
] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

export const categorySchema = z.enum(PROJECT_CATEGORIES);
