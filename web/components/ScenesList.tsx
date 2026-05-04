'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  AnimatePresence, motion, useDragControls, type PanInfo,
} from 'framer-motion'
import { useReactFlow } from '@xyflow/react'
import { Layers, ChevronDown, Crosshair, GripVertical } from 'lucide-react'
import { useShallow } from 'zustand/shallow'
import { useStory } from '@/lib/store'
import type { Scene } from '@/lib/types'
import { nodeHeight, nodeWidth } from '@/lib/layout'

/**
 * Draggable scenes panel. Only the ⋮⋮ grip handle starts a drag (via
 * framer-motion's `useDragControls`), so hovering a row or clicking a button
 * never pulls the whole panel. Position is clamped to the viewport and
 * persisted in localStorage so a refresh keeps the panel where the user
 * parked it.
 */

const STORAGE_KEY = 'noustiny:scenesPanel:pos:v1'
const PANEL_WIDTH = 320
const PANEL_HEIGHT_RESERVE = 360

interface Pos { x: number; y: number }

function clampToViewport(pos: Pos): Pos {
  if (typeof window === 'undefined') return pos
  const maxX = Math.max(8, window.innerWidth - PANEL_WIDTH - 8)
  const maxY = Math.max(8, window.innerHeight - PANEL_HEIGHT_RESERVE - 8)
  return {
    x: Math.min(Math.max(8, pos.x), maxX),
    y: Math.min(Math.max(8, pos.y), maxY),
  }
}

function defaultPos(): Pos {
  if (typeof window === 'undefined') return { x: 24, y: 84 }
  return { x: window.innerWidth - PANEL_WIDTH - 24, y: 84 }
}

function loadPos(): Pos | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { x: number; y: number }
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    return clampToViewport(parsed)
  } catch {
    return null
  }
}

function savePos(pos: Pos): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pos))
  } catch { /* ignore quota */ }
}

const ACT_ACCENT: Record<1 | 2 | 3, string> = {
  1: '#4fc3f7',
  2: '#e9c16b',
  3: '#c7a7ff',
}
const FALLBACK_ACCENT = '#4fc3f7'

function accentFor(scene: Scene): string {
  if (scene.actNumber === 1 || scene.actNumber === 2 || scene.actNumber === 3) {
    return ACT_ACCENT[scene.actNumber]
  }
  return FALLBACK_ACCENT
}

function actRoman(n: 1 | 2 | 3 | undefined): string {
  if (n === 1) return 'I'
  if (n === 2) return 'II'
  if (n === 3) return 'III'
  return '—'
}

