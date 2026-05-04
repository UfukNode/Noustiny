'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { Bookmark, Save as SaveIcon, X, AlertTriangle } from 'lucide-react'
import { useStory } from '@/lib/store'
import { findSaveByName, saveStory, suggestDefaultSaveName } from '@/lib/save-system'
import { toast } from '@/lib/toast-store'

/**
 * Save the current canvas as a named story.
 *
 * Detroit-style parallelogram modal.  Detects name collision against
 * existing saves and either overwrites (with a confirmation) or
 * creates a new save.  Reads the live Zustand snapshot via the
 * ``snapshotCurrent`` action so in-progress renders are captured too.
 */
export function SaveStoryModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved?: (id: string) => void
}) {
  const seed = useStory((s) => s.seed)
  const imagePolicy = useStory((s) => s.imagePolicy)
  const snapshotCurrent = useStory((s) => s.snapshotCurrent)
  const [name, setName] = useState('')
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'collision'; existingId: string }
    | { kind: 'error'; message: string }
    | { kind: 'done' }
  >({ kind: 'idle' })

  useEffect(() => {
    if (!open) return
    // Seed the name field with a franchise-aware, auto-incrementing
    // default: AVATAR-SAVE-1, AVATAR-SAVE-2, etc.  User can overwrite
    // freely; this just saves them from typing the obvious.
    setName(suggestDefaultSaveName({ franchise: imagePolicy?.franchise ?? null, seed }))
    setStatus({ kind: 'idle' })
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, seed, imagePolicy, onClose])

  const commitSave = (overwriteId?: string) => {
    const trimmed = name.trim()
    if (!trimmed) {
      setStatus({ kind: 'error', message: 'Name cannot be empty' })
      return
    }
    try {
      const snap = snapshotCurrent()
      const meta = saveStory({ name: trimmed, snapshot: snap, id: overwriteId })
      setStatus({ kind: 'done' })
      onSaved?.(meta.id)
      toast.success(overwriteId ? 'Story overwritten' : 'Story saved', meta.name)
      // Brief confirmation then close.
      setTimeout(onClose, 420)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'save failed'
      setStatus({ kind: 'error', message })
      toast.error('Save failed', message)
    }
  }

  const onSubmit = () => {
    const trimmed = name.trim()
    if (!trimmed) { setStatus({ kind: 'error', message: 'Name cannot be empty' }); return }
    const existing = findSaveByName(trimmed)
    if (existing) {
      setStatus({ kind: 'collision', existingId: existing.id })
      return
    }
    commitSave()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="save-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-[rgba(5,7,11,0.78)] backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            key="save-panel"
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="relative w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="relative"
              style={{
                clipPath: 'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)',
                background: 'linear-gradient(140deg, rgba(79,195,247,0.35), rgba(79,195,247,0.08) 45%, rgba(233,193,107,0.2))',
                padding: 1,
              }}
            >
              <div
                className="relative overflow-hidden bg-[rgba(10,13,18,0.96)]"
                style={{ clipPath: 'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)' }}
              >
                <div className="pointer-events-none absolute inset-0 scan-line opacity-25" />

                <div className="flex items-center justify-between border-b border-[rgba(79,195,247,0.18)] px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <Bookmark size={14} strokeWidth={2} className="text-[var(--cyan)]" />
                    <span className="font-display text-[11px] uppercase tracking-[0.38em] text-[var(--cyan)]">
                      Save · Story
                    </span>
                  </div>
                  <button type="button" onClick={onClose} className="flex h-6 w-6 items-center justify-center text-[var(--ink-dim)] transition-colors hover:text-[var(--ink)]" aria-label="Close">
                    <X size={13} strokeWidth={2} />
                  </button>
                </div>

                <div className="px-6 pb-6 pt-5">
                  <div className="font-display text-[17px] font-semibold uppercase tracking-[0.14em] text-[var(--ink)]">
                    Name this story
                  </div>
                  <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--ink-dim)]">
                    Saved to your browser.  Tree, characters, portraits and decisions are kept — agents will not re-run when you resume.
                  </p>

                  <div className="mt-4">
                    <div className="flex items-center justify-between px-1 pb-1 font-mono text-[9.5px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">
                      <span>name</span>
                      <span>{name.length}/80</span>
                    </div>
                    <input
                      type="text"
                      autoFocus
                      value={name}
                      maxLength={80}
                      onChange={(e) => { setName(e.target.value); if (status.kind !== 'idle') setStatus({ kind: 'idle' }) }}
                      onKeyDown={(e) => { if (e.key === 'Enter') onSubmit() }}
                      placeholder="Aang's iceberg"
                      className="w-full border border-[var(--line)] bg-[rgba(15,19,27,0.7)] px-3 py-2.5 font-display text-[14px] text-[var(--ink)] outline-none focus:border-[var(--cyan)]"
                    />
                  </div>

                  {status.kind === 'collision' && (
                    <div className="mt-4 flex items-start gap-2 border border-[var(--gold)] bg-[rgba(233,193,107,0.06)] px-3 py-2.5 text-[12px] text-[var(--gold)]">
                      <AlertTriangle size={13} strokeWidth={2} className="mt-[2px] shrink-0" />
                      <span>A save with this name already exists.  Overwrite it, or pick a different name.</span>
                    </div>
                  )}
                  {status.kind === 'error' && (
                    <div className="mt-4 border border-[var(--red)] bg-[rgba(231,76,60,0.08)] px-3 py-2 text-[12px] text-[var(--red)]">{status.message}</div>
                  )}
                  {status.kind === 'done' && (
                    <div className="mt-4 border border-[var(--cyan)] bg-[rgba(79,195,247,0.08)] px-3 py-2 text-[12px] text-[var(--cyan)]">Saved.</div>
                  )}

                  <div className="mt-6 flex items-center justify-end gap-3">
                    <button type="button" onClick={onClose} className="border border-[var(--line)] bg-transparent px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--ink-dim)] transition-colors hover:border-[var(--ink-dim)] hover:text-[var(--ink)]">
                      Cancel
                    </button>
                    {status.kind === 'collision' ? (
                      <button type="button" onClick={() => commitSave(status.existingId)} className="flex items-center gap-2 border border-[var(--gold)] bg-[rgba(233,193,107,0.08)] px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--gold)] transition-all hover:bg-[rgba(233,193,107,0.15)]">
                        <SaveIcon size={12} strokeWidth={2} /> Overwrite
                      </button>
                    ) : (
                      <button type="button" onClick={onSubmit} className="flex items-center gap-2 border border-[var(--cyan)] bg-[rgba(79,195,247,0.08)] px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--cyan)] transition-all hover:bg-[rgba(79,195,247,0.15)] hover:shadow-[0_0_14px_rgba(79,195,247,0.35)]">
                        <SaveIcon size={12} strokeWidth={2} /> Save
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
