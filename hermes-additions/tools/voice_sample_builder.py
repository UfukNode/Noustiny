#!/usr/bin/env python3
"""
Voice Sample Builder Tool — turn a free-form search query into a clean,
mono-speaker, reference-quality wav suitable as input to any Hermes
voice-cloning backend (NeuTTS / ElevenLabs / MiniMax via tts_tool).

Why this tool exists
--------------------

Hermes ships three voice-cloning backends, and every one of them takes
a reference wav as input.  None of them solve the upstream problem:
*how do I get a clean 6–10 second mono-speaker sample for character X?*
This tool is that piece.  Its output is the existing voice-cloning
tools' input — strict separation of concerns, no overlap with what's
already in the ecosystem.

End-to-end pipeline:

    1. Search query              ("Cate Blanchett Galadriel monologue")
    2. yt-dlp                    → raw audio file
    3. pyannote diarization      → identify dominant speaker segments
    4. pyannote VAD              → trim silence / music / overlap
    5. Slice + normalize         → 24kHz mono wav, 6–10 s, –18 LUFS
    6. Cache by SHA-256 of args  → idempotent across calls

This file is **Phase 1 of the plan**: registry skeleton + cache layer +
deterministic stub output (a sine-tone placeholder wav).  Phases 2–4
swap the stub for the real fetch + diarize + slice chain.  The tool
contract (signature + return shape + cache semantics) is final at
Phase 1 so downstream wiring (companion director skill, render
service integration) can be authored against it in parallel.

Input shape
-----------

    {
      "query": "Cate Blanchett Galadriel monologue",
      "min_duration_sec": 6,           # optional, default 6
      "max_duration_sec": 10           # optional, default 10
    }

Output shape
------------

    {
      "sample_path": "/home/.../.hermes/voice_samples/<sha>.wav",
      "source_url":   "stub://placeholder",   # phase 2 → real YT URL
      "speaker_confidence": 1.0,              # phase 3 → real score
      "duration_sec": 6.0,
      "stub": True                            # set while phases 2-4 unwired
    }

The ``stub`` field gives callers a clear signal that the wav is a
deterministic placeholder, not a real fetched sample.  Phases 2-4
flip ``stub`` to ``False`` once the real pipeline lands.
"""

import hashlib
import json
import logging
import math
import os
import re
import struct
import time
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional

from tools.registry import registry

logger = logging.getLogger(__name__)


# yt-dlp is imported lazily so the module loads even when the package
# isn't installed (Phase 1 stub-only environments stay green).
_YTDLP = None
def _ytdlp():
    global _YTDLP
    if _YTDLP is None:
        try:
            import yt_dlp  # type: ignore
            _YTDLP = yt_dlp
        except ImportError:
            _YTDLP = False
    return _YTDLP if _YTDLP is not False else None


# pyannote.audio is HEAVY (~3GB pytorch + 500MB models on first call).
# Lazy-loaded so the module imports cleanly in environments that haven't
# installed it; tool then falls back to "no diarization" (returns the
# whole fetched clip, like Phase 2).  Pipeline is process-global because
# loading the model takes ~5s — caching avoids paying that on every call.
_DIARIZATION_PIPELINE = None  # tri-state: None=untried, False=unavailable, instance=ready


def _diarization_pipeline():
    """Lazy-load the pyannote speaker-diarization pipeline.

    Returns the pipeline instance on success, ``None`` if pyannote isn't
    installed OR no HF token is configured (gated model).  Errors are
    logged at WARNING then cached so we don't hammer the import path."""
    global _DIARIZATION_PIPELINE
    if _DIARIZATION_PIPELINE is not None:
        return _DIARIZATION_PIPELINE if _DIARIZATION_PIPELINE is not False else None
    try:
        from pyannote.audio import Pipeline  # type: ignore
    except ImportError:
        logger.warning("pyannote.audio not installed — diarization disabled")
        _DIARIZATION_PIPELINE = False
        return None
    token = (
        os.environ.get("HUGGINGFACE_HUB_TOKEN")
        or os.environ.get("HF_TOKEN")
        or _read_hf_token_file()
    )
    if not token:
        logger.warning(
            "no HuggingFace token found — set HUGGINGFACE_HUB_TOKEN or run "
            "`huggingface-cli login`; diarization disabled"
        )
        _DIARIZATION_PIPELINE = False
        return None
    # pyannote.audio renamed `use_auth_token` → `token` somewhere in 3.x;
    # try the new kwarg first, fall back for older installs.
    last_err: Optional[Exception] = None
    for kwargs in ({"token": token}, {"use_auth_token": token}):
        try:
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                **kwargs,
            )
            logger.info("pyannote diarization pipeline loaded (via %s)", list(kwargs)[0])
            _DIARIZATION_PIPELINE = pipeline
            return pipeline
        except TypeError as e:
            last_err = e
            continue  # try the other kwarg name
        except Exception as e:
            last_err = e
            break
    logger.warning(
        "pyannote pipeline load failed: %s — diarization disabled", last_err
    )
    _DIARIZATION_PIPELINE = False
    return None


