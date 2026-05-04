'use client'

import { X, Film, BookOpen, Smartphone, Trash2 } from 'lucide-react'
import { useStory, type RenderJob } from '@/lib/store'

/**
 * Floating gallery of finished storybook renders.  Mirrors the bottom-
 * right RenderJobs widget but shows ALL completed jobs, grouped by
 * mode (Reel / Sinematik / Sesli Kitap) so the user can quickly find
 * "that vertical clip I made earlier" without re-rendering.  Jobs land
 * here automatically when their status flips to 'done'.
 *
 * Always-dark chrome (matches Legend) so the panel reads the same on
 * both Detroit-light and Detroit-dark backdrops.
 */

const INK_BRIGHT = 'rgba(234, 240, 248, 0.96)'
const INK_MED = 'rgba(198, 210, 226, 0.82)'
const INK_SOFT = 'rgba(170, 185, 205, 0.62)'

type Bucket = 'reel' | 'intro' | 'audiobook'

function bucketOf(job: RenderJob): Bucket {
  const orientation = job.body?.orientation
  const mode = job.body?.mode
  if (orientation === 'portrait') return 'reel'
  if (mode === 'intro') return 'intro'
  return 'audiobook'
}

const BUCKET_META: Record<Bucket, { label: string; hint: string; icon: typeof Film; accent: string }> = {
  reel:      { label: 'Reel',          hint: 'Vertical 9:16 short video',     icon: Smartphone, accent: 'var(--cyan)' },
  intro:     { label: 'Cinematic',     hint: 'Last N beats as a short film',  icon: Film,       accent: 'var(--gold)' },
  audiobook: { label: 'Audiobook',     hint: 'Whole story end to end',        icon: BookOpen,   accent: 'var(--cyan)' },
}

export function MediaLibrary() {
  const open = useStory((s) => s.mediaLibraryOpen)
  const toggle = useStory((s) => s.toggleMediaLibrary)
  const renderJobs = useStory((s) => s.renderJobs)
  const openStoryPlayer = useStory((s) => s.openStoryPlayer)
  const removeRenderJob = useStory((s) => s.removeRenderJob)

  if (!open) return null

  const completed = renderJobs.filter((j) => j.status === 'done' && j.url)
  const byBucket: Record<Bucket, RenderJob[]> = { reel: [], intro: [], audiobook: [] }
  for (const j of completed) byBucket[bucketOf(j)].push(j)
  // Newest first within each bucket — most recent render at the top.
  for (const k of ['reel', 'intro', 'audiobook'] as Bucket[]) {
    byBucket[k].sort((a, b) => b.startedAt - a.startedAt)
  }

  return (
    <div
      className="fixed right-6 bottom-[72px] z-40 flex max-h-[80vh] w-[420px] flex-col border backdrop-blur"
      style={{
        background: 'rgba(10, 13, 18, 0.97)',
        borderColor: 'var(--line)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }}
    >
      <div
        className="sticky top-0 flex shrink-0 items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-2.5"
        style={{ background: 'rgba(10, 13, 18, 0.98)' }}
      >
        <div className="flex items-center gap-2">
          <Film size={11} strokeWidth={1.8} style={{ color: '#4fc3f7' }} />
          <span className="font-display text-[12px] uppercase tracking-[0.32em]" style={{ color: '#4fc3f7' }}>
            Library
          </span>
        </div>
        <button
          onClick={toggle}
          aria-label="Close media library"
          className="transition-colors"
          style={{ color: INK_SOFT }}
          onMouseEnter={(e) => { e.currentTarget.style.color = INK_BRIGHT }}
          onMouseLeave={(e) => { e.currentTarget.style.color = INK_SOFT }}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      {completed.length === 0 ? (
        <div className="flex-1 px-5 py-10 text-center">
          <Film size={20} strokeWidth={1.5} className="mx-auto mb-3" style={{ color: INK_SOFT }} />
          <div className="font-mono text-[10.5px] uppercase tracking-[0.24em]" style={{ color: INK_MED }}>
            no media yet
          </div>
          <div className="mt-2 text-[11px] leading-[1.55]" style={{ color: INK_SOFT }}>
            Click the Storybook button on any story beat — when the render
            finishes it lands here automatically.
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {(['reel', 'intro', 'audiobook'] as Bucket[]).map((bk) => {
            const jobs = byBucket[bk]
            if (jobs.length === 0) return null
            const meta = BUCKET_META[bk]
            const Icon = meta.icon
            return (
              <div key={bk} className="border-b border-[var(--line)] last:border-b-0">
                <div className="flex items-center gap-2 px-5 pt-4 pb-2">
                  <Icon size={11} strokeWidth={1.8} style={{ color: meta.accent }} />
                  <span className="font-display text-[11px] uppercase tracking-[0.28em]" style={{ color: meta.accent }}>
                    {meta.label}
                  </span>
                  <span className="font-mono text-[9.5px] tracking-[0.22em]" style={{ color: INK_SOFT }}>
                    · {jobs.length}
                  </span>
                  <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.22em]" style={{ color: INK_SOFT }}>
                    {meta.hint}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5 px-3 pb-3">
                  {jobs.map((j) => (
                    <MediaCard
                      key={j.id}
                      job={j}
                      bucket={bk}
                      onPlay={() => {
                        if (!j.url) return
                        const aspect: '16/9' | '9/16' = bk === 'reel' ? '9/16' : '16/9'
                        openStoryPlayer(j.endpointId, j.url, aspect)
                      }}
                      onDelete={() => removeRenderJob(j.id)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MediaCard({
  job,
  bucket,
  onPlay,
  onDelete,
}: {
  job: RenderJob
  bucket: Bucket
  onPlay: () => void
  onDelete: () => void
}) {
  const meta = BUCKET_META[bucket]
  const isReel = bucket === 'reel'
  const thumb = job.beatImage || null
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPlay()
        }
      }}
      className="group flex cursor-pointer items-stretch gap-3 border px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:border-[color:var(--cyan)]"
      style={{
        borderColor: 'var(--line)',
        background: 'rgba(15,19,27,0.5)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = meta.accent }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line)' }}
    >
      <div
        className="relative shrink-0 overflow-hidden bg-[#05070b]"
        style={{
          width: isReel ? 32 : 56,
          height: isReel ? 56 : 32,
        }}
      >
        {thumb ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full w-full items-center justify-center" style={{ color: meta.accent, opacity: 0.5 }}>
            <meta.icon size={14} strokeWidth={1.8} />
          </div>
        )}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ boxShadow: `inset 0 0 0 1px ${meta.accent}30` }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="truncate font-display text-[11.5px] uppercase tracking-[0.18em]"
          style={{ color: INK_BRIGHT }}
        >
          {job.endpointTitle || 'Untitled beat'}
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.22em]" style={{ color: INK_SOFT }}>
          <span>{meta.label}</span>
          {typeof job.beatsTotal === 'number' && (
            <>
              <span>·</span>
              <span>{job.beatsTotal} beats</span>
            </>
          )}
          <span>·</span>
          <span>{relativeAge(job.startedAt)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        title="Delete"
        className="shrink-0 self-start opacity-0 transition-opacity group-hover:opacity-100"
        style={{ color: INK_SOFT }}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#e74c3c' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = INK_SOFT }}
      >
        <Trash2 size={12} strokeWidth={1.7} />
      </button>
    </div>
  )
}

/** Relative age helper — "2m", "5h", "3d".  Avoids pulling a date
 *  library for one tiny use. */
function relativeAge(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
