'use client'

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { motion } from 'framer-motion'
import {
  AlertTriangle, Skull, Heart, Sparkles, Eye, MessageCircle,
  Lock, Maximize2, Check, ChevronRight, ArrowRight, X, Bot, User,
  Undo2, ShieldAlert, RefreshCw, Film,
} from 'lucide-react'
import type { ComponentType, CSSProperties, MouseEvent, SVGProps } from 'react'
import { useState } from 'react'
import type { NodeMood, Scene, StoryNode as TStoryNode } from '@/lib/types'
import { useStory } from '@/lib/store'
import { variantOf, COMPACT_RIBBON_Y, CHECKPOINT_HEIGHT, COMPACT_HEIGHT } from '@/lib/layout'
import { expandNode, reharmonize, generateNodeImage } from '@/lib/hermes-client'
import { DecisionOverlay } from './DecisionOverlay'

// Scene overlay palette. Act-coloured stripe + pill tag appear on nodes that
// belong to the currently hovered scene (from the ScenesList panel). Nodes
// that are NOT members of the hovered scene dim to 0.45 opacity so the
// reader's eye locks onto the subset the agent grouped together.
const ACT_ACCENT: Record<1 | 2 | 3, string> = {
  1: '#4fc3f7',
  2: '#e9c16b',
  3: '#c7a7ff',
}
function sceneAccent(scene: Scene): string {
  if (scene.actNumber === 1 || scene.actNumber === 2 || scene.actNumber === 3) {
    return ACT_ACCENT[scene.actNumber]
  }
  return '#4fc3f7'
}
function sceneActRoman(n: 1 | 2 | 3 | undefined): string {
  if (n === 1) return 'I'
  if (n === 2) return 'II'
  if (n === 3) return 'III'
  return ''
}

/** Subscribe to scene focus state. Returns:
 *  - `hovered`: the scene currently hovered in the panel (or null)
 *  - `thisNodeScene`: the scene this node belongs to (or null)
 *  - `isMember`: true when the node belongs to the hovered scene
 *  - `isDim`: true when a scene is hovered and this node is NOT a member
 */
function useSceneFocus(nodeId: string): {
  hovered: Scene | null
  thisNodeScene: Scene | null
  isMember: boolean
  isDim: boolean
} {
  const hovered = useStory((s) =>
    s.hoveredSceneId ? s.scenes.get(s.hoveredSceneId) ?? null : null,
  )
  const thisNodeScene = useStory((s) => {
    for (const scene of s.scenes.values()) {
      if (scene.nodeIds.includes(nodeId)) return scene
    }
    return null
  })
  const isMember = !!hovered && hovered.nodeIds.includes(nodeId)
  const isDim = !!hovered && !isMember
  return { hovered, thisNodeScene, isMember, isDim }
}

type Props = NodeProps & { data: { node: TStoryNode } }

// Detroit uses a handful of small glyphs to signal the type of choice.
type LucideLike = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number; style?: CSSProperties }
>
const MOOD_ICON: Record<NodeMood, LucideLike> = {
  neutral: ArrowRight,
  hopeful: Sparkles,
  tense: AlertTriangle,
  danger: Skull,
  climax: Sparkles,
  quiet: Heart,
  discovery: Eye,
}

// The mood colour only shows through on non-selected bars; selected bars paint
// solid cyan and the glyph inverts.
const MOOD_TINT: Record<NodeMood, string> = {
  neutral: '#8a96aa',
  hopeful: '#e9c16b',
  tense: '#e9c16b',
  danger: '#e74c3c',
  climax: '#e9c16b',
  quiet: '#8a96aa',
  discovery: '#4fc3f7',
}

// -----------------------------------------------------------------------------
// Helpers

function staleBorder(node: TStoryNode): string | null {
  if (node.staleState === 'stale') return '#e9c16b'
  if (node.staleState === 'unresolved') return '#e74c3c'
  if (node.staleState === 'rewritten') return 'rgba(79,195,247,0.75)'
  return null
}

// -----------------------------------------------------------------------------
// Compact thumbnail — a ~80px preview that sits above the ribbon.  While the
// real image pipeline (FLUX / Nano Banana per policy) is rendering, the
// thumbnail shows a "HERMES IMAGINING…" loader so the demo viewer SEES the
// agent working on the visuals.  Swaps in the real image the moment the
// cached URL lands on the node.
// -----------------------------------------------------------------------------

