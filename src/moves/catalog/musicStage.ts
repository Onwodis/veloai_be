/** Props, duets, groups, stunts and exits. Append only (ids follow the order). */
import { block } from './dsl.js';

export const props = block('PROP', 'PRP', 'MEDIUM', 1, [
  ['Shades Slow Lower', 'lowers the sunglasses slowly with one finger to look over them at the camera', 'A look that lands like a line.', 'vc', 'cpy', 'A', 2, { props: ['sunglasses'], sig: true }],
  ['Jacket Shoulder Drop', 'lets the jacket slide off one shoulder on the beat and leaves it hanging', 'Effortless cool and confidence.', 'c', 'xc', 'M', 2, { props: ['jacket'] }],
  ['Jacket Over the Shoulder', 'hooks the jacket on one finger and throws it over the shoulder while walking', 'Classic swagger.', 'v', 'cn', 'M', 2, { props: ['jacket'] }],
  ['Hat Tip', 'tips the brim of the hat with two fingers and smiles', 'Old-school charm.', 'ao', 'pc', 'A', 1, { props: ['hat'] }],
  ['Hat Over the Eyes', 'tilts the hat down over the eyes, then lifts it to reveal the stare', 'Mystery then reveal.', 'i', 'yc', 'A', 2, { props: ['hat'] }],
  ['Chair Turn-Around Sit', 'spins a chair around and sits on it backwards, arms folded on the backrest', 'Casual authority for verses.', 'v', 'cp', 'M', 2, { props: ['chair'] }],
  ['Scarf Flow', 'lets a long silk scarf trail and flow from the hand while turning', 'Grace and drama for ballads.', 'cb', 'rx', 'S', 2, { props: ['scarf'], g: 'F' }],
  ['Cane Spin', 'spins a walking cane once and plants it on the beat', 'Vintage showman flair.', 'c', 'pc', 'M', 3, { props: ['cane'] }],
  ['Champagne Toast', 'raises a glass toward the camera on the celebration line', 'Celebration songs; tasteful, never sloppy.', 'c', 'ht', 'M', 2, { props: ['glass'] }],
  ['Letter Read', 'reads a handwritten letter while singing, then folds it to the chest', 'Love and loss storytelling.', 'vb', 'rsn', 'S', 1, { props: ['letter'] }],
  ['Phone Glance Ignore', 'glances at a ringing phone, turns it face down and keeps singing', 'Moving-on songs.', 'v', 'dc', 'A', 1, { props: ['phone'] }],
  ['Rose Petal Release', 'opens the hand to let rose petals fall during the held note', 'Romantic climaxes.', 'cb', 'rs', 'S', 2, { props: ['rose petals'] }],
  ['Guitar Neck Raise', 'raises the guitar neck high on the final chord', 'Band and rock moments.', 'co', 'tc', 'A', 3, { props: ['guitar'] }],
  ['Piano Lean Sing', 'sits at the piano, sings over the shoulder to camera while playing', 'Singer-songwriter and soul.', 'vb', 'rn', 'S', 1, { props: ['piano'] }],
  ['Chain Adjust', 'adjusts a chain on the neck with one hand without looking down', 'Small swagger detail for rap and Afro leads.', 'v', 'c', 'A', 1, { props: ['chain'], genres: ['hiphop', 'afrobeats'] }],
  ['Fan Flick', 'snaps open a hand fan and flutters it slowly beside the face', 'Elegant, playful glamour.', 'vc', 'px', 'S', 1, { props: ['hand fan'], g: 'F' }],
]);

