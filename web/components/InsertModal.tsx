'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Sparkles, Wand2, GitBranch, GitMerge, AlertTriangle, PenLine, ArrowLeft } from 'lucide-react'
import { useStory } from '@/lib/store'
import { writerAssist, reharmonize, generateNodeImage } from '@/lib/hermes-client'
import type { NodeMood, StoryNode as TStoryNode } from '@/lib/types'

const MOOD_ACCENT: Record<NodeMood, string> = {
  neutral:   '#8a96aa',
  hopeful:   '#e9c16b',
  tense:     '#ff9f40',
  danger:    '#e74c3c',
  climax:    '#ffd378',
  quiet:     '#64a0dc',
  discovery: '#a78bfa',
}

/**
 * Insert-a-beat modal — agent-first redesign.
 *
 * The old flow competed two input modes at once (intent + manual
 * fields both visible, plus a checkbox to pick which one runs).  That
 * carried six discrete controls on screen before the user read a
 * word.  The redesign collapses it to one primary flow:
 *
 *   1. Canon / What-if tabs (always visible — this IS the one
 *      irreducible choice).
 *   2. Intent textarea — big, primary, labelled "what happens next?".
 *      Hermes spins up a full beat from this.
 *   3. Small "write it yourself" link that flips the form into manual
 *      mode (title / body / mood).  The manual form replaces the
 *      intent input — users aren't staring at two ways to do the
 *      same thing at the same time.
 *   4. Cancel / Insert at the foot.
 *
 * Result: two inputs at rest (tabs + intent), escape hatch for power
 * users, zero visual noise for 95% of the hackathon-demo path.
 */

const MOODS: { id: NodeMood; label: string }[] = [
  { id: 'neutral',   label: 'Neutral' },
  { id: 'hopeful',   label: 'Hopeful' },
  { id: 'tense',     label: 'Tense' },
  { id: 'danger',    label: 'Danger' },
  { id: 'climax',    label: 'Climax' },
  { id: 'quiet',     label: 'Quiet' },
  { id: 'discovery', label: 'Discovery' },
]