function CompactThumb({ node }: { node: TStoryNode }) {
  const [loaded, setLoaded] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const openLightbox = useStory((s) => s.openLightbox)
  const isReal = typeof node.imageUrl === 'string' && node.imageUrl.startsWith('/cache/images/')
  // Shell = inserted placeholder whose writer-assist hasn't returned yet.
  // Styled in gold (ghost) instead of cyan (imagining) to read as "being
  // placed here" rather than "loading a real beat".
  const isShell = node.status === 'generating' && !!node.inserted && !node.title

  const retry = async (e: MouseEvent) => {
    e.stopPropagation()
    if (retrying) return
    const prompt = node.imagePrompt || node.summary || node.title
    if (!prompt) return
    setRetrying(true)
    try {
      await generateNodeImage(node.id, prompt)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      className="group/thumb relative mb-1 w-full cursor-zoom-in overflow-hidden bg-[#05070b]"
      style={{
        height: 80,
        clipPath: 'polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
      }}
      onClick={(e: MouseEvent) => { e.stopPropagation(); openLightbox(node.id) }}
      data-cursor="zoom"
    >
      {/* skeleton pulse while no real image exists yet */}
      {!isReal && (
        <div
          className="absolute inset-0 animate-pulse"
          style={{ background: 'linear-gradient(110deg, #0f131b, #151a24, #0f131b)' }}
        />
      )}
      {isReal && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={node.imageUrl}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          className="h-full w-full object-cover transition-opacity duration-500"
          style={{
            opacity: loaded ? 1 : 0,
            filter: node.status === 'visited' ? 'grayscale(0.3) brightness(0.82)' : undefined,
          }}
        />
      )}
      {/* loader overlay — cyan "hermes imagining…" for brainstorm siblings,
          gold "new beat weaving…" for inserted shells, gold "hermes weaving…"
          on retry click. */}
      {!isReal && (() => {
        const gold = isShell || retrying
        const color = gold ? 'rgba(233,193,107,0.95)' : 'rgba(123,206,243,0.9)'
        const dot = gold ? '#e9c16b' : '#4fc3f7'
        const label = isShell
          ? 'new beat weaving…'
          : retrying ? 'hermes weaving…' : 'hermes imagining…'
        return (
          <div
            className="absolute inset-0 flex items-center justify-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.32em]"
            style={{ color }}
          >
            <span className="flex items-center gap-[3px]">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="inline-block rounded-sm"
                  style={{ width: 3, height: 3, background: dot }}
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: gold ? 0.7 : 1.1, repeat: Infinity, delay: i * 0.18 }}
                />
              ))}
            </span>
            <span>{label}</span>
          </div>
        )
      })()}
      {/* Ghost shell — dashed gold frame + shimmer sweep.  Same visual
          language as the trunk+ hover preview, so pre-insert promise and
          post-insert placeholder read as the same object. */}
      {isShell && (
        <>
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
        </>
      )}
      {/* vignette for ribbon contrast */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(10,13,18,0.12) 0%, transparent 45%, rgba(10,13,18,0.6) 100%)',
        }}
      />
      <div className="pointer-events-none absolute inset-0 scan-line opacity-20" />
      {!isReal && !retrying && !isShell && node.imagePrompt && (
        <button
          type="button"
          onClick={retry}
          title="Retry image render"
          data-cursor="pointer"
          className="absolute right-1.5 top-1.5 flex h-5 items-center gap-1 border border-[var(--gold)] bg-[rgba(10,13,18,0.88)] px-1.5 font-mono text-[8.5px] uppercase tracking-[0.26em] text-[var(--gold)] opacity-0 transition-opacity duration-150 hover:bg-[rgba(233,193,107,0.14)] group-hover/thumb:opacity-100"
          style={{ clipPath: 'polygon(4px 0, 100% 0, calc(100% - 4px) 100%, 0 100%)' }}
        >
          <RefreshCw size={9} strokeWidth={2.2} />
          retry
        </button>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Compact choice bar (Detroit ribbon style)
// -----------------------------------------------------------------------------

function CompactBar({ node }: { node: TStoryNode }) {
  const setCurrent = useStory((s) => s.setCurrent)
  const setSelected = useStory((s) => s.setSelected)
  const selectedId = useStory((s) => s.selectedId)
  const edgeHighlightTargetId = useStory((s) => s.edgeHighlightTargetId)
  const removeInserted = useStory((s) => s.removeInserted)
  const revertRewrite = useStory((s) => s.revertRewrite)
  const keepStale = useStory((s) => s.keepStale)
  const isHover = selectedId === node.id || edgeHighlightTargetId === node.id
  const MoodIcon = MOOD_ICON[node.mood]
  const staleTint = staleBorder(node)
  const { hovered, isMember, isDim } = useSceneFocus(node.id)
  const accent = hovered ? sceneAccent(hovered) : null
  // Shell styling — see CompactThumb for the matching thumb ghost treatment.
  const isShell = node.status === 'generating' && !!node.inserted && !node.title

  // Sibling index for staggered reveal — newly-brainstormed siblings
  // appear 150ms apart so three branches cascade in, Detroit-style,
  // instead of popping in together.
  const siblingIndex = useStory((s) => {
    if (!node.parentId) return 0
    const parent = s.nodes.get(node.parentId)
    if (!parent) return 0
    const i = parent.childrenIds.indexOf(node.id)
    return i < 0 ? 0 : i
  })
  const revealDelay = Math.min(siblingIndex * 0.14, 0.6)

  // Visual states: canon bar is solid cyan; visited and unvisited share the
  // SAME base fill so a branch you've navigated away from reads as a fresh
  // option again. The only cue that a branch has been walked is the small
  // ✓ mark at the end — no colour shift, no muting.
  const onCanon = node.status === 'canon' || node.status === 'current'
  const isVisited = node.status === 'visited'

  let barBg: string
  let titleColor: string
  let iconColor: string
  let chipBg: string
  let chipText: string

  if (isShell) {
    barBg = 'linear-gradient(90deg, rgba(20,26,36,0.88) 0%, rgba(15,19,27,0.88) 100%)'
    titleColor = 'rgba(233,193,107,0.92)'
    iconColor = 'rgba(233,193,107,0.8)'
    chipBg = 'rgba(15,19,27,0.96)'
    chipText = 'rgba(233,193,107,0.85)'
  } else if (onCanon) {
    barBg = 'linear-gradient(90deg, #1aa1e0 0%, #4fc3f7 100%)'
    titleColor = '#0a0d12'
    iconColor = '#0a0d12'
    chipBg = '#0a0d12'
    chipText = '#4fc3f7'
  } else {
    barBg = 'rgba(20,26,36,0.88)'
    titleColor = 'rgba(230,236,244,0.9)'
    iconColor = MOOD_TINT[node.mood]
    chipBg = 'rgba(15,19,27,0.96)'
    chipText = 'rgba(230,236,244,0.9)'
  }

  const outline = isShell
    ? 'inset 0 0 0 1px rgba(233,193,107,0.55)'
    : staleTint
      ? `inset 0 0 0 1.5px ${staleTint}, 0 0 10px ${staleTint}40`
      : isHover
        ? 'inset 0 0 0 1px var(--cyan)'
        : 'inset 0 0 0 1px rgba(255,255,255,0.08)'

  return (
    <motion.div
      initial={{ opacity: 0, x: -10, y: 4 }}
      animate={{
        opacity: isDim ? 0.4 : 1,
        x: 0, y: 0,
        scale: isHover ? 1.01 : 1,
      }}
      transition={{ duration: 0.3, ease: 'easeOut', delay: revealDelay }}
      whileTap={{ scale: 0.985 }}
      onClick={(e: MouseEvent) => { e.stopPropagation(); setCurrent(node.id) }}
      data-cursor="hover"
      className="group relative select-none"
      style={{
        width: 272,
        filter: isMember && accent
          ? `drop-shadow(0 0 10px ${accent}55)`
          : isHover && !onCanon
            ? `drop-shadow(0 0 12px ${MOOD_TINT[node.mood]}44)`
            : undefined,
      }}
    >
      {/* Scene membership pill — appears when this node is part of the
          scene currently hovered in the ScenesList panel. */}
      {isMember && hovered && accent && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="pointer-events-none absolute z-30 inline-flex items-center gap-1.5 px-2 py-[3px] font-display text-[9px] font-semibold uppercase tracking-[0.3em]"
          style={{
            top: -14,
            left: 6,
            background: 'rgba(10,13,18,0.96)',
            color: accent,
            border: `1px solid ${accent}`,
            boxShadow: `0 0 10px ${accent}55`,
          }}
        >
          <span>ACT {sceneActRoman(hovered.actNumber)}</span>
          <span style={{ color: 'rgba(230,236,244,0.85)' }}>· {hovered.label}</span>
          {hovered.motif && (
            <span className="font-mono text-[8px] tracking-[0.24em]" style={{ color: 'rgba(198,210,226,0.7)' }}>
              · {hovered.motif}
            </span>
          )}
        </motion.div>
      )}
      {/* Source handle sits JUST past the chip's right edge — with `min-w-0`
          on the bar above, the chip is guaranteed to end at the motion.div
          boundary, so the handle barely clears it. Target handle sits 4px
          INSIDE the left edge, so incoming edges terminate INTO the node
          rather than leaving a gap. 1×1 transparent anchor dots. */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          left: 4, top: COMPACT_RIBBON_Y,
          width: 1, height: 1, minWidth: 1, minHeight: 1,
          background: 'transparent', border: 'none',
          transform: 'translate(0, -50%)',
          opacity: 0, pointerEvents: 'none',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          right: -2, top: COMPACT_RIBBON_Y,
          width: 1, height: 1, minWidth: 1, minHeight: 1,
          background: 'transparent', border: 'none',
          transform: 'translate(0, -50%)',
          opacity: 0, pointerEvents: 'none',
        }}
      />

      {/* × removal button on user-inserted nodes */}
      {node.inserted && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); removeInserted(node.id) }}
          className="absolute -top-2 -right-2 z-20 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--red)] bg-[rgba(10,13,18,0.96)] text-[var(--red)] opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-80"
          title="Remove this inserted beat and restore the original flow"
        >
          <X size={10} strokeWidth={2.2} />
        </button>
      )}

      {/* small thumbnail — loader while hermes imagines the frame */}
      <CompactThumb node={node} />

      {/* main ribbon */}
      <div className="relative flex items-stretch" style={{ height: 38 }}>
        {/* base bar — parallelogram, slanted at the left seam.
            `min-w-0` is critical: without it, long titles expand the flex
            item beyond its flex-basis and push the % chip past the
            motion.div's 272px boundary, which makes the source handle
            appear INSIDE the chip. With it, `truncate` on the title works
            and the chip stays exactly where the layout expects. */}
        <div
          className="relative flex min-w-0 flex-1 items-center gap-2 px-3"
          style={{
            clipPath: 'polygon(8px 0, 100% 0, 100% 100%, 0 100%)',
            background: barBg,
            boxShadow: outline,
            transition: 'box-shadow 140ms ease, background 140ms ease',
          }}
        >
          <MoodIcon size={11} strokeWidth={2.2} style={{ color: iconColor }} className="shrink-0" />
          <span
            className="truncate font-display text-[11.5px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: titleColor }}
            title={node.label ? node.title : undefined}
          >
            {/* Detroit-style answer label takes priority — short, verb
                phrased ("TAKES IT"), Detroit-feel.  Hover tooltip shows
                the longer narrative title for context.  Shell swaps to
                "new moment" as the ghost placeholder label. */}
            {isShell
              ? 'new moment'
              : node.status === 'generating' && !node.title
                ? 'Hermes weaving…'
                : node.label || node.title}
          </span>
          {/* Shimmer sweep on a generating node — cyan for a brainstorm
              expand, gold for an inserted shell (matches its ghost
              thumb and the trunk+ hover preview). */}
          {node.status === 'generating' && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background: isShell
                  ? 'linear-gradient(100deg, transparent 20%, rgba(233,193,107,0.26) 50%, transparent 80%)'
                  : 'linear-gradient(100deg, transparent 20%, rgba(79,195,247,0.22) 50%, transparent 80%)',
                backgroundSize: '220% 100%',
                animation: 'shellShimmer 1.6s linear infinite',
                clipPath: 'polygon(8px 0, 100% 0, 100% 100%, 0 100%)',
              }}
            />
          )}
          {node.staleState === 'stale' && (
            <span
              className="shrink-0 border px-1 py-[1px] font-mono text-[8px] tracking-[0.22em] uppercase"
              style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
              title="Conflicts with an inserted beat"
            >stale</span>
          )}
          {node.staleState === 'unresolved' && (
            <span
              className="flex shrink-0 items-center gap-1 border px-1 py-[1px] font-mono text-[8px] tracking-[0.22em] uppercase"
              style={{ borderColor: 'var(--red)', color: 'var(--red)' }}
            ><ShieldAlert size={8} strokeWidth={2} /> unresolved</span>
          )}
          {node.staleState === 'rewritten' && (
            <span
              className="flex shrink-0 items-center gap-1 border px-1 py-[1px] font-mono text-[8px] tracking-[0.22em] uppercase"
              style={{ borderColor: 'var(--cyan)', color: onCanon ? '#0a0d12' : 'var(--cyan)', background: onCanon ? 'rgba(10,13,18,0.15)' : undefined }}
            ><Bot size={8} strokeWidth={2} /> rewritten</span>
          )}
          {isVisited && <Check size={11} strokeWidth={2.2} style={{ color: iconColor }} className="ml-auto shrink-0" />}
          {node.status === 'generating' && <Lock size={11} style={{ color: isShell ? '#e9c16b' : '#4fc3f7' }} className="ml-auto shrink-0" />}
          {!isVisited && node.status !== 'generating' && (
            <ChevronRight size={11} strokeWidth={2.2} style={{ color: iconColor, opacity: 0.75 }} className="ml-auto shrink-0 transition-transform group-hover:translate-x-0.5" />
          )}
        </div>

      </div>

      {/* Hover reveal — the beat's summary peeks out just below the
          ribbon when the user considers this choice.  Gives them a
          chance to FEEL the branch before committing.  Canon/current
          bars skip this (no need to preview the path you're on). */}
      {!onCanon && node.summary && (
        <motion.div
          initial={false}
          animate={{
            opacity: isHover ? 1 : 0,
            height: isHover ? 'auto' : 0,
            marginTop: isHover ? 6 : 0,
          }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className="overflow-hidden px-2"
          style={{ pointerEvents: 'none' }}
        >
          <div
            className="line-clamp-3 text-[11.5px] leading-[1.5]"
            style={{
              color: 'rgba(230,236,244,0.78)',
              borderLeft: `2px solid ${MOOD_TINT[node.mood]}66`,
              paddingLeft: 8,
            }}
          >
            {node.summary}
          </div>
        </motion.div>
      )}

      {/* provenance + stale actions strip */}
      {(node.decidedBy === 'agent' || node.inserted || node.staleState !== 'fresh') && (
        <div className="mt-1.5 flex items-center gap-2 px-1 font-mono text-[10.5px] uppercase tracking-[0.24em] text-[var(--ink-faint)]">
          {node.decidedBy === 'agent' ? (
            <span className="flex items-center gap-1.5"><Bot size={11} strokeWidth={2} className="text-[var(--cyan)]" />
              {node.decidedByAgent?.replace('hermes-', '') ?? 'agent'}
            </span>
          ) : (
            <span className="flex items-center gap-1.5"><User size={11} strokeWidth={2} className="text-[var(--gold)]" />you</span>
          )}
          {node.inserted && <span className="border border-[var(--line)] px-1.5 py-[1px]">inserted</span>}
          {(node.staleState === 'stale' || node.staleState === 'unresolved') && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  // Retry cascade must run from the ORIGINAL insert — the
                  // stale node isn't itself an insert, so passing its own
                  // id made the critic compare the beat against its own
                  // title (nonsense verdicts).  insertCauseId was set on
                  // the canon-chain during splice; fall back to the node
                  // itself only for old saves that predate the field.
                  const rootInsert = node.insertCauseId ?? node.id
                  void reharmonize({ insertedNodeId: rootInsert })
                }}
                className="ml-auto flex items-center gap-1.5 border border-[var(--gold)] px-1.5 py-[1px] text-[var(--gold)] transition-colors hover:bg-[rgba(233,193,107,0.1)]"
              ><RefreshCw size={10} strokeWidth={2} /> reharmonize</button>
              <button
                onClick={(e) => { e.stopPropagation(); keepStale(node.id) }}
                className="border border-[var(--line)] px-1.5 py-[1px] text-[var(--ink-dim)] hover:text-[var(--ink)]"
              >keep</button>
            </>
          )}
          {node.staleState === 'rewritten' && node.originalTitle && (
            <button
              onClick={(e) => { e.stopPropagation(); revertRewrite(node.id) }}
              className="ml-auto flex items-center gap-1.5 border border-[var(--line)] px-1.5 py-[1px] text-[var(--ink-dim)] hover:border-[var(--red)] hover:text-[var(--red)]"
            ><Undo2 size={10} strokeWidth={2} /> revert</button>
          )}
        </div>
      )}
    </motion.div>
  )
}

