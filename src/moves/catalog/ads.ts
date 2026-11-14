/**
 * Commercial moves. In ads the sections mean: i = hook (first 2 s), v = story / demo,
 * c = payoff / proof, o = close / call to action. Append only.
 */
import { block } from './dsl.js';

export const presenter = block('PRESENTER', 'PRS', 'MEDIUM', 1, [
  ['Lean-In Secret', 'leans toward the camera as if sharing a secret, lowering the voice on the key benefit', 'Pulls the viewer close in the first seconds.', 'iv', 'cp', 'A', 2, { sig: true }],
  ['Walk-and-Talk', 'walks toward the camera while talking naturally, gesturing with one hand', 'Energy and authenticity; keep the pace relaxed.', 'v', 'ch', 'M', 2, { shot: 'TRACKING' }],
  ['Pattern-Interrupt Stop', 'stops mid-step, turns to the camera and says the hook line straight', 'Stops the scroll in the first second.', 'i', 'cp', 'F', 3],
  ['Counting Benefits', 'counts three benefits on the fingers, a short pause on each', 'Clear structure viewers remember.', 'v', 'ch', 'M', 2],
  ['Raised-Eyebrow Question', 'asks the problem question with a raised eyebrow and a knowing half-smile', 'Opens with relatability.', 'i', 'pc', 'A', 1, { shot: 'CLOSE_UP' }],
  ['Calm Expert Explain', 'explains calmly, hands open at chest height, steady eye contact', 'Trust for finance, health and tech.', 'v', 'mc', 'S', 1],
  ['Over-the-Shoulder Glance', 'glances over the shoulder at the product, then back to the camera, smiling', 'Directs attention without pointing.', 'v', 'p', 'A', 1],
  ['Kitchen-Counter Chat', 'leans on a kitchen counter chatting to the camera like a friend', 'Warm, home-life brands.', 'v', 'hm', 'S', 1, { props: ['kitchen'] }],
  ['Energetic Hype Open', 'jumps into frame with high energy, arms open, voice bright', 'Youth, entertainment and launches.', 'i', 'hp', 'F', 4],
  ['Desk-Edge Sit', 'sits on the edge of a desk, relaxed, one foot on the floor', 'Business and B2B with a human touch.', 'v', 'cm', 'S', 1, { props: ['desk'] }],
  ['Point to On-Screen Text', 'points to empty space where on-screen text will appear, then back to the lens', 'Ties the presenter to graphics.', 'vc', 'c', 'A', 1],
  ['Thumbs-Up Close', 'ends the line with a relaxed thumbs-up and a nod', 'Simple, friendly sign-off.', 'o', 'h', 'A', 1],
]);

