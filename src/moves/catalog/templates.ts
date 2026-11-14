/**
 * Scene templates: how a whole intro, scene or outro is staged. Each becomes
 * the scene's description when applied (the user can edit it). Append only.
 *
 *   [name, direction, camera, light, seconds, moods, whenToUse, tags?]
 */
type Row = [name: string, direction: string, camera: string, light: string, seconds: number, moods: string, whenToUse: string, tags?: string[]];

export interface TemplateBlock {
  code: string;
  kind: 'INTRO' | 'SCENE' | 'OUTRO';
  domain: 'MUSIC' | 'AD';
  rows: Row[];
}

export const templateBlocks: TemplateBlock[] = [
  {
    code: 'MI',
    kind: 'INTRO',
    domain: 'MUSIC',
    rows: [
      ['Cold Open Silhouette', 'The artist stands motionless in silhouette against a hazy backlight; on the first vocal they step forward into a soft key light.', 'Static wide, slow push-in on the step', 'Hard backlight, haze, soft key on the reveal', 6, 'yc', 'Mysterious or confident songs that open with a sparse intro.'],
      ['City Wake-Up', 'Dawn over the city: an empty street, a shop shutter rolling up, then the artist walking out of a doorway pulling on a jacket.', 'Handheld, eye level, following', 'Blue-hour natural light', 8, 'nh', 'Hometown and hustle songs.', ['city']],
      ['Studio Voice-Note', 'Inside a small studio the artist presses record on a phone, hums the melody, laughs, and the beat drops in.', 'Close handheld, shallow focus', 'Practical studio lamps', 6, 'pn', 'Behind-the-music intros, Afro and R&B.'],
      ['Car Interior Monologue', 'Night drive: the artist in the passenger seat, street lights sliding across the face, speaking the first line to the window.', 'Static on the dash, profile', 'Moving street light, dark cabin', 6, 'nsy', 'Reflective rap and R&B intros.'],
      ['Crowd Roar Build', 'A packed venue chanting the artist\'s name in darkness; a single spotlight finds the empty mic.', 'Wide from the back of the crowd', 'Dark house, single spot', 6, 'th', 'Anthems and live-feel videos.', ['crowd']],
      ['Letter on the Table', 'Macro on a handwritten letter and a ring on a wooden table; a hand picks up the ring as the piano starts.', 'Macro slider', 'Window light, warm', 5, 'rsn', 'Love and heartbreak ballads.'],
      ['Village Morning', 'Smoke from a cooking fire, children running, an elder nodding as the artist walks through the compound.', 'Gimbal, slow, wide to medium', 'Morning sun, natural haze', 8, 'nhg', 'Roots, highlife and heritage songs.'],
      ['Mirror Prep', 'Backstage mirror: the artist fixes their collar, meets their own eyes, and breathes out.', 'Over-the-shoulder into the mirror', 'Mirror bulbs', 5, 'cg', 'Confidence and comeback songs.'],
      ['Rain on Glass', 'Rain streaks a window; behind it the artist sits on a bed looking out, unmoving.', 'Through the window, static', 'Grey daylight', 6, 's', 'Sad and reflective songs.', ['rain']],
      ['Church Doors', 'Heavy church doors swing open onto a choir mid-hum; the artist walks up the aisle.', 'Steadicam down the aisle', 'Stained-glass daylight', 8, 'g', 'Gospel and spiritual songs.'],
      ['Phone Screen Story', 'A phone screen lights up with a message; the thumb hovers, deletes, types again; the artist\'s face lit by the screen.', 'Close-up, screen and face', 'Screen glow in a dark room', 5, 'rsp', 'Modern love and situationship songs.'],
      ['Dance Floor Hush', 'A dance floor freezes mid-move as the music cuts; the artist walks through the frozen dancers.', 'Gimbal through the crowd', 'Club lights, frozen strobe', 6, 'cp', 'Club and Afro-house intros.', ['dancers']],
    ],
  },
  {
    code: 'MS',
    kind: 'SCENE',
    domain: 'MUSIC',
    rows: [
      ['One-Light Performance', 'The artist performs the verse to camera in a dark room lit by one bare bulb swinging gently overhead.', 'Medium close, locked off', 'Single practical bulb', 8, 'ysd', 'Raw, honest verses.'],
      ['Rooftop Golden Hour', 'Performance on a rooftop at golden hour, the city behind, wind in the clothes.', 'Slow orbit, medium', 'Low sun, rim light', 8, 'tnh', 'Uplifting choruses.'],
      ['Living-Room Session', 'The band plays in a lived-in living room; the artist sings on the sofa arm, friends listening.', 'Handheld, roaming', 'Warm lamps, window light', 10, 'hn', 'Acoustic and soul.'],
      ['Neon Alley', 'The artist walks and sings through a narrow alley of neon signs, steam rising from a grate.', 'Tracking backward, medium', 'Neon colour, wet ground reflections', 8, 'yx', 'Late-night R&B and trap.'],
      ['Market Chorus', 'The chorus erupts in a busy market: traders join in, a crowd forms and dances around the artist.', 'Wide crane down to medium', 'Midday sun, colourful canopies', 10, 'h', 'Afrobeats and highlife choruses.', ['crowd']],
      ['Stairwell Echo', 'The artist sings in a concrete stairwell, voice echoing, light from a window high above.', 'Low angle looking up', 'Single shaft of daylight', 6, 'sgy', 'Bridges and stripped moments.'],
      ['Car Bonnet Hang', 'Friends sit on car bonnets at a lookout over the city at night, the artist singing among them.', 'Wide, slow dolly', 'City glow, practical torches', 8, 'nh', 'Friendship and summer songs.', ['crew']],
      ['Bedroom Dawn', 'Morning light through curtains; the artist sings sitting on an unmade bed, sheets around them.', 'Static medium, slight drift', 'Soft window light', 8, 'rx', 'Intimate love songs.'],
      ['Warehouse Crew', 'The crew dances in an empty warehouse with one big light behind them, dust in the air.', 'Wide low angle', 'Hard backlight, haze', 10, 'cd', 'Dance breaks and hype choruses.', ['dancers']],
      ['Beach Night Fire', 'A bonfire on the beach at night, friends around it, the artist singing and the waves behind.', 'Handheld, close and wide', 'Firelight', 10, 'rnh', 'Love and nostalgia.'],
      ['Studio Live Take', 'The full band records live in a studio, the artist in a booth, everyone watching each other through the glass.', 'Multiple handheld angles', 'Studio practicals', 10, 'cn', 'Authentic performance videos.', ['band']],
      ['Rain Street Performance', 'The artist sings in the middle of an empty street in pouring rain, unmoving, as cars pass slowly.', 'Wide, slow push-in', 'Street lights, rain', 8, 'sd', 'Emotional peaks.', ['rain']],
      ['Barber Shop Verse', 'The artist raps from the barber chair, the barber working, the shop reacting to the lines.', 'Handheld, mirror reflections', 'Fluorescent shop light', 8, 'pc', 'Storytelling rap and Afro verses.'],
      ['Wedding Dance', 'A wedding reception: the couple on the dance floor, the artist singing among the guests.', 'Gimbal around the couple', 'Warm string lights', 10, 'rh', 'Love songs and celebration.'],
      ['Field of Grass', 'The artist walks through tall grass at sunset, fingertips brushing the tops.', 'Wide then tracking', 'Sunset backlight', 8, 'nrm', 'Peaceful and nostalgic bridges.'],
      ['Mirror Room', 'The artist performs surrounded by mirrors, the reflections multiplying every move.', 'Slow dolly', 'Clean soft light', 8, 'yx', 'Self-reflection and identity songs.'],
    ],
  },
  {
    code: 'MO',
    kind: 'OUTRO',
    domain: 'MUSIC',
    rows: [
      ['Fade to Silhouette', 'The artist walks away into the backlight until only the silhouette remains, then the light fades.', 'Static wide', 'Backlight fading', 6, 'gy', 'Spiritual or mysterious endings.'],
      ['Empty Stage', 'The crowd has gone; the artist sits alone on the edge of the stage, mic beside them, and smiles.', 'Slow pull-back', 'Work lights', 6, 'nt', 'After-the-show endings.'],
      ['Morning After', 'Sunlight in the room the party was in; the artist picks up a cup, laughs to themselves, opens the curtains.', 'Handheld, gentle', 'Bright morning light', 6, 'hn', 'Party and celebration songs.'],
      ['Hands Apart', 'Two hands slowly let go of each other; one stays in frame.', 'Macro', 'Soft window light', 5, 'sr', 'Breakup and goodbye songs.'],
      ['Drive Into the Dawn', 'The car drives away down an empty road toward the sunrise.', 'Static wide from behind', 'Dawn light', 6, 'nt', 'New beginnings.'],
      ['Final Look to Lens', 'The artist looks into the lens for a long moment, a small nod, and the frame cuts to black.', 'Close-up, locked off', 'Soft key', 5, 'cr', 'Direct, personal endings.'],
      ['Credits Over Behind-the-Scenes', 'Behind-the-scenes clips: laughter, mistakes, the crew hugging, while the instrumental plays out.', 'Mixed handheld', 'Mixed', 10, 'hp', 'Feel-good endings.'],
      ['Choir Final Hold', 'The choir holds the last chord, the artist with arms open, the light rising to white.', 'Slow crane up', 'Light rising to white', 6, 'g', 'Gospel finales.'],
    ],
  },
  {
    code: 'AI',
    kind: 'INTRO',
    domain: 'AD',
    rows: [
      ['Problem in Two Seconds', 'Open on the problem the product solves, shown in one relatable moment with a frustrated sigh.', 'Close-up, handheld', 'Natural, everyday', 3, 'p', 'Problem-solution ads; stops the scroll.'],
      ['Product Drop', 'The product drops into frame onto a clean surface with a satisfying thud.', 'Overhead or macro', 'Clean studio light', 2, 'c', 'Product-first launches.'],
      ['Question to Camera', 'A presenter looks into the lens and asks the question every viewer is thinking.', 'Medium close-up', 'Bright, natural', 3, 'pc', 'Educational and service ads.'],
      ['Before-and-After Split', 'A split screen: life before on one side, after on the other.', 'Locked off, matched framing', 'Matched', 3, 'th', 'Transformation products.'],
      ['Unexpected Moment', 'Something surprising happens in an ordinary scene (a spill, a laugh, a surprise visitor) and the product saves the day.', 'Handheld', 'Natural', 3, 'ph', 'Humorous and lifestyle brands.'],
      ['Sound-On Hook', 'A strong sound (a can opening, a sizzle, a beat drop) with a close-up of its source.', 'Macro', 'Contrasty', 2, 'c', 'Food, drink and tech.'],
    ],
  },
  {
    code: 'AS',
    kind: 'SCENE',
    domain: 'AD',
    rows: [
      ['Demo on the Counter', 'Hands demonstrate the product on a kitchen counter, step by step, close and clear.', 'Overhead and 45°', 'Soft daylight', 6, 'c', 'How-it-works scenes.'],
      ['Day-in-the-Life Montage', 'Three quick moments across a day with the product naturally present in each.', 'Handheld, quick cuts', 'Natural, shifting through the day', 8, 'h', 'Lifestyle positioning.'],
      ['Street Interview', 'A presenter asks people in the street to try the product; real, varied reactions.', 'Handheld two-shot', 'Daylight', 8, 'hp', 'Social proof.'],
      ['Expert at Work', 'A professional (chef, nurse, engineer) uses the product while working and explains why.', 'Medium, documentary', 'Practical workplace light', 8, 'c', 'Credibility and B2B.'],
      ['Family Table', 'A family shares a meal; the product is passed around; conversation and laughter.', 'Wide then close-ups', 'Warm evening light', 8, 'hr', 'Food and household.'],
      ['Hero Packshot', 'The product on a plinth turning slowly, light raking across the label.', 'Slow orbit, macro', 'Studio, rim light', 4, 'c', 'Premium products.'],
      ['Customer Story', 'A customer at home or at work tells what changed, cut with shots of them living it.', 'Interview + b-roll', 'Natural', 10, 'mn', 'Testimonials.'],
    ],
  },
  {
    code: 'AO',
    kind: 'OUTRO',
    domain: 'AD',
    rows: [
      ['Packshot and Logo', 'The product centred on a clean background, the logo and offer appearing beside it.', 'Locked off', 'Clean studio', 3, 'c', 'Every ad\'s safe ending.'],
      ['Smile and Call to Action', 'The presenter smiles, says the call to action, and points to where the link appears.', 'Medium close-up', 'Bright', 3, 'hc', 'Direct-response ads.'],
      ['Shopfront Reveal', 'The camera pulls back to reveal the shop or venue with people walking in.', 'Pull-back wide', 'Golden hour', 4, 'h', 'Local businesses and events.'],
      ['Community Close', 'Everyone from the ad turns to the camera together, smiling, as the logo appears.', 'Wide', 'Warm', 3, 'ht', 'Community and membership brands.'],
      ['Tagline on Black', 'Cut to black with the tagline, then the logo, a single sound accent.', 'Graphic', 'Black', 3, 'cy', 'Premium and emotional ads.'],
    ],
  },
];