// -----------------------------------------------------------------------------
// Checkpoint — big image tile
// -----------------------------------------------------------------------------

function CheckpointCard({ node, preview = false }: { node: TStoryNode; preview?: boolean }) {
  const setCurrent = useStory((s) => s.setCurrent)
  const setSelected = useStory((s) => s.setSelected)
  const openLightbox = useStory((s) => s.openLightbox)
  const openStorybook = useStory((s) => s.openStorybook)
  const selectedId = useStory((s) => s.selectedId)
  const edgeHighlightTargetId = useStory((s) => s.edgeHighlightTargetId)
  const removeInserted = useStory((s) => s.removeInserted)
  const [loaded, setLoaded] = useState(false)
  const [askInflight, setAskInflight] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const isCurrentCheckpoint = node.status === 'current' && !preview
  // Show the decision overlay whenever a checkpoint is rendered — either
  // because this is the current beat OR because the user is hovering a
  // compact sibling and the preview expanded into a checkpoint.  The
  // hover preview path is what makes old walked beats reveal their
  // options on rollover (consistent with the lightbox's always-show
  // behaviour).  `generating` state still hides the overlay.
  const showDecisionOverlay =
    node.status !== 'generating' &&
    (isCurrentCheckpoint || (preview && node.childrenIds.length > 0))

  const onAskHermes = async () => {
    if (askInflight) return
    setAskInflight(true)
    try {
      // Force=true so Ask Hermes works both on leaves (first time) AND
      // on already-populated beats (regenerate siblings alongside old
      // ones, never deletes a child the user already walked into).
      await expandNode(node.id, 3, { force: node.childrenIds.length > 0 })
    } finally {
      setAskInflight(false)
    }
  }

  const isHover = selectedId === node.id || edgeHighlightTargetId === node.id
  const staleTint = staleBorder(node)
  const isCurrent = node.status === 'current'
  // Shell = an inserted beat that's waiting for writer-assist to fill its
  // content.  We render it at the final landing position but visually
  // ghost it (dashed gold outline, no title, faded) so the tree shows
  // "something is being placed here" immediately on modal submit, without
  // claiming space with a false filled state.  An inserted shell has
  // title=='' — non-inserted generating nodes (e.g. brainstorm load on a
  // leaf) keep their existing title and render normal "weaving" chrome.
  const isShell = node.status === 'generating' && !!node.inserted && !node.title
  const { hovered, isMember, isDim } = useSceneFocus(node.id)
  const accent = hovered ? sceneAccent(hovered) : null

  // Ribbon is solid cyan for current/canon — Detroit standard. Title ink adapts.
  const ribbonBg = isShell
    ? 'linear-gradient(90deg, rgba(20,26,36,0.7) 0%, rgba(20,26,36,0.4) 100%)'
    : isCurrent
      ? 'linear-gradient(90deg, #b88a2c 0%, #e9c16b 100%)'
      : 'linear-gradient(90deg, #1aa1e0 0%, #4fc3f7 100%)'
  const ribbonInk = isShell ? 'rgba(233,193,107,0.9)' : '#0a0d12'

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: isDim ? 0.4 : 1, scale: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      // In preview mode the wrapping <StoryNodeCard> owns the hover &
      // click semantics (so the underlying compact bar keeps its
      // React Flow handles intact).  Skip the onMouse* / onClick
      // handlers here so they don't fight the outer ones.
      onMouseEnter={preview ? undefined : () => setSelected(node.id)}
      onMouseLeave={preview ? undefined : () => setSelected(null)}
      onClick={preview ? undefined : (e: MouseEvent) => { e.stopPropagation(); setCurrent(node.id) }}
      data-cursor={preview ? undefined : 'hover'}
      className="group relative select-none"
      style={{
        width: 480,
        filter: isMember && accent ? `drop-shadow(0 0 16px ${accent}55)` : undefined,
        // Shell fades to 80% — reads as "placeholder / becoming" rather
        // than a real canon beat.  Image content gets its own dashed
        // gold frame via the image tile's boxShadow below.
        opacity: isShell ? 0.82 : 1,
      }}
    >
      {/* Scene membership pill */}
      {isMember && hovered && accent && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="pointer-events-none absolute z-30 inline-flex items-center gap-1.5 px-2.5 py-[4px] font-display text-[10px] font-semibold uppercase tracking-[0.3em]"
          style={{
            top: -16,
            left: 10,
            background: 'rgba(10,13,18,0.96)',
            color: accent,
            border: `1px solid ${accent}`,
            boxShadow: `0 0 12px ${accent}66`,
          }}
        >
          <span>ACT {sceneActRoman(hovered.actNumber)}</span>
          <span style={{ color: 'rgba(230,236,244,0.88)' }}>· {hovered.label}</span>
          {hovered.motif && (
            <span className="font-mono text-[9px] tracking-[0.24em]" style={{ color: 'rgba(198,210,226,0.72)' }}>
              · {hovered.motif}
            </span>
          )}
        </motion.div>
      )}
      {/* Source handle sits just past the image's visible right edge (the
          clip-path slope brings the silhouette in by ~6px at mid-height, so
          right:-2 lands the handle immediately outside it). Target handle
          sits just inside the left silhouette so incoming edges terminate
          inside the image.  Suppressed in preview mode: the underlying
          CompactBar already provides the edge anchors, and a duplicate
          handle at a different Y would snap the edge mid-hover. */}
      {!preview && (
        <>
          <Handle
            type="target"
            position={Position.Left}
            style={{
              left: 6, top: 120,
              width: 1, height: 1, minWidth: 1, minHeight: 1,
              background: 'transparent', border: 'none',
              transform: 'translate(0, -50%)',
              opacity: 0, pointerEvents: 'none',
            }}
          />
          <Handle
            type="source"
            position={Position.Right}
            style={{
              right: -2, top: 120,
              width: 1, height: 1, minWidth: 1, minHeight: 1,
              background: 'transparent', border: 'none',
              transform: 'translate(0, -50%)',
              opacity: 0, pointerEvents: 'none',
            }}
          />
        </>
      )}

      {node.inserted && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); removeInserted(node.id) }}
          className="absolute -top-2 -right-2 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--red)] bg-[rgba(10,13,18,0.96)] text-[var(--red)] opacity-0 transition-opacity group-hover:opacity-80"
          title="Remove this inserted beat"
        ><X size={12} strokeWidth={2.2} /></button>
      )}

      {/* image tile with parallelogram cut */}
      <div
        className="relative overflow-hidden"
        style={{
          clipPath: 'polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 0 100%)',
          boxShadow: isShell
            ? '0 0 18px rgba(233,193,107,0.28)'
            : staleTint
              ? `inset 0 0 0 1.5px ${staleTint}, 0 0 20px ${staleTint}40`
              : isHover
                ? 'inset 0 0 0 1px var(--cyan), 0 0 18px rgba(79,195,247,0.2)'
                : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
          transition: 'box-shadow 180ms ease',
        }}
      >
        <div
          className="relative h-[240px] w-full overflow-hidden bg-[#05070b]"
          onClick={(e: MouseEvent) => { e.stopPropagation(); openLightbox(node.id) }}
          data-cursor="zoom"
        >
          {!loaded && (
            <div
              className="absolute inset-0 animate-pulse"
              style={{ background: 'linear-gradient(110deg, #0f131b, #151a24, #0f131b)' }}
            />
          )}
          {(() => {
            // A REAL rendered frame lives under /cache/images/; anything else
            // (pollinations placeholder / deterministic seed URL) is visual
            // filler we should suppress during a loading state.
            const hasRealImage = typeof node.imageUrl === 'string' && node.imageUrl.startsWith('/cache/images/')
            const isGenerating = node.status === 'generating'
            // Rule for the big checkpoint image:
            //   • no real image yet → hide entirely, show opaque loading card
            //   • real image + mid-brainstorm → keep it visible dimmed under
            //     the HERMES WEAVING overlay so the scene context doesn't
            //     blink to black when the user clicks an option on this node
            //   • real image + done → full opacity
            const showImage = loaded && (hasRealImage || !isGenerating)
            return (
              // eslint-disable-next-line @next/next/no-img-element, react/jsx-key
              <img
                src={node.imageUrl}
                alt={node.title}
                onLoad={() => setLoaded(true)}
                draggable={false}
                className="h-full w-full object-cover transition-opacity duration-300"
                style={{
                  opacity: showImage ? 1 : 0,
                  filter: node.status === 'visited' ? 'grayscale(0.3) brightness(0.82)' : undefined,
                }}
              />
            )
          })()}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: 'linear-gradient(180deg, rgba(10,13,18,0.2) 0%, transparent 40%, transparent 70%, rgba(10,13,18,0.7) 100%)',
            }}
          />
          {isCurrent && <div className="pointer-events-none absolute inset-0 scan-line" />}
          <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 bg-black/70 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-white/80 opacity-0 transition-opacity group-hover:opacity-100">
            <Maximize2 size={9} strokeWidth={1.8} /> zoom
          </div>
          {(() => {
            // Show the weaving overlay whenever we don't yet have a real
            // cached frame to display — covers three cases:
            //   1. node.status === 'generating' (brainstorm expanding, or
            //      an inserted shell before writer-assist returns)
            //   2. a freshly-brainstormed unvisited sibling whose image
            //      is still pending image-gen — without this, hovering
            //      such a compact bar into a checkpoint preview drops
            //      the "HERMES IMAGINING…" cue the compact was showing.
            //   3. a retry click has been fired (retrying) — swap the
            //      label to gold "hermes weaving…" so the user sees the
            //      click register.
            // For already-rendered nodes we skip the overlay entirely.
            const hasRealImage = typeof node.imageUrl === 'string' && node.imageUrl.startsWith('/cache/images/')
            if (hasRealImage && node.status !== 'generating' && !retrying) return null
            const overlayBg = hasRealImage && loaded ? 'rgba(5,7,11,0.62)' : '#05070b'
            const tone = isShell || retrying ? '#e9c16b' : '#4fc3f7'
            const label = isShell
              ? 'new beat weaving…'
              : retrying
                ? 'hermes weaving…'
                : node.status === 'generating'
                  ? 'hermes weaving…'
                  : 'hermes imagining…'
            return (
              <div
                className="absolute inset-0 flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.3em]"
                style={{ background: overlayBg, color: tone }}
              >
                <Lock size={12} className="mr-2 opacity-70" /> {label}
              </div>
            )
          })()}
          {/* Ghost shell — dashed gold frame + sweeping shimmer matches
              the trunk+ hover preview, so the landing position reads as
              "the ghost the user previewed is being built here". */}
          {isShell && (
            <>
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
            </>
          )}
          {(() => {
            // Retry affordance — image-gen can silently fall off the
            // pipeline (Gemini refusal + retry also refuses, or a network
            // blip) and leave the beat on the pollinations placeholder
            // forever.  Without a manual retry the viewer is stuck
            // watching "HERMES IMAGINING…" with no way out.  Show on
            // hover only, skip shells (they retry themselves from
            // fillInsertedShell) and nodes with no prompt yet.  Hide
            // while a retry is already in flight.
            const hasRealImage = typeof node.imageUrl === 'string' && node.imageUrl.startsWith('/cache/images/')
            if (hasRealImage || isShell || !node.imagePrompt || retrying) return null
            return (
              <button
                type="button"
                onClick={async (e: MouseEvent) => {
                  e.stopPropagation()
                  setRetrying(true)
                  try { await generateNodeImage(node.id, node.imagePrompt) }
                  finally { setRetrying(false) }
                }}
                title="Retry image render"
                data-cursor="pointer"
                className="absolute right-2 top-2 flex items-center gap-1.5 border border-[var(--gold)] bg-[rgba(10,13,18,0.92)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--gold)] opacity-0 transition-opacity duration-150 hover:bg-[rgba(233,193,107,0.12)] group-hover:opacity-100"
                style={{ clipPath: 'polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%)', zIndex: 25 }}
              >
                <RefreshCw size={10} strokeWidth={2.2} />
                retry
              </button>
            )
          })()}

          {/* Detroit-style decision overlay — floats bottom-right of
              the checkpoint image.  Renders on the current beat AND on
              hover-previews of compact siblings (so the viewer can scan
              old beats' choice sets without jumping into a lightbox). */}
          {showDecisionOverlay && (
            <DecisionOverlay
              node={node}
              askInflight={askInflight}
              onAskAgain={onAskHermes}
            />
          )}

        </div>
      </div>

      {/* Storybook tab — sibling of the image tile (NOT inside it),
          because the image tile's parallelogram clip-path otherwise
          pushes the button's visible left edge INWARD along the slope
          (~11px in at button-top), reading as "inset from the image"
          rather than "tag on the image edge".  Rendering at the outer
          card-wrapper level lets the button protrude past the image's
          slanted silhouette into the canvas, then its own clip-path
          uses a slope (2px → 0 over the button's height) that's ~the
          same as the image's slope so they read as parallel.  Visible
          on every completed beat in both normal and preview (hover)
          modes.  Hidden on the root, on shells, and while the beat is
          still generating. */}
      {!isShell && node.status !== 'generating' && node.parentId && (
        <button
          type="button"
          onClick={(e: MouseEvent) => { e.stopPropagation(); openStorybook(node.id) }}
          title="Generate storybook video ending at this beat"
          data-cursor="pointer"
          className="absolute flex items-center gap-1.5 border border-[var(--cyan)] bg-[rgba(10,13,18,0.92)] px-5 py-2 font-mono text-[11.5px] uppercase tracking-[0.28em] text-[var(--cyan)] opacity-80 transition-all duration-150 hover:bg-[rgba(79,195,247,0.18)] hover:opacity-100 hover:scale-[1.02] group-hover:opacity-100"
          style={{
            // The image's parallelogram clip slopes from x=12 at top
            // to x=0 at bottom over its 240px height (slope 0.05).
            // For a tag of ~32px height that's only ~1.6px of slant,
            // so we mirror the image's slope segment exactly across
            // the tag's height: top-left at x=12 (sits on the image's
            // top-left chamfer corner), bottom-left at x=10 (1.6px in
            // — within the image silhouette at y=32).  Anchored at
            // left:0/top:0 so the tag's leading edge IS the image's
            // leading edge, no gap above and no overflow past the
            // silhouette at the bottom.
            left: 0,
            top: 0,
            transformOrigin: 'left top',
            clipPath: 'polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 10px 100%)',
            // Below the active-beat corner brackets (z:20) so the
            // bracket paints over the tag at the corner — the tag
            // reads as living BEHIND the frame, not crashing into it.
            zIndex: 15,
            boxShadow: '0 4px 14px rgba(79,195,247,0.22)',
          }}
        >
          <Film size={12} strokeWidth={2.2} />
          storybook
        </button>
      )}

      {/* Active-beat indicator — only on the CURRENT checkpoint.  Four
          corner brackets wrap the entire card silhouette (image +
          ribbon), and two breathing chevrons sit above and below to
          read as "you are here" without competing with the card
          chrome.  When the user walks to a new beat, isCurrentCheckpoint
          flips on the new node and these markers transfer there
          automatically — no extra orchestration. */}
      {isCurrentCheckpoint && (
        <>
          {/* Top chevron — outer handles horizontal centering, inner
              owns the animation.  Splitting them avoids any conflict
              between the centering transform and the animated transform.
              Pushed to top:-52 (vs the bottom's -28) because the wrapper
              has a `you/brainstorm` provenance row sitting BELOW the
              ribbon — that ~24px of trailing whitespace below the
              card needs to be mirrored above to keep the chevron pair
              symmetric around the actual visual silhouette. */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 z-30"
            style={{ top: -52 }}
          >
            <div
              style={{
                animation: 'activeBeatBounceTop 1.4s ease-in-out infinite',
                filter: 'drop-shadow(0 0 6px var(--cyan-glow))',
              }}
            >
              <svg width="42" height="20" viewBox="0 0 42 20" fill="none">
                <polyline
                  points="3,3 21,17 39,3"
                  stroke="var(--cyan)"
                  strokeWidth="3.2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <polyline
                  points="9,3 21,12 33,3"
                  stroke="var(--cyan)"
                  strokeWidth="2"
                  strokeOpacity="0.6"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>

          {/* Bottom chevron — same wrapper/inner split */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 z-30"
            style={{ bottom: -28 }}
          >
            <div
              style={{
                animation: 'activeBeatBounceBottom 1.4s ease-in-out infinite',
                filter: 'drop-shadow(0 0 6px var(--cyan-glow))',
              }}
            >
              <svg width="42" height="20" viewBox="0 0 42 20" fill="none">
                <polyline
                  points="3,17 21,3 39,17"
                  stroke="var(--cyan)"
                  strokeWidth="3.2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <polyline
                  points="9,17 21,8 33,17"
                  stroke="var(--cyan)"
                  strokeWidth="2"
                  strokeOpacity="0.6"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>

          {/* Four corner brackets — span the full card bounding box
              (image + ribbon) so the active beat reads as a complete
              framed element, not just a framed image.  Top brackets
              are nudged a few pixels higher so they clear the
              STORYBOOK tag's bottom edge and read as a separate
              frame element rather than tangling with it. */}
          <div className="pointer-events-none absolute inset-0 z-20" aria-hidden>
            <span
              className="absolute"
              style={{
                top: -11, left: -5, width: 18, height: 18,
                borderTop: '1.7px solid var(--cyan)',
                borderLeft: '1.7px solid var(--cyan)',
                opacity: 0.9,
              }}
            />
            <span
              className="absolute"
              style={{
                top: -11, right: -5, width: 18, height: 18,
                borderTop: '1.7px solid var(--cyan)',
                borderRight: '1.7px solid var(--cyan)',
                opacity: 0.9,
              }}
            />
            <span
              className="absolute"
              style={{
                bottom: -5, left: -5, width: 18, height: 18,
                borderBottom: '1.7px solid var(--cyan)',
                borderLeft: '1.7px solid var(--cyan)',
                opacity: 0.9,
              }}
            />
            <span
              className="absolute"
              style={{
                bottom: -5, right: -5, width: 18, height: 18,
                borderBottom: '1.7px solid var(--cyan)',
                borderRight: '1.7px solid var(--cyan)',
                opacity: 0.9,
              }}
            />
          </div>
        </>
      )}

      {/* Detroit-style title ribbon — OVERLAPS the image by ~24px, slides out right.
          Cursor: pointer here (body = the explicit click target);
          image area above keeps the parent card's hover preview. */}
      <div className="relative -mt-6 flex items-stretch" style={{ zIndex: 2 }} data-cursor="pointer">
        <div
          className="relative flex flex-1 flex-col justify-center px-4 py-2"
          style={{
            clipPath: 'polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%)',
            background: ribbonBg,
            color: ribbonInk,
            boxShadow: isShell
              ? '0 0 0 1px rgba(233,193,107,0.35), 0 6px 16px rgba(0,0,0,0.35)'
              : `0 8px 20px ${isCurrent ? 'rgba(233,193,107,0.25)' : 'rgba(79,195,247,0.2)'}`,
          }}
        >
          <div
            className="font-display text-[12.5px] font-semibold tracking-[0.06em] leading-[1.35]"
            style={{
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 3,
              overflow: 'hidden',
            }}
          >
            {isShell ? 'New moment' : node.title}
          </div>
          <div
            className="mt-0.5 text-[10px] uppercase tracking-[0.32em]"
            style={{ color: isShell ? 'rgba(233,193,107,0.55)' : 'rgba(10,13,18,0.7)' }}
          >
            {isShell ? 'placeholder · weaving' : 'Checkpoint'}
          </div>
        </div>
      </div>

      {/* provenance + stale actions */}
      <div className="mt-2 flex items-center gap-2 px-1 font-mono text-[11.5px] uppercase tracking-[0.24em] text-[var(--ink-faint)]">
        {node.decidedBy === 'agent' ? (
          <span className="flex items-center gap-1.5"><Bot size={12} strokeWidth={2} className="text-[var(--cyan)]" />{node.decidedByAgent?.replace('hermes-', '') ?? 'agent'}</span>
        ) : (
          <span className="flex items-center gap-1.5"><User size={12} strokeWidth={2} className="text-[var(--gold)]" />you</span>
        )}
        {node.inserted && <span className="border border-[var(--line)] px-1.5 py-[1px]">inserted</span>}
      </div>
    </motion.div>
  )
}