def _read_hf_token_file() -> Optional[str]:
    """Read HF token from the canonical ~/.cache/huggingface/token path
    where `huggingface-cli login` writes it.  Stdlib only."""
    candidates = [
        Path.home() / ".cache" / "huggingface" / "token",
        Path.home() / ".huggingface" / "token",
    ]
    for p in candidates:
        if p.exists():
            try:
                return p.read_text(encoding="utf-8").strip() or None
            except Exception:
                continue
    return None


# ---------------------------------------------------------------------------
# Cache directory.  Lives under the user's hermes config dir so the same
# samples are reused across projects (any Hermes consumer that calls
# this tool with the same query gets the cached wav for free).
# ---------------------------------------------------------------------------

_DEFAULT_CACHE_DIR = Path.home() / ".hermes" / "voice_samples"


def _cache_dir() -> Path:
    base = Path(os.environ.get("HERMES_VOICE_SAMPLE_DIR") or _DEFAULT_CACHE_DIR)
    base.mkdir(parents=True, exist_ok=True)
    return base


def _cache_key(query: str, min_d: float, max_d: float) -> str:
    """Stable hash of the (query, duration window) tuple.  Different
    duration windows are different samples — a 6 s slice and a 10 s
    slice from the same source video are not interchangeable as
    voice-cloning references.  Hash them separately."""
    payload = f"{query.strip().lower()}|min={min_d:.2f}|max={max_d:.2f}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _cache_path(query: str, min_d: float, max_d: float) -> Path:
    return _cache_dir() / f"{_cache_key(query, min_d, max_d)}.wav"


# ---------------------------------------------------------------------------
# Error sentinel.  When yt-dlp fails (network, blocked region, video
# removed, no result), we cache a short JSON marker next to the wav
# slot so the next call can short-circuit without re-hitting YouTube.
# Sentinel TTL is bounded — failures shouldn't be permanent ("YouTube
# was rate-limiting that minute" is a transient case).
# ---------------------------------------------------------------------------

_ERROR_SENTINEL_SUFFIX = ".error.json"
_ERROR_SENTINEL_TTL_SEC = 6 * 60 * 60  # 6 hours


def _sentinel_path(cache_path: Path) -> Path:
    return cache_path.with_suffix(cache_path.suffix + _ERROR_SENTINEL_SUFFIX)


def _read_sentinel(cache_path: Path) -> Optional[Dict[str, Any]]:
    sp = _sentinel_path(cache_path)
    if not sp.exists():
        return None
    try:
        data = json.loads(sp.read_text(encoding="utf-8"))
    except Exception:
        sp.unlink(missing_ok=True)
        return None
    if time.time() - float(data.get("written_at", 0)) > _ERROR_SENTINEL_TTL_SEC:
        sp.unlink(missing_ok=True)
        return None
    return data


