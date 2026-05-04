import { readFile, appendFile, writeFile, mkdir, access } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import OpenAI from 'openai'
import { buildNarrativeContext } from '@/lib/context-builder'
import { lookupCharacterRegistry } from '@/lib/character-registry-lookup'
import { detectStoryCopyright } from '@/lib/story-copyright-detector'

export const runtime = 'nodejs'

/** Request-level trace log.  Writes one JSON line per hop so a human (or an
 *  LLM co-pilot) tailing the file sees every phase of every /api/hermes
 *  call: request received → skill loaded → gateway call sent → first token
 *  → completion → parse OK (or error).  Lines are JSON so downstream tools
 *  can `jq` over them without regex gymnastics.
 *
 *  Gated on HERMES_TRACE — default on in dev, off in prod. */
const TRACE_PATH = process.env.HERMES_TRACE_PATH ?? '/tmp/noustiny-trace.log'
const TRACE_ENABLED = (process.env.HERMES_TRACE ?? '1') !== '0'

function nowIso(): string {
  return new Date().toISOString()
}

async function trace(reqId: string, phase: string, detail: Record<string, unknown> = {}): Promise<void> {
  if (!TRACE_ENABLED) return
  const line = JSON.stringify({ t: nowIso(), req: reqId, phase, ...detail }) + '\n'
  try {
    await appendFile(TRACE_PATH, line, 'utf-8')
  } catch {
    /* tracing must never break the request — swallow errors. */
  }
}

const DEFAULT_MODEL = process.env.NOUS_MODEL ?? 'Hermes-4-70B'

// Cheaper model for templated / classification skills.  ~3-4× cost
// reduction vs. Sonnet, negligible quality drop for determinate tasks
// (IP classification, character sheet templating, beat → IP-free visual
// description).  Narrative-critical skills (brainstorm, writer, rewriter,
// judge, critic) stay on DEFAULT_MODEL because they drive story quality.
const TEMPLATED_MODEL = process.env.NOUS_TEMPLATED_MODEL ?? 'anthropic/claude-haiku-4.5'

/** Hermes Agent gateway client (OpenAI-compatible, served by `hermes gateway
 *  run` on localhost:8642).  Every narrative call goes through this path so
 *  the agents run inside Hermes's agent loop with our SKILL.md bundle as
 *  the system prompt.  platform_toolsets.api_server is empty in
 *  ~/.hermes/config.yaml so the model never sees built-in tools — only the
 *  skill instructions and the user payload.
 *
 *  The NOUS_API_KEY, NOUS_BASE_URL and NOUS_MODEL env vars are consumed by
 *  Hermes via its own config.yaml.  Noustiny never talks to Nous Portal
 *  directly anymore — the agent loop does that for us. */
function hermesClient() {
  const base = process.env.HERMES_API_BASE ?? 'http://localhost:8642/v1'
  const key = process.env.HERMES_API_KEY ?? 'noustiny-dev'
  return new OpenAI({ apiKey: key, baseURL: base })
}

const SKILLS_DIR =
  process.env.HERMES_SKILLS_DIR ?? './hermes-skills-local'

// Cache skill bodies across requests.  In production a skill change is a
// deploy, so an infinite cache is correct.  In dev we also key by mtime
// so edits to SKILL.md take effect on the next request without a server
// restart — otherwise iterating on prose guidance requires killing the
// dev server every time, which is what made the last prose-tightening
// round silently serve the OLD prompt.
// Skills live under <dir>/<category>/<slug>/SKILL.md (agentskills.io).
const skillCache = new Map<string, { mtime: number; body: string }>()
async function loadSkill(category: string, slug: string): Promise<string> {
  const key = `${category}/${slug}`
  const filePath = path.join(SKILLS_DIR, category, slug, 'SKILL.md')
  const isDev = process.env.NODE_ENV !== 'production'
  if (isDev) {
    const { stat } = await import('node:fs/promises')
    const mtime = (await stat(filePath)).mtimeMs
    const cached = skillCache.get(key)
    if (cached && cached.mtime === mtime) return cached.body
    const body = await readFile(filePath, 'utf-8')
    skillCache.set(key, { mtime, body })
    return body
  }
  const cached = skillCache.get(key)
  if (cached) return cached.body
  const body = await readFile(filePath, 'utf-8')
  skillCache.set(key, { mtime: 0, body })
  return body
}

function activationPrompt(skillName: string, skillBody: string): string {
  // Mirrors agent/skill_commands.py:build_skill_invocation_message — the same
  // activation note a Telegram/CLI user would get when they type /skill-name.
  // Using the identical wording means Hermes treats our API invocation
  // exactly like a slash-command invocation elsewhere in the ecosystem.
  return (
    `[SYSTEM: The user has invoked the "${skillName}" skill, indicating ` +
    `they want you to follow its instructions. The full skill content is ` +
    `loaded below.]\n\n${skillBody}`
  )
}

type CanonBeat = { id?: string; title: string; body: string; mood?: string }

type BrainstormBody = {
  kind: 'brainstorm'
  seed: string
  canonTitles: string[]
  canonBeats?: CanonBeat[]
  focusTitle: string
  focusBody: string
  focusMood?: string
  branches?: number
  // Multi-turn conversation history reconstructed from the canon path.
  // When present, replaces the stateless single-user-message form — the
  // model sees every prior pick + its reconstructed option set as a real
  // back-and-forth conversation, same pattern as a chat UI.  Skill body
  // (system prompt) is unchanged; only the calling pattern differs.
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
}

type WriterBody = {
  kind: 'writer'
  seed: string
  canonScenes: { title: string; body: string }[]
}

type WriterAssistBody = {
  kind: 'writer-assist'
  seed: string
  canonTitles: string[]
  parentTitle: string
  childTitle: string
  intent: string
  mode: 'canon' | 'what-if'
}

