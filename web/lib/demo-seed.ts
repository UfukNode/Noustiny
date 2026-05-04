import type { StoryNode } from './types'
import { imageUrl, seedFromString } from './image'

/**
 * Hand-authored Endgame seed so the UI has something real the moment the app
 * opens. The tree matches the shape the Hermes brainstorm agent produces so we
 * can test the visuals before wiring up the model.
 */

type Seed = Omit<StoryNode, 'x' | 'y' | 'imageUrl' | 'decidedBy' | 'staleState'> & {
  imagePrompt: string
}

const blueprint: Seed[] = [
  {
    id: 'root',
    parentId: null,
    childrenIds: ['snap', 'hesitate', 'pass'],
    depth: 0,
    title: 'THE GAUNTLET',
    summary: 'All six stones. Thanos is seconds away. Every universe holds its breath.',
    body:
      'Tony has the Infinity Stones. The portal armies clash across the Avengers compound. Morgan is safe, but the line is here — one snap, one sentence, one future locked in forever.',
    imagePrompt:
      'Iron Man in damaged gold and red armor clutching the Infinity Gauntlet, cracked with energy, rubble battlefield, Marvel Endgame, dramatic golden light',
    mood: 'climax',
    tone: 'canon',
    worldPercent: 100,
    status: 'current',
  },
  {
    id: 'snap',
    parentId: 'root',
    childrenIds: ['pepper', 'happy'],
    depth: 1,
    title: 'SNAP. SAY THE WORDS.',
    summary: '"I… am… Iron Man." The universe answers.',
    body:
      'He lifts the gauntlet. Energy screams up his arm, through his chest, into his eyes. The words arrive like an old friend.',
    imagePrompt:
      'Iron Man about to snap fingers, Infinity Gauntlet glowing white hot, tears in his eyes, surrounded by energy, cinematic Marvel still',
    mood: 'climax',
    tone: 'canon',
    worldPercent: 72,
    status: 'unvisited',
  },
  {
    id: 'hesitate',
    parentId: 'root',
    childrenIds: ['morgan', 'thor'],
    depth: 1,
    title: 'HESITATE. LOOK AT MORGAN.',
    summary: "She's only five. Maybe this isn't his war to finish.",
    body:
      "He sees her — somewhere beyond the battlefield, holding a juice pop, waiting. The gauntlet feels heavier than a planet.",
    imagePrompt:
      'Tony Stark looking away from Infinity Gauntlet toward a vision of his young daughter, conflicted expression, battlefield blurred in background, emotional Marvel still',
    mood: 'tense',
    tone: 'divergent',
    worldPercent: 18,
    status: 'unvisited',
  },
  {
    id: 'pass',
    parentId: 'root',
    childrenIds: ['peter', 'strange'],
    depth: 1,
    title: 'PASS THE GAUNTLET TO PETER.',
    summary: 'The kid is fast. The kid can do this.',
    body:
      '"Hey — Kid." Peter catches his eye mid-flight. Tony holds the gauntlet out like a relay baton to a future he trusts more than his own.',
    imagePrompt:
      'Iron Man offering Infinity Gauntlet to Spider-Man mid-battle, chaotic background of armies, shafts of light, Marvel comic cinematic',
    mood: 'tense',
    tone: 'what-if',
    worldPercent: 10,
    status: 'unvisited',
  },
  {
    id: 'pepper',
    parentId: 'snap',
    childrenIds: [],
    depth: 2,
    title: 'PEPPER KNEELS BESIDE HIM.',
    summary: '"We\'re going to be okay. You can rest now."',
    body:
      'The armor is scorched black. Pepper\'s hand on his face. Friday\'s voice thin and far away. The battlefield has gone quiet the way only the end can be quiet.',
    imagePrompt:
      'Pepper Potts in Rescue armor kneeling beside fallen Tony Stark, helmet off, sunset light, ruins, Marvel Endgame finale',
    mood: 'quiet',
    tone: 'canon',
    worldPercent: 97,
    status: 'unvisited',
  },
  {
    id: 'happy',
    parentId: 'snap',
    childrenIds: [],
    depth: 2,
    title: 'HAPPY REACHES THE HOUSE.',
    summary: 'Morgan looks up. Knows, before anyone says it.',
    body:
      'The porch swing is still moving. Happy can\'t get the first word out. Morgan hands him half a juice pop without looking away from the yard.',
    imagePrompt:
      'Morgan Stark as a small child on a wooden porch, Happy Hogan kneeling, lake cabin, late afternoon, quiet grief, Marvel cinematic',
    mood: 'quiet',
    tone: 'canon',
    worldPercent: 45,
    status: 'unvisited',
  },
  {
    id: 'morgan',
    parentId: 'hesitate',
    childrenIds: [],
    depth: 2,
    title: 'HE DROPS THE GAUNTLET.',
    summary: "Let someone else's story end the war.",
    body:
      'A choice made by a father, not an Avenger. Thor catches the gauntlet before it hits the dirt. The battlefield tilts toward another fate.',
    imagePrompt:
      'Infinity Gauntlet falling from Iron Man hand mid-battle, Thor reaching in slow motion, sparks and debris, Marvel cinematic alternate timeline',
    mood: 'discovery',
    tone: 'divergent',
    worldPercent: 12,
    status: 'unvisited',
  },
  {
    id: 'thor',
    parentId: 'hesitate',
    childrenIds: [],
    depth: 2,
    title: 'THOR TAKES IT, BURNS WITH IT.',
    summary: 'Lightning meets the stones. Asgard pays the price.',
    body:
      'Mjolnir hums. Stormbreaker roars. Thor snaps, screaming, and the sky does not forgive him for it.',
    imagePrompt:
      'Thor wielding Infinity Gauntlet, lightning arcing across entire body, stormy sky tearing open, Marvel alternate cosmic cinematic',
    mood: 'danger',
    tone: 'what-if',
    worldPercent: 6,
    status: 'unvisited',
  },
  {
    id: 'peter',
    parentId: 'pass',
    childrenIds: [],
    depth: 2,
    title: 'PETER SNAPS, TOO YOUNG.',
    summary: 'The webs never let him go.',
    body:
      'He is seventeen. The universe is hot lead poured into his veins. He saves everyone, and keeps on aging backwards until there is nothing left to save.',
    imagePrompt:
      'Spider-Man in torn suit wielding Infinity Gauntlet, cosmic energy devouring him, tragic Marvel alternate future',
    mood: 'danger',
    tone: 'what-if',
    worldPercent: 3,
    status: 'unvisited',
  },
  {
    id: 'strange',
    parentId: 'pass',
    childrenIds: [],
    depth: 2,
    title: 'STRANGE INTERVENES.',
    summary: 'One finger raised. The only path he ever saw.',
    body:
      '"This was the one." He takes the gauntlet himself. Time bends. The multiverse holds its breath differently.',
    imagePrompt:
      'Doctor Strange taking Infinity Gauntlet from Iron Man, glowing sling ring, time distortion waves, Marvel alternate cinematic',
    mood: 'discovery',
    tone: 'what-if',
    worldPercent: 14,
    status: 'unvisited',
  },
]

