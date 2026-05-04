'use client'

import { useStory } from './store'
import type {
  AgentEvent, AgentId, BranchSuggestion, CritiqueResponse,
  JudgeResponse, NodeMood, NodeTone,
  RewriteResponse, Scene, SceneComposeResponse, StoryNode,
  WriterAssistResponse,
} from './types'
import { imageUrl, seedFromString } from './image'
import { detectStoryCopyright, type ImagePolicy } from './story-copyright-detector'
import { resolveCharacterAlias } from './character-registry-lookup'
import { requestControl } from './request-control'

/** Server-attached tool event (from /api/hermes image-prompt-build and
 *  image-gen).  One per invocation of character-registry-lookup or
 *  moderation-rewriter — hydrated into the agent ticker so the demo
 *  viewer sees every tool hop fire live. */
interface ToolEvent {
  tool: 'character-registry-lookup' | 'moderation-rewriter'
  label: string
  detail: string
  status: 'done' | 'error'
}

const tickerId = (() => {
  let n = 0
  return () => `t-${Date.now().toString(36)}-${n++}`
})()

/** Shared helper — unused by the existing calls (keeping them inline
 *  to minimise diff), kept for future single-call sites.  The abort
 *  integration is done by rewriting every inline fetch below to pass
 *  ``signal: requestControl.signal``. */

const inflightExpand = new Set<string>()
const inflightAssist = new Set<string>()
const inflightReharmonize = new Set<string>()
const inflightCompose = new Set<string>()
const inflightDetector = new Set<string>()
const inflightCharacterSheet = new Set<string>()

/** Run the story-copyright-detector skill (via the /api/hermes route)
 *  and persist the resulting ImagePolicy to the Zustand store.  The
 *  route falls back to the deterministic TS mirror when the skill call
 *  fails, so this never blocks the UI.  Called once per distinct seed. */
export async function detectStoryPolicy(seed: string): Promise<void> {
  const key = seed.trim().slice(0, 120)
  if (!key || inflightDetector.has(key)) return
  inflightDetector.add(key)

  const store = useStory.getState()
  // Baseline first — so policy is immediately available for the first beat.
  const baseline = detectStoryCopyright(seed)
  store.setImagePolicy(baseline)

  const prefLabel = (p: ImagePolicy['model_preference']): string =>
    p === 'gemini-stylised' ? 'stylised' : 'photoreal'

  const ev = agentEvent(
    'registry-lookup',
    `COPYRIGHT-DETECTOR · baseline ${baseline.ip_level}${baseline.franchise ? ` · ${baseline.franchise}` : ''}`,
    'story_copyright_detector',
  )
  store.appendAgent({ ...ev, status: 'done', text: baseline.reason })

  try {
    const res = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({ kind: 'copyright-detect', seed }),
    })
    if (!res.ok) return
    const policy = (await res.json()) as ImagePolicy
    if (!policy || !policy.model_preference) return
    store.setImagePolicy(policy)
    const skillEv = agentEvent(
      'registry-lookup',
      `COPYRIGHT-DETECTOR · ${policy.ip_level}${policy.franchise ? ` · ${policy.franchise}` : ''} → ${prefLabel(policy.model_preference)}`,
      'story-copyright-detector · hermes',
    )
    store.appendAgent({ ...skillEv, status: 'done', text: policy.reason })
  } catch {
    // baseline already persisted; nothing more to do
  } finally {
    inflightDetector.delete(key)
  }
}

/** Build the story's character sheet (1-4 principals) and render a hero
 *  portrait for each.  Portraits become ``characterRefs`` — every
 *  subsequent beat's image-gen passes them as multi-modal references so
 *  the same faces appear across the storyboard.  Fire-and-forget from
 *  the landing Enter click after detectStoryPolicy settles.
 *
 *  The skill needs the detector's policy fields — franchise slug and
 *  storyRegister — to seed its fingerprint and portrait aesthetics.
 *  We read them from the store after detector has written them. */
export async function generateCharacterSheet(seed: string): Promise<void> {
  const key = seed.trim().slice(0, 120)
  if (!key || inflightCharacterSheet.has(key)) return
  inflightCharacterSheet.add(key)

  const store = useStory.getState()
  const policy = store.imagePolicy
  const franchise = policy.franchise
  // Register string isn't stored explicitly — re-derive from the same
  // fingerprint table the skill uses.  For simple mapping we rely on
  // franchise slug; when absent the skill has its own fallback register.
  const storyRegister = policyToRegister(policy)

  const hubEv = agentEvent(
    'character-sheet',
    `CAST-SHEET · building principals${franchise ? ` · ${franchise}` : ''}`,
    'character-sheet-builder · hermes',
  )
  store.appendAgent({ ...hubEv, status: 'streaming' })

  try {
    const res = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'character-sheet',
        seed,
        franchise: franchise ?? null,
        storyRegister,
        // Named IP in portraits only when the image model supports it.
        // Gemini/SeeDream (stylised path) pass.  FLUX refuses named IP
        // prompts reliably so we stay sanitised there.
        // Always try named prompts first.  If the image model refuses,
        // route.ts's moderation_rewriter strips IP tokens and retries.
        // This avoids proactively sanitising prompts the model would
        // have happily accepted (Gemini usually does; even FLUX often
        // does for animated franchises).
        allow_ip_names: true,
      }),
    })
    if (!res.ok) {
      store.updateAgent(hubEv.id, { status: 'error', text: 'skill call failed' })
      return
    }
    const data = (await res.json()) as {
      characters?: { name: string; description: string; portrait_prompt: string }[]
    }
    const entries = data.characters ?? []
    if (entries.length === 0) {
      store.updateAgent(hubEv.id, { status: 'error', text: 'skill returned empty cast' })
      return
    }
    // Persist descriptions into the text registry immediately so even if
    // the portrait render fails, visual-prompt-builder still reuses the
    // canonical description.
    const descriptions: Record<string, string> = {}
    for (const e of entries) descriptions[e.name] = e.description
    store.mergeCharacters(descriptions)
    store.updateAgent(hubEv.id, {
      status: 'done',
      text: entries.map((e) => `• ${e.name}`).join('\n'),
    })

    // Fire portrait renders in parallel.  Each emits its own visible
    // agent event so the demo viewer watches the sheet fill in.
    await Promise.all(entries.map(async (e) => {
      const ev = agentEvent(
        'character-sheet',
        `PORTRAIT · ${e.name}`,
        'portrait render',
      )
      const localStore = useStory.getState()
      localStore.appendAgent({ ...ev, status: 'streaming', text: 'rendering…' })
      try {
        const gen = await fetch('/api/hermes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
          body: JSON.stringify({
            kind: 'image-gen',
            prompt: e.portrait_prompt,
            style: 'cinematic',
            aspect: 'square',
            modelPreference: policy.model_preference,
          }),
        })
        if (!gen.ok) throw new Error(`http ${gen.status}`)
        const genData = (await gen.json()) as { url?: string; events?: ToolEvent[] }
        emitToolEvents(genData.events)
        if (genData.url) {
          useStory.getState().mergeCharacterRefs({ [e.name]: genData.url })
          useStory.getState().updateAgent(ev.id, { status: 'done', text: 'portrait cached' })
        } else {
          useStory.getState().updateAgent(ev.id, { status: 'error', text: 'no image returned' })
        }
      } catch (err) {
        if (isAbortError(err)) return
    const message = err instanceof Error ? err.message :'portrait error'
        useStory.getState().updateAgent(ev.id, { status: 'error', text: message })
      }
    }))
  } catch (err) {
    if (isAbortError(err)) return
    const message = err instanceof Error ? err.message :'character-sheet error'
    store.updateAgent(hubEv.id, { status: 'error', text: message })
  } finally {
    inflightCharacterSheet.delete(key)
  }
}

/** Deterministic map from detector policy to a storyRegister string.
 *  Mirrors the fingerprint table in visual-prompt-builder's SKILL.md so
 *  character portraits match beat-level frames. */
function policyToRegister(policy: ImagePolicy): string {
  const f = policy.franchise
  if (f === 'marvel' || f === 'dc') {
    return 'superhero-finale, operatic cosmic, IMAX 70mm color grade, high dynamic range, heroic silhouettes'
  }
  if (f === 'avatar-airbender' || f === 'one-piece' || f === 'naruto' || f === 'attack-on-titan') {
    return 'animated-feature, cel-shaded 2D animation, crisp ink outlines, vibrant saturated palette, Studio Mir-style atmospheric shading'
  }
  if (f === 'avatar-cameron') {
    return 'space-opera, practical-effects cinematic, anamorphic lens flares, deep navy shadows, bioluminescent palette'
  }
  if (f === 'star-wars') {
    return 'space-opera, practical-effects cinematic, anamorphic lens flares, deep navy shadows, amber cockpit glow'
  }
  if (f === 'lotr' || f === 'got') {
    return 'high-fantasy epic, oil-painting detail, volumetric cathedral light, earth-and-ember palette'
  }
  if (f === 'harry-potter') {
    return 'warm magical realism, candlelit interiors, rich jewel tones, cinematic medium-format stills'
  }
  if (f === 'dune') {
    return 'desert sci-fi epic, bleached sun, ochre and bone palette, IMAX wide-angle'
  }
  if (f === 'breaking-bad' || f === 'the-wire') {
    return 'quiet literary drama, natural window light, muted earth tones, medium-format stills'
  }
  return 'cinematic, balanced naturalism, 35mm film'
}