export const duets = block('DUET', 'DUO', 'MEDIUM', 1, [
  ['Forehead Touch', 'rests the forehead against the partner\'s while singing the line softly', 'The most intimate duet moment.', 'cb', 'r', 'S', 1, { tags: ['two-person'], sig: true }],
  ['Back-and-Forth Lines', 'trades lines with the partner face to face, each one stepping closer', 'Call and response with rising tension.', 'v', 'rpd', 'M', 2, { tags: ['two-person'] }],
  ['Walking Away Reach', 'walks away while the partner reaches after them, the hands just missing', 'Heartbreak duets.', 'b', 's', 'S', 2, { tags: ['two-person'] }],
  ['Slow Circle Each Other', 'circles slowly around the partner, eyes locked, singing in turns', 'Tension and attraction.', 'v', 'xry', 'S', 2, { tags: ['two-person'] }],
  ['Hand Hold Pull', 'pulls the partner by the hand into the frame and spins them in', 'Joyful love songs.', 'c', 'hr', 'M', 3, { tags: ['two-person'] }],
  ['Shoulder Lean Harmony', 'leans head on the partner\'s shoulder while they harmonise', 'Warm, close harmonies.', 'cv', 'rg', 'S', 1, { tags: ['two-person'] }],
  ['Argument Face-Off', 'squares up nose to nose with the partner, singing angry lines', 'Conflict verses; intense but respectful.', 'v', 'd', 'M', 3, { tags: ['two-person'] }],
  ['Laugh Together Break', 'both break into laughter between lines, foreheads close', 'Chemistry that feels unscripted.', 'a', 'hp', 'A', 1, { tags: ['two-person'] }],
  ['Embrace From Behind', 'wraps arms around the partner from behind, both swaying', 'Romantic choruses.', 'c', 'r', 'S', 1, { tags: ['two-person'] }],
  ['Lift and Twirl', 'lifts the partner briefly off the ground and twirls them', 'Joyous peaks in love songs.', 'cd', 'hr', 'M', 4, { tags: ['two-person'], x: 2 }],
  ['Feature Verse Handoff', 'steps back as the featured artist steps forward, nodding them in', 'Respectful verse transitions.', 'v', 'c', 'A', 1, { tags: ['two-person'] }],
  ['Mirror Whisper', 'whispers into the partner\'s ear, who smiles and sings the next line', 'Intimacy and secrets.', 'vb', 'xry', 'S', 1, { tags: ['two-person'] }],
  ['Duet Spotlight Split', 'stands in separate spotlights singing to each other across the dark', 'Distance and longing.', 'cb', 'sr', 'S', 2, { tags: ['two-person'] }],
  ['Joint Final Pose', 'ends back to back, heads turned toward each other, on the last note', 'A clean duet ending.', 'o', 'rc', 'A', 2, { tags: ['two-person'] }],
]);

export const groups = block('GROUP', 'GRP', 'WIDE', 1, [
  ['Crew Walk-Up', 'walks toward the camera at the head of a crew, all in step', 'Posse cuts and crew anthems.', 'ic', 'ct', 'M', 3, { props: ['crew'], sig: true }],
  ['Band Huddle', 'huddles with the band before the song kicks in, then breaks to positions', 'Band authenticity.', 'i', 'hc', 'A', 2, { props: ['band'] }],
  ['Choir Lift', 'raises both hands as the choir behind swells into the chorus', 'Gospel and anthem climaxes.', 'cb', 'gt', 'A', 3, { props: ['choir'], genres: ['gospel'] }],
  ['Squad Pose Freeze', 'freezes in a group pose on the last beat, the lead in front', 'Crew-video ending or chorus hit.', 'co', 'ct', 'A', 2, { props: ['crew'] }],
  ['Group Bounce', 'bounces with the whole crew in a tight cluster on the drop', 'Party and hype songs.', 'd', 'h', 'F', 4, { props: ['crew'] }],
  ['Pass-Through Line', 'walks down a line of friends, each one dapping them up on the way', 'Loyalty and community.', 'v', 'hc', 'M', 2, { props: ['crew'] }],
  ['Backup Singers Sway', 'sings in front of backup singers swaying in unison', 'Soul and gospel staging.', 'c', 'gn', 'M', 2, { props: ['backup singers'] }],
  ['Table Gathering', 'sits at a long table with friends, singing as plates and laughter pass', 'Family and celebration songs.', 'v', 'hn', 'M', 1, { props: ['table'] }],
  ['Rooftop Party Toast', 'raises a glass with friends on a rooftop at sunset', 'Celebration and nostalgia.', 'c', 'ht', 'M', 2, { props: ['crew', 'glass'] }],
  ['Dancers Converge', 'stands still as dancers converge from all sides and freeze around them', 'Pop chorus staging.', 'c', 'ct', 'F', 4, { props: ['dancers'], x: 3 }],
]);

