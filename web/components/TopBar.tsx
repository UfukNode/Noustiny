'use client'

import { Home, Layers, MessageCircleQuestion, Pause } from 'lucide-react'
import { useShallow } from 'zustand/shallow'
import { useStory, selectCanonPath, selectCurrentNode } from '@/lib/store'

export function TopBar() {
  const canonPath = useStory(useShallow(selectCanonPath))
  const current = useStory(selectCurrentNode)
  const nodeCount = useStory((s) => s.nodes.size)
  const autoAsk = useStory((s) => s.autoAsk)
  const setAutoAsk = useStory((s) => s.setAutoAsk)
  const resetToLanding = useStory((s) => s.resetToLanding)

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-6 px-6 pt-5">
      {/* left — brand on top, then [home] | beat title row.  Beat title
           sits in a flex row whose vertical center matches the home
           button so the cyan separator + title read as one horizontal
           band anchored to the home button. */}
      <div className="pointer-events-auto flex min-w-0 flex-1 flex-col gap-2">
        <div className="font-display text-[20px] font-light uppercase tracking-[0.42em] text-[var(--ink)]">
          Noustiny
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={resetToLanding}
            title="Back to landing — start a new story"
            aria-label="Home"
            className="group flex h-9 w-9 shrink-0 items-center justify-center border transition-colors"
            style={{
              background: 'rgba(10,13,18,0.88)',
              borderColor: 'var(--line)',
              color: 'rgba(230,236,244,0.78)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#4fc3f7'
              e.currentTarget.style.color = '#0a0d12'
              e.currentTarget.style.borderColor = '#4fc3f7'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(10,13,18,0.88)'
              e.currentTarget.style.color = 'rgba(230,236,244,0.78)'
              e.currentTarget.style.borderColor = 'var(--line)'
            }}
          >
            <Home size={14} strokeWidth={1.7} />
          </button>
          <span className="h-px w-8 shrink-0 bg-gradient-to-r from-transparent via-[var(--cyan)] to-transparent opacity-60" />
          <div
            className="min-w-0 flex-1 truncate font-display text-[12px] uppercase tracking-[0.2em] text-[var(--ink-dim)]"
            title={current?.title ?? 'Divergence Engine'}
          >
            {current?.title ?? 'Divergence Engine'}
          </div>
        </div>
      </div>

      {/* right — compact session strip: depth · nodes · auto-ask */}
      <div className="pointer-events-auto flex shrink-0 items-center gap-3 font-mono text-[10px] uppercase tracking-[0.26em] text-[var(--ink-dim)]">
        <span className="flex items-center gap-1.5">
          <Layers size={11} strokeWidth={1.5} />
          depth <span className="text-[var(--cyan)]">{canonPath.length - 1}</span>
        </span>
        <span className="text-[var(--line)]">·</span>
        <span>
          nodes <span className="text-[var(--cyan)]">{nodeCount}</span>
        </span>
        <span className="text-[var(--line)]">·</span>
        <button
          type="button"
          onClick={() => setAutoAsk(!autoAsk)}
          title={
            autoAsk
              ? 'Auto-ask is ON — Hermes proposes choices every time you walk to a new beat.'
              : 'Auto-ask is OFF — no choices until you click Ask Hermes on the current beat.'
          }
          className="flex items-center gap-1.5 border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.24em] transition-colors"
          style={{
            color: autoAsk ? 'var(--cyan)' : 'var(--ink-dim)',
            borderColor: autoAsk ? 'var(--cyan)' : 'var(--line)',
            background: autoAsk ? 'rgba(79,195,247,0.08)' : 'rgba(10,13,18,0.6)',
          }}
          onMouseEnter={(e) => {
            if (autoAsk) return
            e.currentTarget.style.color = 'var(--ink)'
            e.currentTarget.style.borderColor = 'var(--ink-dim)'
          }}
          onMouseLeave={(e) => {
            if (autoAsk) return
            e.currentTarget.style.color = 'var(--ink-dim)'
            e.currentTarget.style.borderColor = 'var(--line)'
          }}
        >
          {autoAsk ? <MessageCircleQuestion size={11} strokeWidth={1.7} /> : <Pause size={10} strokeWidth={1.8} />}
          auto-ask · {autoAsk ? 'on' : 'off'}
        </button>
      </div>
    </div>
  )
}
