'use client'

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Film, BookOpen, Volume2, VolumeX, Loader2, Download, AlertTriangle, Sparkles, Sliders, Smartphone } from 'lucide-react'
import { useStory } from '@/lib/store'
import type { StoryNode } from '@/lib/types'

type Mode = 'audiobook' | 'intro' | 'reel'
type ReelSubtitleBg = 'none' | 'box' | 'blur-pill'
type ReelSubtitleWeight = 400 | 600 | 700 | 800
type Lang = 'tr' | 'en' | 'es' | 'fr' | 'de'
type IntroStyle = 'marvel' | 'detroit' | 'cinematic' | 'off'
type IntroPace = 'fast' | 'medium' | 'slow'
type IntroTone =
  | 'marvel-red' | 'hero-gold' | 'cinematic-cyan'
  | 'noir-gray' | 'magical-purple' | 'horror-blood'
type IntroTransition = 'cut' | 'fade' | 'whip'
type IntroOutro = 'hold' | 'fade-black' | 'page-close' | 'split-vertical'
type IntroSfx = 'none' | 'marvel-jet' | 'page-turn' | 'whoosh' | 'cinematic-rumble'
type BeatTransition = 'hardcut' | 'fade-chapter'
type VoiceGender = 'male' | 'female'
type VoiceStyle = 'narrator' | 'dramatic' | 'whisper' | 'bright'
type SubtitleSource = 'title' | 'body-snippet' | 'none'

// Voice cloning controls (audio mode only) — picks where the reference
// wav comes from.  'edge' = no cloning, edge-tts default path.
type VoiceMode = 'edge' | 'auto' | 'preset' | 'custom' | 'upload'

type VoicePreset = {
  id: string
  label: string
  query: string
  hint: string
}

// Curated personas — search queries are intentionally narration-style
// (prologue / monologue / interview / audiobook) so voice_sample_builder
// surfaces clean speaking-voice clips, not action drama.  See the
// voice_sample_query_phrasing memory for the rule book.
const VOICE_PRESETS: VoicePreset[] = [
  {
    id: 'galadriel',
    label: 'Galadriel — elven sage',
    query: 'Galadriel prologue The world is changed Lord of the Rings narration',
    hint: 'soft regal mythic narrator',
  },
  {
    id: 'iroh',
    label: 'Iroh — warm uncle',
    query: 'Mako Iroh monologue Avatar Last Airbender narration',
    hint: 'gentle storyteller with weight',
  },
  {
    id: 'morgan-freeman',
    label: 'Morgan Freeman — gravitas',
    query: 'Morgan Freeman audiobook reading narration excerpt',
    hint: 'iconic deep documentary voice',
  },
  {
    id: 'attenborough',
    label: 'Attenborough — naturalist',
    query: 'David Attenborough Planet Earth narration excerpt',
    hint: 'measured wise documentary tone',
  },
  {
    id: 'audiobook-female-warm',
    label: 'Audiobook — warm female',
    query: 'Anne Hathaway audiobook reading narration excerpt',
    hint: 'empathetic mid-range female',
  },
  {
    id: 'audiobook-male-deep',
    label: 'Audiobook — deep male',
    query: 'Tom Hanks audiobook reading narration excerpt',
    hint: 'grounded baritone narrator',
  },
  {
    id: 'noir-detective',
    label: 'Noir detective',
    query: 'hardboiled detective monologue voiceover film noir',
    hint: 'gravelly first-person voiceover',
  },
  {
    id: 'walter-white',
    label: 'Walter White — grim',
    query: 'Bryan Cranston Breaking Bad monologue voice over interview',
    hint: 'cold deliberate gravitas',
  },
]

const LANG_OPTIONS: { id: Lang; label: string; voice: string }[] = [
  { id: 'tr', label: 'Türkçe',   voice: 'tr-TR-EmelNeural' },
  { id: 'en', label: 'English',  voice: 'en-US-AriaNeural' },
  { id: 'es', label: 'Español',  voice: 'es-ES-ElviraNeural' },
  { id: 'fr', label: 'Français', voice: 'fr-FR-DeniseNeural' },
  { id: 'de', label: 'Deutsch',  voice: 'de-DE-KatjaNeural' },
]

const INTRO_STYLE_OPTIONS: { id: IntroStyle; label: string; hint: string }[] = [
  { id: 'marvel',    label: 'Marvel',    hint: 'border + leaves zoom + Anton + montage' },
  { id: 'detroit',   label: 'Detroit',   hint: 'hard cuts · white flashes · cyan slash' },
  { id: 'cinematic', label: 'Cinematic', hint: 'long dissolves · letterbox · deep black' },
  { id: 'off',       label: 'Off',       hint: 'skip the cinematic intro' },
]

const INTRO_TONE_OPTIONS: { id: IntroTone; label: string; swatch: string }[] = [
  { id: 'marvel-red',     label: 'Marvel red',  swatch: '#e63946' },
  { id: 'hero-gold',      label: 'Hero gold',   swatch: '#f5c542' },
  { id: 'cinematic-cyan', label: 'Cyan',        swatch: '#4fc3f7' },
  { id: 'noir-gray',      label: 'Noir gray',   swatch: '#cfcfcf' },
  { id: 'magical-purple', label: 'Magical',     swatch: '#a259ff' },
  { id: 'horror-blood',   label: 'Horror',      swatch: '#a01010' },
]

const INTRO_PACE_OPTIONS: { id: IntroPace; label: string; hint: string }[] = [
  { id: 'fast',   label: 'Fast',   hint: '0.45s/img — Marvel rapid montage' },
  { id: 'medium', label: 'Medium', hint: '0.85s/img — cinematic teaser' },
  { id: 'slow',   label: 'Slow',   hint: '1.5s/img — mood piece' },
]

const INTRO_TRANSITION_OPTIONS: { id: IntroTransition; label: string }[] = [
  { id: 'cut',  label: 'Cut' },
  { id: 'fade', label: 'Fade' },
  { id: 'whip', label: 'Whip' },
]

const INTRO_OUTRO_OPTIONS: { id: IntroOutro; label: string; hint: string }[] = [
  { id: 'hold',           label: 'Hold',     hint: 'still settle, no overlay' },
  { id: 'fade-black',     label: 'Fade',     hint: 'theatrical curtain' },
  { id: 'page-close',     label: 'Page',     hint: 'top + bottom meet' },
  { id: 'split-vertical', label: 'Split',    hint: 'left + right meet' },
]

const INTRO_SFX_OPTIONS: { id: IntroSfx; label: string; hint: string }[] = [
  { id: 'marvel-jet',       label: 'Jet',     hint: 'whip per cut + jet pass' },
  { id: 'page-turn',        label: 'Page',    hint: 'paper crinkle per cut' },
  { id: 'whoosh',           label: 'Whoosh',  hint: 'soft low pass + ocean' },
  { id: 'cinematic-rumble', label: 'Rumble',  hint: 'sustained low rumble' },
  { id: 'none',             label: 'Silent',  hint: 'no SFX' },
]

const BEAT_TRANSITION_OPTIONS: { id: BeatTransition; label: string; hint: string }[] = [
  { id: 'hardcut',      label: 'Hard cut', hint: 'no fade · sharp' },
  { id: 'fade-chapter', label: 'Chapter',  hint: 'fade between beats' },
]

const VOICE_GENDER_OPTIONS: { id: VoiceGender; label: string }[] = [
  { id: 'female', label: 'Female' },
  { id: 'male',   label: 'Male'   },
]

const VOICE_STYLE_OPTIONS: { id: VoiceStyle; label: string; hint: string }[] = [
  { id: 'narrator', label: 'Narrator', hint: 'warm storyteller' },
  { id: 'dramatic', label: 'Dramatic', hint: 'slow · deeper' },
  { id: 'whisper',  label: 'Whisper',  hint: 'hushed intimate' },
  { id: 'bright',   label: 'Bright',   hint: 'lively · brighter' },
]

const SUBTITLE_SOURCE_OPTIONS: { id: SubtitleSource; label: string; hint: string }[] = [
  { id: 'body-snippet', label: 'Body',  hint: 'matches spoken language' },
  { id: 'title',        label: 'Title', hint: 'node title verbatim' },
  { id: 'none',         label: 'Off',   hint: 'no caption' },
]

