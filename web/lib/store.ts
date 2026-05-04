'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  AgentEvent, BackgroundPreset, BranchSuggestion, Decider, Decision,
  NodeMood, NodeStatus, Scene, StoryNode,
} from './types'
import { canonPath, layoutTree } from './layout'
import { buildRootTree, DEMO_SEED } from './demo-seed'
import { imageUrl, seedFromString } from './image'
import { detectStoryCopyright, type ImagePolicy } from './story-copyright-detector'
import type { StorySnapshot } from './save-system'
import { snapshotFromState } from './save-system'
import { requestControl } from './request-control'

type ViewMode = 'landing' | 'canvas'

interface InsertEdgeContext {
  parentId: string
  childId: string
  /** Lock the modal to a single mode.  The arm-+ (between parent and a
   *  specific child) opens in 'canon' so the user can't accidentally
   *  create a sibling.  The trunk-+ (on the parent's outgoing stub,
   *  before branching) opens in 'what-if' — the child reference is a
   *  placeholder anchor only, the new node will become a sibling of it. */
  mode?: 'canon' | 'what-if'
}

/**
 * One render job tracked by the bottom-right widget.  Created on modal
 * submit, lives until the user dismisses it (X) or the page reloads.
 *
 * `body` is the verbatim POST body for /api/storybook including the
 * client-generated `jobId` — the widget owns the fetch lifecycle and
 * re-issues nothing, just streams progress in.  Stage / labels / images
 * are populated from /api/storybook/progress polls.
 */
export interface RenderJob {
  id: string
  endpointId: string
  endpointTitle: string
  body: Record<string, unknown>
  status: 'pending' | 'running' | 'done' | 'error'
  stage?: string
  stageLabel?: string
  beatTitle?: string
  beatImage?: string | null
  beatsTotal?: number
  beatsDone?: number
  /** Reel pre-stage progress — vertical image regen fan-out.  Set
   *  while ``stage === 'vertical_images'``; pipeline bar lerps between
   *  this stage and Translate using the ratio. */
  vimgDone?: number
  vimgTotal?: number
  url?: string
  error?: string
  startedAt: number
  /** Stamped when status first flips to 'done' (or 'error' on failure).
   *  Drives the relative-age label on the queue card so two finished
   *  renders are distinguishable at a glance. */
  completedAt?: number
}

interface StoreState {
  mode: ViewMode
  seed: string
  rootId: string
  nodes: Map<string, StoryNode>
  currentId: string
  selectedId: string | null
  /** Target node id for an "edge preview" highlight — set when the
   *  user hovers a decision option so the canvas can light up the
   *  edge + destination node to signal "this will lead here".
   *  Separate from `selectedId` so it doesn't fight with node hover. */
  edgeHighlightTargetId: string | null
  lightboxNodeId: string | null
  /** Endpoint node for the Storybook modal — when set, the modal renders
   *  a video from the linear path root → this node.  null means modal closed. */
  storybookEndpointId: string | null
  /** When set, the Storybook modal opens straight into the player view
   *  (video already rendered).  Used by the bottom-right RenderJobs
   *  widget to replay a finished job without re-running the form. */
  storyPlayerUrl: string | null
  /** Aspect ratio for the replayed video — Reel renders are 9:16, the
   *  rest are 16:9.  Set alongside `storyPlayerUrl` when the user clicks
   *  a finished job. */
  storyPlayerAspect: '16/9' | '9/16'
  /** Bottom-right render jobs queue.  Persistent across modal open/close
   *  so the widget keeps ticking while the user explores the canvas.
   *  Each entry owns its own fetch + polling lifecycle (managed by the
   *  RenderJobs component). */
  renderJobs: RenderJob[]
  /** Bottom-bar floating gallery for finished renders.  Reads completed
   *  jobs from `renderJobs` filtered by status==='done', grouped by
   *  mode (Reel / Sinematik / Sesli Kitap). */
  mediaLibraryOpen: boolean
  legendOpen: boolean
  decisionLogOpen: boolean
  confirmResetOpen: boolean
  insertContext: InsertEdgeContext | null
  background: BackgroundPreset

  agents: AgentEvent[]
  decisions: Decision[]
  scenes: Map<string, Scene>
  hoveredSceneId: string | null

  // Transient flag — set when the user enters canvas with a new seed.
  // Auto-expand fires for the root EXACTLY ONCE and clears this flag.
  // NOT persisted: page reload does NOT re-arm auto-expand (which would
  // burn API credits on every refresh).  Only an explicit "Enter" or
  // "New story" click sets it again.
  pendingAutoExpand: boolean
  consumePendingAutoExpand: () => boolean

  // Save / load helpers.
  snapshotCurrent: () => StorySnapshot
  loadFromSnapshot: (snapshot: StorySnapshot) => void

  // navigation
  enterCanvas: (seed: string) => void
  resetToLanding: () => void
  newSession: (seed: string) => void
  setCurrent: (nodeId: string, decidedBy?: Decider, agentName?: string) => void
  setSelected: (nodeId: string | null) => void
  setEdgeHighlightTarget: (nodeId: string | null) => void
  openLightbox: (nodeId: string) => void
  closeLightbox: () => void
  openStorybook: (nodeId: string) => void
  closeStorybook: () => void
  openStoryPlayer: (endpointId: string, url: string, aspect?: '16/9' | '9/16') => void
  closeStoryPlayer: () => void
  addRenderJob: (job: RenderJob) => void
  updateRenderJob: (id: string, patch: Partial<RenderJob>) => void
  removeRenderJob: (id: string) => void
  toggleMediaLibrary: () => void
  toggleLegend: () => void
  toggleDecisionLog: () => void
  openConfirmReset: () => void
  closeConfirmReset: () => void
  setBackground: (bg: BackgroundPreset) => void
  openInsertModal: (parentId: string, childId: string, mode?: 'canon' | 'what-if') => void
  closeInsertModal: () => void

