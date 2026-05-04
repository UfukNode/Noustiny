export type NodeStatus =
  | 'current'
  | 'canon'
  | 'visited'
  | 'unvisited'
  | 'generating'

export type NodeMood =
  | 'neutral'
  | 'hopeful'
  | 'tense'
  | 'danger'
  | 'climax'
  | 'quiet'
  | 'discovery'

/**
 * Ambient scene effect driven by a particle layer.  The AI decides
 * both what falls/floats (`kind`) and whether it lives inside the
 * image frame or in the backdrop around it (`scope`) — so a cave
 * scene can have a snowy world *outside* the frame without putting
 * snow on the cave interior.  `none` / `scope: 'none'` → no render.
 */
export type AmbienceKind =
  | 'snow'
  | 'rain'
  | 'embers'
  | 'ash'
  | 'dust_motes'
  | 'fireflies'
  | 'drip'
  | 'fog'
  | 'none'

export type AmbienceScope = 'in_frame' | 'around_frame' | 'none'

export type AmbienceIntensity = 'subtle' | 'active' | 'dense'

export interface Ambience {
  kind: AmbienceKind
  scope: AmbienceScope
  intensity?: AmbienceIntensity
}

export type NodeTone = 'canon' | 'divergent' | 'what-if'

export type NodeVariant = 'checkpoint' | 'compact'

// Backdrop is now driven by theme alone (dark/light) — see DbhBackdrop.
// Keeping the legacy preset values as accepted aliases prevents stale
// localStorage payloads from breaking type-safe rehydration; everything
// non-light collapses to the dark backdrop.
export type BackgroundPreset = 'detroit-dark' | 'detroit-light'

export type Decider = 'human' | 'agent'

export type StaleState = 'fresh' | 'stale' | 'rewritten' | 'unresolved'

export interface StoryNode {
  id: string
  parentId: string | null
  childrenIds: string[]
  depth: number

  title: string
  summary: string
  body?: string
  imagePrompt: string
  imageUrl: string
  mood: NodeMood
  tone: NodeTone

  /** Detroit-style choice label ("TAKES IT", "HESITATES") emitted by the
   *  brainstorm skill alongside `title`.  Used in the Decision overlay
   *  buttons and in compact sibling bars.  Falls back to `title` when
   *  missing (e.g. old saves, manually inserted nodes). */
  label?: string

  /** The decision question this beat asked before it spawned children.
   *  Set on the PARENT node when brainstorm fires from it.  Rendered in
   *  the Decision overlay above the option buttons.  Missing on old
   *  saves / hand-authored nodes → UI falls back to "What happens
   *  next?". */
  question?: string

  /** Verbatim brainstorm reply that spawned this beat's brainstorm
   *  children.  Stored on the PARENT node so every subsequent
   *  brainstorm call can feed the model its OWN prior turn unchanged —
   *  no reconstruction, no format drift.  That is how Gemini browser
   *  chat stays coherent across turns: the model always sees its
   *  earlier prose in its original voice. */
  rawBrainstorm?: string

  /** Rich scene description that was actually fed to the image model
   *  to render this beat.  Built by visual-prompt-builder (full
   *  English sentence with character descriptions, setting, action).
   *  The lightweight `imagePrompt` above carries only the short beat
   *  label/summary; `renderedImagePrompt` is what the *image* actually
   *  depicts, and it's what the NEXT beat's continuity hint should
   *  reference so Gemini carries the frame forward coherently. */
  renderedImagePrompt?: string

  worldPercent?: number
  status: NodeStatus

  /** who chose this branch when it became canon/current */
  decidedBy: Decider
  /** agent role name when decidedBy='agent' (e.g. 'hermes-writer') */
  decidedByAgent?: string

  /** was this node inserted mid-flow by the user? */
  inserted?: boolean

