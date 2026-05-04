/**
 * Save System — name-your-story persistence.
 *
 * Each save is a full snapshot of the Zustand tree (seed, nodes,
 * current selection, character registry, character portrait refs,
 * decisions, scenes, agent policy, background).  Primary store is the
 * browser's localStorage; an opportunistic filesystem mirror writes the
 * same body to web/.saves/<id>.json via /api/saves so saves survive
 * port changes (localStorage is keyed by origin), browser cache wipes,
 * and cross-browser sessions.  The mirror is fire-and-forget — UI never
 * blocks on it — and the hydrate-from-disk path on app boot pulls any
 * fs-only saves back into localStorage so the saved-stories list looks
 * the same regardless of which port the dev server happens to be on.
 *
 * Edge cases handled:
 *  - Map values (nodes, scenes) round-tripped as [key, value][] arrays
 *  - Schema version prefixed so future changes can migrate without
 *    wiping user saves
 *  - Each save has its own key; corruption in one save never poisons
 *    the index
 *  - Delete removes both the body and its index entry atomically
 *  - fs mirror failures are logged but never surface as errors to the
 *    UI — the save still lives in localStorage
 *
 * Not handled (deliberate scope cut for the hackathon):
 *  - Cross-device sync (fs mirror is on the dev box, not the cloud)
 *  - Image cache survival: saves refer to /cache/images/*.png paths
 *    on disk.  If the public/cache directory is cleared the saved
 *    story will fall back to the placeholder.
 */

import type {
  AgentEvent, BackgroundPreset, Decision, Scene, StoryNode,
} from './types'
import type { ImagePolicy } from './story-copyright-detector'

// Schema version: bump whenever StorySnapshot shape changes.  loadSave
// refuses saves from future versions and silently migrates older ones
// where possible.
export const SAVE_SCHEMA_VERSION = 1

const INDEX_KEY = 'noustiny:saves:index'
const SAVE_PREFIX = 'noustiny:save:'

export interface StorySnapshot {
  version: number
  seed: string
  rootId: string
  currentId: string
  // Maps serialised as [k, v][] arrays.
  nodes: Array<[string, StoryNode]>
  scenes: Array<[string, Scene]>
  characters: Record<string, string>
  characterRefs: Record<string, string>
  decisions: Decision[]
  agents: AgentEvent[]
  background: BackgroundPreset
  imagePolicy: ImagePolicy
}

export interface SavedStoryMeta {
  id: string
  name: string
  seedPreview: string
  thumbnail?: string
  nodeCount: number
  createdAt: number
  updatedAt: number
}

export interface SavedStoryFull extends SavedStoryMeta {
  snapshot: StorySnapshot
}

// ---- internals -----------------------------------------------------------

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch { return null }
}

