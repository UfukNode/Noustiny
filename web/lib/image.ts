/**
 * Pollinations.ai — free, no API key.
 * Keep the prompt short and skip `enhance` so the image arrives in ~3–5s
 * instead of 10–15s. We add a compact cinematic hint inline.
 */

export interface ImageOpts {
  prompt: string
  seed?: number
  width?: number
  height?: number
}

export function imageUrl(opts: ImageOpts): string {
  const { prompt, seed = 42, width = 480, height = 300 } = opts
  const full = `${prompt}, cinematic still, 35mm, dramatic lighting`
  const encoded = encodeURIComponent(full)
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    model: 'flux',
    nologo: 'true',
  })
  return `https://image.pollinations.ai/prompt/${encoded}?${params.toString()}`
}

export function seedFromString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h) % 2_147_483_647
}