  // tree edits
  addBranches: (
    parentId: string,
    branches: Omit<StoryNode, 'id' | 'x' | 'y' | 'childrenIds' | 'parentId' | 'depth' | 'status' | 'decidedBy' | 'staleState'>[],
    decidedBy?: Decider,
    agentName?: string,
    /** Decision prompt that produced these branches — stored on the parent. */
    question?: string,
  ) => string[]
  insertBetween: (
    parentId: string,
    childId: string,
    branch: BranchSuggestion,
    mode: 'canon' | 'what-if',
    decidedBy: Decider,
    agentName?: string,
  ) => string | null
  /** Phase 1 of a two-phase optimistic insert.  Splices an empty
   *  `status:'generating'` shell into the tree at the final position the
   *  new beat will occupy, so the canvas shows a shimmering placeholder
   *  at the exact landing spot the moment the modal closes — before
   *  writer-assist or image-gen have returned.  `fillInsertedShell`
   *  patches the real content once Hermes responds. */
  insertShell: (
    parentId: string,
    childId: string,
    mode: 'canon' | 'what-if',
    decidedBy: Decider,
    agentName?: string,
  ) => string | null
  /** Phase 2 — patches a shell created by `insertShell` with the real
   *  writer-assist output.  Clears the 'generating' status (canon →
   *  canon, what-if → unvisited) and records the Decision provenance
   *  entry that `insertBetween` would normally write up-front. */
  fillInsertedShell: (nodeId: string, branch: BranchSuggestion) => void
  removeInserted: (nodeId: string) => void
  applyRewrite: (nodeId: string, patch: Partial<StoryNode>, agentName: string, reason: string) => void
  setNodeImage: (nodeId: string, imageUrl: string) => void
  /** Patch a node's narrative prose (body, optionally summary) without
   *  triggering the rewrite bookkeeping (no staleState flip, no original
   *  backup).  Used by brainstorm to fill the scene paragraph the skill
   *  wrote for the current beat as it brainstormed children.  Also
   *  accepts `rawBrainstorm` so the parent node can carry its verbatim
   *  brainstorm reply for the next turn's history reconstruction. */
  patchNodeProse: (nodeId: string, patch: { body?: string; summary?: string; rawBrainstorm?: string; renderedImagePrompt?: string }) => void

  // Character registry — keeps every character's IP-free visual description
  // consistent across image-prompt-build calls.  Populated by
  // visual-prompt-builder's ``characters_seen`` output.
  characters: Record<string, string>
  mergeCharacters: (entries: Record<string, string>) => void
  clearCharacters: () => void

  // Character reference portraits — URL per character, painted by the
  // character-sheet-builder flow at canvas-enter.  Every subsequent beat
  // image-gen passes the matching refs as multi-modal input to
  // Nano Banana / SeeDream so characters stay visually consistent across
  // the whole storyboard.
  characterRefs: Record<string, string>
  mergeCharacterRefs: (entries: Record<string, string>) => void
  clearCharacterRefs: () => void

  // Image policy — decided once at canvas-enter by the
  // story-copyright-detector skill/tool.  Routes every image-gen request
  // to FLUX (IP-heavy seeds) or Gemini/Nano Banana (original/inspired).
  imagePolicy: ImagePolicy
  setImagePolicy: (policy: ImagePolicy) => void

  // Agent-panel mode.  Default ``storytelling`` hides tool events
  // (Registry, Moderation) and auto-fades done narrative events after a
  // few seconds so the canvas stays clean.  ``debug`` shows every event
  // persistently — for jury demos or troubleshooting.
  agentMode: 'storytelling' | 'debug'
  setAgentMode: (mode: 'storytelling' | 'debug') => void

  // Auto-ask Hermes whenever the user walks to a beat that has no
  // children yet.  Default ON — cinematic flow, user is always
  // presented with the next question.  Turn OFF when you want to read
  // the prose without the meter ticking on Claude.  Persisted.
  autoAsk: boolean
  setAutoAsk: (v: boolean) => void
  keepStale: (nodeId: string) => void
  markUnresolved: (nodeId: string) => void
  revertRewrite: (nodeId: string) => void
  detachFromCanon: (nodeId: string) => void
  markGenerating: (nodeId: string, on: boolean) => void

  // agent stream
  appendAgent: (ev: AgentEvent) => void
  updateAgent: (id: string, patch: Partial<AgentEvent>) => void
  clearAgents: () => void

  // provenance
  addDecision: (d: Omit<Decision, 'id' | 'createdAt'>) => void
  clearDecisions: () => void

  // scenes
  setScenes: (scenes: Map<string, Scene>) => void
  clearScenes: () => void
  setHoveredScene: (id: string | null) => void
}

function relayoutAndRecompute(
  nodes: Map<string, StoryNode>,
  rootId: string,
  currentId: string,
): void {
  // Canon = strict ancestors of the NEW current node. Walking up from
  // currentId via parentId guarantees that siblings of any previously
  // current/canon node get demoted to 'visited' cleanly — no stray cyan
  // highlights on branches the user has navigated away from.
  const canonSet = new Set<string>()
  let cursor: string | null = currentId
  while (cursor) {
    canonSet.add(cursor)
    const n = nodes.get(cursor)
    cursor = n?.parentId ?? null
  }

  nodes.forEach((n) => {
    if (n.id === currentId) {
      n.status = 'current'
    } else if (canonSet.has(n.id)) {
      n.status = 'canon'
    } else if (n.status === 'current' || n.status === 'canon') {
      n.status = 'visited'
    }
    // unvisited stays unvisited
  })
  layoutTree(nodes, rootId)
}

function freshTree(seed: string): { nodes: Map<string, StoryNode>; rootId: string } {
  // Root-only tree.  The brainstorm agent grows the children on canvas
  // mount (see Home's auto-expand effect) so every story starts from its
  // actual seed — no hardcoded Marvel blueprint leaking into Avatar /
  // Breaking Bad / custom seeds.
  const map = buildRootTree(seed)
  layoutTree(map, 'root')
  return { nodes: map, rootId: 'root' }
}

