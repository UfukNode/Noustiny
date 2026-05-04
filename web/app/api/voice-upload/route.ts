/**
 * Voice upload endpoint — accepts a user-supplied audio file (wav / mp3
 * / m4a / ogg), normalises it via ffmpeg into the canonical 24kHz mono
 * 16-bit PCM wav format the voice_clone_synthesize tool expects, and
 * returns a /cache/voice_uploads/<sha>.wav URL the modal then forwards
 * to /api/storybook as voiceUploadPath.
 *
 * Why ffmpeg server-side instead of trusting the upload as-is?
 *   - ElevenLabs IVC quality is sensitive to sample rate / channel
 *     count.  24kHz mono is the sweet spot — matches what
 *     voice_sample_builder produces for fetched clips, so cloned
 *     voice consistency holds whether the reference came from upload
 *     or from YouTube fetch.
 *   - Lets us strip metadata, drop second channel cross-talk, and
 *     enforce a 30 s ceiling so a 4 GB user upload doesn't melt the
 *     IVC payload.
 *
 * Storage layout mirrors the image-cache convention:
 *   web/public/cache/voice_uploads/<sha16>.wav
 * Content-addressable — the same upload twice doesn't double-store and
 * doesn't trigger a re-clone (voice_clone_synthesize keys voice_id by
 * wav-bytes SHA, so the cached voice_id wins on repeat).
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

import { NextRequest } from 'next/server'

const execFileAsync = promisify(execFile)

// Windows dev environment doesn't have ffmpeg/ffprobe on PATH — they
// live in WSL where the storybook FastAPI service consumes them.  We
// shell out via wsl.exe so we reuse the same ffmpeg binary the rest
// of the pipeline already validates against (consistent codec
// assumptions, identical encode params).  Path translation is just
// the standard /mnt/c/<drive-letter>/<rest> convention.
function winToWsl(p: string): string {
  // C:\Users\X\file.txt → /mnt/c/Users/X/file.txt
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (!m) return p
  const drive = m[1].toLowerCase()
  const rest = m[2].replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}

async function runWslFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // wsl.exe forwards each remaining argv as a separate argv entry to
  // the Linux process, so we don't have to worry about shell escaping.
  return execFileAsync('wsl.exe', ['ffmpeg', ...args])
}

async function runWslFfprobe(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('wsl.exe', ['ffprobe', ...args])
}

// Cache lives next to image cache so the dev server picks it up via
// /cache/voice_uploads/X.wav with no extra route plumbing.
const PUBLIC_DIR = path.resolve(process.cwd(), 'public')
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'cache', 'voice_uploads')
const PUBLIC_URL_BASE = '/cache/voice_uploads'

// Hard ceilings — keep ElevenLabs payload sane and reject obvious
// abuse without trusting the client.
const MAX_INPUT_BYTES = 50 * 1024 * 1024     // 50 MB upload cap
const MAX_DURATION_SEC = 30                  // ElevenLabs IVC sweet spot is 6-15 s
const ACCEPTED_MIMES = new Set([
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'audio/ogg', 'audio/x-ogg', 'audio/vorbis',
  'audio/webm',
])

async function ensureDir(): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true })
}

function sha16(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

export async function POST(req: NextRequest): Promise<Response> {
  let form: FormData
  try {
    form = await req.formData()
  } catch (e) {
    return Response.json(
      { error: `multipart parse failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    )
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return Response.json({ error: 'file field is required' }, { status: 400 })
  }
  if (file.size === 0) {
    return Response.json({ error: 'empty file' }, { status: 400 })
  }
  if (file.size > MAX_INPUT_BYTES) {
    return Response.json({ error: `file too large (>${MAX_INPUT_BYTES} bytes)` }, { status: 413 })
  }
  // ACCEPTED_MIMES is a sanity check only; ffmpeg ultimately decides
  // whether the bytes are decodable, and the file picker on the modal
  // already constrains the picker to audio types.  We keep the check
  // soft so a user dropping a webm-as-audio still gets through.
  if (file.type && !ACCEPTED_MIMES.has(file.type) && !file.type.startsWith('audio/')) {
    return Response.json({ error: `unsupported file type: ${file.type}` }, { status: 400 })
  }

  const inputBytes = Buffer.from(await file.arrayBuffer())
  const hash = sha16(inputBytes)
  const outName = `${hash}.wav`
  const outPath = path.join(UPLOAD_DIR, outName)
  await ensureDir()

  // Cache-hit short-circuit — if the same bytes were uploaded before,
  // skip ffmpeg entirely.  Same SHA → same wav → voice_clone_synthesize
  // already has a cached voice_id for it.
  if (existsSync(outPath)) {
    return Response.json({
      path: `${PUBLIC_URL_BASE}/${outName}`,
      hash,
      cached: true,
      duration_sec: null,
      bytes: inputBytes.length,
    })
  }

  // Stage the input under a temp name so ffmpeg can re-decode it from
  // any container.  /tmp is shared with WSL so ffmpeg there sees the
  // same path; we still keep the staging file inside UPLOAD_DIR so the
  // dev server's read-through never crosses an OS boundary mid-flight.
  const tmpName = `_staging_${randomUUID().replace(/-/g, '').slice(0, 12)}${path.extname(file.name) || '.bin'}`
  const tmpPath = path.join(UPLOAD_DIR, tmpName)
  await writeFile(tmpPath, inputBytes)

  // Probe duration first — reject anything over MAX_DURATION_SEC.
  // Runs in WSL (Windows dev env doesn't ship ffprobe).  Path is
  // translated to /mnt/c/... so the WSL binary can read it.
  let durationSec = 0
  try {
    const { stdout } = await runWslFfprobe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      winToWsl(tmpPath),
    ])
    durationSec = parseFloat(stdout.trim()) || 0
  } catch (e) {
    await unlink(tmpPath).catch(() => undefined)
    return Response.json(
      { error: `ffprobe failed — file may be corrupt: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    )
  }
  if (durationSec > MAX_DURATION_SEC) {
    await unlink(tmpPath).catch(() => undefined)
    return Response.json(
      { error: `audio too long (${durationSec.toFixed(1)}s > ${MAX_DURATION_SEC}s)` },
      { status: 400 },
    )
  }
  if (durationSec < 1.0) {
    await unlink(tmpPath).catch(() => undefined)
    return Response.json(
      { error: `audio too short (${durationSec.toFixed(2)}s — need ≥ 1s)` },
      { status: 400 },
    )
  }

  // Re-encode to canonical 24 kHz mono 16-bit PCM wav via WSL ffmpeg
  // (same params as voice_sample_builder so the downstream
  // voice_clone_synthesize tool sees identical input regardless of
  // source).  Both input and output paths translate to /mnt/c/...
  try {
    await runWslFfmpeg([
      '-y',
      '-loglevel', 'error',
      '-i', winToWsl(tmpPath),
      '-ac', '1',
      '-ar', '24000',
      '-c:a', 'pcm_s16le',
      winToWsl(outPath),
    ])
  } catch (e) {
    await unlink(tmpPath).catch(() => undefined)
    return Response.json(
      { error: `ffmpeg re-encode failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  } finally {
    await unlink(tmpPath).catch(() => undefined)
  }

  return Response.json({
    path: `${PUBLIC_URL_BASE}/${outName}`,
    hash,
    cached: false,
    duration_sec: Math.round(durationSec * 100) / 100,
    bytes: inputBytes.length,
  })
}
