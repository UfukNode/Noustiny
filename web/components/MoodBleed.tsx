'use client'

import { useMemo } from 'react'
import { useStory, selectCurrentNode } from '@/lib/store'
import type { NodeMood } from '@/lib/types'

/**
 * Subtle mood vignette — a fixed radial-gradient behind the canvas
 * that bleeds the current beat's emotional colour across the viewport
 * at ~8% opacity.  Swaps smoothly (700ms) when the user walks to a new
 * beat so the room FEELS the story breathing.
 *
 * Kept gentle on purpose: we want "the canvas just got warmer" not
 * "the user is staring at a red filter".
 */

const MOOD_BG_TINT: Record<NodeMood, string> = {
  neutral:   'rgba(90, 110, 140, 0.00)',
  hopeful:   'rgba(233, 193, 107, 0.10)',
  tense:     'rgba(255, 159, 64, 0.09)',
  danger:    'rgba(231, 76, 60, 0.10)',
  climax:    'rgba(255, 211, 120, 0.14)',
  quiet:     'rgba(100, 160, 220, 0.08)',
  discovery: 'rgba(167, 139, 250, 0.09)',
}

export function MoodBleed() {
  const mode = useStory((s) => s.mode)
  const current = useStory(selectCurrentNode)

  const tint = useMemo(() => {
    if (!current) return MOOD_BG_TINT.neutral
    return MOOD_BG_TINT[current.mood] ?? MOOD_BG_TINT.neutral
  }, [current])

  if (mode !== 'canvas') return null

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0"
      style={{
        zIndex: 0,
        transition: 'background 700ms ease',
        background: `radial-gradient(ellipse at 50% 58%, ${tint} 0%, transparent 70%)`,
      }}
    />
  )
}
