'use client'

import { useEffect, useRef } from 'react'
import type { AmbienceKind, AmbienceIntensity } from '@/lib/types'

/**
 * AmbienceLayer — canvas particle renderer for lightbox scenes.
 *
 * Pure client-side, no backend.  Takes a `kind` (what falls / drifts),
 * an `intensity` (how dense) and an `accent` colour (optional — used
 * by firefly / ember glows).  Fills its parent element, so the caller
 * controls scope by placing it inside the image frame (`in_frame`) or
 * outside on the lightbox backdrop (`around_frame`).
 *
 * requestAnimationFrame loop, auto-pauses on unmount.  Particles are
 * plain objects; the render is canvas 2D — GPU not required.
 */

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  life: number
  maxLife: number
  hue?: number
}

const COUNT_FOR: Record<AmbienceIntensity, number> = {
  subtle: 22,
  active: 60,
  dense: 140,
}

export function AmbienceLayer({
  kind,
  intensity = 'active',
  accent = '#4fc3f7',
}: {
  kind: AmbienceKind
  intensity?: AmbienceIntensity
  accent?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const particlesRef = useRef<Particle[]>([])

  useEffect(() => {
    if (kind === 'none') return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const count = COUNT_FOR[intensity]
    let w = 0
    let h = 0

    const resize = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio ?? 1, 2)
      w = rect.width
      h = rect.height
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    if (canvas.parentElement) ro.observe(canvas.parentElement)

    // ---- per-kind spawn + step ------------------------------------
    const spawn = (seedEdge = false): Particle => {
      const rand = Math.random
      switch (kind) {
        case 'snow': {
          return {
            x: rand() * w,
            y: seedEdge ? -rand() * 20 : rand() * h,
            vx: (rand() - 0.5) * 0.25,
            vy: 0.35 + rand() * 0.45,
            size: 0.8 + rand() * 1.8,
            life: 0,
            maxLife: Infinity,
          }
        }
        case 'rain': {
          return {
            x: rand() * w,
            y: seedEdge ? -rand() * 50 : rand() * h,
            vx: 0.6,
            vy: 9 + rand() * 5,
            size: 0.9 + rand() * 0.6, // used as streak length factor
            life: 0,
            maxLife: Infinity,
          }
        }
        case 'embers': {
          return {
            x: rand() * w,
            y: seedEdge ? h + rand() * 40 : rand() * h,
            vx: (rand() - 0.5) * 0.5,
            vy: -(0.4 + rand() * 0.8),
            size: 0.8 + rand() * 1.6,
            life: 0,
            maxLife: 180 + rand() * 220,
          }
        }
        case 'ash': {
          return {
            x: rand() * w,
            y: seedEdge ? -rand() * 30 : rand() * h,
            vx: (rand() - 0.5) * 0.8,
            vy: 0.25 + rand() * 0.55,
            size: 0.5 + rand() * 1.3,
            life: 0,
            maxLife: Infinity,
          }
        }
        case 'dust_motes': {
          return {
            x: rand() * w,
            y: rand() * h,
            vx: (rand() - 0.5) * 0.18,
            vy: (rand() - 0.5) * 0.12 - 0.04,
            size: 0.6 + rand() * 1.3,
            life: rand() * 200,
            maxLife: Infinity,
          }
        }
        case 'fireflies': {
          return {
            x: rand() * w,
            y: rand() * h,
            vx: (rand() - 0.5) * 0.35,
            vy: (rand() - 0.5) * 0.25,
            size: 1.2 + rand() * 1.5,
            life: rand() * 120,
            maxLife: Infinity,
          }
        }
        case 'drip': {
          return {
            x: rand() * w,
            y: seedEdge ? -rand() * 30 : rand() * h,
            vx: 0,
            vy: 2.5 + rand() * 2,
            size: 1 + rand() * 0.8,
            life: 0,
            maxLife: Infinity,
          }
        }
        case 'fog': {
          return {
            x: rand() * w,
            y: rand() * h,
            vx: (rand() - 0.5) * 0.4,
            vy: 0,
            size: 40 + rand() * 60,
            life: rand() * 240,
            maxLife: Infinity,
            hue: 200 + rand() * 30,
          }
        }
        default:
          return { x: 0, y: 0, vx: 0, vy: 0, size: 0, life: 0, maxLife: 0 }
      }
    }

    // Seed the field uniformly so there's no empty-start frame.
    particlesRef.current = Array.from({ length: count }, () => spawn(false))

    // ---- drawing ---------------------------------------------------
    const drawParticle = (p: Particle) => {
      switch (kind) {
        case 'snow': {
          ctx.fillStyle = `rgba(255,255,255,${0.72 - (p.size > 2 ? 0.2 : 0)})`
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
          return
        }
        case 'rain': {
          ctx.strokeStyle = 'rgba(170,195,220,0.55)'
          ctx.lineWidth = 0.9
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(p.x - p.size * 2, p.y + p.size * 14)
          ctx.stroke()
          return
        }
        case 'embers': {
          // Warm orange glow, fading as life burns.
          const frac = Math.max(0, 1 - p.life / p.maxLife)
          const alpha = 0.85 * frac
          ctx.fillStyle = `rgba(255,${130 + Math.floor(60 * frac)},${40 + Math.floor(30 * frac)},${alpha})`
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
          // faint outer glow
          ctx.globalAlpha = alpha * 0.25
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size * 2.8, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
          return
        }
        case 'ash': {
          ctx.fillStyle = 'rgba(200,200,210,0.45)'
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
          return
        }
        case 'dust_motes': {
          // Gentle breathing alpha based on life.
          const breathe = 0.4 + 0.4 * Math.sin(p.life * 0.04)
          ctx.fillStyle = `rgba(240,230,200,${breathe})`
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
          return
        }
        case 'fireflies': {
          const pulse = 0.5 + 0.5 * Math.sin(p.life * 0.08)
          // core
          ctx.fillStyle = `rgba(255,245,150,${0.85 * pulse})`
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
          // glow
          ctx.globalAlpha = 0.35 * pulse
          ctx.fillStyle = accent
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size * 4, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = 1
          return
        }
        case 'drip': {
          ctx.fillStyle = 'rgba(140,180,220,0.7)'
          ctx.beginPath()
          ctx.ellipse(p.x, p.y, p.size * 0.6, p.size * 1.4, 0, 0, Math.PI * 2)
          ctx.fill()
          return
        }
        case 'fog': {
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size)
          grad.addColorStop(0, 'rgba(190,200,215,0.12)')
          grad.addColorStop(1, 'rgba(190,200,215,0)')
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
          return
        }
      }
    }

    // ---- loop ------------------------------------------------------
    const step = () => {
      ctx.clearRect(0, 0, w, h)
      const arr = particlesRef.current
      for (let i = 0; i < arr.length; i += 1) {
        const p = arr[i]
        p.x += p.vx
        p.y += p.vy
        p.life += 1

        // wrap / respawn
        const offBottom = p.y > h + 20
        const offTop = p.y < -20
        const offSide = p.x < -20 || p.x > w + 20
        const exhausted = p.life > p.maxLife

        if (exhausted || (kind !== 'fireflies' && kind !== 'dust_motes' && kind !== 'fog' &&
          ((p.vy > 0 && offBottom) || (p.vy < 0 && offTop) || offSide))) {
          arr[i] = spawn(true)
          continue
        }
        if ((kind === 'fireflies' || kind === 'dust_motes' || kind === 'fog') && (offSide || offBottom || offTop)) {
          // bounce softly for drifters — keeps density even
          if (offSide) p.vx = -p.vx
          if (offBottom || offTop) p.vy = -p.vy
        }
        drawParticle(p)
      }
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  }, [kind, intensity, accent])

  if (kind === 'none') return null

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ width: '100%', height: '100%' }}
    />
  )
}
