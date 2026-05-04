'use client'

import { AnimatePresence, motion } from 'framer-motion'
import {
  X, Bot, User, Sparkles, Plus, RotateCcw,
  ShieldCheck, Gavel, Pencil, CircleDot, Lock, Layers,
} from 'lucide-react'
import { useStory } from '@/lib/store'
import type { Decision, DecisionAction } from '@/lib/types'

const ACTION_LABEL: Record<DecisionAction, string> = {
  expand: 'EXPAND',
  select: 'SELECT',
  insert: 'INSERT',
  remove_inserted: 'REMOVE',
  keep_stale: 'KEEP',
  critique: 'CRITIQUE',
  rewrite: 'REWRITE',
  judge: 'JUDGE',
  human_override: 'OVERRIDE',
  seal: 'SEAL',
  compose_scenes: 'COMPOSE',
}

const ACTION_TINT: Record<DecisionAction, string> = {
  expand: '#4fc3f7',
  select: '#e9c16b',
  insert: '#e9c16b',
  remove_inserted: '#e74c3c',
  keep_stale: '#8a96aa',
  critique: '#a78bfa',
  rewrite: '#4fc3f7',
  judge: '#f7d27c',
  human_override: '#e74c3c',
  seal: '#e9c16b',
  compose_scenes: '#c7a7ff',
}

function ActionIcon({ action }: { action: DecisionAction }) {
  const props = { size: 11, strokeWidth: 1.8 }
  switch (action) {
    case 'expand': return <Sparkles {...props} />
    case 'select': return <CircleDot {...props} />
    case 'insert': return <Plus {...props} />
    case 'remove_inserted': return <X {...props} />
    case 'keep_stale': return <Lock {...props} />
    case 'critique': return <ShieldCheck {...props} />
    case 'rewrite': return <Pencil {...props} />
    case 'judge': return <Gavel {...props} />
    case 'human_override': return <RotateCcw {...props} />
    case 'seal': return <Lock {...props} />
    case 'compose_scenes': return <Layers {...props} />
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function nodeTitle(id: string, nodes: Map<string, { title: string }>): string {
  return nodes.get(id)?.title ?? `#${id.slice(0, 6)}`
}

export function DecisionLog() {
  const open = useStory((s) => s.decisionLogOpen)
  const close = useStory((s) => s.toggleDecisionLog)
  const decisions = useStory((s) => s.decisions)
  const nodes = useStory((s) => s.nodes)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm"
          onClick={close}
        >
          <motion.div
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.26, ease: 'easeOut' }}
            className="absolute right-0 top-0 h-full w-[460px] border-l border-[var(--line)] bg-[rgba(10,13,18,0.97)]"
            style={{ boxShadow: '-20px 0 60px rgba(0,0,0,0.55)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--ink-faint)]">
                  Provenance
                </div>
                <div className="mt-1 font-display text-[14px] uppercase tracking-[0.24em] text-[var(--cyan)]">
                  Decision log
                </div>
              </div>
              <button
                onClick={close}
                className="text-[var(--ink-faint)] hover:text-[var(--ink)]"
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>

            <div className="h-[calc(100%-66px)] overflow-y-auto px-5 py-4">
              {decisions.length === 0 ? (
                <div className="mt-8 text-center font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">
                  no decisions yet · click a node to begin
                </div>
              ) : (
                <ol className="relative space-y-2 pl-5">
                  <div className="absolute left-[7px] top-2 bottom-2 w-px bg-[var(--line)]" />
                  {decisions.slice().reverse().map((d) => (
                    <Row key={d.id} d={d} nodeTitle={(id) => nodeTitle(id, nodes)} />
                  ))}
                </ol>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Row({ d, nodeTitle }: { d: Decision; nodeTitle: (id: string) => string }) {
  const tint = ACTION_TINT[d.action]
  const isHuman = d.decidedBy === 'human'

  return (
    <li className="relative">
      <span
        className="absolute -left-[18px] top-1.5 flex h-3 w-3 items-center justify-center rounded-full"
        style={{ background: tint, boxShadow: `0 0 8px ${tint}` }}
      />
      <div className="border border-[var(--line)] bg-[rgba(15,19,27,0.6)] px-3 py-2">
        <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.22em]">
          <span className="flex items-center gap-1" style={{ color: tint }}>
            <ActionIcon action={d.action} />
            {ACTION_LABEL[d.action]}
          </span>
          <span className="ml-auto text-[var(--ink-faint)]">{formatTime(d.createdAt)}</span>
        </div>
        <div className="mt-1.5 font-display text-[12px] uppercase tracking-[0.14em] text-[var(--ink)]">
          {nodeTitle(d.targetNodeId)}
        </div>
        {d.reason && (
          <div className="mt-1 text-[11px] leading-[1.5] text-[var(--ink-dim)]">
            {d.reason}
          </div>
        )}
        <div className="mt-2 flex items-center gap-3 font-mono text-[9px] uppercase tracking-[0.24em] text-[var(--ink-faint)]">
          <span className="flex items-center gap-1">
            {isHuman
              ? <User size={9} strokeWidth={2} className="text-[var(--gold)]" />
              : <Bot size={9} strokeWidth={2} className="text-[var(--cyan)]" />}
            {isHuman ? 'you' : d.agentName?.replace('hermes-', '') ?? 'agent'}
          </span>
          {typeof d.score === 'number' && (
            <span>score {d.score.toFixed(2)}</span>
          )}
        </div>
      </div>
    </li>
  )
}
