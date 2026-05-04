'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { Cpu, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useStory } from '@/lib/store'
import type { AgentId, AgentEvent } from '@/lib/types'

/**
 * Agent activity panel.
 *
 * Two modes — toggle top-right:
 *  - ``storytelling`` (default): only narrative agents visible.  Done
 *    events fade after 6s.  Tool events (Registry / Moderation) hidden.
 *    Max 3 visible so the canvas stays breathable.
 *  - ``debug``: every event persistent, no fade, all categories.  For
 *    jury demos or troubleshooting the image pipeline.
 *
 * The dichotomy matches the hackathon's two audiences: the user wants
 * story-first immersion; the jury wants to watch the agents work.
 */

const AGENT_LABEL: Record<string, { name: string; accent: string; tooltip: string }> = {
  brainstorm:        { name: 'Brainstorm',      accent: '#4fc3f7', tooltip: 'Produces three divergent story branches from the current beat.' },
  character:         { name: 'Character',       accent: '#e9c16b', tooltip: 'Reasons from a character\'s interior when extending a beat.' },
  conflict:          { name: 'Conflict',        accent: '#e74c3c', tooltip: 'Escalates tension between characters.' },
  world:             { name: 'World',           accent: '#a78bfa', tooltip: 'Extends the setting / lore.' },
  critic:            { name: 'Critic',          accent: '#8a96aa', tooltip: 'Checks whether a downstream beat still fits after an insert.' },
  writer:            { name: 'Writer',          accent: '#f7d27c', tooltip: 'Seals the chosen canon path into prose.' },
  director:          { name: 'Director',        accent: '#a78bfa', tooltip: 'Orchestrates Critic → Rewriter → Judge across stale nodes.' },
  'writer-assist':   { name: 'Writer-Assist',   accent: '#4fc3f7', tooltip: 'Fleshes out a user-drafted branch into a full beat.' },
  'consistency-critic': { name: 'Critic',       accent: '#a78bfa', tooltip: 'Flags contradictions after an inserted beat.' },
  'scene-composer':  { name: 'Scene-Composer',  accent: '#c7a7ff', tooltip: 'Groups beats into scenes and acts.' },
  'character-sheet': { name: 'Cast Sheet',      accent: '#f472b6', tooltip: 'Builds the principal cast with portraits used as image references.' },
  judge:             { name: 'Judge',           accent: '#ffd47a', tooltip: 'Approves or rejects rewritten beats.' },
  'registry-lookup': { name: 'Registry',        accent: '#5eead4', tooltip: 'Reuses known character descriptions across scenes.' },
  'moderation-rewriter': { name: 'Moderation',  accent: '#fb923c', tooltip: 'Softens IP / violence tokens so the image model will render.' },
}

/** Agents whose events are surfaced in storytelling mode.  Tool-pipeline
 *  agents (Registry, Moderation) are filtered out unless the user flips
 *  to debug mode — they're implementation detail, not story. */
const NARRATIVE_AGENTS: Set<AgentId> = new Set<AgentId>([
  'brainstorm', 'writer', 'writer-assist', 'critic', 'judge',
  'director', 'scene-composer', 'character-sheet', 'consistency-critic',
  'character', 'conflict', 'world',
])

const INK_BRIGHT = 'rgba(234, 240, 248, 0.95)'
const INK_MED = 'rgba(198, 210, 226, 0.72)'
const INK_SOFT = 'rgba(170, 185, 205, 0.55)'

const FADE_MS = 6000  // done events linger this long before vanishing in storytelling mode
const MAX_VISIBLE = 3 // storytelling mode cap