/** Recursively collect downstream descendants (excluding the start node). */
function collectDescendants(start: string, nodes: Map<string, StoryNode>): string[] {
  const out: string[] = []
  const stack = [...(nodes.get(start)?.childrenIds ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    out.push(id)
    const n = nodes.get(id)
    if (n) stack.push(...n.childrenIds)
  }
  return out
}

/** Collect the CANON descendant chain from `start` (excluding start). Walks
 *  a single path by preferring current → canon → author-canon insert →
 *  none.  What-if siblings and their subtrees are skipped — they represent
 *  alternative timelines and don't need to adapt when a canon insert
 *  reshapes the main story.
 *
 *  Why the `inserted && tone === 'canon'` fallback: when a user deliberately
 *  splices a canon beat BELOW the current node (e.g. inserting into a leaf
 *  subtree), relayout demotes that beat's status from 'canon' to 'visited'
 *  because it's not an ancestor of current.  A later upstream canon splice
 *  would then stop walking at `current`, missing the deliberate downstream
 *  inserts.  Following author-canon inserts fixes that: the walker respects
 *  authorial intent regardless of where the user happens to be standing.
 *
 *  This is what insertBetween uses for `staleState` marking so only the
 *  ACTUAL-future-of-the-story beats get flagged, not abandoned timelines. */
function collectCanonDescendants(start: string, nodes: Map<string, StoryNode>): string[] {
  const out: string[] = []
  let cursor: string | null = start
  const seen = new Set<string>()
  while (cursor) {
    if (seen.has(cursor)) break // cycle guard
    seen.add(cursor)
    const n = nodes.get(cursor)
    if (!n) break
    const nextId =
      n.childrenIds.find((id) => nodes.get(id)?.status === 'current') ??
      n.childrenIds.find((id) => nodes.get(id)?.status === 'canon') ??
      n.childrenIds.find((id) => {
        const c = nodes.get(id)
        return c?.inserted === true && c?.tone === 'canon'
      }) ??
      null
    if (!nextId) break
    out.push(nextId)
    cursor = nextId
  }
  return out
}

/** ---- persist scaffolding ----
 *
 * Only light preferences live across reloads. The node tree is rebuilt from
 * the demo seed on every load during dev so UI iterations always show up
 * without manual cache clears.
 */
interface Persisted {
  // ``mode`` intentionally omitted — refresh always returns to landing.
  seed: string
  background: BackgroundPreset
  characters: Record<string, string>
  characterRefs: Record<string, string>
  imagePolicy: ImagePolicy
  agentMode: 'storytelling' | 'debug'
  autoAsk: boolean
}

const noopStorage: Storage = {
  length: 0,
  clear: () => undefined,
  key: () => null,
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}
const mapStorage = createJSONStorage<Persisted>(() =>
  typeof window === 'undefined' ? noopStorage : window.localStorage,
)

const nextId = (() => {
  let n = 0
  return (prefix = 'n') => `${prefix}-${Date.now().toString(36)}-${(n += 1).toString(36)}`
})()

export const useStory = create<StoreState>()(
  persist(
    (set, get) => {
      const initial = freshTree(DEMO_SEED)
      return {
        mode: 'landing',
        seed: DEMO_SEED,
        rootId: initial.rootId,
        nodes: initial.nodes,
        currentId: 'root',
        selectedId: null,
        edgeHighlightTargetId: null,
        lightboxNodeId: null,
        storybookEndpointId: null,
        storyPlayerUrl: null,
        storyPlayerAspect: '16/9',
        renderJobs: [],
        mediaLibraryOpen: false,
        legendOpen: false,
        decisionLogOpen: false,
        confirmResetOpen: false,
        insertContext: null,
        background: 'detroit-dark',
        agents: [],
        decisions: [],
        scenes: new Map<string, Scene>(),
        hoveredSceneId: null,

        // Transient, NEVER persisted.  Set true by enterCanvas / newSession,
        // consumed once by the canvas auto-expand effect.
        pendingAutoExpand: false,
        consumePendingAutoExpand: () => {
          const was = get().pendingAutoExpand
          if (was) set({ pendingAutoExpand: false })
          return was
        },

        // Serialise live state into a SAVE snapshot.  Reads fresh
        // state via get() so the caller gets a consistent read even
        // mid-render.
        snapshotCurrent: () => {
          const s = get()
          return snapshotFromState({
            seed: s.seed,
            rootId: s.rootId,
            currentId: s.currentId,
            nodes: s.nodes,
            scenes: s.scenes,
            characters: s.characters,
            characterRefs: s.characterRefs,
            decisions: s.decisions,
            agents: s.agents,
            background: s.background,
            imagePolicy: s.imagePolicy,
          })
        },

        // Replace the whole canvas state from a loaded save.  Critical:
        // ``pendingAutoExpand`` is reset to FALSE so a restored session
        // never fires brainstorm on load — the tree is already there.
        // Re-layouts defensively in case the saved coordinates were
        // authored against a different layout.
        loadFromSnapshot: (snapshot) => {
          // Kill any inflight Hermes calls from the previous session so
          // their late responses can't graft children onto this loaded
          // tree (and can't corrupt characterRefs / decisions).
          requestControl.abortAll('load-snapshot')
          const nodes = new Map<string, StoryNode>(snapshot.nodes ?? [])
          const scenes = new Map<string, Scene>(snapshot.scenes ?? [])
          layoutTree(nodes, snapshot.rootId)
          // Re-detect image policy from the loaded seed.  Saved
          // snapshots carry the policy computed at save-time; if the
          // detector logic has since changed (e.g. we now route
          // animated franchises to gemini-stylised), blindly restoring
          // the old policy would pin the loaded story to the wrong
          // image model forever.
          const freshPolicy = detectStoryCopyright(snapshot.seed)
          set({
            mode: 'canvas',
            seed: snapshot.seed,
            rootId: snapshot.rootId,
            currentId: snapshot.currentId,
            nodes,
            scenes,
            characters: snapshot.characters ?? {},
            characterRefs: snapshot.characterRefs ?? {},
            decisions: snapshot.decisions ?? [],
            agents: snapshot.agents ?? [],
            background: snapshot.background,
            imagePolicy: freshPolicy,
            pendingAutoExpand: false,
            selectedId: null,
            lightboxNodeId: null,
            storybookEndpointId: null,
            storyPlayerUrl: null,
            renderJobs: [],
            hoveredSceneId: null,
            insertContext: null,
            confirmResetOpen: false,
          })
        },

        enterCanvas: (seed) =>
          set((s) => {
            if (!seed.trim() || seed.trim() === s.seed) {
              // Same seed — resume in canvas, do NOT re-expand (existing
              // tree is what the user left behind).
              return { mode: 'canvas', seed }
            }
            // Seed changed → abort any inflight fetches from the previous
            // story so stale children don't graft onto the fresh tree.
            requestControl.abortAll('enter-canvas-new-seed')
            const fresh = freshTree(seed)
            return {
              mode: 'canvas', seed,
              rootId: fresh.rootId, nodes: fresh.nodes, currentId: 'root',
              agents: [], decisions: [], scenes: new Map<string, Scene>(),
              pendingAutoExpand: true,
              // Fresh cast for the fresh story — stale refs from the
              // previous seed would show e.g. Aang's portrait inside a
              // Marvel scene's reference bundle.
              characters: {}, characterRefs: {},
            }
          }),

        newSession: (seed) =>
          set(() => {
            requestControl.abortAll('new-session')
            const fresh = freshTree(seed)
            return {
              mode: 'canvas', seed,
              rootId: fresh.rootId, nodes: fresh.nodes, currentId: 'root',
              selectedId: null, lightboxNodeId: null, storybookEndpointId: null,
              storyPlayerUrl: null, storyPlayerAspect: '16/9', renderJobs: [],
              agents: [], decisions: [], scenes: new Map<string, Scene>(),
              pendingAutoExpand: true,
              characters: {}, characterRefs: {},
            }
          }),

        resetToLanding: () => {
          requestControl.abortAll('reset-to-landing')
          // Wipe the in-memory tree too — without this, Home → Landing →
          // Enter with the same seed would resurrect the abandoned tree
          // (enterCanvas's same-seed fast-path preserves existing nodes).
          // Also drop the auto-snapshot + resume flag so a subsequent
          // reload doesn't silently pull back the same dead tree.
          try {
            localStorage.removeItem('noustiny:auto-snapshot')
            sessionStorage.removeItem('noustiny:resume-on-reload')
          } catch { /* noop */ }
          set((s) => {
            const fresh = freshTree(s.seed)
            return {
              mode: 'landing',
              rootId: fresh.rootId,
              nodes: fresh.nodes,
              currentId: 'root',
              selectedId: null,
              lightboxNodeId: null,
              storybookEndpointId: null,
              storyPlayerUrl: null,
              storyPlayerAspect: '16/9',
              renderJobs: [],
              hoveredSceneId: null,
              insertContext: null,
              agents: [],
              decisions: [],
              scenes: new Map<string, Scene>(),
              // Fresh cast — leftover references from the abandoned
              // session would leak into the next seed's cast bundle.
              characters: {},
              characterRefs: {},
              pendingAutoExpand: false,
            }
          })
        },

        setCurrent: (nodeId, decidedBy = 'human', agentName) =>
          set((s) => {
            const target = s.nodes.get(nodeId)
            if (!target) return {}
            const next = new Map(s.nodes)
            const patched = { ...target, decidedBy, decidedByAgent: agentName }
            next.set(nodeId, patched)
            relayoutAndRecompute(next, s.rootId, nodeId)
            const decision: Decision = {
              id: nextId('d'),
              action: 'select',
              targetNodeId: nodeId,
              decidedBy, agentName,
              createdAt: Date.now(),
            }
            return {
              currentId: nodeId, nodes: next, selectedId: nodeId,
              decisions: [...s.decisions, decision],
            }
          }),

        setSelected: (nodeId) => set({ selectedId: nodeId }),
        setEdgeHighlightTarget: (nodeId) => set({ edgeHighlightTargetId: nodeId }),
        openLightbox: (nodeId) => set({ lightboxNodeId: nodeId }),
        closeLightbox: () => set({ lightboxNodeId: null }),
        openStorybook: (nodeId) => set({ storybookEndpointId: nodeId, storyPlayerUrl: null, storyPlayerAspect: '16/9' }),
        closeStorybook: () => set({ storybookEndpointId: null, storyPlayerUrl: null, storyPlayerAspect: '16/9' }),
        openStoryPlayer: (endpointId, url, aspect) =>
          set({ storybookEndpointId: endpointId, storyPlayerUrl: url, storyPlayerAspect: aspect ?? '16/9' }),
        closeStoryPlayer: () =>
          set({ storybookEndpointId: null, storyPlayerUrl: null, storyPlayerAspect: '16/9' }),
        addRenderJob: (job) => set((s) => ({ renderJobs: [...s.renderJobs, job] })),
        updateRenderJob: (id, patch) =>
          set((s) => ({
            renderJobs: s.renderJobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
          })),
        removeRenderJob: (id) =>
          set((s) => ({ renderJobs: s.renderJobs.filter((j) => j.id !== id) })),
        // Side-panel toggles are mutually exclusive — opening one closes
        // the others so the right edge never stacks two large overlays at
        // once.  Closing (toggle-off) leaves the others alone.
        toggleMediaLibrary: () => set((s) => s.mediaLibraryOpen
          ? { mediaLibraryOpen: false }
          : { mediaLibraryOpen: true, legendOpen: false, decisionLogOpen: false }),
        toggleLegend: () => set((s) => s.legendOpen
          ? { legendOpen: false }
          : { legendOpen: true, mediaLibraryOpen: false, decisionLogOpen: false }),
        toggleDecisionLog: () => set((s) => s.decisionLogOpen
          ? { decisionLogOpen: false }
          : { decisionLogOpen: true, legendOpen: false, mediaLibraryOpen: false }),
        openConfirmReset: () => set({ confirmResetOpen: true }),
        closeConfirmReset: () => set({ confirmResetOpen: false }),
        setBackground: (bg) => set({ background: bg }),
        openInsertModal: (parentId, childId, mode) => set({ insertContext: { parentId, childId, mode } }),
        closeInsertModal: () => set({ insertContext: null }),

        appendAgent: (ev) => set((s) => ({ agents: [...s.agents.slice(-19), ev] })),
        updateAgent: (id, patch) =>
          set((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
        clearAgents: () => set({ agents: [] }),

        addDecision: (d) =>
          set((s) => ({
            decisions: [
              ...s.decisions,
              { ...d, id: nextId('d'), createdAt: Date.now() },
            ],
          })),
        clearDecisions: () => set({ decisions: [] }),

        setScenes: (scenes) => set({ scenes: new Map(scenes), hoveredSceneId: null }),
        clearScenes: () => set({ scenes: new Map<string, Scene>(), hoveredSceneId: null }),
        setHoveredScene: (id) => set({ hoveredSceneId: id }),

        addBranches: (parentId, branches, decidedBy = 'agent', agentName = 'hermes-brainstorm', question) => {
          const newIds: string[] = []
          set((s) => {
            const parent = s.nodes.get(parentId)
            if (!parent) return {}
            const next = new Map(s.nodes)
            branches.forEach((b) => {
              const id = nextId('b')
              newIds.push(id)
              next.set(id, {
                ...b,
                id,
                parentId,
                childrenIds: [],
                depth: parent.depth + 1,
                status: 'unvisited' as NodeStatus,
                decidedBy,
                decidedByAgent: agentName,
                staleState: 'fresh',
                x: 0, y: 0,
              })
            })
            // Write the skill-authored question onto the parent so the
            // Decision overlay can render "Does he take the gauntlet?"
            // above the choice buttons.  Missing → fallback in UI.
            const patchedParent: StoryNode = question
              ? { ...parent, childrenIds: [...parent.childrenIds, ...newIds], question }
              : { ...parent, childrenIds: [...parent.childrenIds, ...newIds] }
            next.set(parentId, patchedParent)
            relayoutAndRecompute(next, s.rootId, s.currentId)
            const decision: Decision = {
              id: nextId('d'),
              action: 'expand',
              targetNodeId: parentId,
              decidedBy, agentName,
              reason: `Generated ${branches.length} branches`,
              createdAt: Date.now(),
            }
            return { nodes: next, decisions: [...s.decisions, decision] }
          })
          return newIds
        },

        insertBetween: (parentId, childId, branch, mode, decidedBy, agentName) => {
          let createdId: string | null = null
          set((s) => {
            const parent = s.nodes.get(parentId)
            const child = s.nodes.get(childId)
            if (!parent || !child) return {}
            if (!parent.childrenIds.includes(childId)) return {}

            const next = new Map(s.nodes)
            const newId = nextId('ins')
            createdId = newId

            // Create the inserted node at child's previous depth, reparent as needed.
            const insertedDepth = parent.depth + 1

            if (mode === 'canon') {
              // Splice in between: parent → new → child
              next.set(newId, {
                id: newId,
                parentId,
                childrenIds: [childId],
                depth: insertedDepth,
                title: branch.title.slice(0, 200),
                label: branch.title.split(/\s+/).slice(0, 3).join(' ').slice(0, 32).toLocaleUpperCase('tr-TR'),
                summary: branch.summary.slice(0, 400),
                body: branch.body,
                imagePrompt: branch.imagePrompt,
                imageUrl: imageUrl({
                  prompt: branch.imagePrompt,
                  seed: seedFromString(newId + branch.title),
                }),
                mood: branch.mood,
                tone: branch.tone,
                worldPercent: branch.worldPercent,
                status: 'canon',
                decidedBy,
                decidedByAgent: agentName,
                inserted: true,
                staleState: 'fresh',
                x: 0, y: 0,
              })
              // Parent: replace child with newId
              next.set(parentId, {
                ...parent,
                childrenIds: parent.childrenIds.map((id) => (id === childId ? newId : id)),
              })
              // Child: reparent to newId, bump depth for subtree
              next.set(childId, { ...child, parentId: newId })
              // Depth shift applies to ALL descendants (the subtree moved one
              // column right spatially).  But `staleState` and the insert-
              // cause pointer apply only to the CANON chain — what-if
              // siblings and their subtrees describe abandoned timelines and
              // don't need to reconcile against the new insert.
              const allDownstream = [childId, ...collectDescendants(childId, next)]
              const canonDownstream = new Set<string>([childId, ...collectCanonDescendants(childId, next)])
              allDownstream.forEach((id) => {
                const n = next.get(id)
                if (!n) return
                const isCanonChain = canonDownstream.has(id)
                next.set(id, {
                  ...n,
                  depth: (n.depth + 1), // shifted right by 1 column due to new parent
                  ...(isCanonChain
                    ? {
                        staleState: 'stale' as const,
                        insertCauseId: newId,
                        originalBody: n.originalBody ?? n.body,
                        originalTitle: n.originalTitle ?? n.title,
                        originalSummary: n.originalSummary ?? n.summary,
                        originalLabel: n.originalLabel ?? n.label,
                        originalImagePrompt: n.originalImagePrompt ?? n.imagePrompt,
                        originalImageUrl: n.originalImageUrl ?? n.imageUrl,
                      }
                    : {}),
                })
              })
            } else {
              // 'what-if': new sibling of child (same parent), standalone
              next.set(newId, {
                id: newId,
                parentId,
                childrenIds: [],
                depth: insertedDepth,
                title: branch.title.slice(0, 200),
                label: branch.title.split(/\s+/).slice(0, 3).join(' ').slice(0, 32).toLocaleUpperCase('tr-TR'),
                summary: branch.summary.slice(0, 400),
                body: branch.body,
                imagePrompt: branch.imagePrompt,
                imageUrl: imageUrl({
                  prompt: branch.imagePrompt,
                  seed: seedFromString(newId + branch.title),
                }),
                mood: branch.mood,
                tone: 'what-if',
                worldPercent: branch.worldPercent,
                status: 'unvisited',
                decidedBy,
                decidedByAgent: agentName,
                inserted: true,
                staleState: 'fresh',
                x: 0, y: 0,
              })
              next.set(parentId, {
                ...parent,
                childrenIds: [...parent.childrenIds, newId],
              })
            }

            relayoutAndRecompute(next, s.rootId, s.currentId)
            const decision: Decision = {
              id: nextId('d'),
              action: 'insert',
              targetNodeId: newId,
              decidedBy, agentName,
              reason: mode === 'canon' ? `Inserted between ${parent.title} and ${child.title}` : `New what-if from ${parent.title}`,
              afterSnapshot: { title: branch.title, summary: branch.summary, mood: branch.mood },
              createdAt: Date.now(),
            }
            return {
              nodes: next, insertContext: null,
              decisions: [...s.decisions, decision],
            }
          })
          return createdId
        },

        insertShell: (parentId, childId, mode, decidedBy, agentName) => {
          let createdId: string | null = null
          set((s) => {
            const parent = s.nodes.get(parentId)
            const child = s.nodes.get(childId)
            if (!parent || !child) return {}
            if (!parent.childrenIds.includes(childId)) return {}

            const next = new Map(s.nodes)
            const newId = nextId('ins')
            createdId = newId
            const insertedDepth = parent.depth + 1

            // Shell content — left empty so the card renders the
            // HERMES WEAVING overlay (keyed off status:'generating') at
            // the exact final position.  fillInsertedShell patches real
            // fields once writer-assist returns.
            const shell: StoryNode = {
              id: newId,
              parentId,
              childrenIds: mode === 'canon' ? [childId] : [],
              depth: insertedDepth,
              title: '',
              summary: '',
              body: '',
              imagePrompt: '',
              imageUrl: '',
              mood: 'neutral',
              tone: mode === 'canon' ? 'canon' : 'what-if',
              status: 'generating',
              decidedBy,
              decidedByAgent: agentName,
              inserted: true,
              staleState: 'fresh',
              x: 0, y: 0,
            }
            next.set(newId, shell)

            if (mode === 'canon') {
              next.set(parentId, {
                ...parent,
                childrenIds: parent.childrenIds.map((id) => (id === childId ? newId : id)),
              })
              next.set(childId, { ...child, parentId: newId })
              const allDownstream = [childId, ...collectDescendants(childId, next)]
              const canonDownstream = new Set<string>([childId, ...collectCanonDescendants(childId, next)])
              allDownstream.forEach((id) => {
                const n = next.get(id)
                if (!n) return
                const isCanonChain = canonDownstream.has(id)
                next.set(id, {
                  ...n,
                  depth: n.depth + 1,
                  ...(isCanonChain
                    ? {
                        staleState: 'stale' as const,
                        insertCauseId: newId,
                        originalBody: n.originalBody ?? n.body,
                        originalTitle: n.originalTitle ?? n.title,
                        originalSummary: n.originalSummary ?? n.summary,
                        originalLabel: n.originalLabel ?? n.label,
                        originalImagePrompt: n.originalImagePrompt ?? n.imagePrompt,
                        originalImageUrl: n.originalImageUrl ?? n.imageUrl,
                      }
                    : {}),
                })
              })
            } else {
              next.set(parentId, {
                ...parent,
                childrenIds: [...parent.childrenIds, newId],
              })
            }

            relayoutAndRecompute(next, s.rootId, s.currentId)
            return { nodes: next, insertContext: null }
          })
          return createdId
        },

        fillInsertedShell: (nodeId, branch) =>
          set((s) => {
            const node = s.nodes.get(nodeId)
            if (!node) return {}
            const next = new Map(s.nodes)
            // Mode inferred from the shell's tone — canon shells carry
            // tone:'canon', what-ifs carry tone:'what-if'.
            const isCanon = node.tone === 'canon'
            next.set(nodeId, {
              ...node,
              title: branch.title.slice(0, 200),
              label: branch.title.split(/\s+/).slice(0, 3).join(' ').slice(0, 32).toLocaleUpperCase('tr-TR'),
              summary: branch.summary.slice(0, 400),
              body: branch.body,
              imagePrompt: branch.imagePrompt,
              imageUrl: imageUrl({
                prompt: branch.imagePrompt,
                seed: seedFromString(nodeId + branch.title),
              }),
              mood: branch.mood,
              tone: branch.tone,
              worldPercent: branch.worldPercent,
              // Canon shells re-enter the canon chain via
              // relayoutAndRecompute below; what-if shells become
              // unvisited siblings.  Either way we clear 'generating'.
              status: isCanon ? 'canon' : 'unvisited',
            })
            relayoutAndRecompute(next, s.rootId, s.currentId)
            const parent = node.parentId ? s.nodes.get(node.parentId) : null
            const childId = isCanon ? node.childrenIds[0] : null
            const child = childId ? s.nodes.get(childId) : null
            const decision: Decision = {
              id: nextId('d'),
              action: 'insert',
              targetNodeId: nodeId,
              decidedBy: node.decidedBy,
              agentName: node.decidedByAgent,
              reason: isCanon && parent && child
                ? `Inserted between ${parent.title} and ${child.title}`
                : parent
                  ? `New what-if from ${parent.title}`
                  : 'Insert',
              afterSnapshot: { title: branch.title, summary: branch.summary, mood: branch.mood },
              createdAt: Date.now(),
            }
            return { nodes: next, decisions: [...s.decisions, decision] }
          }),

        removeInserted: (nodeId) =>
          set((s) => {
            const node = s.nodes.get(nodeId)
            if (!node || !node.inserted) return {}
            if (!node.parentId) return {}
            const parent = s.nodes.get(node.parentId)
            if (!parent) return {}
            const next = new Map(s.nodes)
            // Reattach node's children to its parent (restoring original edge)
            const originalChildren = node.childrenIds
            next.set(node.parentId, {
              ...parent,
              childrenIds: parent.childrenIds.flatMap((id) =>
                id === nodeId ? originalChildren : [id],
              ),
            })
            // For each child: restore parentId + depth - 1, and un-stale
            originalChildren.forEach((cid) => {
              const c = next.get(cid)
              if (!c) return
              const descendants = [cid, ...collectDescendants(cid, next)]
              descendants.forEach((id) => {
                const d = next.get(id)
                if (!d) return
                const restored: StoryNode = { ...d, depth: d.depth - 1 }
                if (id === cid) restored.parentId = node.parentId
                // If we have originals stored, restore them (undo rewrite)
                if (restored.originalTitle) restored.title = restored.originalTitle
                if (restored.originalSummary) restored.summary = restored.originalSummary
                if (restored.originalBody) restored.body = restored.originalBody
                if (restored.originalLabel !== undefined) restored.label = restored.originalLabel
                if (restored.originalImagePrompt !== undefined) restored.imagePrompt = restored.originalImagePrompt
                if (restored.originalImageUrl !== undefined) restored.imageUrl = restored.originalImageUrl
                restored.staleState = 'fresh'
                delete restored.originalTitle
                delete restored.originalSummary
                delete restored.originalBody
                delete restored.originalLabel
                delete restored.originalImagePrompt
                delete restored.originalImageUrl
                delete restored.insertCauseId
                next.set(id, restored)
              })
            })
            next.delete(nodeId)
            relayoutAndRecompute(next, s.rootId, s.currentId)
            const decision: Decision = {
              id: nextId('d'),
              action: 'remove_inserted',
              targetNodeId: nodeId,
              decidedBy: 'human',
              reason: `Removed "${node.title}" and restored original flow`,
              createdAt: Date.now(),
            }
            return { nodes: next, decisions: [...s.decisions, decision] }
          }),

        setNodeImage: (nodeId, imageUrlNew) =>
          set((s) => {
            const n = s.nodes.get(nodeId)
            if (!n) return {}
            if (n.imageUrl === imageUrlNew) return {}
            const next = new Map(s.nodes)
            next.set(nodeId, { ...n, imageUrl: imageUrlNew })
            return { nodes: next }
          }),

        patchNodeProse: (nodeId, patch) =>
          set((s) => {
            const n = s.nodes.get(nodeId)
            if (!n) return {}
            const next = new Map(s.nodes)
            next.set(nodeId, {
              ...n,
              ...(patch.body !== undefined ? { body: patch.body } : {}),
              ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
              ...(patch.rawBrainstorm !== undefined ? { rawBrainstorm: patch.rawBrainstorm } : {}),
              ...(patch.renderedImagePrompt !== undefined ? { renderedImagePrompt: patch.renderedImagePrompt } : {}),
            })
            return { nodes: next }
          }),

        characters: {},
        mergeCharacters: (entries) =>
          set((s) => ({ characters: { ...s.characters, ...entries } })),
        clearCharacters: () => set({ characters: {} }),

        characterRefs: {},
        mergeCharacterRefs: (entries) =>
          set((s) => ({ characterRefs: { ...s.characterRefs, ...entries } })),
        clearCharacterRefs: () => set({ characterRefs: {} }),

        // Default policy is the deterministic classification of the demo
        // seed — flux-photoreal for Marvel.  Overwritten the moment the
        // detector skill returns.
        imagePolicy: detectStoryCopyright(DEMO_SEED),
        setImagePolicy: (policy) => set({ imagePolicy: policy }),

        agentMode: 'storytelling',
        setAgentMode: (mode) => set({ agentMode: mode }),

        autoAsk: true,
        setAutoAsk: (v) => set({ autoAsk: v }),

        applyRewrite: (nodeId, patch, agentName, reason) =>
          set((s) => {
            const n = s.nodes.get(nodeId)
            if (!n) return {}
            const next = new Map(s.nodes)
            const before = { title: n.title, summary: n.summary, body: n.body, mood: n.mood }
            const titleChanged = patch.title !== undefined && patch.title !== n.title
            const merged: StoryNode = {
              ...n,
              ...patch,
              originalTitle: n.originalTitle ?? n.title,
              originalSummary: n.originalSummary ?? n.summary,
              originalBody: n.originalBody ?? n.body,
              // Back up the decision-verb label from before the first
              // rewrite, then strip it so the compact bar falls through
              // to the fresh title.  The old verb phrase ("FREES HIM")
              // no longer matches the new beat, and leaving it produces
              // the exact bar-vs-hover mismatch we hit in testing.
              originalLabel: n.originalLabel ?? n.label,
              // Capture the pre-rewrite image state so revert can restore
              // BOTH the text and the visual.  Otherwise the reverted
              // title sits over the rewrite's generated image.
              originalImagePrompt: n.originalImagePrompt ?? n.imagePrompt,
              originalImageUrl: n.originalImageUrl ?? n.imageUrl,
              label: titleChanged ? undefined : n.label,
              staleState: 'rewritten',
              decidedBy: 'agent',
              decidedByAgent: agentName,
            }
            if (patch.imagePrompt && patch.imagePrompt !== n.imagePrompt) {
              merged.imageUrl = imageUrl({
                prompt: patch.imagePrompt,
                seed: seedFromString(nodeId + patch.imagePrompt),
              })
            }
            next.set(nodeId, merged)
            const decision: Decision = {
              id: nextId('d'),
              action: 'rewrite',
              targetNodeId: nodeId,
              decidedBy: 'agent',
              agentName, reason,
              beforeSnapshot: before,
              afterSnapshot: { title: merged.title, summary: merged.summary, body: merged.body, mood: merged.mood },
              createdAt: Date.now(),
            }
            return { nodes: next, decisions: [...s.decisions, decision] }
          }),

        keepStale: (nodeId) =>
          set((s) => {
            const n = s.nodes.get(nodeId)
            if (!n) return {}
            const next = new Map(s.nodes)
            next.set(nodeId, { ...n, staleState: 'fresh' })
            const decision: Decision = {
              id: nextId('d'),
              action: 'keep_stale',
              targetNodeId: nodeId,
              decidedBy: 'human',
              reason: 'Kept original against insert',
              createdAt: Date.now(),
            }
            return { nodes: next, decisions: [...s.decisions, decision] }
          }),

        markUnresolved: (nodeId) =>
          set((s) => {
            const n = s.nodes.get(nodeId)
            if (!n) return {}
            const next = new Map(s.nodes)
            next.set(nodeId, { ...n, staleState: 'unresolved' })
            return { nodes: next }
          }),

        // Demote a stale downstream beat to an abandoned-alternative what-if
        // instead of rewriting it.  Used when the critic says the insert makes
        // the beat impossible (must_delete, high severity) — forcing a
        // rewrite in that case produces a bolted-on "ICE CRACKS AROUND HIM"
        // half-fit.  The cleaner move is: keep the old beat but demote it to
        // a what-if alternative, then brainstorm fresh canon children on the
        // insert so the canon spine picks up from something organic.
        detachFromCanon: (nodeId) =>
          set((s) => {
            const n = s.nodes.get(nodeId)
            if (!n) return {}
            const next = new Map(s.nodes)
            const demoted: StoryNode = {
              ...n,
              tone: 'what-if',
              staleState: 'fresh',
              // Downgrade status too so the Detroit legend reads this branch
              // as "not walked" instead of "still the canon we came from".
              status: n.status === 'current' ? 'unvisited' : n.status === 'canon' ? 'visited' : n.status,
            }
            // All the originals/insertCauseId bookkeeping we kept for a
            // possible rewrite is now dead weight — this beat will never be
            // rewritten by the cascade that demoted it.
            delete demoted.originalTitle
            delete demoted.originalSummary
            delete demoted.originalBody
            delete demoted.originalLabel
            delete demoted.originalImagePrompt
            delete demoted.originalImageUrl
            delete demoted.insertCauseId
            next.set(nodeId, demoted)
            const decision: Decision = {
              id: nextId('d'),
              action: 'human_override',
              targetNodeId: nodeId,
              decidedBy: 'agent',
              agentName: 'hermes-director',
              reason: 'Critic flagged insert contradiction — demoted to alternative',
              createdAt: Date.now(),
            }
            return { nodes: next, decisions: [...s.decisions, decision] }
          }),

        revertRewrite: (nodeId) =>
          set((s) => {
            const n = s.nodes.get(nodeId)
            if (!n || !n.originalTitle) return {}
            const next = new Map(s.nodes)
            const restored: StoryNode = {
              ...n,
              title: n.originalTitle ?? n.title,
              summary: n.originalSummary ?? n.summary,
              body: n.originalBody ?? n.body,
              // Revert restores the pre-rewrite decision label too, so the
              // compact bar goes back to "FREES HIM" etc. when the user
              // un-does a rewrite they didn't like.
              label: n.originalLabel ?? n.label,
              // Restore the pre-rewrite image state — title + image stay
              // in sync after a revert.
              imagePrompt: n.originalImagePrompt ?? n.imagePrompt,
              imageUrl: n.originalImageUrl ?? n.imageUrl,
              staleState: 'stale',
              decidedBy: 'human',
              decidedByAgent: undefined,
            }
            delete restored.originalTitle
            delete restored.originalSummary
            delete restored.originalBody
            delete restored.originalLabel
            delete restored.originalImagePrompt
            delete restored.originalImageUrl
            next.set(nodeId, restored)
            const decision: Decision = {
              id: nextId('d'),
              action: 'human_override',
              targetNodeId: nodeId,
              decidedBy: 'human',
              reason: 'Reverted agent rewrite',
              createdAt: Date.now(),
            }
            return { nodes: next, decisions: [...s.decisions, decision] }
          }),

        markGenerating: (nodeId, on) =>
          set((s) => {
            const n = s.nodes.get(nodeId)
            if (!n) return {}
            const next = new Map(s.nodes)
            if (on) {
              next.set(nodeId, { ...n, status: 'generating' })
              return { nodes: next }
            }
            relayoutAndRecompute(next, s.rootId, s.currentId)
            return { nodes: next }
          }),
      }
    },
    {
      name: 'noustiny:v1',
      storage: mapStorage,
      version: 6,
      // Persist only preferences and the fact that the user entered the canvas.
      // The tree itself (nodes / currentId / decisions) is rebuilt fresh from
      // the demo seed on each load so iterative UI / layout changes always
      // show up without forcing a localStorage clear. Once a real DB backend
      // lands, branch progress will persist there instead.
      partialize: (s) => ({
        // ``mode`` is deliberately NOT persisted — every reload lands on
        // the SeedInput (home) regardless of where the user was, so a
        // browser refresh never silently re-opens a mid-session canvas.
        // The RefreshGuard modal lets the user save first if they want
        // to preserve progress before leaving.
        seed: s.seed,
        background: s.background,
        characters: s.characters,
        characterRefs: s.characterRefs,
        imagePolicy: s.imagePolicy,
        agentMode: s.agentMode,
        autoAsk: s.autoAsk,
      }),
      merge: (persistedState, current) => {
        const p = persistedState as Partial<Persisted> | undefined
        if (!p) return current
        // Persist is seed-scoped: tree itself is rebuilt from the persisted
        // seed on every load.  Without this, ``seed=Avatar`` from last
        // session would hydrate alongside a stale Marvel tree in the
        // initial state, and enterCanvas(Avatar)'s "same seed, skip
        // rebuild" branch would leave Marvel nodes showing under an
        // Avatar logline.
        const freshSeed = p.seed ?? current.seed
        const fresh = freshTree(freshSeed)
        return {
          ...current,
          // Force landing on every reload — see partialize comment.
          mode: 'landing',
          seed: freshSeed,
          background: p.background ?? current.background,
          characters: p.characters ?? current.characters,
          characterRefs: p.characterRefs ?? current.characterRefs,
          // Re-run the deterministic detector against the persisted seed
          // on every hydrate.  Free (sync TS mirror, no LLM), and it
          // auto-migrates sessions whose imagePolicy was computed by an
          // older detector build (e.g. airbender used to route to FLUX
          // before we added animated franchises to the stylised set —
          // without this, persisted state would pin old users to the
          // wrong image model forever).
          imagePolicy: detectStoryCopyright(freshSeed),
          agentMode: p.agentMode ?? current.agentMode,
          autoAsk: typeof p.autoAsk === 'boolean' ? p.autoAsk : current.autoAsk,
          rootId: fresh.rootId,
          nodes: fresh.nodes,
          currentId: 'root',
          selectedId: null,
          lightboxNodeId: null,
          storybookEndpointId: null,
          storyPlayerUrl: null,
          storyPlayerAspect: '16/9',
          renderJobs: [],
          agents: [],
          decisions: [],
          scenes: new Map<string, Scene>(),
          hoveredSceneId: null,
        }
      },
    },
  ),
)

export const selectCanonPath = (s: StoreState): string[] => canonPath(s.nodes, s.rootId, s.currentId)
export const selectCurrentNode = (s: StoreState): StoryNode | undefined => s.nodes.get(s.currentId)
export const selectStaleIds = (s: StoreState): string[] => {
  const out: string[] = []
  s.nodes.forEach((n) => {
    if (n.staleState === 'stale' || n.staleState === 'unresolved') out.push(n.id)
  })
  return out
}

// Dev-only: expose the Zustand store on `window` so Playwright / browser
// console can inspect state (e.g. node titles / labels / staleState)
// without requiring React DevTools.  No-op in production builds because
// NODE_ENV is compile-time substituted and the branch gets tree-shaken.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as unknown as { __noustinyStore?: typeof useStory }).__noustinyStore = useStory
}
