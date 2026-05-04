'use client'

import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStory } from '@/lib/store'

/**
 * Detroit bracket connector. A short stub from the source, a clean vertical
 * spine, a short stub into the target. No glow on non-canon edges — Detroit
 * uses plain hairlines. Canon is a solid, saturated colour.
 */

// Detroit-style bracket geometry.
//   • SPINE_OFFSET — the bracket's vertical spine sits at least this far
//     from the source, giving every edge a visible source stub. If the
//     column is too narrow for that, the spine falls back to the midpoint.
//   • The + connector button sits at the MIDPOINT of the target-side
//     horizontal run (from the post-spine corner to the target handle).
//     This keeps breathing room symmetric around the button regardless of
//     whether the parent is a wide checkpoint or a narrow compact bar.
const RADIUS = 9
// Length of the parent-side stub before the bracket spine fans out.
// Bumped from 50 → 95 so the trunk + button has real breathing room
// on the stub and reads as a first-class affordance, not a crammed
// dot right next to the parent node.
const SPINE_OFFSET = 95

function computeSpine(sx: number, tx: number): number {
  const mid = (sx + tx) / 2
  return Math.min(sx + SPINE_OFFSET, mid)
}

/**
 * Hover-preview ghost shell — rendered while arm+ or trunk+ is hovered.
 * Geometry mirrors a compact sibling (272w, 80 thumb + 38 bar + 20
 * provenance strip) so the ghost reads as "this slot will hold a beat
 * that looks EXACTLY like the bars you already see".  Dashed gold + gold
 * shimmer + gold labels carry the ghost signal without changing shape.
 */
function GhostShellCard({ label = 'new moment' }: { label?: string }) {
  return (
    <div className="select-none" style={{ width: 272, opacity: 0.82 }}>
      {/* thumb (80) */}
      <div
        className="relative mb-1 w-full overflow-hidden bg-[#05070b]"
        style={{
          height: 80,
          clipPath: 'polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%)',
          boxShadow: '0 0 18px rgba(233,193,107,0.28)',
        }}
      >
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse"
          style={{ background: 'linear-gradient(110deg, #0f131b, #151a24, #0f131b)' }}
        />
        <div
          className="absolute inset-0 flex items-center justify-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.32em]"
          style={{ color: 'rgba(233,193,107,0.95)' }}
        >
          <span>new beat weaving…</span>
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ border: '1.5px dashed rgba(233,193,107,0.75)' }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'linear-gradient(100deg, transparent 35%, rgba(233,193,107,0.22) 50%, transparent 65%)',
            backgroundSize: '220% 100%',
            animation: 'shellShimmer 1.8s linear infinite',
            mixBlendMode: 'screen',
          }}
        />
      </div>
      {/* bar (38) */}
      <div
        className="relative flex items-center gap-2 px-3"
        style={{
          height: 38,
          clipPath: 'polygon(8px 0, 100% 0, 100% 100%, 0 100%)',
          background: 'linear-gradient(90deg, rgba(20,26,36,0.88) 0%, rgba(15,19,27,0.88) 100%)',
          boxShadow: 'inset 0 0 0 1px rgba(233,193,107,0.55)',
        }}
      >
        <span
          className="truncate font-display text-[11.5px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: 'rgba(233,193,107,0.92)' }}
        >
          {label}
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'linear-gradient(100deg, transparent 20%, rgba(233,193,107,0.26) 50%, transparent 80%)',
            backgroundSize: '220% 100%',
            animation: 'shellShimmer 1.6s linear infinite',
            clipPath: 'polygon(8px 0, 100% 0, 100% 100%, 0 100%)',
          }}
        />
      </div>
      {/* provenance strip (20) — keeps the ghost's total height flush with a real compact */}
      <div
        className="mt-2 flex items-center gap-2 px-1 font-mono text-[10.5px] uppercase tracking-[0.24em]"
        style={{ color: 'rgba(233,193,107,0.55)' }}
      >
        placeholder · weaving
      </div>
    </div>
  )
}

