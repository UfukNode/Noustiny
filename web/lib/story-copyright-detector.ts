/**
 * story-copyright-detector — deterministic keyword-match mirror of the
 * Hermes Python tool (tools/story_copyright_detector.py).
 *
 * The LLM skill is the primary classifier, but every image-pipeline
 * request needs a synchronous fallback: if the skill call is slow or
 * the gateway is down, the route still has to pick between FLUX and
 * Gemini *right now*.  This function runs in ~microseconds against a
 * curated franchise registry and returns the same shape as the skill.
 *
 * Hand-synced with the Python counterpart so the behaviour is
 * identical whether the story is routed via Hermes or via the web
 * route's inline path.
 */

export type IpLevel = 'known' | 'inspired' | 'original'
export type ModelPreference = 'flux-photoreal' | 'gemini-stylised'

export interface ImagePolicy {
  ip_level: IpLevel
  franchise: string | null
  model_preference: ModelPreference
  reason: string
}

const FRANCHISES: Record<string, string[]> = {
  marvel: [
    'marvel', 'avengers', 'iron man', 'tony stark', 'stark industries',
    'thor odinson', 'captain america', 'steve rogers', 'bruce banner',
    'hulk', 'black widow', 'natasha romanoff', 'hawkeye', 'clint barton',
    'nick fury', 's.h.i.e.l.d.', 'shield', 'infinity gauntlet', 'infinity stones',
    'mjolnir', 'stormbreaker', 'wakanda', 'vibranium', 'asgard', 'thanos',
    'loki laufeyson', 'scarlet witch', 'wanda maximoff', 'doctor strange',
    'spider-man', 'peter parker', 'pepper potts', 'happy hogan',
    'morgan stark', 'ant-man', 'black panther', 'tchalla', 'guardians of the galaxy',
    'star-lord', 'groot', 'rocket raccoon', 'gamora', 'nebula', 'drax',
  ],
  'star-wars': [
    'star wars', 'jedi', 'sith', 'skywalker', 'darth vader', 'anakin',
    'luke skywalker', 'leia organa', 'han solo', 'chewbacca',
    'lightsaber', 'death star', 'millennium falcon', 'obi-wan',
    'yoda', 'the force', 'kylo ren', 'rey', 'stormtrooper',
    'boba fett', 'mandalorian', 'tatooine', 'coruscant',
  ],
  'harry-potter': [
    'harry potter', 'hogwarts', 'gryffindor', 'slytherin', 'ravenclaw',
    'hufflepuff', 'hermione granger', 'ron weasley', 'dumbledore',
    'voldemort', 'diagon alley', 'quidditch', 'muggle', 'azkaban',
    'hagrid', 'snape',
  ],
  got: [
    'game of thrones', 'westeros', 'winterfell', 'stark family',
    'jon snow', 'daenerys targaryen', 'tyrion lannister', 'cersei',
    'iron throne', 'the wall', 'white walker', 'khaleesi', "king's landing",
    'house stark', 'house lannister', 'house targaryen',
  ],
  lotr: [
    'lord of the rings', 'middle-earth', 'middle earth', 'the shire',
    'hobbit', 'frodo baggins', 'bilbo', 'gandalf', 'aragorn',
    'legolas', 'gimli', 'sauron', 'mordor', 'mount doom', 'the one ring',
    'rivendell', 'elrond', 'galadriel', 'orc',
  ],
  dc: [
    'batman', 'bruce wayne', 'gotham city', 'joker', 'harley quinn',
    'superman', 'clark kent', 'metropolis', 'kryptonite', 'wonder woman',
    'diana prince', 'themyscira', 'the flash', 'aquaman', 'lex luthor',
  ],
  dune: [
    'arrakis', 'paul atreides', "muad'dib", 'house atreides', 'house harkonnen',
    'fremen', 'sandworm', 'the spice', 'melange', 'leto atreides',
    'bene gesserit', 'kwisatz haderach',
  ],
  'avatar-cameron': [
    "na'vi", 'navi', 'pandora', 'unobtanium', 'rda', 'jake sully',
    'neytiri', 'hometree', 'tree of souls', 'toruk',
  ],
  'avatar-airbender': [
    'aang', 'katara', 'sokka', 'toph beifong', 'zuko', 'azula',
    'appa', 'momo', 'air nomad', 'air nomads', 'southern air temple',
    'the avatar state', 'fire nation', 'earth kingdom', 'water tribe',
    'ba sing se', 'the last airbender',
  ],
  'one-piece': [
    'monkey d luffy', 'one piece', 'straw hat', 'zoro', 'nami',
    'sanji', 'usopp', 'chopper', 'robin', 'franky', 'brook',
    'grand line', 'devil fruit',
  ],
  naruto: [
    'naruto uzumaki', 'sasuke uchiha', 'sakura haruno', 'kakashi hatake',
    'hidden leaf', 'konoha', 'chakra', 'sharingan', 'rasengan', 'akatsuki',
  ],
  'attack-on-titan': [
    'eren yeager', 'mikasa ackerman', 'armin arlert', 'levi ackerman',
    'titan', 'survey corps', 'wall maria', 'wall rose', 'wall sina',
    'the beast titan',
  ],
  'breaking-bad': [
    'walter white', 'heisenberg', 'jesse pinkman', 'saul goodman',
    'gus fring', 'albuquerque',
  ],
}

const INSPIRED_REGISTERS: string[] = [
  'cybernetic implant', 'cybernetic eye', 'neural jack', 'corporate dystopia',
  'farmboy', 'prophecy', 'chosen one', 'the old gods',
  'neon-drenched', 'hover-bike', 'mech suit',
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function wholePhrase(phrase: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(phrase)}(?![A-Za-z0-9])`, 'i')
}

export function detectStoryCopyright(seed: string): ImagePolicy {
  const lc = (seed ?? '').toLowerCase()
  if (!lc.trim()) {
    return {
      ip_level: 'original',
      franchise: null,
      model_preference: 'gemini-stylised',
      reason: 'empty seed — default stylised path',
    }
  }

  // All renders go through Gemini now — FLUX and SeeDream were removed
  // from the pipeline after they produced off-style output for animated
  // franchises and added unwanted figures to scenes.  The franchise tag
  // is still useful for character-sheet-builder and visual-prompt-builder
  // to derive the right storyRegister, so we keep detecting it.
  for (const franchise of Object.keys(FRANCHISES)) {
    const hits: string[] = []
    for (const token of FRANCHISES[franchise]) {
      if (wholePhrase(token).test(lc)) hits.push(token)
      if (hits.length >= 4) break
    }
    if (hits.length > 0) {
      return {
        ip_level: 'known',
        franchise,
        model_preference: 'gemini-stylised',
        reason: `Matched ${franchise} token(s): ${hits.join(', ')}`,
      }
    }
  }

  const inspired: string[] = []
  for (const token of INSPIRED_REGISTERS) {
    if (wholePhrase(token).test(lc)) inspired.push(token)
  }
  if (inspired.length > 0) {
    return {
      ip_level: 'inspired',
      franchise: null,
      model_preference: 'gemini-stylised',
      reason: `Inspired-register hits: ${inspired.slice(0, 4).join(', ')}`,
    }
  }

  return {
    ip_level: 'original',
    franchise: null,
    model_preference: 'gemini-stylised',
    reason: 'no franchise tokens detected — grounded/original seed',
  }
}