export function buildDemoTree(): Map<string, StoryNode> {
  const map = new Map<string, StoryNode>()
  for (const b of blueprint) {
    map.set(b.id, {
      ...b,
      imageUrl: imageUrl({
        prompt: b.imagePrompt,
        seed: seedFromString(b.id + b.title),
      }),
      decidedBy: b.status === 'current' ? 'human' : 'agent',
      decidedByAgent: undefined,
      staleState: 'fresh',
      x: 0,
      y: 0,
    })
  }
  return map
}

/** Single-root tree from an arbitrary seed.  The canvas opens with this,
 *  then page.tsx's auto-expand effect calls the brainstorm agent so the
 *  child beats come from Hermes — not a hardcoded blueprint.  The old
 *  buildDemoTree is kept for reference / regression but no longer used
 *  by the live session flow. */
export function buildRootTree(seed: string): Map<string, StoryNode> {
  const trimmed = (seed ?? '').trim() || DEMO_SEED
  // Title: first sentence (sentence case, not uppercase — the ribbon
  // now renders multi-line and readable).  Hard cap at 100 chars with
  // word-boundary ellipsis so a 250-char sentence doesn't push the
  // ribbon out of the card.  The FULL seed still travels to the model
  // via node.body / seed param — this is display-only.
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0]?.trim() ?? trimmed
  const title = firstSentence.length <= 100
    ? (firstSentence || 'Opening beat')
    : firstSentence.slice(0, 100).replace(/\s+\S*$/, '') + '…'
  const imagePrompt = trimmed.slice(0, 300)

  const map = new Map<string, StoryNode>()
  map.set('root', {
    id: 'root',
    parentId: null,
    childrenIds: [],
    depth: 0,
    title,
    summary: trimmed.slice(0, 180),
    body: trimmed,
    imagePrompt,
    imageUrl: imageUrl({
      prompt: imagePrompt,
      seed: seedFromString('root' + title),
    }),
    mood: 'neutral',
    tone: 'canon',
    worldPercent: 100,
    status: 'current',
    decidedBy: 'human',
    decidedByAgent: undefined,
    staleState: 'fresh',
    x: 0,
    y: 0,
  })
  return map
}

export const DEMO_SEED =
  'Tony Stark stands on the Avengers compound battlefield, the Infinity Gauntlet in his hand — every possible ending hinges on what he chooses to do next.'