const MOODS: NodeMood[] = ['neutral', 'hopeful', 'tense', 'danger', 'climax', 'quiet', 'discovery']
const TONES: NodeTone[] = ['canon', 'divergent', 'what-if']

function validateMood(m: string): NodeMood {
  return (MOODS as string[]).includes(m) ? (m as NodeMood) : 'neutral'
}
function validateTone(m: string): NodeTone {
  return (TONES as string[]).includes(m) ? (m as NodeTone) : 'divergent'
}

// ---- helpers --------------------------------------------------------------

function canonScenes(): { title: string; body: string }[] {
  const s = useStory.getState()
  const scenes: { title: string; body: string }[] = []
  let cursor: string | null = s.rootId
  while (cursor) {
    const n = s.nodes.get(cursor)
    if (!n) break
    scenes.push({ title: n.title, body: n.body ?? n.summary })
    const next =
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'current') ??
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'canon') ??
      null
    cursor = next
  }
  return scenes
}

function canonTitlesUpTo(nodeId: string): string[] {
  const s = useStory.getState()
  const titles: string[] = []
  let cursor: string | null = s.rootId
  while (cursor) {
    const n = s.nodes.get(cursor)
    if (!n) break
    titles.push(n.title)
    if (cursor === nodeId) break
    const next =
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'current') ??
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'canon') ??
      null
    cursor = next
  }
  return titles
}

/** Walk the canon from root up to (but excluding) ``nodeId`` and return
 *  each ancestor's {id, title, body, mood}.  Feeds the narrative
 *  context builder so the brainstorm / writer-assist skills receive
 *  actual prose rather than just titles. */
function canonBeatsUpTo(nodeId: string): { id: string; title: string; body: string; mood: string }[] {
  const s = useStory.getState()
  const out: { id: string; title: string; body: string; mood: string }[] = []
  let cursor: string | null = s.rootId
  while (cursor && cursor !== nodeId) {
    const n = s.nodes.get(cursor)
    if (!n) break
    out.push({
      id: n.id,
      title: n.title,
      body: n.body ?? n.summary ?? '',
      mood: n.mood,
    })
    const next =
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'current') ??
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'canon') ??
      null
    cursor = next
  }
  return out
}


/** Build the multi-turn chat history that makes `expandNode(nodeId)` read
 *  as a real back-and-forth conversation instead of a stateless single-
 *  shot.  Walks the canon from root to `nodeId`, and at each ancestor
 *  emits a `{user, assistant}` pair:
 *
 *    user     = the intent that drove that round of brainstorming
 *               ("seed is X, give me 1-3 options"  at root;
 *                "I picked <label>, give me the next 1-3"  below)
 *    assistant = the options the model would have produced at that
 *               level, reconstructed from the node's own CHILDREN —
 *               only the brainstormed ones, skipping inserts so the
 *               reconstruction matches what the model actually output
 *               at the time (canon splices / what-ifs are user edits,
 *               not assistant output).
 *
 *  The final (not-yet-answered) user turn for `nodeId` itself is then
 *  pushed on, and the gateway is asked to complete that turn.  The
 *  returned JSON is the new brainstorm output for `nodeId`'s children.
 *
 *  Pure derivation — nothing persisted in the store.  Canon splices /
 *  reverts automatically re-shape the history because they re-shape
 *  the canon walk itself. */
function buildBrainstormHistory(nodeId: string, seed: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const s = useStory.getState()
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []

  // Canon walk from root to nodeId inclusive.
  const canon: StoryNode[] = []
  let cursor: string | null = s.rootId
  while (cursor) {
    const n = s.nodes.get(cursor)
    if (!n) break
    canon.push(n)
    if (cursor === nodeId) break
    const next =
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'current') ??
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'canon') ??
      null
    cursor = next
  }

  // For every ancestor EXCEPT nodeId itself, replay that level's turn.
  // User turns are lightweight ("Story start: …" / "Picked: …").
  // Assistant turns use the PARENT'S verbatim brainstorm reply when
  // available — that's how Gemini browser chat stays coherent: the
  // model always sees its own prior prose unchanged.  Fallback to a
  // reconstructed shape for older nodes that pre-date raw storage.
  for (let i = 0; i < canon.length - 1; i++) {
    const p = canon[i]

    if (i === 0) {
      history.push({ role: 'user', content: seed })
    } else {
      const parent = p.parentId ? s.nodes.get(p.parentId) : null
      const siblings = parent
        ? parent.childrenIds.map((id) => s.nodes.get(id)).filter((n): n is StoryNode => !!n && !n.inserted)
        : []
      const pickIndex = siblings.findIndex((n) => n.id === p.id)
      const pickLabel = p.label ?? p.title
      history.push({
        role: 'user',
        content: pickIndex >= 0 ? `pick option ${pickIndex + 1}` : `pick the option: ${pickLabel}`,
      })
    }

    const content = (p.rawBrainstorm ?? '').trim()
    if (content) {
      history.push({ role: 'assistant', content })
    } else {
      // Legacy fallback — reconstruct from parsed children when the
      // parent node has no stored raw reply (pre-v6 saves).
      const brainstormKids = p.childrenIds
        .map((id) => s.nodes.get(id))
        .filter((n): n is StoryNode => !!n && !n.inserted)
      const scenePart = i === 0 ? '' : (p.body ?? p.summary ?? '').trim()
      const optionsPart = brainstormKids
        .map((c, idx) => `${idx + 1}. ${(c.label ?? c.title.slice(0, 24)).toUpperCase()} — ${(c.summary ?? '').trim()}`)
        .join('\n')
      const reconstructed = scenePart ? `${scenePart}\n\n${optionsPart}` : optionsPart
      if (reconstructed) history.push({ role: 'assistant', content: reconstructed })
    }
  }

  // Final user turn for nodeId.  Root: the seed as the opening message
  // (skill knows to skip the scene paragraph on turn 1).  Non-root: a
  // chat-natural "I pick N" where N is the numbered position of the
  // picked sibling in the parent's brainstorm output.
  const last = canon[canon.length - 1]
  if (last) {
    if (canon.length === 1) {
      history.push({ role: 'user', content: seed })
    } else {
      const parent = last.parentId ? s.nodes.get(last.parentId) : null
      const siblings = parent
        ? parent.childrenIds.map((id) => s.nodes.get(id)).filter((n): n is StoryNode => !!n && !n.inserted)
        : []
      const pickIndex = siblings.findIndex((n) => n.id === last.id)
      history.push({
        role: 'user',
        content: pickIndex >= 0 ? `pick option ${pickIndex + 1}` : `pick the option: ${last.label ?? last.title}`,
      })
    }
  }

  return history
}

function agentEvent(agent: AgentId, label: string, model = 'gemini-2.5-flash'): AgentEvent {
  return {
    id: tickerId(),
    agent,
    model,
    label,
    text: '',
    status: 'thinking',
    startedAt: Date.now(),
  }
}

/** Hydrate tool events from the image-pipeline envelope into the agent
 *  ticker.  Each event fires a short-lived visible entry so the demo
 *  viewer can *see* character-registry hits and moderation rewrites
 *  land as first-class steps. */
function emitToolEvents(events: ToolEvent[] | undefined): void {
  if (!events || events.length === 0) return
  const store = useStory.getState()
  for (const ev of events) {
    const agentId: AgentId = ev.tool === 'moderation-rewriter'
      ? 'moderation-rewriter'
      : 'registry-lookup'
    const model = ev.tool === 'moderation-rewriter'
      ? 'moderation_rewriter (deterministic)'
      : 'character_registry_lookup (deterministic)'
    store.appendAgent({
      id: tickerId(),
      agent: agentId,
      model,
      label: ev.label,
      text: ev.detail,
      status: ev.status,
      startedAt: Date.now(),
    })
  }
}

/** True when an exception came from the shared AbortController.  We
 *  don't want aborted fetches to surface as red agent errors — they
 *  are intentional, not failures. */
function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

/** Parse JSON emitted by Hermes even if the model wrapped it in a fence or
 *  leaked commentary around it. Throws if nothing parseable is present. */
function parseJsonSafe(raw: string): unknown {
  const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim()
  try { return JSON.parse(cleaned) } catch { /* continue */ }
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch { /* continue */ }
  }
  throw new Error('Hermes returned non-JSON')
}

/** Parse a natural-prose brainstorm reply.  The v6 skill doesn't enforce
 *  a format — Gemini can return any of these shapes (all valid):
 *
 *    1. LABEL — summary
 *    **1.** **Bold Header**\nprose paragraph
 *    [Label]: prose with "dialog"
 *    1. **Label**\nSummary paragraph
 *
 *  Everything before the first matched option is the scene paragraph
 *  (patched onto the current node's body so the card reads as prose).
 *  Options become the brainstormed children.  We up-case the label only
 *  for the compact bar's Detroit chip — the full title keeps original
 *  casing so the card stays readable. */