export function InsertModal() {
  const ctx = useStory((s) => s.insertContext)
  const close = useStory((s) => s.closeInsertModal)
  const nodes = useStory((s) => s.nodes)
  const insertBetween = useStory((s) => s.insertBetween)
  const insertShell = useStory((s) => s.insertShell)
  const fillInsertedShell = useStory((s) => s.fillInsertedShell)
  const removeInserted = useStory((s) => s.removeInserted)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [mood, setMood] = useState<NodeMood>('tense')
  const [mode, setMode] = useState<'canon' | 'what-if'>('canon')
  const [manual, setManual] = useState(false)
  const [intent, setIntent] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (ctx) {
      setTitle(''); setBody(''); setMood('tense')
      // Honour the mode lock from the trigger — arm-+ opens 'canon',
      // trunk-+ opens 'what-if'.  When neither is specified we default
      // to 'canon' so the primary action stays the Detroit "change the
      // story" gesture.
      setMode(ctx.mode ?? 'canon')
      setManual(false); setIntent('')
      setError(null)
    }
  }, [ctx])

  useEffect(() => {
    if (!ctx) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctx, close])

  if (!ctx) return null
  const parent = nodes.get(ctx.parentId)
  const child = nodes.get(ctx.childId)
  if (!parent || !child) return null

  const canSubmit = manual
    ? title.trim().length >= 2 && body.trim().length >= 8
    : intent.trim().length >= 4

  const submit = () => {
    setError(null)
    // Manual branch — content is known now, use the single-phase path.
    if (manual) {
      const branch = {
        title: title.trim(),
        summary: body.trim().slice(0, 160),
        body: body.trim(),
        imagePrompt: `${title.trim()} — cinematic still, ${mood} mood`,
        mood,
        tone: (mode === 'canon' ? 'canon' : 'what-if') as 'canon' | 'what-if',
        worldPercent: mode === 'canon' ? Math.floor(55 + Math.random() * 40) : Math.floor(5 + Math.random() * 25),
      }
      const newNodeId = insertBetween(ctx.parentId, ctx.childId, branch, mode, 'human', undefined)
      if (!newNodeId) {
        setError('Insert failed — parent/child relation was stale.')
        return
      }
      close()
      if (branch.imagePrompt) void generateNodeImage(newNodeId, branch.imagePrompt)
      if (mode === 'canon') void reharmonize({ insertedNodeId: newNodeId })
      return
    }

    // Hermes path — two-phase optimistic insert.  We splice an empty
    // generating shell into the tree IMMEDIATELY at the final landing
    // position, close the modal, and let writer-assist run in the
    // background.  When it returns we patch the real content in; if it
    // fails, we roll the shell back out.
    const shellId = insertShell(ctx.parentId, ctx.childId, mode, 'human', 'hermes-writer-assist')
    if (!shellId) {
      setError('Insert failed — parent/child relation was stale.')
      return
    }
    const intentText = intent.trim()
    const parentId = ctx.parentId
    const childId = ctx.childId
    close()

    void (async () => {
      const branch = await writerAssist({ parentId, childId, intent: intentText, mode })
      if (!branch) {
        // Shell has no real content — remove it so the tree returns to
        // its pre-insert shape.  The user sees the placeholder appear
        // and then quietly vanish.
        removeInserted(shellId)
        return
      }
      fillInsertedShell(shellId, branch)
      if (branch.imagePrompt) void generateNodeImage(shellId, branch.imagePrompt)
      if (mode === 'canon') void reharmonize({ insertedNodeId: shellId })
    })()
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
        onClick={close}
      >
        <motion.div
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="relative w-[min(560px,92vw)] border border-[var(--line)] bg-[rgba(10,13,18,0.98)]"
          style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* header — compact context strip.  Parent & child titles
              show a Detroit-style node preview card on hover (thumbnail
              + full title + summary + mood tint) so the user knows
              exactly where in the story this insert lands, even when
              the titles get truncated. */}
          <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--ink-faint)]">
                Insert a moment
              </div>
              <div className="mt-1 flex items-center gap-2 truncate font-display text-[12px] uppercase tracking-[0.18em] text-[var(--ink-dim)]">
                <NodeTitleWithPreview node={parent} />
                <span className="shrink-0 text-[var(--ink-faint)]">→</span>
                <span className="shrink-0 text-[var(--gold)]">new moment</span>
                <span className="shrink-0 text-[var(--ink-faint)]">→</span>
                <NodeTitleWithPreview node={child} />
              </div>
            </div>
            <button
              onClick={close}
              className="ml-3 shrink-0 text-[var(--ink-faint)] hover:text-[var(--ink)]"
              aria-label="Close"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>

          {/* canon / what-if — when the trigger locked the mode (arm-+
              forces 'canon', trunk-+ forces 'what-if'), render a single
              read-only label instead of the toggleable tabs so the user
              isn't offered an action that contradicts the + they chose. */}
          {ctx.mode ? (
            <div className="border-b border-[var(--line)] px-5 py-3">
              <ModeTab
                active
                locked
                icon={ctx.mode === 'canon'
                  ? <GitMerge size={12} strokeWidth={1.8} />
                  : <GitBranch size={12} strokeWidth={1.8} />}
                label={ctx.mode === 'canon' ? 'Change the story' : 'Try a what-if'}
                hint={ctx.mode === 'canon'
                  ? 'Becomes part of the story — later moments adapt.'
                  : 'A side branch — the main story stays.'}
                onClick={() => { /* locked */ }}
              />
            </div>
          ) : (
          <div className="flex border-b border-[var(--line)]">
            <ModeTab
              active={mode === 'canon'}
              icon={<GitMerge size={12} strokeWidth={1.8} />}
              label="Change the story"
              hint="Becomes part of the story — later moments adapt."
              onClick={() => setMode('canon')}
            />
            <ModeTab
              active={mode === 'what-if'}
              icon={<GitBranch size={12} strokeWidth={1.8} />}
              label="Try a what-if"
              hint="A side branch — the main story stays."
              onClick={() => setMode('what-if')}
            />
          </div>
          )}

          {/* primary input — Hermes intent by default, manual fields
              when the user flips.  Exclusive: never both at once. */}
          <div className="space-y-4 px-5 py-5">
            {!manual ? (
              <>
                <div>
                  <div className="mb-2 flex items-center gap-2 font-display text-[11px] uppercase tracking-[0.26em] text-[var(--cyan)]">
                    <Sparkles size={11} strokeWidth={1.8} />
                    <span>What happens here?</span>
                  </div>
                  <textarea
                    autoFocus
                    value={intent}
                    onChange={(e) => setIntent(e.target.value.slice(0, 240))}
                    rows={4}
                    placeholder="e.g. Katara finds a scrap of his mother's ribbon frozen in the ice — she doesn't show Sokka"
                    className="w-full resize-none border border-[var(--line)] bg-[rgba(15,19,27,0.6)] px-3.5 py-3 font-display text-[14px] leading-[1.55] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--cyan)]"
                  />
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="text-[11px] italic text-[var(--ink-faint)]">
                      A sentence is enough — Hermes will flesh out the scene.
                    </span>
                    <span className="font-mono text-[9.5px] tracking-[0.22em] text-[var(--ink-faint)]">{intent.length}/240</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setManual(true)}
                  className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.26em] text-[var(--ink-faint)] transition-colors hover:text-[var(--ink-dim)]"
                >
                  <PenLine size={11} strokeWidth={1.8} />
                  or write the moment yourself →
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setManual(false)}
                  className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.26em] text-[var(--cyan)] transition-colors hover:text-[var(--ink)]"
                >
                  <ArrowLeft size={11} strokeWidth={1.8} />
                  back to intent
                </button>

                <Field label="Title">
                  <input
                    autoFocus
                    value={title}
                    onChange={(e) => setTitle(e.target.value.slice(0, 64))}
                    placeholder="LET HER LIE HERE"
                    className="w-full bg-transparent font-display text-[14px] uppercase tracking-[0.14em] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
                  />
                </Field>
                <Field label="Body" hint={`${body.length}/500`}>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value.slice(0, 500))}
                    rows={4}
                    placeholder="Two to three sentences, concrete and sensory."
                    className="w-full resize-none bg-transparent font-display text-[13px] leading-[1.55] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
                  />
                </Field>
                <Field label="Mood">
                  <div className="flex flex-wrap gap-1.5">
                    {MOODS.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setMood(m.id)}
                        className="border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.22em] transition-colors"
                        style={{
                          borderColor: mood === m.id ? 'var(--cyan)' : 'var(--line)',
                          background: mood === m.id ? 'rgba(79,195,247,0.1)' : 'transparent',
                          color: mood === m.id ? 'var(--cyan)' : 'var(--ink-dim)',
                        }}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </Field>
              </>
            )}

            {error && (
              <div className="flex items-start gap-2 border border-[var(--red)] bg-[rgba(231,76,60,0.08)] px-3 py-2 text-[12px] text-[var(--red)]">
                <AlertTriangle size={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
                {error}
              </div>
            )}
          </div>

          {/* footer */}
          <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3">
            <div className="max-w-[62%] text-[11px] leading-[1.45] text-[var(--ink-faint)]">
              {mode === 'canon'
                ? 'This changes the story — later moments will catch up.'
                : 'Side branch — the story continues as before.'}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={close}
                className="border border-[var(--line)] px-3 py-1.5 font-display text-[10px] uppercase tracking-[0.28em] text-[var(--ink-dim)] hover:text-[var(--ink)]"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!canSubmit}
                className="flex items-center gap-2 border px-4 py-1.5 font-display text-[11px] uppercase tracking-[0.3em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  color: canSubmit ? 'var(--cyan)' : 'var(--ink-faint)',
                  borderColor: canSubmit ? 'var(--cyan)' : 'var(--line)',
                  background: canSubmit ? 'rgba(79,195,247,0.08)' : 'rgba(15,19,27,0.6)',
                  boxShadow: canSubmit ? '0 0 16px rgba(79,195,247,0.22)' : undefined,
                }}
              >
                <Wand2 size={12} strokeWidth={1.8} />
                {manual ? 'Insert' : 'Ask Hermes & insert'}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block border border-[var(--line)] bg-[rgba(15,19,27,0.6)]">
      <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">
          {label}
        </span>
        {hint && <span className="font-mono text-[9px] tracking-[0.22em] text-[var(--ink-faint)]">{hint}</span>}
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </label>
  )
}

