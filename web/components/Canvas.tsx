'use client'

import { useEffect, useCallback, useRef } from 'react'
import {
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  useReactFlow,
} from '@xyflow/react'
import { Crosshair } from 'lucide-react'
import { useShallow } from 'zustand/shallow'
import { useStory, selectCanonPath } from '@/lib/store'
import type { StoryNode } from '@/lib/types'
import { nodeTypes } from './StoryNode'
import { edgeTypes } from './StoryEdge'
import { nodeHeight, variantOf } from '@/lib/layout'

function toReactFlow(
  nodes: Map<string, StoryNode>,
  canonSet: Set<string>,
): { rfNodes: Node[]; rfEdges: Edge[] } {
  const rfNodes: Node[] = []
  const rfEdges: Edge[] = []
  nodes.forEach((n) => {
    const h = nodeHeight(n)
    rfNodes.push({
      id: n.id,
      type: 'story',
      // layout stores y as the vertical midpoint; RF wants top-left.
      position: { x: n.x, y: n.y - h / 2 },
      data: { node: n },
      draggable: false,
      connectable: false,
      selectable: true,
    })
    if (n.parentId) {
      const parent = nodes.get(n.parentId)
      const canon = canonSet.has(n.id) && canonSet.has(n.parentId)
      const explored =
        !canon &&
        (parent?.status === 'visited' || parent?.status === 'canon' || parent?.status === 'current') &&
        (n.status === 'visited' || n.status === 'canon' || n.status === 'current')
      rfEdges.push({
        id: `e-${n.parentId}-${n.id}`,
        source: n.parentId,
        target: n.id,
        type: 'story',
        data: { canon, explored },
        className: canon ? 'canon' : explored ? 'explored' : 'unvisited',
        // Default z-order: edges render below nodes. With `min-w-0` on the bar
        // and handle offsets tight to the silhouette, the source stub already
        // exits past the chip's visible edge, so we don't need to elevate the
        // edge above nodes — and doing so would cover the + label button with
        // the SVG path, breaking clicks on it.
      })
    }
  })
  return { rfNodes, rfEdges }
}