export function ScenesList() {
  const scenes = useStory(useShallow((s) => Array.from(s.scenes.values())))
  const hoveredSceneId = useStory((s) => s.hoveredSceneId)
  const setHoveredScene = useStory((s) => s.setHoveredScene)
  const currentId = useStory((s) => s.currentId)
  const nodes = useStory((s) => s.nodes)
  const flow = useReactFlow()
  const [collapsed, setCollapsed] = useState(false)
  const dragControls = useDragControls()

  const [pos, setPos] = useState<Pos | null>(null)

  useEffect(() => {
    setPos(loadPos() ?? defaultPos())
  }, [])

  useEffect(() => {
    if (!pos) return
    const onResize = () => {
      setPos((p) => (p ? clampToViewport(p) : p))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pos])

  const focusedByCurrent = useMemo(
    () => scenes.find((s) => s.nodeIds.includes(currentId)) ?? null,
    [scenes, currentId],
  )

  const onFit = (scene: Scene) => {
    const rf: { id: string; position: { x: number; y: number }; width: number; height: number }[] = []
    for (const id of scene.nodeIds) {
      const n = nodes.get(id)
      if (!n) continue
      const h = nodeHeight(n)
      const w = nodeWidth(n)
      rf.push({ id, position: { x: n.x, y: n.y - h / 2 }, width: w, height: h })
    }
    if (rf.length === 0) return
    flow.fitView({ nodes: rf, padding: 0.25, duration: 520, maxZoom: 1.1, minZoom: 0.35 })
  }

  const sorted = useMemo(() => {
    return [...scenes].sort((a, b) => {
      const av = a.actNumber ?? 9
      const bv = b.actNumber ?? 9
      if (av !== bv) return av - bv
      const an = nodes.get(a.nodeIds[0] ?? '')
      const bn = nodes.get(b.nodeIds[0] ?? '')
      return (an?.depth ?? 0) - (bn?.depth ?? 0)
    })
  }, [scenes, nodes])

  if (scenes.length === 0 || !pos) return null

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const next = clampToViewport({
      x: pos.x + info.offset.x,
      y: pos.y + info.offset.y,
    })
    setPos(next)
    savePos(next)
  }

  return (
    <motion.div
      drag
      dragMomentum={false}
      dragElastic={0}
      dragListener={false}
      dragControls={dragControls}
      // keying on position resets the motion transform after a programmatic
      // clamp (resize), so the panel snaps cleanly to the new spot instead
      // of drifting.
      key={`${pos.x},${pos.y}`}
      initial={{ x: pos.x, y: pos.y }}
      onDragEnd={onDragEnd}
      className="pointer-events-auto absolute left-0 top-0 z-10 w-[320px]"
      style={{ fontFamily: 'var(--font-display), system-ui, sans-serif' }}
    >
      <div
        className="border backdrop-blur"
        style={{
          background: 'rgba(10, 13, 18, 0.96)',
          borderColor: 'var(--line)',
          boxShadow: '0 20px 48px rgba(0,0,0,0.55)',
        }}
      >
        <div className="flex items-center">
          {/* Grip — ONLY this element starts a drag. Everything else in the
              panel (rows, crosshair buttons, chevron) is interactive without
              accidentally yanking the panel. */}
          <div
            onPointerDown={(e) => dragControls.start(e)}
            className="flex h-10 items-center justify-center px-2 transition-colors"
            style={{ cursor: 'grab', color: 'rgba(170,185,205,0.55)', touchAction: 'none' }}
            title="Drag to move"
            onMouseEnter={(e) => { e.currentTarget.style.color = '#4fc3f7' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(170,185,205,0.55)' }}
          >
            <GripVertical size={14} strokeWidth={1.7} />
          </div>

          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="flex flex-1 items-center gap-2 py-2.5 pr-3 text-left text-[10px] uppercase tracking-[0.32em] transition-colors"
            style={{ color: 'rgba(198, 210, 226, 0.82)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#4fc3f7' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(198, 210, 226, 0.82)' }}
          >
            <Layers size={12} strokeWidth={1.7} />
            <span className="flex-1">scenes</span>
            <span className="font-mono text-[9px] tracking-[0.24em]" style={{ color: '#c7a7ff' }}>
              {scenes.length}
            </span>
            <motion.span
              animate={{ rotate: collapsed ? -90 : 0 }}
              transition={{ duration: 0.18 }}
            >
              <ChevronDown size={12} strokeWidth={1.7} />
            </motion.span>
          </button>
        </div>

        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="border-t border-[var(--line)]">
                {sorted.map((scene) => {
                  const accent = accentFor(scene)
                  const isHovered = hoveredSceneId === scene.id
                  const isCurrent = focusedByCurrent?.id === scene.id
                  const active = isHovered || (!hoveredSceneId && isCurrent)
                  return (
                    <div
                      key={scene.id}
                      onMouseEnter={() => setHoveredScene(scene.id)}
                      onMouseLeave={() => setHoveredScene(null)}
                      className="group flex items-center gap-2.5 border-b border-[var(--line)] px-3 py-2.5 transition-colors last:border-b-0"
                      style={{
                        background: active ? `${accent}14` : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        className="inline-flex h-5 min-w-[22px] items-center justify-center font-mono text-[9px] font-semibold uppercase tracking-[0.22em]"
                        style={{
                          color: accent,
                          border: `1px solid ${accent}`,
                          background: 'rgba(10,13,18,0.6)',
                          padding: '0 5px',
                        }}
                      >
                        {actRoman(scene.actNumber)}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span
                          className="truncate text-[11px] font-semibold uppercase tracking-[0.22em]"
                          style={{ color: active ? accent : 'rgba(234,240,248,0.92)' }}
                        >
                          {scene.label}
                        </span>
                        <span
                          className="truncate font-mono text-[9px] tracking-[0.24em]"
                          style={{ color: 'rgba(198,210,226,0.6)' }}
                        >
                          {scene.motif ? `${scene.motif} · ` : ''}
                          {scene.nodeIds.length} node{scene.nodeIds.length === 1 ? '' : 's'}
                          {isCurrent ? ' · you are here' : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onFit(scene) }}
                        title="Frame this scene in the viewport"
                        className="flex h-6 w-6 items-center justify-center transition-colors"
                        style={{ color: 'rgba(198,210,226,0.6)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = accent }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(198,210,226,0.6)' }}
                      >
                        <Crosshair size={12} strokeWidth={1.8} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
