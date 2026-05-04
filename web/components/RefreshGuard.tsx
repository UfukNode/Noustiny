'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, ChevronLeft, Home, RotateCcw, Save as SaveIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useStory } from '@/lib/store'
import { SaveStoryModal } from './SaveStoryModal'

const AUTO_SNAPSHOT_KEY = 'noustiny:auto-snapshot'

/**
 * RefreshGuard — two-pronged "don't lose the tree on reload" system.
 *
 *  1. BEST-EFFORT CUSTOM MODAL
 *     Keyboard (F5 / Ctrl-R / Ctrl-Shift-R / Cmd-R) and browser back
 *     are caught and routed through the custom Detroit-style confirm.
 *     preventDefault on F5 isn't 100% reliable across browsers and
 *     extensions, so this is best-effort.
 *
 *  2. TRANSPARENT AUTO-RESUME
 *     On every page unload (pagehide / beforeunload) the live tree is
 *     snapshotted into localStorage and a sessionStorage flag is set.
 *     On the next mount, app/page.tsx reads the flag and restores the
 *     snapshot straight into canvas mode.  The user lands back on the
 *     same beat with no manual save required.
 *
 *     Deliberately NO beforeunload preventDefault — we do NOT trigger
 *     Chrome's "Leave site?" native dialog.  The auto-resume makes
 *     reload safe by design, so a confirm prompt would be noise.
 *
 * Explicit Home click clears the auto-snapshot so reset is honoured.
 */
