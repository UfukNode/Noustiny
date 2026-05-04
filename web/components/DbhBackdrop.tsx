'use client'

import { useEffect, useState } from 'react'

/**
 * Single source of truth for the canvas backdrop.  Two static SVG
 * artworks live in /public/backdrops/ — dbh-dark.svg and dbh-light.svg.
 * We pick one based on `<body data-theme>` (the same flag Cursor.tsx
 * watches), so a backdrop swap is driven entirely by the theme flip
 * elsewhere in the app — no preset state, no picker.
 *
 * The layer is viewport-fixed and pointer-events:none, so it sits
 * permanently behind the React Flow surface and never participates
 * in pan/zoom.  preserveAspectRatio="xMidYMid slice" inside the SVG
 * crops as needed to fill any aspect ratio without distortion.
 *
 * Cross-fade between the two assets is a 320ms opacity ramp on each
 * <img> independently — we mount BOTH images and only toggle opacity,
 * so the next theme is already decoded and there's no flash of empty
 * background mid-swap.
 */
export function DbhBackdrop() {
  const [isLight, setIsLight] = useState(false)

  useEffect(() => {
    const check = () => {
      const t = document.body.getAttribute('data-theme')
      setIsLight(t === 'light')
    }
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.body, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 0 }}
    >
      <img
        src="/backdrops/dbh-dark.svg"
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full"
        style={{
          objectFit: 'cover',
          opacity: isLight ? 0 : 1,
          transition: 'opacity 320ms ease',
        }}
      />
      <img
        src="/backdrops/dbh-light.svg"
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full"
        style={{
          objectFit: 'cover',
          opacity: isLight ? 1 : 0,
          transition: 'opacity 320ms ease',
        }}
      />
    </div>
  )
}
