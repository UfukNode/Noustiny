/**
 * Narrative context builder — TypeScript mirror of the
 * ``narrative_context_builder`` Hermes tool
 * (``hermes-agent/tools/narrative_context_builder.py``).
 *
 * The route can't tool-call Python through chat-completions because Nous
 * Portal emits ``<tool_call>`` XML that the Hermes agent loop doesn't
 * round-trip back as ``message.tool_calls``.  So we compute the brief
 * inline in TypeScript and inject it as ``contextBrief`` in the skill
 * payload.  The Python tool stays the canonical upstream-PR version for
 * CLI / Telegram callers.  If the algorithm changes, update both in one
 * commit.
 */

interface Beat {
  id?: string
  title?: string
  body?: string
  mood?: string
}

interface Entity {
  name: string
  kind: 'character' | 'object'
  mentions: number
  firstScene: number
  lastScene: number
}

interface Motif {
  token: string
  scenes: number[]
  mentions: number
  carryStrength: number
}

interface Signals {
  beatCount: number
  avgBodyWords: number
  avgSentenceWords: number
  properNounDensityPer100Words: number
  moodArc: string[]
  registerHint: 'cinematic-action' | 'literary-interior' | 'named-ensemble' | 'balanced'
  motifsTop: Motif[]
}

export interface ContextBrief {
  brief: string
  entities: Entity[]
  signals: Signals
  characterCount: number
  objectCount: number
  beatCount: number
}

const STOPWORDS = new Set<string>([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'any',
  'every', 'all', 'no', 'none', 'each', 'one', 'other', 'another',
  'of', 'in', 'on', 'at', 'by', 'to', 'for', 'with', 'without',
  'from', 'about', 'against', 'between', 'through', 'into', 'onto',
  'over', 'under', 'before', 'after', 'during', 'while', 'within',
  'out', 'off', 'up', 'down', 'across', 'along', 'around',
  'and', 'or', 'but', 'if', 'so', 'than', 'then', 'though', 'although',
  'because', 'since', 'until', 'unless', 'whether', 'as', 'like',
  'i', 'me', 'my', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'we', 'us', 'our', 'they', 'them', 'their',
  'who', 'whom', 'whose', 'which', 'what', 'where', 'when', 'why', 'how',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'has', 'have', 'had', 'having', 'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might',
  'there', 'here', 'yes', 'not', 'never', 'always', 'still',
  'just', 'only', 'even', 'also', 'too', 'back', 'away', 'now',
  'again', 'once', 'ever',
])

const WORD_RE = /\p{L}+/gu
const SENT_BOUNDARY_RE = /[.!?]\s+|\n+/g

function isTitleCase(tok: string): boolean {
  if (tok.length < 2) return false
  const first = tok[0]
  if (first.toUpperCase() !== first) return false
  if (first.toLowerCase() === first) return false
  const rest = tok.slice(1)
  return rest === rest.toLowerCase()
}

function sentenceInitialIndices(text: string): Set<number> {
  const starts = new Set<number>()
  if (!text) return starts
  let pos = 0
  while (pos < text.length && /\s/.test(text[pos])) pos += 1
  if (pos < text.length) starts.add(pos)
  SENT_BOUNDARY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SENT_BOUNDARY_RE.exec(text)) !== null) {
    let after = m.index + m[0].length
    while (after < text.length && /\s/.test(text[after])) after += 1
    if (after < text.length) starts.add(after)
  }
  return starts
}

function collectWords(text: string): { tok: string; start: number }[] {
  const out: { tok: string; start: number }[] = []
  if (!text) return out
  WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RE.exec(text)) !== null) {
    out.push({ tok: m[0], start: m.index })
  }
  return out
}

function collectLowercaseVocab(beats: Beat[]): Set<string> {
  const vocab = new Set<string>()
  for (const beat of beats) {
    for (const text of [beat.title ?? '', beat.body ?? '']) {
      for (const { tok } of collectWords(text)) {
        if (tok === tok.toLowerCase()) vocab.add(tok)
      }
    }
  }
  return vocab
}

function normaliseBody(body: string, lowercaseVocab: Set<string>): string {
  if (!body) return ''
  const sentStarts = sentenceInitialIndices(body)
  const words = collectWords(body)
  let result = ''
  let cursor = 0
  for (const { tok, start } of words) {
    result += body.slice(cursor, start)
    const low = tok.toLowerCase()
    if (
      sentStarts.has(start) &&
      isTitleCase(tok) &&
      (lowercaseVocab.has(low) || STOPWORDS.has(low))
    ) {
      result += low
    } else {
      result += tok
    }
    cursor = start + tok.length
  }
  result += body.slice(cursor)
  return result
}

interface Counts {
  name: string
  firstScene: number
  lastScene: number
  mentions: number
  scenesHit: Set<number>
}

