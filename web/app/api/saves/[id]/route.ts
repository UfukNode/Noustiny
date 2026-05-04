import { unlink } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'

export const runtime = 'nodejs'

const SAVES_DIR = path.join(process.cwd(), '.saves')
const SAFE_ID = /^[A-Za-z0-9_-]+$/

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/saves/[id]'>,
): Promise<Response> {
  const { id } = await ctx.params
  if (!id || !SAFE_ID.test(id)) {
    return Response.json({ error: 'Invalid id' }, { status: 400 })
  }
  const fp = path.join(SAVES_DIR, `${id}.json`)
  try {
    await unlink(fp)
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') {
      return new Response(null, { status: 404 })
    }
    return Response.json(
      { error: `Failed to delete: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
  return new Response(null, { status: 204 })
}