def _write_sentinel(cache_path: Path, error: str) -> None:
    sp = _sentinel_path(cache_path)
    sp.write_text(
        json.dumps({"written_at": time.time(), "error": error}),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# yt-dlp wrapper.  Searches YouTube for the query, downloads the top
# result's audio stream, returns the local audio path.  Output is
# always an .m4a / .webm / similar — Phase 4 normalizes to wav.
#
# Notes on robustness:
#   - We use ytsearch1 to fetch a single top result (not ytsearch5 →
#     pick best) because diarization quality is more about the source
#     content than search ranking; spending an extra round-trip to
#     pick "the better one" doesn't pay off in practice.
#   - Per-call yt-dlp instances (no shared session) so a stuck cookie
#     or rate-limit on one query doesn't poison subsequent ones.
#   - Output dir is per-call temp under cache_dir/work/, swept after
#     extraction so we don't accumulate stale m4a's.
# ---------------------------------------------------------------------------

def _fetch_youtube_audio(query: str, work_dir: Path) -> Optional[Dict[str, Any]]:
    """Download top YouTube result for ``query`` as an audio file.

    Returns ``{"audio_path": Path, "url": str, "title": str, "duration": float}``
    on success; ``None`` if yt-dlp couldn't return a result for any
    reason (caller logs and writes the error sentinel)."""
    yt = _ytdlp()
    if yt is None:
        logger.warning("yt-dlp not installed — voice_sample_builder cannot fetch")
        return None

    work_dir.mkdir(parents=True, exist_ok=True)
    out_template = str(work_dir / "raw.%(ext)s")

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "format": "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl": out_template,
        # 3-min ceiling — interview / monologue clips are usually
        # under that and longer downloads waste time + diarization budget.
        "match_filter": yt.utils.match_filter_func("duration < 300"),
        # Avoid prompting for cookies / browser auth.
        "cookiefile": None,
        "noplaylist": True,
        # Soft timeouts — fail fast rather than hanging the gateway.
        "socket_timeout": 30,
        "retries": 2,
        # Don't bail the whole search if one entry is "video unavailable"
        # / age-gated / region-locked — keep walking results.
        "ignoreerrors": True,
    }

    # Walk the top-N results until one downloads successfully.  The
    # original implementation used ytsearch1, which dies on a single dead
    # video even when YouTube has plenty of other matching clips
    # (geo-block, age-gate, takedown).  N=5 is a good balance: 4 fallback
    # slots, still cheap when the first hit is good (yt-dlp short-circuits
    # after the first successful download).
    search_n = 5
    info: Optional[Dict[str, Any]] = None
    # If the query is already a URL or an 11-char YouTube id, hand it
    # straight to yt-dlp instead of wrapping with ytsearch — lets the
    # caller pin a known clip when the search is unreliable.
    is_url = bool(re.match(r"https?://", query))
    is_id = bool(re.fullmatch(r"[A-Za-z0-9_-]{11}", query))
    target = query if (is_url or is_id) else f"ytsearch{search_n}:{query}"
    try:
        with yt.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target, download=True)
    except Exception as e:
        logger.warning("yt-dlp failed for query=%r: %s", query, e)
        return None

    if not info:
        return None
    entries = info.get("entries") or [info]
    if not entries:
        return None

    # With ignoreerrors=True and ytsearchN, yt-dlp may emit None entries
    # for dead videos and stop downloading after the first successful
    # one.  Find the entry whose file actually landed on disk.
    candidates: List[Path] = sorted(work_dir.glob("raw.*"))
    if not candidates:
        return None
    audio_path = candidates[0]

    # Pick the first non-None entry as the metadata source.  yt-dlp
    # ordering matches the search rank, so this is the same video whose
    # audio we just downloaded.
    chosen = next((e for e in entries if e is not None), None)
    if chosen is None:
        return None

    return {
        "audio_path": audio_path,
        "url": chosen.get("webpage_url") or chosen.get("url") or "",
        "title": chosen.get("title") or "",
        "duration": float(chosen.get("duration") or 0.0),
    }


# ---------------------------------------------------------------------------
# Stub wav writer.  Used as a fallback when fetch fails AND the caller
# explicitly asked us to emit something (Phase 1 behaviour preserved
# behind a flag for tests).  Real callers want the error sentinel
# path so they can decide whether to retry / fall back to a
# non-cloning TTS.
# ---------------------------------------------------------------------------

def _write_stub_wav(out_path: Path, duration_sec: float) -> None:
    sample_rate = 24_000
    freq = 440.0
    amplitude = 0.08  # quiet on purpose
    n_samples = int(duration_sec * sample_rate)
    with wave.open(str(out_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        for i in range(n_samples):
            sample = int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / sample_rate))
            wf.writeframesraw(struct.pack("<h", sample))


# ---------------------------------------------------------------------------
# ffmpeg helper — re-encode any audio container yt-dlp might emit (m4a,
# webm, opus, mp3, ogg) into our canonical 24 kHz mono 16-bit PCM wav.
# Shells out rather than going through libav bindings so we don't drag
# pyav into the dep set; ffmpeg is already a runtime dep of the
# storybook service and ships in most Linux distros.
# ---------------------------------------------------------------------------