export const stunts = block('STUNT', 'STU', 'WIDE', 3, [
  ['Slow-Motion Jump Freeze', 'jumps with knees tucked and is captured hanging at the peak of the jump', 'Shot at high frame rate; safe, low jump made huge by the camera.', 'd', 'tc', 'F', 5, { sig: true }],
  ['Backflip Off the Riser', 'lands a clean backflip off a low riser onto the beat', 'Trained performers only, with mats and spotters.', 'd', 'tc', 'F', 5],
  ['Fall Back Into the Crowd', 'falls back with arms wide into a waiting crowd that catches them', 'Trained crowd and spotters; a short, controlled fall.', 'c', 'gt', 'A', 5, { props: ['crowd'] }],
  ['Wire Float', 'floats up off the stage on a hidden harness, arms open', 'Harness work with a rigging team; a dream-like peak.', 'b', 'gy', 'S', 4],
  ['Car Bonnet Slide', 'slides across the bonnet of a parked car and lands walking', 'Action-movie swagger; stationary car, padded surface.', 'v', 'cp', 'F', 4, { props: ['car'] }],
  ['Pyro Hit Stance', 'stands still in a power stance as pyro bursts behind on the drop', 'Pyro by licensed technicians at a safe distance; the stillness sells it.', 'd', 'td', 'F', 5],
  ['Rain Machine Spin', 'spins with arms out under a burst of artificial rain on the climax', 'Emotional release; non-slip floor.', 'cb', 'ts', 'M', 4, { tags: ['rain'] }],
  ['Motorbike Arrival', 'rolls in on a motorbike, stops, kicks the stand and steps off', 'Professional rider for the motion; the star does the stop and step-off.', 'i', 'dc', 'M', 4, { props: ['motorbike'] }],
  ['Rooftop Lean (Safe)', 'leans back against a rooftop railing with the city lights below', 'Strong safety rail; the lens sells the height.', 'v', 'cny', 'S', 2],
  ['Underwater Moment', 'opens the eyes underwater with hair and clothes floating, then surfaces', 'Pool with safety divers; dreamlike bridges.', 'b', 'gsy', 'S', 4],
  ['Confetti Cannon Drop', 'raises both arms as confetti cannons fire on the final chorus', 'Triumphant finales.', 'd', 'ht', 'F', 5],
  ['Running Leap Across', 'runs and leaps across a short gap between two platforms', 'Short gap with mats; shot to feel like flight.', 'd', 'td', 'F', 5],
]);

export const exits = block('EXIT', 'EXT', 'WIDE', 1, [
  ['Walk Into the Light', 'turns and walks slowly into a bright light until the silhouette disappears', 'A spiritual, final exit.', 'o', 'gsy', 'S', 2, { sig: true }],
  ['Last Look Back', 'walks away, stops, and gives one last look back over the shoulder before leaving', 'Bittersweet endings.', 'o', 'nrs', 'S', 1],
  ['Mic Down and Leave', 'sets the mic down on the stage floor, bows the head, and walks off', 'The respectful mic drop.', 'o', 'ct', 'S', 2, { props: ['handheld mic'] }],
  ['Fade Into the Crowd', 'steps back into the crowd and is swallowed by it', 'Back to the people.', 'o', 'hn', 'A', 2, { props: ['crowd'] }],
  ['Door Close Ending', 'walks through a door and lets it swing shut behind, the light cut off', 'Final full stop for stories.', 'o', 'sy', 'S', 1],
  ['Lights-Out Freeze', 'freezes in the final pose as the lights snap off', 'Clean pop and dance endings.', 'o', 'ct', 'A', 2],
  ['Drive Away', 'gets into a car and drives off into the night, tail lights fading', 'Moving-on endings.', 'o', 'nd', 'M', 2, { props: ['car'] }],
  ['Smile to Black', 'holds a small private smile to the lens as the frame fades to black', 'Warm, intimate endings.', 'o', 'rh', 'S', 1, { shot: 'CLOSE_UP' }],
  ['Exhale and Laugh', 'exhales, laughs at themselves, and looks away as the last note rings', 'Human, unpolished endings.', 'o', 'hp', 'S', 1, { shot: 'CLOSE_UP' }],
  ['Sunset Walk Away', 'walks away into a sunset along an empty road', 'Classic hopeful ending.', 'o', 'nt', 'S', 1],
  ['Bow and Blackout', 'takes a slow bow as the stage goes dark', 'Concert endings.', 'o', 'gt', 'S', 1],
  ['Spin Out of Frame', 'spins out of the frame on the last beat, leaving the empty set', 'Playful endings.', 'o', 'p', 'F', 3],
  ['Head Down Hold', 'drops the head on the last note and holds completely still', 'Dramatic stop for ballads and rock.', 'o', 'sd', 'A', 1],
  ['Hand Over the Lens', 'reaches out and covers the lens with an open hand', 'Bold, cheeky or mysterious ending.', 'o', 'pyc', 'A', 1, { shot: 'CLOSE_UP' }],
]);