export const product = block('PRODUCT', 'PRD', 'CLOSE_UP', 1, [
  ['Hero Reveal Lift', 'lifts the product slowly into the light at chest height, label facing the camera', 'The packshot moment: steady hands, label square to the lens.', 'ic', 'ct', 'S', 2, { sig: true }],
  ['Unboxing Open', 'opens the box slowly, peeks inside, and smiles before lifting the product out', 'Anticipation and delight.', 'iv', 'hp', 'S', 2],
  ['Slide Across the Table', 'slides the product across the table toward the camera, letting it stop by itself', 'A clean hand-off to the viewer.', 'co', 'cp', 'M', 1],
  ['Twist-Open Demo', 'twists the cap open with a satisfying motion, close to the lens', 'Tactile demos: drinks, cosmetics, food.', 'v', 'h', 'A', 1],
  ['First Sip', 'takes a slow first sip, closes the eyes, and exhales with a smile', 'Food and drink payoff; real enjoyment.', 'c', 'hm', 'S', 2, { sig: true }],
  ['First Bite', 'takes a bite, pauses, and raises the eyebrows in genuine surprise', 'Food payoff; the pause matters.', 'c', 'hp', 'A', 2],
  ['Apply and Feel', 'applies the product to the skin and runs fingertips over it, eyes closed', 'Beauty and skincare demos.', 'v', 'xm', 'S', 1],
  ['Tap on Screen', 'taps through the app on the phone with an easy thumb, then turns the screen to camera', 'App demos; the turn to camera is the reveal.', 'v', 'cp', 'M', 1, { props: ['phone'] }],
  ['Hold Next to Face', 'holds the product beside the face, both in focus, and smiles', 'Pairs the brand with a person.', 'c', 'hc', 'A', 1],
  ['Pour Shot', 'pours the product into a glass slowly, the liquid catching the light', 'Beverage hero shot.', 'c', 'h', 'S', 1],
  ['Before-and-After Swipe', 'swipes a hand across the frame to switch from before to after', 'Transformation products.', 'c', 'th', 'F', 2],
  ['Spray Mist Moment', 'sprays a fine mist into the air and steps into it', 'Fragrance and freshness.', 'c', 'xr', 'S', 2],
  ['Keys Toss', 'tosses car keys up and catches them, then walks to the car', 'Automotive and freedom.', 'o', 'cp', 'M', 2, { props: ['keys'] }],
  ['Feel the Fabric', 'runs the hand along the fabric and smiles at the softness', 'Fashion and home textiles.', 'v', 'mx', 'S', 1],
]);

export const reactions = block('REACTION', 'RCT', 'CLOSE_UP', 1, [
  ['Genuine Surprise', 'eyes widen and a laugh escapes on seeing the result', 'The moment people believe the product works.', 'c', 'hp', 'A', 2, { sig: true }],
  ['Slow Nod Approval', 'nods slowly, lips pressed, impressed', 'Understated credibility.', 'c', 'c', 'S', 1],
  ['Friend Reaction Shot', 'turns to a friend with an open-mouthed "see?" look', 'Social proof in a moment.', 'c', 'hp', 'A', 1, { tags: ['two-person'] }],
  ['Relief Exhale', 'exhales with relief, shoulders dropping, as the problem disappears', 'Pain-point products.', 'c', 'm', 'S', 1],
  ['Happy Dance Burst', 'breaks into a short happy dance after the payoff', 'Fun brands and promotions.', 'c', 'hp', 'F', 3],
  ['Mouth-Full Thumbs Up', 'gives a thumbs up with a mouth full, unable to speak', 'Food brands; honest and funny.', 'c', 'hp', 'A', 1],
  ['Squeal and Hug', 'squeals and hugs the gift close to the chest', 'Gifting and festive campaigns.', 'c', 'h', 'A', 2],
  ['Skeptic Turned Fan', 'starts with folded arms and a doubtful look, then cracks into a smile', 'The conversion arc in one shot.', 'vc', 'pc', 'A', 2],
  ['Proud Look to Camera', 'looks proudly at the result, then at the camera', 'Achievement and DIY.', 'c', 'tc', 'A', 1],
  ['Kid-Like Wonder', 'stares at the product with wide-eyed wonder, a slow smile spreading', 'Tech reveals and launches.', 'c', 'h', 'S', 1],
]);

export const testimonials = block('TESTIMONIAL', 'TST', 'MEDIUM', 1, [
  ['Seated Honest Story', 'sits facing slightly off-camera and tells their story in their own words', 'Documentary interview style; real pauses.', 'v', 'mc', 'S', 1, { sig: true }],
  ['Look-Away Remember', 'looks away to remember a detail, then back to the interviewer', 'Real memory beats; never scripted perfection.', 'v', 'n', 'S', 1],
  ['Customer at Work', 'talks while working at their job, glancing up between sentences', 'Small business and B2B.', 'v', 'c', 'M', 1],
  ['Family Together Testimonial', 'speaks with the family around, a child leaning in', 'Family brands, insurance, food.', 'v', 'hr', 'S', 1, { props: ['family'] }],
  ['Emotional Pause', 'stops for a breath, smiles through emotion, and continues', 'Healthcare, charity and life-changing products.', 'c', 'sg', 'S', 2],
  ['Proud Owner Gesture', 'gestures to the shop or home behind them with pride', 'Business success stories.', 'c', 'tc', 'A', 1],
  ['Before-Life Recall', 'describes life before with a small grimace, then lightens up', 'Problem-solution arc.', 'v', 'nh', 'S', 1],
  ['Direct Recommendation', 'looks straight into the lens and recommends it to the viewer', 'The closing line of a testimonial.', 'o', 'c', 'S', 1, { shot: 'CLOSE_UP' }],
]);

