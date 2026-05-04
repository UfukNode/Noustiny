'use client'

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Hand, ZoomIn, Check, RefreshCw, ArrowLeftCircle,
  BookOpen, Sparkles, Info, History, Layers, Film,
  HelpCircle, MoreHorizontal, FolderOpen, Save, X,
} from 'lucide-react'
import { useStory, selectCurrentNode } from '@/lib/store'
import { BackgroundPicker } from './BackgroundPicker'
import { ZoomControl } from './ZoomControl'
import { SaveStoryModal } from './SaveStoryModal'
import { OpenSavedModal } from './SavedStoriesList'

/**
 * Three-slot dock. Left: help. Centre: the three agent actions — EXPAND
 * (brainstorm new branches), SCENES (compose dramaturgy), WRITE (seal as
 * prose). Right: zoom + backdrop + utility popover. Nothing competes for
 * attention with the three agent primaries; everything else is one click
 * deeper. This is the pattern Detroit, Linear and Figma all use — a quiet
 * canvas with a clear "what do I do next" focal point.
 */

// ---- shared tokens --------------------------------------------------------

const CHROME = 'border border-[var(--line)] bg-[rgba(10,13,18,0.97)] backdrop-blur'

interface AgentButtonProps {
  label: string
  hint: string
  icon: React.ReactNode
  accent: string
  accentHover: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
  badge?: number
  /** Render a "working" skin (dots loader + disabled) while the caller's
   *  async action is in flight.  Swaps label→"ASKING…" etc. */
  busy?: boolean
  /** Text shown while ``busy`` is true (defaults to label). */
  busyLabel?: string
}

/**
 * Detroit-style invert-on-hover. Idle = dark panel + accent border + accent
 * text. Hover = accent fill + dark ink text. This is the pattern Detroit uses
 * for its selected/hovered actions, and it works on any backdrop because the
 * contrast comes from full-saturation surfaces on both sides of the flip —
 * not from translucent tints that bleed through to the canvas behind.
 */
const IDLE_BG = 'rgba(10, 13, 18, 0.97)'
const INK_ON_ACCENT = '#0a0d12'
const INK_ON_ACCENT_SOFT = 'rgba(10, 13, 18, 0.72)'
const HINT_INK_IDLE = 'rgba(230, 236, 244, 0.88)'
const HINT_INK_DISABLED = 'rgba(180, 190, 205, 0.32)'
const TITLE_INK_DISABLED = 'rgba(210, 220, 235, 0.36)'

function AgentButton({
  label, hint, icon, accent, accentHover,
  onClick, disabled, disabledReason, badge, busy, busyLabel,
}: AgentButtonProps) {
  const [hovered, setHovered] = useState(false)
  const isDisabled = disabled || busy
  const active = !isDisabled && hovered
  const effectiveLabel = busy ? (busyLabel ?? 'asking…') : label

  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={isDisabled ? disabledReason : hint}
      className="group relative flex w-[172px] flex-col items-center gap-1 border-[1.5px] px-3 py-2 transition-all disabled:cursor-not-allowed"
      style={{
        borderColor: isDisabled ? 'rgba(120, 130, 145, 0.32)' : accent,
        background: active ? accent : IDLE_BG,
        boxShadow: isDisabled
          ? 'none'
          : active
            ? `0 0 28px ${accentHover}, 0 4px 14px ${accentHover}`
            : `0 0 10px ${accentHover}`,
        clipPath: 'polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%)',
        transform: active ? 'translateY(-1px)' : 'none',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <div
        className="flex items-center gap-2 font-display text-[12px] font-semibold uppercase tracking-[0.3em] leading-none"
        style={{ color: isDisabled ? TITLE_INK_DISABLED : active ? INK_ON_ACCENT : accent }}
      >
        {busy
          ? <InlineDots color={isDisabled ? TITLE_INK_DISABLED : accent} />
          : icon}
        {effectiveLabel}
        {typeof badge === 'number' && badge > 0 && !busy && (
          <span
            className="ml-1 font-mono text-[9px] tabular-nums"
            style={{
              color: isDisabled ? TITLE_INK_DISABLED : active ? INK_ON_ACCENT : accent,
              opacity: 0.92,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <div
        className="font-display text-[9px] font-semibold uppercase tracking-[0.3em] leading-none"
        style={{
          color: isDisabled ? HINT_INK_DISABLED : active ? INK_ON_ACCENT_SOFT : HINT_INK_IDLE,
        }}
      >
        {hint}
      </div>
    </button>
  )
}

function InlineDots({ color }: { color: string }) {
  return (
    <span className="inline-flex items-center gap-[3px]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="inline-block"
          style={{ width: 3, height: 3, background: color, borderRadius: 1 }}
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.0, repeat: Infinity, delay: i * 0.16 }}
        />
      ))}
    </span>
  )
}