const REEL_BG_OPTIONS: { id: ReelSubtitleBg; label: string; hint: string }[] = [
  { id: 'blur-pill', label: 'Pill',  hint: 'soft pill behind text' },
  { id: 'box',       label: 'Box',   hint: 'opaque rect' },
  { id: 'none',      label: 'None',  hint: 'just outline' },
]

const REEL_WEIGHT_OPTIONS: { id: ReelSubtitleWeight; label: string }[] = [
  { id: 400, label: '400' },
  { id: 600, label: '600' },
  { id: 700, label: '700' },
  { id: 800, label: '800' },
]

const REEL_FONT_PRESETS: { id: string; label: string; stack: string }[] = [
  { id: 'system', label: 'System', stack: '' },
  { id: 'inter',  label: 'Inter',  stack: 'Inter, system-ui, sans-serif' },
  { id: 'mono',   label: 'Mono',   stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { id: 'serif',  label: 'Serif',  stack: 'Georgia, "Times New Roman", serif' },
]

const INTRO_LAST_N = 5

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

// Six well-separated hues cycle across the path list — adjacent rows
// always land in different colour families.  Low alpha (≈0.10) keeps
// the tint subtle on the dark modal surface and remains legible on
// light/system surfaces too (transparency lets the underlying colour
// dictate contrast).
const PATH_TINTS: readonly string[] = [
  'rgba(79,195,247,0.10)',   // cyan
  'rgba(233,193,107,0.10)',  // gold
  'rgba(167,139,250,0.10)',  // mauve
  'rgba(110,199,153,0.10)',  // emerald
  'rgba(231,124,124,0.10)',  // coral
  'rgba(124,156,200,0.10)',  // slate-blue
]
// Same hues, slightly bolder alpha — used as the square badge silhouette
// behind each row's index number, so the number reads as belonging to
// the row tint rather than floating in faint grey.
const PATH_TINT_BADGES: readonly string[] = [
  'rgba(79,195,247,0.22)',
  'rgba(233,193,107,0.22)',
  'rgba(167,139,250,0.22)',
  'rgba(110,199,153,0.22)',
  'rgba(231,124,124,0.22)',
  'rgba(124,156,200,0.22)',
]
// Ink colour for the number — the saturated hue of the same family,
// bright enough to read against the soft badge fill.
const PATH_TINT_INKS: readonly string[] = [
  '#7bcef3',  // cyan
  '#e9c16b',  // gold
  '#a78bfa',  // mauve
  '#6ec799',  // emerald
  '#e77c7c',  // coral
  '#7c9cc8',  // slate-blue
]

/** Walk parent pointers from `endpointId` back to the root, return
 *  the linear path in root→endpoint order. */
function pathRootToNode(nodes: Map<string, StoryNode>, endpointId: string): StoryNode[] {
  const out: StoryNode[] = []
  let cursor: string | null = endpointId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const n = nodes.get(cursor)
    if (!n) break
    out.push(n)
    cursor = n.parentId
  }
  return out.reverse()
}

