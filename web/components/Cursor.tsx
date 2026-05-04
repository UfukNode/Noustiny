'use client'
import { useEffect, useRef, useState } from 'react'

interface ThemePalette {
  baseGlowPx: number
  extraGlowPx: number
  glowColor: string
}

export default function Cursor() {
  const arrowRef = useRef<SVGSVGElement>(null)
  const arrowFillRef = useRef<SVGPathElement>(null)
  const arrowStrokeRef = useRef<SVGPathElement>(null)
  const handRef = useRef<SVGSVGElement>(null)
  const zoomRef = useRef<SVGSVGElement>(null)
  const [isDark, setIsDark] = useState(true)
  const themeRef = useRef<ThemePalette>({ baseGlowPx: 4, extraGlowPx: 10, glowColor: '#378ADD' })

  useEffect(() => {
    // Noustiny doesn't put a `.dark` class on <html>; the theme flips
    // light by setting `data-theme="light"` (or legacy `data-bg=
    // "detroit-light"`) on <body>.  Watch both attributes so the
    // cursor follows backdrop swaps live.
    const check = () => {
      const b = document.body
      const t = b.getAttribute('data-theme')
      const bg = b.getAttribute('data-bg')
      const isLight = t === 'light' || bg === 'detroit-light'
      setIsDark(!isLight)
    }
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'data-bg'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    let mx = 0, my = 0, cx = 0, cy = 0
    let mode: 'idle' | 'hover' | 'pointer' | 'zoom' = 'idle'
    let pressed = false
    let fillOp = 0
    let glowAmt = 0
    let scaleAmt = 1
    let raf = 0

    // Pointer events instead of mouse events: React Flow (and any other
    // surface using setPointerCapture for drag/pan) suppresses
    // mousemove during capture, which would freeze the cursor and let
    // it "snap back" on release.  pointermove keeps firing through the
    // capture, so the custom cursor tracks the real mouse all the way.
    const move = (e: PointerEvent) => { mx = e.clientX; my = e.clientY }
    const down = () => { pressed = true }
    const up = () => { pressed = false }

    // Matchers — kept on `closest()` so the rule applies to any wrapper
    // anywhere up the tree.
    //   zoom     → `data-cursor="zoom"` (image lightbox / inspect targets) —
    //              checked first so it wins over the surrounding hover card
    //   pointer  → semantic clickables + Tailwind `cursor-pointer` users
    //              + the explicit data-cursor="pointer" opt-in
    //   hover    → `data-cursor="hover"` (preview-style overlays, hover
    //              cards, draggable canvas nodes)
    const ZOOM_SEL = '[data-cursor="zoom"]'
    const POINTER_SEL =
      'a, button, [data-cursor="pointer"], [role="button"], ' +
      'input[type="button"], input[type="submit"], input[type="checkbox"], ' +
      'input[type="radio"], input[type="color"], input[type="range"], ' +
      'input[type="file"], select, summary, label[for], ' +
      '[class*="cursor-pointer"]'
    const HOVER_SEL = '[data-cursor="hover"]'

    const onOver = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      // Nearest `data-cursor` attribute wins.  This lets a child opt
      // OUT of an ancestor's data-cursor (e.g. "what happens next?"
      // choices live inside the image's data-cursor="zoom" wrapper but
      // declare data-cursor="pointer" on themselves to override).
      // Falls back to native button/anchor matchers only when nothing
      // up the tree has set a data-cursor at all.
      const cursorAttrEl = t.closest('[data-cursor]')
      const cursorAttr = cursorAttrEl?.getAttribute('data-cursor') ?? null

      if (cursorAttr === 'zoom') mode = 'zoom'
      else if (cursorAttr === 'pointer') mode = 'pointer'
      else if (cursorAttr === 'hover') mode = 'hover'
      else if (t.closest(POINTER_SEL)) mode = 'pointer'
      else if (t.closest(HOVER_SEL)) mode = 'hover'
      else mode = 'idle'

      if (arrowRef.current) arrowRef.current.style.opacity = (mode === 'pointer' || mode === 'zoom') ? '0' : '1'
      if (handRef.current) handRef.current.style.opacity = mode === 'pointer' ? '1' : '0'
      if (zoomRef.current) zoomRef.current.style.opacity = mode === 'zoom' ? '1' : '0'
    }

    // capture:true so we win over stopPropagation in app handlers, and
    // passive:true keeps scroll perf clean.
    window.addEventListener('pointermove', move, { capture: true, passive: true })
    window.addEventListener('pointerdown', down, { capture: true, passive: true })
    window.addEventListener('pointerup', up, { capture: true, passive: true })
    window.addEventListener('pointerover', onOver, { capture: true, passive: true })

    const tick = () => {
      cx += (mx - cx) * 0.22
      cy += (my - cy) * 0.22

      // Hover state — instead of darkening with fill we LIGHT UP: a
      // bigger drop-shadow blur, a punchier fill tint (cyan/blue, not
      // black), and a small scale pop.  Reads as "this thing is
      // selectable" without making the cursor murky on dark
      // backgrounds.
      const targetFill = mode === 'hover' ? 0.18 : 0
      fillOp += (targetFill - fillOp) * 0.2
      const targetGlow = mode === 'hover' ? 1 : 0
      glowAmt += (targetGlow - glowAmt) * 0.18
      const targetScale = pressed ? 0.88 : (mode === 'hover' ? 1.08 : 1)
      scaleAmt += (targetScale - scaleAmt) * 0.2

      if (arrowFillRef.current) arrowFillRef.current.setAttribute('fill-opacity', fillOp.toFixed(3))
      if (arrowStrokeRef.current) arrowStrokeRef.current.setAttribute('stroke-width', (1.5 + glowAmt * 0.6).toFixed(2))

      // Animate the drop-shadow on the SVG wrapper itself — a single
      // filter string that reads as a soft underglow at idle and a
      // strong cyan halo on hover.  Theme palette is mutated on
      // theme-flip via themeRef so the rAF loop sees the latest
      // colours without a re-bind.
      const { baseGlowPx, extraGlowPx, glowColor } = themeRef.current
      const blur = baseGlowPx + glowAmt * extraGlowPx
      const filter = `drop-shadow(0 0 ${blur.toFixed(1)}px ${glowColor})`

      if (arrowRef.current) {
        arrowRef.current.style.transform = `translate(${cx - 4}px, ${cy - 3}px) scale(${scaleAmt.toFixed(3)})`
        arrowRef.current.style.filter = filter
      }
      if (handRef.current) {
        handRef.current.style.transform = `translate(${cx - 16}px, ${cy - 4}px) scale(${scaleAmt.toFixed(3)})`
        handRef.current.style.filter = filter
      }
      if (zoomRef.current) {
        // Hot-spot: lens centre sits on the real pointer position so a
        // click lands precisely on what the lens "frames".  SVG is
        // rendered at 36px (vs 28px viewBox) so the lens centre at
        // viewBox (12, 12) lands at display (12*36/28, 12*36/28) ≈
        // (15.4, 15.4) from the SVG's top-left — translate offset
        // shifts the SVG so its lens centre coincides with (cx, cy).
        zoomRef.current.style.transform = `translate(${cx - 15}px, ${cy - 15}px) scale(${scaleAmt.toFixed(3)})`
        zoomRef.current.style.filter = filter
      }

      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move, { capture: true } as EventListenerOptions)
      window.removeEventListener('pointerdown', down, { capture: true } as EventListenerOptions)
      window.removeEventListener('pointerup', up, { capture: true } as EventListenerOptions)
      window.removeEventListener('pointerover', onOver, { capture: true } as EventListenerOptions)
    }
  }, [])

  const c = isDark
    ? { stroke: '#85B7EB', fill: '#85B7EB', handFill: 'rgba(55, 138, 221, 0.35)', glow: '#378ADD', baseGlowPx: 4,  extraGlowPx: 10 }
    : { stroke: '#185FA5', fill: '#185FA5', handFill: 'rgba(24, 95, 165, 0.18)', glow: 'rgba(24, 95, 165, 0.6)', baseGlowPx: 3, extraGlowPx: 8  }

  // Mirror the theme into the rAF-readable ref so the running animation
  // loop picks up the new glow palette without a remount.
  useEffect(() => {
    themeRef.current = {
      baseGlowPx: c.baseGlowPx,
      extraGlowPx: c.extraGlowPx,
      glowColor: c.glow,
    }
  }, [c.baseGlowPx, c.extraGlowPx, c.glow])

  const baseStyle: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0,
    pointerEvents: 'none', zIndex: 9999,
    transform: 'translate(-100px, -100px)',
    transition: 'opacity 0.15s',
  }

  return (
    <>
      <svg
        ref={arrowRef}
        width="32" height="32" viewBox="0 0 32 32"
        style={{ ...baseStyle, filter: `drop-shadow(0 0 ${c.baseGlowPx}px ${c.glow})` }}
      >
        <path ref={arrowFillRef} d="M 4 3 L 4 24 L 10 19 L 14 27 L 18 25 L 14 17 L 22 17 Z" fill={c.fill} fillOpacity="0"/>
        <path ref={arrowStrokeRef} d="M 4 3 L 4 24 L 10 19 L 14 27 L 18 25 L 14 17 L 22 17 Z" fill="none" stroke={c.stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
      </svg>

      <svg
        ref={handRef}
        width="32" height="36" viewBox="0 0 32 36"
        style={{ ...baseStyle, opacity: 0, filter: `drop-shadow(0 0 ${c.baseGlowPx}px ${c.glow})` }}
      >
        <path
          d="M 11 18 L 11 6 Q 11 4 13 4 Q 15 4 15 6 L 15 16 L 15 11 Q 15 9 17 9 Q 19 9 19 11 L 19 17 L 19 13 Q 19 11 21 11 Q 23 11 23 13 L 23 18 L 23 15 Q 23 13 25 13 Q 27 13 27 15 L 27 24 Q 27 30 22 32 L 16 32 Q 11 32 9 28 L 5 21 Q 4 19 6 18 Q 8 17 9 19 L 11 22 Z"
          fill={c.handFill} stroke={c.stroke} strokeWidth="1.5"
          strokeLinejoin="round" strokeLinecap="round"
        />
      </svg>

      {/* Magnifying-glass — fires on `data-cursor="zoom"` (image lightbox
       * targets).  Lens centre is the click hot-spot (see translate
       * cx-12, cy-12 in tick()), so the user clicks exactly the pixel
       * the lens frames.  The "+" inside reads as "zoom in" rather
       * than just "this is a magnifier".  Shares the same glow palette
       * as the arrow so theme flips are coherent. */}
      <svg
        ref={zoomRef}
        width="36" height="36" viewBox="0 0 28 28"
        style={{ ...baseStyle, opacity: 0, filter: `drop-shadow(0 0 ${c.baseGlowPx}px ${c.glow})` }}
      >
        {/* Black contour, slightly wider, drawn FIRST so the cyan
            strokes overlay it.  Reads as a thin halo that lifts the
            magnifier off any backdrop — solid cyan alone disappears
            on near-cyan image patches.  Same opacity in light/dark
            because black contour works on both. */}
        <circle cx="12" cy="12" r="7" fill="none"
                stroke="#000" strokeOpacity="0.55" strokeWidth="3.6" />
        <line x1="12" y1="9" x2="12" y2="15" stroke="#000"
              strokeOpacity="0.55" strokeWidth="3.6" strokeLinecap="round" />
        <line x1="9" y1="12" x2="15" y2="12" stroke="#000"
              strokeOpacity="0.55" strokeWidth="3.6" strokeLinecap="round" />
        <line x1="17.2" y1="17.2" x2="23" y2="23" stroke="#000"
              strokeOpacity="0.55" strokeWidth="4" strokeLinecap="round" />
        {/* cyan core */}
        <circle cx="12" cy="12" r="7" fill={c.fill} fillOpacity="0.10"
                stroke={c.stroke} strokeWidth="1.6" />
        <line x1="12" y1="9" x2="12" y2="15" stroke={c.stroke}
              strokeWidth="1.6" strokeLinecap="round" />
        <line x1="9" y1="12" x2="15" y2="12" stroke={c.stroke}
              strokeWidth="1.6" strokeLinecap="round" />
        <line x1="17.2" y1="17.2" x2="23" y2="23" stroke={c.stroke}
              strokeWidth="2" strokeLinecap="round" />
      </svg>
    </>
  )
}