// ---- help popover ---------------------------------------------------------

const HINTS: { icon: React.ReactNode; label: string; hotkey?: string }[] = [
  { icon: <Hand size={12} strokeWidth={1.7} />, label: 'drag · pan', hotkey: 'mouse' },
  { icon: <ZoomIn size={12} strokeWidth={1.7} />, label: 'scroll · zoom', hotkey: '⇅' },
  { icon: <Check size={12} strokeWidth={1.7} />, label: 'select node', hotkey: 'click' },
  { icon: <ArrowLeftCircle size={12} strokeWidth={1.7} />, label: 'jump back', hotkey: 'click ancestor' },
]

function HelpChip() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const legendOpen = useStory((s) => s.legendOpen)
  const mediaLibraryOpen = useStory((s) => s.mediaLibraryOpen)
  const decisionLogOpen = useStory((s) => s.decisionLogOpen)

  // Close self when any side panel opens — keeps "one menu visible at a
  // time" invariant without sharing local state with the global store.
  useEffect(() => {
    if (legendOpen || mediaLibraryOpen || decisionLogOpen) setOpen(false)
  }, [legendOpen, mediaLibraryOpen, decisionLogOpen])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  // Opening this popover closes the side panels — symmetric to the
  // useEffect above.
  const onToggle = () => {
    setOpen((v) => {
      if (!v) {
        const s = useStory.getState()
        if (s.legendOpen) s.toggleLegend()
        if (s.mediaLibraryOpen) s.toggleMediaLibrary()
        if (s.decisionLogOpen) s.toggleDecisionLog()
      }
      return !v
    })
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="Show navigation hints"
        onClick={onToggle}
        className="flex h-9 w-9 items-center justify-center border backdrop-blur transition-colors"
        style={{
          background: open ? '#4fc3f7' : 'rgba(10,13,18,0.97)',
          color: open ? '#0a0d12' : 'rgba(230,236,244,0.85)',
          borderColor: open ? '#4fc3f7' : 'var(--line)',
        }}
        onMouseEnter={(e) => {
          if (open) return
          e.currentTarget.style.background = '#4fc3f7'
          e.currentTarget.style.color = '#0a0d12'
          e.currentTarget.style.borderColor = '#4fc3f7'
        }}
        onMouseLeave={(e) => {
          if (open) return
          e.currentTarget.style.background = 'rgba(10,13,18,0.97)'
          e.currentTarget.style.color = 'rgba(230,236,244,0.85)'
          e.currentTarget.style.borderColor = 'var(--line)'
        }}
      >
        <HelpCircle size={14} strokeWidth={1.6} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.16 }}
            className={`${CHROME} absolute bottom-full left-0 mb-2 w-[260px] p-3`}
            style={{ boxShadow: '0 20px 48px rgba(0,0,0,0.55)' }}
          >
            <div className="mb-2 font-display text-[10px] uppercase tracking-[0.32em] text-[rgba(200,210,225,0.72)]">
              navigation
            </div>
            <div className="flex flex-col gap-1.5">
              {HINTS.map((h) => (
                <div
                  key={h.label}
                  className="flex items-center gap-2.5 font-display text-[10.5px] uppercase tracking-[0.24em] text-[rgba(230,236,244,0.88)]"
                >
                  {h.icon}
                  <span className="flex-1">{h.label}</span>
                  {h.hotkey && (
                    <span className="font-mono text-[9px] tracking-[0.2em] text-[rgba(170,185,205,0.58)]">
                      {h.hotkey}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---- utility (more) popover -----------------------------------------------

interface MoreProps {
  onLog: () => void
  onReset: () => void
  onSave: () => void
  onOpenSaved: () => void
  decisionCount: number
}

function MoreMenu({ onLog, onReset, onSave, onOpenSaved, decisionCount }: MoreProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const legendOpen = useStory((s) => s.legendOpen)
  const mediaLibraryOpen = useStory((s) => s.mediaLibraryOpen)
  const decisionLogOpen = useStory((s) => s.decisionLogOpen)

  // Mutual-exclusion with the side panels — see HelpChip for the
  // matching "open self → close side panels" path.
  useEffect(() => {
    if (legendOpen || mediaLibraryOpen || decisionLogOpen) setOpen(false)
  }, [legendOpen, mediaLibraryOpen, decisionLogOpen])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const onToggle = () => {
    setOpen((v) => {
      if (!v) {
        const s = useStory.getState()
        if (s.legendOpen) s.toggleLegend()
        if (s.mediaLibraryOpen) s.toggleMediaLibrary()
        if (s.decisionLogOpen) s.toggleDecisionLog()
      }
      return !v
    })
  }

  const item = (
    label: string,
    icon: React.ReactNode,
    handler: () => void,
    trailing?: React.ReactNode,
    danger = false,
  ) => (
    <button
      type="button"
      onClick={() => { handler(); setOpen(false) }}
      className="flex items-center gap-2.5 px-3 py-2 text-left font-display text-[10.5px] uppercase tracking-[0.24em] transition-colors"
      style={{
        color: 'rgba(230,236,244,0.88)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? 'rgba(231,76,60,0.12)' : 'rgba(79,195,247,0.1)'
        e.currentTarget.style.color = danger ? 'var(--red)' : 'var(--cyan)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'rgba(230,236,244,0.88)'
      }}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  )

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="More options"
        onClick={onToggle}
        className="flex h-9 w-9 items-center justify-center border backdrop-blur transition-colors"
        style={{
          background: open ? '#4fc3f7' : 'rgba(10,13,18,0.97)',
          color: open ? '#0a0d12' : 'rgba(230,236,244,0.85)',
          borderColor: open ? '#4fc3f7' : 'var(--line)',
        }}
        onMouseEnter={(e) => {
          if (open) return
          e.currentTarget.style.background = '#4fc3f7'
          e.currentTarget.style.color = '#0a0d12'
          e.currentTarget.style.borderColor = '#4fc3f7'
        }}
        onMouseLeave={(e) => {
          if (open) return
          e.currentTarget.style.background = 'rgba(10,13,18,0.97)'
          e.currentTarget.style.color = 'rgba(230,236,244,0.85)'
          e.currentTarget.style.borderColor = 'var(--line)'
        }}
      >
        {open ? <X size={14} strokeWidth={1.8} /> : <MoreHorizontal size={14} strokeWidth={1.8} />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.16 }}
            className={`${CHROME} absolute bottom-full right-0 mb-2 flex w-[220px] flex-col py-1`}
            style={{ boxShadow: '0 20px 48px rgba(0,0,0,0.55)' }}
          >
            {item(
              'decision log',
              <History size={12} strokeWidth={1.7} />,
              onLog,
              <span className="font-mono text-[9px] tabular-nums text-[var(--cyan)]">{decisionCount}</span>,
            )}
            {item('save story', <Save size={12} strokeWidth={1.7} />, onSave)}
            {item('open saved', <FolderOpen size={12} strokeWidth={1.7} />, onOpenSaved)}
            {item('reset tree', <RefreshCw size={12} strokeWidth={1.7} />, onReset, undefined, true)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---- main bar -------------------------------------------------------------

export function BottomBar({ onExpand, onComplete, onComposeScenes }: {
  onExpand: () => void
  onComplete: () => void
  onComposeScenes: () => void
}) {
  const current = useStory(selectCurrentNode)
  const toggleLegend = useStory((s) => s.toggleLegend)
  const legendOpen = useStory((s) => s.legendOpen)
  const toggleMediaLibrary = useStory((s) => s.toggleMediaLibrary)
  const mediaLibraryOpen = useStory((s) => s.mediaLibraryOpen)
  const finishedRenderCount = useStory((s) => s.renderJobs.filter((j) => j.status === 'done' && j.url).length)
  const toggleDecisionLog = useStory((s) => s.toggleDecisionLog)
  const decisionCount = useStory((s) => s.decisions.length)
  const openConfirmReset = useStory((s) => s.openConfirmReset)
  const nodeCount = useStory((s) => s.nodes.size)
  const sceneCount = useStory((s) => s.scenes.size)
  const [saveOpen, setSaveOpen] = useState(false)
  const [openOpen, setOpenOpen] = useState(false)

  const canExpand = !!current && current.childrenIds.length === 0 && current.status !== 'generating'
  const canCompose = nodeCount >= 3

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 flex items-end justify-between px-6 pb-5">
      {/* left — help only */}
      <div className="pointer-events-auto flex items-center gap-2">
        <HelpChip />
      </div>

      {/* centre — three agent primaries */}
      <div className="pointer-events-auto flex items-end gap-2">
        <AgentButton
          label={current && current.childrenIds.length > 0 ? 'ask again' : 'ask hermes'}
          hint={current && current.childrenIds.length > 0 ? 'regenerate choices' : 'offer choices'}
          icon={<Sparkles size={13} strokeWidth={2} />}
          accent="#4fc3f7"
          accentHover="rgba(79,195,247,0.2)"
          onClick={onExpand}
          disabled={!current}
          disabledReason={!current ? 'Select a node first' : undefined}
          busy={!!current && current.status === 'generating'}
          busyLabel="asking…"
        />
        <AgentButton
          label="scenes"
          hint="group into acts"
          icon={<Layers size={13} strokeWidth={2} />}
          accent="#b794ff"
          accentHover="rgba(167,139,250,0.22)"
          onClick={onComposeScenes}
          disabled={!canCompose}
          disabledReason="Need at least 3 nodes before scenes make sense"
          badge={sceneCount > 0 ? sceneCount : undefined}
        />
        <AgentButton
          label="write"
          hint="seal as prose"
          icon={<BookOpen size={13} strokeWidth={2} />}
          accent="#e9c16b"
          accentHover="rgba(233,193,107,0.2)"
          onClick={onComplete}
        />
      </div>

      {/* right — zoom + backdrop + legend + more */}
      <div className="pointer-events-auto flex items-center gap-2">
        <ZoomControl />
        <BackgroundPicker />
        <button
          type="button"
          onClick={toggleLegend}
          title="Show the icon / color / status legend"
          className="flex h-9 items-center gap-2 border px-3 font-display text-[10px] uppercase tracking-[0.28em] backdrop-blur transition-colors"
          style={{
            background: legendOpen ? '#4fc3f7' : 'rgba(10,13,18,0.97)',
            color: legendOpen ? '#0a0d12' : 'rgba(230,236,244,0.85)',
            borderColor: legendOpen ? '#4fc3f7' : 'var(--line)',
          }}
          onMouseEnter={(e) => {
            if (legendOpen) return
            e.currentTarget.style.background = '#4fc3f7'
            e.currentTarget.style.color = '#0a0d12'
            e.currentTarget.style.borderColor = '#4fc3f7'
          }}
          onMouseLeave={(e) => {
            if (legendOpen) return
            e.currentTarget.style.background = 'rgba(10,13,18,0.97)'
            e.currentTarget.style.color = 'rgba(230,236,244,0.85)'
            e.currentTarget.style.borderColor = 'var(--line)'
          }}
        >
          <Info size={12} strokeWidth={1.7} /> guide
        </button>
        <button
          type="button"
          onClick={toggleMediaLibrary}
          title="Generated medias — Reel · Sinematik · Audiobook"
          className="relative flex h-9 items-center gap-2 border px-3 font-display text-[10px] uppercase tracking-[0.28em] backdrop-blur transition-colors"
          style={{
            background: mediaLibraryOpen ? '#4fc3f7' : 'rgba(10,13,18,0.97)',
            color: mediaLibraryOpen ? '#0a0d12' : 'rgba(230,236,244,0.85)',
            borderColor: mediaLibraryOpen ? '#4fc3f7' : 'var(--line)',
          }}
          onMouseEnter={(e) => {
            if (mediaLibraryOpen) return
            e.currentTarget.style.background = '#4fc3f7'
            e.currentTarget.style.color = '#0a0d12'
            e.currentTarget.style.borderColor = '#4fc3f7'
          }}
          onMouseLeave={(e) => {
            if (mediaLibraryOpen) return
            e.currentTarget.style.background = 'rgba(10,13,18,0.97)'
            e.currentTarget.style.color = 'rgba(230,236,244,0.85)'
            e.currentTarget.style.borderColor = 'var(--line)'
          }}
        >
          <Film size={12} strokeWidth={1.7} /> media
          {finishedRenderCount > 0 && (
            <span
              className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center px-1 font-mono text-[9px] tabular-nums"
              style={{
                background: mediaLibraryOpen ? '#0a0d12' : 'var(--gold)',
                color: mediaLibraryOpen ? 'var(--gold)' : '#0a0d12',
              }}
            >
              {finishedRenderCount}
            </span>
          )}
        </button>
        <MoreMenu
          onLog={toggleDecisionLog}
          onReset={openConfirmReset}
          onSave={() => setSaveOpen(true)}
          onOpenSaved={() => setOpenOpen(true)}
          decisionCount={decisionCount}
        />
      </div>
      <SaveStoryModal open={saveOpen} onClose={() => setSaveOpen(false)} />
      <OpenSavedModal open={openOpen} onClose={() => setOpenOpen(false)} />
    </div>
  )
}
