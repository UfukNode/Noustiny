'use client'

import { useCallback, useEffect, useState } from 'react'
import { useStory, selectCurrentNode } from '@/lib/store'
import { Canvas, ReactFlowProvider } from '@/components/Canvas'
import { TopBar } from '@/components/TopBar'
import { BottomBar } from '@/components/BottomBar'
import { AgentTicker } from '@/components/AgentTicker'
import { MoodBleed } from '@/components/MoodBleed'
import { DbhBackdrop } from '@/components/DbhBackdrop'
import { Legend } from '@/components/Legend'
import { MediaLibrary } from '@/components/MediaLibrary'
import { ScenesList } from '@/components/ScenesList'
import { ImageLightbox } from '@/components/ImageLightbox'
import { StorybookModal } from '@/components/StorybookModal'
import { RenderJobs } from '@/components/RenderJobs'
import { InsertModal } from '@/components/InsertModal'
import { DecisionLog } from '@/components/DecisionLog'
import { ConfirmResetModal } from '@/components/ConfirmResetModal'
import { RefreshGuard } from '@/components/RefreshGuard'
import { Toaster } from '@/components/Toaster'
import { SeedInput } from '@/components/SeedInput'
import { composeScenes, expandNode, generateNodeImage, writeFinalStory } from '@/lib/hermes-client'
import { hydrateSavesFromDisk, listSaves, loadSave } from '@/lib/save-system'

