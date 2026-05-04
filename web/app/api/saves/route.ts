import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

/**
 * Filesystem mirror for Noustiny story saves.
 *
 * The primary save store is the browser's localStorage (see
 * web/lib/save-system.ts).  This route adds a write-through filesystem
 * mirror so saves survive scenarios localStorage can't:
 *
 *   - port change (3000 → 3100): localStorage is keyed by origin, so a
 *     port flip looks like an empty saves list to the user.  This mirror
 *     lets the app rehydrate from disk on boot regardless of port.
 *   - browser cache wipe: localStorage cleared, fs untouched.
 *   - cross-browser session: open the app in a fresh browser, hydrate
 *     pulls saves from disk into the new localStorage.
 *
 * Storage layout: `web/.saves/<id>.json` per save, file contains
 * `{ meta: SavedStoryMeta, snapshot: StorySnapshot }`.  No index file —
 * we scan the directory.  Saves are ~100KB-500KB each; <50 saves is
 * the realistic ceiling for a single user, so directory listing stays
 * cheap.
 */

const SAVES_DIR = path.join(process.cwd(), '.saves')

// Save IDs come from save-system's makeSaveId: `${ts.toString(36)}-${rand}`
// → only [0-9a-z-]. We still validate to prevent path traversal from
// hand-crafted POST bodies.
const SAFE_ID = /^[A-Za-z0-9_-]+$/

async function ensureDir(): Promise<void> {
  try {
    await mkdir(SAVES_DIR, { recursive: true })
  } catch {
    /* mkdir with recursive=true only fails on permission/IO; let the
       caller surface the read/write failure with more context. */
  }
}

export async function GET(): Promise<Response> {
  await ensureDir()
  let entries: string[]
  try {
    entries = await readdir(SAVES_DIR)
  } catch {
    return Response.json({ saves: [] })
  }
  const out: unknown[] = []
  for (const file of entries) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -5)
    if (!SAFE_ID.test(id)) continue
    const fp = path.join(SAVES_DIR, file)
    try {
      const raw = await readFile(fp, 'utf-8')
      const parsed = JSON.parse(raw)
      // Quick shape gate — anything malformed is silently dropped so a
      // corrupt file can't break the list.  A more aggressive validation
      // would require importing the type, which we'd rather not pull
      // server-side; the client re-validates on hydrate anyway.
      if (parsed && parsed.meta && parsed.snapshot && parsed.meta.id === id) {
        out.push(parsed)
      }
    } catch {
      /* unreadable / unparseable file — skip */
    }
  }
  // Sort newest-first by updatedAt for parity with localStorage list view.
  out.sort((a, b) => {
    const ax = (a as { meta: { updatedAt?: number } }).meta?.updatedAt ?? 0
    const bx = (b as { meta: { updatedAt?: number } }).meta?.updatedAt ?? 0
    return bx - ax
  })
  return Response.json({ saves: out })
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'Body must be an object' }, { status: 400 })
  }
  const { meta, snapshot } = body as { meta?: { id?: string }, snapshot?: unknown }
  const id = meta?.id
  if (!id || typeof id !== 'string' || !SAFE_ID.test(id)) {
    return Response.json({ error: 'Missing or invalid meta.id' }, { status: 400 })
  }
  if (!snapshot || typeof snapshot !== 'object') {
    return Response.json({ error: 'Missing snapshot' }, { status: 400 })
  }
  await ensureDir()
  const fp = path.join(SAVES_DIR, `${id}.json`)
  try {
    await writeFile(fp, JSON.stringify(body), 'utf-8')
  } catch (e) {
    return Response.json(
      { error: `Failed to write save: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
  let size = 0
  try { size = (await stat(fp)).size } catch { /* size is informational */ }
  return Response.json({ ok: true, id, bytes: size })
}