function readIndex(): SavedStoryMeta[] {
  const s = storage()
  if (!s) return []
  const raw = s.getItem(INDEX_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as SavedStoryMeta[]
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function writeIndex(index: SavedStoryMeta[]): void {
  const s = storage()
  if (!s) return
  try { s.setItem(INDEX_KEY, JSON.stringify(index)) } catch {
    // Quota probably hit.  Best we can do is surface it — UI can prompt
    // the user to delete old saves.
    throw new Error('Save failed: localStorage quota exhausted. Delete an old save first.')
  }
}

function makeSaveId(): string {
  // Short, readable, sortable by time.
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${ts}-${rand}`
}

function previewOf(seed: string): string {
  const clean = (seed ?? '').trim().replace(/\s+/g, ' ')
  return clean.length <= 120 ? clean : clean.slice(0, 117) + '…'
}

// ---- public API ----------------------------------------------------------

/** Serialise the active Zustand state into a snapshot that can be
 *  written to localStorage.  Caller provides the fields it has so the
 *  save-system stays decoupled from the store's internals. */
export function snapshotFromState(state: {
  seed: string
  rootId: string
  currentId: string
  nodes: Map<string, StoryNode>
  scenes: Map<string, Scene>
  characters: Record<string, string>
  characterRefs: Record<string, string>
  decisions: Decision[]
  agents: AgentEvent[]
  background: BackgroundPreset
  imagePolicy: ImagePolicy
}): StorySnapshot {
  return {
    version: SAVE_SCHEMA_VERSION,
    seed: state.seed,
    rootId: state.rootId,
    currentId: state.currentId,
    nodes: Array.from(state.nodes.entries()),
    scenes: Array.from(state.scenes.entries()),
    characters: { ...state.characters },
    characterRefs: { ...state.characterRefs },
    decisions: [...state.decisions],
    agents: [...state.agents],
    background: state.background,
    imagePolicy: state.imagePolicy,
  }
}

/** Write a new save OR update an existing one (by id).  Returns the
 *  meta entry written to the index so the UI can refresh.  Throws on
 *  quota errors so the caller can surface a toast. */
export function saveStory(opts: {
  name: string
  snapshot: StorySnapshot
  id?: string
}): SavedStoryMeta {
  const s = storage()
  if (!s) throw new Error('Save failed: localStorage unavailable')

  const id = opts.id ?? makeSaveId()
  const now = Date.now()
  // Root node's cached image if any — used as the saved-story card's thumbnail.
  const rootEntry = opts.snapshot.nodes.find(([k]) => k === opts.snapshot.rootId)
  const thumbnail = rootEntry?.[1]?.imageUrl && rootEntry[1].imageUrl.startsWith('/cache/')
    ? rootEntry[1].imageUrl
    : undefined

  const existing = readIndex()
  const prior = existing.find((e) => e.id === id)
  const meta: SavedStoryMeta = {
    id,
    name: opts.name.trim() || 'Untitled',
    seedPreview: previewOf(opts.snapshot.seed),
    thumbnail,
    nodeCount: opts.snapshot.nodes.length,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  }

  // Write body first.  If this fails (quota) we never touch the index —
  // so the user is left in a consistent state.
  try {
    s.setItem(SAVE_PREFIX + id, JSON.stringify(opts.snapshot))
  } catch {
    throw new Error('Save failed: localStorage quota exhausted. Delete an old save first.')
  }

  const nextIndex = prior
    ? existing.map((e) => (e.id === id ? meta : e))
    : [meta, ...existing]
  writeIndex(nextIndex)
  // Mirror to filesystem.  Fire-and-forget — the save already lives in
  // localStorage, so a fs failure (offline, permission, dev server
  // restarting) must not block the UI or surface as a user-facing error.
  void mirrorWriteToDisk(meta, opts.snapshot)
  return meta
}

/** List all saves, newest-first by updatedAt. */
export function listSaves(): SavedStoryMeta[] {
  const index = readIndex()
  return [...index].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Load a save by id.  Returns null if the save body is missing
 *  (index corruption, manual localStorage edit) or the schema version
 *  is newer than we know how to read. */
export function loadSave(id: string): SavedStoryFull | null {
  const s = storage()
  if (!s) return null
  const meta = readIndex().find((e) => e.id === id)
  if (!meta) return null
  const raw = s.getItem(SAVE_PREFIX + id)
  if (!raw) return null
  let snapshot: StorySnapshot
  try {
    snapshot = JSON.parse(raw) as StorySnapshot
  } catch {
    return null
  }
  if (typeof snapshot?.version !== 'number' || snapshot.version > SAVE_SCHEMA_VERSION) {
    return null
  }
  // Backward-compatible defaults for missing fields in older saves.
  const normalised: StorySnapshot = {
    ...snapshot,
    nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes : [],
    scenes: Array.isArray(snapshot.scenes) ? snapshot.scenes : [],
    characters: snapshot.characters ?? {},
    characterRefs: snapshot.characterRefs ?? {},
    decisions: Array.isArray(snapshot.decisions) ? snapshot.decisions : [],
    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
  }
  return { ...meta, snapshot: normalised }
}

/** Delete both the body and the index entry.  Silent no-op if id
 *  doesn't exist. */
export function deleteSave(id: string): void {
  const s = storage()
  if (!s) return
  const index = readIndex()
  if (!index.some((e) => e.id === id)) return
  try { s.removeItem(SAVE_PREFIX + id) } catch { /* ignore */ }
  writeIndex(index.filter((e) => e.id !== id))
  // Mirror delete to filesystem (fire-and-forget — see saveStory).
  void mirrorDeleteFromDisk(id)
}

// ---- filesystem mirror ---------------------------------------------------

/**
 * Hydrate localStorage from the filesystem mirror.
 *
 * Called on app boot so that switching ports / browsers / refreshing a
 * cleared cache doesn't make the user think their saves vanished.  We
 * GET /api/saves and write any fs-only entries straight into
 * localStorage — entries already present (matched by id) are left alone
 * to avoid clobbering newer in-memory edits.
 *
 * Returns the number of entries that were pulled in (0 on error or no-op),
 * primarily for logging — UIs that show a saves list should re-read
 * `listSaves()` afterwards rather than rely on the return value.
 */
export async function hydrateSavesFromDisk(): Promise<number> {
  const s = storage()
  if (!s) return 0
  let resp: Response
  try {
    resp = await fetch('/api/saves', { cache: 'no-store' })
  } catch {
    return 0
  }
  if (!resp.ok) return 0
  let body: { saves?: unknown[] }
  try {
    body = await resp.json()
  } catch {
    return 0
  }
  const saves = Array.isArray(body.saves) ? body.saves : []
  if (saves.length === 0) return 0

  const localIndex = readIndex()
  const knownIds = new Set(localIndex.map((e) => e.id))
  let added = 0
  const newMetas: SavedStoryMeta[] = []
  for (const entry of saves) {
    if (!entry || typeof entry !== 'object') continue
    const meta = (entry as { meta?: SavedStoryMeta }).meta
    const snapshot = (entry as { snapshot?: StorySnapshot }).snapshot
    if (!meta || typeof meta.id !== 'string') continue
    if (knownIds.has(meta.id)) continue
    if (!snapshot || typeof snapshot !== 'object') continue
    if (typeof snapshot.version !== 'number' || snapshot.version > SAVE_SCHEMA_VERSION) continue
    try {
      s.setItem(SAVE_PREFIX + meta.id, JSON.stringify(snapshot))
      newMetas.push(meta)
      added += 1
    } catch {
      // Quota — stop pulling more entries.  The user will already have
      // localStorage saves; the disk copy is the safety net, not the
      // primary store, so partial hydrate is acceptable.
      break
    }
  }
  if (newMetas.length > 0) {
    // Merge new metas into the index, then re-sort newest-first.
    const merged = [...newMetas, ...localIndex].sort((a, b) => b.updatedAt - a.updatedAt)
    try { writeIndex(merged) } catch { /* swallow — see saveStory */ }
  }
  return added
}

function mirrorWriteToDisk(meta: SavedStoryMeta, snapshot: StorySnapshot): Promise<void> {
  // Fire-and-forget.  Errors are caught and logged so the dev tab shows
  // a clear breadcrumb, but they never bubble up to the caller.
  return fetch('/api/saves', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meta, snapshot }),
    keepalive: true,
  })
    .then((r) => {
      if (!r.ok) console.warn(`[saves] mirror POST ${meta.id} failed: ${r.status}`)
    })
    .catch((e) => console.warn(`[saves] mirror POST ${meta.id} error:`, e))
}

function mirrorDeleteFromDisk(id: string): Promise<void> {
  return fetch(`/api/saves/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true })
    .then((r) => {
      if (!r.ok && r.status !== 404) {
        console.warn(`[saves] mirror DELETE ${id} failed: ${r.status}`)
      }
    })
    .catch((e) => console.warn(`[saves] mirror DELETE ${id} error:`, e))
}