/**
 * Title span that reveals a Detroit-style preview card on hover.
 *
 * Context: the insert-modal header shows `parent → new → child`, but
 * both parent & child titles get truncated on narrow widths so the
 * user can't tell where in the story this splice actually lands.
 * The hover card reconstitutes that context with the node's thumbnail,
 * full title, summary, and a mood-tinted border — so the user sees
 * "yes, I'm inserting between *this* moment and *that* moment."
 *
 * Opens on 140ms hover (intentional to avoid trigger-on-every-pass),
 * closes instantly on leave.  Positioned below the span using absolute
 * positioning on a wrapper.
 */
function NodeTitleWithPreview({ node }: { node: TStoryNode }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)
  const accent = MOOD_ACCENT[node.mood] ?? '#4fc3f7'
  const summary = (node.summary ?? '').trim()

  const onEnter = () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), 140)
  }
  const onLeave = () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    setOpen(false)
  }

  return (
    <span
      className="relative truncate"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <span className="truncate cursor-help" style={{ borderBottom: `1px dotted ${accent}44` }}>
        {node.title}
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="pointer-events-none absolute left-0 top-full z-[60] mt-2"
            style={{ minWidth: 280, maxWidth: 340 }}
          >
            <div
              className="relative"
              style={{
                background: 'rgba(8, 11, 16, 0.96)',
                boxShadow: `0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px ${accent}33`,
                backdropFilter: 'blur(10px)',
                clipPath: 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
              }}
            >
              <Corners color={accent} />

              {/* thumbnail — 16:9 so the composition stays cinematic */}
              <div className="relative aspect-[16/9] w-full overflow-hidden bg-black">
                {node.imageUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={node.imageUrl}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                )}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background: `linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.7) 100%)`,
                  }}
                />
              </div>

              {/* mood chip + title + summary */}
              <div className="px-3.5 py-3">
                <div
                  className="mb-1.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.3em]"
                  style={{ color: accent }}
                >
                  <span className="h-px w-5" style={{ background: `linear-gradient(90deg, transparent, ${accent})` }} aria-hidden />
                  <span>{node.mood}</span>
                </div>
                <div className="font-display text-[12.5px] font-semibold uppercase leading-[1.2] tracking-[0.1em] text-[var(--ink)]">
                  {node.title}
                </div>
                {summary && (
                  <p className="mt-2 text-[11.5px] leading-[1.55] text-[var(--ink-dim)]">
                    {summary.length > 160 ? summary.slice(0, 157) + '…' : summary}
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  )
}