/** A single entry in the rolling context chain.  The reharmonize loop
 *  walks downstream from the inserted beat and accumulates one entry
 *  per visited node — using the rewritten version when the judge
 *  approved one, otherwise the original.  Each downstream critic /
 *  rewriter / judge call receives this chain so it can reason against
 *  the *current* state of the story, not just the isolated insert. */
type RecentBeat = { title: string; body: string }

type CriticBody = {
  kind: 'critic'
  insertTitle: string
  insertBody: string
  nodeTitle: string
  nodeBody: string
  recentChain?: RecentBeat[]
}

type RewriteBody = {
  kind: 'rewrite'
  insertTitle: string
  insertBody: string
  nodeTitle: string
  nodeBody: string
  criticReason: string
  recentChain?: RecentBeat[]
}

type JudgeBody = {
  kind: 'judge'
  insertTitle: string
  insertBody: string
  originalTitle: string
  originalBody: string
  rewrittenTitle: string
  rewrittenBody: string
  recentChain?: RecentBeat[]
}

type SceneComposeBody = {
  kind: 'scene-compose'
  seed: string
  nodes: {
    id: string
    title: string
    body: string
    depth: number
    parentId: string | null
    mood: string
    tone: string
  }[]
}

type ImageGenBody = {
  kind: 'image-gen'
  prompt: string
  style?: 'cinematic' | 'illustrated' | 'photoreal'
  aspect?: '16:9' | 'square' | '9:16'
  // When present, overrides the default FLUX-first ladder.  Set by the
  // story-copyright-detector so original/inspired seeds go straight to
  // Nano Banana (faster, stylised, filter-safe because no trademark tokens).
  modelPreference?: 'flux-photoreal' | 'gemini-stylised'
  // Bypass the disk cache entirely.  Used for per-beat scene renders
  // where every beat must look unique even if two beats share a similar
  // prompt.  Character portraits (hero-portrait renders) still use the
  // cache because those are reusable reference assets by design.
  skipCache?: boolean
  // Reference portraits from the character-sheet flow.  When the model
  // supports multi-modal input (Nano Banana / SeeDream), they are passed
  // as ``image_url`` content blocks so the generator draws scenes with
  // visually consistent characters across the whole storyboard.
  referenceUrls?: string[]
  // Optional parallel array of names for each reference URL.  When
  // present, each ref is labelled in the multi-modal payload
  // ("Reference N — <Name>:") so the model binds portrait → character
  // identity correctly; without this Gemini sometimes duplicates a
  // character (two Aangs in one frame, etc.).
  referenceNames?: string[]
}

type CopyrightDetectBody = {
  kind: 'copyright-detect'
  seed: string
}

type CharacterSheetBody = {
  kind: 'character-sheet'
  seed: string
  franchise: string | null
  storyRegister: string
  allow_ip_names?: boolean
}

type ImagePromptBuildBody = {
  kind: 'image-prompt-build'
  title: string
  body: string
  seed?: string
  canonBeats?: { title: string; body: string }[]
  characters?: Record<string, string>
  franchise?: string | null
  allow_ip_names?: boolean
}

type ImagePromptBatchBody = {
  kind: 'image-prompt-batch'
  beats: { title: string; body: string }[]
  seed?: string
  canonBeats?: { title: string; body: string }[]
  characters?: Record<string, string>
  franchise?: string | null
  allow_ip_names?: boolean
}

type SceneQaBody = {
  kind: 'scene-qa'
  imageUrl: string
  nodeTitle: string
  nodeBody: string
  canonContext?: { title: string; body: string; imagePrompt?: string }[]
}

type Body = BrainstormBody | WriterBody | WriterAssistBody | CriticBody | RewriteBody | JudgeBody | SceneComposeBody | ImageGenBody | ImagePromptBuildBody | ImagePromptBatchBody | CopyrightDetectBody | CharacterSheetBody | SceneQaBody

export async function POST(req: NextRequest) {
  const reqId = randomUUID().slice(0, 8)
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    await trace(reqId, 'invalid_json')
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }

  // Summarise the payload at the trace level so tail -f readers see the
  // shape of the request without us dumping the whole body to disk.
  const summary: Record<string, unknown> = { kind: body.kind }
  if (body.kind === 'brainstorm') summary.focus = body.focusTitle?.slice(0, 80)
  if (body.kind === 'writer-assist') summary.intent = body.intent?.slice(0, 80)
  if (body.kind === 'critic') summary.node = body.nodeTitle?.slice(0, 80)
  if (body.kind === 'rewrite') summary.node = body.nodeTitle?.slice(0, 80)
  if (body.kind === 'judge') summary.rewrite = body.rewrittenTitle?.slice(0, 80)
  if (body.kind === 'scene-compose') summary.node_count = body.nodes?.length ?? 0
  if (body.kind === 'writer') summary.scene_count = body.canonScenes?.length ?? 0
  if (body.kind === 'image-gen') {
    summary.prompt = body.prompt?.slice(0, 80)
    summary.policy = body.modelPreference
  }
  if (body.kind === 'image-prompt-build') summary.title = body.title?.slice(0, 80)
  if (body.kind === 'image-prompt-batch') summary.beat_count = body.beats?.length ?? 0
  if (body.kind === 'copyright-detect') summary.seed = body.seed?.slice(0, 80)
  if (body.kind === 'character-sheet') {
    summary.seed = body.seed?.slice(0, 80)
    summary.franchise = body.franchise
  }
  if (body.kind === 'scene-qa') {
    summary.node = body.nodeTitle?.slice(0, 60)
    summary.imageUrl = body.imageUrl?.slice(-40)
  }
  await trace(reqId, 'request_received', summary)

  try {
    switch (body.kind) {
      case 'brainstorm': return await brainstorm(body, reqId)
      case 'writer':     return await writer(body, reqId)
      case 'writer-assist': return await writerAssist(body, reqId)
      case 'critic':     return await critic(body, reqId)
      case 'rewrite':    return await rewriter(body, reqId)
      case 'judge':      return await judge(body, reqId)
      case 'scene-compose': return await sceneCompose(body, reqId)
      case 'image-gen':  return await imageGen(body, reqId)
      case 'image-prompt-build': return await imagePromptBuild(body, reqId)
      case 'image-prompt-batch': return await imagePromptBatch(body, reqId)
      case 'copyright-detect': return await copyrightDetect(body, reqId)
      case 'character-sheet': return await characterSheet(body, reqId)
      case 'scene-qa': return await sceneQa(body, reqId)
      default:
        await trace(reqId, 'unknown_kind')
        return Response.json({ error: 'unknown kind' }, { status: 400 })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'hermes error'
    await trace(reqId, 'handler_error', { message })
    return Response.json({ error: message }, { status: 500 })
  }
}