function parseBrainstormText(raw: string): {
  stateDescription: string
  options: Array<{ label: string; summary: string }>
} {
  // Strip any code fence wrapping and collapse redundant blank lines.
  const cleaned = raw
    .replace(/^\s*```\w*\s*|\s*```\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const lines = cleaned.split('\n').map((l) => l.replace(/\r$/, ''))

  // Strip Markdown emphasis markers + lead bullets/labels that Gemini
  // wraps around the actual text.  Cleans `**bold**`, `[Label]:`,
  // `* Prose:` / `- Özet:` prefixes, etc.
  const stripEmph = (s: string) => s.replace(/\*\*|__|\*|_/g, '').trim()
  const stripLead = (s: string) =>
    s.replace(/^\s*\[\s*([^\]]+?)\s*\]\s*:?\s*/, '$1 ')
      .replace(/^\s*[•\-*]\s+/, '')
      .replace(/^\s*(?:prose|özet|summary|not)\s*:\s*/i, '')
      .replace(/^\s+/, '')
      .trim()

  // An option header is a line that STARTS with a number, bullet, or
  // bracket marker at low indent (≤3 spaces).  Continuation prose lines
  // (indented more, or no marker at all) roll into the previous option.
  // We accept both numbered (`1. foo`) and bullet (`* foo` / `- foo`)
  // because Gemini switches between them unpredictably in Turkish, and
  // both are valid option headers in a choice list.
  const reHeaderNumbered = /^\s{0,3}(?:\*\*)?(\d+)(?:\*\*)?\.\s*(.+)$/
  const reHeaderBullet   = /^\s{0,3}[•\-*]\s+(.+)$/
  const reHeaderBracket  = /^\s{0,3}\[\s*([^\]]+?)\s*\]\s*[:—–-]?\s*(.+)$/
  const headerKind = (l: string): { kind: 'numbered' | 'bullet' | 'bracket'; tail: string; num?: number } | null => {
    const mn = l.match(reHeaderNumbered)
    if (mn) return { kind: 'numbered', tail: mn[2], num: parseInt(mn[1], 10) }
    const mbr = l.match(reHeaderBracket)
    if (mbr) return { kind: 'bracket', tail: `${mbr[1]} ${mbr[2]}`.trim() }
    const mbu = l.match(reHeaderBullet)
    if (mbu) return { kind: 'bullet', tail: mbu[1] }
    return null
  }
  const isHeader = (l: string) => headerKind(l) !== null

  // Scan all header indices and split into groups.  A group break
  // happens when:
  //   - kind changes (numbered → bullet or vice-versa), OR
  //   - numbered sequence restarts at 1 (new recap block).
  // We take the LAST group as the real options; earlier groups are
  // prior-turn recap or unrelated.
  const headerIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isHeader(lines[i])) headerIndices.push(i)
  }
  let firstOptIdx = -1
  if (headerIndices.length > 0) {
    let groupStart = headerIndices[0]
    let prevKind: string | null = null
    let prevNum = 0
    for (const idx of headerIndices) {
      const h = headerKind(lines[idx])!
      const breaksGroup =
        (prevKind !== null && h.kind !== prevKind) ||
        (h.kind === 'numbered' && h.num === 1 && prevNum >= 1)
      if (breaksGroup) groupStart = idx
      prevKind = h.kind
      if (h.kind === 'numbered') prevNum = h.num ?? 0
    }
    firstOptIdx = groupStart
  }

  // Scene prose = last non-empty paragraph BEFORE firstOptIdx,
  // skipping prior recap options / pick markers AND preamble lines
  // like "İşte 1-3 seçenek:" / "Here are the options:" / "Lütfen
  // aşağıdakilerden birini seçin:" — those are meta-announcements
  // from the model, not actual scene prose.  Dropping them keeps
  // node.body clean: either real narrative flow or nothing.
  const scanStart = firstOptIdx === -1 ? lines.length : firstOptIdx
  const sceneLines: string[] = []
  for (let i = scanStart - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t === '') {
      if (sceneLines.length > 0) break
      continue
    }
    if (isHeader(lines[i]) || t.startsWith('>')) break
    sceneLines.unshift(lines[i])
  }
  const rawScene = sceneLines.map(stripEmph).join(' ').replace(/\s+/g, ' ').trim()
  const looksLikePreamble = (s: string): boolean => {
    if (!s) return true
    if (s.length < 160 && /:\s*$/.test(s)) return true
    const meta = /\b(?:seçenek|seçenekler|seçeneğ|opsiyon|alternatif|option|options|choice|choices)\b/i
    const verb = /\b(?:işte|buyrun|aşağıda|here\s+(?:are|is)|below\s+are)\b/i
    if (meta.test(s) && verb.test(s)) return true
    if (/^\s*(?:işte|here\s+(?:are|is)|below\s+are|aşağıda|lütfen)\b/i.test(s)) return true
    return false
  }
  const stateDescription = looksLikePreamble(rawScene) ? '' : rawScene

  const options: Array<{ label: string; summary: string }> = []
  if (firstOptIdx === -1) return { stateDescription, options }

  // Collect option sections.  Each section = one numbered header line
  // + every subsequent line up to the NEXT numbered header (or end).
  // Lines with bullet/bracket/label markers under a numbered header are
  // the prose body of that option — they get merged into summary.
  let current: { title: string; summaryLines: string[] } | null = null
  const pushCurrent = () => {
    if (!current) return
    const title = stripEmph(current.title).trim()
    const summary = current.summaryLines.map((l) => stripEmph(stripLead(l))).join(' ').replace(/\s+/g, ' ').trim()
    if (title || summary) options.push({ label: title || summary.split(/\s+/).slice(0, 3).join(' '), summary: summary || title })
    current = null
  }

  for (let i = firstOptIdx; i < lines.length; i++) {
    const line = lines[i]
    const h = headerKind(line)
    if (h) {
      pushCurrent()
      current = { title: h.tail.trim(), summaryLines: [] }
      continue
    }
    if (current && line.trim()) current.summaryLines.push(line)
  }
  pushCurrent()

  return {
    stateDescription,
    // Raw label + summary — caller decides which one is the checkpoint
    // title (full sentence) and which is the Detroit chip label (short
    // uppercase).  The parser no longer up-cases because `label` can be
    // the ONLY text on a numbered line (`1. Aang ve Sokka köye yola
    // koyulurlar...`), i.e. a full sentence — force-uppercasing that
    // kills the node ribbon.
    options: options.slice(0, 3).map((o) => ({
      label: o.label.slice(0, 200),
      summary: o.summary,
    })),
  }
}

/** Read a text/plain stream into a single string, updating the agent ticker
 *  live so the user sees the agent typing. Throttled via requestAnimationFrame
 *  so rapid token bursts don't saturate React renders. */
async function consumeStream(
  res: Response,
  agentId: string,
): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')
  const decoder = new TextDecoder()
  let acc = ''
  let pending = ''
  let raf: number | null = null
  const flush = () => {
    if (pending === acc) { raf = null; return }
    pending = acc
    useStory.getState().updateAgent(agentId, { status: 'streaming', text: acc })
    raf = null
  }
  const schedule = () => {
    if (raf !== null) return
    if (typeof requestAnimationFrame === 'undefined') {
      flush()
      return
    }
    raf = requestAnimationFrame(flush)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
      schedule()
    }
  } finally {
    if (raf !== null && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf)
    useStory.getState().updateAgent(agentId, { status: 'streaming', text: acc })
  }
  return acc
}

// ---- expand ---------------------------------------------------------------

/** Fire the brainstorm skill for a node.  By default only fires on
 *  leaves (childrenIds.length === 0).  Pass ``force: true`` (e.g. the
 *  Decision overlay's "Ask Hermes again" button) to regenerate more
 *  siblings even if the node already has children — existing children
 *  are preserved, new ones are appended, so the user never loses work
 *  they've already walked into. */