// -----------------------------------------------------------------------------

export function StoryNodeCard({ data }: Props) {
  const { node } = data
  // Hover-expand — keeps edges anchored.
  //
  // The previous attempt swapped CompactBar → CheckpointCard in place,
  // which also swapped each card's Handle components.  React Flow
  // re-measured the new handles at the checkpoint's top:120 instead of
  // the compact's ribbon-Y, so mid-hover the edge endpoint whipped
  // downward to the new handle — the visible "line jumping" bug.
  //
  // Fix: CompactBar is ALWAYS kept in the DOM for non-checkpoint
  // variants.  Its Handles never move.  On hover we overlay a
  // checkpoint-shaped preview absolutely above it, pushed up by the
  // half-delta so vertical centre matches the compact's centre.  The
  // preview passes `preview` to CheckpointCard which strips its own
  // Handles / click / setSelected handlers, so the overlay is purely
  // a visual flyout.  The wrapper div carries its own enter/leave so
  // hover stays active while the mouse is over the extended region.
  const selectedId = useStory((s) => s.selectedId)
  const edgeHighlightTargetId = useStory((s) => s.edgeHighlightTargetId)
  const setSelected = useStory((s) => s.setSelected)
  const isHovered = selectedId === node.id || edgeHighlightTargetId === node.id
  const variant = variantOf(node)

  if (variant === 'checkpoint') return <CheckpointCard node={node} />

  const showPreview = isHovered
  const yShift = (CHECKPOINT_HEIGHT - COMPACT_HEIGHT) / 2

  // Parent-level mouse handling: onMouseEnter/Leave on a wrapper that
  // CONTAINS both the compact bar and the preview overlay.  Because the
  // overlay is a DOM descendant of this wrapper (not a portal), mouse
  // moving FROM the compact-bar's visible box INTO the overlay's extended
  // area (which sticks ~120px above and below) does NOT trigger the
  // wrapper's onMouseLeave — React treats all descendant regions as "still
  // inside" the parent.  Each inner component used to own its own
  // enter/leave and set selectedId from there; the result was a visible
  // flicker at the boundary: compact fires Leave → preview fires Enter
  // (or vice versa) on the same frame, state flapped, the compact's
  // hover outline blinked back into view mid-transition.  Lifting the
  // handlers here kills that race.
  return (
    <div
      className="relative"
      onMouseEnter={() => setSelected(node.id)}
      onMouseLeave={() => setSelected(null)}
    >
      {/* Compact bar stays in DOM always so its Handle components keep
          their DOM rect stable — React Flow reads those rects to draw
          edge endpoints, and remounting them mid-hover snaps edges to
          new positions.  When the preview is active we hide the bar
          VISUALLY (visibility:hidden) rather than unmounting it: the
          layout box is preserved, handles are still measurable, but
          the compact chrome doesn't leak out from under the taller
          preview at its bottom-left corner. */}
      <div style={{ visibility: showPreview ? 'hidden' : 'visible' }}>
        <CompactBar node={node} />
      </div>
      {showPreview && (
        <PreviewOverlay node={node} yShift={yShift} />
      )}
    </div>
  )
}

export const nodeTypes = { story: StoryNodeCard }

/**
 * Hover preview flyout.  Renders the CheckpointCard in preview mode
 * (no handles, no self-driven selection) on top of the underlying
 * CompactBar.  Owns its own enter/leave so mouse-moving from the
 * compact bar up into the preview's extended region keeps the hover
 * state alive — otherwise the leave on the small compact bar would
 * unmount the preview before the enter on the overlay fires.
 */
function PreviewOverlay({ node, yShift }: { node: TStoryNode; yShift: number }) {
  const setCurrent = useStory((s) => s.setCurrent)
  // No mouse handlers here — the parent StoryNodeCard wraps this +
  // CompactBar in a single onMouseEnter/Leave.  Moving the mouse
  // between the preview and the (hidden) compact bar no longer flips
  // selectedId off and back on, so the compact's hover outline never
  // blinks through the transition.
  return (
    <div
      className="absolute left-0 z-20"
      style={{ top: -yShift }}
      onClick={(e) => { e.stopPropagation(); setCurrent(node.id) }}
      data-cursor="hover"
    >
      <CheckpointCard node={node} preview />
    </div>
  )
}