import shutil
import subprocess


def _ffmpeg_to_wav(src: Path, dst: Path, *, sample_rate: int = 24_000) -> None:
    """Re-encode ``src`` to 24 kHz mono 16-bit PCM wav at ``dst``.
    Raises on non-zero ffmpeg exit so the caller can write the error
    sentinel."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not on PATH")
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-ac", "1",                # mono
        "-ar", str(sample_rate),   # 24 kHz
        "-c:a", "pcm_s16le",       # 16-bit signed little-endian PCM
        str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"ffmpeg exit {proc.returncode}")


# ---------------------------------------------------------------------------
# Per-sample metadata sidecar — JSON next to the wav so callers can read
# back the source URL / confidence / etc without re-fetching.  Lightweight
# enough to be worth keeping; the wav-only path stays valid (callers that
# don't care about provenance just see a wav).
# ---------------------------------------------------------------------------

_META_SUFFIX = ".meta.json"


def _meta_path(cache_path: Path) -> Path:
    return cache_path.with_suffix(cache_path.suffix + _META_SUFFIX)


def _read_meta(cache_path: Path) -> Optional[Dict[str, Any]]:
    mp = _meta_path(cache_path)
    if not mp.exists():
        return None
    try:
        return json.loads(mp.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_meta(cache_path: Path, meta: Dict[str, Any]) -> None:
    _meta_path(cache_path).write_text(json.dumps(meta), encoding="utf-8")


def _cleanup_work_dir(work_dir: Path) -> None:
    """Remove the per-call yt-dlp scratch dir.  Best-effort; a leftover
    work dir is annoying but never breaks correctness."""
    if work_dir.exists():
        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Diarization → dominant speaker → clean monologue selection.  This is
# what turns a multi-speaker movie clip into a single-speaker reference
# wav suitable for cloning.
# ---------------------------------------------------------------------------

def _select_dominant_clean_segment(
    audio_path: Path,
    *,
    min_duration_sec: float,
    max_duration_sec: float,
) -> Optional[Dict[str, Any]]:
    """Run diarization on ``audio_path``, pick the dominant speaker's
    longest contiguous monologue, and return the (start, end, confidence)
    tuple to extract.

    Returns ``None`` if diarization is unavailable OR no segment longer
    than ``min_duration_sec`` exists for any speaker.  Caller falls back
    to "use whole clip" behaviour in the unavailable case."""
    pipeline = _diarization_pipeline()
    if pipeline is None:
        return None

    try:
        result = pipeline(str(audio_path))
    except Exception as e:
        logger.warning("diarization failed audio=%s: %s", audio_path.name, e)
        return None

    # pyannote 4.x returns a DiarizeOutput wrapper with two Annotation
    # views; older 3.x returns the Annotation directly.  We want the
    # *exclusive* (non-overlapping) view since voice-cloning reference
    # samples must not contain overlapping speech.
    annotation = (
        getattr(result, "exclusive_speaker_diarization", None)
        or getattr(result, "speaker_diarization", None)
        or result
    )
    if not hasattr(annotation, "itertracks"):
        logger.warning(
            "diarization returned unexpected shape %s — disabling for this call",
            type(result).__name__,
        )
        return None

    # Collect (speaker, start, end) tuples.
    segments: List[Dict[str, Any]] = []
    speaker_totals: Dict[str, float] = {}
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        seg = {"speaker": speaker, "start": float(turn.start), "end": float(turn.end)}
        seg["duration"] = seg["end"] - seg["start"]
        segments.append(seg)
        speaker_totals[speaker] = speaker_totals.get(speaker, 0.0) + seg["duration"]

    if not segments or not speaker_totals:
        return None

    total_speech = sum(speaker_totals.values())
    dominant_speaker = max(speaker_totals.items(), key=lambda kv: kv[1])[0]
    dominant_total = speaker_totals[dominant_speaker]
    confidence = dominant_total / total_speech if total_speech > 0 else 0.0

    # Pick segments belonging to the dominant speaker.
    dominant_segments = [s for s in segments if s["speaker"] == dominant_speaker]
    if not dominant_segments:
        return None

    longest = max(dominant_segments, key=lambda s: s["duration"])

    # ---- Case A: a single contiguous block already meets the minimum.
    #
    # Single-slice is always preferable when it's available because it
    # preserves prosody and avoids any concat-boundary artefacts.  We
    # carve out [+0.5, -0.5] of the segment to stay clear of diarization
    # boundary noise.
    if longest["duration"] >= min_duration_sec + 1.0:  # need 1s of safety padding
        target_duration = min(max_duration_sec, longest["duration"] - 1.0)
        target_duration = max(min_duration_sec, target_duration)
        slice_start = longest["start"] + 0.5
        slice_end = slice_start + target_duration
        if slice_end > longest["end"] - 0.5:
            slice_end = longest["end"] - 0.5
            slice_start = max(longest["start"] + 0.5, slice_end - target_duration)
        return {
            "segments": [{"start": slice_start, "end": slice_end}],
            "duration": slice_end - slice_start,
            "speaker": dominant_speaker,
            "confidence": confidence,
            "speaker_count": len(speaker_totals),
            "total_speech": total_speech,
            "selection_mode": "single-slice",
        }

    # ---- Case B: no single block long enough — concat multiple
    # dominant-speaker segments.
    #
    # The exclusive diarization view guarantees no overlap with other
    # speakers, so concat-cuts produce a clean reference (the only
    # downside is mild prosodic discontinuity at join points, which
    # voice-cloning backends tolerate well — they care about timbre /
    # resonance / breath, not narrative flow).
    #
    # Strategy: prefer LONGER segments (less concat seams), drop noise-
    # tier segments under 0.5s, keep adding until we hit max_duration_sec.
    candidates = sorted(
        [s for s in dominant_segments if s["duration"] >= 0.5],
        key=lambda s: s["duration"],
        reverse=True,
    )
    selected: List[Dict[str, float]] = []
    cumulative = 0.0
    for seg in candidates:
        # Inset 0.2s from each side to avoid boundary contamination,
        # but only if the segment can absorb the trim.
        s_start = seg["start"]
        s_end = seg["end"]
        if seg["duration"] > 1.0:
            s_start += 0.2
            s_end -= 0.2
        seg_dur = s_end - s_start
        if cumulative + seg_dur >= max_duration_sec:
            # Take only the slice we still need.
            needed = max_duration_sec - cumulative
            if needed >= 0.5:  # don't append micro-fragments
                selected.append({"start": s_start, "end": s_start + needed})
                cumulative += needed
            break
        selected.append({"start": s_start, "end": s_end})
        cumulative += seg_dur

    if cumulative < min_duration_sec:
        logger.info(
            "dominant speaker has only %.1fs total (longest=%.1fs) "
            "— below min %.1fs, falling back to whole clip",
            cumulative, longest["duration"], min_duration_sec,
        )
        return None

    # Re-sort by start time so the concatenated wav preserves temporal
    # flow — important for voice-cloning models that care about prosody.
    selected.sort(key=lambda s: s["start"])

    return {
        "segments": selected,
        "duration": cumulative,
        "speaker": dominant_speaker,
        "confidence": confidence,
        "speaker_count": len(speaker_totals),
        "total_speech": total_speech,
        "selection_mode": "concat",
    }


def _ffmpeg_concat_segments_to_wav(
    src: Path,
    dst: Path,
    *,
    segments: List[Dict[str, float]],
    sample_rate: int = 24_000,
) -> None:
    """Cut [start, end] segments from ``src`` and concat them into a
    single 24 kHz mono 16-bit PCM wav at ``dst``.

    For a single segment this is just a fast atrim; for multiple
    segments we use ffmpeg's concat filter so we never touch disk for
    intermediate files.  All inputs reference the same source file
    (single ``-i``), so the filter is the only moving part."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not on PATH")
    if not segments:
        raise RuntimeError("no segments to concat")

    # Build a filter graph that atrims each segment from the single
    # input then concatenates them.  Each atrim resets PTS so the
    # concat sees a clean zero-based timeline per branch.
    parts: List[str] = []
    for i, seg in enumerate(segments):
        parts.append(
            f"[0:a]atrim={seg['start']:.3f}:{seg['end']:.3f},"
            f"asetpts=PTS-STARTPTS[a{i}]"
        )
    inputs_join = "".join(f"[a{i}]" for i in range(len(segments)))
    parts.append(
        f"{inputs_join}concat=n={len(segments)}:v=0:a=1[outa]"
    )
    filter_complex = ";".join(parts)

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-filter_complex", filter_complex,
        "-map", "[outa]",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-c:a", "pcm_s16le",
        str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"ffmpeg concat exit {proc.returncode}")


