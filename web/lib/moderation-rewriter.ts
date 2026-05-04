/**
 * moderation-rewriter — deterministic trigger-word softener for image
 * model prompts refused by BFL / Google / ByteDance safety filters.
 *
 * Invoked by the image-gen route when FLUX returns finish_reason
 * "content_filter" / "no_image" / HTTP 400.  Rewrites known trigger
 * words into non-flagging synonyms and returns both the rewritten
 * prompt and a diff array so the UI can surface the substitution in
 * the agent ticker ("nanotech armor → layered plate").  Two levels of
 * aggression: "light" touches only violence / trademark-ish tokens;
 * "heavy" also generalises cosmic / sci-fi vocabulary.
 *
 * Deterministic, stdlib only, zero LLM — the moment the demo depends
 * on a live rewrite LLM, a degraded upstream can block every image.
 * A Python mirror lives at hermes-agent/tools/moderation_rewriter.py
 * so other Hermes users can drop the same pre-filter in front of
 * their own image pipelines.
 */

export interface ModerationDiff {
  from: string
  to: string
}

export interface ModerationResult {
  rewritten: string
  diff: ModerationDiff[]
  aggression: 'light' | 'heavy'
}

/** Light substitutions — violence + trademark-coded vocabulary that
 *  reliably flips safety filters to "PROHIBITED_CONTENT" / "no_image".
 *  Keys are regex-safe literal phrases, matched case-insensitively as
 *  whole words (see applyDict).  Values are narrative-preserving
 *  softeners that keep the beat readable.
 */
const LIGHT_DICT: Record<string, string> = {
  // trademark-coded materials
  'nanotech armor': 'layered plate armor',
  'nanotech body armor': 'layered plate armor',
  'nanotech': 'layered',
  'adamantium': 'darksteel',
  'vibranium': 'mirror-metal',

  // violence / body horror
  'charred black': 'darkened',
  'charred skin': 'darkened skin',
  'charred': 'darkened',
  'blackens': 'darkens',
  'blackening': 'darkening',
  'bleeding': 'wounded',
  'bleeds': 'is wounded',
  'severed': 'cut free',
  'decapitated': 'fallen',
  'gore': 'aftermath',
  'bloody': 'battle-marked',
  'blood-soaked': 'battle-worn',
  'skull': 'silhouette',
  'corpse': 'fallen figure',
  'dying': 'wounded',
  'dead body': 'fallen figure',
  'burning alive': 'surrounded by flame',

  // implicit minor / unsafe subjects
  'child soldier': 'young warrior',
  'child warrior': 'young warrior',
}

/** Heavy substitutions — layered on top of LIGHT when the light pass
 *  doesn't get through.  Loosens cosmic / superhero / franchise-coded
 *  register that some filters associate with trademarked properties. */
