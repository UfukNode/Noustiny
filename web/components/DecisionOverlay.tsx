'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { useMemo, useState } from 'react'
import type { MouseEvent, ReactNode, CSSProperties } from 'react'
import { Sparkles } from 'lucide-react'
import { useStory } from '@/lib/store'
import type { NodeMood, StoryNode as TStoryNode } from '@/lib/types'

/** PlayStation-style glyph cycled per option position — △ ○ □.  The
 *  square replaces the cross (✕) deliberately: in a web UI the cross
 *  reads as "close / dismiss" and would mis-signal the option as a
 *  destructive action.  All three are pure unicode, crisp at 11-14px. */
const OPTION_GLYPHS = ['△', '○', '□'] as const

/**
 * Decision Overlay — Detroit-style in-scene choice prompt floating on
 * the current checkpoint's image.
 *
 * Two modes (one component, behaviour switches on whether the node
 * already has children):
 *
 *  - **MODE A** (leaf, no children yet).  The beat is asking its
 *    question but the answers aren't generated yet.  Shows a loader
 *    until brainstorm fires — triggered externally, not here.
 *
 *  - **MODE B** (has children).  The canonical answer glows cyan/gold,
 *    the other answers are faded "WHAT-IF" alternates.  Clicking a
 *    what-if rewires canon to that branch without deleting any node,
 *    so the user can walk every life without losing work.
 *
 * Deliberately minimal chrome — this lives on top of a photograph, it
 * must not compete with it.  Bracket frame (Detroit motif), thin
 * mood-tinted border, 1-pixel hairlines between options.
 */

const MOOD_BORDER: Record<NodeMood, string> = {
  neutral:   'rgba(180, 195, 220, 0.62)',
  hopeful:   'rgba(233, 193, 107, 0.75)',
  tense:     'rgba(255, 159, 64, 0.75)',
  danger:    'rgba(231, 76, 60, 0.78)',
  climax:    'rgba(255, 211, 120, 0.82)',
  quiet:     'rgba(100, 160, 220, 0.68)',
  discovery: 'rgba(167, 139, 250, 0.75)',
}

/** Solid, fully-saturated mood colour — reserved for accents that need
 *  to pop (e.g. the hover-revealed option glyphs).  MOOD_BORDER uses
 *  alpha-reduced variants for border hairlines where the colour must
 *  fade against dark bg; MOOD_ACCENT is what the eye reads as "this is
 *  the mood's voice".
 *
 *  `neutral` uses the Detroit cyan rather than a desaturated grey —
 *  otherwise on a "neutral" story beat the hover flip is imperceptible
 *  against the rest state's pale-white glyph.  Cyan is the app's
 *  signature accent, so it reads correctly as "interactive". */
const MOOD_ACCENT: Record<NodeMood, string> = {
  neutral:   '#4fc3f7',
  hopeful:   '#e9c16b',
  tense:     '#ff9f40',
  danger:    '#e74c3c',
  climax:    '#ffd378',
  quiet:     '#64a0dc',
  discovery: '#a78bfa',
}

const MOOD_SOFT: Record<NodeMood, string> = {
  neutral:   'rgba(180, 195, 220, 0.15)',
  hopeful:   'rgba(233, 193, 107, 0.18)',
  tense:     'rgba(255, 159, 64, 0.20)',
  danger:    'rgba(231, 76, 60, 0.20)',
  climax:    'rgba(255, 211, 120, 0.25)',
  quiet:     'rgba(100, 160, 220, 0.16)',
  discovery: 'rgba(167, 139, 250, 0.18)',
}

