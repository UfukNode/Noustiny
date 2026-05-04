'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Sparkles, Pencil, Wand2, ArrowRight, History, Bot, Infinity, ChevronRight } from 'lucide-react'
import { useStory } from '@/lib/store'
import { DEMO_SEED } from '@/lib/demo-seed'
import { detectStoryPolicy, generateCharacterSheet } from '@/lib/hermes-client'
import { SavedStoriesGrid } from './SavedStoriesList'
import { listSaves } from '@/lib/save-system'

const EXAMPLES = [
  {
    label: 'Endgame — the gauntlet moment',
    text: DEMO_SEED,
  },
  {
    label: 'Avatar: The Last Airbender — Aang wakes in the iceberg',
    text:
      'At the South Pole, Aang lies frozen inside a massive iceberg — unconscious, eyes closed, asleep for a hundred years. Katara and Sokka of the Southern Water Tribe discover him and call out through the ice, trying to wake the Avatar.',
  },
  {
    label: 'Breaking Bad — the last phone call',
    text:
      'Walt stands at the payphone outside a New Hampshire diner. Every option he weighs in his head will end something. Which one does he choose to end?',
  },
  {
    label: 'Istanbul — the nameless hacker awakens',
    text:
      'A hacker wakes at the foot of the Galata Tower; a cybernetic implant sits beneath the skin of his arm, and he has no memory of the last three years. The time is 03:17.',
  },
]

/** "What if" prompts — pinned to a single demo seed for the hackathon
 *  showcase so the WhatIfButton always feeds the deterministic story
 *  the demo script expects.  Memory-only, never persisted. */
const WHAT_IF_PROMPTS: string[] = [
  'As Sauron stepped into the War of the Last Alliance to crush the remaining resistance, a sudden radiance broke the darkness. Galadriel had arrived',
]

