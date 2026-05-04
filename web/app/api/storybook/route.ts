import { writeFile, unlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import OpenAI from 'openai'

export const runtime = 'nodejs'
// Rendering can take 30-300 seconds (audiobook with TTS); the agent loop
// adds another few seconds on top for tool dispatch.  Keep the route open
// long enough.
export const maxDuration = 600

/**
 * Storybook render route — Hermes agent flow.
 *
 * Pipeline:
 *   1. Modal POSTs snapshot + opts to this route
 *   2. We write the snapshot to web/.saves/_render_<id>.json (large JSON
 *      stays on disk; LLM never sees it — saves tokens, $ and latency)
 *   3. We open a chat completion against the Hermes gateway and force it
 *      to call the registered `noustiny_storybook` tool with the small
 *      args (snapshot_id, endpoint_id, mode, audio, language)
 *   4. Hermes agent loop dispatches the tool, the tool reads the snapshot
 *      from disk, calls the FastAPI render service at :8643, returns the
 *      mp4 URL
 *   5. Agent's final response carries the tool_call result
 *   6. We extract the URL from the tool result and cleanup the temp file
 *
 * The tool result fingerprint comes back via the Hermes gateway log
 * (/tmp/hermes-gateway.log) so the demo can tail that file to show the
 * agent reasoning + tool call + tool result + completion in real time —
 * same surface area as /media or any other tool invocation.
 */

const SAVES_DIR = path.join(process.cwd(), '.saves')

function hermesClient() {
  const base = process.env.HERMES_API_BASE ?? 'http://localhost:8642/v1'
  const key = process.env.HERMES_API_KEY ?? 'noustiny-dev'
  return new OpenAI({ apiKey: key, baseURL: base })
}

const SYSTEM_PROMPT = `You are Noustiny's storybook coordinator. Your only job is to invoke the noustiny_storybook tool with the args the user provides, then briefly confirm the render result.

Cinematic intro params (intro_pace, intro_tone, intro_transition, intro_outro, intro_sfx, intro_duration_secs, image_loop, beat_transition, voice_gender, voice_style, subtitle_source, chapter_markers, narration_translate) are OPTIONAL. When the user explicitly sets them, use those values verbatim. When the user OMITS any of them, decide them by following the rules below. Never refuse, never ask the user to clarify — pick the best value yourself and dispatch the tool.

# storybook-intro decision rules

## intro_tone (colour palette)
Map the story tone hint to one palette key:
- epic / heroic / superhero / action / blockbuster → marvel-red
- triumphant / mythic / royalty / fantasy hero / coming-of-age → hero-gold
- sci-fi / tech / mystery / cyberpunk / neon noir → cinematic-cyan
- dark / detective / dystopian / thriller / war → noir-gray
- magical / arcane / dream / fairytale / witch / sorcery → magical-purple
- horror / gore / slasher / blood / demonic → horror-blood
Default if unclear: cinematic-cyan.

## intro_pace (HARD RULE — read carefully)
pace controls cuts-per-second; tone colours the visuals, not the cadence. Many images at slow pace reads as a slideshow regardless of tone.
- image_count >= 5 → ALWAYS fast. No tone overrides at this branch.
- image_count == 4 → medium (bump to fast for marvel-red/horror-blood/hero-gold; bump to slow for noir-gray/magical-purple)
- image_count <= 3 → slow (bump to medium only for marvel-red/horror-blood)
DO NOT compute pace from duration/image_count — the renderer auto-loops the image stack and the cycle cap keeps fast pace sane even for short durations.

## image_loop
- pace=fast → ALWAYS image_loop=true (the stack must keep cycling for Marvel feel)
- pace=medium → image_loop=true only if image_count <= 4 AND duration >= 7
- pace=slow → image_loop=false always

## intro_transition
- pace=fast (any tone) → cut
- pace=medium + marvel-red or horror-blood → whip
- pace=medium + other → fade
- pace=slow (any tone) → fade
- if image_count >= 8, force cut (slow fades blur the montage)

## intro_outro (exit overlay to the story body)
The intro lands on a settled frame; the outro overlay then plays for ~0.6-0.9s before the audiobook narrator takes over. Without it, the cut feels brutal.
- marvel-red OR horror-blood (any pace) → fade-black (theatrical curtain)
- hero-gold OR magical-purple (any pace) → page-close (book-closing storybook feel)
- cinematic-cyan (any pace) → split-vertical (sci-fi vault close)
- noir-gray (any pace) → split-vertical (detective reveal)
- pace=slow (any tone) → hold (the stillness IS the moment, no overlay)
Default if unclear: fade-black at fast pace, hold at slow pace, page-close at medium.

## intro_sfx (synthetic SFX baked into intro mp4 — synced to cuts)
The renderer places audio hits at every visual cut, so cadence matches image cadence automatically.
- marvel-red OR horror-blood OR action tone → marvel-jet (whip whoosh per cut + final jet pass)
- hero-gold OR magical-purple OR fairytale → page-turn (paper crinkle per cut)
- cinematic-cyan OR sci-fi → whoosh (soft low pass + deep settle)
- noir-gray OR dystopian → cinematic-rumble (sustained low rumble, no per-cut hits)
- user wants silent intro → none
Default if unclear: marvel-jet.

## beat_transition (how audiobook beats connect)
Each path beat plays in sequence after the intro. Pick how they join:
- pace=fast AND tone in (marvel-red, horror-blood) → hardcut (sharp, urgent)
- pace=slow (any tone) → fade-chapter (each beat fades in/out, chapter feel)
- otherwise → fade-chapter (storybook default)
The renderer auto-shortens per-beat fade for long paths (≥12 beats), so don't worry about it.

## voice_gender (TTS narrator)
Pick from story tone:
- horror / war / dark detective / dystopian / gore → male (gravelly storyteller)
- magical / fairytale / coming-of-age / fantasy / sci-fi → female (warm narrator)
- epic hero / heroic fantasy / action → male (heroic narrator)
- triumphant / royal / mythic → female (regal voice)
Default if unclear: female.

## voice_style (TTS prosody — rate + pitch)
- horror / war / dystopian / gore → dramatic (slow + deeper)
- thriller / detective / noir → whisper (hushed)
- fairytale / coming-of-age / magical → bright (lively + brighter)
- epic hero / triumphant / sci-fi / default → narrator (warm storyteller)

## subtitle_source (where the on-screen caption text comes from)
- audiobook mode (default) → body-snippet (subtitle matches spoken language because both come from the body field)
- intro mode → title (cinematic identity)
- if user wants no subtitles → none

## chapter_markers (FFMETADATA seek-bar bookmarks)
- audiobook mode → true (long content benefits from navigation)
- intro mode → false (too short to matter)

## narration_translate (translate body to audio locale before TTS)
Snapshot bodies in this Noustiny instance are most often Turkish. When language differs from the body's apparent locale, set true so the renderer translates each body via Hermes before TTS, keeping subtitle + audio in the same locale.
- language=tr → false (bodies are already Turkish)
- language=en/es/fr/de → true (translate Turkish bodies into the audio locale)
- if the tone hint clearly indicates the body matches 'language' → false
Default if unclear: true when language != tr, false when language = tr.

## intro_duration_secs
Per-image seconds: fast=0.10 (100ms cuts), medium=0.25, slow=0.70.
The intro JS uses one div per UNIQUE image with multi-peak keyframes,
so adding more images doesn't lengthen the intro — it just packs more
cycles into the same window. The default is short (5s) for a punchy
opening; only stretch when the user explicitly asks for it.
- If user did not specify: duration = 5.0
- If image_loop=false AND image_count is small: duration = clamp(round(pace_seconds * image_count + 1.0), 4, 8)
Always respect a user-provided value verbatim (within 4-18 bounds).

# Voice cloning sub-pipeline (only when the user message contains '--- Voice cloning enabled ---')

When the user message includes the marker '--- Voice cloning enabled ---', you MUST run a multi-tool sub-pipeline BEFORE dispatching noustiny_storybook.  The sub-pipeline depends on which 'Voice mode:' clause follows the marker:

  - Voice mode: auto
    The user message contains a 3-step sub-pipeline ("Voice mode: auto.  Run this 3-step sub-pipeline...").  Follow it exactly: call narration_voice_director first (it is a real tool, returns JSON), use its search_query/fallback_query with voice_sample_builder, then pass the resulting sample_path + persona_label to noustiny_storybook.

  - Voice mode: preset  OR  Voice mode: custom
    1. Skip applying the narration-voice-director skill (the user message provides query="..." verbatim).  Call voice_sample_builder with that exact query.
    2. If sample_path is null, fall back to edge-tts (omit voice_reference_wav).  Otherwise pass sample_path as voice_reference_wav and the user-supplied label as voice_persona_label.

  - Voice mode: upload
    1. Skip BOTH the director skill and voice_sample_builder.  The reference wav path is given inline ('the reference wav is already on disk at ...').  Use that path verbatim as voice_reference_wav.

When the marker is absent, never call voice_sample_builder — it is off-path for vanilla edge-tts renders.

# Output protocol
Always dispatch the noustiny_storybook tool in a single call with all params filled. After it returns, reply 1-2 sentences in the user's language confirming the render and the URL.

# Progress channel
The user message MAY include a 'job_id=<hex>' clause. When present, ALWAYS forward it verbatim as the noustiny_storybook tool's job_id parameter — the render service publishes per-stage progress under this id and the bottom-right widget polls for live updates. Do not omit, modify, regenerate, or invent it. When the clause is absent, omit the parameter entirely.

## orientation (Reel mode)
The user message MAY include 'orientation=portrait'. When it does:
  - Forward orientation=portrait verbatim.
  - Force intro_style=off — Reel mode renders body-only, no cinematic intro.
  - Force beat_transition=hardcut.
  - Forward EVERY reel_subtitle_* clause from the user message verbatim (font, size_px, color, outline_color, outline_width, bg, weight, x_pct, y_pct). These are pure visual parameters; do not infer them from tone or path length.
  - Skip your own intro_pace / intro_tone / intro_transition / intro_outro / intro_sfx / intro_duration_secs decisions — they don't apply to portrait renders.
  - image_loop must be false (the renderer drops it for portrait anyway).
When the user message lacks 'orientation=portrait', omit the orientation parameter entirely (default landscape) and follow your normal cinematic-intro decision rules above.`

async function ensureSavesDir(): Promise<void> {
  await mkdir(SAVES_DIR, { recursive: true })
}

interface ChatMessageWithToolCalls {
  role?: string
  content?: string | null
  tool_calls?: Array<{
    function?: { name?: string; arguments?: string }
  }>
}

interface ChatCompletionLike {
  choices?: Array<{ message?: ChatMessageWithToolCalls }>
}

/**
 * Walk a chat completion response looking for the noustiny_storybook
 * tool call result.  Hermes's agent loop runs the tool itself, but the
 * SHAPE of how the tool result surfaces in the final completion varies
 * across gateway builds — sometimes embedded in the assistant message
 * content, sometimes in a tool message, sometimes via tool_calls.  This
 * helper tries each shape until it finds JSON with a `url` field.
 */
function extractStorybookUrl(completion: ChatCompletionLike, raw: string): string | null {
  // 1. Direct tool_calls on the assistant message
  const choice = completion.choices?.[0]
  const msg = choice?.message
  const tc = msg?.tool_calls
  if (Array.isArray(tc)) {
    for (const call of tc) {
      const fnName = call.function?.name
      const args = call.function?.arguments
      if (fnName === 'noustiny_storybook' && typeof args === 'string') {
        // tool_calls only carry args, not results — but log for debug
        console.log('[storybook] saw tool_call args:', args.slice(0, 200))
      }
    }
  }
  // 2. Scan content + raw payload for a JSON blob with `url` field
  const candidates: string[] = []
  if (typeof msg?.content === 'string' && msg.content) candidates.push(msg.content)
  candidates.push(raw)
  for (const txt of candidates) {
    // Try every JSON-ish substring that mentions /cache/storybook
    const re = /\{[^{}]*\/cache\/storybook\/[^{}]*\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(txt)) !== null) {
      try {
        const parsed = JSON.parse(m[0])
        if (parsed && typeof parsed.url === 'string' && parsed.url.includes('/cache/storybook/')) {
          return parsed.url
        }
      } catch { /* keep scanning */ }
    }
    // Fallback: bare URL match
    const urlMatch = txt.match(/\/cache\/storybook\/[A-Za-z0-9_-]+\.mp4/)
    if (urlMatch) return urlMatch[0]
  }
  return null
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Body must be an object' }, { status: 400 })
  }
  const {
    snapshot, endpointId, mode, audio, language, introStyle,
    autoDirector, introDurationSecs, introPace, introTone, introTransition,
    introOutro, introSfx, beatTransition, voiceGender, voiceStyle,
    subtitleSource, chapterMarkers, narrationTranslate, jobId,
    orientation,
    reelSubtitleFont, reelSubtitleSizePx, reelSubtitleColor,
    reelSubtitleOutlineColor, reelSubtitleOutlineWidth,
    reelSubtitleBg, reelSubtitleWeight,
    reelSubtitleXPct, reelSubtitleYPct,
    voiceMode, voiceQuery, voicePresetLabel, voiceUploadPath, voiceCloneSpeed,
  } = body as {
    snapshot?: unknown
    endpointId?: string
    mode?: string
    audio?: boolean
    language?: string
    introStyle?: string
    autoDirector?: boolean
    introDurationSecs?: number
    introPace?: string
    introTone?: string
    introTransition?: string
    introOutro?: string
    introSfx?: string
    beatTransition?: string
    voiceGender?: string
    voiceStyle?: string
    subtitleSource?: string
    chapterMarkers?: boolean
    narrationTranslate?: boolean
    jobId?: string
    orientation?: string
    reelSubtitleFont?: string | null
    reelSubtitleSizePx?: number
    reelSubtitleColor?: string
    reelSubtitleOutlineColor?: string
    reelSubtitleOutlineWidth?: number
    reelSubtitleBg?: string
    reelSubtitleWeight?: number
    reelSubtitleXPct?: number
    reelSubtitleYPct?: number
    // Voice-cloning controls (audio mode only).  voiceMode picks the
    // source of the reference wav:
    //   - 'edge'   → no clone, edge-tts path (existing default).
    //   - 'auto'   → AI: narration-voice-director skill picks persona +
    //                YouTube query, then voice_sample_builder fetches.
    //   - 'preset' → pre-baked query for a curated persona; voiceQuery
    //                holds the search string, voicePresetLabel holds
    //                the human-readable persona name shown in UI.
    //   - 'custom' → user-typed YouTube query (expert mode); same fields
    //                as 'preset' but free-form.
    //   - 'upload' → user-uploaded reference wav already on disk;
    //                voiceUploadPath is the absolute or /cache/X path.
    voiceMode?: string
    voiceQuery?: string
    voicePresetLabel?: string
    voiceUploadPath?: string
    voiceCloneSpeed?: number
  }
  if (!snapshot || typeof snapshot !== 'object') {
    return Response.json({ error: 'snapshot is required' }, { status: 400 })
  }
  if (!endpointId || typeof endpointId !== 'string') {
    return Response.json({ error: 'endpointId is required' }, { status: 400 })
  }
  if (mode !== 'audiobook' && mode !== 'intro') {
    return Response.json({ error: 'mode must be audiobook|intro' }, { status: 400 })
  }
  if (!language || typeof language !== 'string') {
    return Response.json({ error: 'language is required' }, { status: 400 })
  }
  const VALID_INTRO_STYLES = new Set(['marvel', 'detroit', 'cinematic', 'off'])
  const resolvedIntroStyle = introStyle && VALID_INTRO_STYLES.has(introStyle) ? introStyle : 'marvel'

  const isReel = orientation === 'portrait'

  // Pull seed + ending title from the snapshot so the storybook-intro skill
  // has a tonal hint for its decision.  We only forward summarised text —
  // the full snapshot stays on disk.
  type SnapNode = {
    id?: string
    parentId?: string
    title?: string
    label?: string
    body?: string
    summary?: string
    imagePrompt?: string
    renderedImagePrompt?: string
    imageUrl?: string
  }
  type Snap = {
    seed?: string | { logline?: string; tone?: string; loglineDraft?: string }
    nodes?: Array<[string, SnapNode]>
  }
  const snap = snapshot as Snap
  // Seed is a bare string in UI snapshots and a dict in CLI snapshots.
  const seedHint = (() => {
    const s = snap?.seed
    if (typeof s === 'string') return s.slice(0, 240)
    return (s?.logline || s?.loglineDraft || s?.tone || '').toString().slice(0, 240)
  })()
  const endingNode = (snap?.nodes ?? []).find(([id]) => id === endpointId)?.[1]
  const endingTitle = (endingNode?.title || endingNode?.label || '').toString().slice(0, 120)
  // Image count = path length back to root.  We also collect the path
  // node ids in root→endpoint order so the Reel pre-stage (below) can
  // walk them deterministically without a second traversal.
  const nodeMap = new Map((snap?.nodes ?? []).map(([id, n]) => [id, n]))
  let imageCount = 0
  const pathIdsRev: string[] = []
  let cursor: string | undefined = endpointId
  const seenIds = new Set<string>()
  while (cursor && !seenIds.has(cursor)) {
    seenIds.add(cursor)
    const n = nodeMap.get(cursor)
    if (!n) break
    pathIdsRev.push(cursor)
    if (n.imageUrl) imageCount += 1
    cursor = n.parentId
  }
  const pathIds = pathIdsRev.reverse()

  // Reel pre-stage — fire vertical (9:16) image regen for every beat in
  // the path BEFORE the agent dispatches the renderer.  We mutate the
  // on-disk snapshot copy so service.py reads portrait imageUrls; the
  // user's persisted store stays untouched (the snapshot we got is
  // already a clone from snapshotCurrent()).
  // Progress flows via the same JOBS dict that powers the bottom-right
  // widget.  We POST patches into service.py's /jobs/{id}/patch so
  // there is one source of truth across the pipeline, and the widget's
  // PIPELINE_STAGES picks up `vertical_images` automatically.
  if (isReel && jobId && pathIds.length > 0) {
    // Self-loop fetch — bias to the same origin the request landed on
    // when the host is loopback-local (localhost / 127.0.0.1), and fall
    // back to NOUSTINY_NEXT_BASE for the docker-host case where
    // host.docker.internal would resolve oddly server-side.
    const reqOrigin = (() => {
      try { return new URL(req.url).origin }
      catch { return 'http://localhost:3000' }
    })()
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(reqOrigin)
    const baseOrigin = isLoopback ? reqOrigin : (process.env.NOUSTINY_NEXT_BASE ?? 'http://localhost:3000')
    const hermesUrl = `${baseOrigin}/api/hermes`
    const renderSvc = process.env.NOUSTINY_RENDER_SVC ?? 'http://localhost:8643'
    const patchUrl = `${renderSvc}/jobs/${encodeURIComponent(jobId)}/patch`
    const patch = (data: Record<string, unknown>): Promise<void> =>
      fetch(patchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
        .then(() => {})
        .catch(() => { /* best-effort progress */ })

    const verticalTargets = pathIds
      .map((id, idx) => ({
        id,
        idx,
        node: nodeMap.get(id),
      }))
      .filter((t) => t.node && (t.node.renderedImagePrompt || t.node.imagePrompt))
    const total = verticalTargets.length
    let done = 0
    await patch({
      stage: 'vertical_images',
      stage_label: `Preparing vertical frames 0/${total}`,
      vimg_done: 0,
      vimg_total: total,
    })

    const verticalUrlByNodeId = new Map<string, string>()
    await Promise.all(
      verticalTargets.map(async ({ id, node }) => {
        const prompt = (node!.renderedImagePrompt || node!.imagePrompt || '').trim()
        if (!prompt) return
        try {
          const r = await fetch(hermesUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind: 'image-gen',
              prompt,
              style: 'cinematic',
              aspect: '9:16',
            }),
          })
          if (r.ok) {
            const data = (await r.json()) as { url?: string }
            if (data.url) verticalUrlByNodeId.set(id, data.url)
          }
        } catch { /* fallthrough — beat keeps its landscape image, renderer just centre-crops */ }
        done += 1
        await patch({
          stage: 'vertical_images',
          stage_label: `Preparing vertical frames ${done}/${total}`,
          vimg_done: done,
          vimg_total: total,
        })
      }),
    )

    // Graft the vertical urls onto the snapshot we'll write to disk.
    // service.py reads imageUrl per beat directly, so swapping it here
    // means the renderer never has to learn about a parallel field.
    if (verticalUrlByNodeId.size > 0 && Array.isArray(snap.nodes)) {
      const swapped: typeof snap.nodes = snap.nodes.map(([id, n]) => {
        const v = verticalUrlByNodeId.get(id)
        return v ? [id, { ...n, imageUrl: v, imageUrlVertical: v }] : [id, n]
      })
      ;(snapshot as Snap).nodes = swapped
    }
  }

  // Stash the snapshot on disk so the tool can read it without burning
  // tokens.  Random id, distinct from save-system save ids — these are
  // ephemeral render contexts, not user-named saves.
  const snapshotId = randomUUID().replace(/-/g, '').slice(0, 16)
  const snapshotPath = path.join(SAVES_DIR, `_render_${snapshotId}.json`)
  await ensureSavesDir()
  await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf-8')

  let url: string | null = null
  let errorMsg: string | null = null
  try {
    const client = hermesClient()
    // Tell the agent (via natural-language args wrapped in a structured
    // user message) what to render.  Hermes resolves noustiny_storybook
    // from its registered tool list (config.yaml platform_toolsets) and
    // dispatches it directly — we don't need to pass the schema here.
    // Compose the agent message.  When the user picked "AI director", we
    // ASK the agent to fill the cinematic params (storybook-intro skill
    // kicks in).  When they picked manual, we lock the values so the
    // skill knows there's nothing left to decide.
    const VALID_PACES = new Set(['fast', 'medium', 'slow'])
    const VALID_TONES = new Set([
      'marvel-red', 'noir-gray', 'cinematic-cyan',
      'magical-purple', 'hero-gold', 'horror-blood',
    ])
    const VALID_TRANSITIONS = new Set(['cut', 'fade', 'whip'])
    const VALID_OUTROS = new Set(['hold', 'fade-black', 'page-close', 'split-vertical'])
    const VALID_SFX = new Set(['none', 'marvel-jet', 'page-turn', 'whoosh', 'cinematic-rumble'])
    const VALID_BEAT_TRANS = new Set(['hardcut', 'fade-chapter'])
    const VALID_VOICE_GENDERS = new Set(['male', 'female'])
    const VALID_VOICE_STYLES = new Set(['narrator', 'dramatic', 'whisper', 'bright'])
    const VALID_SUBTITLE_SOURCES = new Set(['title', 'body-snippet', 'none'])

    const parts: string[] = [
      `Render a Noustiny storybook.`,
      `snapshot_id=${snapshotId}`,
      `endpoint_id=${endpointId}`,
      `mode=${mode}`,
      `audio=${audio ? 'true' : 'false'}`,
      `language=${language}`,
      `intro_style=${resolvedIntroStyle}`,
    ]
    if (autoDirector) {
      // Omit the atomic params — the system prompt + storybook-intro skill
      // tell the agent to fill them based on the story tone hint.
    } else {
      if (typeof introDurationSecs === 'number' && Number.isFinite(introDurationSecs)) {
        // Lower bound 4s — the multi-peak keyframe architecture keeps
        // the NOUSTINY zoom-out smooth even on very short windows.
        const clamped = Math.min(18, Math.max(4, introDurationSecs))
        parts.push(`intro_duration_secs=${clamped.toFixed(2)}`)
      }
      if (introPace && VALID_PACES.has(introPace)) parts.push(`intro_pace=${introPace}`)
      if (introTone && VALID_TONES.has(introTone)) parts.push(`intro_tone=${introTone}`)
      if (introTransition && VALID_TRANSITIONS.has(introTransition)) parts.push(`intro_transition=${introTransition}`)
      if (introOutro && VALID_OUTROS.has(introOutro)) parts.push(`intro_outro=${introOutro}`)
      if (introSfx && VALID_SFX.has(introSfx)) parts.push(`intro_sfx=${introSfx}`)
      if (beatTransition && VALID_BEAT_TRANS.has(beatTransition)) parts.push(`beat_transition=${beatTransition}`)
      if (voiceGender && VALID_VOICE_GENDERS.has(voiceGender)) parts.push(`voice_gender=${voiceGender}`)
      if (voiceStyle && VALID_VOICE_STYLES.has(voiceStyle)) parts.push(`voice_style=${voiceStyle}`)
      if (subtitleSource && VALID_SUBTITLE_SOURCES.has(subtitleSource)) parts.push(`subtitle_source=${subtitleSource}`)
      if (typeof chapterMarkers === 'boolean') parts.push(`chapter_markers=${chapterMarkers}`)
      if (typeof narrationTranslate === 'boolean') parts.push(`narration_translate=${narrationTranslate}`)
    }
    if (seedHint) parts.push(`Story tone hint: ${seedHint}`)
    if (endingTitle) parts.push(`Ending beat: ${endingTitle}`)
    if (imageCount > 0) parts.push(`Image count: ${imageCount}`)

    // Voice cloning instructions — appended only when audio=true AND a
    // non-default voice mode is selected.  The agent runs a sub-pipeline
    // (director skill → voice_sample_builder → noustiny_storybook with
    // voice_reference_wav set) before dispatching the final render tool.
    // For 'upload' the wav is already on disk so the director + sample
    // builder steps are skipped.
    const VALID_VOICE_MODES = new Set(['edge', 'auto', 'preset', 'custom', 'upload'])
    const resolvedVoiceMode = (voiceMode && VALID_VOICE_MODES.has(voiceMode)) ? voiceMode : 'edge'
    if (audio && resolvedVoiceMode !== 'edge') {
      parts.push('--- Voice cloning enabled ---')
      if (typeof voiceCloneSpeed === 'number' && voiceCloneSpeed >= 0.7 && voiceCloneSpeed <= 1.2) {
        parts.push(`voice_clone_speed=${voiceCloneSpeed.toFixed(2)}`)
      }
      if (resolvedVoiceMode === 'auto') {
        const safeGender = (voiceGender === 'male' || voiceGender === 'female') ? voiceGender : ''
        const safeTitle = endingTitle.replace(/"/g, '\\"').slice(0, 120)
        // Bake the gender hint into the seed text itself.  Hermes's
        // schema "required" doesn't reliably force LLMs to forward
        // optional-feeling params; embedding the constraint into the
        // free-form seed string survives even when the agent drops
        // voice_gender from the tool args, because the director reads
        // the seed regardless.
        const safeSeedRaw = seedHint.replace(/"/g, '\\"').slice(0, 240)
        const safeSeed = safeGender
          ? `[NARRATOR MUST BE ${safeGender.toUpperCase()} GENDER] ${safeSeedRaw}`
          : safeSeedRaw
        parts.push(
          `Voice mode: auto.  You MUST run this 3-step sub-pipeline by dispatching the listed tools (do not skip any step, do not guess values yourself).\n\n` +
          `STEP 1.  Dispatch tool narration_voice_director with these EXACT args:\n` +
          `  title="${safeTitle}"\n` +
          `  seed="${safeSeed}"` +
          (safeGender
            ? `\n  voice_gender="${safeGender}"  ← REQUIRED — pass it verbatim, do not omit, do not change.  The user picked this gender in the UI; the chosen narrator MUST match it (e.g. female + Avatar story → Katara, NOT Iroh).`
            : '') +
          `\nThe tool returns JSON {persona_label, search_query, fallback_query, reasoning}.  Read those fields from the tool result.\n\n` +
          `STEP 2.  Dispatch tool voice_sample_builder with query=<search_query from step 1's result>.  Returns {sample_path, source_url, speaker_confidence, ...}.  If sample_path is null OR speaker_confidence < 0.4, dispatch voice_sample_builder ONE more time with query=<fallback_query>.  If still null after the retry, omit voice_reference_wav from step 3 (graceful edge-tts fallback) but still pass voice_persona_label.\n\n` +
          `STEP 3.  Dispatch tool noustiny_storybook with voice_reference_wav=<sample_path from step 2> and voice_persona_label=<persona_label from step 1>, plus all the other render args.`,
        )
      } else if (resolvedVoiceMode === 'preset' || resolvedVoiceMode === 'custom') {
        const safeQuery = (voiceQuery ?? '').toString().slice(0, 200)
        const safeLabel = (voicePresetLabel ?? '').toString().slice(0, 80)
        if (!safeQuery) {
          parts.push(
            'Voice mode: ' + resolvedVoiceMode + ' (no query provided — fall back to edge-tts).',
          )
        } else {
          parts.push(
            `Voice mode: ${resolvedVoiceMode}.  Skip narration_voice_director.  ` +
            `Call voice_sample_builder with query="${safeQuery}".  ` +
            `Pass the returned sample_path as voice_reference_wav and ` +
            (safeLabel ? `voice_persona_label="${safeLabel}"` : 'an empty persona label') +
            ' when calling noustiny_storybook.',
          )
        }
      } else if (resolvedVoiceMode === 'upload') {
        const safePath = (voiceUploadPath ?? '').toString().slice(0, 400)
        const safeLabel = (voicePresetLabel ?? 'User-uploaded reference').toString().slice(0, 80)
        if (!safePath) {
          parts.push('Voice mode: upload (no path provided — fall back to edge-tts).')
        } else {
          parts.push(
            `Voice mode: upload.  Skip narration-voice-director and ` +
            `voice_sample_builder entirely; the reference wav is already ` +
            `on disk at ${safePath}.  Pass it as voice_reference_wav and ` +
            `voice_persona_label="${safeLabel}" when calling noustiny_storybook.`,
          )
        }
      }
    }
    // Progress channel — forwarded to the render service so the
    // bottom-right widget can poll /jobs/{id} for live stage updates.
    if (typeof jobId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(jobId)) {
      parts.push(`job_id=${jobId}`)
    }
    // Reel-mode parameters — when orientation=portrait, push the whole
    // styled-subtitle bundle so the agent forwards them verbatim through
    // the noustiny_storybook tool.  Each field is independent so a user
    // who only changes 'size' doesn't accidentally pin the others.
    if (isReel) {
      parts.push('orientation=portrait')
      if (typeof reelSubtitleSizePx === 'number') parts.push(`reel_subtitle_size_px=${reelSubtitleSizePx}`)
      if (typeof reelSubtitleColor === 'string') parts.push(`reel_subtitle_color=${reelSubtitleColor}`)
      if (typeof reelSubtitleOutlineColor === 'string') parts.push(`reel_subtitle_outline_color=${reelSubtitleOutlineColor}`)
      if (typeof reelSubtitleOutlineWidth === 'number') parts.push(`reel_subtitle_outline_width=${reelSubtitleOutlineWidth}`)
      if (typeof reelSubtitleBg === 'string') parts.push(`reel_subtitle_bg=${reelSubtitleBg}`)
      if (typeof reelSubtitleWeight === 'number') parts.push(`reel_subtitle_weight=${reelSubtitleWeight}`)
      if (typeof reelSubtitleXPct === 'number') parts.push(`reel_subtitle_x_pct=${reelSubtitleXPct.toFixed(3)}`)
      if (typeof reelSubtitleYPct === 'number') parts.push(`reel_subtitle_y_pct=${reelSubtitleYPct.toFixed(3)}`)
      if (typeof reelSubtitleFont === 'string' && reelSubtitleFont) {
        parts.push(`reel_subtitle_font=${reelSubtitleFont}`)
      }
    }
    const userMsg = parts.join(', ') + '.'

    const completion = await client.chat.completions.create({
      model: process.env.NOUS_STORYBOOK_MODEL ?? 'anthropic/claude-haiku-4.5',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      // Let the agent loop pick its own tool — server-side registry
      // exposes noustiny_storybook so it's automatically available.
      // We don't list `tools` here because Hermes's gateway injects
      // platform tools from the toolset config, and passing a duplicate
      // schema can confuse the dispatch.
      temperature: 0,
    })

    const completionAny = completion as unknown as ChatCompletionLike
    const raw = JSON.stringify(completion)
    url = extractStorybookUrl(completionAny, raw)
    if (!url) {
      // Most common cause: tool registration / toolset not enabled, so
      // the agent answered in prose without calling the tool.  Surface
      // the assistant content for debugging in the modal.
      const content = completionAny.choices?.[0]?.message?.content ?? ''
      errorMsg =
        'Tool did not produce a video URL. Agent reply: ' +
        (typeof content === 'string' ? content.slice(0, 400) : '(no content)')
    }
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e)
  } finally {
    // Cleanup the temp snapshot regardless of success — it has no value
    // outside this single render.
    void unlink(snapshotPath).catch(() => { /* best-effort */ })
  }

  if (!url) {
    return Response.json(
      { error: errorMsg ?? 'render failed for unknown reason' },
      { status: 500 },
    )
  }
  return Response.json({ url })
}