export function StorybookModal() {
  const endpointId = useStory((s) => s.storybookEndpointId)
  const close = useStory((s) => s.closeStorybook)
  const nodes = useStory((s) => s.nodes)
  const snapshotCurrent = useStory((s) => s.snapshotCurrent)
  const seed = useStory((s) => s.seed)
  // Set when the user clicks a finished render in the bottom-right
  // widget — modal then opens straight into the player view, skipping
  // the form so they can replay the mp4 without re-running anything.
  const storyPlayerUrl = useStory((s) => s.storyPlayerUrl)
  const storyPlayerAspect = useStory((s) => s.storyPlayerAspect)
  const addRenderJob = useStory((s) => s.addRenderJob)

  const [mode, setMode] = useState<Mode>('audiobook')
  const [audio, setAudio] = useState(true)
  const [lang, setLang] = useState<Lang>('en')
  const [introStyle, setIntroStyle] = useState<IntroStyle>('marvel')
  // AI-director toggle.  When ON, the agent picks pace/tone/transition/duration
  // based on the storybook-intro skill.  When OFF, the user controls them
  // explicitly via the manual panel below.
  const [autoDirector, setAutoDirector] = useState(true)
  const [introDuration, setIntroDuration] = useState<number>(7)
  const [introPace, setIntroPace] = useState<IntroPace>('medium')
  const [introTone, setIntroTone] = useState<IntroTone>('cinematic-cyan')
  const [introTransition, setIntroTransition] = useState<IntroTransition>('fade')
  const [introOutro, setIntroOutro] = useState<IntroOutro>('fade-black')
  const [introSfx, setIntroSfx] = useState<IntroSfx>('marvel-jet')
  const [beatTransition, setBeatTransition] = useState<BeatTransition>('fade-chapter')
  const [voiceGender, setVoiceGender] = useState<VoiceGender>('female')
  const [voiceStyle, setVoiceStyle] = useState<VoiceStyle>('narrator')
  // Voice cloning state — picks the reference-wav source and (when
  // applicable) the search query / preset / upload payload that feeds
  // the voice_sample_builder + voice_clone_synthesize pipeline.
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('auto')
  const [voicePresetId, setVoicePresetId] = useState<string>(VOICE_PRESETS[0].id)
  const [voiceCustomQuery, setVoiceCustomQuery] = useState<string>('')
  const [voiceUploadPath, setVoiceUploadPath] = useState<string>('')
  const [voiceUploadLabel, setVoiceUploadLabel] = useState<string>('')
  const [voiceUploading, setVoiceUploading] = useState<boolean>(false)
  const [voiceUploadError, setVoiceUploadError] = useState<string | null>(null)
  const [voiceCloneSpeed, setVoiceCloneSpeed] = useState<number>(0.85)
  const [subtitleSource, setSubtitleSource] = useState<SubtitleSource>('body-snippet')
  const [chapterMarkers, setChapterMarkers] = useState<boolean>(true)
  const [narrationTranslate, setNarrationTranslate] = useState<boolean>(false)
  // Reel-mode subtitle styling — only consulted when mode==='reel'.
  // Defaults match service.py's blur-pill/700/0.78 design contract so a
  // user who never touches the studio still gets a sensible Reel.
  const [reelFont, setReelFont] = useState<string>('system')
  const [reelSize, setReelSize] = useState<number>(60)
  const [reelColor, setReelColor] = useState<string>('#ffffff')
  const [reelOutlineColor, setReelOutlineColor] = useState<string>('#000000')
  const [reelOutlineWidth, setReelOutlineWidth] = useState<number>(1)
  const [reelBg, setReelBg] = useState<ReelSubtitleBg>('none')
  const [reelWeight, setReelWeight] = useState<ReelSubtitleWeight>(700)
  const [reelXPct, setReelXPct] = useState<number>(0.50)
  const [reelYPct, setReelYPct] = useState<number>(0.78)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultAspect, setResultAspect] = useState<'16/9' | '9/16'>('16/9')

  // Reset state on every open.  When openStoryPlayer is used (widget
  // click on a finished render), seed resultUrl so the modal renders
  // straight into the player view instead of the form.
  useEffect(() => {
    if (endpointId) {
      setMode('audiobook')
      setAudio(true)
      setLang('en')
      setIntroStyle('marvel')
      setAutoDirector(true)
      setIntroDuration(7)
      setIntroPace('medium')
      setIntroTone('cinematic-cyan')
      setIntroTransition('fade')
      setIntroOutro('fade-black')
      setIntroSfx('marvel-jet')
      setBeatTransition('fade-chapter')
      setVoiceGender('female')
      setVoiceStyle('narrator')
      setVoiceMode('auto')
      setVoicePresetId(VOICE_PRESETS[0].id)
      setVoiceCustomQuery('')
      setVoiceUploadPath('')
      setVoiceUploadLabel('')
      setVoiceUploadError(null)
      setVoiceUploading(false)
      setVoiceCloneSpeed(0.85)
      setSubtitleSource('body-snippet')
      setChapterMarkers(true)
      setNarrationTranslate(false)
      setReelFont('system')
      setReelSize(60)
      setReelColor('#ffffff')
      setReelOutlineColor('#000000')
      setReelOutlineWidth(1)
      setReelBg('none')
      setReelWeight(700)
      setReelXPct(0.50)
      setReelYPct(0.78)
      setBusy(false)
      setError(null)
      setResultUrl(storyPlayerUrl ?? null)
      setResultAspect(storyPlayerUrl ? storyPlayerAspect : '16/9')
    }
  }, [endpointId, storyPlayerUrl, storyPlayerAspect])

  useEffect(() => {
    if (!endpointId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [endpointId, busy, close])

  const fullPath = useMemo(
    () => (endpointId ? pathRootToNode(nodes, endpointId) : []),
    [endpointId, nodes],
  )

  const usedPath = useMemo(() => {
    // Reel mode uses the full path (it's just a vertical audiobook).
    // Intro mode is the only one that trims to last N for cinematic
    // condensation.
    if (mode === 'intro') return fullPath.slice(Math.max(0, fullPath.length - INTRO_LAST_N))
    return fullPath
  }, [fullPath, mode])

  const usedIds = useMemo(() => new Set(usedPath.map((n) => n.id)), [usedPath])

  const submit = () => {
    if (!endpointId) return
    const snapshot = snapshotCurrent()
    // When the user is in Auto mode we *omit* the atomic params from the
    // payload — the route then signals the agent that those fields are
    // up to the storybook-intro skill to decide.  In Manual mode we
    // forward the slider/picker values verbatim.
    const jobId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 24)
        : Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14)
    // Reel mode: portrait orientation, no cinematic intro, body-only
    // narration.  We force the route's downstream defaults here so the
    // agent never has to guess between "the user wants Reel" and "the
    // user wants Audiobook with weird orientation."
    const isReel = mode === 'reel'
    const body: Record<string, unknown> = {
      snapshot,
      endpointId,
      mode: isReel ? 'audiobook' : mode,
      audio,
      language: lang,
      introStyle: isReel ? 'off' : introStyle,
      autoDirector: isReel ? false : autoDirector,
      jobId,
    }
    if (isReel) {
      body.orientation = 'portrait'
      body.reelSubtitleFont = reelFont === 'system' ? null : (REEL_FONT_PRESETS.find((f) => f.id === reelFont)?.stack ?? null)
      body.reelSubtitleSizePx = reelSize
      body.reelSubtitleColor = reelColor
      body.reelSubtitleOutlineColor = reelOutlineColor
      body.reelSubtitleOutlineWidth = reelOutlineWidth
      body.reelSubtitleBg = reelBg
      body.reelSubtitleWeight = reelWeight
      body.reelSubtitleXPct = reelXPct
      body.reelSubtitleYPct = reelYPct
      // Reel ALWAYS uses body-snippet captions, with or without TTS.
      // When audio is on, edge-tts emits a per-cue SRT synced to the
      // narration.  When audio is off, service.py drops a static
      // single-cue SRT so libass still has something to draw — silent
      // Reels otherwise rendered captionless (the cause of the
      // "altyazı yok" report from the audio-off render path).
      body.subtitleSource = 'body-snippet'
      body.beatTransition = 'hardcut'
      body.chapterMarkers = false
      body.narrationTranslate = audio && lang !== 'tr'
    } else if (!autoDirector && introStyle === 'marvel' && mode === 'audiobook') {
      body.introDurationSecs = introDuration
      body.introPace = introPace
      body.introTone = introTone
      body.introTransition = introTransition
      body.introOutro = introOutro
      body.introSfx = introSfx
      body.beatTransition = beatTransition
    }
    // Voice gender / style / subtitle / chapter always forwarded when
    // AI is off — these apply across intro styles and even when the
    // audiobook body has no intro at all.
    if (!isReel && !autoDirector) {
      body.voiceGender = voiceGender
      body.voiceStyle = voiceStyle
      body.subtitleSource = subtitleSource
      body.chapterMarkers = chapterMarkers
      body.narrationTranslate = narrationTranslate
    }
    // Voice cloning controls — forwarded only when audio is on AND the
    // user picked a non-default voice mode.  The route turns each mode
    // into a multi-tool sub-pipeline (director skill → voice_sample_builder
    // → voice_clone_synthesize) before dispatching the render tool.
    if (audio && voiceMode !== 'edge') {
      body.voiceMode = voiceMode
      body.voiceCloneSpeed = voiceCloneSpeed
      if (voiceMode === 'preset') {
        const preset = VOICE_PRESETS.find((p) => p.id === voicePresetId) ?? VOICE_PRESETS[0]
        body.voiceQuery = preset.query
        body.voicePresetLabel = preset.label
      } else if (voiceMode === 'custom') {
        const q = voiceCustomQuery.trim()
        if (q) {
          body.voiceQuery = q
          // Show the first 6 words of the query as a label so the
          // ticker has something readable instead of the full search
          // string.
          body.voicePresetLabel = q.split(/\s+/).slice(0, 6).join(' ')
        } else {
          // Empty custom query → silently degrade to edge-tts so the
          // render doesn't stall waiting for an empty fetch.
          body.voiceMode = 'edge'
        }
      } else if (voiceMode === 'upload') {
        if (voiceUploadPath) {
          body.voiceUploadPath = voiceUploadPath
          body.voicePresetLabel = voiceUploadLabel || 'Uploaded reference'
        } else {
          body.voiceMode = 'edge'
        }
      }
      // 'auto' carries no extra fields — the agent calls the director
      // skill which produces persona_label + search_query at runtime.
    }
    const endpointNode = nodes.get(endpointId)
    const endpointTitle = endpointNode?.title || endpointNode?.label || 'storybook'
    addRenderJob({
      id: jobId,
      endpointId,
      endpointTitle,
      body,
      status: 'pending',
      startedAt: Date.now(),
      beatsTotal: fullPath.length,
      beatsDone: 0,
    })
    setResultAspect(isReel ? '9/16' : '16/9')
    close()
  }

  return (
    <AnimatePresence>
      {endpointId && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(5,7,11,0.86)] backdrop-blur-sm"
          onClick={() => { if (!busy) close() }}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="relative flex w-[min(640px,94vw)] max-h-[88vh] flex-col overflow-hidden border border-[var(--line)] bg-[rgba(10,13,18,0.98)]"
            style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* header */}
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.32em] text-[var(--ink-faint)]">
                  <Film size={11} strokeWidth={1.6} className="text-[var(--cyan)]" />
                  <span>Storybook</span>
                </div>
                <div className="mt-1 truncate font-display text-[12px] uppercase tracking-[0.18em] text-[var(--ink-dim)]">
                  {fullPath.length > 0
                    ? <>root → <span className="text-[var(--cyan)]">{fullPath[fullPath.length - 1].title || 'beat'}</span></>
                    : 'no path'}
                </div>
              </div>
              <button
                onClick={() => { if (!busy) close() }}
                disabled={busy}
                className="ml-3 shrink-0 text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)] disabled:opacity-40"
                aria-label="Close"
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>

            {/* result view — when an mp4 has been rendered, replace the
                form with a player + download link.  Result still inside
                the same modal so the user can see "yes, this came from
                the path I just confirmed". */}
            {resultUrl ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-5">
                <video
                  src={resultUrl}
                  controls
                  autoPlay
                  className="mx-auto block border border-[var(--line)] bg-black"
                  style={
                    resultAspect === '9/16'
                      ? { aspectRatio: '9/16', maxHeight: '70vh', height: '70vh', width: 'auto' }
                      : { aspectRatio: '16/9', width: '100%' }
                  }
                />
                <div className="flex items-center justify-between gap-3">
                  <a
                    href={resultUrl}
                    download
                    className="inline-flex items-center gap-2 border border-[var(--cyan)] bg-[rgba(79,195,247,0.08)] px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.26em] text-[var(--cyan)] transition-colors hover:bg-[rgba(79,195,247,0.16)]"
                    style={{ clipPath: 'polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%)' }}
                  >
                    <Download size={11} strokeWidth={2} /> download
                  </a>
                  <button
                    onClick={() => { setResultUrl(null) }}
                    className="font-mono text-[10.5px] uppercase tracking-[0.26em] text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)]"
                  >
                    render another
                  </button>
                </div>
              </div>
            ) : (
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
                {/* path preview list */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">
                      story compose · {fullPath.length} beats
                      {mode === 'intro' && fullPath.length > INTRO_LAST_N && (
                        <span className="ml-2 text-[var(--gold)]">
                          last {INTRO_LAST_N} beats used
                        </span>
                      )}
                    </div>
                  </div>
                  <ol className="max-h-[180px] space-y-[3px] overflow-y-auto border border-[var(--line)] bg-[rgba(15,19,27,0.5)] px-2 py-2 font-mono text-[11px] tabular-nums text-[var(--ink-dim)]">
                    {fullPath.map((n, i) => {
                      const used = usedIds.has(n.id)
                      const isLast = i === fullPath.length - 1
                      const tintIndex = i % PATH_TINTS.length
                      return (
                        <li
                          key={n.id}
                          className="flex items-center gap-2 truncate px-2 py-1"
                          style={{
                            opacity: used ? 1 : 0.32,
                            background: PATH_TINTS[tintIndex],
                          }}
                        >
                          <span
                            className="inline-flex h-[18px] w-[22px] shrink-0 items-center justify-center font-semibold tabular-nums"
                            style={{
                              background: PATH_TINT_BADGES[tintIndex],
                              color: PATH_TINT_INKS[tintIndex],
                            }}
                          >
                            {String(i + 1).padStart(2, '0')}
                          </span>
                          <span
                            className="truncate uppercase tracking-[0.14em]"
                            style={{ color: isLast ? 'var(--cyan)' : 'var(--ink-dim)' }}
                          >
                            {n.title || n.label || '(untitled)'}
                          </span>
                          {!used && mode === 'intro' && (
                            <span className="ml-auto shrink-0 text-[9px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
                              skipped
                            </span>
                          )}
                          {isLast && (
                            <span className="ml-auto shrink-0 text-[9px] uppercase tracking-[0.22em] text-[var(--cyan)]">
                              endpoint
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                </div>

                <SectionSep />

                {/* mode toggle */}
                <div className="pb-4">
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">mode</div>
                  <div className="flex border border-[var(--line)]">
                    <ModeTab
                      active={mode === 'audiobook'}
                      icon={<BookOpen size={11} strokeWidth={1.8} />}
                      label="Audiobook"
                      hint="Whole story narrated end to end"
                      onClick={() => setMode('audiobook')}
                    />
                    <ModeTab
                      active={mode === 'intro'}
                      icon={<Film size={11} strokeWidth={1.8} />}
                      label={`Cinematic (${INTRO_LAST_N})`}
                      hint={`Short film from the last ${INTRO_LAST_N} beats`}
                      onClick={() => setMode('intro')}
                    />
                    <ModeTab
                      active={mode === 'reel'}
                      icon={<Smartphone size={11} strokeWidth={1.8} />}
                      label="Reel"
                      hint="Vertical short video from your story"
                      onClick={() => setMode('reel')}
                    />
                  </div>
                </div>

                <SectionSep />

                {/* audio + language + voice gender row */}
                <div className="pb-4">
                  <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">audio</div>
                  <div className="flex items-stretch gap-3">
                  <button
                    type="button"
                    onClick={() => setAudio((v) => !v)}
                    className="flex flex-1 items-center justify-between border px-3 py-2 transition-colors"
                    style={{
                      borderColor: audio ? 'var(--cyan)' : 'var(--line)',
                      background: audio ? 'rgba(79,195,247,0.08)' : 'rgba(15,19,27,0.5)',
                      color: audio ? 'var(--cyan)' : 'var(--ink-dim)',
                    }}
                  >
                    <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.26em]">
                      {audio ? <Volume2 size={11} strokeWidth={1.8} /> : <VolumeX size={11} strokeWidth={1.8} />}
                      audio · {audio ? 'on' : 'off'}
                    </span>
                  </button>
                  <select
                    value={lang}
                    onChange={(e) => setLang(e.target.value as Lang)}
                    disabled={!audio}
                    className="flex-1 border border-[var(--line)] bg-[rgba(15,19,27,0.5)] px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.26em] text-[var(--ink)] outline-none transition-colors focus:border-[var(--cyan)] disabled:opacity-40"
                  >
                    {LANG_OPTIONS.map((l) => (
                      <option key={l.id} value={l.id}>{l.label}</option>
                    ))}
                  </select>
                  <div className="flex border border-[var(--line)]" style={{ opacity: audio ? 1 : 0.4 }}>
                    {VOICE_GENDER_OPTIONS.map((v, i) => {
                      const active = voiceGender === v.id
                      return (
                        <button
                          key={v.id}
                          type="button"
                          disabled={!audio}
                          onClick={() => setVoiceGender(v.id)}
                          className="px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.26em] transition-colors"
                          style={{
                            background: active ? 'rgba(79,195,247,0.14)' : 'transparent',
                            color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                            borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
                          }}
                        >
                          {v.label}
                        </button>
                      )
                    })}
                  </div>
                  </div>
                </div>

                {/* Voice cloning picker — only visible when audio is on.
                    Picks the source of the reference wav: AI auto, curated
                    preset, custom YouTube query, or local upload.  When
                    Edge is selected (default) this whole sub-pipeline is
                    skipped and the renderer uses Microsoft Edge neural
                    voices via voice_gender / voice_style as before. */}
                {audio && <SectionSep />}
                {audio && (
                  <div className="pb-4">
                    <div className="mb-1.5 flex items-center justify-between">
                      <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">voice</div>
                      {voiceMode !== 'edge' && (
                        <div className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--cyan)]">
                          cloning · ElevenLabs IVC
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-5 gap-1 border border-[var(--line)]">
                      {([
                        { id: 'edge',   label: 'Edge',    hint: 'no clone' },
                        { id: 'auto',   label: 'Auto',    hint: 'AI picks persona' },
                        { id: 'preset', label: 'Preset',  hint: 'curated voice' },
                        { id: 'custom', label: 'Custom',  hint: 'YouTube query' },
                        { id: 'upload', label: 'Upload',  hint: 'your wav/mp3' },
                      ] as { id: VoiceMode; label: string; hint: string }[]).map((m, i) => {
                        const active = voiceMode === m.id
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => setVoiceMode(m.id)}
                            className="flex flex-col items-start gap-0 px-2 py-1.5 text-left transition-colors"
                            style={{
                              background: active ? 'rgba(79,195,247,0.14)' : 'transparent',
                              color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                              borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
                            }}
                          >
                            <span className="font-mono text-[10px] uppercase tracking-[0.24em]">{m.label}</span>
                            <span className="font-mono text-[8.5px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
                              {m.hint}
                            </span>
                          </button>
                        )
                      })}
                    </div>

                    {/* Auto — no extra inputs, just an explainer */}
                    {voiceMode === 'auto' && (
                      <div className="mt-2 border border-dashed border-[var(--line)] bg-[rgba(79,195,247,0.04)] px-3 py-2 font-mono text-[10px] leading-relaxed text-[var(--ink-dim)]">
                        narration-voice-director skill picks a persona based on the story tone, then voice_sample_builder fetches a clean reference clip from YouTube.  agent ticker shows the chosen persona live.
                      </div>
                    )}

                    {/* Preset — dropdown */}
                    {voiceMode === 'preset' && (
                      <div className="mt-2">
                        <select
                          value={voicePresetId}
                          onChange={(e) => setVoicePresetId(e.target.value)}
                          className="w-full border border-[var(--line)] bg-[rgba(15,19,27,0.5)] px-3 py-2 font-mono text-[11px] uppercase tracking-[0.22em] text-[var(--ink)] outline-none transition-colors focus:border-[var(--cyan)]"
                        >
                          {VOICE_PRESETS.map((p) => (
                            <option key={p.id} value={p.id}>{p.label} — {p.hint}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Custom — free-form YouTube search query */}
                    {voiceMode === 'custom' && (
                      <div className="mt-2">
                        <input
                          type="text"
                          value={voiceCustomQuery}
                          onChange={(e) => setVoiceCustomQuery(e.target.value)}
                          placeholder="e.g. Cate Blanchett interview narration"
                          maxLength={200}
                          className="w-full border border-[var(--line)] bg-[rgba(15,19,27,0.5)] px-3 py-2 font-mono text-[11px] text-[var(--ink)] outline-none transition-colors focus:border-[var(--cyan)]"
                        />
                        <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
                          tip: use prologue / monologue / interview / audiobook — avoid scene / fight
                        </div>
                      </div>
                    )}

                    {/* Upload — file picker via /api/voice-upload */}
                    {voiceMode === 'upload' && (
                      <div className="mt-2">
                        <label className="flex cursor-pointer items-center justify-between border border-[var(--line)] bg-[rgba(15,19,27,0.5)] px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.24em] text-[var(--ink-dim)] transition-colors hover:border-[var(--cyan)] hover:text-[var(--cyan)]">
                          <span>{voiceUploadPath ? voiceUploadLabel || 'uploaded' : (voiceUploading ? 'uploading…' : 'pick a wav/mp3 file')}</span>
                          <span className="text-[var(--ink-faint)]">{voiceUploadPath ? '✓' : '+ choose'}</span>
                          <input
                            type="file"
                            accept="audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg,.wav,.mp3,.m4a,.ogg"
                            disabled={voiceUploading}
                            className="hidden"
                            onChange={async (e) => {
                              const file = e.target.files?.[0]
                              if (!file) return
                              setVoiceUploadError(null)
                              setVoiceUploading(true)
                              try {
                                const fd = new FormData()
                                fd.append('file', file)
                                const resp = await fetch('/api/voice-upload', {
                                  method: 'POST',
                                  body: fd,
                                })
                                const json = await resp.json()
                                if (!resp.ok || !json.path) {
                                  throw new Error(json.error || `HTTP ${resp.status}`)
                                }
                                setVoiceUploadPath(json.path)
                                setVoiceUploadLabel(file.name.slice(0, 40))
                              } catch (err) {
                                setVoiceUploadError(err instanceof Error ? err.message : String(err))
                                setVoiceUploadPath('')
                                setVoiceUploadLabel('')
                              } finally {
                                setVoiceUploading(false)
                                e.target.value = ''
                              }
                            }}
                          />
                        </label>
                        {voiceUploadError && (
                          <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.22em] text-[#ff5e6c]">
                            upload failed · {voiceUploadError}
                          </div>
                        )}
                        {!voiceUploadError && (
                          <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
                            6-30 s mono-speaker clip · auto-normalised to 24kHz wav
                          </div>
                        )}
                      </div>
                    )}

                    {/* Speed slider — visible whenever cloning is on */}
                    {voiceMode !== 'edge' && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">speed</span>
                        <input
                          type="range"
                          min={0.7}
                          max={1.2}
                          step={0.05}
                          value={voiceCloneSpeed}
                          onChange={(e) => setVoiceCloneSpeed(parseFloat(e.target.value))}
                          className="flex-1 accent-[var(--cyan)]"
                        />
                        <span className="font-mono text-[10px] tabular-nums text-[var(--ink-dim)]">
                          {voiceCloneSpeed.toFixed(2)}×
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Reel-mode subtitle studio — drag the caption around a
                    9:16 stage and tune type/colour/background.  Only
                    visible when the user picked Reel; audiobook/intro
                    keep their own panels below. */}
                {mode === 'reel' && <SectionSep />}
                {mode === 'reel' && (
                  <ReelSubtitlePanel
                    text={fullPath[fullPath.length - 1]?.title || 'subtitle preview'}
                    font={reelFont}
                    onFont={setReelFont}
                    sizePx={reelSize}
                    onSize={setReelSize}
                    color={reelColor}
                    onColor={setReelColor}
                    outlineColor={reelOutlineColor}
                    onOutlineColor={setReelOutlineColor}
                    outlineWidth={reelOutlineWidth}
                    onOutlineWidth={setReelOutlineWidth}
                    bg={reelBg}
                    onBg={setReelBg}
                    weight={reelWeight}
                    onWeight={setReelWeight}
                    xPct={reelXPct}
                    yPct={reelYPct}
                    onPos={(x, y) => { setReelXPct(x); setReelYPct(y) }}
                  />
                )}

                {/* intro-style picker — only meaningful in audiobook mode,
                    intro mode IS the cinematic so a second intro is silly. */}
                {mode === 'audiobook' && <SectionSep />}
                {mode === 'audiobook' && (
                  <div className="pb-4">
                    <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">intro style</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {INTRO_STYLE_OPTIONS.map((s) => {
                        const active = introStyle === s.id
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setIntroStyle(s.id)}
                            className="flex flex-col items-start gap-0.5 border px-2.5 py-1.5 text-left transition-colors"
                            style={{
                              borderColor: active ? 'var(--cyan)' : 'var(--line)',
                              background: active ? 'rgba(79,195,247,0.1)' : 'rgba(15,19,27,0.5)',
                            }}
                          >
                            <span
                              className="font-display text-[11.5px] uppercase tracking-[0.22em]"
                              style={{ color: active ? 'var(--cyan)' : 'var(--ink)' }}
                            >
                              {s.label}
                            </span>
                            <span className="font-mono text-[9px] tracking-[0.14em] text-[var(--ink-faint)] normal-case">
                              {s.hint}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* AI director toggle + manual override panel — only when
                    the marvel template is selected (it's the parametric one). */}
                {mode === 'audiobook' && introStyle === 'marvel' && <SectionSep />}
                {mode === 'audiobook' && introStyle === 'marvel' && (
                  <div className="border border-[var(--line)] bg-[rgba(15,19,27,0.5)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">
                        {autoDirector ? <Sparkles size={11} strokeWidth={1.8} className="text-[var(--cyan)]" /> : <Sliders size={11} strokeWidth={1.8} />}
                        intro director
                      </div>
                      <div className="flex border border-[var(--line)]">
                        <button
                          type="button"
                          onClick={() => setAutoDirector(true)}
                          className="px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.22em] transition-colors"
                          style={{
                            background: autoDirector ? 'rgba(79,195,247,0.14)' : 'transparent',
                            color: autoDirector ? 'var(--cyan)' : 'var(--ink-dim)',
                          }}
                        >
                          auto · hermes ai
                        </button>
                        <button
                          type="button"
                          onClick={() => setAutoDirector(false)}
                          className="border-l border-[var(--line)] px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.22em] transition-colors"
                          style={{
                            background: !autoDirector ? 'rgba(79,195,247,0.14)' : 'transparent',
                            color: !autoDirector ? 'var(--cyan)' : 'var(--ink-dim)',
                          }}
                        >
                          manual
                        </button>
                      </div>
                    </div>

                    {autoDirector ? (
                      <div className="mt-3 font-mono text-[10px] leading-relaxed tracking-[0.12em] text-[var(--ink-faint)] normal-case">
                        AI picks pace, tone, transition and duration based on the
                        story's images and the seed's tonal hints. The decision
                        and reasoning land in the agent ticker.
                      </div>
                    ) : (
                      <div className="mt-3 space-y-3">
                        {/* duration slider */}
                        <div>
                          <div className="mb-1 flex items-center justify-between font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
                            <span>length</span>
                            <span className="text-[var(--ink)]">{introDuration.toFixed(1)}s</span>
                          </div>
                          <input
                            type="range"
                            min={3}
                            max={15}
                            step={0.5}
                            value={introDuration}
                            onChange={(e) => setIntroDuration(parseFloat(e.target.value))}
                            className="w-full accent-[var(--cyan)]"
                          />
                        </div>

                        {/* tone */}
                        <div>
                          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">tone</div>
                          <div className="grid grid-cols-3 gap-1">
                            {INTRO_TONE_OPTIONS.map((t) => {
                              const active = introTone === t.id
                              return (
                                <button
                                  key={t.id}
                                  type="button"
                                  onClick={() => setIntroTone(t.id)}
                                  className="flex items-center gap-1.5 border px-2 py-1.5 text-left transition-colors"
                                  style={{
                                    borderColor: active ? t.swatch : 'var(--line)',
                                    background: active ? 'rgba(255,255,255,0.04)' : 'transparent',
                                  }}
                                >
                                  <span
                                    className="size-2 shrink-0 rounded-full"
                                    style={{ background: t.swatch, boxShadow: active ? `0 0 8px ${t.swatch}` : 'none' }}
                                  />
                                  <span className="font-mono text-[9px] uppercase tracking-[0.14em]" style={{ color: active ? 'var(--ink)' : 'var(--ink-dim)' }}>
                                    {t.label}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        </div>

                        {/* pace + transition row */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">pace</div>
                            <div className="flex border border-[var(--line)]">
                              {INTRO_PACE_OPTIONS.map((p, i) => {
                                const active = introPace === p.id
                                return (
                                  <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => setIntroPace(p.id)}
                                    className="flex-1 px-1.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.18em] transition-colors"
                                    style={{
                                      background: active ? 'rgba(79,195,247,0.14)' : 'transparent',
                                      color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                                      borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
                                    }}
                                    title={p.hint}
                                  >
                                    {p.label}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                          <div>
                            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">transition</div>
                            <div className="flex border border-[var(--line)]">
                              {INTRO_TRANSITION_OPTIONS.map((t, i) => {
                                const active = introTransition === t.id
                                return (
                                  <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => setIntroTransition(t.id)}
                                    className="flex-1 px-1.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.18em] transition-colors"
                                    style={{
                                      background: active ? 'rgba(79,195,247,0.14)' : 'transparent',
                                      color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                                      borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
                                    }}
                                  >
                                    {t.label}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        </div>

                        {/* outro — exit transition into the audiobook body */}
                        <div>
                          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">outro</div>
                          <div className="grid grid-cols-4 gap-1">
                            {INTRO_OUTRO_OPTIONS.map((o) => {
                              const active = introOutro === o.id
                              return (
                                <button
                                  key={o.id}
                                  type="button"
                                  onClick={() => setIntroOutro(o.id)}
                                  className="flex flex-col items-start gap-0.5 border px-2 py-1.5 text-left transition-colors"
                                  style={{
                                    borderColor: active ? 'var(--cyan)' : 'var(--line)',
                                    background: active ? 'rgba(79,195,247,0.1)' : 'transparent',
                                  }}
                                  title={o.hint}
                                >
                                  <span
                                    className="font-mono text-[9.5px] uppercase tracking-[0.18em]"
                                    style={{ color: active ? 'var(--cyan)' : 'var(--ink-dim)' }}
                                  >
                                    {o.label}
                                  </span>
                                  <span className="font-mono text-[8.5px] tracking-[0.12em] text-[var(--ink-faint)] normal-case">
                                    {o.hint}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        </div>

                        {/* intro SFX — synthetic audio synced to image cuts */}
                        <div>
                          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">intro sfx</div>
                          <div className="grid grid-cols-5 gap-1">
                            {INTRO_SFX_OPTIONS.map((s) => {
                              const active = introSfx === s.id
                              return (
                                <button
                                  key={s.id}
                                  type="button"
                                  onClick={() => setIntroSfx(s.id)}
                                  className="flex flex-col items-start gap-0.5 border px-2 py-1.5 text-left transition-colors"
                                  style={{
                                    borderColor: active ? 'var(--cyan)' : 'var(--line)',
                                    background: active ? 'rgba(79,195,247,0.1)' : 'transparent',
                                  }}
                                  title={s.hint}
                                >
                                  <span
                                    className="font-mono text-[9.5px] uppercase tracking-[0.18em]"
                                    style={{ color: active ? 'var(--cyan)' : 'var(--ink-dim)' }}
                                  >
                                    {s.label}
                                  </span>
                                  <span className="font-mono text-[8.5px] tracking-[0.12em] text-[var(--ink-faint)] normal-case">
                                    {s.hint}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        </div>

                        {/* beat transition — how audiobook beats join */}
                        <div>
                          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">beat transition</div>
                          <div className="grid grid-cols-2 gap-1">
                            {BEAT_TRANSITION_OPTIONS.map((b) => {
                              const active = beatTransition === b.id
                              return (
                                <button
                                  key={b.id}
                                  type="button"
                                  onClick={() => setBeatTransition(b.id)}
                                  className="flex flex-col items-start gap-0.5 border px-2 py-1.5 text-left transition-colors"
                                  style={{
                                    borderColor: active ? 'var(--cyan)' : 'var(--line)',
                                    background: active ? 'rgba(79,195,247,0.1)' : 'transparent',
                                  }}
                                  title={b.hint}
                                >
                                  <span
                                    className="font-mono text-[9.5px] uppercase tracking-[0.18em]"
                                    style={{ color: active ? 'var(--cyan)' : 'var(--ink-dim)' }}
                                  >
                                    {b.label}
                                  </span>
                                  <span className="font-mono text-[8.5px] tracking-[0.12em] text-[var(--ink-faint)] normal-case">
                                    {b.hint}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        </div>

                        {/* voice style — TTS prosody profile */}
                        <div>
                          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">voice style</div>
                          <div className="grid grid-cols-4 gap-1">
                            {VOICE_STYLE_OPTIONS.map((v) => {
                              const active = voiceStyle === v.id
                              return (
                                <button
                                  key={v.id}
                                  type="button"
                                  onClick={() => setVoiceStyle(v.id)}
                                  className="flex flex-col items-start gap-0.5 border px-2 py-1.5 text-left transition-colors"
                                  style={{
                                    borderColor: active ? 'var(--cyan)' : 'var(--line)',
                                    background: active ? 'rgba(79,195,247,0.1)' : 'transparent',
                                  }}
                                  title={v.hint}
                                >
                                  <span
                                    className="font-mono text-[9.5px] uppercase tracking-[0.18em]"
                                    style={{ color: active ? 'var(--cyan)' : 'var(--ink-dim)' }}
                                  >
                                    {v.label}
                                  </span>
                                  <span className="font-mono text-[8.5px] tracking-[0.12em] text-[var(--ink-faint)] normal-case">
                                    {v.hint}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        </div>

                        {/* subtitle source + chapter markers row */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">subtitles</div>
                            <div className="flex border border-[var(--line)]">
                              {SUBTITLE_SOURCE_OPTIONS.map((s, i) => {
                                const active = subtitleSource === s.id
                                return (
                                  <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => setSubtitleSource(s.id)}
                                    className="flex-1 px-1.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.18em] transition-colors"
                                    style={{
                                      background: active ? 'rgba(79,195,247,0.14)' : 'transparent',
                                      color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                                      borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
                                    }}
                                    title={s.hint}
                                  >
                                    {s.label}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                          <div>
                            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">chapters</div>
                            <button
                              type="button"
                              onClick={() => setChapterMarkers((v) => !v)}
                              className="w-full border px-3 py-1 font-mono text-[9.5px] uppercase tracking-[0.18em] transition-colors"
                              style={{
                                borderColor: chapterMarkers ? 'var(--cyan)' : 'var(--line)',
                                background: chapterMarkers ? 'rgba(79,195,247,0.14)' : 'transparent',
                                color: chapterMarkers ? 'var(--cyan)' : 'var(--ink-dim)',
                              }}
                            >
                              MPC bookmarks · {chapterMarkers ? 'on' : 'off'}
                            </button>
                          </div>
                        </div>

                        {/* narration translation — Hermes translates body to audio locale before TTS */}
                        <div>
                          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">narration translate</div>
                          <button
                            type="button"
                            onClick={() => setNarrationTranslate((v) => !v)}
                            className="w-full border px-3 py-1.5 text-left transition-colors"
                            style={{
                              borderColor: narrationTranslate ? 'var(--cyan)' : 'var(--line)',
                              background: narrationTranslate ? 'rgba(79,195,247,0.1)' : 'transparent',
                            }}
                            title="Translate body to audio language via Hermes before TTS — keeps spoken line and subtitle in same locale"
                          >
                            <span
                              className="font-mono text-[9.5px] uppercase tracking-[0.18em]"
                              style={{ color: narrationTranslate ? 'var(--cyan)' : 'var(--ink-dim)' }}
                            >
                              translate before tts · {narrationTranslate ? 'on' : 'off'}
                            </span>
                            <div className="font-mono text-[8.5px] tracking-[0.12em] text-[var(--ink-faint)] normal-case">
                              hermes rewrites each beat body to match the audio language
                            </div>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {error && (
                  <div className="flex items-start gap-2 border border-[var(--red)] bg-[rgba(231,76,60,0.08)] px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--red)]">
                    <AlertTriangle size={12} strokeWidth={1.8} className="mt-[1px] shrink-0" />
                    <span className="break-words normal-case tracking-normal">{error}</span>
                  </div>
                )}

                {/* footer */}
                <div className="flex items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
                  <button
                    onClick={close}
                    disabled={busy}
                    className="font-mono text-[10.5px] uppercase tracking-[0.26em] text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)] disabled:opacity-40"
                  >
                    cancel
                  </button>
                  <button
                    onClick={submit}
                    disabled={busy || fullPath.length === 0}
                    className="inline-flex items-center gap-2 border border-[var(--cyan)] bg-[rgba(79,195,247,0.1)] px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.28em] text-[var(--cyan)] transition-colors hover:bg-[rgba(79,195,247,0.2)] disabled:cursor-not-allowed disabled:opacity-50"
                    style={{ clipPath: 'polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%)' }}
                  >
                    {busy ? (
                      <>
                        <Loader2 size={12} strokeWidth={2} className="animate-spin" />
                        rendering…
                      </>
                    ) : (
                      <>
                        <Film size={12} strokeWidth={2} />
                        generate
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Detroit-style section separator — a thin gradient hairline.
 *  Renders as a 1px-tall element so the container's space-y rules
 *  control vertical breathing room consistently across every section
 *  pair (rather than the separator adding its own variable height). */
function SectionSep() {
  return (
    <div
      className="h-px select-none"
      aria-hidden
      style={{
        background:
          'linear-gradient(90deg, transparent 0%, rgba(79,195,247,0.10) 12%, rgba(79,195,247,0.42) 50%, rgba(79,195,247,0.10) 88%, transparent 100%)',
      }}
    />
  )
}

function ModeTab({
  active, icon, label, hint, onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  hint: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors"
      style={{
        background: active ? 'rgba(79,195,247,0.1)' : 'transparent',
        borderRight: '1px solid var(--line)',
      }}
    >
      <span
        className="flex items-center gap-2 font-display text-[11.5px] uppercase tracking-[0.22em]"
        style={{ color: active ? 'var(--cyan)' : 'var(--ink)' }}
      >
        {icon} {label}
      </span>
      <span className="font-mono text-[9.5px] tracking-[0.18em] text-[var(--ink-faint)] normal-case">
        {hint}
      </span>
    </button>
  )
}

// Grid-snap geometry for the Reel preview stage.  The 9:16 mockup is
// quantised so positioning lands on predictable cells instead of pixel-
// perfect drag values that the user can never re-hit.  Choosing 8 cols
// × 16 rows keeps cell aspect close to square (each cell ≈ 0.0625 ×
// 0.0625 of the frame) and matches the user's "8'lik genişlik" hint.
const REEL_GRID_COLS = 8
const REEL_GRID_ROWS = 16
// Caption block always spans this many of REEL_GRID_COLS (centered on
// xPct).  Render side wraps the SRT to a matching character budget so
// preview = render.  6 of 8 means 75% of the 1080px frame = 810px.
const REEL_SUBTITLE_COLS = 6
// A 6-of-8-cell caption fits cleanly into the stage at exactly three
// horizontal positions — left-aligned (cells 0–5), centered (1–6) or
// right-aligned (2–7).  We snap xPct to one of these three so the
// caption clicks into a column block like a jigsaw piece, never lands
// at an awkward fractional cell.  Critically, 0.5 is a valid stop —
// the user's intuitive "drop in the middle" target.
const REEL_SUB_X_POSITIONS = [
  REEL_SUBTITLE_COLS / REEL_GRID_COLS / 2,             // 0.375 — subtitle left edge at column 0
  0.5,                                                  // 0.5  — subtitle centred
  1 - REEL_SUBTITLE_COLS / REEL_GRID_COLS / 2,         // 0.625 — subtitle right edge at column 8
] as const
const snapXPct = (pct: number): number => {
  let best = REEL_SUB_X_POSITIONS[0]
  let bestDist = Infinity
  for (const p of REEL_SUB_X_POSITIONS) {
    const d = Math.abs(p - pct)
    if (d < bestDist) { best = p; bestDist = d }
  }
  return best
}
// Vertical snap is finer-grained: 16 rows → 17 grid lines (0, 1/16,
// 2/16, …, 1).  Caption height fits comfortably in any row band so no
// clamp is needed; the caption may sit slightly off the top/bottom
// edge if the user picks an extreme row, but that's a deliberate
// pick rather than a bug.
const snapYPct = (pct: number): number => {
  const idx = Math.max(0, Math.min(REEL_GRID_ROWS, Math.round(pct * REEL_GRID_ROWS)))
  return idx / REEL_GRID_ROWS
}

function ReelSubtitlePanel(props: {
  text: string
  font: string
  onFont: (id: string) => void
  sizePx: number
  onSize: (n: number) => void
  color: string
  onColor: (c: string) => void
  outlineColor: string
  onOutlineColor: (c: string) => void
  outlineWidth: number
  onOutlineWidth: (n: number) => void
  bg: ReelSubtitleBg
  onBg: (b: ReelSubtitleBg) => void
  weight: ReelSubtitleWeight
  onWeight: (w: ReelSubtitleWeight) => void
  xPct: number
  yPct: number
  onPos: (x: number, y: number) => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  const fontStack = REEL_FONT_PRESETS.find((f) => f.id === props.font)?.stack || ''
  // The mockup is 180px wide → preview type scales as `mockupW / outputW`
  // (1080).  56px in the output reads as ~9px on the mockup.
  const previewSizePx = Math.max(8, props.sizePx * (180 / 1080))
  // Manual pointer-driven drag.  framer-motion's `drag` ran a transform
  // offset on top of style.left/top, so after release the element kept
  // accumulating offsets and the visible caption never matched the
  // displayed xPct/yPct.  This ref-based approach has no transform of
  // its own — during drag we update a live offset state for visual
  // feedback, and on release we commit the final snapped xPct/yPct
  // through onPos and zero the offset in the same render.
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragStartRef = useRef<{
    startCx: number
    startCy: number
    startClientX: number
    startClientY: number
    pointerId: number
  } | null>(null)

  const onCaptionPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    dragStartRef.current = {
      startCx: props.xPct * rect.width,
      startCy: props.yPct * rect.height,
      startClientX: e.clientX,
      startClientY: e.clientY,
      pointerId: e.pointerId,
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }

  const onCaptionPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragStartRef.current
    if (!s || s.pointerId !== e.pointerId) return
    setDragOffset({
      x: e.clientX - s.startClientX,
      y: e.clientY - s.startClientY,
    })
  }

  const onCaptionPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = dragStartRef.current
    if (!s || s.pointerId !== e.pointerId) return
    const stage = stageRef.current
    if (stage) {
      const rect = stage.getBoundingClientRect()
      const finalCx = s.startCx + (e.clientX - s.startClientX)
      const finalCy = s.startCy + (e.clientY - s.startClientY)
      const rawX = clamp01(finalCx / rect.width)
      const rawY = clamp01(finalCy / rect.height)
      props.onPos(snapXPct(rawX), snapYPct(rawY))
    }
    setDragOffset({ x: 0, y: 0 })
    dragStartRef.current = null
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const padding = props.bg === 'none' ? '0' : props.bg === 'box' ? '4px 8px' : '4px 10px'
  const bgFill =
    props.bg === 'none' ? 'transparent'
      : props.bg === 'box' ? 'rgba(0,0,0,0.7)'
      : 'rgba(0,0,0,0.45)'
  const radius = props.bg === 'blur-pill' ? 999 : 0
  // Hard-code the preview's text-shadow outline; libass renders this
  // as the actual outline style at render time.
  const ow = props.outlineWidth
  const textShadow = ow > 0
    ? [
        `${ow}px ${ow}px 0 ${props.outlineColor}`,
        `-${ow}px ${ow}px 0 ${props.outlineColor}`,
        `${ow}px -${ow}px 0 ${props.outlineColor}`,
        `-${ow}px -${ow}px 0 ${props.outlineColor}`,
      ].join(',')
    : 'none'

  return (
    <div className="border border-[var(--line)] bg-[rgba(15,19,27,0.5)] p-3">
      <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-[var(--ink-faint)]">
        <Smartphone size={11} strokeWidth={1.8} className="text-[var(--cyan)]" />
        compose your story as a reel
      </div>
      <div className="flex gap-3">
        {/* 9:16 mockup stage */}
        <div
          ref={stageRef}
          className="relative shrink-0 select-none overflow-hidden border border-[var(--line)]"
          style={{
            width: 180,
            aspectRatio: '9/16',
            background:
              'radial-gradient(120% 80% at 30% 30%, rgba(79,195,247,0.18), transparent 60%),' +
              'radial-gradient(140% 100% at 70% 80%, rgba(245,197,66,0.08), transparent 60%),' +
              'linear-gradient(135deg,#1a2030,#0a0d12)',
          }}
          onPointerDownCapture={(e: ReactPointerEvent<HTMLDivElement>) => {
            // Click-to-place — same snap as drag end so tapping a row
            // snaps the caption into it.  X collapses to one of the
            // three valid 6-cell stops; Y rides the 16-row grid line.
            if ((e.target as HTMLElement).closest('[data-reel-caption]')) return
            const rect = stageRef.current?.getBoundingClientRect()
            if (!rect) return
            const rawX = clamp01((e.clientX - rect.left) / rect.width)
            const rawY = clamp01((e.clientY - rect.top) / rect.height)
            props.onPos(snapXPct(rawX), snapYPct(rawY))
          }}
        >
          {/* Grid overlay — 8 columns × 16 rows of faint white hairlines
              so the user can SEE which cells the caption snaps to.  The
              center axis is brighter to highlight the natural 50/50
              anchor people gravitate toward. */}
          {Array.from({ length: REEL_GRID_COLS - 1 }).map((_, i) => (
            <div
              key={`gx-${i}`}
              className="pointer-events-none absolute inset-y-0 w-px"
              style={{
                left: `${((i + 1) / REEL_GRID_COLS) * 100}%`,
                background: i + 1 === REEL_GRID_COLS / 2 ? 'rgba(79,195,247,0.22)' : 'rgba(255,255,255,0.07)',
              }}
            />
          ))}
          {Array.from({ length: REEL_GRID_ROWS - 1 }).map((_, i) => (
            <div
              key={`gy-${i}`}
              className="pointer-events-none absolute inset-x-0 h-px"
              style={{
                top: `${((i + 1) / REEL_GRID_ROWS) * 100}%`,
                background: i + 1 === REEL_GRID_ROWS / 2 ? 'rgba(79,195,247,0.22)' : 'rgba(255,255,255,0.05)',
              }}
            />
          ))}
          <div
            data-reel-caption
            onPointerDown={onCaptionPointerDown}
            onPointerMove={onCaptionPointerMove}
            onPointerUp={onCaptionPointerUp}
            onPointerCancel={onCaptionPointerUp}
            className="absolute cursor-grab text-center break-words touch-none active:cursor-grabbing"
            style={{
              // Caption block is ALWAYS 6/8 grid cells wide (75% of
              // the 9:16 frame).  `box-sizing: border-box` makes the
              // padding live INSIDE that 75% so the visible
              // background — pill / box / none — always fills exactly
              // the 6-cell column band, never bleeds past.  Without
              // this, padding pushed the visible frame several pixels
              // wider than the snap target and the user perceived the
              // caption as off-grid even when the snap math was right.
              boxSizing: 'border-box',
              width: `${(REEL_SUBTITLE_COLS / REEL_GRID_COLS) * 100}%`,
              left: `${props.xPct * 100}%`,
              top: `${props.yPct * 100}%`,
              // -50% recentres on (left, top); dragOffset adds the
              // live cursor delta during a drag so the user sees the
              // caption follow their finger.  Both reset to 0 on
              // release, while xPct/yPct update via onPos — element
              // ends up exactly at the snapped cell with no leftover
              // offset (the bug the framer-motion drag had).
              transform: `translate(calc(-50% + ${dragOffset.x}px), calc(-50% + ${dragOffset.y}px))`,
              fontFamily: fontStack || undefined,
              fontSize: previewSizePx,
              fontWeight: props.weight,
              color: props.color,
              textShadow,
              background: bgFill,
              padding,
              borderRadius: radius,
              backdropFilter: props.bg === 'blur-pill' ? 'blur(4px)' : undefined,
              lineHeight: 1.2,
            }}
          >
            {props.text || 'subtitle'}
          </div>
          <div className="pointer-events-none absolute inset-x-2 bottom-1.5 text-center font-mono text-[8px] uppercase tracking-[0.18em] text-[var(--ink-faint)]">
            {(props.xPct * 100).toFixed(0)}% · {(props.yPct * 100).toFixed(0)}%
          </div>
        </div>

        {/* control column */}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          {/* font */}
          <div>
            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">font</div>
            <div className="flex flex-wrap gap-1">
              {REEL_FONT_PRESETS.map((f) => {
                const active = props.font === f.id
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => props.onFont(f.id)}
                    className="border px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.18em] transition-colors"
                    style={{
                      borderColor: active ? 'var(--cyan)' : 'var(--line)',
                      color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                      background: active ? 'rgba(79,195,247,0.1)' : 'transparent',
                      fontFamily: f.stack || undefined,
                    }}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* size + weight */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 flex items-center justify-between font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
                <span>size</span>
                <span className="text-[var(--ink)]">{props.sizePx}px</span>
              </div>
              <input
                type="range"
                min={24}
                max={120}
                step={2}
                value={props.sizePx}
                onChange={(e) => props.onSize(parseInt(e.target.value, 10))}
                className="w-full accent-[var(--cyan)]"
              />
            </div>
            <div>
              <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">weight</div>
              <div className="flex border border-[var(--line)]">
                {REEL_WEIGHT_OPTIONS.map((w, i) => {
                  const active = props.weight === w.id
                  return (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => props.onWeight(w.id)}
                      className="flex-1 px-1 py-1 font-mono text-[9.5px] tracking-[0.18em] transition-colors"
                      style={{
                        background: active ? 'rgba(79,195,247,0.14)' : 'transparent',
                        color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                        borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
                        fontWeight: w.id,
                      }}
                    >
                      {w.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* color + outline color row */}
          <div className="grid grid-cols-2 gap-2">
            <ColorRow
              label="text"
              value={props.color}
              onChange={props.onColor}
            />
            <ColorRow
              label="outline"
              value={props.outlineColor}
              onChange={props.onOutlineColor}
            />
          </div>

          {/* outline width + bg row */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 flex items-center justify-between font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
                <span>outline w</span>
                <span className="text-[var(--ink)]">{props.outlineWidth}</span>
              </div>
              <input
                type="range"
                min={0}
                max={8}
                step={1}
                value={props.outlineWidth}
                onChange={(e) => props.onOutlineWidth(parseInt(e.target.value, 10))}
                className="w-full accent-[var(--cyan)]"
              />
            </div>
            <div>
              <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">background</div>
              <div className="flex border border-[var(--line)]">
                {REEL_BG_OPTIONS.map((b, i) => {
                  const active = props.bg === b.id
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => props.onBg(b.id)}
                      className="flex-1 px-1 py-1 font-mono text-[9.5px] uppercase tracking-[0.18em] transition-colors"
                      style={{
                        background: active ? 'rgba(79,195,247,0.14)' : 'transparent',
                        color: active ? 'var(--cyan)' : 'var(--ink-dim)',
                        borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
                      }}
                      title={b.hint}
                    >
                      {b.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">{label}</div>
      <div className="flex items-center gap-1.5 border border-[var(--line)] px-1.5 py-0.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
          style={{ background: 'transparent' }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange(v)
          }}
          maxLength={7}
          className="w-full bg-transparent font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink)] outline-none"
        />
      </div>
    </div>
  )
}