/** Run a skill-backed chat completion on the Hermes gateway.  The skill body
 *  becomes the system prompt (via the same activation wrapper Hermes uses
 *  internally for slash commands) and the JSON payload becomes the user
 *  message.  Tokens are streamed through as text/plain so the existing
 *  `consumeStream` client helper works unchanged. */
async function streamViaSkill(
  category: string,
  slug: string,
  skillName: string,
  payload: unknown,
  maxTokens: number,
  temperature: number,
  reqId: string,
  options: {
    nonStreaming?: boolean
    model?: string
    // When set, REPLACES the default `[{system}, {user: payload}]` message
    // array.  Used by multi-turn skills (brainstorm) so the conversation
    // carries every prior pick + its reconstructed options, letting the
    // model track arc state implicitly instead of rebuilding context from
    // a single stateless user blob on every call.  If provided, `payload`
    // is still serialised and logged for the trace but NOT sent as a
    // user message.
    historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
    // When true, the skill body is prepended to the FIRST user message
    // instead of travelling as a system prompt.  Gemini treats system
    // prompts as strict rules and compresses rich outputs toward the
    // letter of the spec; moving the same guidance into the user role
    // makes the model read it as a "Gemini-browser style" opening
    // instruction and respond with the naturally expressive prose
    // browser chats produce.  Used by brainstorm for chat parity.
    instructionInUser?: boolean
  } = {},
): Promise<Response> {
  const t0 = Date.now()
  const cacheHit = skillCache.has(`${category}/${slug}`)
  const skillBody = await loadSkill(category, slug)
  await trace(reqId, 'skill_loaded', {
    slug,
    cache: cacheHit ? 'hit' : 'miss',
    skill_chars: skillBody.length,
  })

  const system = activationPrompt(skillName, skillBody)
  const user = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const model = options.model ?? DEFAULT_MODEL

  // instructionInUser mode: skill body ridesprepends into the FIRST user
  // message instead of a system prompt, so Gemini reads it as casual
  // guidance (the way it does in browser chat) and replies with the
  // naturally expressive prose that system-prompt mode tends to
  // compress away.  When history is empty we fall back to bare
  // skill-body + payload as the sole user message.
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
    options.instructionInUser
      ? (options.historyMessages && options.historyMessages.length > 0
          ? options.historyMessages.map((m, i) => (
              i === 0 && m.role === 'user'
                ? { ...m, content: `${skillBody}\n\n${m.content}` }
                : m
            ))
          : [{ role: 'user', content: `${skillBody}\n\n${user}` }])
      : (options.historyMessages && options.historyMessages.length > 0
          ? [{ role: 'system', content: system }, ...options.historyMessages]
          : [{ role: 'system', content: system }, { role: 'user', content: user }])

  // We log the *requested* model here; Hermes gateway may override it via
  // its own config.yaml default (resolved_model phase below reports what
  // Hermes actually used).
  const totalUserChars = messages
    .filter((m) => m.role === 'user')
    .reduce((n, m) => n + m.content.length, 0)
  const totalAssistantChars = messages
    .filter((m) => m.role === 'assistant')
    .reduce((n, m) => n + m.content.length, 0)
  await trace(reqId, 'gateway_call', {
    requested_model: model,
    system_chars: system.length,
    user_chars: totalUserChars,
    assistant_chars: totalAssistantChars,
    turn_count: messages.length - 1, // excluding system
    max_tokens: maxTokens,
    temperature,
    multi_turn: (options.historyMessages?.length ?? 0) > 0,
  })

  const openai = hermesClient()

  // Non-streaming path — used when we want Hermes to actually execute
  // registered Python tools during the agent loop.  Hermes-4's native
  // output format ships OpenAI-spec tool_calls correctly only when the
  // Nous LLM call is non-streaming; in streaming mode tool_calls land in
  // ``content`` as XML that Hermes's agent loop doesn't parse back.  So
  // for tool-heavy skills (scene-composition, narrative-writer) we opt
  // out of streaming.  Trade-off: the whole response arrives in one
  // chunk, no live token-by-token UI typing effect.
  if (options.nonStreaming) {
    try {
      const resp = await openai.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      })
      const full = resp.choices[0]?.message?.content ?? ''
      const preview = full.length > 900 ? full.slice(0, 900) + '…' : full
      await trace(reqId, 'stream_done', {
        ms_total: Date.now() - t0,
        chunks: 1,
        chars: full.length,
        resolved_model: resp.model ?? 'unknown',
        preview,
        mode: 'non-streaming',
      })
      return new Response(full, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'gateway error'
      await trace(reqId, 'gateway_error', { message })
      throw err
    }
  }

  let stream
  try {
    stream = await openai.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'gateway error'
    await trace(reqId, 'gateway_error', { message })
    throw err
  }

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      let tokenCount = 0
      let charCount = 0
      let firstTokenLogged = false
      let resolvedModel: string | undefined
      let clientGone = false  // true once the client fetch is aborted
      const buf: string[] = []
      const safeEnqueue = (data: Uint8Array): boolean => {
        if (clientGone) return false
        try {
          controller.enqueue(data)
          return true
        } catch {
          clientGone = true
          return false
        }
      }
      try {
        for await (const chunk of stream) {
          if (clientGone) break
          if (!resolvedModel && chunk.model) resolvedModel = chunk.model
          const delta = chunk.choices[0]?.delta?.content ?? ''
          if (delta) {
            if (!firstTokenLogged) {
              await trace(reqId, 'first_token', { ms_since_call: Date.now() - t0 })
              firstTokenLogged = true
            }
            tokenCount += 1
            charCount += delta.length
            buf.push(delta)
            if (!safeEnqueue(encoder.encode(delta))) break
          }
        }
        if (!clientGone) {
          try { controller.close() } catch { /* already closed */ }
        }
        const full = buf.join('')
        const preview = full.length > 900 ? full.slice(0, 900) + '…' : full
        await trace(reqId, clientGone ? 'stream_aborted' : 'stream_done', {
          ms_total: Date.now() - t0,
          chunks: tokenCount,
          chars: charCount,
          resolved_model: resolvedModel ?? 'unknown',
          preview,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'stream error'
        await trace(reqId, 'stream_error', { message, ms_total: Date.now() - t0, client_gone: clientGone })
        if (!clientGone) {
          try { controller.error(err) } catch { /* already closed */ }
        }
      }
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function brainstorm(b: BrainstormBody, reqId: string): Promise<Response> {
  // Compute a grounding brief from the canon spine so the skill's
  // SENSE_DNA step has a real fingerprint (register, motifs, characters,
  // objects) and can resolve pronouns against the actual story.
  // Mirror of the ``narrative_context_builder`` Hermes Python tool.
  const canonBeats = b.canonBeats ?? b.canonTitles.map((t) => ({ title: t, body: '' }))
  const ctx = buildNarrativeContext(canonBeats, {
    title: b.focusTitle,
    body: b.focusBody,
    mood: b.focusMood,
  })
  await trace(reqId, 'context_built', {
    register: ctx.signals.registerHint,
    characters: ctx.characterCount,
    objects: ctx.objectCount,
    motifs: ctx.signals.motifsTop.length,
    brief_chars: ctx.brief.length,
  })

  const payload = {
    parentId: b.focusTitle,
    title: b.focusTitle,
    body: b.focusBody,
    tone: 'canon',
    siblings: [],
    canonTitles: b.canonTitles,
    contextBrief: ctx.brief,
  }
  const brainstormModel = process.env.NOUS_BRAINSTORM_MODEL ?? TEMPLATED_MODEL

  // Pure chat flow — the model sees only the seed and the user's picks.
  // No contextBrief injection, no payload JSON: Gemini-browser parity.
  // The skill handles all output-format guidance; we just pass history.
  return streamViaSkill(
    'creative', 'narrative-brainstorm', 'narrative-brainstorm',
    payload, 1400, 0.9, reqId,
    {
      model: brainstormModel,
      historyMessages: b.chatHistory,
      // Skill rides inside the first user message — Gemini-browser chat
      // parity.  System-prompt mode was compressing outputs to terse
      // numbered lines even when the skill explicitly asked for rich,
      // dialog-laden prose; moving the same guidance to the user role
      // lets the model's natural chat register take over.
      instructionInUser: true,
    },
  )
}

async function writerAssist(b: WriterAssistBody, reqId: string): Promise<Response> {
  return streamViaSkill(
    'creative',
    'narrative-writer-assist',
    'narrative-writer-assist',
    {
      seed: b.seed,
      canonTitles: b.canonTitles,
      parentTitle: b.parentTitle,
      childTitle: b.childTitle,
      intent: b.intent,
      mode: b.mode,
    },
    900,
    0.75,
    reqId,
    { model: TEMPLATED_MODEL },
  )
}

async function critic(b: CriticBody, reqId: string): Promise<Response> {
  return streamViaSkill(
    'creative',
    'narrative-continuity-critic',
    'narrative-continuity-critic',
    {
      insertTitle: b.insertTitle,
      insertBody: b.insertBody,
      nodeTitle: b.nodeTitle,
      nodeBody: b.nodeBody,
      recentChain: b.recentChain ?? [],
    },
    400,
    0.4,
    reqId,
    { model: TEMPLATED_MODEL },
  )
}

async function rewriter(b: RewriteBody, reqId: string): Promise<Response> {
  return streamViaSkill(
    'creative',
    'narrative-rewriter',
    'narrative-rewriter',
    {
      insertTitle: b.insertTitle,
      insertBody: b.insertBody,
      nodeTitle: b.nodeTitle,
      nodeBody: b.nodeBody,
      criticReason: b.criticReason,
      recentChain: b.recentChain ?? [],
    },
    900,
    0.75,
    reqId,
    { model: TEMPLATED_MODEL },
  )
}

async function judge(b: JudgeBody, reqId: string): Promise<Response> {
  return streamViaSkill(
    'creative',
    'narrative-judge',
    'narrative-judge',
    {
      insertTitle: b.insertTitle,
      insertBody: b.insertBody,
      originalTitle: b.originalTitle,
      originalBody: b.originalBody,
      rewrittenTitle: b.rewrittenTitle,
      rewrittenBody: b.rewrittenBody,
      recentChain: b.recentChain ?? [],
    },
    400,
    0.3,
    reqId,
    { model: TEMPLATED_MODEL },
  )
}

async function sceneCompose(b: SceneComposeBody, reqId: string): Promise<Response> {
  // scene-composition pairs with the narrative_scene_clustering Python
  // tool registered in Hermes.  For the tool to actually execute during
  // Hermes's agent loop we must opt out of streaming: Hermes-4 emits
  // tool_calls as XML-in-content in streaming mode, but as proper
  // OpenAI tool_calls in non-streaming mode.  We accept losing live
  // token typing on this one call in exchange for real tool execution.
  return streamViaSkill(
    'creative',
    'scene-composition',
    'scene-composition',
    { seed: b.seed, nodes: b.nodes },
    1800,
    0.55,
    reqId,
    { nonStreaming: true },
  )
}

async function writer(b: WriterBody, reqId: string): Promise<Response> {
  // The narrative-writer skill emits prose, not JSON.  streamViaSkill still
  // forwards the token stream untouched — the client just doesn't parse it.
  return streamViaSkill(
    'creative',
    'narrative-writer',
    'narrative-writer',
    { seed: b.seed, canonScenes: b.canonScenes },
    1800,
    0.9,
    reqId,
  )
}

// ---- copyright detection (routes image pipeline per story) ----------------

/** Runs the story-copyright-detector skill (Claude reasoning) but falls
 *  back to the deterministic TS mirror if the gateway is slow / down.
 *  Envelope: `{ ip_level, franchise, model_preference, reason }`.  This
 *  result is persisted by the client; every subsequent image-gen reads
 *  the policy out of Zustand. */
async function copyrightDetect(b: CopyrightDetectBody, reqId: string): Promise<Response> {
  // Deterministic-only now.  Routing is Gemini for every seed, so the
  // LLM skill call was doing nothing the TS mirror couldn't do —
  // except burning ~10s and misclassifying animated franchises as
  // flux-photoreal.  The deterministic detector still tags franchise
  // (used by character-sheet / visual-prompt-builder for register hints)
  // and drops a reason line for the ticker.  Anything else is dead
  // weight on the pipeline.
  const baseline = detectStoryCopyright(b.seed)
  await trace(reqId, 'copyright_baseline', {
    ip_level: baseline.ip_level,
    franchise: baseline.franchise,
    model: baseline.model_preference,
  })
  return Response.json(baseline)
}

// ---- character sheet (cast list + portrait prompts) -----------------------

/** Runs the character-sheet-builder skill once per story.  Returns a
 *  JSON array `[{name, description, portrait_prompt}, ...]` the client
 *  uses to (a) persist description into the text character registry and
 *  (b) fire image-gen per portrait_prompt and cache the resulting
 *  reference portraits keyed by name.  No retry on parse failure — a
 *  bad skill output simply means no reference portraits this story. */
async function characterSheet(b: CharacterSheetBody, reqId: string): Promise<Response> {
  const skillRes = await streamViaSkill(
    'creative',
    'character-sheet-builder',
    'character-sheet-builder',
    {
      seed: b.seed,
      franchise: b.franchise ?? null,
      storyRegister: b.storyRegister,
      allow_ip_names: !!b.allow_ip_names,
    },
    1200,
    0.4,
    reqId,
    { nonStreaming: true, model: TEMPLATED_MODEL },
  )
  const txt = await skillRes.text()
  try {
    const cleaned = txt.replace(/^```json\s*|\s*```$/g, '').trim()
    const match = cleaned.match(/\[[\s\S]*\]/)
    const parsed = JSON.parse(match ? match[0] : cleaned) as Array<{
      name?: string; description?: string; portrait_prompt?: string
    }>
    const entries = (Array.isArray(parsed) ? parsed : [])
      .filter((e) => typeof e?.name === 'string' && typeof e?.description === 'string' && typeof e?.portrait_prompt === 'string')
      .slice(0, 4)
    await trace(reqId, 'character_sheet_done', {
      count: entries.length,
      names: entries.map((e) => e.name),
    })
    return Response.json({ characters: entries })
  } catch {
    await trace(reqId, 'character_sheet_parse_error', { preview: txt.slice(0, 300) })
    return Response.json({ characters: [] })
  }
}

// ---- image prompt build (sanitize beat into IP-free rich visual) ----------

/** Tool event surfaced to the UI so the viewer sees the tool's work live
 *  in the agent ticker panel.  Route handlers attach these to the JSON
 *  envelope they return; the client re-hydrates them into agent events. */
type ToolEvent = {
  tool: 'character-registry-lookup' | 'moderation-rewriter'
  label: string
  detail: string
  status: 'done' | 'error'
}

/** VLM post-render check: send the rendered image + the beat's narrative
 *  intent to a multimodal model (Gemini 2.5 Flash) and ask it to flag
 *  faithfulness failures.  This catches the "Katara harnesses Sokka →
 *  Sokka rendered as sled dog" class of literal-render bug that the
 *  prompt builder cannot catch upstream (the builder honours the body,
 *  the body was ambiguous, the image model resolved ambiguity the wrong
 *  way).  Returns `{approved, score, issues, fix_hint}` — the caller
 *  decides whether to regenerate with the hint.
 *
 *  Runs DIRECTLY against the gateway (bypasses streamViaSkill) because
 *  the skill input must be a multimodal message array, not a plain
 *  string — streamViaSkill assumes a text-only user payload. */
async function sceneQa(b: SceneQaBody, reqId: string): Promise<Response> {
  const skillBody = await loadSkill('creative', 'narrative-scene-qa')
  await trace(reqId, 'skill_loaded', {
    slug: 'narrative-scene-qa',
    cache: skillCache.has('creative/narrative-scene-qa') ? 'hit' : 'miss',
    skill_chars: skillBody.length,
  })
  const system = activationPrompt('narrative-scene-qa', skillBody)
  const canonText = (b.canonContext ?? [])
    .map((c, i) => `[beat ${i + 1}] ${c.title}\n${c.body}${c.imagePrompt ? `\n(prior image prompt: ${c.imagePrompt.slice(0, 160)})` : ''}`)
    .join('\n\n')
  const userText = [
    `nodeTitle: ${b.nodeTitle}`,
    `nodeBody: ${b.nodeBody}`,
    canonText ? `canonContext:\n${canonText}` : 'canonContext: (empty — this is an early beat)',
    '',
    'Inspect the attached image and return the JSON verdict.',
  ].join('\n')

  // The image URL is a public /cache/images/... path served by Next
  // (for cached renders) — Gemini needs a fully qualified URL to fetch
  // the bytes on its side.  Promote a relative URL to absolute here,
  // falling back to the localhost origin (the dev server is the one
  // serving /cache/images/ anyway).
  let fullImageUrl = b.imageUrl
  if (fullImageUrl.startsWith('/')) {
    const origin = process.env.NOUSTINY_PUBLIC_ORIGIN ?? 'http://localhost:3000'
    fullImageUrl = `${origin}${fullImageUrl}`
  }
  const t0 = Date.now()
  const openai = hermesClient()
  await trace(reqId, 'gateway_call', {
    requested_model: TEMPLATED_MODEL,
    system_chars: system.length,
    user_chars: userText.length,
    max_tokens: 400,
    temperature: 0.3,
    multimodal: true,
  })
  try {
    const resp = await openai.chat.completions.create({
      model: TEMPLATED_MODEL,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: fullImageUrl } },
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 400,
      stream: false,
    })
    const full = resp.choices[0]?.message?.content ?? ''
    const preview = full.length > 600 ? full.slice(0, 600) + '…' : full
    await trace(reqId, 'stream_done', {
      ms_total: Date.now() - t0,
      chunks: 1,
      chars: full.length,
      resolved_model: resp.model ?? 'unknown',
      preview,
      mode: 'scene-qa',
    })
    return new Response(full, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'scene-qa gateway error'
    await trace(reqId, 'gateway_error', { message })
    throw err
  }
}

async function imagePromptBuild(b: ImagePromptBuildBody, reqId: string): Promise<Response> {
  const characters = b.characters ?? {}

  // Tool hop #1 — character_registry_lookup runs before the skill fires.
  // Emits one visible event per registry hit so the demo viewer sees
  // "REGISTRY HIT · Hannah → freckled redhead…" in the agent ticker.
  const hits = lookupCharacterRegistry(b.body, b.title, characters)
  const events: ToolEvent[] = hits.map((h) => ({
    tool: 'character-registry-lookup',
    label: `REGISTRY HIT · ${h.name}`,
    detail: h.description,
    status: 'done',
  }))
  await trace(reqId, 'registry_lookup', {
    hit_count: hits.length,
    names: hits.map((h) => h.name),
  })

  // Skill call (non-streaming so we can parse the JSON and wrap it in the
  // envelope with events).  Hermes-4's streaming tool_call XML issue doesn't
  // bite here since the skill is reasoning-only.  Runs on Haiku — templated
  // output, ~3-4x cheaper than Sonnet, quality parity for this task.
  const skillRes = await streamViaSkill(
    'creative',
    'visual-prompt-builder',
    'visual-prompt-builder',
    {
      title: b.title,
      body: b.body,
      seed: b.seed,
      canonBeats: b.canonBeats ?? [],
      characters,
      franchise: b.franchise ?? null,
      allow_ip_names: !!b.allow_ip_names,
    },
    800,
    0.6,
    reqId,
    { nonStreaming: true, model: TEMPLATED_MODEL },
  )
  const skillText = await skillRes.text()
  let skillJson: Record<string, unknown> = {}
  try {
    const cleaned = skillText.replace(/^```json\s*|\s*```$/g, '').trim()
    const match = cleaned.match(/\{[\s\S]*\}/)
    skillJson = match ? JSON.parse(match[0]) : JSON.parse(cleaned)
  } catch {
    return Response.json({ error: 'skill returned non-JSON', events, raw: skillText.slice(0, 400) }, { status: 502 })
  }
  return Response.json({ ...skillJson, events })
}

/** Batch variant — sends N beats to visual-prompt-builder in a single skill
 *  call, expects a JSON array back in input order.  Halves-plus the Claude
 *  cost since the 5KB skill body is billed once instead of N times.  Falls
 *  back to per-beat single calls only if parsing the batch response fails. */
async function imagePromptBatch(b: ImagePromptBatchBody, reqId: string): Promise<Response> {
  const characters = b.characters ?? {}
  const beats = b.beats ?? []
  if (beats.length === 0) return Response.json({ prompts: [], events: [] })

  // Registry lookup per beat (cheap, deterministic).  Emit one event per hit.
  const events: ToolEvent[] = []
  for (const beat of beats) {
    const hits = lookupCharacterRegistry(beat.body, beat.title, characters)
    for (const h of hits) {
      events.push({
        tool: 'character-registry-lookup',
        label: `REGISTRY HIT · ${h.name}`,
        detail: h.description,
        status: 'done',
      })
    }
  }
  await trace(reqId, 'registry_lookup_batch', {
    beat_count: beats.length,
    hit_count: events.length,
  })

  const skillRes = await streamViaSkill(
    'creative',
    'visual-prompt-builder',
    'visual-prompt-builder',
    {
      beats,
      seed: b.seed,
      canonBeats: b.canonBeats ?? [],
      characters,
      franchise: b.franchise ?? null,
      allow_ip_names: !!b.allow_ip_names,
    },
    2400,  // N×800 upper bound
    0.6,
    reqId,
    { nonStreaming: true, model: TEMPLATED_MODEL },
  )
  const skillText = await skillRes.text()
  let prompts: Array<{ storyRegister?: string; prompt?: string; characters_seen?: unknown[] }> = []
  try {
    const cleaned = skillText.replace(/^```json\s*|\s*```$/g, '').trim()
    const match = cleaned.match(/\[[\s\S]*\]/)
    prompts = JSON.parse(match ? match[0] : cleaned) as typeof prompts
    if (!Array.isArray(prompts)) throw new Error('not array')
  } catch {
    await trace(reqId, 'image_prompt_batch_parse_error', { preview: skillText.slice(0, 300) })
    return Response.json({ prompts: [], events, error: 'batch parse failed' }, { status: 502 })
  }

  return Response.json({ prompts, events })
}

// ---- image generation ------------------------------------------------------

// Single render engine — Gemini 3.1 Flash Image Preview (Nano Banana).
// FLUX (photoreal) and SeeDream (fallback) were removed: FLUX broke the
// stylised look on animated franchises and SeeDream drifted extra
// figures into multi-ref scenes.  Keeping one model cheap + predictable.
const IMAGE_STYLISED = 'google/gemini-3.1-flash-image-preview'

const IMAGE_CACHE_DIR = path.join(process.cwd(), 'public', 'cache', 'images')

// Bump this version tag when the prompt-composition rule changes (style
// tail, aspect tag, …) so previously-rendered images under the old
// composition are re-generated instead of silently reused.
const IMAGE_CACHE_VERSION = 'v3-gemini-only'
function imageCacheKey(prompt: string, style: string, aspect: string): string {
  return createHash('sha256').update(`${IMAGE_CACHE_VERSION}|${prompt}|${style}|${aspect}`).digest('hex').slice(0, 20)
}

function extractImageDataUri(resp: unknown): { ext: string; base64: string } | null {
  // Nano Banana / SeeDream / FLUX all return the image under
  //   choices[0].message.images[0].image_url.url
  // as a data URI.  OpenAI SDK doesn't type this field, so we traverse
  // defensively.
  const c = (resp as { choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[] }).choices?.[0]
  const url = c?.message?.images?.[0]?.image_url?.url
  if (typeof url !== 'string' || !url.startsWith('data:')) return null
  const match = url.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/)
  if (!match) return null
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  return { ext, base64: match[2] }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

type ImageAttempt = {
  model: string
  prompt: string
  httpStatus?: number
  img?: { ext: string; base64: string }
  refusal?: string
  errorMsg?: string
}

/** Return an absolute HTTP URL for a ``/cache/refs/...`` or
 *  ``/cache/images/...`` path so Nous Portal image models can fetch it.
 *  Disk paths live under `web/public/cache/...` but the image model
 *  gateway runs out-of-process and can't read local files. */
function absoluteCacheUrl(relUrl: string, reqHost?: string): string {
  if (relUrl.startsWith('http://') || relUrl.startsWith('https://')) return relUrl
  const origin = reqHost
    ? reqHost
    : (process.env.NOUSTINY_PUBLIC_URL ?? 'http://localhost:3100')
  return `${origin}${relUrl.startsWith('/') ? '' : '/'}${relUrl}`
}

/** Inline a /cache/images/... file as a data URI.  Nous Portal rejects
 *  private/localhost URLs (response: "Cannot fetch from private/localhost
 *  URLs"), so we can't hand it a dev-server link.  Reading the PNG/JPG
 *  off disk and base64-embedding it makes the payload fully self-contained
 *  and works identically in dev and prod.  Portrait files are small
 *  (< 200 KB each); three inlined refs add ~1 MB to the request — well
 *  under Nous Portal's 10 MB body limit.
 *
 *  Falls back to returning the absolute URL unchanged for any ref that
 *  isn't a local /cache/ file (e.g. a user-supplied http reference) so
 *  downstream behaviour never regresses. */
async function inlineRefAsDataUri(relOrUrl: string): Promise<string> {
  try {
    // Accept both bare paths ("/cache/images/abc.png") and full
    // "http://host/cache/images/abc.png" produced by absoluteCacheUrl.
    const tail = relOrUrl.replace(/^https?:\/\/[^/]+/, '')
    if (!tail.startsWith('/cache/images/')) return relOrUrl
    const file = tail.split('/').pop() ?? ''
    const diskPath = path.join(IMAGE_CACHE_DIR, file)
    const buf = await readFile(diskPath)
    const ext = (file.split('.').pop() ?? 'png').toLowerCase()
    const mime =
      ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
      ext === 'webp' ? 'image/webp' :
      'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return relOrUrl
  }
}

async function tryImageModel(
  model: string,
  fullPrompt: string,
  nousKey: string,
  nousBase: string,
  reqId: string,
  referenceUrls?: string[],
  referenceNames?: string[],
): Promise<ImageAttempt> {
  const refsRaw = (referenceUrls ?? []).filter((u) => typeof u === 'string' && u.length > 0)
  // Inline every cached /cache/images/... ref as a data URI.  Without
  // this Nous Portal refuses with "Cannot fetch from private/localhost
  // URLs" because our ref URLs point at the dev server (unreachable
  // from the gateway's network).  data: URIs travel with the request
  // and always resolve.
  const isMultimodalCapable = model.includes('gemini') || model.includes('seedream')
  const refs = (refsRaw.length > 0 && isMultimodalCapable)
    ? await Promise.all(refsRaw.map(inlineRefAsDataUri))
    : refsRaw
  const names = referenceNames ?? []
  await trace(reqId, 'image_model_try', {
    model, prompt_len: fullPrompt.length, refs: refs.length,
  })
  try {
    // Multi-modal content for Nano Banana / SeeDream when refs are
    // present.  Each ref is prefixed with a labelled text block
    // ("Reference N — <Name>:") so Gemini knows which portrait maps to
    // which character in the prompt — without this binding it sometimes
    // renders the same character twice in one frame.  A final
    // anti-duplication guardrail follows the scene prompt.
    // Two ref kinds: character portraits (label with the character's name,
    // one figure per portrait) and scene-continuity refs (prior canon
    // frame, treat as composition anchor — carry world state forward).
    // Distinguish by the magic `prior_scene` name so Gemini doesn't read
    // it as "a character named prior_scene".
    const content = (refs.length > 0 && isMultimodalCapable)
      ? [
          ...refs.flatMap((url, i) => {
            const name = names[i]
            const label = name === 'prior_scene'
              ? `Previous scene frame — compose this next shot as a visual continuation of it. Keep the world state (broken/shattered/altered objects, freed/wounded/repositioned characters, lit fires, open doors) as depicted. Do NOT re-render the prior state as pristine:`
              : name
                ? `Reference ${i + 1} — ${name}:`
                : `Reference ${i + 1}:`
            return [
              { type: 'text' as const, text: label },
              { type: 'image_url' as const, image_url: { url } },
            ]
          }),
          {
            type: 'text' as const,
            text: `Scene: ${fullPrompt}\n\nRender exactly one figure per named character above — do not duplicate any character or invent extra people.`,
          },
        ]
      : fullPrompt
    const httpResp = await fetch(`${nousBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${nousKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: 4000,
        stream: false,
      }),
    })
    if (!httpResp.ok) {
      await trace(reqId, 'image_http_error', { model, status: httpResp.status })
      return { model, prompt: fullPrompt, httpStatus: httpResp.status }
    }
    const resp = await httpResp.json() as Record<string, unknown>
    const img = extractImageDataUri(resp)
    const choice = (resp as { choices?: { finish_reason?: string; native_finish_reason?: string; message?: Record<string, unknown> }[] }).choices?.[0]
    if (!img) {
      const refusal = choice?.finish_reason ?? 'no_image'
      // Log the FULL prompt on refusal so we can understand what pattern
      // tripped the safety filter (not just the 80-char trace summary).
      // Costs log-lines but only on failures — normal path unchanged.
      await trace(reqId, 'image_model_refused', {
        model,
        finish_reason: refusal,
        native_finish: choice?.native_finish_reason,
        full_prompt: fullPrompt,
        ref_count: refs.length,
      })
      return { model, prompt: fullPrompt, refusal }
    }
    return { model, prompt: fullPrompt, img }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'image error'
    await trace(reqId, 'image_model_error', { model, message })
    return { model, prompt: fullPrompt, errorMsg: message }
  }
}

async function imageGen(b: ImageGenBody, reqId: string): Promise<Response> {
  const style = b.style ?? 'cinematic'
  const aspect = b.aspect ?? '16:9'
  // modelPreference is accepted for backwards-compat but ignored — every
  // render goes through Gemini now.  FLUX / SeeDream paths were removed
  // because (a) FLUX's photoreal output killed the animated cel-shade
  // look of franchise seeds, (b) SeeDream drifted extra figures into
  // crowd scenes when multi-modal refs were attached, and (c) one model
  // is cheaper and more predictable than a three-way fallback ladder.
  const refs = (b.referenceUrls ?? []).map((u) => absoluteCacheUrl(u))
  const refNames = b.referenceNames ?? []
  // Cache key includes ref count so the same prompt rendered with vs.
  // without references produces distinct cache entries.  Scene renders
  // pass skipCache:true so every beat gets a fresh render even if two
  // prompts look similar; character portraits still hit the cache so
  // the same Aang/Katara/Sokka sheet isn't regenerated on every entry.
  const cacheKey = imageCacheKey(b.prompt, style, `${aspect}|refs=${refs.length}`)

  await mkdir(IMAGE_CACHE_DIR, { recursive: true })
  if (!b.skipCache) {
    for (const ext of ['jpg', 'png', 'webp']) {
      const p = path.join(IMAGE_CACHE_DIR, `${cacheKey}.${ext}`)
      if (await fileExists(p)) {
        const url = `/cache/images/${cacheKey}.${ext}`
        await trace(reqId, 'image_cache_hit', { cacheKey, ext, url })
        return Response.json({ url, cached: true, events: [] })
      }
    }
  }

  const styleTail = style === 'cinematic'
    ? ', cinematic still, 35mm film, dramatic lighting'
    : style === 'illustrated'
      ? ', illustrated storybook style, painterly'
      : ', photorealistic, natural lighting, shallow depth of field'

  // Nano Banana / Imagen / SeeDream via `/chat/completions` don't expose a
  // dedicated aspect-ratio parameter — the aspect has to travel in the
  // prompt itself.  Without this token Gemini defaults to near-square /
  // portrait orientation even for widescreen scene beats; the explicit
  // aspect phrase is what the browser UI's "widescreen" toggle sends
  // under the hood.
  const aspectTag =
    aspect === '16:9'
      ? ', wide 16:9 landscape aspect ratio, horizontal widescreen composition, full scene in frame'
      : aspect === '9:16'
        ? ', tall 9:16 portrait aspect ratio, vertical frame'
        : ', square 1:1 aspect ratio'

  const nousKey = process.env.NOUS_API_KEY ?? ''
  const nousBase = process.env.NOUS_BASE_URL ?? 'https://inference-api.nousresearch.com/v1'
  const t0 = Date.now()

  const events: ToolEvent[] = []
  const fullPrompt = `${b.prompt}${styleTail}${aspectTag}`

  // Single render path — Gemini only.  If it refuses we surface the
  // error instead of silently falling back to a photoreal or stylised
  // engine that produces off-style output.  The skill stack (visual
  // prompt builder + moderation rewriter logic previously on the
  // server) is now Gemini's own safety layer; our job is just to hand
  // it the prompt + refs.
  await trace(reqId, 'image_policy', { policy: 'gemini-only' })
  const geminiTry = await tryImageModel(IMAGE_STYLISED, fullPrompt, nousKey, nousBase, reqId, refs, refNames)
  if (geminiTry.img) {
    // Deterministic filename (cacheKey) for cacheable renders so a lookup
    // finds them; unique filename for skipCache renders so two beats with
    // the same prompt hash don't stomp each other on disk.
    const basename = b.skipCache
      ? createHash('sha256').update(`${cacheKey}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 20)
      : cacheKey
    const filename = `${basename}.${geminiTry.img.ext}`
    await writeFile(path.join(IMAGE_CACHE_DIR, filename), Buffer.from(geminiTry.img.base64, 'base64'))
    const url = `/cache/images/${filename}`
    await trace(reqId, 'image_saved', {
      model: IMAGE_STYLISED, ext: geminiTry.img.ext, attempt: 'gemini',
      ms_total: Date.now() - t0, url, skipCache: !!b.skipCache,
    })
    return Response.json({ url, cached: false, model: IMAGE_STYLISED, events })
  }
  await trace(reqId, 'image_exhausted', {
    ms_total: Date.now() - t0,
    refusal: geminiTry.refusal,
    http_status: geminiTry.httpStatus,
    error: geminiTry.errorMsg,
  })
  return Response.json({
    error: geminiTry.errorMsg ?? geminiTry.refusal ?? `gemini http ${geminiTry.httpStatus ?? 'unknown'}`,
    events,
  }, { status: 502 })
}