/** Find a save id by exact name match (case-insensitive).  Used by the
 *  save modal to offer "overwrite vs. new name" when the user picks
 *  a name that's already in use. */
export function findSaveByName(name: string): SavedStoryMeta | null {
  const lc = name.trim().toLowerCase()
  if (!lc) return null
  const match = readIndex().find((e) => e.name.toLowerCase() === lc)
  return match ?? null
}

/**
 * Suggest a default save name for the current story.
 *
 * Shape: ``<PREFIX>-SAVE-<N>`` — where PREFIX is the franchise slug's
 * first segment uppercased (``avatar-airbender`` → ``AVATAR``), or the
 * first distinctive word of the seed when no franchise was detected,
 * or ``STORY`` as a last-resort fallback.  N auto-increments off the
 * highest existing save that shares the same prefix, so resaving the
 * same world yields AVATAR-SAVE-1, AVATAR-SAVE-2, AVATAR-SAVE-3…
 *
 * Deliberately name-only: doesn't overwrite user input once they've
 * edited the field; just seeds a sensible default on modal open.
 */
export function suggestDefaultSaveName(opts: {
  franchise: string | null
  seed: string
}): string {
  const prefix = derivePrefix(opts.franchise, opts.seed)
  const pattern = new RegExp(`^${escapeForRegExp(prefix)}-SAVE-(\\d+)$`, 'i')
  let maxN = 0
  for (const entry of readIndex()) {
    const m = entry.name.trim().match(pattern)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n > maxN) maxN = n
    }
  }
  return `${prefix}-SAVE-${maxN + 1}`
}

function derivePrefix(franchise: string | null, seed: string): string {
  if (franchise) {
    const head = franchise.split('-')[0]
    if (head) return head.toUpperCase()
  }
  // Walk the seed for the first word ≥ 4 chars that isn't a stopword.
  // This catches the story's subject ("aang", "detective", "titan")
  // instead of leading with "the", "a", "in", etc.
  const STOP = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'of',
    'to', 'for', 'with', 'from', 'by', 'is', 'was', 'are', 'were',
    'be', 'been', 'being', 'this', 'that', 'these', 'those', 'it',
    'its', 'his', 'her', 'him', 'she', 'they', 'them', 'their',
    'when', 'while', 'after', 'before',
  ])
  const tokens = (seed ?? '').toLowerCase().match(/[a-z][a-z'-]*/g) ?? []
  for (const t of tokens) {
    const clean = t.replace(/['-]/g, '')
    if (clean.length >= 4 && !STOP.has(clean)) {
      return clean.toUpperCase().slice(0, 12)
    }
  }
  return 'STORY'
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