export async function expandNode(
  nodeId: string,
  branchCount = 3,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (inflightExpand.has(nodeId)) return
  inflightExpand.add(nodeId)
  const store = useStory.getState()
  const node = store.nodes.get(nodeId)
  if (!node) { inflightExpand.delete(nodeId); return }
  if (!opts.force && node.childrenIds.length > 0) { inflightExpand.delete(nodeId); return }

  const canonTitles = canonTitlesUpTo(nodeId)
  const canonBeats = canonBeatsUpTo(nodeId)
  // Multi-turn: reconstruct the full conversation from the canon path so
  // the model sees every prior pick + its reconstructed options as a real
  // chat.  For the opening call (nodeId === root), history is empty and
  // the server falls back to its stateless single-user-message form —
  // nothing to reconstruct when there are no ancestors.
  const chatHistory = buildBrainstormHistory(nodeId, store.seed)

  const ev = agentEvent(
    'brainstorm',
    `BRAINSTORM · branching "${node.title}"${chatHistory.length > 0 ? ` (turn ${chatHistory.length})` : ''}`,
  )
  store.appendAgent({ ...ev, status: 'streaming' })
  // Only lock the parent as 'generating' when it's a SHELL (no title yet
  // — the agent is filling in the node's own content).  For an
  // established beat where the user clicked Ask Hermes, the parent
  // stays exactly as it was; only the new sibling children — which
  // will appear as 'unvisited' shells with their own weaving labels —
  // need a loading state.  This was the source of the "HERMES WEAVING
  // overlay stuck on the parent after Ask Hermes" bug.
  const isShell = !node.title
  if (isShell) store.markGenerating(nodeId, true)

  try {
    const res = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'brainstorm',
        seed: store.seed,
        canonTitles,
        canonBeats,
        focusTitle: node.title,
        focusBody: node.body ?? node.summary,
        focusMood: node.mood,
        branches: branchCount,
        chatHistory,
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      store.updateAgent(ev.id, { status: 'error', text: text.slice(0, 240) })
      return
    }

    const raw = await consumeStream(res, ev.id)
    // narrative-brainstorm v6 emits free-form prose + numbered options.
    // Parse liberally — the model may use `1. LABEL — summary`, bold
    // markdown, `[Label]: dialog` brackets, bullets, or mixed shapes.
    // The parser extracts scene prose + options; we keep the RAW text
    // verbatim on the parent node so the next turn's history feeds the
    // model its own prior voice unchanged (Gemini-browser-style chat
    // continuity).
    const { stateDescription, options } = parseBrainstormText(raw)
    if (options.length === 0) {
      // Empty options is the skill's "arc resolved" signal, not a fault.
      // The brainstorm skill caps each playthrough at ~5-10 critical beats
      // and stops emitting branches past the terminal window — surfacing
      // that as ERROR misreads the dramaturgy as a failure.
      store.updateAgent(ev.id, {
        status: 'done',
        text: 'Story arc resolved — Hermes did not weave further branches from this beat.',
      })
      return
    }

    store.updateAgent(ev.id, {
      status: 'done',
      text: options.map((o) => `• ${o.label}`).join('\n'),
    })

    // Parent node carries the raw brainstorm verbatim so the next turn's
    // history stays faithful to the model's voice.  Scene prose is patched
    // onto the body ONLY when the beat is not root — the root holds the
    // user's seed as its scene, and we must never overwrite it.  Skills
    // that give a scene paragraph on the opening turn do so as a preface
    // to the seed; treating it as the beat body blurs the user's input.
    const isRoot = nodeId === store.rootId
    store.patchNodeProse(nodeId, {
      rawBrainstorm: raw,
      ...(stateDescription && !isRoot ? { body: stateDescription.slice(0, 1200) } : {}),
    })

    const prepared = options.map((o) => {
      // Checkpoint-scale mapping:
      //   o.label   → numbered header (the checkpoint TITLE sentence)
      //   o.summary → prose body under the header (the story flow)
      // Hard cap title at ~100 chars — skill says ≤80, but some
      // responses still blow past that and a 200-char title would
      // overflow the node ribbon and read as "the whole story".  Body
      // (summary) stays long — that's where the narrative sits.
      const rawTitle = o.label.slice(0, 400) || (o.summary.split(/[.!?]/)[0] ?? '').trim()
      // Trim to last full-word boundary within 100 chars so we don't
      // cut mid-word.  If the sentence exceeds 100, replace the cut
      // with "…" so the user sees it's truncated rather than a jagged
      // line clamp.
      const title = rawTitle.length <= 100
        ? rawTitle
        : rawTitle.slice(0, 100).replace(/\s+\S*$/, '') + '…'
      const summary = o.summary.slice(0, 600)
      const label = title.split(/\s+/).slice(0, 3).join(' ').slice(0, 32).toLocaleUpperCase('tr-TR')
      const prompt = summary || title || node.imagePrompt
      return {
        title,
        label,
        summary,
        body: summary,
        imagePrompt: prompt,
        imageUrl: imageUrl({ prompt, seed: seedFromString(prompt) }),
        mood: 'neutral' as const,
        tone: 'divergent' as const,
      }
    })
    store.addBranches(nodeId, prepared, 'agent', 'hermes-brainstorm')

    // Fire real image generation in the background for new children.  We
    // batch all N beats through the visual-prompt-builder skill in ONE
    // call (Haiku, not Sonnet) instead of N parallel calls — the 5KB skill
    // body is billed once rather than N times.  Per-beat image-gen still
    // runs in parallel since those are free on the Nous Portal image tier.
    const parent = useStory.getState().nodes.get(nodeId)
    const newChildIds = parent?.childrenIds ?? []
    void batchGenerateImagesForChildren(newChildIds, nodeId)
  } catch (err) {
    if (isAbortError(err)) return
    const message = err instanceof Error ? err.message :'unknown error'
    store.updateAgent(ev.id, { status: 'error', text: message })
  } finally {
    if (isShell) store.markGenerating(nodeId, false)
    inflightExpand.delete(nodeId)
  }
}

// ---- batch image pipeline (brainstorm children) --------------------------

/** Build N visual prompts for N new sibling beats in a single Haiku call,
 *  then fire N image-gens in parallel.  Saves ~60% of the per-Enter
 *  Claude spend vs. calling visual-prompt-builder once per child.
 *
 *  Each child's image-prompt is still subject to the character registry
 *  + moderation pipeline on the server.  The N image-gen calls inherit
 *  the story's imagePolicy (FLUX / Gemini route) and pass matching
 *  characterRefs as multi-modal references. */
async function batchGenerateImagesForChildren(
  childIds: string[],
  _parentNodeId: string,
): Promise<void> {
  if (childIds.length === 0) return
  const store = useStory.getState()
  const children = childIds
    .map((cid) => store.nodes.get(cid))
    .filter((n): n is NonNullable<typeof n> => !!n && !!n.imagePrompt)
  if (children.length === 0) return

  const seed = store.seed
  // Canon context — use any child's parent chain (they all share one).
  const first = children[0]
  const canonBeats = first ? canonBeatsForImage(first.id) : []

  let batchRes: Response
  try {
    const batchPolicy = store.imagePolicy
    batchRes = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'image-prompt-batch',
        beats: children.map((c) => ({ title: c.title, body: c.body ?? c.summary ?? '' })),
        seed,
        canonBeats,
        characters: store.characters,
        franchise: batchPolicy.franchise,
        allow_ip_names: true,
      }),
    })
  } catch {
    return
  }
  if (!batchRes.ok) return
  const data = (await batchRes.json()) as {
    prompts?: { storyRegister?: string; prompt?: string; characters_seen?: { source_name: string; visual_description: string }[] }[]
    events?: ToolEvent[]
  }
  emitToolEvents(data.events)
  const prompts = data.prompts ?? []

  // Merge characters_seen from every beat into the registry.
  const entries: Record<string, string> = {}
  for (const p of prompts) {
    for (const c of p.characters_seen ?? []) {
      if (c?.source_name && c?.visual_description) entries[c.source_name] = c.visual_description
    }
  }
  if (Object.keys(entries).length > 0) useStory.getState().mergeCharacters(entries)

  const policy = useStory.getState().imagePolicy
  const refs = useStory.getState().characterRefs

  // All brainstormed siblings share the same parent → one prior-scene
  // ref + one continuity hint computed once for the whole batch.
  const sharedPriorUrl = first ? priorCanonImageUrl(first.id) : null

  // Fire per-child image-gen in parallel.  Free on Nous Portal image tier.
  await Promise.all(
    children.map(async (child, idx) => {
      const p = prompts[idx]
      const richPrompt = p?.prompt
      if (!richPrompt) return
      // Persist so the next-turn continuity hint references what the
      // frame actually depicts, not just the short beat label.
      useStory.getState().patchNodeProse(child.id, { renderedImagePrompt: richPrompt })
      const referenceUrls: string[] = []
      const referenceNames: string[] = []
      if (sharedPriorUrl) {
        referenceUrls.push(sharedPriorUrl)
        referenceNames.push('prior_scene')
      }
      for (const c of p?.characters_seen ?? []) {
        // Alias-tolerant lookup via the character-registry-lookup tool —
        // visual-prompt-builder routinely drifts between canonical
        // ("Light") and full ("Light Yagami") name forms; without
        // resolution the portrait ref silently fails to attach and
        // image-gen redraws the character from scratch.
        const canonical = resolveCharacterAlias(refs, c.source_name)
        if (canonical) {
          const url = refs[canonical]
          if (url && !referenceUrls.includes(url)) {
            referenceUrls.push(url)
            referenceNames.push(canonical)
          }
        }
      }
      // Delta prompting: prior_scene ref carries the image itself; no
      // text dump of the prior scene (was producing duplicate chars).
      const promptWithHint = richPrompt
      try {
        const gen = await fetch('/api/hermes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
          body: JSON.stringify({
            kind: 'image-gen',
            prompt: promptWithHint,
            style: 'cinematic',
            aspect: '16:9',
            modelPreference: policy.model_preference,
            referenceUrls,
            referenceNames,
            skipCache: true,
          }),
        })
        if (!gen.ok) {
          try {
            const errData = (await gen.json()) as { events?: ToolEvent[] }
            emitToolEvents(errData.events)
          } catch { /* ignore */ }
          return
        }
        const genData = (await gen.json()) as { url?: string; events?: ToolEvent[] }
        emitToolEvents(genData.events)
        if (genData.url) useStory.getState().setNodeImage(child.id, genData.url)
      } catch { /* swallow — placeholder stays */ }
    }),
  )
}

// ---- image generation (Nano Banana via /api/hermes image-gen) -------------

const inflightImageGen = new Set<string>()

/** Kick off image generation for a node as a two-stage pipeline:
 *    (1) image-prompt-build → visual-prompt-builder skill rewrites the beat
 *        into a rich IP-free photoreal description and extracts any new
 *        character descriptions.  Uses + merges the persisted character
 *        registry so every "Hannah" gets the same freckles across scenes.
 *    (2) image-gen → FLUX / SeeDream / Nano Banana fallback chain renders
 *        the sanitized prompt and saves to public/cache/images/.
 *  Skip if the node already points at a cache file or a request is in-flight. */