function Corners({ color }: { color: string }) {
  const size = 8
  return (
    <>
      <span aria-hidden className="pointer-events-none absolute" style={{ top: -1, left: -1, width: size, height: size, borderTop: `1px solid ${color}`, borderLeft: `1px solid ${color}` }} />
      <span aria-hidden className="pointer-events-none absolute" style={{ top: -1, right: -1, width: size, height: size, borderTop: `1px solid ${color}`, borderRight: `1px solid ${color}` }} />
      <span aria-hidden className="pointer-events-none absolute" style={{ bottom: -1, left: -1, width: size, height: size, borderBottom: `1px solid ${color}`, borderLeft: `1px solid ${color}` }} />
      <span aria-hidden className="pointer-events-none absolute" style={{ bottom: -1, right: -1, width: size, height: size, borderBottom: `1px solid ${color}`, borderRight: `1px solid ${color}` }} />
    </>
  )
}

function ModeTab({ active, icon, label, hint, onClick, locked = false }: {
  active: boolean; icon: React.ReactNode; label: string; hint: string; onClick: () => void; locked?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={locked}
      className={`${locked ? 'w-full' : 'flex-1'} px-5 py-3 text-left transition-colors ${locked ? 'cursor-default' : ''}`}
      style={{
        background: active ? 'rgba(79,195,247,0.08)' : 'transparent',
        borderBottom: active && !locked ? '1px solid var(--cyan)' : '1px solid transparent',
      }}
    >
      <div
        className="flex items-center gap-2 font-display text-[11px] uppercase tracking-[0.24em]"
        style={{ color: active ? 'var(--cyan)' : 'var(--ink-dim)' }}
      >
        {icon}
        {label}
      </div>
      <div className="mt-1 text-[11px] leading-[1.45] text-[var(--ink-faint)]">
        {hint}
      </div>
    </button>
  )
}