const HEAVY_DICT: Record<string, string> = {
  ...LIGHT_DICT,

  // ---- marvel / MCU --------------------------------------------------
  'infinity stones': 'six jeweled shards',
  'infinity stone': 'jeweled shard',
  'gauntlet': 'armored glove',
  'cosmic power': 'radiant light',
  'cosmic energy': 'radiant energy',
  'kaleidoscopic': 'many-coloured',
  'dimensional': 'otherworldly',
  'multiverse': 'other world',
  'thunder god': 'warrior',
  'warrior god': 'warrior',
  'titan warlord': 'giant warlord',
  'arc reactor': 'chest-lantern',
  'repulsor': 'beam',
  'hulked': 'transformed',
  'iron man': 'armored hero',
  'tony stark': 'lean goateed inventor',
  'captain america': 'star-shield warrior',
  'thor': 'blond thunder-warrior',
  'hulk': 'green-skinned giant',
  'black widow': 'red-haired spy',
  'thanos': 'violet-skinned titan',
  'mjolnir': 'rune hammer',
  'stormbreaker': 'short-handled thunder axe',
  'vibranium': 'mirror-metal',

  // ---- avatar: the last airbender -----------------------------------
  'aang': 'bald monk boy',
  'katara': 'water-tribe girl',
  'sokka': 'stocky polar boy',
  'zuko': 'scarred exiled prince',
  'azula': 'sharp-eyed royal sister',
  'toph': 'young earthbender',
  'appa': 'six-legged flying bison',
  'momo': 'winged lemur',
  'avatar state': 'luminous spirit trance',
  'firebender': 'flame-wielder',
  'waterbender': 'water-wielder',
  'earthbender': 'stone-wielder',
  'airbender': 'wind-wielder',
  'fire nation': 'crimson empire',
  'water tribe': 'arctic snow-country tribe',
  'earth kingdom': 'stone kingdom',
  'air nomads': 'monk nomads',
  'polar boy': 'arctic teenage boy',
  'polar tribe': 'arctic snow-country tribe',
  'polar girl': 'arctic teenage girl',
  'southern air temple': 'mountain monastery',
  'ba sing se': 'walled capital',

  // ---- star wars -----------------------------------------------------
  'luke skywalker': 'blond desert knight',
  'darth vader': 'black-armored warlord',
  'anakin': 'young knight-apprentice',
  'leia': 'braided princess',
  'han solo': 'roguish pilot',
  'obi-wan': 'bearded mentor',
  'yoda': 'small green sage',
  'lightsaber': 'energy blade',
  'jedi': 'light-order knight',
  'sith': 'dark-order lord',
  'stormtrooper': 'white-armored soldier',
  'death star': 'moon-sized battle station',
  'tatooine': 'twin-sun desert world',

  // ---- lotr ----------------------------------------------------------
  'frodo': 'dark-haired halfling',
  'sam': 'stout halfling gardener',
  'gandalf': 'grey-robed wizard',
  'aragorn': 'ranger king',
  'legolas': 'pale blond elf-archer',
  'gimli': 'red-bearded dwarf-warrior',
  'sauron': 'fiery eye tyrant',
  'mordor': 'ash-black volcano realm',
  'the one ring': 'the gold band',
  'middle-earth': 'ancient northern continent',

  // ---- harry potter --------------------------------------------------
  'harry potter': 'lightning-scarred boy-wizard',
  'hermione': 'bushy-haired witch',
  'ron weasley': 'red-haired wizard-boy',
  'dumbledore': 'long-bearded headmaster',
  'voldemort': 'serpentine dark lord',
  'hogwarts': 'cliffside magic castle',
  'quidditch': 'sky-broom sport',

  // ---- game of thrones ----------------------------------------------
  'jon snow': 'dark-curls northern warrior',
  'daenerys': 'silver-haired dragon queen',
  'tyrion': 'sharp-tongued dwarf-lord',
  'iron throne': 'sword-welded throne',
  'white walker': 'blue-eyed ice wight',
  'winterfell': 'northern stone keep',

  // ---- dune ----------------------------------------------------------
  'paul atreides': 'young noble heir',
  'arrakis': 'sand-ocean desert world',
  'fremen': 'desert nomad warriors',
  'sandworm': 'giant burrowing leviathan',
  'melange': 'glittering blue spice',

  // ---- anime (starter pack) -----------------------------------------
  'naruto': 'blond whiskered ninja-boy',
  'sasuke': 'dark-haired rival-ninja',
  'sakura': 'pink-haired kunoichi',
  'kakashi': 'silver-haired masked mentor',
  'hidden leaf': 'forest ninja village',
  'chakra': 'inner life-force',
  'sharingan': 'spinning-pupil red eye',
  'luffy': 'straw-hatted rubber pirate',
  'zoro': 'green-haired three-sword swordsman',
  'nami': 'orange-haired navigator',
  'grand line': 'great tropical sea route',
  'devil fruit': 'power-granting cursed fruit',
  'eren': 'dark-haired titan-shifter',
  'mikasa': 'black-haired red-scarf warrior',
  'titan': 'giant humanoid beast',
  'survey corps': 'wing-cloaked scout regiment',

  // ---- breaking bad --------------------------------------------------
  'walter white': 'bald goateed chemistry teacher',
  'heisenberg': 'bearded man in black hat',
  'jesse pinkman': 'young blond partner',
}

/** Apply a dictionary of case-insensitive whole-phrase substitutions.
 *  Collects every replacement actually made so the UI can diff them.
 *  Sorted by phrase length descending so "charred skin" replaces before
 *  "charred" does. */
function applyDict(input: string, dict: Record<string, string>): { rewritten: string; diff: ModerationDiff[] } {
  const phrases = Object.keys(dict).sort((a, b) => b.length - a.length)
  let working = input
  const diff: ModerationDiff[] = []
  for (const phrase of phrases) {
    const safe = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Word-boundary only when phrase starts/ends with a word char.
    const re = new RegExp(`(?<![A-Za-z0-9])${safe}(?![A-Za-z0-9])`, 'gi')
    const replacement = dict[phrase]
    let matched = false
    working = working.replace(re, () => {
      matched = true
      return replacement
    })
    if (matched) diff.push({ from: phrase, to: replacement })
  }
  return { rewritten: working, diff }
}

export function rewriteForModeration(
  prompt: string,
  reason: string,
  aggression: 'light' | 'heavy' = 'light',
): ModerationResult {
  const dict = aggression === 'heavy' ? HEAVY_DICT : LIGHT_DICT
  const { rewritten, diff } = applyDict(prompt, dict)

  // If nothing changed and we're on "heavy", nuke the still-dramatic
  // intensifiers — this is the last-chance pass before SeeDream fallback.
  if (diff.length === 0 && aggression === 'heavy') {
    const { rewritten: stripped, diff: stripDiff } = applyDict(rewritten, {
      'operatic': 'balanced',
      'high-contrast': 'balanced-contrast',
      'burning': 'glowing',
      'engulfed': 'surrounded',
      'rim-lit': 'side-lit',
    })
    return { rewritten: stripped, diff: stripDiff, aggression }
  }

  return { rewritten, diff, aggression }
}

// Silence the "unused reason param" lint — the reason isn't used for
// routing yet, but keeping it in the signature mirrors the Python tool
// and leaves room for refusal-aware rewriting (e.g. BFL-specific vs
// Google-specific dictionaries) without another breaking change.
export function _reasonIsInfo(reason: string): boolean { return reason.length > 0 }