export async function generateNodeImage(nodeId: string, _prompt: string): Promise<void> {
  if (inflightImageGen.has(nodeId)) return
  const store = useStory.getState()
  const node = store.nodes.get(nodeId)
  if (!node) return
  if (node.imageUrl && node.imageUrl.startsWith('/cache/images/')) return  // already cached
  inflightImageGen.add(nodeId)
  try {
    // Stage 1 — sanitize into rich visual description.  Response is a
    // JSON envelope: { storyRegister, prompt, characters_seen, events[] }
    // where events[] surfaces registry hits for the UI ticker.
    const canonBeats = canonBeatsForImage(nodeId)
    const policy = store.imagePolicy
    const sanRes = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'image-prompt-build',
        title: node.title,
        body: node.body ?? node.summary ?? '',
        seed: store.seed,
        canonBeats,
        characters: store.characters,
        franchise: policy.franchise,
        // Always try named prompts first.  If the image model refuses,
        // route.ts's moderation_rewriter strips IP tokens and retries.
        // This avoids proactively sanitising prompts the model would
        // have happily accepted (Gemini usually does; even FLUX often
        // does for animated franchises).
        allow_ip_names: true,
      }),
    })
    if (!sanRes.ok) return
    let sanitized: {
      storyRegister?: string
      prompt?: string
      characters_seen?: { source_name: string; visual_description: string }[]
      events?: ToolEvent[]
    }
    try {
      sanitized = await sanRes.json() as typeof sanitized
    } catch {
      return
    }
    // Hydrate registry-lookup events immediately so the viewer sees the
    // tool fire before the skill reasoning does.
    emitToolEvents(sanitized.events)

    const richPrompt = sanitized.prompt
    if (!richPrompt) return
    // Persist the rich prompt on the node so the NEXT beat's image-gen
    // can feed it as an explicit continuity hint ("PREVIOUS FRAME
    // showed: <rich prompt>").  Without this the hint falls back to the
    // beat's short label ("Aang'e seslenmeye çalış") which doesn't tell
    // the image model anything about what the frame visually depicts.
    store.patchNodeProse(nodeId, { renderedImagePrompt: richPrompt })

    // Merge any new character descriptions back into the persisted registry
    // so the next beat that mentions the same character reuses it verbatim.
    const seen = sanitized.characters_seen ?? []
    if (seen.length > 0) {
      const entries: Record<string, string> = {}
      for (const c of seen) {
        if (c.source_name && c.visual_description) entries[c.source_name] = c.visual_description
      }
      if (Object.keys(entries).length > 0) store.mergeCharacters(entries)
    }

    // Stage 2 — render the sanitized prompt.  Envelope: { url, cached,
    // model, events[] } where events[] logs every moderation rewrite
    // the server applied on refuse.  Route branches on modelPreference:
    // FLUX+moderation ladder for IP-heavy seeds, Nano Banana direct for
    // original/inspired seeds (faster, stylised, filter-safe).
    //
    // Character refs: for every character_seen in the beat, look up a
    // portrait URL in store.characterRefs and pass it to image-gen.
    // Multi-modal-capable models (Nano Banana / SeeDream) condition the
    // render on those reference frames — characters stay visually
    // consistent across scenes.  FLUX ignores refs silently.
    const allRefs = useStory.getState().characterRefs
    const referenceUrls: string[] = []
    const referenceNames: string[] = []
    // Prepend the prior canon beat's rendered frame (if any) so Gemini
    // composes the new shot as a continuation — broken ice stays broken,
    // freed characters stay out, fires stay lit.  Scene ref goes FIRST
    // so it anchors the model's attention on the world state before the
    // per-character portrait refs lock identity.
    const priorSceneUrl = priorCanonImageUrl(nodeId)
    if (priorSceneUrl) {
      referenceUrls.push(priorSceneUrl)
      referenceNames.push('prior_scene')
    }
    for (const c of seen) {
      const ref = allRefs[c.source_name]
      if (ref && !referenceUrls.includes(ref)) {
        referenceUrls.push(ref)
        referenceNames.push(c.source_name)
      }
    }
    // Delta prompting: prior scene image is attached as a multimodal
    // ref; no text dump of it here (was producing duplicate characters).
    const promptWithHint = richPrompt
    const genRes = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'image-gen',
        prompt: promptWithHint,
        style: 'cinematic',
        aspect: '16:9',
        modelPreference: policy.model_preference,
        referenceUrls,
        referenceNames,
        skipCache: true,
      }),
    })
    let data: { url?: string; cached?: boolean; events?: ToolEvent[] } = {}
    if (genRes.ok) {
      data = (await genRes.json()) as typeof data
      emitToolEvents(data.events)
    } else {
      // Gemini refused the render (content policy, safety filter, or
      // similar).  Without a retry the node stays on the pollinations
      // placeholder forever, reading as "HERMES IMAGINING…" to the user
      // even though the pipeline has given up.  Try ONCE more through a
      // full re-run of the prompt builder (temperature 0.6 means the
      // new prompt often differs enough to slip past the filter) and a
      // fresh image-gen call.  If the retry also refuses, we surface the
      // failure events and leave the node on placeholder — user can
      // click Ask Hermes on the parent to regenerate choices.
      try {
        const errData = await genRes.json() as { events?: ToolEvent[] }
        emitToolEvents(errData.events)
      } catch { /* ignore */ }
      const retriedUrl = await retryImageGen(
        nodeId,
        node.title,
        node.body ?? node.summary ?? '',
        store.seed,
        canonBeats,
        store.characters,
        policy.franchise,
        policy.model_preference,
      )
      if (retriedUrl) {
        data = { url: retriedUrl }
      } else {
        return
      }
    }
    if (data?.url) useStory.getState().setNodeImage(nodeId, data.url)

    // VLM post-render check.  Sends the rendered frame to Gemini multimodal
    // with the beat's intent and asks "does this match?".  Catches the
    // literal-render class of bug the prompt builder can't catch upstream
    // (ambiguous verb in the body, model resolved it the wrong way — the
    // "Sokka harnessed as a sled dog" failure mode).  Max one retry so the
    // worst case is two image-gen calls per beat, not an infinite loop.
    if (data.url) {
      try {
        const qa = await runSceneQa(nodeId, data.url, canonBeats)
        if (qa && !qa.approved && qa.fix_hint) {
          const retriedUrl = await regenerateWithHint(
            nodeId,
            node.title,
            node.body ?? node.summary ?? '',
            store.seed,
            canonBeats,
            store.characters,
            policy.franchise,
            qa.fix_hint,
            qa.issues,
            policy.model_preference,
          )
          if (retriedUrl) useStory.getState().setNodeImage(nodeId, retriedUrl)
        }
      } catch {
        // Scene QA is a BEST-EFFORT safety net — if it breaks, we keep the
        // original render rather than blanking the node.
      }
    }
  } catch {
    // swallow — placeholder pollinations URL stays; user can retry later
  } finally {
    inflightImageGen.delete(nodeId)
  }
}

interface SceneQaVerdict {
  approved: boolean
  score: number
  issues: string
  fix_hint: string
}

async function runSceneQa(
  nodeId: string,
  imageUrl: string,
  canonBeats: { title: string; body: string; imagePrompt?: string }[],
): Promise<SceneQaVerdict | null> {
  const store = useStory.getState()
  const node = store.nodes.get(nodeId)
  if (!node) return null
  const ev = agentEvent('judge', `SCENE-QA · "${node.title.slice(0, 40)}"`)
  store.appendAgent({ ...ev, status: 'streaming' })
  try {
    const res = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'scene-qa',
        imageUrl,
        nodeTitle: node.title,
        nodeBody: node.body ?? node.summary ?? '',
        canonContext: canonBeats.slice(-3), // last few beats are enough for state carry check
      }),
    })
    if (!res.ok) {
      store.updateAgent(ev.id, { status: 'done', text: 'skipped · http error' })
      return null
    }
    const raw = await res.text()
    let verdict: SceneQaVerdict
    try {
      verdict = parseJsonSafe(raw) as SceneQaVerdict
    } catch {
      // Gemini occasionally replies with conversational text instead of
      // the JSON verdict ("Please provide the image…") when the multimodal
      // attachment flakes out.  One silent retry, then give up — QA is a
      // safety net, not a blocker, so a skipped verdict is acceptable and
      // shouldn't surface a scary red error to the viewer.
      const retry = await fetch('/api/hermes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: requestControl.signal,
        body: JSON.stringify({
          kind: 'scene-qa',
          imageUrl,
          nodeTitle: node.title,
          nodeBody: node.body ?? node.summary ?? '',
          canonContext: canonBeats.slice(-3),
        }),
      })
      if (!retry.ok) {
        store.updateAgent(ev.id, { status: 'done', text: 'skipped · non-json reply' })
        return null
      }
      try {
        verdict = parseJsonSafe(await retry.text()) as SceneQaVerdict
      } catch {
        store.updateAgent(ev.id, { status: 'done', text: 'skipped · non-json reply' })
        return null
      }
    }
    store.updateAgent(ev.id, {
      status: 'done',
      text: verdict.approved
        ? `APPROVED · ${verdict.score.toFixed(2)}`
        : `REJECTED · ${verdict.score.toFixed(2)} · ${verdict.issues.slice(0, 80)}`,
    })
    return verdict
  } catch (err) {
    store.updateAgent(ev.id, { status: 'done', text: `skipped · ${(err as Error).message.slice(0, 60)}` })
    return null
  }
}

