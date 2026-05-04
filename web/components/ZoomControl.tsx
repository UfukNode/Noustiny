'use client'

import { Plus, Minus, Maximize } from 'lucide-react'
import { useReactFlow, useViewport } from '@xyflow/react'
import { useStory } from '@/lib/store'

export function ZoomControl() {
  const flow = useReactFlow()
  const nodes = useStory((s) => s.nodes)
  // `useViewport` re-renders this component whenever the user pans or zooms
  // (scroll-wheel zoom, pinch, or fitView). `flow.getZoom()` returned a stale
  // value because nothing else in the component tree subscribed to viewport
  // changes — the percentage label never ticked.
  const { zoom } = useViewport()

  const zoomIn = () => flow.zoomIn({ duration: 220 })
  const zoomOut = () => flow.zoomOut({ duration: 220 })
  const fit = () => flow.fitView({ padding: 0.14, duration: 400, maxZoom: 0.95, minZoom: 0.25 })

  const zoomLevel = Math.round(zoom * 100)

  // Invert-on-hover: idle dark + light text, hover cyan fill + dark text.
  // Same pattern as the agent primaries — the hover is a solid surface flip
  // so it stays visible on any backdrop preset.
  const btn =
    'flex h-[30px] items-center justify-center transition-colors'
  const btnStyle = { color: 'rgba(230,236,244,0.85)' }
  const hoverOn = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.color = '#0a0d12'
    e.currentTarget.style.background = '#4fc3f7'
  }
  const hoverOff = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.color = 'rgba(230,236,244,0.85)'
    e.currentTarget.style.background = 'transparent'
  }

  return (
    <div
      className="pointer-events-auto flex items-stretch border border-[var(--line)] backdrop-blur"
      style={{ background: 'rgba(10,13,18,0.97)' }}
    >
      <button
        type="button"
        onClick={zoomOut}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
        className={`${btn} w-[30px] border-r border-[var(--line)]`}
        style={btnStyle}
        title={`Zoom out (${nodes.size} nodes)`}
      >
        <Minus size={12} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        onClick={fit}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
        className={`${btn} gap-1.5 border-r border-[var(--line)] px-2.5 font-mono text-[9px] uppercase tracking-[0.22em]`}
        style={btnStyle}
        title="Fit all nodes"
      >
        <Maximize size={10} strokeWidth={1.8} />
        <span className="tabular-nums">{zoomLevel}%</span>
      </button>
      <button
        type="button"
        onClick={zoomIn}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
        className={`${btn} w-[30px]`}
        style={btnStyle}
        title="Zoom in"
      >
        <Plus size={12} strokeWidth={1.8} />
      </button>
    </div>
  )
}
