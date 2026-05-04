'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, AlertTriangle, Sparkles } from 'lucide-react'
import { useStory } from '@/lib/store'
import type { RenderJob } from '@/lib/store'

/**
 * Bottom-right render queue widget.
 *
 * One card per active render job — modal hands a job off here when the
 * user hits Generate, then the canvas stays interactive while Hermes
 * dispatches the storybook tool.  Each card owns its own POST + polling
 * lifecycle (managed inside this single component, no per-card hook
 * gymnastics) and surfaces the live stage / beat as it streams in.
 *
 * Layers shown while running:
 *  1. Hermes badge + cyan pulse (top-right of card)         — agent activity
 *  2. Stage label + beat title                              — what's happening
 *  3. Beat thumbnail (current beat's image, dim ghost)      — story made visible
 *  4. Beat dots strip (lit-up = page rendered)              — overall progress
 *  5. Pipeline bar (translate / tts / page / intro / mux)   — phase position
 *
 * Done state: card glows gold, ▶ play icon centred — click anywhere on
 * the card to open the player.  Error state: red border + message.
 *
 * Persistence: dismiss = X.  Render keeps running in the background
 * even if the user closes the widget early (no AbortController on the
 * server-side Hermes call — that would orphan the tool dispatch
 * mid-flight).  Closing here just stops the UI from displaying it; the
 * mp4 still lands in /cache/storybook/ and the user can re-render.
 */

const PIPELINE_STAGES = [
  { id: 'queued',           label: 'Queue' },
  { id: 'prep',             label: 'Prep' },
  { id: 'vertical_images',  label: 'Frames' },
  { id: 'translate',        label: 'Translate' },
  { id: 'tts',              label: 'Voice' },
  { id: 'page',             label: 'Pages' },
  { id: 'intro',            label: 'Intro' },
  { id: 'concat',           label: 'Mux' },
  { id: 'done',             label: 'Done' },
] as const
type StageId = (typeof PIPELINE_STAGES)[number]['id']

function stageOrder(stage: string | undefined): number {
  if (!stage) return 0
  const i = PIPELINE_STAGES.findIndex((s) => s.id === stage)
  return i < 0 ? 0 : i
}

/** Relative age — "just now", "2m", "3h", "1d".  Mirrors the helper in
 *  MediaLibrary so the queue card and the gallery speak the same dialect
 *  without a shared util module for one tiny function. */