/** Second pass through image-prompt-build + image-gen when the FIRST
 *  pass was refused outright by the image model (HTTP 502 from /api/
 *  hermes, usually IMAGE_PROHIBITED_CONTENT from Gemini's safety layer).
 *  We re-run visual-prompt-builder fresh — its temperature 0.6 means
 *  the new prompt is likely to differ enough from the first to slip
 *  past the filter that tripped on the exact token pattern.  Hard cap
 *  at ONE retry; no scene-qa on the retry (keep the failure ladder
 *  short, infinite-loop-proof). */
async function retryImageGen(
  nodeId: string,
  title: string,
  body: string,
  seed: string,
  canonBeats: { title: string; body: string; imagePrompt?: string }[],
  characters: Record<string, string>,
  franchise: string | null,
  modelPreference: string,
): Promise<string | null> {
  const store = useStory.getState()
  const ev = agentEvent('writer', `IMAGE RETRY · "${title.slice(0, 40)}"`)
  store.appendAgent({ ...ev, status: 'streaming' })
  try {
    const sanRes = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'image-prompt-build',
        title,
        body,
        seed,
        canonBeats,
        characters,
        franchise,
        allow_ip_names: true,
      }),
    })
    if (!sanRes.ok) {
      store.updateAgent(ev.id, { status: 'error', text: 'retry prompt http error' })
      return null
    }
    const sanitized = await sanRes.json() as {
      prompt?: string
      characters_seen?: { source_name: string; visual_description: string }[]
    }
    const richPrompt = sanitized.prompt
    if (!richPrompt) {
      store.updateAgent(ev.id, { status: 'error', text: 'empty retry prompt' })
      return null
    }
    const refs = useStory.getState().characterRefs
    const referenceUrls: string[] = []
    const referenceNames: string[] = []
    const priorSceneUrl = priorCanonImageUrl(nodeId)
    if (priorSceneUrl) {
      referenceUrls.push(priorSceneUrl)
      referenceNames.push('prior_scene')
    }
    for (const c of sanitized.characters_seen ?? []) {
      const ref = refs[c.source_name]
      if (ref && !referenceUrls.includes(ref)) {
        referenceUrls.push(ref)
        referenceNames.push(c.source_name)
      }
    }
    // Delta prompting: the prior scene IMAGE already travels as a
    // multimodal ref (prior_scene).  Dumping its rich text description
    // into the new prompt caused duplicate-character renders ("one
    // Sokka watching + one Sokka in the new action").  Trust the ref.
    const promptWithHint = richPrompt
    const genRes = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'image-gen',
        prompt: promptWithHint,
        style: 'cinematic',
        aspect: '16:9',
        modelPreference,
        referenceUrls,
        referenceNames,
        skipCache: true,
      }),
    })
    if (!genRes.ok) {
      store.updateAgent(ev.id, { status: 'error', text: 'retry render refused' })
      return null
    }
    const data = await genRes.json() as { url?: string }
    store.updateAgent(ev.id, {
      status: 'done',
      text: data.url ? '→ retry rendered' : 'no-op',
    })
    return data.url ?? null
  } catch (err) {
    store.updateAgent(ev.id, { status: 'error', text: (err as Error).message })
    return null
  } finally {
    void nodeId
  }
}

async function regenerateWithHint(
  nodeId: string,
  title: string,
  body: string,
  seed: string,
  canonBeats: { title: string; body: string; imagePrompt?: string }[],
  characters: Record<string, string>,
  franchise: string | null,
  fixHint: string,
  issues: string,
  modelPreference: string,
): Promise<string | null> {
  const store = useStory.getState()
  // Rebuild the prompt — we re-run visual-prompt-builder with the body
  // AUGMENTED by the QA fix_hint so the next prompt addresses the specific
  // visual failure.  Simpler than deserialising and patching the prior
  // prompt: let the skill rewrite with fresh context + the correction.
  const augmentedBody = `${body}\n\n[QA correction, must be reflected visually: ${fixHint}. Previous render failed because: ${issues}]`
  const ev = agentEvent('writer', `SCENE-QA REGEN · "${title.slice(0, 40)}"`)
  store.appendAgent({ ...ev, status: 'streaming' })
  try {
    const sanRes = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'image-prompt-build',
        title,
        body: augmentedBody,
        seed,
        canonBeats,
        characters,
        franchise,
        allow_ip_names: true,
      }),
    })
    if (!sanRes.ok) {
      store.updateAgent(ev.id, { status: 'error', text: 'regen prompt http error' })
      return null
    }
    const sanitized = await sanRes.json() as {
      prompt?: string
      characters_seen?: { source_name: string; visual_description: string }[]
    }
    const richPrompt = sanitized.prompt
    if (!richPrompt) {
      store.updateAgent(ev.id, { status: 'error', text: 'empty regen prompt' })
      return null
    }
    const refs = useStory.getState().characterRefs
    const referenceUrls: string[] = []
    const referenceNames: string[] = []
    const priorSceneUrl = priorCanonImageUrl(nodeId)
    if (priorSceneUrl) {
      referenceUrls.push(priorSceneUrl)
      referenceNames.push('prior_scene')
    }
    for (const c of sanitized.characters_seen ?? []) {
      const ref = refs[c.source_name]
      if (ref && !referenceUrls.includes(ref)) {
        referenceUrls.push(ref)
        referenceNames.push(c.source_name)
      }
    }
    // Delta prompting: the prior scene IMAGE already travels as a
    // multimodal ref (prior_scene).  Dumping its rich text description
    // into the new prompt caused duplicate-character renders ("one
    // Sokka watching + one Sokka in the new action").  Trust the ref.
    const promptWithHint = richPrompt
    const genRes = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'image-gen',
        prompt: promptWithHint,
        style: 'cinematic',
        aspect: '16:9',
        modelPreference,
        referenceUrls,
        referenceNames,
        skipCache: true,
      }),
    })
    if (!genRes.ok) {
      store.updateAgent(ev.id, { status: 'error', text: 'regen render http error' })
      return null
    }
    const data = await genRes.json() as { url?: string }
    store.updateAgent(ev.id, {
      status: 'done',
      text: data.url ? `→ rerendered` : 'no-op',
    })
    return data.url ?? null
  } catch (err) {
    store.updateAgent(ev.id, { status: 'error', text: (err as Error).message })
    return null
  } finally {
    // Suppress unused-var lint for nodeId — kept in signature for future tracing
    void nodeId
  }
}

/** Slim canon spine suitable for visual-prompt-builder — {title, body} pairs
 *  from root up to the parent of the target node. */
/** Resolve the prior-canon beat's rendered image URL, if any, so we can
 *  pass it as a scene reference to the next image render.  Single-frame
 *  chain: beat N references beat N-1, N-1 already referenced N-2, so the
 *  state (broken ice, freed character, altered room) propagates forward
 *  naturally without dumping the whole history into every prompt.
 *  Returns null when the parent has no cached image yet (e.g. the render
 *  is still in flight, or this is the root) — caller falls back to
 *  character-only refs and lets the text prompt carry the setting. */
function priorCanonImageUrl(nodeId: string): string | null {
  const s = useStory.getState()
  const node = s.nodes.get(nodeId)
  if (!node?.parentId) return null
  const parent = s.nodes.get(node.parentId)
  if (!parent?.imageUrl?.startsWith('/cache/images/')) return null
  return parent.imageUrl
}


function canonBeatsForImage(nodeId: string): { title: string; body: string }[] {
  const s = useStory.getState()
  const out: { title: string; body: string }[] = []
  let cursor: string | null = s.rootId
  while (cursor && cursor !== nodeId) {
    const n = s.nodes.get(cursor)
    if (!n) break
    // Title + body only.  Previously we also shipped the parent's rendered
    // imagePrompt — that leaked the prior frame's full composition into
    // visual-prompt-builder and produced duplicate-character renders
    // (skill was inheriting positions from a prior frame AND adding the
    // new action → 2 of the same character).  The prior image ref (as a
    // multi-modal attachment) carries the visible state forward; the
    // skill doesn't need a text dump on top.
    out.push({
      title: n.title,
      body: n.body ?? n.summary ?? '',
    })
    const next =
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'current') ??
      n.childrenIds.find((id) => s.nodes.get(id)?.status === 'canon') ??
      null
    cursor = next
  }
  return out
}

// ---- writer (final story) -------------------------------------------------

let writerController: AbortController | null = null

export async function writeFinalStory(): Promise<void> {
  if (writerController) writerController.abort()
  const ctrl = new AbortController()
  writerController = ctrl

  const store = useStory.getState()
  const scenes = canonScenes()

  const ev = agentEvent('writer', 'WRITER · sealing the canon')
  store.appendAgent({ ...ev, status: 'streaming' })

  try {
    const res = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Writer has its own per-call AbortController (so a second Write
      // click cancels the first mid-stream) AND the global
      // requestControl signal (so landing / load / reset wipe it too).
      signal: AbortSignal.any([ctrl.signal, requestControl.signal]),
      body: JSON.stringify({ kind: 'writer', seed: store.seed, canonScenes: scenes }),
    })
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => res.statusText)
      store.updateAgent(ev.id, { status: 'error', text: t.slice(0, 240) })
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let acc = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
      store.updateAgent(ev.id, { text: acc })
    }
    store.updateAgent(ev.id, { status: 'done', text: acc })
    store.addDecision({
      action: 'seal',
      targetNodeId: store.currentId,
      decidedBy: 'agent',
      agentName: 'hermes-writer',
      reason: 'Sealed the canon into prose',
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    if (isAbortError(err)) return
    const message = err instanceof Error ? err.message :'writer error'
    store.updateAgent(ev.id, { status: 'error', text: message })
  }
}

