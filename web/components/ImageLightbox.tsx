'use client'

import { motion, AnimatePresence, useMotionValue, useSpring, useTransform } from 'framer-motion'
import { X, ChevronLeft, ChevronRight, Film } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { useStory } from '@/lib/store'
import { expandNode } from '@/lib/hermes-client'
import { DecisionOverlay } from './DecisionOverlay'
import { AmbienceLayer } from './AmbienceLayer'
import type { Ambience, AmbienceKind, NodeMood, StoryNode as TStoryNode } from '@/lib/types'

/**
 * Story-reading lightbox — the "3D glasses" stage.
 *
 * The whole image+decision composite sits inside a shared perspective
 * wrapper driven by mouse parallax.  The decision
 * overlay is rendered in `embedded` mode so it inherits the parent's
 * tilt instead of fighting it with its own transform — image and
 * options feel like one object behind glass, not two layers.
 *
 * Masthead: chapter NUMBER (walked from node.depth) + mood tint.
 * Nav: prev goes to parent node; next follows the canon child that
 *      lies on the current cursor's path, if any.
 * Footnote: short summary appears as italic logline BELOW the prose
 *      when body differs from summary — no duplicate string.
 */

const MOOD_ACCENT: Record<NodeMood, string> = {
  neutral:   '#8a96aa',
  hopeful:   '#e9c16b',
  tense:     '#ff9f40',
  danger:    '#e74c3c',
  climax:    '#ffd378',
  quiet:     '#64a0dc',
  discovery: '#a78bfa',
}

/** Mood-based fallback for the ambience layer while the skill hasn't
 *  shipped its body-aware ambience field yet.  Conservative: many
 *  moods default to `none` so the effect feels earned when it appears.
 *  Body analysis overrides this in a later pass. */
function fallbackAmbience(mood: NodeMood, body: string): Ambience {
  const b = (body ?? '').toLowerCase()

  // Narrative keyword scan — crude but catches the obvious cases
  // ("snow", "rain", "fire", "mist") regardless of mood, so a quiet
  // snowy scene still gets snow rather than mood-default silence.
  if (/\b(snow|snowflakes|snowing|blizzard|flurries|iceberg)\b/.test(b)) {
    return { kind: 'snow', scope: 'in_frame', intensity: 'active' }
  }
  if (/\b(rain|raining|downpour|drizzle|storm)\b/.test(b)) {
    return { kind: 'rain', scope: 'in_frame', intensity: 'active' }
  }
  if (/\b(fire|flame|burning|inferno|ember|pyre)\b/.test(b)) {
    return { kind: 'embers', scope: 'in_frame', intensity: 'active' }
  }
  if (/\b(ash|soot|smouldering|smoldering|aftermath)\b/.test(b)) {
    return { kind: 'ash', scope: 'in_frame', intensity: 'subtle' }
  }
  if (/\b(mist|fog|haze|vapor|vapour)\b/.test(b)) {
    return { kind: 'fog', scope: 'in_frame', intensity: 'subtle' }
  }
  if (/\b(cave|cavern|underground|tunnel|crypt)\b/.test(b)) {
    return { kind: 'drip', scope: 'in_frame', intensity: 'subtle' }
  }
  if (/\b(candle|lantern|torch|dim|sunbeam|shaft of light)\b/.test(b)) {
    return { kind: 'dust_motes', scope: 'in_frame', intensity: 'subtle' }
  }
  if (/\b(firefly|fireflies|glowflies|lanternbugs)\b/.test(b)) {
    return { kind: 'fireflies', scope: 'in_frame', intensity: 'subtle' }
  }

  // Pure mood fallback — deliberately sparse.
  switch (mood) {
    case 'danger':    return { kind: 'embers', scope: 'in_frame', intensity: 'subtle' }
    case 'climax':    return { kind: 'embers', scope: 'in_frame', intensity: 'active' }
    case 'quiet':     return { kind: 'dust_motes', scope: 'in_frame', intensity: 'subtle' }
    case 'discovery': return { kind: 'fireflies', scope: 'in_frame', intensity: 'subtle' }
    case 'hopeful':   return { kind: 'dust_motes', scope: 'in_frame', intensity: 'subtle' }
    default:          return { kind: 'none', scope: 'none' }
  }
}