function relativeAge(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function RenderJobs() {
  const jobs = useStory((s) => s.renderJobs)

  return (
    <div
      className="pointer-events-none fixed right-4 z-30 flex flex-col gap-3"
      style={{ width: 384, bottom: 96 }}
    >
      <AnimatePresence initial={false}>
        {jobs.map((job) => (
          <RenderJobCard key={job.id} job={job} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function RenderJobCard({ job }: { job: RenderJob }) {
  const updateRenderJob = useStory((s) => s.updateRenderJob)
  const removeRenderJob = useStory((s) => s.removeRenderJob)
  const openStoryPlayer = useStory((s) => s.openStoryPlayer)

  // Owns the POST lifecycle.  StrictMode fires effects twice in dev;
  // a ref-guard ensures only one fetch leaves the browser per job id.
  const startedRef = useRef(false)

  // Once the card flips terminal the polling effect bails — without a
  // separate clock the age label would freeze at whatever it read on the
  // last poll tick.  60 s is finer-grained than the label needs (it only
  // changes on minute boundaries) but cheap, and keeps two cards rendered
  // a minute apart visibly distinct.
  const [, setAgeTick] = useState(0)
  useEffect(() => {
    if (!job.completedAt) return
    const handle = window.setInterval(() => setAgeTick((t) => t + 1), 60_000)
    return () => window.clearInterval(handle)
  }, [job.completedAt])

  useEffect(() => {
    if (startedRef.current) return
    if (job.status !== 'pending') return
    startedRef.current = true

    let cancelled = false
    updateRenderJob(job.id, { status: 'running' })

    void fetch('/api/storybook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job.body),
    })
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          let msg: string = text || `HTTP ${res.status}`
          try {
            const parsed = JSON.parse(text)
            if (parsed && typeof parsed.error === 'string') msg = parsed.error
          } catch { /* keep raw text */ }
          updateRenderJob(job.id, { status: 'error', error: msg, completedAt: Date.now() })
          return
        }
        const json = (await res.json()) as { url?: string }
        if (cancelled) return
        if (typeof json.url === 'string') {
          updateRenderJob(job.id, { status: 'done', url: json.url, completedAt: Date.now() })
        } else {
          updateRenderJob(job.id, { status: 'error', error: 'no url in response', completedAt: Date.now() })
        }
      })
      .catch((e) => {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        updateRenderJob(job.id, { status: 'error', error: msg, completedAt: Date.now() })
      })

    return () => {
      cancelled = true
    }
    // The job id is what defines this lifecycle — re-running on patches
    // would double-fire the POST.  Effect intentionally keyed to job.id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id])

  // Polling progress channel — keeps the card alive with stage updates
  // until the long fetch resolves.  Stops the moment we hit a terminal
  // status either via fetch resolution OR via service.py reporting done.
  useEffect(() => {
    if (job.status === 'done' || job.status === 'error') return
    let cancelled = false

    const tick = async () => {
      try {
        const res = await fetch(`/api/storybook/progress?jobId=${encodeURIComponent(job.id)}`, {
          cache: 'no-store',
        })
        if (cancelled || !res.ok) return
        const data = (await res.json()) as {
          status?: string
          stage?: string
          stage_label?: string
          beats_total?: number
          beats_done?: number
          beat_title?: string
          beat_image?: string | null
          vimg_done?: number
          vimg_total?: number
          url?: string
          error?: string
        }
        if (cancelled) return
        const patch: Partial<RenderJob> = {
          stage: data.stage,
          stageLabel: data.stage_label,
          beatTitle: data.beat_title,
          beatImage: data.beat_image,
          beatsTotal: data.beats_total,
          beatsDone: data.beats_done,
          vimgDone: data.vimg_done,
          vimgTotal: data.vimg_total,
        }
        // service.py is the first to know a render finished; the long
        // fetch returns a moment later with the same url.  We honour
        // whichever surface reports first.
        if (data.status === 'done' && data.url) {
          patch.status = 'done'
          patch.url = data.url
          if (!job.completedAt) patch.completedAt = Date.now()
        } else if (data.status === 'error' && data.error) {
          patch.status = 'error'
          patch.error = data.error
          if (!job.completedAt) patch.completedAt = Date.now()
        }
        updateRenderJob(job.id, patch)
      } catch { /* swallow polling errors — next tick retries */ }
    }

    const handle = window.setInterval(tick, 1000)
    void tick()
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [job.id, job.status, updateRenderJob])

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Defense in depth: even if the close button's stopPropagation misses
    // (e.g. user clicks the SVG's transparent corner), this guard catches
    // the bubble-up here before opening the player.
    if ((e.target as HTMLElement).closest('[data-rj-close]')) return
    if (job.status !== 'done' || !job.url) return
    const aspect = job.body?.orientation === 'portrait' ? '9/16' : '16/9'
    openStoryPlayer(job.endpointId, job.url, aspect)
  }

  const stageIdx = stageOrder(job.stage)
  const totalStages = PIPELINE_STAGES.length - 1 // skip "queued" baseline
  const overallPct = (() => {
    if (job.status === 'done') return 100
    // Page rendering is the longest phase (TTS + ffmpeg).  Weight stages
    // accordingly so the bar moves like the wall clock, not like an
    // even distribution.  Tuned by feel against ~3min 15-beat renders.
    const STAGE_WEIGHTS: Record<StageId, number> = {
      queued: 0,
      prep: 5,
      vertical_images: 8,
      translate: 12,
      tts: 25,
      page: 65,
      intro: 85,
      concat: 95,
      done: 100,
    }
    const id = (job.stage as StageId) ?? 'queued'
    let base = STAGE_WEIGHTS[id] ?? 0
    if ((id === 'translate' || id === 'tts' || id === 'page') &&
        job.beatsTotal && job.beatsDone !== undefined) {
      // Within the page phase, lerp by beat completion.
      const next: Record<string, StageId> = {
        translate: 'tts', tts: 'page', page: 'intro',
      }
      const nextWeight = STAGE_WEIGHTS[next[id]] ?? base
      const frac = Math.min(1, Math.max(0, job.beatsDone / Math.max(1, job.beatsTotal)))
      base = base + (nextWeight - base) * frac
    }
    if (id === 'vertical_images' && job.vimgTotal && job.vimgDone !== undefined) {
      // Lerp by vertical-image completion when the route pushes
      // vimg_done / vimg_total during the Reel pre-stage.
      const next = STAGE_WEIGHTS.translate
      const frac = Math.min(1, Math.max(0, job.vimgDone / Math.max(1, job.vimgTotal)))
      base = base + (next - base) * frac
    }
    return Math.round(base)
  })()

  const isDone = job.status === 'done' && !!job.url
  const isError = job.status === 'error'
  const accent = isError ? 'var(--red, #e74c3c)' : isDone ? 'var(--gold, #e9c16b)' : 'var(--cyan, #4fc3f7)'

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 24, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="pointer-events-auto relative overflow-hidden border bg-[rgba(10,13,18,0.96)] backdrop-blur-md"
      style={{
        borderColor: accent,
        boxShadow: `0 16px 48px rgba(0,0,0,0.55), 0 0 0 1px ${accent}26, 0 0 24px ${accent}33`,
        clipPath: 'polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%)',
      }}
      data-cursor={isDone ? 'pointer' : undefined}
      role={isDone ? 'button' : undefined}
      onClick={handleClick}
    >
      {/* dim beat thumbnail backdrop — story made visible */}
      {job.beatImage && !isError && (
        <motion.div
          key={job.beatImage}
          initial={{ opacity: 0 }}
          animate={{ opacity: isDone ? 0.18 : 0.12 }}
          transition={{ duration: 0.4 }}
          className="pointer-events-none absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `url(${JSON.stringify(job.beatImage).slice(1, -1)})`,
            filter: 'blur(2px) saturate(0.7)',
          }}
        />
      )}

      {/* scanline overlay — cinematic skeleton feel */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,0.4) 0 1px, transparent 1px 3px)',
        }}
      />

      <div className="relative px-3 py-2.5">
        {/* header row */}
        <div className="flex items-center gap-2">
          <span
            className="font-mono text-[9.5px] uppercase tracking-[0.28em]"
            style={{ color: accent }}
          >
            {isDone ? 'storybook ready' : isError ? 'render failed' : 'hermes weaving'}
          </span>
          {!isDone && !isError && (
            <motion.span
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: accent }}
            />
          )}
          {job.body?.orientation === 'portrait' && (
            <span
              className="font-mono text-[9px] uppercase tracking-[0.22em]"
              style={{ color: accent, opacity: 0.85 }}
            >
              · 9:16
            </span>
          )}
          {(isDone || isError) && job.completedAt && (
            <span
              className="font-mono text-[9px] uppercase tracking-[0.22em]"
              style={{ color: accent, opacity: 0.7 }}
            >
              · {relativeAge(job.completedAt)}
            </span>
          )}
          <span
            className="ml-auto flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.22em]"
            style={{ color: 'var(--gold)' }}
          >
            <Sparkles size={9} strokeWidth={1.8} />
            nous
          </span>
          <button
            type="button"
            data-rj-close
            data-cursor="pointer"
            onClick={(e) => { e.stopPropagation(); removeRenderJob(job.id) }}
            onMouseDown={(e) => e.stopPropagation()}
            className="-mr-1 ml-0.5 inline-flex h-6 w-6 items-center justify-center text-[var(--ink-faint)] transition-colors hover:bg-white/5 hover:text-[var(--ink)]"
            aria-label="dismiss"
          >
            <X size={14} strokeWidth={1.8} />
          </button>
        </div>

        {/* center: stage label + beat title (or done CTA / error) */}
        <div className="mt-1.5 min-h-[34px]">
          {isDone ? (
            <div>
              <div className="flex items-center gap-2 text-[var(--gold, #e9c16b)]">
                <Play size={14} strokeWidth={2} fill="currentColor" />
                <span className="font-display text-[12px] uppercase tracking-[0.18em]">
                  click to play
                </span>
              </div>
              {job.endpointTitle && (
                <div className="mt-1 truncate font-mono text-[10px] text-[var(--ink-dim)]">
                  &ldquo;{job.endpointTitle}&rdquo;
                </div>
              )}
            </div>
          ) : isError ? (
            <div className="flex items-start gap-1.5 font-mono text-[10px] text-[var(--red, #e74c3c)]">
              <AlertTriangle size={11} strokeWidth={1.8} className="mt-[1px] shrink-0" />
              <span className="break-words">{job.error || 'unknown error'}</span>
            </div>
          ) : (
            <>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--ink)]">
                {job.stageLabel || 'preparing storybook'}
              </div>
              {job.beatTitle && (
                <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--ink-dim)]">
                  &ldquo;{job.beatTitle}&rdquo;
                </div>
              )}
            </>
          )}
        </div>

        {/* beat dots strip — one dot per beat, lit when rendered */}
        {job.beatsTotal && job.beatsTotal > 0 && !isError && (
          <div className="mt-2 flex items-center gap-[3px]">
            {Array.from({ length: Math.min(job.beatsTotal, 24) }).map((_, i) => {
              const lit = (job.beatsDone ?? 0) > i
              const active = (job.beatsDone ?? 0) === i && !isDone
              return (
                <span
                  key={i}
                  className="block h-[3px] flex-1 transition-colors"
                  style={{
                    backgroundColor: lit
                      ? accent
                      : active
                        ? `${accent}80`
                        : 'rgba(255,255,255,0.08)',
                    boxShadow: lit ? `0 0 4px ${accent}` : 'none',
                  }}
                />
              )
            })}
          </div>
        )}

        {/* pipeline progress bar */}
        <div className="mt-2 h-[3px] w-full overflow-hidden bg-[rgba(255,255,255,0.06)]">
          <motion.div
            initial={false}
            animate={{ width: `${overallPct}%` }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="h-full"
            style={{ backgroundColor: accent, boxShadow: `0 0 8px ${accent}` }}
          />
        </div>

        {/* phase ticks */}
        <div className="mt-1 flex justify-between font-mono text-[8px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
          {PIPELINE_STAGES.filter((s) => s.id !== 'queued').map((s, i) => {
            const reached = stageIdx >= i + 1
            return (
              <span
                key={s.id}
                style={{
                  color: reached ? accent : 'var(--ink-faint)',
                  opacity: reached ? 1 : 0.5,
                }}
              >
                {s.label}
              </span>
            )
          })}
        </div>
      </div>
    </motion.div>
  )
}