export function DecisionOverlay({
  node,
  onAskAgain,
  askInflight,
  embedded = false,
  onAfterPick,
}: {
  node: TStoryNode
  /** Called when a leaf node has no question yet and the user clicks
   *  "Ask Hermes".  Wires to the hermes-client brainstorm. */
  onAskAgain: () => void
  askInflight: boolean
  /** When true, this overlay lives inside a parent that already applies
   *  perspective (e.g. the lightbox stage).  Disables its own tilt and
   *  scales up sizes so it reads on a full-screen image instead of a
   *  320-wide thumb.  The parent's transform carries both image and
   *  overlay as one composite — that's the "3D-glasses" feel. */
  embedded?: boolean
  /** Fires after the pick commits.  Lightbox passes ``closeLightbox``
   *  here so picking an option dismisses the modal — same outcome as
   *  picking from the flowchart card, just from inside the zoomed
   *  view. */
  onAfterPick?: () => void
}) {
  const setCurrent = useStory((s) => s.setCurrent)
  const nodes = useStory((s) => s.nodes)
  const currentId = useStory((s) => s.currentId)
  const setEdgeHighlightTarget = useStory((s) => s.setEdgeHighlightTarget)

  const children = node.childrenIds
    .map((id) => nodes.get(id))
    .filter((n): n is TStoryNode => !!n)

  // Only the checkpoint's own children are "live" decisions.  For a
  // historical visited node the decision is resolved: one child is the
  // canon ancestor of the current cursor.  We highlight that one.
  const canonSet = useMemo(() => {
    const set = new Set<string>()
    let cursor: string | null = currentId
    while (cursor) {
      set.add(cursor)
      const n = nodes.get(cursor)
      cursor = n?.parentId ?? null
    }
    return set
  }, [nodes, currentId])

  const isTerminal = node.childrenIds.length === 0 && node.status === 'canon'
  const borderColor = MOOD_BORDER[node.mood]
  const softBg = MOOD_SOFT[node.mood]
  const accentSolid = MOOD_ACCENT[node.mood]
  const displayQuestion = (node.question ?? '').trim() || 'What happens next?'

  // Active click guard — prevents committing the same option twice
  // while the previous setCurrent + relayout is still running.
  const [committing, setCommitting] = useState<string | null>(null)
  // Row-level hover — needed so the accent-coloured glyph flips to
  // dark ink when the button's background fills with accent, otherwise
  // glyph-on-accent vanishes.
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [askHover, setAskHover] = useState(false)

  const onPick = (childId: string) => {
    if (committing) return
    // Idempotent: clicking the already-current canon path is a no-op.
    if (childId === currentId) return
    setCommitting(childId)
    // Let the commit flash play before we actually move.
    setTimeout(() => {
      setCurrent(childId, 'human')
      setCommitting(null)
      // Lightbox dismissal — embedded host (ImageLightbox) hands
      // closeLightbox() in via onAfterPick so the pick lands on the
      // canvas with the full tree visible, not behind the modal.
      onAfterPick?.()
    }, 220)
  }

  return (
    <div
      // bottom-8 clears the title ribbon (-mt-6 pulls it over image bottom 24px).
      className={`pointer-events-auto absolute z-20 flex flex-col ${embedded ? 'right-6 bottom-6' : 'right-3 bottom-8'}`}
      style={{
        minWidth: embedded ? 280 : 166,
        maxWidth: embedded ? 340 : 210,
        // When embedded, the parent stage is a preserve-3d plane that
        // breathes (rotateY/X).  translateZ lifts the overlay off the
        // image plane so rotation reveals real parallax between them —
        // the "3D glasses" feel the user wants.  When standalone
        // (Detroit flowchart card), self-tilt anchors the overlay to
        // the bottom-right corner.
        transform: embedded
          ? 'translateZ(48px)'
          : 'perspective(840px) rotateY(-25deg) rotateX(7deg)',
        transformOrigin: 'right bottom',
        filter: `drop-shadow(0 8px 24px rgba(0,0,0,0.55)) drop-shadow(0 0 18px ${borderColor}28)`,
      }}
      onClick={(e: MouseEvent) => e.stopPropagation()}
    >
      <BracketFrame color={borderColor}>
        <div
          className={embedded ? 'px-4 py-3' : 'px-2.5 py-2'}
          style={{
            background: embedded ? 'rgba(8, 11, 16, 0.62)' : 'rgba(8, 11, 16, 0.86)',
            backdropFilter: embedded ? 'blur(10px) saturate(110%)' : 'blur(6px)',
          }}
        >
          {/* Question micro-line */}
          <div
            className={`font-display uppercase ${embedded ? 'mb-2.5 text-[11px] tracking-[0.26em]' : 'mb-1.5 text-[9.5px] tracking-[0.24em]'}`}
            style={{ color: 'rgba(230,236,244,0.85)' }}
          >
            {displayQuestion}
          </div>

          {/* Option list OR loader / ask button */}
          {children.length === 0 ? (
            askInflight ? (
              <LoaderRow accent={borderColor} label="HERMES ASKING…" />
            ) : isTerminal ? (
              <div
                className="flex items-center gap-2 px-1 py-1 font-mono text-[9.5px] uppercase tracking-[0.24em]"
                style={{ color: 'rgba(198,210,226,0.6)' }}
              >
                end of this life
              </div>
            ) : (
              // Ask-Hermes affordance — full invert on hover so the
              // button visibly declares itself clickable, matching the
              // Detroit flip pattern used elsewhere.  Embedded mode
              // bumps sizing so the button reads at lightbox scale.
              <motion.button
                type="button"
                onClick={onAskAgain}
                disabled={askInflight}
                whileHover={askInflight ? undefined : { scale: 1.015 }}
                whileTap={askInflight ? undefined : { scale: 0.97 }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
                className={`group flex w-full items-center font-display uppercase transition-colors ${
                  embedded
                    ? 'gap-3 px-3 py-2.5 text-[13px] tracking-[0.24em]'
                    : 'gap-2 px-2 py-1.5 text-[11px] tracking-[0.22em]'
                }`}
                style={{
                  color: askInflight
                    ? 'rgba(230,236,244,0.4)'
                    : askHover ? '#0a0d12' : 'rgba(230,236,244,0.96)',
                  background: askHover && !askInflight ? borderColor : softBg,
                  border: `1px solid ${borderColor}`,
                  boxShadow: askHover && !askInflight
                    ? `0 0 18px ${borderColor}, 0 0 2px ${borderColor}`
                    : 'none',
                  opacity: askInflight ? 0.45 : 1,
                  cursor: askInflight ? 'not-allowed' : 'pointer',
                }}
                onMouseEnter={() => !askInflight && setAskHover(true)}
                onMouseLeave={() => setAskHover(false)}
              >
                <Sparkles size={embedded ? 12 : 10} strokeWidth={2} />
                {askInflight ? 'asking…' : 'Ask Hermes'}
              </motion.button>
            )
          ) : (
            <AnimatePresence initial={false}>
              {/* Cap visible options at ~5 — anything beyond scrolls
                  inside a themed thin-cyan scrollbar so the overlay
                  never grows past the image's bottom edge.  Heights
                  tuned to row metrics: ~33px per row at flowchart
                  scale, ~44px embedded (lightbox). */}
              <div
                className="flex flex-col overflow-y-auto [&::-webkit-scrollbar-thumb]:bg-[var(--cyan)] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-[3px]"
                style={{
                  maxHeight: embedded ? 220 : 175,
                  scrollbarWidth: 'thin',
                  scrollbarColor: 'var(--cyan) transparent',
                }}
              >
                {(() => {
                  // Decision is "resolved" only when one child is already on
                  // canon (user has walked into it).  Otherwise all three are
                  // just pending choices — no "CHOSEN / WHAT-IF" tag, no
                  // historical framing.
                  const anyCanon = children.some((c) => canonSet.has(c.id))
                  return children.map((c, i) => {
                    const isCanon = canonSet.has(c.id)
                    const isCommitting = committing === c.id
                    const isDimmed = committing !== null && !isCommitting
                    const label = (c.label ?? c.title ?? 'CHOOSE').toUpperCase().slice(0, 18)
                    const glyph = OPTION_GLYPHS[i % OPTION_GLYPHS.length]
                    const isHovered = hoveredId === c.id && !isCanon && committing === null
                    return (
                      <motion.button
                        key={c.id}
                        type="button"
                        initial={{ opacity: 0, x: 6 }}
                        animate={{ opacity: isDimmed ? 0.3 : 1, x: 0 }}
                        transition={{ duration: 0.22, delay: i * 0.08, ease: 'easeOut' }}
                        whileTap={{ scale: 0.97 }}
                        onClick={() => onPick(c.id)}
                        disabled={committing !== null}
                        className={`group flex items-center text-left font-display uppercase transition-colors ${
                          embedded
                            ? 'gap-3 px-3 py-2.5 text-[13px] tracking-[0.24em]'
                            : 'gap-2.5 px-2.5 py-2 text-[11px] tracking-[0.22em]'
                        }`}
                        style={{
                          // Hairline separator between options — gradient
                          // fades at the ends so it doesn't punch through the
                          // bracket frame corners.
                          borderTop: i === 0
                            ? 'none'
                            : `1px solid`,
                          borderImage: i === 0
                            ? undefined
                            : `linear-gradient(90deg, transparent 0%, ${borderColor}44 30%, ${borderColor}44 70%, transparent 100%) 1`,
                          color: isCanon ? '#0a0d12' : 'rgba(230,236,244,0.92)',
                          // Row bg is intentionally subtle — only the
                          // glyph colours up on hover.  Strong accent
                          // fill is reserved for the commit flash and
                          // the canon/chosen state so the hover doesn't
                          // compete with them.
                          background: isCommitting
                            ? borderColor
                            : isCanon
                              ? softBg
                              : isHovered
                                ? softBg
                                : 'transparent',
                          boxShadow: isCommitting ? `0 0 16px ${borderColor}` : 'none',
                          cursor: committing !== null ? 'default' : 'pointer',
                        }}
                        onMouseEnter={() => {
                          if (isCanon || isCommitting || committing !== null) return
                          setHoveredId(c.id)
                          // Light up the edge + card landing on this
                          // child — "this choice leads here" preview.
                          // Skipped in embedded mode (lightbox) since
                          // the canvas isn't visible behind it.
                          if (!embedded) setEdgeHighlightTarget(c.id)
                        }}
                        onMouseLeave={() => {
                          setHoveredId(null)
                          if (!embedded) setEdgeHighlightTarget(null)
                        }}
                        data-cursor="pointer"
                      >
                        <span
                          className={`inline-flex items-center justify-center font-mono leading-none transition-all duration-150 ${
                            embedded ? 'h-5 w-5 text-[14px]' : 'h-4 w-4 text-[11px]'
                          }`}
                          style={{
                            // Rest = muted outline, hover = solid mood
                            // accent + glow + slight scale.  The triple
                            // change (colour, shadow, size) makes the
                            // flip unmistakable even on "neutral" mood
                            // where the accent is closest to the rest.
                            color: isCommitting
                              ? '#0a0d12'
                              : isCanon
                                ? '#0a0d12'
                                : isHovered
                                  ? accentSolid
                                  : 'rgba(230,236,244,0.32)',
                            opacity: isCanon ? 0.85 : 1,
                            textShadow: isHovered
                              ? `0 0 10px ${accentSolid}, 0 0 2px ${accentSolid}cc`
                              : 'none',
                            transform: isHovered ? 'scale(1.25)' : 'scale(1)',
                          }}
                        >
                          {glyph}
                        </span>
                        <span className="flex-1 truncate">{label}</span>
                        {anyCanon && isCanon && (
                          <span
                            className="font-mono text-[8.5px] tracking-[0.22em]"
                            style={{ color: 'rgba(10,13,18,0.75)' }}
                          >
                            CHOSEN
                          </span>
                        )}
                        {anyCanon && !isCanon && (
                          <span
                            className="font-mono text-[8.5px] tracking-[0.22em]"
                            style={{ color: 'rgba(198,210,226,0.55)' }}
                          >
                            WHAT-IF
                          </span>
                        )}
                      </motion.button>
                    )
                  })
                })()}
              </div>
            </AnimatePresence>
          )}
        </div>
      </BracketFrame>
    </div>
  )
}

function BracketFrame({ color, children }: { color: string; children: ReactNode }) {
  // 4 small L-corner brackets drawn with thin cyan-tinted lines — the
  // Detroit flowchart motif.  Wrap the overlay body with just enough
  // padding to give the brackets room to breathe.
  return (
    <div className="relative">
      <Corner pos="tl" color={color} />
      <Corner pos="tr" color={color} />
      <Corner pos="bl" color={color} />
      <Corner pos="br" color={color} />
      {children}
    </div>
  )
}

function Corner({ pos, color }: { pos: 'tl' | 'tr' | 'bl' | 'br'; color: string }) {
  const size = 10
  const thickness = 1
  const side = 1
  const coords: CSSProperties =
    pos === 'tl' ? { top: -side, left: -side, borderTop: `${thickness}px solid ${color}`, borderLeft: `${thickness}px solid ${color}` } :
    pos === 'tr' ? { top: -side, right: -side, borderTop: `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` } :
    pos === 'bl' ? { bottom: -side, left: -side, borderBottom: `${thickness}px solid ${color}`, borderLeft: `${thickness}px solid ${color}` } :
                   { bottom: -side, right: -side, borderBottom: `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` }
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute"
      style={{ width: size, height: size, ...coords }}
    />
  )
}

function LoaderRow({ accent, label }: { accent: string; label: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-1 font-mono text-[9.5px] uppercase tracking-[0.28em]" style={{ color: accent }}>
      <span className="inline-flex items-center gap-[3px]">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="inline-block"
            style={{ width: 3, height: 3, background: accent, borderRadius: 1 }}
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
          />
        ))}
      </span>
      <span>{label}</span>
    </div>
  )
}

