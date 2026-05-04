'use client'

import { Sun, Moon } from 'lucide-react'
import { useStory } from '@/lib/store'

/**
 * Theme toggle — dark ↔ light.  We dropped the multi-preset picker;
 * the canvas now has exactly one backdrop per theme (DbhBackdrop reads
 * the SVG asset matching the current theme).  The store still holds
 * `background` as the source of truth so persistence keeps working;
 * we just collapse it onto the two values that actually have art.
 */
export function BackgroundPicker() {
  const current = useStory((s) => s.background)
  const setBackground = useStory((s) => s.setBackground)
  const isLight = current === 'detroit-light'

  return (
    <button
      type="button"
      onClick={() => setBackground(isLight ? 'detroit-dark' : 'detroit-light')}
      title={isLight ? 'Switch to dark backdrop' : 'Switch to light backdrop'}
      className="flex h-9 items-center gap-2 border px-3 font-display text-[10px] uppercase tracking-[0.28em] backdrop-blur transition-colors"
      style={{
        background: 'rgba(10,13,18,0.97)',
        color: 'rgba(230,236,244,0.85)',
        borderColor: 'var(--line)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = '#4fc3f7'
        e.currentTarget.style.color = '#0a0d12'
        e.currentTarget.style.borderColor = '#4fc3f7'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(10,13,18,0.97)'
        e.currentTarget.style.color = 'rgba(230,236,244,0.85)'
        e.currentTarget.style.borderColor = 'var(--line)'
      }}
    >
      {isLight ? <Sun size={12} strokeWidth={1.5} /> : <Moon size={12} strokeWidth={1.5} />}
      {isLight ? 'day' : 'night'}
    </button>
  )
}