export default function Home() {
  // Avoid SSR/CSR mismatch: wait for localStorage rehydration before painting.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Hydrate filesystem-mirrored saves into localStorage on first mount.
  // localStorage is keyed by origin (scheme+host+port), so a port flip
  // (3000 → 3100) makes the saved-stories list look empty even though the
  // saves still exist on disk under web/.saves/.  This effect pulls any
  // missing entries back in so the UI is port-/browser-independent.  Runs
  // once per mount; never blocks the resume flow below.
  const [savesHydrated, setSavesHydrated] = useState(false)
  useEffect(() => {
    if (!mounted) return
    let cancelled = false
    void hydrateSavesFromDisk().finally(() => {
      if (!cancelled) setSavesHydrated(true)
    })
    return () => { cancelled = true }
  }, [mounted])

  // Resume-on-reload — RefreshGuard's "Leave anyway" sets a
  // sessionStorage flag AND persists an auto-snapshot of the live
  // tree.  On the next mount we consume the flag and restore the
  // snapshot straight into canvas, so the user doesn't lose their
  // session by clicking reload.  Falls back to the most recent named
  // save if the auto-snapshot is absent (old builds).  Flag + snap
  // are consumed on read so a subsequent manual refresh behaves
  // normally.  Gated on savesHydrated so the fallback's listSaves()
  // sees the fs-mirrored entries when localStorage was empty (e.g. a
  // fresh port hosts the dev server for the first time).
  useEffect(() => {
    if (!mounted || !savesHydrated) return
    let flag: string | null = null
    try { flag = sessionStorage.getItem('noustiny:resume-on-reload') } catch { /* noop */ }
    if (flag !== '1') return
    try { sessionStorage.removeItem('noustiny:resume-on-reload') } catch { /* noop */ }

    // Primary: auto-snapshot written by RefreshGuard on "Leave anyway"
    try {
      const raw = localStorage.getItem('noustiny:auto-snapshot')
      if (raw) {
        localStorage.removeItem('noustiny:auto-snapshot')
        const snapshot = JSON.parse(raw)
        useStory.getState().loadFromSnapshot(snapshot)
        return
      }
    } catch { /* noop, fall through to named saves */ }

    // Fallback: most recent user-saved story
    const latest = listSaves()[0]
    if (!latest) return
    const full = loadSave(latest.id)
    if (!full) return
    useStory.getState().loadFromSnapshot(full.snapshot)
  }, [mounted, savesHydrated])

  const mode = useStory((s) => s.mode)
  const current = useStory(selectCurrentNode)
  const background = useStory((s) => s.background)
  const rootId = useStory((s) => s.rootId)
  const autoAsk = useStory((s) => s.autoAsk)

  useEffect(() => {
    document.body.dataset.bg = background
    // Theme family — derived from the background preset.  Only
    // `detroit-light` is a true light canvas; every other preset is a
    // variation on dark.  `data-theme` lets CSS target the palette
    // family without enumerating every bg, so future bg presets just
    // need to declare their family here.
    const lightFamily = new Set<string>(['detroit-light'])
    document.body.dataset.theme = lightFamily.has(background) ? 'light' : 'dark'
  }, [background])

  // Auto-grow: fires EXACTLY when enterCanvas / newSession armed the
  // transient ``pendingAutoExpand`` flag.  The flag is NOT persisted, so
  // page refresh / HMR reload never re-triggers a brainstorm + image
  // pipeline — only an explicit "Enter" or "New story" click does.  This
  // prevents silent API spend on reloads.
  const pendingAutoExpand = useStory((s) => s.pendingAutoExpand)
  useEffect(() => {
    if (mode !== 'canvas') return
    if (!pendingAutoExpand) return
    const consumed = useStory.getState().consumePendingAutoExpand()
    if (!consumed) return
    const root = useStory.getState().nodes.get(rootId)
    if (!root) return
    if (root.childrenIds.length > 0) return
    if (root.status === 'generating') return
    void expandNode(root.id)
    if (root.imagePrompt) void generateNodeImage(root.id, root.imagePrompt)
  }, [mode, rootId, pendingAutoExpand])

  // Auto-ask Hermes: whenever the user walks to a beat that has no
  // children and no question yet, fire brainstorm so the Decision
  // overlay always has answers waiting.  Respects the ``autoAsk``
  // toggle (off → user hits the "Ask Hermes" button themselves).
  // Guards: must be the active canvas mode, node must be a leaf, can't
  // already be generating, and we pass through expandNode's own
  // ``inflightExpand`` Set so rapid navigation doesn't stampede.
  useEffect(() => {
    if (mode !== 'canvas') return
    if (!autoAsk) return
    if (!current) return
    if (current.status === 'generating') return
    if (current.childrenIds.length > 0) return
    if (current.imagePrompt) {
      // current is fresh-current + no image yet — trigger image pipeline too.
      void generateNodeImage(current.id, current.imagePrompt)
    }
    void expandNode(current.id)
  }, [mode, current, autoAsk])

  const onExpand = useCallback(() => {
    if (!current) return
    if (current.status === 'generating') return
    // If children already exist, user wants MORE options ("ask again").
    // Force-add appends siblings; existing children (and anything the
    // user already walked into) are preserved.
    const force = current.childrenIds.length > 0
    void expandNode(current.id, 3, { force })
  }, [current])

  const onComplete = useCallback(() => {
    if (!current) return
    void writeFinalStory()
  }, [current])

  const onComposeScenes = useCallback(() => {
    void composeScenes()
  }, [])

  if (!mounted) return <BootSplash />

  if (mode === 'landing') {
    return (
      <>
        <DbhBackdrop />
        <SeedInput />
        <Toaster />
      </>
    )
  }

  return (
    <ReactFlowProvider>
      <main className="fixed inset-0">
        <DbhBackdrop />
        <MoodBleed />
        <Canvas />
        <TopBar />
        <AgentTicker />
        <BottomBar onExpand={onExpand} onComplete={onComplete} onComposeScenes={onComposeScenes} />
        <Legend />
        <MediaLibrary />
        <ScenesList />
        <ImageLightbox />
        <StorybookModal />
        <RenderJobs />
        <InsertModal />
        <DecisionLog />
        <ConfirmResetModal />
        <RefreshGuard />
        <Toaster />
      </main>
    </ReactFlowProvider>
  )
}

function BootSplash() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[var(--bg-0)]">
      <div className="flex items-center gap-3 font-display text-[12px] uppercase tracking-[0.42em] text-[var(--ink-faint)]">
        <span className="h-px w-10 bg-gradient-to-r from-transparent via-[var(--cyan)] to-transparent" />
        Noustiny · awakening
        <span className="h-px w-10 bg-gradient-to-l from-transparent via-[var(--cyan)] to-transparent" />
      </div>
    </div>
  )
}
