#!/usr/bin/env python3
"""
Voice Clone Synthesize Tool — generic Hermes tool that turns
``(text, reference_wav)`` into a synthesized mp3 in the reference
voice via ElevenLabs Instant Voice Cloning.

Why this tool exists
--------------------

``voice_sample_builder`` produces a clean reference wav.  ``tts_tool``
synthesises text but uses a HARDCODED stock voice — not the reference.
This tool fills the gap: takes any reference wav (from
voice_sample_builder, a curated preset, or a user-uploaded clip),
registers it as an ElevenLabs IVC voice, and synthesises arbitrary
text in that voice.

End-to-end pipeline a consumer assembles:

    1. director skill       → search query (or curated/upload bypass)
    2. voice_sample_builder → reference wav
    3. voice_clone_synthesize → mp3 in that voice (this tool)
    4. consumer's ffmpeg pipeline stitches the mp3 into the final reel

Caching strategy
----------------

ElevenLabs IVC takes 3-10 s and consumes a voice slot (free tier = 10).
Most renders synthesise N beats from ONE persona, so we cache the
``voice_id`` keyed by ``sha256(reference_wav_bytes)[:16]``:

  - First call for a reference: clone (slow) + synthesize (fast).
  - Subsequent calls for the same reference: synthesize only (fast).
  - Cache lives at ``~/.hermes/voice_clones/<sha>.json`` with
    ``{voice_id, created_at, last_used}`` so the LRU evictor (separate
    ``voice_clone_cleanup`` tool) can free slots when we hit the cap.

Cross-venv importable
---------------------

Hermes consumers (other Hermes tools, gateway dispatch) AND non-Hermes
consumers (e.g. a render service running in its own venv) can both use
this file:

  - Non-Hermes consumers: ``import voice_clone_synthesize`` after
    putting hermes-agent on ``sys.path``; the registry import is
    gated with try/except so missing Hermes deps don't crash the
    module load.  Pure helpers (``clone_voice``, ``synthesize_with_voice``,
    ``delete_voice``) are importable straight from the module.
  - Hermes consumers: import + the registry hook fires at import time
    so the gateway can dispatch via tool call protocol like any other
    Hermes tool.

API key resolution
------------------

ElevenLabs API key is read from ``ELEVENLABS_API_KEY`` env first, then
from ``~/.hermes/config.yaml`` under ``tts.elevenlabs.api_key`` — this
mirrors the existing tts_tool path so consumers don't need to set yet
another env var.  YAML parsing is hand-rolled (just for this one key)
to avoid making pyyaml a hard dep.

Input shape
-----------

    {
      "text":          "string (what to say in the cloned voice)",
      "reference_wav": "/abs/path/to/ref.wav  OR  /cache/voice_uploads/X.wav",
      "output_path":   "/abs/path/to/out.mp3 (will be overwritten)",
      "speed":         0.85,    // optional, narration default 0.85
      "stability":     0.6,     // optional ElevenLabs voice setting
      "similarity_boost": 0.85, // optional
      "style":         0.3,     // optional
      "use_speaker_boost": true,// optional
      "model_id":      "eleven_multilingual_v2" // optional, supports tr/en/...
    }

Output shape
------------

    {
      "output_path": "/abs/path/to/out.mp3",
      "voice_id":    "abc123def...",
      "from_cache":  true,        // false on the call that triggered cloning
      "duration_sec": 9.34,       // mp3 duration after synthesis
      "bytes_written": 76112,
      "error": null               // populated on failure (output_path will be missing)
    }
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_API_BASE = "https://api.elevenlabs.io/v1"
_HTTP_TIMEOUT_SEC = 60
_DEFAULT_MODEL_ID = "eleven_multilingual_v2"

# Tuned on the Galadriel prologue smoke test — ElevenLabs' own neutral
# defaults (1.0 speed, ~0.5 stability) sound rushed for narration.  These
# are the right anchor for storyteller-register cloning; per-call params
# can override.
_DEFAULT_VOICE_SETTINGS: Dict[str, Any] = {
    "speed": 0.85,
    "stability": 0.6,
    "similarity_boost": 0.85,
    "style": 0.3,
    "use_speaker_boost": True,
}

_CACHE_DIR = Path.home() / ".hermes" / "voice_clones"
_DEFAULT_CACHE_NAME_PREFIX = "noustiny_clone_"


# ---------------------------------------------------------------------------
# API key resolution — env first, then ~/.hermes/config.yaml
# ---------------------------------------------------------------------------

def resolve_api_key() -> Optional[str]:
    """Public so consumers can fail fast when the key is missing without
    actually attempting a synthesis call."""
    key = os.environ.get("ELEVENLABS_API_KEY")
    if key:
        return key.strip() or None
    cfg = Path.home() / ".hermes" / "config.yaml"
    if not cfg.exists():
        return None
    try:
        text = cfg.read_text(encoding="utf-8")
    except Exception:
        return None
    in_tts = False
    in_eleven = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.lstrip()
        if indent == 0:
            in_tts = stripped.startswith("tts:")
            in_eleven = False
            continue
        if in_tts and indent == 2 and stripped.startswith("elevenlabs:"):
            in_eleven = True
            continue
        if in_eleven and indent == 4 and stripped.startswith("api_key:"):
            _, _, val = stripped.partition(":")
            return val.strip().strip('"').strip("'") or None
    return None


# ---------------------------------------------------------------------------
# Reference wav resolution
# ---------------------------------------------------------------------------

def _public_dir_candidates() -> List[Path]:
    """Where Noustiny-style /cache/X paths might be served from.
    Set NOUSTINY_PUBLIC_DIR to your Next-style /public directory.  Generic
    enough for any consumer that uses the /public + /cache convention."""
    candidates: List[Path] = []
    env = os.environ.get("NOUSTINY_PUBLIC_DIR")
    if env:
        candidates.append(Path(env))
    return candidates


def resolve_reference_wav(ref: str) -> Optional[Path]:
    """Resolve a ``reference_wav`` argument to a concrete file path.
    Supports:
      - absolute paths (preferred)
      - /cache/* URLs relative to a Next-style /public dir
      - file:// URLs

    Returns None if the path doesn't exist on disk.  Generic helper —
    consumer's wav location convention is honoured without coupling to
    any one project."""
    if not ref:
        return None
    # file:// URL
    if ref.startswith("file://"):
        ref = ref[len("file://"):]
    p = Path(ref)
    if p.is_absolute() and p.exists():
        return p
    if ref.startswith("/cache/"):
        for base in _public_dir_candidates():
            candidate = base / ref.lstrip("/")
            if candidate.exists():
                return candidate
    if ref.startswith("/"):
        candidate = Path(ref)
        if candidate.exists():
            return candidate
    # Relative-to-cwd as last resort.
    candidate = Path.cwd() / ref
    if candidate.exists():
        return candidate.resolve()
    return None


# ---------------------------------------------------------------------------
# Cache (voice_id keyed by wav SHA)
# ---------------------------------------------------------------------------

def _wav_sha(reference_wav: Path) -> str:
    h = hashlib.sha256()
    with open(reference_wav, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _cache_path(sha: str) -> Path:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _CACHE_DIR / f"{sha}.json"


def cache_get(sha: str) -> Optional[Dict[str, Any]]:
    p = _cache_path(sha)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def cache_set(sha: str, voice_id: str, *, created_at: Optional[float] = None) -> None:
    payload = {
        "sha": sha,
        "voice_id": voice_id,
        "created_at": created_at or time.time(),
        "last_used": time.time(),
    }
    _cache_path(sha).write_text(json.dumps(payload), encoding="utf-8")


def cache_touch(sha: str) -> None:
    """Bump last_used on cache hit so the LRU evictor preserves the
    most-recently-active voices."""
    p = _cache_path(sha)
    if not p.exists():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        data["last_used"] = time.time()
        p.write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass


def cache_drop(sha: str) -> None:
    p = _cache_path(sha)
    p.unlink(missing_ok=True)


def cache_list() -> List[Dict[str, Any]]:
    """Return all cached voice records, newest-last by last_used.  Used
    by the cleanup tool's LRU evictor."""
    if not _CACHE_DIR.exists():
        return []
    out: List[Dict[str, Any]] = []
    for p in _CACHE_DIR.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            out.append(data)
        except Exception:
            continue
    out.sort(key=lambda d: d.get("last_used", 0))
    return out


# ---------------------------------------------------------------------------
# ElevenLabs HTTP — urllib only, no third-party HTTP deps
# ---------------------------------------------------------------------------

def _request(
    method: str,
    path: str,
    *,
    api_key: str,
    json_body: Optional[Dict[str, Any]] = None,
    multipart_fields: Optional[List[Tuple[str, Tuple[Optional[str], Any, Optional[str]]]]] = None,
    extra_headers: Optional[Dict[str, str]] = None,
) -> Tuple[int, bytes, Dict[str, str]]:
    """Minimal urllib-based HTTP helper.  Returns ``(status, body, headers)``.
    No third-party deps so the tool works in any venv that has stdlib."""
    url = f"{_API_BASE}{path}"
    headers: Dict[str, str] = {"xi-api-key": api_key}
    if extra_headers:
        headers.update(extra_headers)
    body: bytes
    if multipart_fields is not None:
        boundary = f"----noustiny{uuid.uuid4().hex}"
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        parts: List[bytes] = []
        for name, (filename, content, ctype) in multipart_fields:
            parts.append(f"--{boundary}\r\n".encode())
            if filename is not None and ctype is not None:
                parts.append(
                    f'Content-Disposition: form-data; name="{name}"; '
                    f'filename="{filename}"\r\n'
                    f"Content-Type: {ctype}\r\n\r\n".encode()
                )
                if isinstance(content, (bytes, bytearray)):
                    parts.append(bytes(content))
                else:
                    parts.append(str(content).encode("utf-8"))
            else:
                parts.append(
                    f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
                )
                parts.append(str(content).encode("utf-8"))
            parts.append(b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
    elif json_body is not None:
        headers.setdefault("Content-Type", "application/json")
        body = json.dumps(json_body).encode("utf-8")
    else:
        body = b""

    req = urllib.request.Request(
        url, data=body if body else None, headers=headers, method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read() or b"", dict(e.headers or {})


# ---------------------------------------------------------------------------
# Core operations — register / synthesise / delete
# ---------------------------------------------------------------------------

def clone_voice(reference_wav: Path, *, api_key: str, name: Optional[str] = None) -> str:
    """Register a wav file as an ElevenLabs Instant Voice Cloning voice
    and return its ``voice_id``.  Caller decides whether to delete the
    voice after use (free tier has 10 voice slots; this tool's cleanup
    companion handles eviction)."""
    if not reference_wav.exists():
        raise FileNotFoundError(f"reference_wav not found: {reference_wav}")
    audio_bytes = reference_wav.read_bytes()
    name = name or f"{_DEFAULT_CACHE_NAME_PREFIX}{uuid.uuid4().hex[:8]}"
    fields = [
        ("name", (None, name, None)),
        ("description", (None, "voice_clone_synthesize tool registration", None)),
        ("files", (reference_wav.name, audio_bytes, "audio/wav")),
    ]
    status, body, _ = _request("POST", "/voices/add", api_key=api_key, multipart_fields=fields)
    if status >= 400:
        raise RuntimeError(f"ElevenLabs IVC add failed: HTTP {status} {body[:300]!r}")
    payload = json.loads(body.decode("utf-8"))
    voice_id = payload.get("voice_id")
    if not voice_id:
        raise RuntimeError(f"IVC add returned no voice_id: {payload!r}")
    return voice_id


def delete_voice(voice_id: str, *, api_key: str) -> bool:
    """Best-effort cleanup of a stored voice.  Returns True on success.
    Errors are logged but never raised — a leftover slot is annoying but
    not a render-breaker."""
    try:
        status, body, _ = _request("DELETE", f"/voices/{voice_id}", api_key=api_key)
        if status >= 400:
            logger.warning(
                "delete voice %s HTTP %d body=%r", voice_id, status, body[:200],
            )
            return False
        return True
    except Exception as e:
        logger.warning("delete voice %s exception: %s", voice_id, e)
        return False


def _synthesize_blocking(
    text: str,
    voice_id: str,
    out_path: Path,
    *,
    api_key: str,
    model_id: str,
    voice_settings: Dict[str, Any],
) -> Tuple[int, Optional[Dict[str, Any]]]:
    """Sync synthesis call.

    Returns (bytes_written, alignment).  ``alignment`` is the per-character
    timing dict returned by ElevenLabs's ``with-timestamps`` endpoint and
    matches the upstream shape exactly:

        {
          "characters": ["A", "a", "n", "g", " ", ...],
          "character_start_times_seconds": [0.0, 0.0464, ...],
          "character_end_times_seconds":   [0.0464, 0.1102, ...],
        }

    Same endpoint, same character count → same billing as the old
    audio-only call; alignment data rides for free.

    May be None if ElevenLabs does not return alignment for this model
    (model_id is the only known omission: very old multilingual_v1).
    Raises on HTTP error so callers can retry.
    """
    body = {
        "text": text,
        "model_id": model_id,
        "voice_settings": voice_settings,
    }
    status, raw, _ = _request(
        "POST",
        # NB: with-timestamps returns JSON with base64-encoded audio +
        # alignment.  Same character count is billed as the audio-only
        # endpoint, so we never lose anything by always asking for it.
        f"/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128",
        api_key=api_key,
        json_body=body,
    )
    if status >= 400:
        raise RuntimeError(f"ElevenLabs TTS HTTP {status}: {raw[:200]!r}")

    try:
        envelope = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise RuntimeError(
            f"ElevenLabs TTS unexpected response (not JSON): {e}; head={raw[:200]!r}"
        )

    audio_b64 = envelope.get("audio_base64") or envelope.get("audio")
    if not isinstance(audio_b64, str) or not audio_b64:
        raise RuntimeError(
            f"ElevenLabs TTS response missing audio_base64 field; keys={list(envelope.keys())}"
        )
    audio_bytes = base64.b64decode(audio_b64)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(audio_bytes)

    # Prefer the normalized alignment when available — it matches the
    # spoken text post-normalisation (numbers spelled out, punctuation
    # collapsed) which is what the user actually hears.  Fall back to
    # the raw alignment when normalized is absent.
    alignment = envelope.get("normalized_alignment") or envelope.get("alignment")
    # Validate shape so downstream consumers can blindly index — drop
    # anything that doesn't have all three parallel arrays.
    if isinstance(alignment, dict):
        chars = alignment.get("characters")
        starts = alignment.get("character_start_times_seconds")
        ends = alignment.get("character_end_times_seconds")
        if not (isinstance(chars, list) and isinstance(starts, list) and isinstance(ends, list)
                and len(chars) == len(starts) == len(ends) and chars):
            alignment = None

    return len(audio_bytes), alignment


async def synthesize_with_voice(
    text: str,
    voice_id: str,
    out_path: Path,
    *,
    api_key: str,
    model_id: str = _DEFAULT_MODEL_ID,
    voice_settings: Optional[Dict[str, Any]] = None,
    max_attempts: int = 3,
) -> Tuple[int, Optional[Dict[str, Any]]]:
    """Async wrapper — runs the blocking call in the default executor so
    FastAPI / asyncio consumers don't stall the event loop while
    ElevenLabs takes 3-8 s to synthesise.  Three attempts with
    exponential backoff before bubbling the last error.

    Returns ``(bytes_written, alignment)`` — alignment is the per-character
    timing dict from ElevenLabs (or None if not available)."""
    settings = dict(_DEFAULT_VOICE_SETTINGS)
    if voice_settings:
        settings.update(voice_settings)
    last_err: Optional[Exception] = None
    loop = asyncio.get_running_loop()
    for attempt in range(1, max_attempts + 1):
        try:
            return await loop.run_in_executor(
                None,
                lambda: _synthesize_blocking(
                    text, voice_id, out_path,
                    api_key=api_key, model_id=model_id, voice_settings=settings,
                ),
            )
        except Exception as e:
            last_err = e
            logger.warning(
                "synthesize_with_voice attempt %d/%d voice=%s: %s",
                attempt, max_attempts, voice_id, e,
            )
            if attempt < max_attempts:
                await asyncio.sleep(min(2 ** attempt, 4))
    raise RuntimeError(f"synthesize_with_voice failed after {max_attempts} tries: {last_err}")


def synthesize_with_voice_blocking(
    text: str,
    voice_id: str,
    out_path: Path,
    *,
    api_key: str,
    model_id: str = _DEFAULT_MODEL_ID,
    voice_settings: Optional[Dict[str, Any]] = None,
    max_attempts: int = 3,
) -> Tuple[int, Optional[Dict[str, Any]]]:
    """Sync variant for consumers not running an event loop.  Same retry
    semantics as the async version.  Returns ``(bytes_written, alignment)``."""
    settings = dict(_DEFAULT_VOICE_SETTINGS)
    if voice_settings:
        settings.update(voice_settings)
    last_err: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        try:
            return _synthesize_blocking(
                text, voice_id, out_path,
                api_key=api_key, model_id=model_id, voice_settings=settings,
            )
        except Exception as e:
            last_err = e
            logger.warning(
                "synthesize_with_voice_blocking attempt %d/%d voice=%s: %s",
                attempt, max_attempts, voice_id, e,
            )
            if attempt < max_attempts:
                time.sleep(min(2 ** attempt, 4))
    raise RuntimeError(f"synthesize_with_voice_blocking failed after {max_attempts} tries: {last_err}")


# ---------------------------------------------------------------------------
# mp3 duration probe (ffprobe shellout, optional — degrades gracefully)
# ---------------------------------------------------------------------------

def _probe_mp3_duration(path: Path) -> Optional[float]:
    """Best-effort duration probe via ffprobe.  Returns None if ffprobe
    is unavailable so consumers without ffmpeg don't crash on this."""
    import shutil as _sh
    import subprocess as _sp
    if _sh.which("ffprobe") is None:
        return None
    try:
        proc = _sp.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True, text=True, timeout=10,
        )
        if proc.returncode == 0:
            return float(proc.stdout.strip())
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Public entry — voice_clone_synthesize
# ---------------------------------------------------------------------------

def voice_clone_synthesize(
    text: str,
    reference_wav: str,
    output_path: str,
    *,
    speed: Optional[float] = None,
    stability: Optional[float] = None,
    similarity_boost: Optional[float] = None,
    style: Optional[float] = None,
    use_speaker_boost: Optional[bool] = None,
    model_id: str = _DEFAULT_MODEL_ID,
) -> Dict[str, Any]:
    """Sync entry — synthesise ``text`` in the reference voice at
    ``output_path``.  Caches voice_id by reference wav SHA so repeat
    calls for the same wav skip the IVC step.  Returns the result dict
    documented at the top of this module.

    Failure modes that produce an ``error`` field instead of raising:
      - missing api key
      - reference wav not found
      - empty text
    Genuine HTTP failures bubble as exceptions (caller can fall back to
    a non-cloning TTS)."""
    if not text or not text.strip():
        return {
            "output_path": None, "voice_id": None, "from_cache": False,
            "duration_sec": 0.0, "bytes_written": 0,
            "error": "empty text",
        }
    api_key = resolve_api_key()
    if not api_key:
        return {
            "output_path": None, "voice_id": None, "from_cache": False,
            "duration_sec": 0.0, "bytes_written": 0,
            "error": "ELEVENLABS_API_KEY not set and not in ~/.hermes/config.yaml",
        }

    ref_path = resolve_reference_wav(reference_wav)
    if ref_path is None:
        return {
            "output_path": None, "voice_id": None, "from_cache": False,
            "duration_sec": 0.0, "bytes_written": 0,
            "error": f"reference_wav not found: {reference_wav!r}",
        }

    sha = _wav_sha(ref_path)
    cached = cache_get(sha)
    if cached and cached.get("voice_id"):
        voice_id = cached["voice_id"]
        from_cache = True
        cache_touch(sha)
    else:
        voice_id = clone_voice(ref_path, api_key=api_key)
        cache_set(sha, voice_id)
        from_cache = False

    settings: Dict[str, Any] = {}
    if speed is not None:
        settings["speed"] = float(speed)
    if stability is not None:
        settings["stability"] = float(stability)
    if similarity_boost is not None:
        settings["similarity_boost"] = float(similarity_boost)
    if style is not None:
        settings["style"] = float(style)
    if use_speaker_boost is not None:
        settings["use_speaker_boost"] = bool(use_speaker_boost)

    out = Path(output_path)
    alignment: Optional[Dict[str, Any]] = None
    try:
        bytes_written, alignment = synthesize_with_voice_blocking(
            text, voice_id, out,
            api_key=api_key, model_id=model_id, voice_settings=settings,
        )
    except RuntimeError as e:
        # Stale voice_id (e.g. cache survived account-side deletion) →
        # drop cache and retry once with a fresh clone.
        msg = str(e)
        if from_cache and ("404" in msg or "voice_not_found" in msg):
            logger.info("stale voice_id %s — re-cloning from reference", voice_id)
            cache_drop(sha)
            voice_id = clone_voice(ref_path, api_key=api_key)
            cache_set(sha, voice_id)
            from_cache = False
            bytes_written, alignment = synthesize_with_voice_blocking(
                text, voice_id, out,
                api_key=api_key, model_id=model_id, voice_settings=settings,
            )
        else:
            raise

    duration = _probe_mp3_duration(out) or 0.0
    return {
        "output_path": str(out),
        "voice_id": voice_id,
        "from_cache": from_cache,
        "duration_sec": round(duration, 3),
        "bytes_written": bytes_written,
        # Per-character alignment from ElevenLabs's with-timestamps endpoint.
        # Shape: {"characters": [...], "character_start_times_seconds": [...],
        #         "character_end_times_seconds": [...]}.  Consumers can group
        # by whitespace to derive word-level timings (chunked SRT, karaoke
        # highlighting, etc.).  None when the model didn't return alignment
        # (rare — only very old multilingual_v1).
        "alignment": alignment,
        "error": None,
    }


# ---------------------------------------------------------------------------
# Cleanup companion — evict cached voices (LRU + by SHA + by voice_id)
# ---------------------------------------------------------------------------

def voice_clone_cleanup(
    *,
    sha: Optional[str] = None,
    voice_id: Optional[str] = None,
    older_than_secs: Optional[float] = None,
    keep_n: Optional[int] = None,
    drop_all: bool = False,
) -> Dict[str, Any]:
    """Evict cached voices.  Filters compose: any combination of
    ``sha`` / ``voice_id`` / ``older_than_secs`` / ``keep_n`` / ``drop_all``
    can be supplied.

      - ``sha``: drop one specific entry (and the ElevenLabs voice).
      - ``voice_id``: same, but matched by ElevenLabs voice_id.
      - ``older_than_secs``: drop entries whose ``last_used`` is older
        than now - older_than_secs.
      - ``keep_n``: keep the N most-recently-used; drop the rest.
      - ``drop_all``: drop everything (use with caution).

    Always tries to delete the corresponding ElevenLabs voice so slots
    free up.  Returns ``{deleted_count, kept_count, errors}``."""
    api_key = resolve_api_key()
    entries = cache_list()
    targets: List[Dict[str, Any]] = []

    if drop_all:
        targets = list(entries)
    else:
        if sha:
            targets += [e for e in entries if e.get("sha") == sha]
        if voice_id:
            targets += [e for e in entries if e.get("voice_id") == voice_id]
        if older_than_secs is not None:
            cutoff = time.time() - float(older_than_secs)
            targets += [e for e in entries if e.get("last_used", 0) < cutoff]
        if keep_n is not None:
            kept = entries[-int(keep_n):] if int(keep_n) > 0 else []
            kept_shas = {e.get("sha") for e in kept}
            targets += [e for e in entries if e.get("sha") not in kept_shas]

    seen: set[str] = set()
    deduped: List[Dict[str, Any]] = []
    for e in targets:
        s = e.get("sha")
        if s in seen:
            continue
        seen.add(s)
        deduped.append(e)

    deleted = 0
    errors: List[str] = []
    for e in deduped:
        s = e.get("sha")
        vid = e.get("voice_id")
        if api_key and vid:
            try:
                delete_voice(vid, api_key=api_key)
            except Exception as exc:
                errors.append(f"voice_id={vid}: {exc}")
        if s:
            cache_drop(s)
        deleted += 1

    return {
        "deleted_count": deleted,
        "kept_count": max(len(entries) - deleted, 0),
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# Hermes registry hook (gated — module loads cleanly outside Hermes venv)
# ---------------------------------------------------------------------------

_SCHEMA_SYNTH = {
    "type": "object",
    "properties": {
        "text": {
            "type": "string",
            "description": "What to say in the cloned voice.",
        },
        "reference_wav": {
            "type": "string",
            "description": (
                "Absolute path to the reference wav (or /cache/... URL "
                "served by the consumer's static dir).  Should be a clean "
                "mono-speaker clip (e.g. from voice_sample_builder)."
            ),
        },
        "output_path": {
            "type": "string",
            "description": "Absolute path to write the resulting mp3.",
        },
        "speed": {"type": "number", "description": "0.7..1.2; default 0.85."},
        "stability": {"type": "number", "description": "0..1; default 0.6."},
        "similarity_boost": {"type": "number", "description": "0..1; default 0.85."},
        "style": {"type": "number", "description": "0..1; default 0.3."},
        "use_speaker_boost": {"type": "boolean", "description": "Default true."},
        "model_id": {
            "type": "string",
            "description": "ElevenLabs model id; default eleven_multilingual_v2.",
        },
    },
    "required": ["text", "reference_wav", "output_path"],
    "additionalProperties": False,
}


_SCHEMA_CLEANUP = {
    "type": "object",
    "properties": {
        "sha": {"type": "string"},
        "voice_id": {"type": "string"},
        "older_than_secs": {"type": "number"},
        "keep_n": {"type": "integer"},
        "drop_all": {"type": "boolean"},
    },
    "additionalProperties": False,
}


def _handle_voice_clone_synthesize(args: Dict[str, Any], **_kwargs: Any) -> str:
    """Hermes display layer string-ops the result, so JSON-encode here."""
    import json as _json
    result = voice_clone_synthesize(
        text=args.get("text", ""),
        reference_wav=args.get("reference_wav", ""),
        output_path=args.get("output_path", ""),
        speed=args.get("speed"),
        stability=args.get("stability"),
        similarity_boost=args.get("similarity_boost"),
        style=args.get("style"),
        use_speaker_boost=args.get("use_speaker_boost"),
        model_id=args.get("model_id") or _DEFAULT_MODEL_ID,
    )
    return _json.dumps(result, ensure_ascii=False)


def _handle_voice_clone_cleanup(args: Dict[str, Any], **_kwargs: Any) -> str:
    import json as _json
    result = voice_clone_cleanup(
        sha=args.get("sha"),
        voice_id=args.get("voice_id"),
        older_than_secs=args.get("older_than_secs"),
        keep_n=args.get("keep_n"),
        drop_all=bool(args.get("drop_all", False)),
    )
    return _json.dumps(result, ensure_ascii=False)


from tools.registry import registry  # type: ignore

registry.register(
    name="voice_clone_synthesize",
    toolset="narrative",
    schema=_SCHEMA_SYNTH,
    handler=_handle_voice_clone_synthesize,
    is_async=False,
    description=(
        "Synthesise text in a cloned voice via ElevenLabs Instant Voice "
        "Cloning.  Pairs with voice_sample_builder: the latter produces "
        "a clean reference wav, this tool turns text + that wav into "
        "an mp3 in the same voice.  Caches voice_id per reference SHA "
        "so repeat calls for the same persona are fast.  Returns "
        "{output_path, voice_id, from_cache, duration_sec, bytes_written}."
    ),
    emoji="🎤",
)
registry.register(
    name="voice_clone_cleanup",
    toolset="narrative",
    schema=_SCHEMA_CLEANUP,
    handler=_handle_voice_clone_cleanup,
    is_async=False,
    description=(
        "Evict cached voice clones (and delete from ElevenLabs).  "
        "Filters compose: sha, voice_id, older_than_secs, keep_n, "
        "drop_all.  Returns {deleted_count, kept_count, errors}."
    ),
    emoji="🧹",
)