export function RefreshGuard() {
  const mode = useStory((s) => s.mode)
  const resetToLanding = useStory((s) => s.resetToLanding)
  const [open, setOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  useEffect(() => {
    if (mode !== 'canvas') return

    // --- 1. keyboard refresh combos (best effort) --------------------
    // Attached on window AND document, at capture AND bubble.  Chrome
    // allows preventDefault on F5 in most contexts but not universally;
    // if preventDefault fails we fall through to the silent auto-
    // snapshot path below and the user ends up right back where they
    // were after the reload.
    const onKey = (e: KeyboardEvent) => {
      const refreshCombo =
        e.key === 'F5' ||
        e.code === 'F5' ||
        e.keyCode === 116 ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R' || e.code === 'KeyR'))
      if (!refreshCombo) return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
      setOpen(true)
    }

    // --- 2. back button ----------------------------------------------
    try { history.pushState({ __noustinyGuard: true }, '', location.href) } catch { /* noop */ }
    const onPopState = () => {
      try { history.pushState({ __noustinyGuard: true }, '', location.href) } catch { /* noop */ }
      setOpen(true)
    }

    // --- 3. transparent auto-snapshot on page hide -------------------
    // pagehide fires on EVERY navigation-away (reload, tab close,
    // navigation) and is more reliable than beforeunload.  Write the
    // live tree so the next mount can restore it without asking.
    //
    // Deliberately NOT calling e.preventDefault on beforeunload — that
    // would trigger Chrome's native "Reload site? Changes you made may
    // not be saved." dialog, which the user doesn't want.  The auto-
    // snapshot already makes the reload transparent; we don't need a
    // confirm prompt blocking the page.
    const persistSnapshot = () => {
      try {
        const snap = useStory.getState().snapshotCurrent()
        localStorage.setItem(AUTO_SNAPSHOT_KEY, JSON.stringify(snap))
        sessionStorage.setItem('noustiny:resume-on-reload', '1')
      } catch { /* noop */ }
    }

    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keydown', onKey, false)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('popstate', onPopState)
    window.addEventListener('pagehide', persistSnapshot)
    window.addEventListener('beforeunload', persistSnapshot)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keydown', onKey, false)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('pagehide', persistSnapshot)
      window.removeEventListener('beforeunload', persistSnapshot)
    }
  }, [mode])

  // Close the modal on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const close = () => setOpen(false)

  const onSaveClick = () => {
    setOpen(false)
    setSaveOpen(true)
  }

  const onHomeClick = () => {
    setOpen(false)
    // Explicit "go to landing" — clear any auto-snapshot so the next
    // reload on the landing page doesn't transparently drop the user
    // back into the tree they just abandoned.
    try {
      localStorage.removeItem(AUTO_SNAPSHOT_KEY)
      sessionStorage.removeItem('noustiny:resume-on-reload')
    } catch { /* noop */ }
    resetToLanding()
  }

  const onReloadAnyway = () => {
    setOpen(false)
    // Auto-snapshot + flag (same as pagehide does — redundant but safe
    // in case pagehide doesn't fire for some reason on this browser).
    try {
      const snap = useStory.getState().snapshotCurrent()
      localStorage.setItem(AUTO_SNAPSHOT_KEY, JSON.stringify(snap))
      sessionStorage.setItem('noustiny:resume-on-reload', '1')
    } catch { /* noop */ }
    setTimeout(() => window.location.reload(), 60)
  }

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            key="refresh-guard-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(5,7,11,0.78)] backdrop-blur-sm"
            onClick={close}
          >
            <motion.div
              key="refresh-guard-panel"
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
                  clipPath:
                    'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)',
                  background:
                    'linear-gradient(140deg, rgba(79,195,247,0.35), rgba(79,195,247,0.08) 45%, rgba(233,193,107,0.2))',
                  padding: 1,
                }}
              >
                <div
                  className="relative overflow-hidden bg-[var(--surface-hi)]"
                  style={{
                    clipPath:
                      'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)',
                  }}
                >
                  <div className="pointer-events-none absolute inset-0 scan-line opacity-30" />

                  <div className="flex items-center justify-between border-b border-[rgba(79,195,247,0.18)] px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <AlertTriangle size={14} strokeWidth={2} className="text-[var(--gold)]" />
                      <span className="font-display text-[11px] uppercase tracking-[0.38em] text-[var(--cyan)]">
                        Reload · Confirm
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

                  <div className="px-6 pb-6 pt-5">
                    <div className="font-display text-[17px] font-semibold uppercase tracking-[0.14em] text-[var(--ink)]">
                      Reload this page?
                    </div>
                    <p className="mt-3 text-[13px] leading-relaxed text-[var(--ink-dim)]">
                      Your branch tree is kept safe — we auto-save it and restore
                      you on the same beat after the reload.
                    </p>
                    <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
                      Stay here, or explicitly go Home to reset.
                    </p>

                    <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={close}
                        className="flex items-center gap-2 border border-[var(--cyan)] bg-[var(--surface-accent)] px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--cyan)] transition-all hover:bg-[var(--surface-accent-hover)] hover:shadow-[0_0_14px_rgba(79,195,247,0.35)]"
                      >
                        <ChevronLeft size={12} strokeWidth={2} /> Stay here
                      </button>
                      <button
                        type="button"
                        onClick={onSaveClick}
                        className="flex items-center gap-2 border border-[var(--cyan)] bg-[var(--surface-accent-soft)] px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--cyan)] transition-all hover:bg-[var(--surface-accent-hover)]"
                      >
                        <SaveIcon size={12} strokeWidth={2} /> Save story
                      </button>
                      <button
                        type="button"
                        onClick={onReloadAnyway}
                        className="border border-[var(--line)] bg-transparent px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--ink-dim)] transition-colors hover:border-[var(--ink)] hover:text-[var(--ink)]"
                      >
                        <span className="flex items-center gap-2">
                          <RotateCcw size={12} strokeWidth={2} /> Reload
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={onHomeClick}
                        className="flex items-center gap-2 border border-[var(--gold)] bg-[rgba(233,193,107,0.08)] px-4 py-1.5 font-display text-[10.5px] uppercase tracking-[0.3em] text-[var(--gold)] transition-all hover:bg-[rgba(233,193,107,0.15)] hover:shadow-[0_0_14px_rgba(233,193,107,0.35)]"
                      >
                        <Home size={12} strokeWidth={2} /> Home
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <SaveStoryModal open={saveOpen} onClose={() => setSaveOpen(false)} />
    </>
  )
}