function scanBeat(
  idx: number,
  body: string,
  charCounts: Map<string, Counts>,
  objectCounts: Map<string, Counts>,
): void {
  const words = collectWords(body)

  let i = 0
  while (i < words.length) {
    const { tok } = words[i]
    if (isTitleCase(tok)) {
      const run: string[] = [tok]
      let j = i + 1
      while (j < words.length && isTitleCase(words[j].tok)) {
        run.push(words[j].tok)
        j += 1
      }
      const phrase = run.join(' ')
      const existing = charCounts.get(phrase) ?? {
        name: phrase,
        firstScene: idx,
        lastScene: idx,
        mentions: 0,
        scenesHit: new Set<number>(),
      }
      existing.mentions += 1
      existing.lastScene = idx
      if (existing.firstScene > idx) existing.firstScene = idx
      existing.scenesHit.add(idx)
      charCounts.set(phrase, existing)
      i = j
      continue
    }
    i += 1
  }

  for (const { tok } of words) {
    const low = tok.toLowerCase()
    if (low.length < 4) continue
    if (STOPWORDS.has(low)) continue
    if (isTitleCase(tok)) continue
    const existing = objectCounts.get(low) ?? {
      name: low,
      firstScene: idx,
      lastScene: idx,
      mentions: 0,
      scenesHit: new Set<number>(),
    }
    existing.mentions += 1
    existing.lastScene = idx
    if (existing.firstScene > idx) existing.firstScene = idx
    existing.scenesHit.add(idx)
    objectCounts.set(low, existing)
  }
}

function classify(
  charCounts: Map<string, Counts>,
  objectCounts: Map<string, Counts>,
): { characters: Entity[]; objects: Entity[] } {
  const characters: Entity[] = []
  for (const [key, entry] of charCounts.entries()) {
    const low = key.toLowerCase()
    const sameAsObject = objectCounts.has(low)
    const isPhrase = key.includes(' ')
    const crossScene = entry.firstScene !== entry.lastScene
    if (isPhrase || crossScene) {
      characters.push({
        name: entry.name, kind: 'character', mentions: entry.mentions,
        firstScene: entry.firstScene, lastScene: entry.lastScene,
      })
    } else if (sameAsObject) {
      const obj = objectCounts.get(low)!
      obj.mentions += entry.mentions
      obj.firstScene = Math.min(obj.firstScene, entry.firstScene)
      obj.lastScene = Math.max(obj.lastScene, entry.lastScene)
      for (let s = entry.firstScene; s <= entry.lastScene; s += 1) obj.scenesHit.add(s)
    } else {
      characters.push({
        name: entry.name, kind: 'character', mentions: entry.mentions,
        firstScene: entry.firstScene, lastScene: entry.lastScene,
      })
    }
  }
  const objects: Entity[] = []
  for (const entry of objectCounts.values()) {
    if (entry.scenesHit.size >= 2) {
      objects.push({
        name: entry.name, kind: 'object', mentions: entry.mentions,
        firstScene: entry.firstScene, lastScene: entry.lastScene,
      })
    }
  }
  const sortFn = (a: Entity, b: Entity) =>
    b.mentions - a.mentions || a.firstScene - b.firstScene || a.name.localeCompare(b.name)
  characters.sort(sortFn)
  objects.sort(sortFn)
  return { characters, objects }
}

function storySignals(allBeats: Beat[]): Signals {
  let totalWords = 0
  let totalSentences = 0
  let properNounTotal = 0
  const moodArc: string[] = []
  const lowerCount = new Map<string, number>()
  const lowerScenes = new Map<string, Set<number>>()

  allBeats.forEach((beat, idx) => {
    const body = beat.body ?? ''
    const words = collectWords(body)
    totalWords += words.length
    if (body) {
      const sents = body.match(SENT_BOUNDARY_RE)
      totalSentences += (sents?.length ?? 0) + 1
    }
    for (const { tok } of words) {
      if (isTitleCase(tok)) {
        properNounTotal += 1
        continue
      }
      const low = tok.toLowerCase()
      if (low.length < 4 || STOPWORDS.has(low)) continue
      lowerCount.set(low, (lowerCount.get(low) ?? 0) + 1)
      const scenes = lowerScenes.get(low) ?? new Set<number>()
      scenes.add(idx)
      lowerScenes.set(low, scenes)
    }
    if (beat.mood) moodArc.push(beat.mood.trim().toLowerCase())
  })

  const avgBodyWords = allBeats.length > 0 ? totalWords / allBeats.length : 0
  const avgSentenceWords = totalSentences > 0 ? totalWords / totalSentences : 0
  const density = totalWords > 0 ? (properNounTotal * 100) / totalWords : 0

  const motifs: Motif[] = []
  for (const [token, scenes] of lowerScenes.entries()) {
    if (scenes.size < 2) continue
    motifs.push({
      token,
      scenes: [...scenes].sort((a, b) => a - b),
      mentions: lowerCount.get(token) ?? 0,
      carryStrength: Math.round((scenes.size / allBeats.length) * 1000) / 1000,
    })
  }
  motifs.sort(
    (a, b) => b.carryStrength - a.carryStrength || b.mentions - a.mentions || a.token.localeCompare(b.token),
  )

  let registerHint: Signals['registerHint'] = 'balanced'
  if (avgSentenceWords > 0) {
    if (avgSentenceWords < 12 && density > 4) registerHint = 'cinematic-action'
    else if (avgSentenceWords > 22) registerHint = 'literary-interior'
    else if (density > 8) registerHint = 'named-ensemble'
  }

  return {
    beatCount: allBeats.length,
    avgBodyWords: Math.round(avgBodyWords * 10) / 10,
    avgSentenceWords: Math.round(avgSentenceWords * 10) / 10,
    properNounDensityPer100Words: Math.round(density * 100) / 100,
    moodArc,
    registerHint,
    motifsTop: motifs.slice(0, 5),
  }
}

