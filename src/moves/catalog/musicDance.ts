/** Dance and footwork. Append only (ids follow the order). */
import { block } from './dsl.js';

export const dances = block('DANCE', 'DNC', 'WIDE', 2, [
  // Afro and Amapiano
  ['Log-Drum Shoulder Bounce', 'bounces the shoulders loosely on the log drum, knees soft, a lazy half-smile', 'The Amapiano groove: relaxed, behind the beat, never stiff.', 'cvn', 'hpc', 'M', 3, { genres: ['amapiano'], sig: true }],
  ['Amapiano Slow Wind', 'winds the waist slowly with the arms floating low, feet barely moving', 'Smooth Amapiano grooves; keep it unhurried.', 'cn', 'xpc', 'M', 3, { genres: ['amapiano'] }],
  ['Afro Shoulder Shimmy', 'shimmies the shoulders on the off-beat while stepping side to side', 'Light, joyful Afrobeats movement; smile through it.', 'c', 'hp', 'M', 3, { genres: ['afrobeats'] }],
  ['Legwork Flick', 'flicks the feet quickly in a criss-cross legwork pattern, upper body cool', 'Street legwork energy; the face stays unbothered.', 'cd', 'pc', 'F', 4, { genres: ['afrobeats'], x: 3 }],
  ['Groove Step-Touch', 'step-touches side to side with an easy body roll, arms loose', 'The foundation groove anyone can do and it still looks good.', 'cv', 'hp', 'M', 2, { genres: ['afrobeats', 'amapiano', 'pop'], x: 1 }],
  ['Waist Whine', 'rolls the waist in slow circles with knees bent, hands on the thighs', 'Dancehall and Afro whine; confident, tasteful, never vulgar.', 'cn', 'xp', 'M', 3, { genres: ['dancehall', 'afrobeats'] }],
  ['Kneel-and-Bounce Groove', 'drops low into a deep bounce, palms up, and rises slowly with the build', 'Hype moment on a build or drop.', 'dk', 'hp', 'F', 4, { genres: ['afrobeats', 'amapiano'] }],
  ['Highlife Sway', 'sways from the hips with small steps, a handkerchief waving in one hand', 'Classic West African celebration; warm and stately.', 'cv', 'hn', 'M', 2, { genres: ['highlife'], props: ['handkerchief'] }],
  ['Afro-Fusion Arm Waves', 'rolls the arms in slow waves from the shoulders while the feet keep a simple step', 'Melodic Afro-fusion; fluid and easy.', 'c', 'rx', 'M', 3, { genres: ['afrobeats'] }],
  ['Celebration Hop', 'hops lightly from foot to foot with the arms up, laughing with the dancers', 'Party and wedding songs.', 'cd', 'h', 'F', 4, { genres: ['afrobeats', 'highlife'] }],
  // Urban / hip-hop
  ['Two-Step Bop', 'two-steps on the beat with a slight bounce and loose shoulders', 'The universal hip-hop groove; looks cool because it looks easy.', 'cv', 'cp', 'M', 2, { genres: ['hiphop', 'rnb'], x: 1 }],
  ['Rock Groove', 'rocks the torso forward and back on the beat with small foot steps', 'Old-school hip-hop feel.', 'v', 'cp', 'M', 2, { genres: ['hiphop'] }],
  ['Body Wave Drop', 'rolls a smooth body wave from the head to the hips and drops into a crouch on the beat', 'A slick accent for the end of a phrase.', 'c', 'xc', 'M', 3, { genres: ['hiphop', 'rnb', 'pop'] }],
  ['Arm Wave Isolation', 'sends a clean wave through both arms while the body stays still', 'Popping showcase in an instrumental break.', 'n', 'cp', 'M', 3, { genres: ['hiphop', 'pop'], x: 3 }],
  ['Freestyle Circle Moment', 'jumps into the centre of a dance circle and freestyles a few bars as the crew cheers', 'Raw street energy; everyone around reacts.', 'nd', 'hp', 'F', 4, { props: ['crew'], genres: ['hiphop', 'afrobeats'] }],
  ['Krump Chest Pop', 'pops the chest and arms with sharp, aggressive accents on the hits', 'Raw power and catharsis; controlled force.', 'd', 'd', 'F', 5, { genres: ['hiphop'], x: 3 }],
  ['Bounce and Point', 'bounces on the beat and points around the room on each bar', 'Crowd-hype choreography.', 'c', 'hp', 'F', 3, { genres: ['hiphop', 'afrobeats'] }],
  ['Smooth R&B Groove', 'grooves with small, controlled steps and slow shoulder rolls, eyes half closed', 'R&B choreography: less is more.', 'vc', 'xr', 'S', 2, { genres: ['rnb'] }],
  // Pop / commercial
  ['Hair-Whip Chorus', 'whips the hair in a full circle on the downbeat of the chorus, then snaps to a pose', 'Pop showstopper; rehearse so the snap lands on time.', 'c', 'cp', 'F', 4, { g: 'F', genres: ['pop'] }],
  ['Formation Hit', 'hits a sharp unison pose with the dancers on the chorus accent', 'Big-pop choreography: tight, sharp, together.', 'c', 'ct', 'F', 4, { props: ['dancers'], genres: ['pop'], x: 3 }],
  ['Pop Choreo Point and Sweep', 'points across the body, sweeps the arm overhead and finishes with a hip pop', 'Classic pop chorus phrase.', 'c', 'pc', 'F', 3, { genres: ['pop'] }],
  ['Chair Choreography', 'performs a seated routine on a chair: leg extensions, a slow turn, a lean back', 'Sensual-but-classy pop and R&B; precise and controlled.', 'vc', 'xc', 'M', 3, { props: ['chair'], x: 3 }],
  ['Floor Roll Rise', 'rolls across the floor and rises in one fluid motion onto the beat', 'Contemporary-pop drama for bridges.', 'b', 'xs', 'S', 4, { x: 3 }],
  ['Jazz Hands Freeze', 'flashes a quick jazz-hands freeze with a wink, then carries on', 'Theatrical, self-aware fun.', 'a', 'p', 'F', 2, { genres: ['pop'] }],
  ['Disco Point', 'points diagonally up and down across the body in a disco step', 'Retro and nostalgia songs.', 'c', 'hn', 'M', 2, { genres: ['disco', 'pop'] }],
  ['Running Man', 'performs a light running-man step in place with a big smile', 'Throwback fun.', 'c', 'pn', 'F', 3, { genres: ['pop', 'hiphop'] }],
  // Contemporary / expressive
  ['Contemporary Reach and Fall', 'reaches upward with the whole body and lets it fall forward into a soft catch', 'Emotional storytelling dance for ballads.', 'b', 'sg', 'S', 3, { genres: ['contemporary'], x: 3 }],
  ['Slow Spiral Turn', 'turns slowly on one foot, arms spiralling around the body, eyes closed', 'Dreamy, introspective moments.', 'bn', 'rmy', 'S', 3, { genres: ['contemporary'] }],
  ['Rain Dance Release', 'dances freely in the rain, spinning and stamping, soaked and smiling', 'Catharsis and freedom.', 'cd', 'hd', 'M', 4, { tags: ['rain'] }],
  ['Mirror Dance', 'dances facing a partner, mirroring each move a heartbeat late', 'Connection and chemistry.', 'v', 'rp', 'S', 3, { tags: ['two-person'] }],
  ['Lyrical Arm Story', 'uses slow, deliberate arm movements to act out the lyric', 'Lyrical dance for storytelling ballads.', 'vb', 'sr', 'S', 3, { genres: ['contemporary'] }],
  // Latin / ballroom / classic
  ['Salsa Turn', 'takes a quick salsa turn under a partner\'s arm and lands facing the camera', 'Latin-flavoured love songs.', 'c', 'rph', 'F', 3, { genres: ['latin'], tags: ['two-person'] }],
  ['Slow Dance Sway', 'slow dances close with a partner, foreheads touching', 'Love songs and wedding moments.', 'vco', 'rn', 'S', 1, { tags: ['two-person'], x: 1 }],
  ['Tango Dip', 'dips the partner low in a sharp tango dip and holds', 'Passion at the peak of a duet.', 'cb', 'rx', 'M', 4, { tags: ['two-person'], x: 3 }],
  ['Swing Kick Step', 'kicks out a swing step with a little bounce and a grin', 'Retro swing and jazz-pop.', 'c', 'pn', 'F', 3, { genres: ['jazz', 'swing'] }],
  ['Soul Train Strut', 'struts down a line of clapping dancers with a showy step', 'Retro soul and funk.', 'c', 'hpn', 'M', 3, { props: ['dancers'], genres: ['soul', 'funk'] }],
  ['Moonwalk Glide', 'glides backward in a smooth moonwalk, upper body loose', 'Iconic and timeless; use once, sparingly.', 'n', 'cp', 'M', 3, { x: 3 }],
  ['Robot Lock (Human)', 'locks into a few robot accents with human breath and a smile between them', 'Popping with personality, never mechanical all the way through.', 'n', 'p', 'M', 3, { x: 3 }],
  // Dancehall / Caribbean
  ['Dancehall Bounce', 'bounces with bent knees and loose arms, accenting every second beat', 'Dancehall groove; relaxed power.', 'c', 'hp', 'F', 3, { genres: ['dancehall'] }],
  ['Shoulder Rotation Groove', 'rotates the shoulders in big slow circles with the hips following', 'Caribbean and Afro grooves.', 'c', 'xp', 'M', 3, { genres: ['dancehall', 'afrobeats'] }],
  // Gospel / worship
  ['Praise Shuffle', 'shuffles side to side clapping on the backbeat, face lifted', 'Gospel celebration.', 'c', 'gh', 'F', 3, { genres: ['gospel'] }],
  ['Worship Sway', 'sways gently with both hands lifted, eyes closed', 'Quiet worship.', 'cbo', 'g', 'S', 1, { genres: ['gospel'], x: 1 }],
  // EDM / festival
  ['Festival Jump', 'jumps on the drop with both hands up, landing in the bounce', 'Drop energy for EDM and Afro-house.', 'd', 'th', 'F', 5, { genres: ['edm', 'afrohouse'], x: 1 }],
  ['Shuffle Step', 'shuffles the feet fast in a running-heel-toe pattern', 'Festival and house tracks.', 'd', 'hp', 'F', 4, { genres: ['edm', 'house'], x: 3 }],
  ['Arms Wave Over the Crowd', 'waves both arms side to side over the head with the crowd', 'Anthemic choruses.', 'c', 'th', 'M', 3, { props: ['crowd'], x: 1 }],
  // Crew / group choreography
  ['Crew Unison Bop', 'moves in tight unison with a crew in a simple, punchy bop', 'Crew videos and posse cuts.', 'c', 'cp', 'M', 3, { props: ['crew'] }],
  ['Wave Through the Line', 'starts a movement wave that ripples through a line of dancers', 'Visual flourish for chorus intros.', 'c', 'pc', 'M', 3, { props: ['dancers'], x: 3 }],
  ['V-Formation Lead', 'leads a V-formation of dancers, a half-step ahead on every hit', 'Pop and Afro dance videos.', 'c', 'ct', 'F', 4, { props: ['dancers'], x: 3 }],
  ['Cypher Spotlight', 'steps into the middle of a cypher and dances while the circle hypes', 'Hip-hop and Afro dance culture.', 'nd', 'cp', 'F', 4, { props: ['crew'] }],
  ['Final Pose Freeze', 'freezes in a final dramatic pose with the dancers on the last beat', 'The full stop of a routine.', 'o', 'ct', 'A', 3, { props: ['dancers'] }],
]);