// ---- writer-assist (fleshes user intent) ----------------------------------

export async function writerAssist(args: {
  parentId: string
  childId: string
  intent: string
  mode: 'canon' | 'what-if'
}): Promise<BranchSuggestion | null> {
  const key = `${args.parentId}→${args.childId}`
  if (inflightAssist.has(key)) return null
  inflightAssist.add(key)

  const store = useStory.getState()
  const parent = store.nodes.get(args.parentId)
  const child = store.nodes.get(args.childId)
  if (!parent || !child) { inflightAssist.delete(key); return null }

  const ev = agentEvent('writer-assist', `WRITER-ASSIST · "${args.intent.slice(0, 40)}…"`)
  store.appendAgent(ev)

  try {
    const res = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({
        kind: 'writer-assist',
        seed: store.seed,
        canonTitles: canonTitlesUpTo(args.parentId),
        parentTitle: parent.title,
        childTitle: child.title,
        intent: args.intent,
        mode: args.mode,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      store.updateAgent(ev.id, { status: 'error', text: text.slice(0, 240) })
      return null
    }
    // /api/hermes now streams the skill output as text/plain regardless of
    // the eventual JSON shape — consume the full stream then parse.
    const raw = await consumeStream(res, ev.id)
    const data = parseJsonSafe(raw) as WriterAssistResponse
    store.updateAgent(ev.id, { status: 'done', text: `→ ${data.title}` })
    return {
      // Checkpoint-scale: title is a full sentence (200 char cap), not
      // a 3-word label.  Store-side will derive the short chip label
      // from the first words.
      title: (data.title ?? 'UNTITLED').slice(0, 200),
      summary: (data.summary ?? '').slice(0, 400),
      body: (data.body ?? '').slice(0, 900),
      imagePrompt: data.imagePrompt ?? data.summary ?? '',
      mood: validateMood(data.mood),
      tone: validateTone(data.tone),
      worldPercent:
        typeof data.worldPercent === 'number' ? Math.max(1, Math.min(99, Math.round(data.worldPercent))) : undefined,
    }
  } catch (err) {
    if (isAbortError(err)) return null
    const message = err instanceof Error ? err.message : 'writer-assist error'
    store.updateAgent(ev.id, { status: 'error', text: message })
    return null
  } finally {
    inflightAssist.delete(key)
  }
}

// ---- reharmonize pipeline -------------------------------------------------

interface ReharmonizeOpts {
  insertedNodeId: string
  maxRounds?: number
  judgeThreshold?: number
}

/** Orchestrated Critic → Rewriter → Judge across downstream stale nodes. */
export async function reharmonize({
  insertedNodeId,
  maxRounds = 2,
  judgeThreshold = 0.6,
}: ReharmonizeOpts): Promise<void> {
  if (inflightReharmonize.has(insertedNodeId)) return
  inflightReharmonize.add(insertedNodeId)

  const startState = useStory.getState()
  const inserted = startState.nodes.get(insertedNodeId)
  if (!inserted) { inflightReharmonize.delete(insertedNodeId); return }

  // Collect downstream canon nodes that are currently stale
  const stale: string[] = []
  let cursor: string | null = insertedNodeId
  // move past the inserted node
  const insertedChildren = inserted.childrenIds
  if (insertedChildren.length > 0) cursor = insertedChildren[0]
  while (cursor) {
    const n = startState.nodes.get(cursor)
    if (!n) break
    if (n.staleState === 'stale') stale.push(n.id)
    // Mirrors store.ts collectCanonDescendants — follow the canon chain
    // through author-intent-canon inserts even when status was relayout-
    // demoted to 'visited' (happens when the insert sits below currentId).
    const next =
      n.childrenIds.find((id) => {
        const c = startState.nodes.get(id)
        return c?.status === 'current' || c?.status === 'canon' || c?.staleState === 'stale'
      }) ??
      n.childrenIds.find((id) => {
        const c = startState.nodes.get(id)
        return c?.inserted === true && c?.tone === 'canon'
      }) ??
      null
    cursor = next
  }

  const directorEv = agentEvent('director', `DIRECTOR · reharmonizing ${stale.length} node(s)`)
  startState.appendAgent(directorEv)

  const insertTitle = inserted.title
  const insertBody = inserted.body ?? inserted.summary

  for (let round = 1; round <= maxRounds; round += 1) {
    let resolvedInRound = 0
    // Rolling context — accumulates as we walk downstream.  Each entry
    // is the CURRENT live state of a previously-visited node (rewritten
    // when the judge approved, original when still_valid or rejected).
    // critic / rewriter / judge all receive this chain so when we reach
    // node 5 the agents already know what 4 looks like *now*.
    const recentChain: { title: string; body: string }[] = []

    for (const nodeId of stale) {
      const state = useStory.getState()
      const node = state.nodes.get(nodeId)
      if (!node) continue
      // Skip if no longer stale
      if (node.staleState !== 'stale' && node.staleState !== 'unresolved') continue

      const critiqueEv = agentEvent('consistency-critic', `CRITIC · "${node.title}"`)
      state.appendAgent(critiqueEv)

      let critique: CritiqueResponse
      try {
        const res = await fetch('/api/hermes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
          body: JSON.stringify({
            kind: 'critic',
            insertTitle, insertBody,
            nodeTitle: node.title,
            nodeBody: node.body ?? node.summary,
            recentChain,
          }),
        })
        if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
        const raw = await consumeStream(res, critiqueEv.id)
        critique = parseJsonSafe(raw) as CritiqueResponse
      } catch (err) {
        state.updateAgent(critiqueEv.id, { status: 'error', text: (err as Error).message })
        continue
      }

      state.updateAgent(critiqueEv.id, {
        status: 'done',
        text: `${critique.verdict.toUpperCase()} · ${critique.reason}`,
      })
      state.addDecision({
        action: 'critique',
        targetNodeId: nodeId,
        decidedBy: 'agent',
        agentName: 'hermes-consistency-critic',
        reason: critique.reason,
        score: critique.severity,
      })

      if (critique.verdict === 'still_valid') {
        state.keepStale(nodeId)
        resolvedInRound += 1
        // Valid-as-is node still contributes its ORIGINAL content to the
        // chain — downstream agents need to see it to reason against it.
        recentChain.push({ title: node.title, body: node.body ?? node.summary ?? '' })
        continue
      }

      // Hard-contradiction path: critic says the insert makes this beat
      // impossible (must_delete + high severity) AND this is the direct
      // child of the insert we just spliced in.  Rewriting a contradiction
      // this deep produces bolted-on half-fits ("Aang wearies" → "ICE CRACKS
      // AROUND HIM" passively — user saw this and called it out).  Instead:
      // demote this beat to a what-if alternative (it was never taken in
      // the new canon) and fire a fresh brainstorm on the INSERT so the
      // canon picks up from something organic.  Downstream of the demoted
      // beat stays attached — it's now an abandoned timeline, not a canon
      // path the rewriter has to prop up.
      const isDirectChildOfInsert = insertedChildren.includes(nodeId)
      if (
        critique.verdict === 'must_delete' &&
        critique.severity >= 0.85 &&
        isDirectChildOfInsert
      ) {
        state.detachFromCanon(nodeId)
        const regenEv = agentEvent('director', `DIRECTOR · regenerate from "${inserted.title}"`)
        state.appendAgent(regenEv)
        try {
          await expandNode(insertedNodeId, 3, { force: true })
          state.updateAgent(regenEv.id, {
            status: 'done',
            text: `Fresh options branched from the insert; old canon demoted to what-if`,
          })
        } catch (err) {
          state.updateAgent(regenEv.id, {
            status: 'error',
            text: (err as Error).message,
          })
        }
        resolvedInRound += 1
        // Stop the cascade here — nodes beneath this one were downstream of
        // the demoted beat, not downstream of the new canon.  They stay as
        // a what-if subtree and don't need canon adaptation.
        break
      }

      // needs_rewrite or must_delete (softer severity) — rewrite path.
      const rewriteEv = agentEvent('writer', `REWRITER · "${node.title}"`)
      state.appendAgent(rewriteEv)

      let rewrite: RewriteResponse
      try {
        const res = await fetch('/api/hermes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
          body: JSON.stringify({
            kind: 'rewrite',
            insertTitle, insertBody,
            nodeTitle: node.title,
            nodeBody: node.body ?? node.summary,
            criticReason: critique.reason,
            recentChain,
          }),
        })
        if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
        const raw = await consumeStream(res, rewriteEv.id)
        rewrite = parseJsonSafe(raw) as RewriteResponse
      } catch (err) {
        state.updateAgent(rewriteEv.id, { status: 'error', text: (err as Error).message })
        continue
      }

      state.updateAgent(rewriteEv.id, {
        status: 'done',
        text: `→ ${rewrite.title}`,
      })

      const judgeEv = agentEvent('judge', `JUDGE · "${rewrite.title}"`)
      state.appendAgent(judgeEv)

      let judgeResult: JudgeResponse
      try {
        const res = await fetch('/api/hermes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
          body: JSON.stringify({
            kind: 'judge',
            insertTitle, insertBody,
            originalTitle: node.title,
            originalBody: node.body ?? node.summary,
            rewrittenTitle: rewrite.title,
            rewrittenBody: rewrite.body,
            recentChain,
          }),
        })
        if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
        const raw = await consumeStream(res, judgeEv.id)
        judgeResult = parseJsonSafe(raw) as JudgeResponse
      } catch (err) {
        state.updateAgent(judgeEv.id, { status: 'error', text: (err as Error).message })
        continue
      }

      state.updateAgent(judgeEv.id, {
        status: 'done',
        text: `${judgeResult.approved ? 'APPROVED' : 'REJECTED'} · ${judgeResult.score.toFixed(2)} · ${judgeResult.reason}`,
      })
      state.addDecision({
        action: 'judge',
        targetNodeId: nodeId,
        decidedBy: 'agent',
        agentName: 'hermes-judge',
        reason: judgeResult.reason,
        score: judgeResult.score,
      })

      if (judgeResult.approved && judgeResult.score >= judgeThreshold) {
        state.applyRewrite(
          nodeId,
          {
            title: rewrite.title.toUpperCase().slice(0, 64),
            summary: rewrite.summary.slice(0, 200),
            body: rewrite.body.slice(0, 700),
            imagePrompt: rewrite.imagePrompt,
            mood: validateMood(rewrite.mood),
          },
          'hermes-rewriter',
          rewrite.reason,
        )
        // applyRewrite replaces the cached imageUrl with a deterministic
        // placeholder; the REAL stylised/photoreal render only happens when
        // we invoke the image pipeline here.  Otherwise the card sits on
        // "HERMES IMAGINING…" forever with no request ever firing.
        if (rewrite.imagePrompt) {
          void generateNodeImage(nodeId, rewrite.imagePrompt)
        }
        resolvedInRound += 1
        // Chain carries the REWRITTEN version forward — downstream
        // agents reason against the new state, not the stale one.
        recentChain.push({ title: rewrite.title, body: rewrite.body })
      } else {
        // Rejected — original text stays live.  Downstream agents need
        // to see what actually survived, so push the original content.
        recentChain.push({ title: node.title, body: node.body ?? node.summary ?? '' })
        if (round === maxRounds) {
          // Last round and still rejected — mark unresolved for human decision.
          state.markUnresolved(nodeId)
        }
      }
    }

    // Stop early if nothing left stale
    const remaining = useStory.getState()
    const anyStale = stale.some((id) => remaining.nodes.get(id)?.staleState === 'stale')
    if (!anyStale) break
    if (resolvedInRound === 0) break // no progress — give up
  }

  // Final sweep: any still stale → mark unresolved
  const final = useStory.getState()
  stale.forEach((id) => {
    const n = final.nodes.get(id)
    if (n && n.staleState === 'stale') final.markUnresolved(id)
  })

  final.updateAgent(directorEv.id, {
    status: 'done',
    text: `Reharmonize complete · ${stale.length} node(s) processed`,
  })
  inflightReharmonize.delete(insertedNodeId)
}

