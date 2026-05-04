'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { FolderOpen, Trash2, X, Clock, History } from 'lucide-react'
import { useStory } from '@/lib/store'
import {
  deleteSave, hydrateSavesFromDisk, listSaves, loadSave,
  type SavedStoryMeta,
} from '@/lib/save-system'
import { toast } from '@/lib/toast-store'

/**
 * Grid of saved-story cards.  Mounts in two places:
 *  - Landing page, inline section (seed picker alternative)
 *  - Canvas MoreMenu → "Open saved" modal
 *
 * Clicking a card hydrates the store from the snapshot and switches to
 * canvas mode.  Deliberately does NOT re-fire the detector or
 * character-sheet flow — the saved story already has those outputs.
 */

function formatDate(ts: number): string {
  try {
    const d = new Date(ts)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    const hh = d.getHours().toString().padStart(2, '0')
    const mm = d.getMinutes().toString().padStart(2, '0')
    if (sameDay) return `today · ${hh}:${mm}`
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${hh}:${mm}`
  } catch { return '' }
}

export function SavedStoriesGrid({ onOpen }: { onOpen?: (id: string) => void }) {
  const [saves, setSaves] = useState<SavedStoryMeta[]>([])
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const loadFromSnapshot = useStory((s) => s.loadFromSnapshot)

  const refresh = () => setSaves(listSaves())
  useEffect(() => {
    // Show whatever localStorage already has immediately, then re-read
    // after hydrating from the filesystem mirror so the list still
    // populates when this is a fresh-port browser session whose
    // localStorage is empty but disk has prior saves.
    refresh()
    let cancelled = false
    void hydrateSavesFromDisk().then((added) => {
      if (cancelled) return
      if (added > 0) refresh()
    })
    return () => { cancelled = true }
  }, [])

  const onClickLoad = (id: string) => {
    const full = loadSave(id)
    if (!full) {
      toast.error('Load failed', 'Save data missing or incompatible')
      return
    }
    loadFromSnapshot(full.snapshot)
    toast.success('Story loaded', full.name)
    onOpen?.(id)
  }

  if (saves.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <History size={22} strokeWidth={1.3} className="text-[var(--ink-faint)]" />
        <div className="font-display text-[11px] uppercase tracking-[0.3em] text-[var(--ink-faint)]">
          No saved stories yet
        </div>
        <div className="text-[12px] text-[var(--ink-dim)]">
          Save a story from the canvas menu and it will appear here.
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {saves.map((meta) => (
        <div
          key={meta.id}
          className="group relative border bg-[var(--surface-panel)] p-3 transition-colors hover:border-[var(--cyan)]"
          style={{ borderColor: 'var(--line)' }}
        >
          <button
            type="button"
            onClick={() => onClickLoad(meta.id)}
            className="flex w-full items-stretch gap-3 text-left"
          >
            <div
              className="relative h-16 w-24 shrink-0 overflow-hidden bg-[#05070b]"
              style={{ clipPath: 'polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%)' }}
            >
              {meta.thumbnail ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={meta.thumbnail}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="h-full w-full bg-gradient-to-br from-[#0f131b] to-[#151a24]" />
              )}
              <div className="pointer-events-none absolute inset-0 scan-line opacity-20" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-2">
                <FolderOpen size={12} strokeWidth={1.7} className="shrink-0 text-[var(--cyan)]" />
                <div className="truncate font-display text-[13px] uppercase tracking-[0.14em] text-[var(--ink)]">
                  {meta.name}
                </div>
              </div>
              <div className="mt-1 line-clamp-2 text-[11.5px] leading-[1.4] text-[var(--ink-dim)]">
                {meta.seedPreview}
              </div>
              <div className="mt-auto flex items-center gap-3 pt-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
                <span className="flex items-center gap-1.5"><Clock size={10} strokeWidth={1.7} /> {formatDate(meta.updatedAt)}</span>
                <span>{meta.nodeCount} node{meta.nodeCount === 1 ? '' : 's'}</span>
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(meta.id) }}
            title="Delete save"
            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center border opacity-0 transition-opacity group-hover:opacity-100"
            style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'var(--surface-hi)' }}
          >
            <Trash2 size={11} strokeWidth={1.8} />
          </button>
          {confirmDelete === meta.id && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 border bg-[var(--surface-hi)] p-3"
              style={{ borderColor: 'var(--red)' }}
            >
              <div className="text-center font-display text-[11px] uppercase tracking-[0.28em] text-[var(--red)]">
                Delete “{meta.name}”?
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  className="border border-[var(--line)] px-3 py-1 font-display text-[10px] uppercase tracking-[0.26em] text-[var(--ink-dim)] hover:border-[var(--ink-dim)] hover:text-[var(--ink)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    deleteSave(meta.id)
                    setConfirmDelete(null)
                    refresh()
                    toast.info('Save deleted', meta.name)
                  }}
                  className="flex items-center gap-1 border border-[var(--red)] bg-[rgba(231,76,60,0.1)] px-3 py-1 font-display text-[10px] uppercase tracking-[0.26em] text-[var(--red)] hover:bg-[rgba(231,76,60,0.2)]"
                >
                  <Trash2 size={10} strokeWidth={1.9} /> Delete
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Full-screen modal wrapper used from canvas MoreMenu. */
export function OpenSavedModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="open-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-[rgba(5,7,11,0.78)] backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            key="open-panel"
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="relative w-full max-w-2xl"
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
                <div className="pointer-events-none absolute inset-0 scan-line opacity-20" />
                <div className="flex items-center justify-between border-b border-[rgba(79,195,247,0.18)] px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <FolderOpen size={14} strokeWidth={2} className="text-[var(--cyan)]" />
                    <span className="font-display text-[11px] uppercase tracking-[0.38em] text-[var(--cyan)]">
                      Saved · Stories
                    </span>
                  </div>
                  <button type="button" onClick={onClose} className="flex h-6 w-6 items-center justify-center text-[var(--ink-dim)] transition-colors hover:text-[var(--ink)]" aria-label="Close">
                    <X size={13} strokeWidth={2} />
                  </button>
                </div>
                <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
                  <SavedStoriesGrid onOpen={() => onClose()} />
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
