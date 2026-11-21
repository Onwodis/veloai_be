/**
 * YouTube films: the kinds of film a show can make and the soundtrack moods. Each kind tells the
 * writer how to shape the story; each mood tells the soundtrack generator what to play.
 */
export const FILM_KINDS = {
  'short-film': { label: 'Short film', brief: 'A complete cinematic short story with a beginning, a turn and an ending; characters, conflict and a payoff.' },
  story: { label: 'Narrated story', brief: 'A gripping story told by a narrator over cinematic scenes, like a mini-documentary of one moment.' },
  documentary: { label: 'Documentary', brief: 'A factual mini-documentary: a hook question, three to five strong facts or turning points, and a closing thought. Only state facts that are widely known and true.' },
  history: { label: 'History', brief: 'A historical episode brought to life: the setting, the people, the turning point and why it still matters. Accurate to the record.' },
  mystery: { label: 'Mystery & true crime', brief: 'A suspenseful case: the hook, the clues, the twist and the open question. Fictional unless the niche says otherwise; never accuse real living people.' },
  motivation: { label: 'Motivation', brief: 'A powerful motivational piece: a relatable struggle, a turning point and a call to act, narrated with conviction.' },
  explainer: { label: 'Explainer', brief: 'A clear explainer: one question answered in simple steps, each shown with a cinematic visual metaphor.' },
  'kids-tale': { label: 'Kids tale', brief: 'A warm, gentle tale for children with a simple lesson; friendly characters, nothing scary.' },
  'sci-fi': { label: 'Sci-fi', brief: 'A science-fiction short: a striking world, a single big idea and a twist.' },
  horror: { label: 'Horror', brief: 'A short horror piece built on atmosphere and dread rather than gore; a final sting.' },
} as const;
export type FilmKind = keyof typeof FILM_KINDS;
export const FILM_KIND_IDS = Object.keys(FILM_KINDS) as [FilmKind, ...FilmKind[]];

export const MOODS = {
  epic: { label: 'Epic orchestral', prompt: 'epic cinematic orchestral score, big drums, soaring strings, trailer energy' },
  suspense: { label: 'Suspense', prompt: 'dark suspenseful cinematic underscore, low pulsing synths, ticking tension, sparse piano' },
  emotional: { label: 'Emotional', prompt: 'emotional cinematic piano and strings, warm, slow build, hopeful' },
  uplifting: { label: 'Uplifting', prompt: 'uplifting inspiring cinematic music, bright strings, steady drums, motivational build' },
  mystery: { label: 'Mystery', prompt: 'mysterious ambient score, airy pads, curious plucks, soft percussion' },
  adventure: { label: 'Adventure', prompt: 'adventurous orchestral theme, brass fanfare, driving strings, sense of wonder' },
  playful: { label: 'Playful', prompt: 'playful light whimsical music, pizzicato strings, glockenspiel, bouncy rhythm' },
  afrobeat: { label: 'Afro cinematic', prompt: 'cinematic afrobeat-inspired score, talking drums, warm guitars, percussive groove' },
  dark: { label: 'Dark & eerie', prompt: 'dark eerie horror ambience, dissonant drones, distant metallic hits, unsettling' },
  lofi: { label: 'Calm lo-fi', prompt: 'calm lo-fi beat, soft keys, mellow drums, relaxed' },
} as const;
export type Mood = keyof typeof MOODS;
export const MOOD_IDS = Object.keys(MOODS) as [Mood, ...Mood[]];

/** The narrator voices offered (stock voices of the speech engine). */
export const NARRATORS = ['Brian', 'George', 'Daniel', 'Bill', 'Eric', 'Callum', 'Aria', 'Sarah', 'Charlotte', 'Alice', 'Lily', 'Matilda'] as const;