export function SeedInput() {
  const [text, setText] = useState(DEMO_SEED)
  const [tab, setTab] = useState<'new' | 'saved'>('new')
  const [saveCount, setSaveCount] = useState(0)
  const enterCanvas = useStory((s) => s.enterCanvas)

  // Refresh save count whenever tab toggles (cheap — localStorage read).
  useEffect(() => { setSaveCount(listSaves().length) }, [tab])

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden">
      {/* ambient backdrop */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 25% 30%, rgba(79,195,247,0.08), transparent 55%), radial-gradient(ellipse at 75% 70%, rgba(233,193,107,0.06), transparent 55%)',
        }}
      />

      {/* thin top chrome */}
      <div className="relative z-10 flex items-center justify-between px-8 py-5">
        <div className="font-display text-[26px] font-light uppercase tracking-[0.5em] leading-none text-[var(--ink-dim)]">
          Noustiny
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">
          nous research · hermes
        </div>
      </div>

      {/* hero */}
      <div className="relative z-10 flex flex-1 items-center justify-center px-8">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="w-full max-w-[760px] corner-brackets"
        >
          <div className="flex items-center gap-3 font-display text-[11px] uppercase tracking-[0.36em] text-[var(--cyan)]">
            <span className="h-px w-8 bg-[var(--cyan)] opacity-50" />
            <Sparkles size={12} strokeWidth={1.5} />
            Branching narrative engine
          </div>
          <h1 className="mt-5 font-display text-[56px] font-light leading-[1.02] tracking-[-0.01em] text-[var(--ink)]">
            Every choice is a universe.<br />
            <span className="text-[var(--cyan)]">What if…</span>
          </h1>
          <p className="mt-4 max-w-[560px] text-[14px] leading-[1.7] text-[var(--ink-dim)]">
            Drop a scene, a memory, or a decision you can&rsquo;t stop rehearsing.
            A council of Hermes agents will branch it into the lives it could
            have been — and let you walk into any of them.
          </p>

          {/* Tab strip — NEW STORY vs. RESUME SAVED */}
          <div className="mt-7 flex items-center gap-2 border-b border-[var(--line)]">
            {([
              { key: 'new' as const, label: 'New story', icon: <Sparkles size={11} strokeWidth={1.7} /> },
              { key: 'saved' as const, label: `Resume saved${saveCount > 0 ? ` · ${saveCount}` : ''}`, icon: <History size={11} strokeWidth={1.7} /> },
            ]).map((t) => {
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className="relative -mb-[1px] flex items-center gap-2 px-3 py-2 font-display text-[10.5px] uppercase tracking-[0.28em] transition-colors"
                  style={{
                    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                    borderBottom: active ? '2px solid var(--cyan)' : '2px solid transparent',
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = 'var(--ink)' }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = 'var(--ink-dim)' }}
                >
                  {t.icon}
                  {t.label}
                </button>
              )
            })}
          </div>

          {tab === 'saved' ? (
            <div className="mt-5">
              <SavedStoriesGrid />
            </div>
          ) : (
          <>
          <div className="mt-5 border border-[var(--line)] bg-[var(--surface-panel)] backdrop-blur-sm">
            <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-2">
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">
                <Pencil size={11} strokeWidth={1.5} /> seed
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.26em] text-[var(--ink-faint)]">
                {text.length}/600
              </div>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 600))}
              rows={4}
              placeholder="A scene, a decision, a character at a crossroads…"
              className="w-full resize-none bg-transparent px-4 py-4 font-display text-[16px] leading-[1.55] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
            />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {EXAMPLES.map((ex) => {
              const active = text.trim() === ex.text.trim()
              return (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => setText(ex.text)}
                  className="flex items-center gap-2 border px-3 py-1.5 font-display text-[10px] uppercase tracking-[0.26em] transition-colors"
                  style={{
                    borderColor: active ? 'var(--cyan)' : 'var(--line)',
                    background: active ? 'var(--surface-accent-ink)' : 'var(--surface-inset)',
                    color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                    boxShadow: active ? '0 0 14px rgba(79,195,247,0.28)' : 'none',
                  }}
                  onMouseEnter={(e) => {
                    if (active) return
                    e.currentTarget.style.borderColor = 'var(--cyan)'
                    e.currentTarget.style.color = 'var(--cyan)'
                  }}
                  onMouseLeave={(e) => {
                    if (active) return
                    e.currentTarget.style.borderColor = 'var(--line)'
                    e.currentTarget.style.color = 'var(--ink-dim)'
                  }}
                >
                  <Wand2 size={11} strokeWidth={1.5} />
                  {ex.label}
                </button>
              )
            })}
            <WhatIfButton onPick={(seed) => setText(seed)} />
          </div>

          <div className="mt-8 flex items-center justify-between">
            <PipelineFlow />
            <button
              type="button"
              disabled={!text.trim()}
              onClick={() => {
                const seed = text.trim() || DEMO_SEED
                // Detector writes the deterministic policy baseline
                // synchronously (franchise slug etc.), so character-sheet
                // can read it from the store on the next event-loop tick.
                // Both are fire-and-forget: enterCanvas opens the canvas
                // immediately while the skill calls stream in the
                // background and populate the agent ticker live.
                void detectStoryPolicy(seed)
                void generateCharacterSheet(seed)
                enterCanvas(seed)
              }}
              className="group flex shrink-0 items-center gap-3 whitespace-nowrap border border-[var(--gold)] px-7 py-3.5 font-display text-[13px] uppercase tracking-[0.36em] text-[var(--gold)] transition-all disabled:opacity-40"
              style={{
                background: 'rgba(233,193,107,0.08)',
                boxShadow: '0 0 28px rgba(233,193,107,0.32), inset 0 0 0 1px rgba(233,193,107,0.18)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(233,193,107,0.16)'
                e.currentTarget.style.boxShadow = '0 0 36px rgba(233,193,107,0.48), inset 0 0 0 1px rgba(233,193,107,0.28)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(233,193,107,0.08)'
                e.currentTarget.style.boxShadow = '0 0 28px rgba(233,193,107,0.32), inset 0 0 0 1px rgba(233,193,107,0.18)'
              }}
            >
              Enter the divergence
              <ArrowRight
                size={15}
                strokeWidth={1.8}
                className="transition-transform group-hover:translate-x-1"
              />
            </button>
          </div>
          </>
          )}
        </motion.div>
      </div>

      {/* bottom chrome */}
      <div className="relative z-10 flex items-center justify-between px-8 py-4 font-mono text-[9px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">
        <span>no login · all in your browser and local saves</span>
        <span>nous · hermes ai</span>
      </div>
    </div>
  )
}