function InnerCanvas() {
  const nodes = useStory((s) => s.nodes)
  const currentId = useStory((s) => s.currentId)
  const rootId = useStory((s) => s.rootId)
  const canonPath = useStory(useShallow(selectCanonPath))
  const setSelected = useStory((s) => s.setSelected)
  const setCurrent = useStory((s) => s.setCurrent)
  const flow = useReactFlow()
  const hasFitRef = useRef(false)

  // Recompute on every render. toReactFlow is cheap for small trees and
  // skipping the memo means that when we iterate on node/edge visuals during
  // development, HMR propagates without needing a hard reload or cache clear.
  const canonSet = new Set(canonPath)
  const { rfNodes, rfEdges } = toReactFlow(nodes, canonSet)

  // Initial focus on first mount — center on the active beat (mirrors
  // the minimap's crosshair button) instead of fitting the whole tree.
  // This is the right behaviour for save-load resume: the user expects
  // to land back on the beat they were on, not zoomed all the way out
  // to "see everything."  Falls back to fitView only if currentId is
  // somehow missing (defensive).  Fires once, then `hasFitRef` blocks
  // further auto-pans so the user isn't fought when they navigate.
  useEffect(() => {
    if (hasFitRef.current) return
    if (rfNodes.length === 0) return
    const t = setTimeout(() => {
      const s = useStory.getState()
      const cur = s.nodes.get(s.currentId)
      if (cur) {
        const isCheckpoint = variantOf(cur) === 'checkpoint'
        const anchorX = cur.x + (isCheckpoint ? 156 : 136)
        flow.setCenter(anchorX, cur.y, { zoom: 0.9, duration: 600 })
      } else {
        flow.fitView({ padding: 0.14, duration: 600, maxZoom: 0.95, minZoom: 0.25 })
      }
      hasFitRef.current = true
    }, 120)
    return () => clearTimeout(t)
  }, [rfNodes.length, flow])

  // When the user jumps to a new node OR the current node spawns new
  // children (auto-ask brainstorm finishes and its options appear to
  // the right), ease the camera toward the current node so the fresh
  // branches come into view.  Without the childrenIds dep the camera
  // would stay pinned on the parent and the new siblings would land
  // off-screen, forcing a manual pan.
  const currentChildCount = nodes.get(currentId)?.childrenIds.length ?? 0
  useEffect(() => {
    if (!hasFitRef.current) return
    const cur = nodes.get(currentId)
    if (!cur) return
    const isCheckpoint = variantOf(cur) === 'checkpoint'
    const anchorX = cur.x + (isCheckpoint ? 156 : 136)
    flow.setCenter(anchorX, cur.y, { zoom: 0.8, duration: 650 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, currentChildCount, rootId])

  const onPaneClick = useCallback(() => setSelected(null), [setSelected])
  // RF-level click handler as a safety net: with elementsSelectable=false,
  // motion.div onClick inside the custom node can be swallowed on some RF
  // code paths. Binding the nav here guarantees every click on a node —
  // regardless of which inner element receives it — becomes setCurrent.
  const onNodeClick = useCallback(
    (_e: unknown, rfNode: Node) => setCurrent(rfNode.id),
    [setCurrent],
  )

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onPaneClick={onPaneClick}
      onNodeClick={onNodeClick}
      proOptions={{ hideAttribution: true }}
      minZoom={0.15}
      maxZoom={2}
      zoomOnScroll
      zoomOnPinch
      zoomOnDoubleClick={false}
      selectionOnDrag={false}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      fitView={false}
    >
      {/* Backdrop is rendered viewport-fixed by <DbhBackdrop /> outside
          React Flow (see app/page.tsx) so it never participates in pan/
          zoom — exactly like the static reference HTML.  React Flow's
          own <Background> would translate with the surface, which we
          don't want. */}
      {/* MiniMap wrapped in a Panel so we can overlay our own chrome:
          a focus button at top-left (re-centers on the current beat)
          and a faded "MAP" label at bottom-right (sits inside the
          minimap rather than as an external tooltip). */}
      <Panel position="top-right" style={{ marginTop: 72 }}>
        <div
          className="flex flex-col border"
          style={{
            background: 'rgba(10,13,18,0.96)',
            borderColor: 'var(--line)',
            boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
          }}
        >
          {/* Header bar — title + focus button.  Lives outside the
              minimap canvas so the minimap's mask never competes with
              the chrome typography. */}
          <div
            className="flex items-center justify-between gap-2 border-b px-2 py-1.5"
            style={{ borderColor: 'var(--line)', background: 'rgba(10,13,18,0.92)' }}
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  const cur = nodes.get(currentId)
                  if (!cur) return
                  const isCheckpoint = variantOf(cur) === 'checkpoint'
                  const anchorX = cur.x + (isCheckpoint ? 156 : 136)
                  flow.setCenter(anchorX, cur.y, { zoom: 1.0, duration: 600 })
                }}
                data-cursor="pointer"
                title="Center on current beat"
                className="flex h-5 w-5 items-center justify-center border border-[var(--line)] bg-[rgba(10,13,18,0.85)] text-[var(--ink-dim)] transition-colors hover:border-[var(--cyan)] hover:bg-[rgba(79,195,247,0.1)] hover:text-[var(--cyan)]"
                style={{ borderRadius: 2 }}
              >
                <Crosshair size={10} strokeWidth={1.7} />
              </button>
            </div>
            <span
              className="font-display text-[10.5px] font-semibold uppercase tracking-[0.34em]"
              style={{ color: '#4fc3f7' }}
            >
              mini map
            </span>
          </div>
          <MiniMap
            pannable
            zoomable
            maskColor="rgba(10,13,18,0.82)"
            ariaLabel={null}
            nodeColor={(n) => {
              const node = (n.data as { node: StoryNode }).node
              if (node.status === 'current') return '#e9c16b'
              if (node.status === 'canon') return '#4fc3f7'
              if (node.status === 'visited') return '#64748b'
              if (node.status === 'generating') return '#4fc3f7'
              return '#2a3140'
            }}
            nodeStrokeWidth={0}
            // Position is a no-op once we own the Panel; pass empty
            // style so the React Flow default top-right doesn't fight
            // our wrapper's positioning.
            style={{ position: 'relative', margin: 0 }}
          />
        </div>
      </Panel>
    </ReactFlow>
  )
}

export function Canvas() {
  return <InnerCanvas />
}

export { ReactFlowProvider }