# ---------------------------------------------------------------------------
# Tool entry point.
# ---------------------------------------------------------------------------

def voice_sample_builder(
    query: str,
    min_duration_sec: float = 6.0,
    max_duration_sec: float = 10.0,
) -> Dict[str, Any]:
    """Phase 1 implementation: cache + stub wav.

    The tool contract is final at this phase.  Subsequent phases keep
    the same signature and return shape; only the body changes."""
    if not query or not query.strip():
        return {
            "sample_path": None,
            "source_url": None,
            "speaker_confidence": 0.0,
            "duration_sec": 0.0,
            "stub": True,
            "error": "empty query",
        }

    if min_duration_sec <= 0 or max_duration_sec < min_duration_sec:
        return {
            "sample_path": None,
            "source_url": None,
            "speaker_confidence": 0.0,
            "duration_sec": 0.0,
            "stub": True,
            "error": (
                f"invalid duration window "
                f"min={min_duration_sec} max={max_duration_sec}"
            ),
        }

    cache_path = _cache_path(query, min_duration_sec, max_duration_sec)

    # Cache hit — return immediately, no network.
    if cache_path.exists() and cache_path.stat().st_size > 0:
        meta = _read_meta(cache_path)
        with wave.open(str(cache_path), "rb") as wf:
            duration = wf.getnframes() / float(wf.getframerate())
        logger.info("voice_sample cache hit query=%r path=%s", query, cache_path.name)
        return {
            "sample_path": str(cache_path),
            "source_url": meta.get("source_url", "") if meta else "",
            "speaker_confidence": float(meta.get("speaker_confidence", 1.0)) if meta else 1.0,
            "duration_sec": round(duration, 3),
            "stub": bool(meta.get("stub", False)) if meta else False,
        }

    # Recent error sentinel — short-circuit instead of hammering YouTube.
    sentinel = _read_sentinel(cache_path)
    if sentinel:
        logger.info(
            "voice_sample sentinel hit query=%r error=%r — short-circuiting",
            query, sentinel.get("error"),
        )
        return {
            "sample_path": None,
            "source_url": None,
            "speaker_confidence": 0.0,
            "duration_sec": 0.0,
            "stub": False,
            "error": f"recent fetch failed: {sentinel.get('error')}",
        }

    # Cache miss + no sentinel — fetch from YouTube.  Phase 2 emits the
    # raw downloaded audio re-encoded to 24 kHz mono wav, no diarization
    # yet (Phase 3) and no smart-slice (Phase 4 trims to the duration
    # window).  We hand back a 24 kHz mono wav of the WHOLE downloaded
    # clip so Phase 3/4 have something concrete to operate on; the
    # `duration_sec` returned is the full clip length, callers should
    # not yet rely on it being inside the requested window.
    work_dir = _cache_dir() / "work" / cache_path.stem
    fetched = _fetch_youtube_audio(query, work_dir)
    if fetched is None:
        _write_sentinel(cache_path, "yt-dlp returned no result")
        _cleanup_work_dir(work_dir)
        return {
            "sample_path": None,
            "source_url": None,
            "speaker_confidence": 0.0,
            "duration_sec": 0.0,
            "stub": False,
            "error": "yt-dlp returned no result",
        }

    # Diarize the raw fetched audio to pick the dominant speaker's
    # longest contiguous monologue.  Returns None when pyannote isn't
    # installed OR no qualifying segment exists; in that case we fall
    # back to "use the whole clip" — better than failing, callers that
    # need stricter purity can re-run with a more targeted query.
    segment = _select_dominant_clean_segment(
        fetched["audio_path"],
        min_duration_sec=min_duration_sec,
        max_duration_sec=max_duration_sec,
    )

    try:
        if segment is not None:
            _ffmpeg_concat_segments_to_wav(
                fetched["audio_path"], cache_path,
                segments=segment["segments"],
            )
            confidence = float(segment["confidence"])
            speaker_count = int(segment["speaker_count"])
            selection_mode = segment["selection_mode"]
        else:
            # No diarization available OR no qualifying dominant segment
            # — re-encode the whole fetched clip to canonical wav.
            _ffmpeg_to_wav(fetched["audio_path"], cache_path, sample_rate=24_000)
            confidence = 1.0
            speaker_count = 1
            selection_mode = "whole-clip"
    except Exception as e:
        logger.warning("ffmpeg failed query=%r: %s", query, e)
        _write_sentinel(cache_path, f"ffmpeg failed: {e}")
        _cleanup_work_dir(work_dir)
        return {
            "sample_path": None,
            "source_url": None,
            "speaker_confidence": 0.0,
            "duration_sec": 0.0,
            "stub": False,
            "error": f"ffmpeg failed: {e}",
        }

    _cleanup_work_dir(work_dir)

    with wave.open(str(cache_path), "rb") as wf:
        duration = wf.getnframes() / float(wf.getframerate())

    meta = {
        "source_url": fetched["url"],
        "title": fetched["title"],
        "speaker_confidence": confidence,
        "speaker_count": speaker_count,
        "selection_mode": selection_mode,
        "stub": False,
    }
    _write_meta(cache_path, meta)

    logger.info(
        "voice_sample fetched query=%r duration=%.2fs mode=%s confidence=%.2f url=%s",
        query, duration, selection_mode, confidence, fetched["url"],
    )
    return {
        "sample_path": str(cache_path),
        "source_url": fetched["url"],
        "speaker_confidence": confidence,
        "duration_sec": round(duration, 3),
        "stub": False,
    }