  /** coherence state relative to surrounding canon */
  staleState: StaleState
  /** if rewritten, keep the original for undo */
  originalBody?: string
  originalTitle?: string
  originalSummary?: string
  /** decision-verb label (e.g. "TAKES IT") captured before a rewrite so
   *  the compact bar can restore it on revert.  Cleared on rewrite apply
   *  because the old verb phrase stops matching the new beat. */
  originalLabel?: string
  /** pre-rewrite image prompt + url captured at stale/rewrite time so a
   *  revert restores the VISUAL too, not just the text.  Without these,
   *  the user sees reverted title with the rewrite's generated image —
   *  a visible semantic mismatch. */
  originalImagePrompt?: string
  originalImageUrl?: string

  /** id of the nearest `inserted: true` ancestor whose splice caused this
   *  node to go stale.  Set when insertBetween marks the canon
   *  descendant chain.  Reharmonize "retry" on a stale node uses this to
   *  run the cascade with the correct insert reference (not the stale
   *  node itself, which would compare the node against its own title). */
  insertCauseId?: string

  x: number
  y: number
}

export interface StoryEdgeMeta {
  id: string
  source: string
  target: string
  canon: boolean
  explored: boolean
}

export type AgentId =
  | 'brainstorm'
  | 'character'
  | 'conflict'
  | 'world'
  | 'critic'
  | 'writer'
  | 'judge'
  | 'director'
  | 'writer-assist'
  | 'consistency-critic'
  | 'scene-composer'
  | 'registry-lookup'
  | 'moderation-rewriter'
  | 'character-sheet'

export interface AgentEvent {
  id: string
  agent: AgentId
  model: string
  label: string
  text: string
  status: 'thinking' | 'streaming' | 'done' | 'error'
  startedAt: number
}

export type DecisionAction =
  | 'expand'
  | 'select'
  | 'insert'
  | 'remove_inserted'
  | 'keep_stale'
  | 'critique'
  | 'rewrite'
  | 'judge'
  | 'human_override'
  | 'seal'
  | 'compose_scenes'

export interface Decision {
  id: string
  action: DecisionAction
  targetNodeId: string
  decidedBy: Decider
  agentName?: string
  reason?: string
  score?: number
  beforeSnapshot?: Partial<StoryNode>
  afterSnapshot?: Partial<StoryNode>
  createdAt: number
}

// ---- Hermes payloads -------------------------------------------------------

export interface BranchSuggestion {
  title: string
  summary: string
  body: string
  imagePrompt: string
  mood: NodeMood
  tone: NodeTone
  worldPercent?: number
  /** Short Detroit-style answer tag for the Decision overlay.  Optional
   *  for backwards compatibility with older Hermes outputs. */
  label?: string
}

export interface ExpandResponse {
  branches: BranchSuggestion[]
  /** Skill-authored decision prompt ("Does he take the gauntlet?").
   *  Optional for back-compat — clients fall back to a generic prompt. */
  question?: string
}

export interface WriterAssistResponse {
  title: string
  summary: string
  body: string
  imagePrompt: string
  mood: NodeMood
  tone: NodeTone
  worldPercent: number
}

export type CritiqueVerdict = 'still_valid' | 'needs_rewrite' | 'must_delete'

export interface CritiqueResponse {
  verdict: CritiqueVerdict
  reason: string
  severity: number // 0..1
}

export interface RewriteResponse {
  title: string
  summary: string
  body: string
  imagePrompt: string
  mood: NodeMood
  reason: string
}

export interface JudgeResponse {
  approved: boolean
  score: number // 0..1
  reason: string
}

// ---- scene composer -------------------------------------------------------

/**
 * A Scene groups a cluster of narrative beats that share setting / motif /
 * emotional pressure. The scene-composer agent produces these by reading the
 * whole tree holistically — it may group across different parents when the
 * motif dominates, so scenes are NOT just "parent + direct children".
 */
export interface Scene {
  id: string
  label: string
  motif?: string
  actNumber?: 1 | 2 | 3
  nodeIds: string[]
  createdAt: number
  decidedByAgent?: string
}

export interface SceneComposeResponse {
  scenes: {
    label: string
    motif?: string
    actNumber?: 1 | 2 | 3
    nodeIds: string[]
  }[]
}
