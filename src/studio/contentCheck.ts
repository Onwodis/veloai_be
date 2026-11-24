/**
 * Content check: the words in a scene that image and video models' safety filters commonly refuse
 * (weapons, smoking and drugs, gore, sexual wording…), with a suggestion for each.
 *
 * Free and instant (no AI call): it runs on every scene in the project view, so the artist sees a
 * warning BEFORE paying for a take, and on a take the engine refused ("flagged by a content
 * checker") it names what most likely triggered it. The AI rewrite ("Fix it", musicvideo
 * service) is only called when the artist asks for it.
 */

export interface ContentRisk {
  category: string;
  label: string;
  /** The words found in the scene, as written. */
  words: string[];
  suggestion: string;
}

interface Rule {
  category: string;
  label: string;
  pattern: RegExp;
  suggestion: string;
}

const RULES: Rule[] = [
  {
    category: 'weapons',
    label: 'Weapons',
    pattern:
      /\b(guns?|pistols?|rifles?|firearms?|sidearms?|holster(?:ed|s)?|shotguns?|revolvers?|handguns?|ak-?47s?|uzis?|ammo|ammunition|bullets?|grenades?|knives|knife|machetes?|swords?|daggers?|armed)\b/gi,
    suggestion: 'Show power without weapons: bodyguards in black suits with earpieces and folded arms, a hard stare, a slow walk.',
  },
  {
    category: 'smoking',
    label: 'Smoking or drugs',
    pattern:
      /\b(cigars?|cigarettes?|cigs?|smok(?:e|es|ed|ing|y)(?! machine)|tobacco|(?:wooden|tobacco|smoking|crack|clay) pipes?|joints?|blunts?|weed|marijuana|cannabis|vap(?:e|es|ing)|hookah|shisha|cocaine|coke lines?|drugs?|pills?|syringes?|needles?|codeine)\b/gi,
    suggestion: 'Swap it for a prop that keeps the attitude: a glass of a drink, sunglasses, a toothpick, a gold lighter clicked shut, haze from the club lights instead of smoke.',
  },
  {
    category: 'violence',
    label: 'Violence or gore',
    pattern: /\b(blood(?:y|ied)?|gore|gory|stab(?:s|bed|bing)?|gunshots?|shoot(?:s|ing)? (?:him|her|them|at)|kill(?:s|ed|ing)?|murder(?:s|ed)?|corpses?|dead bod(?:y|ies)|wounds?|bruis(?:e|ed|es)|beaten up|strangl\w*|tortur\w*)\b/gi,
    suggestion: 'Imply the danger instead of showing harm: tense faces, a chase, a slammed door, shattered glass, a cut to black.',
  },
  {
    category: 'sexual',
    label: 'Sexual or revealing wording',
    pattern:
      /\b(nude|naked|topless|nipples?|lingerie|underwear|thongs?|g-strings?|strip(?:per|pers|ping|tease)|erotic|sensual|seductive(?:ly)?|sexy|horny|twerk(?:s|ing)?|grind(?:s|ing)? on|cleavage|breasts?|boobs?|butt|booty|bum ?bum|ass)\b/gi,
    suggestion: 'Describe styling and attitude, not body parts: "fitted satin dress, confident, playful smile, dances close to him".',
  },
  {
    category: 'minors',
    label: 'Minors',
    pattern: /\b(underage|schoolgirls?|schoolboys?|minors?|little (?:girl|boy)|teen(?:age|ager|agers)?)\b/gi,
    suggestion: 'Make every person clearly an adult (e.g. "a woman in her twenties"), especially in any romantic or party scene.',
  },
  {
    category: 'hate',
    label: 'Hate symbols',
    pattern: /\b(nazis?|swastikas?|kkk|white power)\b/gi,
    suggestion: 'Remove hate symbols and slogans entirely.',
  },
  {
    category: 'self-harm',
    label: 'Self-harm',
    pattern: /\b(suicid\w*|self-harm\w*|overdos\w*|slit (?:her|his) wrists?|hang(?:s|ed|ing) (?:herself|himself))\b/gi,
    suggestion: 'Show the emotion (grief, isolation, rain on a window) without the act.',
  },
];

/** True when an engine refused a job for its content (rather than a technical error). */
export function isContentFlag(error: string | null | undefined): boolean {
  return Boolean(error && /content checker|content (?:policy|moderation|filter)|flagged|nsfw|safety (?:checker|filter|system)|inappropriate|not allowed by|violat\w* (?:our|the) (?:policy|policies|guidelines)/i.test(error));
}

/** The risky words in a piece of text, grouped by category (each word listed once). */
export function checkContent(...texts: (string | null | undefined)[]): ContentRisk[] {
  const text = texts.filter(Boolean).join('\n');
  if (!text.trim()) return [];
  const risks: ContentRisk[] = [];
  for (const rule of RULES) {
    const words = [...new Set([...text.matchAll(rule.pattern)].map((match) => match[0].toLowerCase()))];
    if (words.length) risks.push({ category: rule.category, label: rule.label, words: words.slice(0, 8), suggestion: rule.suggestion });
  }
  return risks;
}

/** For a refused take: what most likely triggered it, and what to do about it. */
export function contentAdvice(...texts: (string | null | undefined)[]): { risks: ContentRisk[]; note: string } {
  const risks = checkContent(...texts);
  return {
    risks,
    note: risks.length
      ? 'The film engine refused this scene for its content. The words below are the most likely cause: change them (or press Fix it) and generate again. Nothing was charged.'
      : "The film engine refused this scene for its content, but the script has no obvious trigger words, so it was probably a cast photo or the mix of the scene (e.g. a revealing outfit with a provocative action). Press Fix it for a closer look, or try a different cast photo. Nothing was charged.",
  };
}