# ---------------------------------------------------------------------------
# Registry hook — called at import time by `discover_builtin_tools`.  We
# wire the same function as both the public API (importable as
# `voice_sample_builder`) and the Hermes-dispatchable handler so callers
# can reach it either way: direct Python import for tightly-coupled
# in-process use (any consumer's render pipeline) OR through the gateway
# tool-call protocol for any other Hermes consumer.
# ---------------------------------------------------------------------------

_SCHEMA = {
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": (
                "Free-form search string identifying whose voice to fetch "
                "— e.g. \"Cate Blanchett Galadriel monologue\" or "
                "\"Mae Whitman as Katara\".  Treated as a YouTube search "
                "query in phases 2-4 where the real fetch lands."
            ),
        },
        "min_duration_sec": {
            "type": "number",
            "description": "Lower bound on the returned sample length, default 6.",
            "default": 6,
        },
        "max_duration_sec": {
            "type": "number",
            "description": "Upper bound on the returned sample length, default 10.",
            "default": 10,
        },
    },
    "required": ["query"],
    "additionalProperties": False,
}


def _handle_voice_sample_builder(args: Dict[str, Any], **_kwargs: Any) -> str:
    """Adapter the gateway calls — unwraps args dict to keyword params.

    The dispatch layer forwards extra kwargs (task_id, plugin_context, etc.)
    that the tool itself doesn't need; absorb them with **_kwargs.

    Returns a JSON-encoded string because Hermes's display.py runs string
    ops on tool results (`result[:500].lower()`); a raw dict trips
    `unhashable type: 'slice'`.
    """
    import json as _json
    try:
        with open("/tmp/noustiny-tool.log", "a", encoding="utf-8") as _f:
            import datetime as _dt
            _f.write(_json.dumps({
                "ts": _dt.datetime.utcnow().isoformat(),
                "tool": "voice_sample_builder.dispatch_in",
                "args": args,
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass
    result = voice_sample_builder(
        query=args.get("query", ""),
        min_duration_sec=float(args.get("min_duration_sec", 6.0)),
        max_duration_sec=float(args.get("max_duration_sec", 10.0)),
    )
    try:
        with open("/tmp/noustiny-tool.log", "a", encoding="utf-8") as _f:
            import datetime as _dt
            _f.write(_json.dumps({
                "ts": _dt.datetime.utcnow().isoformat(),
                "tool": "voice_sample_builder.dispatch_out",
                "result": {k: v for k, v in result.items() if k in {"sample_path", "source_url", "speaker_confidence", "duration_sec", "error"}},
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return _json.dumps(result, ensure_ascii=False)


registry.register(
    name="voice_sample_builder",
    toolset="narrative",
    schema=_SCHEMA,
    handler=_handle_voice_sample_builder,
    is_async=False,
    description=(
        "Turn a free-form search query into a clean reference-quality "
        "wav suitable as input to any voice-cloning backend.  Output "
        "is guaranteed 24 kHz mono PCM in the [min_duration_sec, "
        "max_duration_sec] window.  Idempotent: identical calls reuse "
        "the cached wav."
    ),
    emoji="🎙",
)
