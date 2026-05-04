'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Home, RefreshCw, X } from 'lucide-react'
import { useEffect } from 'react'
import { useStory } from '@/lib/store'

/**
 * Detroit-faithful confirmation modal for destructive tree reset.
 * Two exits: "Reset tree" rebuilds the current seed's tree in place;
 * "New story" drops the user back on the landing page so they can pick
 * a fresh preset (Avatar / Endgame / custom).
 */
export function ConfirmResetModal() {
  const open = useStory((s) => s.confirmResetOpen)
  const close = useStory((s) => s.closeConfirmReset)
  const newSession = useStory((s) => s.newSession)
  const resetToLanding = useStory((s) => s.resetToLanding)
  const seed = useStory((s) => s.seed)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const onResetTree = () => {
    newSession(seed)
    close()
  }

  const onNewStory = () => {
    resetToLanding()
    close()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="confirm-reset-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(5,7,11,0.78)] backdrop-blur-sm"
          onClick={close}
        >
          <motion.div
            key="confirm-reset-panel"
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="relative w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            {/* angular cyan frame with clip */}
            <div
              className="relative"
              style={{
                clipPath:
                  'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)',
                background:
                  'linear-gradient(140deg, rgba(79,195,247,0.35), rgba(79,195,247,0.08) 45%, rgba(233,193,107,0.2))',
                padding: 1,
              }}
            >
              <div
                className="relative overflow-hidden bg-[rgba(10,13,18,0.96)]"
                style={{
                  clipPath:
                    'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)',
                }}
              >
                {/* scanline shimmer */}
                <div className="pointer-events-none absolute inset-0 scan-line opacity-30" />

                {/* header */}
                <div className="flex items-center justify-between border-b border-[rgba(79,195,247,0.18)] px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <AlertTriangle size={14} strokeWidth={2} className="text-[var(--gold)]" />
                    <span className="font-display text-[11px] uppercase tracking-[0.38em] text-[var(--cyan)]">
                      Reset · Confirm
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={close}
                    className="flex h-6 w-6 items-center justify-center text-[var(--ink-dim)] transition-colors hover:text-[var(--ink)]"
                    aria-label="Close"
                  >
                    <X size={13} strokeWidth={2} />
                  </button>
                </div>

                {/* body */}
                <div className="px-6 pb-6 pt-5">
                  <div className="font-display text-[17px] font-semibold uppercase tracking-[0.14em] text-[var(--ink)]">
                    Reset this story?
                  </div>
                  <p className="mt-3 text-[13px] leading-relaxed text-[var(--ink-dim)]">
                    <span className="text-[var(--cyan)]">Reset tree</span> rebuilds the branches from the current seed — canvas stays open.
                    <br />
                    <span className="text-[var(--gold)]">New story</span> takes you back to the seed picker so you can start from a different preset.
                  </p>
                  <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
                    Both actions clear the current branch tree. This cannot be undone.
                  </p>

                  {/* actions */}
                  <div className="mt-6 flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={close}
                      className="border border-[var(--line)] bg-transparent px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--ink-dim)] transition-colors hover:border-[var(--ink-dim)] hover:text-[var(--ink)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={onResetTree}
                      className="flex items-center gap-2 border border-[var(--cyan)] bg-[rgba(79,195,247,0.08)] px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--cyan)] transition-all hover:bg-[rgba(79,195,247,0.15)] hover:shadow-[0_0_14px_rgba(79,195,247,0.35)]"
                    >
                      <RefreshCw size={12} strokeWidth={2} /> Reset tree
                    </button>
                    <button
                      type="button"
                      onClick={onNewStory}
                      className="flex items-center gap-2 border border-[var(--gold)] bg-[rgba(233,193,107,0.08)] px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--gold)] transition-all hover:bg-[rgba(233,193,107,0.15)] hover:shadow-[0_0_14px_rgba(233,193,107,0.35)]"
                    >
                      <Home size={12} strokeWidth={2} /> New story
                    </button>
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