export const footwork = block('FOOTWORK', 'FTW', 'TRACKING', 2, [
  ['Heel-Toe Slide', 'slides sideways on a heel-toe pivot, smooth as ice', 'Smooth R&B and soul.', 'vc', 'cx', 'M', 3, { genres: ['rnb', 'soul'] }],
  ['Quick Pivot Turn', 'pivots 180 degrees on the ball of the foot on the beat and freezes', 'Sharp transitions between phrases.', 'c', 'c', 'F', 3],
  ['Toe Stand Rise', 'rises onto the toes on the held note and holds the balance', 'Lifts a held note visually.', 'cb', 'gt', 'S', 3],
  ['Cross-Step Glide', 'crosses one foot over the other in a gliding step across the stage', 'Showman travel across the stage.', 'v', 'cp', 'M', 3],
  ['Stomp Accent', 'stomps one foot hard on the accent, dust or water splashing', 'Power accents in defiant songs.', 'cd', 'd', 'F', 4],
  ['Spin and Stop', 'spins twice and stops dead facing the camera', 'Turns that land exactly on the beat.', 'c', 'cp', 'F', 4, { x: 3 }],
  ['Shuffle Ball Change', 'drops a quick shuffle-ball-change between lines', 'Tap-flavoured detail for retro and jazz-pop.', 'v', 'pn', 'M', 2, { genres: ['jazz', 'pop'] }],
  ['Knee Slide', 'runs and slides on the knees across the stage floor into the chorus', 'Rock and soul climax; pads under the costume.', 'cd', 'tc', 'F', 5, { x: 3 }],
  ['Splits Drop', 'drops into the splits on the final beat of the bridge', 'Big moment for trained dancers only.', 'b', 'ct', 'F', 5, { x: 3 }],
  ['Tip-Toe Sneak', 'tip-toes in exaggerated sneaking steps with a cheeky grin', 'Playful and mischievous verses.', 'v', 'p', 'M', 2],
  ['Lazy Shuffle', 'shuffles the feet lazily in place, hands in the pockets', 'Laid-back cool for rap and R&B.', 'v', 'cm', 'S', 1, { genres: ['hiphop', 'rnb', 'afrobeats'] }],
  ['Afro Foot Stamp Pattern', 'stamps a rhythmic Afro pattern, right-left-right, with the drums', 'Locks the body to the percussion.', 'c', 'hc', 'F', 3, { genres: ['afrobeats', 'highlife'] }],
  ['Backward Slide Exit Step', 'slides backward out of the light with small gliding steps', 'Smooth exits.', 'o', 'yc', 'M', 2],
  ['Hop-Turn', 'hops into a half turn and lands soft, facing away', 'Playful phrase endings.', 'c', 'p', 'F', 3],
  ['Grapevine Travel', 'grapevines across the stage, arms loose', 'Old-school choreography to travel.', 'c', 'hn', 'M', 2],
  ['Slide Into Frame', 'slides into the frame from the side on one foot and lands in a pose', 'Entrances into an already-rolling shot.', 'ic', 'pc', 'F', 3],
  ['Weight-Shift Sway', 'shifts the weight from foot to foot in time, barely moving', 'The minimum movement that still looks alive.', 'v', 'mr', 'S', 1, { x: 1 }],
  ['Tap Flurry', 'taps a quick flurry with the toes on the drum fill', 'Showcases rhythm on fills.', 'n', 'pc', 'F', 3, { x: 3 }],
]);
