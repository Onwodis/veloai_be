/**
 * What VeloBot knows about the platform when it plans promotional assets: the
 * products, the exact steps of each flow as they appear in the app, the
 * landing page's sections and the brand look. Kept beside the code so it is
 * updated with it (one place, read by the marketing studio's planner).
 */
import { env } from '../config/env.js';

export function platformKnowledge(): string {
  const app = env.APP_NAME;
  const bot = process.env['BOT_NAME']?.trim() || 'VeloBot';
  return `
# ${app}: what it is
${app} is an AI video studio. Three studios plus tools:
1. Reels from long videos: upload a podcast, stream or webinar; it transcribes every word, scores hooks, finds the best moments, reframes them to 9:16 on the active speaker, adds animated captions, and exports per platform. Each reel can be edited (trim, hook headline, captions).
2. AI films (AI studio): write a script, add photos of yourself or a cast; ${bot} plans shots, generates takes per scene, you pick the best, and it assembles a graded film (looks: natural, filmic, teal & orange, golden hour, cool night, noir, vivid; grain, letterbox, 24 fps).
3. Music video director: your own song + photos → a real music video in 8 stages: Song (upload, lyrics transcribed), Sound (DAW-style editing, mix), Characters (cast from photos, consent), Scene ideas, Director's room (chat with ${bot}), Storyboard (scenes locked to bars and lyrics), Shoot (takes per scene, real lip sync on sung lines), Master (mastering desk: loudness presets -14/-16/-23/-9 LUFS, EQ, L/R locators to master part of the song, AI master with before/after scores, grade, grain, letterbox, opening titles). On the Master page each scene card has a checkbox: select up to 3 consecutive scenes and press "Quick mix & master" to name and download a postable teaser.
4. Commercials: company and products (brand kit, logo), a brief (objective, platform, length up to 60 s, rules), a chat with the ${bot} director, an approved script with spoken lines in real voices, an end card with logo and call to action, then one master re-cut into every feed format (9:16, 1:1, 4:5, 16:9) without re-filming.
Tools: Create (@me) for photoreal images and short videos of yourself from one sentence; My likeness (your face/body profile); Moves & templates (~1000 performance moves, custom moves shared by id + key); Shared links (view-only or download, expiring, rotatable); Contributions (teammates push changes, you review side by side, pull or revert); Storage plans; Tokens (every paid step shows its price first); Privacy & data and Verification (KYC).
Trial: new users can claim free trial tokens for a week; trial and all renders carry the ${app} watermark until removed per project.

# Where things are in the app (for tutorials)
- Sidebar: Overview, Create (@me), AI Studio, Music video director, Ads & promos, Moves & templates, Shared links, Contributions, Reels, My likeness; Account: Storage, Tokens & billing, Profile, Security, Verification, Privacy & data, Support.
- Music video: Music video director → New music video (title, artist, aspect 16:9 / 9:16 / 1:1, category) → the 8-stage tracker at the top; "Next step" panel tells what to do; each stage has an Approve button that unlocks the next.
- Master page layout: monitor + waveform with L/R locators; mastering desk (knobs with ± buttons); shot strip of scene cards (checkbox top-left for quick clips); Finishing card (look, grain, letterbox, loudness, Remove watermark); Master button (shows the token price first).
- Reels: Reels → upload → choose how many reels → progress → gallery of reels → edit each.
- Commercials: Ads & promos → company → product → New ad → brief → Director's room → script → voices → takes → end card → platform versions.

# Landing page (top to bottom)
Hero (footage + 3D, "Reels, films and music videos. Directed by AI."), export platforms marquee, How it works (pinned 3D story: ingest → detect → deliver), Showreel, Pipeline (4 stages), AI that listens (transcription + hook detection), Smart reframe, Before/after slider, AI studio (director's notes → shot list), Music videos, Production stages (lip sync, AI master scores, locators), Commercials (brief → director → script → every format), Manifesto, Creators gallery, Teams (push / review / pull / revert), Studio features grid, Voices (testimonials), Security, FAQ, final call to action.

# Brand look
Dark, cinematic, violet (#8b5cf6) and cyan (#22d3ee) rim light, shallow depth of field, premium and real (never cartoonish or "AI glossy"), people of African and global descent, Lagos and global city settings welcome. Assets for the site carry no text, logos or watermarks unless they are fliers.
`.trim();
}