export function AgentTicker() {
  const agents = useStory((s) => s.agents)
  const mode = useStory((s) => s.agentMode)
  const setMode = useStory((s) => s.setAgentMode)

  // Ticking re-render so fade-out happens on schedule.  Only runs while
  // storytelling mode has a fading event in flight — otherwise idle.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (mode === 'debug') return
    const hasFading = agents.some((a) => a.status === 'done' && Date.now() - a.startedAt < FADE_MS + 400)
    if (!hasFading) return
    const t = setInterval(() => setNow(Date.now()), 600)
    return () => clearInterval(t)
  }, [agents, mode])

  const visible = useMemo(() => {
    if (mode === 'debug') return agents
    return agents
      .filter((a) => NARRATIVE_AGENTS.has(a.agent))
      .filter((a) => {
        if (a.status === 'streaming' || a.status === 'thinking' || a.status === 'error') return true
        return now - a.startedAt < FADE_MS
      })
      .slice(-MAX_VISIBLE)
  }, [agents, mode, now])

  const hiddenCount = mode === 'storytelling'
    ? Math.max(0, agents.length - visible.length)
    : 0

  if (visible.length === 0 && mode === 'storytelling') {
    // Idle state — just the tiny header with the toggle so the user can
    // still open debug mode on demand.  Keeps the canvas clean.
    return <TickerHeader mode={mode} onToggle={() => setMode('debug')} />
  }

  return (
    <div className="pointer-events-none absolute left-6 top-[168px] z-10 flex w-[380px] flex-col gap-2">
      <TickerHeader mode={mode} onToggle={() => setMode(mode === 'storytelling' ? 'debug' : 'storytelling')} />
      {/* Unified panel — cards + "show all" footer share one opaque
          surround so the right edge reads as a single block instead of
          three loose cards plus a stray button.  Inner cards keep their
          accent stripe; the panel adds the cohesive background and a
          single border around everything. */}
      <div
        className="pointer-events-auto flex flex-col border backdrop-blur"
        style={{
          background: 'rgba(10, 13, 18, 0.92)',
          borderColor: 'rgba(255,255,255,0.07)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
        }}
      >
        <div className="flex flex-col gap-1.5 p-1.5">
          <AnimatePresence initial={false}>
            {visible.slice().reverse().map((a) => (
              <AgentEventCard key={a.id} event={a} />
            ))}
          </AnimatePresence>
        </div>
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setMode('debug')}
            className="flex items-center justify-center gap-1.5 border-t px-2 py-2 text-center font-mono text-[9.5px] uppercase tracking-[0.28em] transition-colors"
            style={{
              color: 'var(--gold)',
              borderColor: 'rgba(255,255,255,0.07)',
              background: 'rgba(233,193,107,0.05)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(233,193,107,0.14)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(233,193,107,0.05)'
            }}
            title="Show every agent + tool event"
          >
            ⋯ {hiddenCount} more · show all
          </button>
        )}
      </div>
    </div>
  )
}

function TickerHeader({ mode, onToggle }: { mode: 'storytelling' | 'debug'; onToggle: () => void }) {
  return (
    <div
      className="pointer-events-auto flex items-center gap-2 font-display text-[10px] uppercase tracking-[0.32em]"
      style={{ color: INK_MED }}
    >
      <Cpu size={11} strokeWidth={1.6} />
      agents · {mode === 'debug' ? 'debug' : 'live'}
      <button
        type="button"
        onClick={onToggle}
        className="ml-auto px-2 py-[3px] font-mono text-[9px] tracking-[0.22em] transition-colors"
        style={{
          border: '1px solid rgba(255,255,255,0.08)',
          color: mode === 'debug' ? 'var(--cyan)' : INK_SOFT,
          background: mode === 'debug' ? 'rgba(79,195,247,0.1)' : 'transparent',
        }}
        title={mode === 'debug' ? 'Hide tool events, auto-fade narrative' : 'Show every agent + tool event, persistent'}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'rgba(79,195,247,0.4)'
          e.currentTarget.style.color = 'var(--cyan)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
          e.currentTarget.style.color = mode === 'debug' ? 'var(--cyan)' : INK_SOFT
        }}
      >
        {mode === 'debug' ? 'Show Less' : 'Show Agent Flow'}
      </button>
    </div>
  )
}

