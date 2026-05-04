"""Noustiny storybook render tool.

Hermes-registered tool that converts a Noustiny story tree into an mp4
(silent intro / TTS audiobook).  The actual heavy lifting (ffmpeg pipeline +
edge-tts) lives in a standalone FastAPI service at localhost:8643 — this
file is the tool-registry adapter so the agent can dispatch a render and
the gateway logs the action like any other tool call.

Snapshot data is large (100KB-500KB JSON) and would balloon LLM token cost
if passed through the model.  The web app writes the snapshot to disk at
``<NOUSTINY_PROJECT_DIR>/web/.saves/_render_<snapshot_id>.json`` BEFORE
asking the agent to render; the tool handler reads from that path and
forwards to the FastAPI service.  Tool args therefore stay small —
just the snapshot id + render options.

Auth: the FastAPI service binds to localhost only and has no auth (it's a
dev-mode helper).  Cleanup of the temp snapshot file is the caller's
responsibility (web/api/storybook does it after the chat completion
returns).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Set NOUSTINY_PROJECT_DIR to your project root.  The render service writes
# its mp4 output under <project>/web/public/cache/storybook/.
DEFAULT_PROJECT_DIR = os.environ.get("NOUSTINY_PROJECT_DIR", "")
SERVICE_URL_DEFAULT = "http://127.0.0.1:8643/render"

ALLOWED_MODES = {"audiobook", "intro"}
ALLOWED_LANGS = {"tr", "en", "es", "fr", "de"}
ALLOWED_INTRO_STYLES = {"marvel", "detroit", "cinematic", "off"}
ALLOWED_INTRO_PACES = {"fast", "medium", "slow"}
ALLOWED_INTRO_TONES = {
    "marvel-red", "noir-gray", "cinematic-cyan",
    "magical-purple", "hero-gold", "horror-blood",
}
ALLOWED_INTRO_TRANSITIONS = {"cut", "fade", "whip"}
ALLOWED_INTRO_OUTROS = {"hold", "fade-black", "page-close", "split-vertical"}
ALLOWED_INTRO_SFX = {"none", "marvel-jet", "page-turn", "whoosh", "cinematic-rumble"}
ALLOWED_BEAT_TRANSITIONS = {"hardcut", "fade-chapter"}
ALLOWED_VOICE_GENDERS = {"male", "female"}
ALLOWED_VOICE_STYLES = {"narrator", "dramatic", "whisper", "bright"}
ALLOWED_SUBTITLE_SOURCES = {"title", "body-snippet", "none"}
# Reel mode — vertical 9:16 storybook with a styled subtitle track.
# Service.py swaps the canvas to 1080x1920 and skips the cinematic intro
# entirely; orientation is the gate that flips it on.
ALLOWED_ORIENTATIONS = {"landscape", "portrait"}
ALLOWED_REEL_BG = {"none", "box", "blur-pill"}
ALLOWED_REEL_WEIGHTS = {400, 600, 700, 800}


def _project_dir() -> Path:
    return Path(os.environ.get("NOUSTINY_PROJECT_DIR", DEFAULT_PROJECT_DIR)).resolve()


def _service_url() -> str:
    return os.environ.get("NOUSTINY_STORYBOOK_SERVICE", SERVICE_URL_DEFAULT)


def _read_snapshot(snapshot_id: str) -> dict[str, Any]:
    # Restrict to the [A-Za-z0-9_-] charset to block path traversal — the id
    # is filesystem-bound under web/.saves/.
    if not snapshot_id or not all(c.isalnum() or c in "-_" for c in snapshot_id):
        raise ValueError(f"Invalid snapshot_id: {snapshot_id!r}")
    fp = _project_dir() / "web" / ".saves" / f"_render_{snapshot_id}.json"
    if not fp.is_file():
        raise FileNotFoundError(
            f"Snapshot {snapshot_id} not found at {fp}. "
            "Web app should have written this before calling the tool."
        )
    return json.loads(fp.read_text(encoding="utf-8"))


def _post_render(payload: dict[str, Any], timeout: float = 600.0) -> dict[str, Any]:
    """Synchronous HTTP POST to the FastAPI render service.  Uses urllib so
    the tool stays dependency-free — the hermes-agent venv doesn't need
    requests/httpx just for this."""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _service_url(),
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"render service {e.code}: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"render service unreachable at {_service_url()}: {e.reason}. "
            "Start it in WSL: ~/noustiny-storybook/run.sh"
        )
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f"render service returned non-JSON: {raw[:200]}")


# ---------------------------------------------------------------------------
# Schema + handler
# ---------------------------------------------------------------------------

NOUSTINY_STORYBOOK_SCHEMA = {
    "name": "noustiny_storybook",
    "description": (
        "Render a Noustiny story tree into an mp4 storybook. Supports two "
        "modes: 'audiobook' (full root→endpoint path read by TTS) and 'intro' "
        "(last 5 beats as a short cinematic). Uses Microsoft Edge TTS for "
        "narration in 5 languages (tr/en/es/fr/de) plus ffmpeg for video "
        "encoding. The snapshot data is read from disk by the snapshot_id "
        "the web app provides — do not include the snapshot here."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "snapshot_id": {
                "type": "string",
                "description": (
                    "Identifier the web app passed in the user message. "
                    "Used to locate the snapshot file at "
                    "web/.saves/_render_<snapshot_id>.json. "
                    "Letters, digits, dashes, underscores only."
                ),
            },
            "endpoint_id": {
                "type": "string",
                "description": (
                    "Node id where the storybook ends — typically the "
                    "currently-selected beat. The render walks parent "
                    "pointers from this back to the root."
                ),
            },
            "mode": {
                "type": "string",
                "enum": sorted(ALLOWED_MODES),
                "description": (
                    "'audiobook' renders the entire root→endpoint path as "
                    "a TTS-narrated video. 'intro' renders only the last "
                    "5 beats as a short cinematic teaser."
                ),
            },
            "audio": {
                "type": "boolean",
                "description": (
                    "When true, generate TTS narration per beat (body text). "
                    "When false, the video is silent with only on-screen text."
                ),
            },
            "language": {
                "type": "string",
                "enum": sorted(ALLOWED_LANGS),
                "description": (
                    "TTS voice language. Only consulted when audio=true. "
                    "Picks a per-locale Edge neural voice."
                ),
            },
            "intro_style": {
                "type": "string",
                "enum": sorted(ALLOWED_INTRO_STYLES),
                "description": (
                    "High-level preset for the opening montage. "
                    "'marvel' = bordered wordmark + leaves zoom + montage. "
                    "'detroit' = hard cuts + white flashes + slash bars. "
                    "'cinematic' = slow dissolves + letterbox bars. "
                    "'off' = skip intro. Ignored for mode=intro."
                ),
            },
            "intro_duration_secs": {
                "type": "number",
                "minimum": 4,
                "maximum": 18,
                "description": (
                    "Total length of the cinematic intro in seconds. "
                    "Pick based on image count and pace: 5s for 6 images "
                    "at fast pace, 10s for 4 images at medium, etc. "
                    "Don't pad with image_loop just to fill seconds — "
                    "shorter intros land harder."
                ),
            },
            "intro_pace": {
                "type": "string",
                "enum": sorted(ALLOWED_INTRO_PACES),
                "description": (
                    "How fast images cut through the montage. "
                    "'fast' = ~0.4s/image (Marvel rapid montage feel). "
                    "'medium' = ~0.8s/image (cinematic teaser). "
                    "'slow' = ~1.5s/image (dreamy / mood-piece). "
                    "Combine with image_loop=true if you want fast pace "
                    "to keep cycling for a longer total duration."
                ),
            },
            "intro_tone": {
                "type": "string",
                "enum": sorted(ALLOWED_INTRO_TONES),
                "description": (
                    "Colour theme for border, glow and accent slash. "
                    "Pick from story tone:\n"
                    "  'marvel-red' = epic / heroic / superhero\n"
                    "  'hero-gold' = triumphant / mythic / royalty\n"
                    "  'cinematic-cyan' = sci-fi / tech / mystery (default)\n"
                    "  'noir-gray' = dark / detective / dystopian\n"
                    "  'magical-purple' = fantasy / arcane / dream\n"
                    "  'horror-blood' = horror / gore / blood-soaked"
                ),
            },
            "intro_transition": {
                "type": "string",
                "enum": sorted(ALLOWED_INTRO_TRANSITIONS),
                "description": (
                    "How images blend between beats. "
                    "'cut' = hard switch (Marvel rapid montage). "
                    "'fade' = smooth crossfade (cinematic). "
                    "'whip' = fast wipe with motion-blur feel."
                ),
            },
            "intro_outro": {
                "type": "string",
                "enum": sorted(ALLOWED_INTRO_OUTROS),
                "description": (
                    "Exit transition that bridges the intro's settle frame "
                    "to the audiobook body — without one the cut to story "
                    "content lands hard. "
                    "'hold' = no overlay, just an extra beat of breathing room. "
                    "'fade-black' = theatrical curtain to black. "
                    "'page-close' = top + bottom bars meet (book closing). "
                    "'split-vertical' = left + right bars meet (vault close)."
                ),
            },
            "intro_sfx": {
                "type": "string",
                "enum": sorted(ALLOWED_INTRO_SFX),
                "description": (
                    "Synthetic SFX track baked into the intro mp4.  Hits "
                    "are placed at every visual cut (image transition) — "
                    "audio cadence MATCHES image cadence automatically. "
                    "'none' = silent intro. "
                    "'marvel-jet' = quick whip whoosh per cut + final jet "
                    "pass (energetic action / superhero). "
                    "'page-turn' = paper crinkle per cut + sustained "
                    "crinkle on outro (storybook / fantasy). "
                    "'whoosh' = soft low-frequency pass per cut + deep "
                    "ocean settle (cinematic / sci-fi). "
                    "'cinematic-rumble' = no per-cut hits, just one "
                    "sustained low rumble (horror / dread)."
                ),
            },
            "beat_transition": {
                "type": "string",
                "enum": sorted(ALLOWED_BEAT_TRANSITIONS),
                "description": (
                    "How audiobook beats connect to each other. "
                    "'hardcut' = no fade, sharp cuts (urgent / Marvel pace). "
                    "'fade-chapter' = each beat fades in from black and out "
                    "to black — chapter-break feel for storybook narration. "
                    "Per-beat fade duration is derived from the path length: "
                    "longer paths get tighter fades automatically."
                ),
            },
            "voice_gender": {
                "type": "string",
                "enum": sorted(ALLOWED_VOICE_GENDERS),
                "description": (
                    "TTS narrator gender — picks a male or female neural "
                    "voice within the chosen language locale. "
                    "Pick from story tone: "
                    "horror / war / dark detective / dystopian → male "
                    "(gravelly storyteller). "
                    "magical / fairytale / coming-of-age / sci-fi → female "
                    "(warm narrator). "
                    "epic hero / heroic fantasy → male. "
                    "Default if unclear: female."
                ),
            },
            "voice_style": {
                "type": "string",
                "enum": sorted(ALLOWED_VOICE_STYLES),
                "description": (
                    "Prosody profile applied to the TTS voice — drives rate "
                    "and pitch. "
                    "'narrator' = warm storyteller (default), slight slow. "
                    "'dramatic' = heavy & deep, for horror / war / dystopian. "
                    "'whisper' = hushed intimate, for thriller / detective. "
                    "'bright' = lively quick, for fairytale / coming-of-age."
                ),
            },
            "voice_reference_wav": {
                "type": "string",
                "description": (
                    "Optional path to a reference wav for voice cloning. "
                    "When set, the renderer delegates synthesis to the "
                    "voice_clone_synthesize tool (ElevenLabs IVC) instead "
                    "of edge-tts; voice_gender / voice_style become "
                    "fallback-only.  Path may be absolute (preferred) or "
                    "a /cache/voice_uploads/X.wav URL relative to the "
                    "consumer's static dir.  Forward verbatim from the "
                    "caller — never invent or modify."
                ),
            },
            "voice_persona_label": {
                "type": "string",
                "description": (
                    "Optional human-readable persona name "
                    "('Galadriel-style elven sage narrator') shown to the "
                    "agent ticker / job widget when voice cloning is in "
                    "use.  Cosmetic only; does not affect synthesis."
                ),
            },
            "voice_clone_speed": {
                "type": "number",
                "description": (
                    "Optional speech rate multiplier for the cloned voice "
                    "(0.7-1.2; default 0.85).  Lower = more deliberate "
                    "narration; higher = livelier delivery.  Only consulted "
                    "when voice_reference_wav is set."
                ),
            },
            "subtitle_source": {
                "type": "string",
                "enum": sorted(ALLOWED_SUBTITLE_SOURCES),
                "description": (
                    "Which node field populates the on-screen caption. "
                    "'title' = node title verbatim (cinematic identity, but "
                    "may diverge from spoken language). "
                    "'body-snippet' = first sentence of the body text — "
                    "always matches the audio language since both come "
                    "from the same field. "
                    "'none' = no caption. "
                    "DEFAULT for audiobook + audio=true is body-snippet so "
                    "subtitles and narration share the same locale."
                ),
            },
            "chapter_markers": {
                "type": "boolean",
                "description": (
                    "When true, embed FFMETADATA chapter markers keyed to "
                    "each path beat — MPC-HC / VLC / native players show "
                    "clickable section bookmarks in the seek bar. "
                    "Default true for audiobook mode (long content benefits "
                    "from navigation), false for intro mode (too short to "
                    "matter)."
                ),
            },
            "narration_translate": {
                "type": "boolean",
                "description": (
                    "When true, the renderer calls Hermes to translate "
                    "each beat body to the chosen audio language BEFORE "
                    "running TTS, and uses the translation for the "
                    "subtitle too — so spoken line and on-screen caption "
                    "share the same locale.  Set true whenever the "
                    "snapshot's narrative language likely differs from "
                    "the requested `language` (e.g. Turkish bodies + "
                    "language=en).  Default false for same-locale renders."
                ),
            },
            "image_loop": {
                "type": "boolean",
                "description": (
                    "When true, the image stack cycles more than once if "
                    "the duration far exceeds the per-image slot. Use it "
                    "with fast pace + long duration; otherwise leave false."
                ),
            },
            "job_id": {
                "type": "string",
                "description": (
                    "Opaque progress channel id supplied by the UI. When "
                    "the user message includes 'job_id=<hex>', forward it "
                    "verbatim — the render service publishes per-stage "
                    "progress under this id and the bottom-right widget "
                    "polls for live updates. Do not invent or modify it."
                ),
            },
            "orientation": {
                "type": "string",
                "enum": sorted(ALLOWED_ORIENTATIONS),
                "description": (
                    "Output frame orientation.  'landscape' (default) keeps "
                    "the canonical 1920x1080 audiobook flow.  'portrait' = "
                    "Reel mode: 1080x1920 vertical canvas, cinematic intro "
                    "is skipped (service.py forces intro_style=off), beat "
                    "transitions hardcut, and the styled reel_subtitle_* "
                    "track replaces the audiobook drawtext caption.  Forward "
                    "this verbatim from the user message — do NOT invent it."
                ),
            },
            "reel_subtitle_font": {
                "type": ["string", "null"],
                "description": (
                    "Reel-mode subtitle font stack.  Null / omitted = "
                    "system default.  Only consulted when orientation="
                    "portrait."
                ),
            },
            "reel_subtitle_size_px": {
                "type": "number",
                "minimum": 24,
                "maximum": 120,
                "description": (
                    "Reel subtitle size in output pixels (1080x1920 frame). "
                    "56 is the default — bump for shorter captions."
                ),
            },
            "reel_subtitle_color": {
                "type": "string",
                "description": (
                    "Reel subtitle text colour as #rrggbb.  Default #ffffff."
                ),
            },
            "reel_subtitle_outline_color": {
                "type": "string",
                "description": (
                    "Reel subtitle outline colour as #rrggbb.  Default #000000."
                ),
            },
            "reel_subtitle_outline_width": {
                "type": "integer",
                "minimum": 0,
                "maximum": 10,
                "description": (
                    "Reel subtitle outline thickness in pixels.  0 = no "
                    "outline.  Default 3."
                ),
            },
            "reel_subtitle_bg": {
                "type": "string",
                "enum": sorted(ALLOWED_REEL_BG),
                "description": (
                    "Reel subtitle background style.  'blur-pill' = soft "
                    "rounded backdrop (default).  'box' = solid rectangle. "
                    "'none' = outline-only."
                ),
            },
            "reel_subtitle_weight": {
                "type": "integer",
                "enum": sorted(ALLOWED_REEL_WEIGHTS),
                "description": (
                    "Reel subtitle font weight.  Service-side libass takes "
                    "this as a bold flag (>=600 → bold).  Default 700."
                ),
            },
            "reel_subtitle_x_pct": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": (
                    "Reel subtitle horizontal anchor as a fraction of "
                    "frame width (0=left, 0.5=center, 1=right).  Default "
                    "0.50.  Currently informational; libass renders "
                    "Alignment=2 (bottom-center)."
                ),
            },
            "reel_subtitle_y_pct": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": (
                    "Reel subtitle vertical anchor as a fraction of frame "
                    "height (0=top, 1=bottom).  Default 0.78 — eight-tenths "
                    "down for a comfortable thumb zone in 9:16."
                ),
            },
        },
        "required": ["snapshot_id", "endpoint_id", "mode", "audio", "language"],
    },
}


def _handle_storybook(args: dict, **_kw) -> str:
    """Tool handler — reads snapshot from disk, calls render service,
    returns the result serialised as JSON for the agent to summarise."""
    from tools.registry import tool_error

    snapshot_id = args.get("snapshot_id", "")
    endpoint_id = args.get("endpoint_id", "")
    mode = args.get("mode", "audiobook")
    audio = bool(args.get("audio", False))
    language = args.get("language", "en")
    intro_style = args.get("intro_style", "marvel")
    intro_duration_secs = args.get("intro_duration_secs")
    intro_pace = args.get("intro_pace", "medium")
    intro_tone = args.get("intro_tone", "cinematic-cyan")
    intro_transition = args.get("intro_transition", "fade")
    intro_outro = args.get("intro_outro", "hold")
    intro_sfx = args.get("intro_sfx", "marvel-jet")
    beat_transition = args.get("beat_transition", "fade-chapter")
    voice_gender = args.get("voice_gender", "female")
    voice_style = args.get("voice_style", "narrator")
    voice_reference_wav = args.get("voice_reference_wav") or None
    voice_persona_label = args.get("voice_persona_label") or None
    voice_clone_speed = args.get("voice_clone_speed")
    subtitle_source = args.get("subtitle_source", "body-snippet")
    chapter_markers = bool(args.get("chapter_markers", True))
    narration_translate = bool(args.get("narration_translate", False))
    image_loop = bool(args.get("image_loop", False))
    job_id = args.get("job_id") or None
    orientation = args.get("orientation", "landscape")
    reel_subtitle_font = args.get("reel_subtitle_font")
    reel_subtitle_size_px = args.get("reel_subtitle_size_px")
    reel_subtitle_color = args.get("reel_subtitle_color")
    reel_subtitle_outline_color = args.get("reel_subtitle_outline_color")
    reel_subtitle_outline_width = args.get("reel_subtitle_outline_width")
    reel_subtitle_bg = args.get("reel_subtitle_bg")
    reel_subtitle_weight = args.get("reel_subtitle_weight")
    reel_subtitle_x_pct = args.get("reel_subtitle_x_pct")
    reel_subtitle_y_pct = args.get("reel_subtitle_y_pct")

    if mode not in ALLOWED_MODES:
        return tool_error(f"Invalid mode {mode!r}. Use one of {sorted(ALLOWED_MODES)}.")
    if language not in ALLOWED_LANGS:
        return tool_error(f"Invalid language {language!r}. Use one of {sorted(ALLOWED_LANGS)}.")
    if intro_style not in ALLOWED_INTRO_STYLES:
        return tool_error(f"Invalid intro_style {intro_style!r}. Use one of {sorted(ALLOWED_INTRO_STYLES)}.")
    if intro_pace not in ALLOWED_INTRO_PACES:
        return tool_error(f"Invalid intro_pace {intro_pace!r}. Use one of {sorted(ALLOWED_INTRO_PACES)}.")
    if intro_tone not in ALLOWED_INTRO_TONES:
        return tool_error(f"Invalid intro_tone {intro_tone!r}. Use one of {sorted(ALLOWED_INTRO_TONES)}.")
    if intro_transition not in ALLOWED_INTRO_TRANSITIONS:
        return tool_error(f"Invalid intro_transition {intro_transition!r}. Use one of {sorted(ALLOWED_INTRO_TRANSITIONS)}.")
    if intro_outro not in ALLOWED_INTRO_OUTROS:
        return tool_error(f"Invalid intro_outro {intro_outro!r}. Use one of {sorted(ALLOWED_INTRO_OUTROS)}.")
    if intro_sfx not in ALLOWED_INTRO_SFX:
        return tool_error(f"Invalid intro_sfx {intro_sfx!r}. Use one of {sorted(ALLOWED_INTRO_SFX)}.")
    if beat_transition not in ALLOWED_BEAT_TRANSITIONS:
        return tool_error(f"Invalid beat_transition {beat_transition!r}. Use one of {sorted(ALLOWED_BEAT_TRANSITIONS)}.")
    if voice_gender not in ALLOWED_VOICE_GENDERS:
        return tool_error(f"Invalid voice_gender {voice_gender!r}. Use one of {sorted(ALLOWED_VOICE_GENDERS)}.")
    if voice_style not in ALLOWED_VOICE_STYLES:
        return tool_error(f"Invalid voice_style {voice_style!r}. Use one of {sorted(ALLOWED_VOICE_STYLES)}.")
    if subtitle_source not in ALLOWED_SUBTITLE_SOURCES:
        return tool_error(f"Invalid subtitle_source {subtitle_source!r}. Use one of {sorted(ALLOWED_SUBTITLE_SOURCES)}.")
    if intro_duration_secs is not None:
        try:
            intro_duration_secs = float(intro_duration_secs)
        except (TypeError, ValueError):
            return tool_error(f"intro_duration_secs must be a number, got {intro_duration_secs!r}.")
        if not 4.0 <= intro_duration_secs <= 18.0:
            return tool_error(f"intro_duration_secs must be in [4, 18], got {intro_duration_secs}.")
    if not endpoint_id:
        return tool_error("endpoint_id is required.")
    if orientation not in ALLOWED_ORIENTATIONS:
        return tool_error(f"Invalid orientation {orientation!r}. Use one of {sorted(ALLOWED_ORIENTATIONS)}.")
    if reel_subtitle_bg is not None and reel_subtitle_bg not in ALLOWED_REEL_BG:
        return tool_error(f"Invalid reel_subtitle_bg {reel_subtitle_bg!r}. Use one of {sorted(ALLOWED_REEL_BG)}.")
    if reel_subtitle_weight is not None:
        try:
            reel_subtitle_weight = int(reel_subtitle_weight)
        except (TypeError, ValueError):
            return tool_error(f"reel_subtitle_weight must be an integer, got {reel_subtitle_weight!r}.")
        if reel_subtitle_weight not in ALLOWED_REEL_WEIGHTS:
            return tool_error(f"Invalid reel_subtitle_weight {reel_subtitle_weight!r}. Use one of {sorted(ALLOWED_REEL_WEIGHTS)}.")
    if reel_subtitle_size_px is not None:
        try:
            reel_subtitle_size_px = int(float(reel_subtitle_size_px))
        except (TypeError, ValueError):
            return tool_error(f"reel_subtitle_size_px must be a number, got {reel_subtitle_size_px!r}.")
        if not 24 <= reel_subtitle_size_px <= 120:
            return tool_error(f"reel_subtitle_size_px must be in [24, 120], got {reel_subtitle_size_px}.")
    if reel_subtitle_outline_width is not None:
        try:
            reel_subtitle_outline_width = int(reel_subtitle_outline_width)
        except (TypeError, ValueError):
            return tool_error(f"reel_subtitle_outline_width must be an integer, got {reel_subtitle_outline_width!r}.")
        if not 0 <= reel_subtitle_outline_width <= 10:
            return tool_error(f"reel_subtitle_outline_width must be in [0, 10], got {reel_subtitle_outline_width}.")
    for pct_name, pct_val in (
        ("reel_subtitle_x_pct", reel_subtitle_x_pct),
        ("reel_subtitle_y_pct", reel_subtitle_y_pct),
    ):
        if pct_val is None:
            continue
        try:
            v = float(pct_val)
        except (TypeError, ValueError):
            return tool_error(f"{pct_name} must be a number, got {pct_val!r}.")
        if not 0.0 <= v <= 1.0:
            return tool_error(f"{pct_name} must be in [0, 1], got {v}.")

    try:
        snapshot = _read_snapshot(snapshot_id)
    except (ValueError, FileNotFoundError, OSError) as e:
        return tool_error(f"Snapshot read failed: {e}")
    except json.JSONDecodeError as e:
        return tool_error(f"Snapshot JSON invalid: {e}")

    payload: dict[str, Any] = {
        "snapshot": snapshot,
        "endpointId": endpoint_id,
        "mode": mode,
        "audio": audio,
        "language": language,
        "intro_style": intro_style,
        "intro_pace": intro_pace,
        "intro_tone": intro_tone,
        "intro_transition": intro_transition,
        "intro_outro": intro_outro,
        "intro_sfx": intro_sfx,
        "beat_transition": beat_transition,
        "voice_gender": voice_gender,
        "voice_style": voice_style,
        "subtitle_source": subtitle_source,
        "chapter_markers": chapter_markers,
        "narration_translate": narration_translate,
        "image_loop": image_loop,
    }
    if intro_duration_secs is not None:
        payload["intro_duration_secs"] = intro_duration_secs
    if job_id:
        payload["job_id"] = str(job_id)
    # Voice cloning fields — forwarded only when set so the renderer's
    # edge-tts default path stays the only thing in payload for vanilla
    # renders (clone-disabled stories see exactly the same /render call
    # they did before this tool existed).
    if voice_reference_wav:
        payload["voice_reference_wav"] = str(voice_reference_wav)
    if voice_persona_label:
        payload["voice_persona_label"] = str(voice_persona_label)
    if voice_clone_speed is not None:
        payload["voice_clone_speed"] = float(voice_clone_speed)
    payload["orientation"] = orientation
    if reel_subtitle_font is not None:
        payload["reel_subtitle_font"] = reel_subtitle_font
    if reel_subtitle_size_px is not None:
        payload["reel_subtitle_size_px"] = reel_subtitle_size_px
    if reel_subtitle_color is not None:
        payload["reel_subtitle_color"] = reel_subtitle_color
    if reel_subtitle_outline_color is not None:
        payload["reel_subtitle_outline_color"] = reel_subtitle_outline_color
    if reel_subtitle_outline_width is not None:
        payload["reel_subtitle_outline_width"] = reel_subtitle_outline_width
    if reel_subtitle_bg is not None:
        payload["reel_subtitle_bg"] = reel_subtitle_bg
    if reel_subtitle_weight is not None:
        payload["reel_subtitle_weight"] = reel_subtitle_weight
    if reel_subtitle_x_pct is not None:
        payload["reel_subtitle_x_pct"] = float(reel_subtitle_x_pct)
    if reel_subtitle_y_pct is not None:
        payload["reel_subtitle_y_pct"] = float(reel_subtitle_y_pct)
    logger.info(
        "storybook tool dispatch: mode=%s audio=%s lang=%s voice=%s/%s "
        "subtitle=%s chapters=%s intro=%s pace=%s tone=%s trans=%s outro=%s "
        "beat=%s dur=%s loop=%s orientation=%s reel_size=%s reel_bg=%s endpoint=%s",
        mode, audio, language, voice_gender, voice_style, subtitle_source,
        chapter_markers, intro_style, intro_pace, intro_tone, intro_transition,
        intro_outro, beat_transition, intro_duration_secs, image_loop,
        orientation, reel_subtitle_size_px, reel_subtitle_bg, endpoint_id,
    )
    # Mirror the dispatched args to /tmp/noustiny-tool.log so the demo can
    # tail this file and show the AI's exact intro decisions in real time.
    try:
        import datetime as _dt
        with open("/tmp/noustiny-tool.log", "a", encoding="utf-8") as _f:
            _f.write(json.dumps({
                "ts": _dt.datetime.utcnow().isoformat(),
                "mode": mode, "audio": audio, "language": language,
                "intro_style": intro_style, "intro_pace": intro_pace,
                "intro_tone": intro_tone, "intro_transition": intro_transition,
                "intro_outro": intro_outro,
                "intro_sfx": intro_sfx,
                "beat_transition": beat_transition,
                "voice_gender": voice_gender,
                "voice_style": voice_style,
                "subtitle_source": subtitle_source,
                "chapter_markers": chapter_markers,
                "narration_translate": narration_translate,
                "intro_duration_secs": intro_duration_secs,
                "image_loop": image_loop,
                "orientation": orientation,
                "reel_subtitle_size_px": reel_subtitle_size_px,
                "reel_subtitle_bg": reel_subtitle_bg,
                "reel_subtitle_weight": reel_subtitle_weight,
                "endpoint_id": endpoint_id,
                "snapshot_id": snapshot_id,
                "voice_reference_wav": voice_reference_wav,
                "voice_persona_label": voice_persona_label,
                "voice_clone_speed": voice_clone_speed,
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass
    try:
        result = _post_render(payload)
    except RuntimeError as e:
        return tool_error(str(e))

    url = result.get("url")
    pages = result.get("pages")
    duration = result.get("duration_sec")
    if not url:
        return tool_error(f"render service returned no url: {result}")
    return json.dumps({
        "url": url,
        "pages": pages,
        "duration_sec": duration,
    })


def _check_storybook_available() -> bool:
    """Tool is available whenever the FastAPI render service is reachable.
    Cheap socket probe via urllib so we don't pull in extra deps."""
    import socket
    host = "127.0.0.1"
    port = 8643
    try:
        with socket.create_connection((host, port), timeout=0.3):
            return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

from tools.registry import registry  # noqa: E402  (imports at bottom for circular safety)

registry.register(
    name="noustiny_storybook",
    toolset="noustiny",
    schema=NOUSTINY_STORYBOOK_SCHEMA,
    handler=_handle_storybook,
    check_fn=_check_storybook_available,
    emoji="🎬",
)
