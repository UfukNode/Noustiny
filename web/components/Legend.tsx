'use client'

import { Info, X } from 'lucide-react'
import { useStory } from '@/lib/store'

/**
 * Always-dark chrome so the legend reads the same on Detroit-light and
 * Detroit-dark backdrops. Text colours are hard-coded — CSS vars would
 * invert on the light theme (`--ink` becomes dark navy) and vanish against
 * the dark panel.
 */

const INK_BRIGHT = 'rgba(234, 240, 248, 0.96)'
const INK_MED = 'rgba(198, 210, 226, 0.82)'
const INK_SOFT = 'rgba(170, 185, 205, 0.62)'

interface Row {
  dot: string
  label: string
  note: string
}

const STATUS_ROWS: Row[] = [
  { dot: '#e9c16b', label: 'Current',  note: 'The node you\'re inhabiting right now. Golden, scanlined.' },
  { dot: '#4fc3f7', label: 'Canon',    note: 'Your selected storyline. Cyan pulse flows through it.' },
  { dot: '#64748b', label: 'Visited',  note: 'A path you once walked but moved away from.' },
  { dot: '#3a4558', label: 'What-if',  note: 'Sibling branches no one has chosen yet. They wait.' },
  { dot: '#4fc3f7', label: 'Weaving',  note: 'Hermes agents are filling children in. Locked until ready.' },
]

const MOOD_ROWS: { glyph: string; label: string; tint: string; note: string }[] = [
  { glyph: '→', label: 'Neutral',   tint: '#8a96aa', note: 'Plain narrative momentum.' },
  { glyph: '★', label: 'Hopeful',   tint: '#e9c16b', note: 'Characters believing the best.' },
  { glyph: '⚠', label: 'Tense',     tint: '#e9c16b', note: 'Pressure building, not yet breaking.' },
  { glyph: '☠', label: 'Danger',    tint: '#e74c3c', note: 'Fatal stakes present.' },
  { glyph: '✧', label: 'Climax',    tint: '#e9c16b', note: 'The pivotal beat.' },
  { glyph: '♡', label: 'Quiet',     tint: '#8a96aa', note: 'Aftermath, breath, grief.' },
  { glyph: '◉', label: 'Discovery', tint: '#4fc3f7', note: 'The moment a truth becomes visible.' },
]

export function Legend() {
  const open = useStory((s) => s.legendOpen)
  const toggle = useStory((s) => s.toggleLegend)

  if (!open) return null

  return (
    <div
      className="fixed right-6 bottom-[72px] z-40 w-[400px] max-h-[80vh] overflow-y-auto border backdrop-blur"
      style={{
        background: 'rgba(10, 13, 18, 0.97)',
        borderColor: 'var(--line)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
      }}
    >
      <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-2.5" style={{ background: 'rgba(10, 13, 18, 0.98)' }}>
        <div className="flex items-center gap-2">
          <Info size={11} strokeWidth={1.8} style={{ color: '#4fc3f7' }} />
          <span className="font-display text-[12px] uppercase tracking-[0.32em]" style={{ color: '#4fc3f7' }}>
            Guide
          </span>
        </div>
        <button
          onClick={toggle}
          aria-label="Close legend"
          className="transition-colors"
          style={{ color: INK_SOFT }}
          onMouseEnter={(e) => { e.currentTarget.style.color = INK_BRIGHT }}
          onMouseLeave={(e) => { e.currentTarget.style.color = INK_SOFT }}
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <Section title="Status" rows={STATUS_ROWS} />
      <MoodSection />

      <div className="border-t border-[var(--line)] px-5 py-3 font-mono text-[9px] uppercase tracking-[0.28em]" style={{ color: INK_SOFT }}>
        click any node · it becomes current · siblings stay alive
      </div>
    </div>
  )
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="border-b border-[var(--line)] px-5 py-4">
      <div className="mb-3 font-mono text-[9px] uppercase tracking-[0.32em]" style={{ color: INK_SOFT }}>
        {title}
      </div>
      <div className="flex flex-col gap-2.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-3">
            <span
              className="mt-[5px] block h-[10px] w-[10px] shrink-0"
              style={{ background: r.dot, boxShadow: `0 0 10px ${r.dot}aa` }}
            />
            <div className="flex-1">
              <div className="font-display text-[11px] uppercase tracking-[0.24em]" style={{ color: INK_BRIGHT }}>
                {r.label}
              </div>
              <div className="mt-0.5 text-[11.5px] leading-[1.5]" style={{ color: INK_MED }}>
                {r.note}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function MoodSection() {
  return (
    <div className="px-5 py-4">
      <div className="mb-3 font-mono text-[9px] uppercase tracking-[0.32em]" style={{ color: INK_SOFT }}>
        Mood glyphs
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {MOOD_ROWS.map((m) => (
          <div key={m.label} className="flex items-start gap-2.5">
            <span
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center font-mono text-[12px]"
              style={{
                color: m.tint,
                border: `1px solid ${m.tint}66`,
                background: `${m.tint}14`,
              }}
            >
              {m.glyph}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-display text-[10.5px] uppercase tracking-[0.22em]" style={{ color: INK_BRIGHT }}>
                {m.label}
              </div>
              <div className="text-[10.5px] leading-[1.45]" style={{ color: INK_MED }}>
                {m.note}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