function bracketPath(sx: number, sy: number, tx: number, ty: number): string {
  const spine = computeSpine(sx, tx)
  const dy = ty - sy
  if (Math.abs(dy) < 1) return `M ${sx},${sy} L ${tx},${ty}`
  const sign = dy > 0 ? 1 : -1
  // Clamp the corner radius so it never exceeds half of either the vertical
  // run or the horizontal half-run — otherwise the quadratic corners would
  // overshoot their own anchor segments on tight edges.
  const halfH = (tx - sx) / 2
  const r = Math.max(1, Math.min(RADIUS, Math.abs(dy) / 2, halfH - 1))
  return [
    `M ${sx},${sy}`,
    `L ${spine - r},${sy}`,
    `Q ${spine},${sy} ${spine},${sy + sign * r}`,
    `L ${spine},${ty - sign * r}`,
    `Q ${spine},${ty} ${spine + r},${ty}`,
    `L ${tx},${ty}`,
  ].join(' ')
}

export function StoryEdge({
  source, target,
  sourceX, sourceY, targetX, targetY,
  data, markerEnd,
}: EdgeProps) {
  const meta = (data ?? {}) as { canon?: boolean; explored?: boolean }
  const path = bracketPath(sourceX, sourceY, targetX, targetY)
  const openInsertModal = useStory((s) => s.openInsertModal)
  // Four-tier edge palette.  Each tier is a CSS variable so the
  // light/dark theme flip adjusts all of them at once (see globals.css).
  //
  //   1. hover     (GOLD)        — target being hovered; always gold
  //                                regardless of canon status
  //   2. canon     (CYAN)        — the root-to-current spine
  //   3. explored  (mid grey)    — visited but off current canon
  //   4. unvisited (dim dashed)  — never walked
  //
  // Root edges are excluded from hover implicitly: the root has no
  // incoming edge.
  // Ghost-edge cue: when the target is an empty inserted shell (modal
  // just closed, writer-assist in flight), render the edge leading INTO
  // it as a dashed gold line — same visual language as the trunk+ hover
  // preview, so the user reads "the ghost I previewed is being built".
  const targetIsShell = useStory((s) => {
    const n = s.nodes.get(target)
    return !!(n && n.status === 'generating' && n.inserted && !n.title)
  })
  // Highlight the FULL ancestor chain of the hovered/selected node, not
  // just the one edge landing on it.  When the viewer hovers a leaf the
  // eye should follow the whole path back to root — that's the story
  // branch they're about to walk.  Walks parent pointers from the
  // anchor and returns true if this edge's target sits on that chain.
  const isHighlighted = useStory((s) => {
    const anchor = s.selectedId ?? s.edgeHighlightTargetId
    if (!anchor) return false
    let cursor: string | null = anchor
    while (cursor) {
      if (cursor === target) return true
      cursor = s.nodes.get(cursor)?.parentId ?? null
    }
    return false
  })

  const stroke = targetIsShell
    ? 'var(--gold)'
    : isHighlighted
      ? 'var(--edge-hover)'
      : meta.canon
        ? 'var(--edge-canon)'
        : meta.explored
          ? 'var(--edge-explored)'
          : 'var(--edge-unvisited)'
  const width = targetIsShell ? 1.4 : isHighlighted ? 2.4 : meta.canon ? 1.9 : meta.explored ? 1.3 : 1
  const dash = targetIsShell
    ? '5 4'
    : isHighlighted || meta.canon || meta.explored ? undefined : '4 4'
  const filter = targetIsShell
    ? 'drop-shadow(0 0 6px rgba(233,193,107,0.45))'
    : isHighlighted
      ? 'drop-shadow(0 0 7px var(--edge-hover-glow)) drop-shadow(0 0 2px var(--edge-hover))'
      : meta.canon
        ? 'drop-shadow(0 0 5px var(--edge-canon-glow))'
        : undefined

  // Two + buttons per edge with distinct semantics:
  //
  //   ARM +    — midpoint of the target-side horizontal run (between
  //              the post-spine corner and the target node).  Tied to
  //              a specific parent → child pair → opens the modal in
  //              CANON mode only (splice into the story between them).
  //
  //   TRUNK +  — midpoint of the source stub (between source node and
  //              the spine, BEFORE the fan-out).  Tied to the parent's
  //              outgoing line only → opens the modal in WHAT-IF mode
  //              (spawn a new sibling branch without touching any
  //              existing child).  All of a parent's child-edges draw
  //              this button at the same pixel spot, so visually the
  //              user sees one trunk + per parent.
  const spine = computeSpine(sourceX, targetX)
  const mx = (spine + RADIUS + targetX) / 2
  const my = targetY
  const tx = (sourceX + (spine - RADIUS)) / 2
  const ty = sourceY

  // Hover state lifts each + button into a live preview of WHAT it would
  // create.  The placement tells the user the SEMANTIC difference the two
  // buttons otherwise only encode through shape:
  //   • arm ghost   — sits at the edge midpoint, the actual splice slot
  //                   between parent and child ("new moment lands here")
  //   • trunk ghost — drifts downward from the + into open space below the
  //                   existing siblings, showing that a new branch grows
  //                   off the parent ("new what-if spawns here")
  const [armHover, setArmHover] = useState(false)
  const [trunkHover, setTrunkHover] = useState(false)

  // Trunk ghost = preview of a new sibling of `target` (one row below the
  // bottom-most sibling, in the same column).  We lean entirely on the
  // edge's own flow-space inputs (`targetX`, `targetY`) which React Flow
  // computes from the real handle position, so we don't have to reason
  // about the store's center-y / top-left-y coordinate split.
  //
  // Column: the target IS a sibling, so its column is the column we want.
  // `targetX` lands on the target's INCOMING handle (usually left edge of
  // the node), so the ghost card is aligned with the sibling bars by
  // pinning its left edge there too (no centre offset).
  //
  // Row: "below the last sibling" — we peek the store once to find the
  // deepest (highest y) sibling of the parent and drop the ghost one row
  // gap below it.  Falls back to `targetY + 140` if the map read gives
  // nothing usable.
  const trunkGhostPos = (() => {
    const s = useStory.getState()
    const src = s.nodes.get(source)
    // Top-left anchor: place the ghost card's TOP just below the last
    // sibling's bottom edge, aligned to the sibling column.  Compact bars
    // are 132 tall with their `n.y` at center, so their bottom sits 66
    // below n.y.  Add a breath of spacing so the ghost doesn't kiss the
    // sibling beneath it.
    const SIBLING_HALF_H = 66
    const V_SPACING = 28
    if (!src) return { x: targetX, y: targetY + SIBLING_HALF_H + V_SPACING }
    let maxY = targetY
    src.childrenIds.forEach((id) => {
      const n = s.nodes.get(id)
      if (typeof n?.y === 'number' && n.y > maxY) maxY = n.y
    })
    return { x: targetX, y: maxY + SIBLING_HALF_H + V_SPACING }
  })()

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth: width,
          strokeDasharray: dash,
          fill: 'none',
          filter,
          transition: 'stroke 160ms ease, stroke-width 160ms ease, filter 160ms ease',
        }}
      />

      <EdgeLabelRenderer>
        {/* ARM + GHOST — preview of where the spliced beat lands.  A dashed
            parallelogram bar at the edge midpoint (same spot the button
            implies), animated in on hover.  Pointer-events off so it can't
            steal the click from the actual button underneath. */}
        <AnimatePresence>
          {armHover && (
            // Outer positioning div — framer-motion manages the inner
            // motion.div's transform for its scale/opacity animation, so we
            // MUST NOT stack our own transform on the same element or
            // framer will silently clobber it (hard lesson: the arm ghost
            // was pinned at viewport origin because we did).
            <div
              key="arm-ghost"
              className="nodrag nopan pointer-events-none absolute"
              style={{
                transform: `translate(-50%, -50%) translate(${mx}px, ${my}px)`,
                zIndex: 48,
              }}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <GhostShellCard label="new moment" />
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* ARM + — canon splice between this parent/child pair */}
        <div
          className="nodrag nopan absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${mx}px, ${my}px)`,
            // Above both the edge SVG and the node layer so the + button is
            // always clickable regardless of where it falls on the canvas.
            zIndex: 50,
            pointerEvents: 'auto',
          }}
          onMouseEnter={() => setArmHover(true)}
          onMouseLeave={() => setArmHover(false)}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              openInsertModal(source, target, 'canon')
            }}
            className={
              meta.canon
                // On canon edges the line is cyan too, so the button MUST be
                // opaque and the + icon must not be cyan — otherwise the
                // icon bleeds into the line passing behind. Gold on dark
                // inverts the palette cleanly.  Bg is a theme token so
                // the button reads on both light and dark backdrops.
                ? 'group/insert relative flex h-8 w-8 cursor-pointer items-center justify-center border-[1.5px] border-[var(--gold)] bg-[var(--surface-hi)] text-[var(--gold)] shadow-[0_0_12px_rgba(233,193,107,0.35)] transition-all duration-150 hover:scale-110 hover:shadow-[0_0_20px_rgba(233,193,107,0.7)] focus-visible:outline-none'
                : 'group/insert relative flex h-8 w-8 cursor-pointer items-center justify-center border-[1.5px] border-[var(--cyan)] bg-[var(--surface-panel)] text-[var(--cyan)] shadow-[0_0_10px_rgba(79,195,247,0.35)] backdrop-blur-[2px] transition-all duration-150 hover:bg-[var(--surface-hi)] hover:scale-110 hover:shadow-[0_0_18px_rgba(79,195,247,0.7)] focus-visible:outline-none'
            }
            style={{
              clipPath: 'polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%)',
            }}
            title="Splice a moment into the story, between these two beats"
          >
            <Plus size={15} strokeWidth={2.6} />
          </button>
        </div>

        {/* TRUNK + — what-if sibling, attached to the parent's outgoing
            stub.  All child-edges draw this at the same pixel, so the
            user sees one button per parent.

            Visual language: a DASHED CIRCLE in muted ink — literally a
            "ghost branch waiting to be born".  Reads immediately as
            different from the arm +'s solid parallelogram (which is
            canon / decisive).  Hover solidifies the outline into gold,
            scales up, pulses a glow — the ghost "takes form". */}
        {/* TRUNK + GHOST — preview of where a new what-if sibling lands.
            The connector reuses the edge's bracket geometry so the ghost
            line reads as a continuation of the real edge family (same
            stub-spine-stub shape, just dashed and muted).  Ghost card sits
            in the sibling column, one row below the last existing sibling.
            Pointer-events off so the button stays clickable. */}
        <AnimatePresence>
          {trunkHover && (
            <>
              {/* Connector is a plain SVG (no framer transform on the svg
                  itself — opacity only) pinned at the flow origin with
                  overflow:visible so absolute path coords paint where we
                  say they should. */}
              <motion.svg
                key="trunk-ghost-line"
                className="nodrag nopan pointer-events-none absolute"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                style={{
                  left: 0, top: 0, overflow: 'visible',
                  width: 1, height: 1,
                  zIndex: 47,
                }}
              >
                <path
                  d={bracketPath(
                    sourceX,
                    sourceY,
                    trunkGhostPos.x,
                    // GhostShellCard's ribbon midline — 80 thumb + 4 gap + 19
                    // half-bar — same geometry as a real compact sibling so
                    // the dashed incoming edge lands in the same Y as the
                    // adjacent solid edges above it.
                    trunkGhostPos.y + 80 + 4 + 19,
                  )}
                  fill="none"
                  stroke="var(--gold)"
                  strokeWidth={1.3}
                  strokeDasharray="5 4"
                />
              </motion.svg>
              {/* Outer div does flow-space positioning.  Inner motion.div
                  handles scale/opacity animation only — framer manages
                  transform, so stacking our positional transform on the
                  animated element would be silently clobbered. */}
              <div
                key="trunk-ghost-card"
                className="nodrag nopan pointer-events-none absolute"
                style={{
                  transform: `translate(${trunkGhostPos.x}px, ${trunkGhostPos.y}px)`,
                  zIndex: 48,
                }}
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.92 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  <GhostShellCard label="new choice" />
                </motion.div>
              </div>
            </>
          )}
        </AnimatePresence>

        <div
          className="nodrag nopan absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${tx}px, ${ty}px)`,
            zIndex: 49,
            pointerEvents: 'auto',
          }}
          onMouseEnter={() => setTrunkHover(true)}
          onMouseLeave={() => setTrunkHover(false)}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              openInsertModal(source, target, 'what-if')
            }}
            className="group/whatif flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-full transition-all duration-180 focus-visible:outline-none hover:scale-110"
            style={{
              // Theme-aware panel: dark on night, pale on day — both
              // keep the dashed border and ink-dim + visible.
              background: 'var(--surface-panel)',
              border: '1.2px dashed var(--ink-faint)',
              color: 'var(--ink-dim)',
              backdropFilter: 'blur(2px)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.border = '1.2px solid var(--gold)'
              e.currentTarget.style.color = 'var(--gold)'
              e.currentTarget.style.background = 'var(--surface-hi)'
              e.currentTarget.style.boxShadow = '0 0 14px rgba(233,193,107,0.45), 0 0 3px rgba(233,193,107,0.8)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.border = '1.2px dashed var(--ink-faint)'
              e.currentTarget.style.color = 'var(--ink-dim)'
              e.currentTarget.style.background = 'var(--surface-panel)'
              e.currentTarget.style.boxShadow = 'none'
            }}
            title="Spawn a what-if sibling on this branch"
          >
            <Plus size={13} strokeWidth={2.4} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const edgeTypes = { story: StoryEdge }