export function ImageLightbox() {
  const lightboxNodeId = useStory((s) => s.lightboxNodeId)
  const openLightbox = useStory((s) => s.openLightbox)
  const close = useStory((s) => s.closeLightbox)
  const openStorybook = useStory((s) => s.openStorybook)
  const setCurrent = useStory((s) => s.setCurrent)
  const nodes = useStory((s) => s.nodes)
  const node = lightboxNodeId ? nodes.get(lightboxNodeId) : undefined

  const [askInflight, setAskInflight] = useState(false)

  // Mouse-driven parallax.  Raw mouse offset (-1..1) goes through a
  // soft spring into rotation values, so the stage tracks the cursor
  // with organic lag instead of jitter-mapping 1:1.  On leave the
  // spring returns to zero — flat, no drift.
  const stageRef = useRef<HTMLDivElement | null>(null)
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const spring = { stiffness: 120, damping: 18, mass: 0.9 }
  const sx = useSpring(mx, spring)
  const sy = useSpring(my, spring)
  const rotateY = useTransform(sx, [-1, 1], [-7, 7])
  const rotateX = useTransform(sy, [-1, 1], [5, -5])

  const onMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const el = stageRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1
    mx.set(Math.max(-1, Math.min(1, nx)))
    my.set(Math.max(-1, Math.min(1, ny)))
  }
  const onMouseLeave = () => { mx.set(0); my.set(0) }

  // Navigation walks the LIGHTBOX node's own chain — not the global
  // cursor.  Prev = parent.  Next = the child that's already on canon
  // (current / canon status) so browsing follows the story spine; if
  // no child is marked canon yet, fall back to the first child so the
  // arrow still moves forward through the tree.
  const prevId = node?.parentId ?? null
  const nextId = useMemo(() => {
    if (!node || node.childrenIds.length === 0) return null
    const children = node.childrenIds
      .map((id): TStoryNode | undefined => nodes.get(id))
      .filter((c): c is TStoryNode => !!c)
    const canonish = children.find((c) => c.status === 'current' || c.status === 'canon')
    return (canonish ?? children[0])?.id ?? null
  }, [node, nodes])

  useEffect(() => {
    if (!lightboxNodeId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowLeft' && prevId) openLightbox(prevId)
      else if (e.key === 'ArrowRight' && nextId) openLightbox(nextId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxNodeId, close, openLightbox, prevId, nextId])

  const { prose, footnote } = useMemo(() => {
    if (!node) return { prose: '', footnote: '' }
    const body = (node.body ?? '').trim()
    const summary = (node.summary ?? '').trim()
    // Show summary as footnote only if it's genuinely different from
    // the body — not just a truncated preview.  For root nodes
    // summary is the first 180 chars of the seed and body is the full
    // seed; both strings differ but visually they repeat the same
    // opening, so the footnote reads as duplicate text.
    const summaryPreviewsBody =
      summary.length > 0 &&
      body.length > 0 &&
      body.replace(/\s+/g, ' ').startsWith(summary.replace(/…$/, '').replace(/\s+/g, ' ').slice(0, 80))
    if (body && body !== summary && !summaryPreviewsBody) {
      return { prose: body, footnote: summary }
    }
    return { prose: body || summary, footnote: '' }
  }, [node])

  const onAskHermes = async () => {
    if (!node || askInflight) return
    setAskInflight(true)
    // Asking Hermes from the lightbox is semantically the same as the
    // user picking the gold ribbon to make this node current and
    // THEN clicking "Ask Hermes" from the bottom bar.  Make that
    // explicit: promote the lightbox node to current first so the
    // canvas treats it as the focal beat (checkpoint card, brackets,
    // canon chain) — without this the user sees the parent stay as
    // a compact bar even after the brainstorm completes.
    setCurrent(node.id, 'human')
    // Close the lightbox the moment the user kicks off a brainstorm —
    // the new branches land on the canvas as shells with their own
    // weaving overlays, and seeing them appear in real time is more
    // useful than waiting on the modal.  Brainstorm runs in the
    // background regardless; we don't await it before closing.
    close()
    try {
      await expandNode(node.id, 3, { force: node.childrenIds.length > 0 })
    } finally {
      setAskInflight(false)
    }
  }

  if (!node) return <AnimatePresence />

  const accent = MOOD_ACCENT[node.mood] ?? '#4fc3f7'
  const chapterNo = (node.depth ?? 0) + 1
  const first = prose.charAt(0)
  const restOfFirstWord = prose.match(/^\S+/)?.[0]?.slice(1) ?? ''
  const afterFirstWord = prose.slice(first.length + restOfFirstWord.length)

  // Ambience — mood/body-driven fallback for now.  When the skill ships
  // a body-aware ambience field on the node we'll swap this for
  // `node.ambience ?? fallbackAmbience(...)`.
  const ambience = fallbackAmbience(node.mood, (node.body ?? node.summary ?? ''))
  const ambienceKind: AmbienceKind = ambience.scope === 'none' ? 'none' : ambience.kind

  return (
    <AnimatePresence>
      <motion.div
        key="lb-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22 }}
        className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/92 backdrop-blur-md"
        onClick={close}
      >
        {/* around-frame ambience — drifts in the backdrop space outside
            the image frame, for beats whose *world* has weather but
            whose kamera is somewhere sheltered (cave, indoor, etc.) */}
        {ambience.scope === 'around_frame' && (
          <AmbienceLayer
            kind={ambienceKind}
            intensity={ambience.intensity}
            accent={accent}
          />
        )}
        <motion.article
          key="lb-panel"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.3, ease: [0.2, 0.9, 0.2, 1] }}
          onClick={(e) => e.stopPropagation()}
          className="relative my-10 w-[min(1180px,94vw)]"
        >
          {/* close */}
          <button
            onClick={close}
            aria-label="Close"
            className="absolute -right-2 -top-10 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--ink-dim)] transition-colors hover:text-[var(--ink)]"
          >
            <X size={12} strokeWidth={1.5} /> close · esc
          </button>

          {/* masthead — chapter number only, no brand text */}
          <header className="mb-4 flex items-baseline gap-3 font-mono text-[10px] uppercase tracking-[0.42em]" style={{ color: accent }}>
            <span className="h-px w-10" style={{ background: `linear-gradient(90deg, transparent, ${accent})` }} aria-hidden />
            <span>Chapter {String(chapterNo).padStart(2, '0')}</span>
            <span style={{ color: 'rgba(198,210,226,0.45)' }}>·</span>
            <span style={{ color: 'rgba(198,210,226,0.55)' }}>{node.mood}</span>
          </header>

          {/* The 3D stage — image + prose + decision together as one
              cinematic spread.  Mouse position over the stage drives
              the rotation through a spring, so parallax tracks the
              cursor with organic lag.  On mouse leave, the spring
              returns to flat — no drift, no idle wobble. */}
          <motion.div
            ref={stageRef}
            className="relative"
            style={{ perspective: 1800, perspectiveOrigin: '50% 50%' }}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          >
            <motion.div
              className="relative w-full"
              style={{
                transformStyle: 'preserve-3d',
                willChange: 'transform',
                rotateX,
                rotateY,
              }}
            >
              {/* image frame — overflow:visible so the DecisionOverlay's
                  translateZ isn't flattened by a parent with overflow
                  clipping.  The <img> itself stays inside the box due
                  to object-cover + 100% sizing. */}
              <div
                className="relative w-full overflow-hidden bg-black"
                style={{
                  aspectRatio: '16 / 9',
                  boxShadow: `0 40px 100px rgba(0,0,0,0.7), 0 0 0 1px ${accent}22, inset 0 0 0 1px ${accent}18`,
                  transformStyle: 'preserve-3d',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={node.imageUrl}
                  alt={node.title}
                  draggable={false}
                  className="h-full w-full object-cover"
                />

                {/* Storybook tab — top-left, mirrors the StoryNode card
                    button.  Click sets the storybook endpoint to THIS
                    beat (no navigation); the modal opens on top of
                    the lightbox, the user keeps reading where they
                    were.  Hidden on the root (no journey to render). */}
                {node.parentId && node.status !== 'generating' && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); openStorybook(node.id) }}
                    title="Generate storybook video ending at this beat"
                    data-cursor="pointer"
                    className="absolute z-30 flex items-center gap-2 bg-[rgba(10,13,18,0.92)] px-4 py-2.5 font-mono text-[13px] uppercase tracking-[0.30em] text-[var(--cyan)] opacity-90 transition-all duration-150 hover:bg-[rgba(79,195,247,0.18)] hover:opacity-100 hover:scale-[1.02]"
                    style={{
                      // Tag trick: button extends 12px past the image's
                      // left edge with a top-left chamfer so its slanted
                      // wedge falls into the OUTSIDE region.  The image
                      // frame's overflow:hidden trims the wedge, and
                      // what's visible is a clean tag flush against the
                      // image's left edge.  Border is drawn via inset
                      // box-shadow so the cyan outline tracks the
                      // visible (clipped) silhouette rather than the
                      // intrinsic rectangle.
                      left: -12,
                      top: 18,
                      transformOrigin: 'left top',
                      clipPath: 'polygon(12px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
                      boxShadow: 'inset 0 0 0 1px var(--cyan), 0 4px 14px rgba(79,195,247,0.18)',
                    }}
                  >
                    <Film size={14} strokeWidth={2.2} />
                    storybook
                  </button>
                )}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background: `linear-gradient(180deg, transparent 35%, rgba(0,0,0,0.55) 100%)`,
                  }}
                />

                {/* in-frame ambience — particles overlay the image when
                    the scene itself has snow/rain/embers inside it */}
                {ambience.scope === 'in_frame' && (
                  <AmbienceLayer
                    kind={ambienceKind}
                    intensity={ambience.intensity}
                    accent={accent}
                  />
                )}

                <div className="pointer-events-none absolute bottom-0 left-0 right-0 p-6">
                  <div
                    className="font-display text-[28px] font-semibold leading-[1.1] tracking-[0.02em] text-white"
                    style={{ textShadow: '0 2px 14px rgba(0,0,0,0.8)', maxWidth: '62%' }}
                  >
                    {node.title}
                  </div>
                </div>

                {/* decision overlay — anchored to the image frame's
                    bottom-right, lifted on Z for parallax. */}
                {node.status !== 'generating' && (
                  <DecisionOverlay
                    node={node}
                    askInflight={askInflight}
                    onAskAgain={onAskHermes}
                    embedded
                    onAfterPick={close}
                  />
                )}
              </div>

              {/* prose — part of the same tilted page.  Paper panel
                  with soft gradient + accent bar so it doesn't float in
                  black space.  translateZ(-18px) puts it on a slightly
                  recessed plane so rotation separates it subtly from
                  the image foreground. */}
              {prose && (
                <div
                  className="relative mx-auto mt-8"
                  style={{
                    maxWidth: 860,
                    transform: 'translateZ(-18px)',
                  }}
                >
                  <section
                    className="relative overflow-hidden px-10 py-8"
                    style={{
                      background: 'linear-gradient(180deg, rgba(15,19,27,0.82) 0%, rgba(10,13,18,0.78) 100%)',
                      boxShadow: `0 20px 50px rgba(0,0,0,0.5), inset 0 0 0 1px ${accent}1f`,
                      borderLeft: `2px solid ${accent}66`,
                    }}
                  >
                    {/* faint diagonal paper grain */}
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0 opacity-[0.06]"
                      style={{
                        backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.4) 0 1px, transparent 1px 6px)',
                      }}
                    />
                    <p
                      className="font-display text-[17.5px] leading-[1.78]"
                      style={{ color: 'rgba(230,236,244,0.94)', letterSpacing: '0.005em' }}
                    >
                      <span
                        className="float-left mr-2 leading-none"
                        style={{
                          fontSize: 62,
                          lineHeight: 0.9,
                          paddingTop: 4,
                          color: accent,
                          fontWeight: 600,
                          textShadow: `0 2px 10px ${accent}33`,
                        }}
                      >
                        {first}
                      </span>
                      {restOfFirstWord}
                      {afterFirstWord}
                    </p>

                    {footnote && (
                      <div
                        className="mt-6 flex items-center justify-end gap-3 text-right"
                        style={{ color: 'rgba(198,210,226,0.6)' }}
                      >
                        <span
                          aria-hidden
                          className="h-px flex-1"
                          style={{ background: `linear-gradient(90deg, transparent, ${accent}55)` }}
                        />
                        <span className="font-mono text-[10.5px] italic tracking-[0.12em]">
                          logline · {footnote}
                        </span>
                      </div>
                    )}
                  </section>
                </div>
              )}
            </motion.div>

            {/* prev / next — flanks the image vertically, outside the
                breathing frame so they stay stable for navigation. */}
            {prevId && (
              <button
                type="button"
                onClick={() => openLightbox(prevId)}
                aria-label="Previous chapter"
                className="group absolute left-0 -translate-x-[calc(100%+18px)] -translate-y-1/2 flex flex-col items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.32em] transition-colors"
                style={{ color: 'rgba(198,210,226,0.55)', top: 'min(332px, 26.4vw)' }}
              >
                <span
                  className="flex h-11 w-11 items-center justify-center border transition-all group-hover:scale-110"
                  style={{ borderColor: `${accent}66`, color: accent, background: 'rgba(8,11,16,0.6)' }}
                >
                  <ChevronLeft size={18} strokeWidth={1.6} />
                </span>
                <span className="group-hover:text-white">prev</span>
              </button>
            )}
            {nextId && (
              <button
                type="button"
                onClick={() => openLightbox(nextId)}
                aria-label="Next chapter"
                className="group absolute right-0 translate-x-[calc(100%+18px)] -translate-y-1/2 flex flex-col items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.32em] transition-colors"
                style={{ color: 'rgba(198,210,226,0.55)', top: 'min(332px, 26.4vw)' }}
              >
                <span
                  className="flex h-11 w-11 items-center justify-center border transition-all group-hover:scale-110"
                  style={{ borderColor: `${accent}66`, color: accent, background: 'rgba(8,11,16,0.6)' }}
                >
                  <ChevronRight size={18} strokeWidth={1.6} />
                </span>
                <span className="group-hover:text-white">next</span>
              </button>
            )}
          </motion.div>
        </motion.article>
      </motion.div>
    </AnimatePresence>
  )
}
