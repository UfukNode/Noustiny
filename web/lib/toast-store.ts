import { create } from 'zustand'

/**
 * Lightweight toast state.  Deliberately its own store (not folded
 * into the main narrative store) so toast churn never invalidates
 * selectors on the story tree.  Messages auto-dismiss on a timer
 * scheduled at push time — callers never need to remove by hand.
 */

export type ToastKind = 'success' | 'info' | 'warn' | 'error'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  detail?: string
  ttl: number
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id' | 'ttl'> & { ttl?: number }) => string
  dismiss: (id: string) => void
  clear: () => void
}

let counter = 0
function makeId(): string {
  counter += 1
  return `t${Date.now().toString(36)}-${counter}`
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = makeId()
    const ttl = t.ttl ?? 2600
    set((s) => ({ toasts: [...s.toasts, { id, ttl, kind: t.kind, title: t.title, detail: t.detail }] }))
    if (ttl > 0) {
      setTimeout(() => get().dismiss(id), ttl)
    }
    return id
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}))

/** Convenience wrapper — `toast.success('Saved', 'AVATAR-SAVE-1')`. */
export const toast = {
  success: (title: string, detail?: string) => useToasts.getState().push({ kind: 'success', title, detail }),
  info:    (title: string, detail?: string) => useToasts.getState().push({ kind: 'info',    title, detail }),
  warn:    (title: string, detail?: string) => useToasts.getState().push({ kind: 'warn',    title, detail }),
  error:   (title: string, detail?: string) => useToasts.getState().push({ kind: 'error',   title, detail, ttl: 4200 }),
}