// ---- scene composer -------------------------------------------------------

/** Hermes reads the whole tree and groups nodes into scenes and acts.
 *  Every node is assigned to exactly one scene by the agent — the composer
 *  is a dramaturge, not a clusterer. */
export async function composeScenes(): Promise<void> {
  if (inflightCompose.has('compose')) return
  inflightCompose.add('compose')

  const store = useStory.getState()

  // Use short index IDs (n0, n1, n2 …) when talking to Hermes. Long auto-
  // generated IDs like "b-m98ql7a3-1" are easy for an LLM to typo, which
  // dropped every scene at validate time. Short IDs round-trip reliably.
  const realIds: string[] = []
  store.nodes.forEach((n) => realIds.push(n.id))
  const realToShort = new Map<string, string>()
  const shortToReal = new Map<string, string>()
  realIds.forEach((id, i) => {
    const short = `n${i}`
    realToShort.set(id, short)
    shortToReal.set(short, id)
  })

  const nodePayload: {
    id: string; title: string; body: string;
    depth: number; parentId: string | null;
    mood: string; tone: string;
  }[] = []
  store.nodes.forEach((n) => {
    nodePayload.push({
      id: realToShort.get(n.id)!,
      title: n.title,
      body: (n.body ?? n.summary).slice(0, 200),
      depth: n.depth,
      parentId: n.parentId ? realToShort.get(n.parentId) ?? null : null,
      mood: n.mood,
      tone: n.tone,
    })
  })

  if (nodePayload.length === 0) {
    inflightCompose.delete('compose')
    return
  }

  const ev = agentEvent(
    'scene-composer',
    `SCENE-COMPOSER · analyzing ${nodePayload.length} nodes`,
  )
  store.appendAgent({ ...ev, status: 'streaming' })

  try {
    const res = await fetch('/api/hermes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: requestControl.signal,
      body: JSON.stringify({ kind: 'scene-compose', seed: store.seed, nodes: nodePayload }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      store.updateAgent(ev.id, { status: 'error', text: text.slice(0, 240) })
      return
    }

    const rawText = await consumeStream(res, ev.id)
    let data: SceneComposeResponse
    try {
      data = parseJsonSafe(rawText) as SceneComposeResponse
    } catch (err) {
      store.updateAgent(ev.id, { status: 'error', text: (err as Error).message })
      return
    }
    const raw = Array.isArray(data.scenes) ? data.scenes : []
    if (raw.length === 0) {
      store.updateAgent(ev.id, { status: 'error', text: 'Hermes returned no scenes.' })
      return
    }

    // Validate: short IDs round-trip reliably, but we still defensively drop
    // anything the agent hallucinated. Each real node must appear in exactly
    // one scene. Solo-node scenes are rejected (merged into an adjacent scene
    // instead) so the per-node stripe + pill UI always highlights at least a
    // small cluster — a single beat on its own isn't a "scene".
    const seen = new Set<string>()
    const cleanedRaw: Scene[] = []
    raw.forEach((s, idx) => {
      const realNodeIds: string[] = []
      for (const maybeShort of s.nodeIds ?? []) {
        const realId = shortToReal.get(maybeShort)
        if (!realId) continue
        if (seen.has(realId)) continue
        seen.add(realId)
        realNodeIds.push(realId)
      }
      if (realNodeIds.length === 0) return
      const act = s.actNumber === 1 || s.actNumber === 2 || s.actNumber === 3 ? s.actNumber : undefined
      cleanedRaw.push({
        id: `scene-${Date.now().toString(36)}-${idx}`,
        label: (s.label ?? 'UNTITLED').toUpperCase().slice(0, 40),
        motif: s.motif?.toLowerCase().slice(0, 20),
        actNumber: act,
        nodeIds: realNodeIds,
        createdAt: Date.now(),
        decidedByAgent: 'hermes-scene-composer',
      })
    })

    // Fold solo-node scenes into the nearest multi-node scene in the same act
    // (fallback: the previous cleaned scene). Agent is asked to avoid solos
    // but we enforce it here so the UI never has to render a 1-node "cluster".
    const cleaned: Scene[] = []
    const soloNodes: string[] = []
    for (const s of cleanedRaw) {
      if (s.nodeIds.length >= 2) {
        cleaned.push(s)
        continue
      }
      const solo = s.nodeIds[0]
      // Try same-act multi-node scene first
      const sameAct = cleaned.find(
        (c) => c.actNumber === s.actNumber && c.nodeIds.length >= 2,
      )
      const target = sameAct ?? cleaned[cleaned.length - 1]
      if (target) {
        target.nodeIds.push(solo)
      } else {
        // No target yet — park it; it'll be absorbed or reported as orphan
        soloNodes.push(solo)
      }
    }

    // If parked solos exist and we built at least one scene later, attach them.
    if (soloNodes.length > 0 && cleaned.length > 0) {
      cleaned[0].nodeIds.push(...soloNodes)
      soloNodes.length = 0
    }

    if (cleaned.length === 0) {
      store.updateAgent(ev.id, {
        status: 'error',
        text: `Agent returned ${raw.length} scene(s) but none had matchable node ids. Try again.`,
      })
      return
    }

    const orphanCount = realIds.filter((id) => !seen.has(id)).length

    const sceneMap = new Map<string, Scene>()
    cleaned.forEach((s) => sceneMap.set(s.id, s))
    store.setScenes(sceneMap)

    const orphanSummary = orphanCount > 0 ? ` · ${orphanCount} node(s) unassigned` : ''
    store.updateAgent(ev.id, {
      status: 'done',
      text: cleaned
        .map((s) => `• ${s.label}${s.actNumber ? ` · act ${s.actNumber}` : ''}${s.motif ? ` · ${s.motif}` : ''}`)
        .join('\n') + orphanSummary,
    })
    store.addDecision({
      action: 'compose_scenes',
      targetNodeId: store.rootId,
      decidedBy: 'agent',
      agentName: 'hermes-scene-composer',
      reason: `Grouped ${nodePayload.length - orphanCount} nodes into ${cleaned.length} scenes${orphanSummary}`,
    })
  } catch (err) {
    if (isAbortError(err)) return
    const message = err instanceof Error ? err.message :'scene-compose error'
    store.updateAgent(ev.id, { status: 'error', text: message })
  } finally {
    inflightCompose.delete('compose')
  }
}