function AgentEventCard({ event: a }: { event: AgentEvent }) {
  const meta = AGENT_LABEL[a.agent] ?? { name: a.agent, accent: '#4fc3f7', tooltip: '' }
  const isActive = a.status === 'thinking' || a.status === 'streaming'
  const [expanded, setExpanded] = useState(false)

  // Truncate long done-event texts.  Active events show full stream.
  // Cap doubled so brainstorm replies — which run multi-line —
  // surface the first two/three options inline instead of one.
  const showFull = isActive || expanded
  const preview = showFull ? a.text : truncate(a.text, 280)

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12, transition: { duration: 0.28 } }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="pointer-events-auto relative px-3 py-2"
      style={{
        background: 'rgba(15, 19, 27, 0.6)',
        boxShadow: isActive
          ? `inset 3px 0 0 ${meta.accent}, 0 0 18px ${meta.accent}22`
          : `inset 3px 0 0 ${meta.accent}`,
      }}
    >
      <div className="flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.28em]">
        <span
          style={{ color: meta.accent, fontWeight: 600 }}
          title={meta.tooltip}
          className="cursor-help"
        >
          {meta.name}
        </span>
        <span style={{ color: INK_SOFT }}>· {a.model}</span>
        {isActive && (
          <span className="ml-auto flex items-center gap-1" style={{ color: meta.accent }}>
            <Zap size={9} strokeWidth={2} /> {a.status}
          </span>
        )}
        {a.status === 'done' && <span className="ml-auto" style={{ color: INK_SOFT }}>done</span>}
        {a.status === 'error' && <span className="ml-auto text-[var(--red)]">error</span>}
      </div>

      {/* Subject line — carries the agent event's specific target
          (character name for portrait renders, beat title for brainstorm,
          image model for image-gen etc.).  Without this the ticker shows
          3 identical "Cast Sheet · portrait render · streaming" cards when
          three portraits render in parallel, giving the viewer no way to
          tell which character each card belongs to. */}
      {a.label && a.label !== meta.name && (
        <div
          className="mt-1 font-display text-[11.5px] uppercase tracking-[0.2em]"
          style={{ color: INK_BRIGHT, letterSpacing: '0.16em' }}
        >
          {a.label}
        </div>
      )}

      {isActive && (
        <div className="mt-1.5 h-[1px] w-full overflow-hidden" style={{ background: `${meta.accent}22` }}>
          <motion.div
            className="h-full"
            style={{ background: meta.accent, boxShadow: `0 0 8px ${meta.accent}` }}
            animate={{ x: ['-100%', '100%'] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
          />
        </div>
      )}

      {a.text ? (
        a.status === 'streaming' ? (
          <div className="mt-1.5 max-h-[240px] overflow-hidden font-mono text-[10.5px] leading-[1.5]" style={{ color: INK_BRIGHT }}>
            <div className="line-clamp-12 whitespace-pre-wrap break-all">
              {a.text}
              <span className="caret" />
            </div>
          </div>
        ) : (
          <div className="mt-1.5 whitespace-pre-wrap font-display text-[12px] leading-[1.55]" style={{ color: INK_BRIGHT }}>
            {preview}
            {!showFull && a.text.length > 140 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="ml-1 align-baseline font-mono text-[9.5px] uppercase tracking-[0.24em] text-[var(--cyan)] underline-offset-2 hover:underline"
              >
                more
              </button>
            )}
          </div>
        )
      ) : (
        <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em]" style={{ color: INK_SOFT }}>
          <LoadingDots accent={meta.accent} />
          <span>reading context</span>
        </div>
      )}
    </motion.div>
  )
}

function truncate(text: string, max: number): string {
  if (!text) return ''
  if (text.length <= max) return text
  return text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…'
}

function LoadingDots({ accent }: { accent: string }) {
  return (
    <span className="inline-flex items-center gap-[3px]">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="inline-block"
          style={{ width: 4, height: 4, background: accent, borderRadius: 1 }}
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
        />
      ))}
    </span>
  )
}