export const lifestyle = block('LIFESTYLE', 'LFS', 'WIDE', 1, [
  ['Morning Routine', 'moves through a morning routine with the product naturally in hand', 'Products living in a real day.', 'v', 'hm', 'M', 1],
  ['City Commute', 'walks through a busy city with the product, earbuds in, smiling', 'Urban, mobile, young.', 'v', 'c', 'M', 2, { shot: 'TRACKING' }],
  ['Weekend With Friends', 'laughs with friends at an outdoor table, the product shared around', 'Sociable brands.', 'v', 'h', 'M', 1, { props: ['crew'] }],
  ['Workout Moment', 'trains hard, stops, drinks, and gets back to it', 'Fitness and sports nutrition.', 'v', 'tc', 'F', 3],
  ['Evening Wind-Down', 'curls up on a sofa with the product as the lights dim', 'Comfort and home.', 'o', 'm', 'S', 1],
  ['Road Trip', 'drives with the window down, arm out, the product on the seat', 'Freedom, travel, auto.', 'v', 'hn', 'M', 2, { props: ['car'] }],
  ['Market Day', 'shops at a busy open market, choosing produce, chatting with the seller', 'Local, food and fintech brands.', 'v', 'hn', 'M', 1],
  ['Celebration Moment', 'raises the product with friends at a party as the music hits', 'Festive campaigns.', 'c', 'ht', 'F', 3, { props: ['crew'] }],
  ['Work-From-Home Win', 'finishes a task at a laptop and leans back satisfied', 'Productivity and tech.', 'c', 'c', 'S', 1, { props: ['laptop'] }],
  ['Family Kitchen', 'cooks with the family, passing ingredients, laughing', 'Food and household brands.', 'v', 'hr', 'M', 1, { props: ['family', 'kitchen'] }],
]);

export const callsToAction = block('CALL_TO_ACTION', 'CTA', 'MEDIUM', 1, [
  ['Point to the Offer', 'points down to where the offer and link appear, eyes on the lens', 'Directs attention to the CTA graphic.', 'o', 'c', 'A', 1, { sig: true }],
  ['Phone Up "Order Now"', 'holds the phone up to the camera with the order screen showing', 'App and e-commerce CTAs.', 'o', 'cp', 'A', 1, { props: ['phone'] }],
  ['Come-With-Me Wave', 'waves the viewer to follow and walks off-frame', 'Store visits and events.', 'o', 'hp', 'M', 2],
  ['Product to Lens Close', 'pushes the product toward the lens until it fills the frame', 'A packshot ending that hands it to the viewer.', 'o', 'c', 'A', 1],
  ['Countdown Fingers', 'counts down three, two, one with the fingers for a limited offer', 'Urgency for sales and launches.', 'o', 'pc', 'F', 2],
  ['Logo Reveal Step-Aside', 'steps aside to reveal the logo or shopfront behind them', 'Brand-ending in one move.', 'o', 'c', 'A', 1],
  ['Smile and Nod Sign-Off', 'smiles, nods once, and says the brand name', 'Calm, trustworthy closes.', 'o', 'cm', 'S', 1, { shot: 'CLOSE_UP' }],
  ['Group "Join Us"', 'the whole cast turns to the camera and opens their arms', 'Community and membership offers.', 'o', 'ht', 'M', 2, { props: ['crew'] }],
]);