function shortText(text: string, cap: number): string {
  const cleaned = (text ?? '').trim().replace(/\n+/g, ' ')
  return cleaned.length <= cap ? cleaned : cleaned.slice(0, cap).trimEnd() + '…'
}

function renderBrief(
  canonBeats: Beat[],
  focus: Beat,
  characters: Entity[],
  objects: Entity[],
  signals: Signals,
  maxChars: number,
): string {
  const lines: string[] = ['# Canon Context Brief', '']
  lines.push('## Story fingerprint')
  lines.push(`- register: **${signals.registerHint}**`)
  lines.push(`- beats so far: ${signals.beatCount}`)
  lines.push(
    `- avg body: ${signals.avgBodyWords} words · avg sentence: ${signals.avgSentenceWords} words`,
  )
  lines.push(
    `- proper-noun density: ${signals.properNounDensityPer100Words} per 100 words`,
  )
  if (signals.moodArc.length > 0) lines.push(`- mood arc: ${signals.moodArc.join(' → ')}`)
  if (signals.motifsTop.length > 0) {
    const carry = signals.motifsTop
      .map((m) => `${m.token} (${m.mentions}× across ${m.scenes.length} beats)`)
      .join(', ')
    lines.push(`- recurring motifs: ${carry}`)
  }
  lines.push('')

  if (characters.length > 0) {
    lines.push('## Characters on stage')
    for (const c of characters.slice(0, 10)) {
      const span =
        c.firstScene === c.lastScene
          ? `beat ${c.firstScene}`
          : `beats ${c.firstScene}-${c.lastScene}`
      lines.push(`- **${c.name}** · ${c.mentions}× · ${span}`)
    }
    lines.push('')
  }
  if (objects.length > 0) {
    lines.push('## Objects in play')
    for (const o of objects.slice(0, 10)) {
      const span =
        o.firstScene === o.lastScene
          ? `beat ${o.firstScene}`
          : `beats ${o.firstScene}-${o.lastScene}`
      lines.push(`- **${o.name}** · ${o.mentions}× · ${span}`)
    }
    lines.push('')
  }
  lines.push('## Canon spine (root → parent of focus)')
  canonBeats.forEach((beat, i) => {
    const title = beat.title ?? `beat ${i}`
    const body = shortText(beat.body ?? '', 240)
    lines.push(body ? `${i}. **${title}**  \n   ${body}` : `${i}. **${title}**`)
  })
  lines.push('')
  const focusTitle = focus.title ?? '(focus)'
  const focusBody = shortText(focus.body ?? '', 480)
  lines.push('## Focus beat — resolve pronouns against everything above')
  lines.push(`> **${focusTitle}**`)
  if (focusBody) lines.push(`> ${focusBody}`)

  const brief = lines.join('\n')
  return brief.length > maxChars ? brief.slice(0, maxChars - 1).trimEnd() + '…' : brief
}

/** Compute a narrative grounding brief for a focus beat given its canon
 *  spine.  Mirrors the ``narrative_context_builder`` Hermes Python tool.
 *  Synchronous, pure.  Safe to call on every request. */
export function buildNarrativeContext(
  canonBeats: Beat[],
  focusBeat: Beat,
  { maxBriefChars = 2400 }: { maxBriefChars?: number } = {},
): ContextBrief {
  const allBeats = [...canonBeats, focusBeat]
  const lowercaseVocab = collectLowercaseVocab(allBeats)

  const normalised = allBeats.map((b) => ({
    ...b,
    body: normaliseBody(b.body ?? '', lowercaseVocab),
  }))

  const charCounts = new Map<string, Counts>()
  const objectCounts = new Map<string, Counts>()
  normalised.forEach((beat, idx) => scanBeat(idx, beat.body ?? '', charCounts, objectCounts))

  const { characters, objects } = classify(charCounts, objectCounts)
  const signals = storySignals(allBeats)
  const brief = renderBrief(canonBeats, focusBeat, characters, objects, signals, maxBriefChars)

  return {
    brief,
    entities: [...characters, ...objects],
    signals,
    characterCount: characters.length,
    objectCount: objects.length,
    beatCount: allBeats.length,
  }
}