/** Eye-catching example tile — gold core, cyan light circulating
 *  around the border via a conic-gradient mask.  Picks a random
 *  cross-franchise "what if" seed from WHAT_IF_PROMPTS each click,
 *  so the same press never feeds the same prompt twice in a row.
 *  Magic-UI-style border-beam without the breathing/pulse — the
 *  rotation alone reads as "live" without strobing. */
function WhatIfButton({ onPick }: { onPick: (seed: string) => void }) {
  const [lastIndex, setLastIndex] = useState(-1)
  const handle = () => {
    if (WHAT_IF_PROMPTS.length === 0) return
    let next = Math.floor(Math.random() * WHAT_IF_PROMPTS.length)
    if (WHAT_IF_PROMPTS.length > 1 && next === lastIndex) {
      next = (next + 1) % WHAT_IF_PROMPTS.length
    }
    setLastIndex(next)
    onPick(WHAT_IF_PROMPTS[next])
  }
  return (
    <button
      type="button"
      onClick={handle}
      title="Toss a cross-franchise mashup at Hermes"
      className="relative isolate flex items-center gap-2 overflow-hidden border px-3 py-1.5 font-display text-[10px] uppercase tracking-[0.26em] transition-colors"
      style={{
        // Solid gold-tinted ink so the cyan beam reads as a halo,
        // not as the button's primary surface.
        borderColor: 'rgba(233,193,107,0.55)',
        background: 'rgba(233,193,107,0.10)',
        color: 'var(--gold)',
        boxShadow: '0 0 18px rgba(233,193,107,0.18), inset 0 0 0 1px rgba(233,193,107,0.08)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(233,193,107,0.18)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(233,193,107,0.10)'
      }}
    >
      {/* Rotating cyan beam — conic gradient pinned behind the button,
          masked to a 1.5px ring so only the perimeter glows.  Speed
          tuned to ~3.2s per revolution: fast enough to read as alive,
          slow enough to not flicker.  Pure CSS, no JS frame loop. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-px"
        style={{
          background:
            'conic-gradient(from 0deg, transparent 0%, rgba(79,195,247,0.0) 60%, rgba(79,195,247,0.95) 75%, rgba(79,195,247,0.0) 90%, transparent 100%)',
          animation: 'whatifBeamSpin 3.2s linear infinite',
          // Mask: keep the gradient only at the border ring, hollow
          // out the inside so the gold core stays readable.
          WebkitMask:
            'linear-gradient(#000, #000) content-box, linear-gradient(#000, #000)',
          WebkitMaskComposite: 'xor',
          mask: 'linear-gradient(#000, #000) content-box, linear-gradient(#000, #000)',
          maskComposite: 'exclude',
          padding: 1.5,
          zIndex: -1,
        }}
      />
      <Sparkles size={11} strokeWidth={1.6} />
      Wonder What If ?
      <style jsx>{`
        @keyframes whatifBeamSpin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </button>
  )
}

/** A 4-step pipeline strip showing the actual Hermes flow that fires
 *  the moment the user enters: seed → brainstorm skill → image gen →
 *  branches on canvas.  Replaces the lazy "3-4 branches" copy with a
 *  visual that reads like a tool diagram, so the AI work happening in
 *  the background is legible to the jury at a glance.  Cyan accents on
 *  hover to telegraph "this is AI machinery, not decoration." */
function PipelineFlow() {
  const steps: { icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>; label: string; tint: string }[] = [
    { icon: Sparkles, label: 'seed',   tint: 'rgba(230,236,244,0.78)' },
    { icon: Bot,      label: 'hermes', tint: 'var(--gold)' },
    { icon: Infinity, label: 'infinity', tint: 'var(--cyan)' },
  ]
  return (
    <div className="flex items-center gap-2 font-mono text-[9.5px] uppercase tracking-[0.28em]">
      {steps.map((s, i) => {
        const Icon = s.icon
        return (
          <div key={s.label} className="flex items-center gap-2">
            <span
              className="flex items-center gap-1.5 border border-[var(--line)] bg-[rgba(15,19,27,0.45)] px-2 py-1"
              style={{ color: s.tint }}
            >
              <Icon size={10} strokeWidth={1.8} />
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <ChevronRight
                size={11}
                strokeWidth={1.6}
                className="text-[var(--ink-faint)]"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
