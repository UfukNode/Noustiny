'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { Check, Info, AlertTriangle, XCircle, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useToasts, type ToastKind } from '@/lib/toast-store'

/**
 * Bottom-centre toast rail — Detroit-style parallelogram card with
 * bracket corners + accent tint per kind.  Sits ABOVE the dock
 * buttons with enough clearance that the icons don't overlap.
 *
 * The toast store auto-dismisses; this component only renders what
 * the store currently holds, plus a manual close affordance.
 */

const KIND: Record<ToastKind, { accent: string; ink: string; Icon: React.FC<{ size?: number; strokeWidth?: number }> }> = {
  success: { accent: '#4fc3f7', ink: '#4fc3f7', Icon: Check },
  info:    { accent: '#8a96aa', ink: '#cfd6e2', Icon: Info },
  warn:    { accent: '#e9c16b', ink: '#e9c16b', Icon: AlertTriangle },
  error:   { accent: '#e74c3c', ink: '#e74c3c', Icon: XCircle },
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)

  return (
    <div
      // Sits above BottomBar (which lives at bottom:0 with pb-5 +
      // ~36px button height).  92px keeps the toast clear of any
      // utility icons on either side.
      className="pointer-events-none fixed inset-x-0 bottom-[92px] z-[60] flex flex-col items-center gap-2 px-6"
    >
      <AnimatePresence>
        {toasts.map((t) => {
          const cfg = KIND[t.kind]
          return (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ duration: 0.2, ease: [0.2, 0.9, 0.2, 1] }}
              className="pointer-events-auto relative"
              style={{
                background: 'rgba(10,13,18,0.96)',
                boxShadow: `0 20px 60px rgba(0,0,0,0.55), 0 0 0 1px ${cfg.accent}2e`,
                backdropFilter: 'blur(10px)',
                clipPath: 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
              }}
            >
              <div
                className="flex items-center gap-3 px-5 py-2.5"
                style={{ minWidth: 260, maxWidth: 460 }}
              >
                <Corners color={cfg.accent} />
                <span
                  aria-hidden
                  className="flex h-5 w-5 items-center justify-center"
                  style={{ color: cfg.ink }}
                >
                  <cfg.Icon size={14} strokeWidth={2} />
                </span>
                <div className="flex-1 truncate font-display text-[11.5px] uppercase tracking-[0.24em]" style={{ color: cfg.ink }}>
                  {t.title}
                  {t.detail && (
                    <span className="ml-2 font-mono text-[10px] tracking-[0.16em]" style={{ color: 'rgba(230,236,244,0.75)' }}>
                      · {t.detail}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                  className="flex h-5 w-5 items-center justify-center text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)]"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}

function Corners({ color }: { color: string }): ReactNode {
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
