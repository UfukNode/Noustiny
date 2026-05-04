import type { NodeVariant, StoryNode } from './types'

/**
 * Detroit-style horizontal tree layout with subtree-size reservation.
 *
 * Each subtree takes `max(selfHeight, sum(childSubtreeHeights))` vertical space
 * so a big checkpoint parent never collides with its compact-bar siblings.
 */

// Horizontal distance between columns. Generous enough that each edge has
// room for a long source stub (node → bracket spine) AND a long target stub
// (spine → target) with the + button floating on the target stub without
// covering the line entirely.
// Must exceed CHECKPOINT_WIDTH (480) by ~200px so the bracket spine and the
// + button get breathing room — with a tight gap the edges are invisible.
export const COL_WIDTH = 680
export const V_GAP = 34

// Bigger current checkpoint so the Detroit decision overlay can sit on
// the right third of the image without swallowing the scene.  Image
// goes 150→240 tall, card 312→480 wide.  Compact siblings stay small so
// the hierarchy "ONE hero beat at a time" reads clearly.
export const CHECKPOINT_HEIGHT = 320
// Compact bar now stacks a small thumbnail (80px) above the ribbon (38px)
// + a 4px gap + up to 24px provenance strip = ~146 visual, ~130 tight.
// The slot reservation still uses CHECKPOINT_HEIGHT (see reservedHeight) so
// layout never collides — this only affects treeBounds / handle offsets.
export const COMPACT_HEIGHT = 132
// Ribbon midline offset from the top of the compact card (thumb + gap +
// half-ribbon).  Used by the source/target handles so edges enter/exit at
// the title ribbon, not inside the thumbnail.
export const COMPACT_RIBBON_Y = 80 + 4 + 19
export const CHECKPOINT_WIDTH = 480
export const COMPACT_WIDTH = 272

/** Horizontal gap between columns (derived) — edges live inside this lane. */
export const COL_GAP = COL_WIDTH - CHECKPOINT_WIDTH

export function variantOf(n: Pick<StoryNode, 'status' | 'parentId' | 'inserted'>): NodeVariant {
  // The root beat is always rendered as a checkpoint — it's the
  // story's opening image, the visual anchor the rest of the tree
  // hangs off of.  Beyond that, the single node the viewer is
  // currently inhabiting (current / generating) also gets the big
  // image-tile treatment.  Everything else is a compact Detroit
  // choice bar.
  //
  // Exception: an inserted SHELL (generating + inserted) is about to
  // become a sibling of the existing compact children — rendering it
  // checkpoint-sized during its weaving state would pop it out of the
  // sibling column and read as a totally different UI object.  Keep
  // shells compact so the placeholder visually matches its final form.
  if (n.parentId === null) return 'checkpoint'
  if (n.status === 'generating' && n.inserted) return 'compact'
  if (n.status === 'current' || n.status === 'generating') return 'checkpoint'
  return 'compact'
}

export function nodeHeight(n: StoryNode): number {
  return variantOf(n) === 'checkpoint' ? CHECKPOINT_HEIGHT : COMPACT_HEIGHT
}

export function nodeWidth(n: StoryNode): number {
  return variantOf(n) === 'checkpoint' ? CHECKPOINT_WIDTH : COMPACT_WIDTH
}

/**
 * Height to RESERVE for a node in layout, independent of its current variant.
 *
 * ANY node — leaf or interior — can be promoted to `current` (and hence
 * checkpoint-sized) by a click, so we reserve a full CHECKPOINT_HEIGHT slot
 * uniformly for every node. The cost is a bit of extra vertical whitespace
 * around compact bars; the benefit is that clicking any node never causes
 * a sibling's visible checkpoint card to overflow into a neighbour's slot.
 */
function reservedHeight(_n: StoryNode): number {
  return CHECKPOINT_HEIGHT
}

function subtreeHeight(id: string, nodes: Map<string, StoryNode>): number {
  const n = nodes.get(id)
  if (!n) return 0
  const ownH = reservedHeight(n)
  if (n.childrenIds.length === 0) return ownH
  const childrenTotal = n.childrenIds.reduce((sum, cid, i) => {
    return sum + subtreeHeight(cid, nodes) + (i > 0 ? V_GAP : 0)
  }, 0)
  return Math.max(ownH, childrenTotal)
}

function placeSubtree(id: string, nodes: Map<string, StoryNode>, yTop: number): void {
  const n = nodes.get(id)
  if (!n) return
  const myH = subtreeHeight(id, nodes)

  if (n.childrenIds.length === 0) {
    n.y = yTop + myH / 2
    return
  }

  const childrenHeight = n.childrenIds.reduce((sum, cid, i) => {
    return sum + subtreeHeight(cid, nodes) + (i > 0 ? V_GAP : 0)
  }, 0)
  let cursor = yTop + (myH - childrenHeight) / 2

  for (const cid of n.childrenIds) {
    const ch = subtreeHeight(cid, nodes)
    placeSubtree(cid, nodes, cursor)
    cursor += ch + V_GAP
  }

  // Parent sits at the vertical midpoint of its whole slot so the big
  // checkpoint card visually centers over its compact-bar children.
  n.y = yTop + myH / 2
}

export function layoutTree(nodes: Map<string, StoryNode>, rootId: string): void {
  const root = nodes.get(rootId)
  if (!root) return
  placeSubtree(rootId, nodes, 0)
  nodes.forEach((n) => {
    n.x = n.depth * COL_WIDTH
  })
}

/**
 * The canon line is the chain from the CURRENT node back to the root.
 *
 * Walking up via `parentId` (rather than down via status tags) means that
 * switching siblings instantly rewrites canon — siblings never linger as
 * 'canon' after being navigated away from. The root-to-current ancestors
 * get canon status; everyone else drops back to visited/unvisited.
 */
export function canonPath(
  nodes: Map<string, StoryNode>,
  rootId: string,
  currentId?: string,
): string[] {
  // Prefer the store-provided currentId — it never flickers.  The
  // status-scan fallback is kept for call sites that only hand us
  // `nodes` (e.g. legacy migration) but it misses the transient
  // window when the current node is marked 'generating' during a
  // brainstorm, leaving the canon chain empty.  Trusting the explicit
  // id keeps the Detroit canon spine lit even while Hermes is
  // mid-weave on the tail.
  let startId: string | null = null
  if (currentId && nodes.has(currentId)) {
    startId = currentId
  } else {
    const viaStatus = Array.from(nodes.values()).find(
      (n) => n.status === 'current' || n.status === 'generating',
    )
    startId = viaStatus?.id ?? rootId
  }
  const path: string[] = []
  let cursor: string | null = startId
  while (cursor) {
    path.unshift(cursor)
    const n = nodes.get(cursor)
    cursor = n?.parentId ?? null
  }
  return path
}

export function treeBounds(nodes: Map<string, StoryNode>): {
  minX: number; minY: number; maxX: number; maxY: number
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  nodes.forEach((n) => {
    const h = nodeHeight(n)
    const w = nodeWidth(n)
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y - h / 2)
    maxX = Math.max(maxX, n.x + w)
    maxY = Math.max(maxY, n.y + h / 2)
  })
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX, minY, maxX, maxY }
}
