#!/usr/bin/env python3
"""
Narrative Context Builder Tool — deterministic grounding brief for a focus
beat inside a branching story tree.

The problem this solves: an LLM asked to brainstorm branches from "Thor
takes it, burns with it" will happily substitute *it* with Mjolnir every
time, because Thor+hammer is the dominant prior.  The only way to prevent
that drift is to hand the model a grounded brief *before* it writes —
"these are the characters you have", "these are the objects the canon
already put on the table", "here is the immediate parent in its own
words".  That is what this tool produces: a structured, machine-built
summary of *what exists in the current world* so the model stops
inventing.

Design notes
------------

- Extracts two kinds of salient tokens from each beat:
  * **characters** — multi-letter Title-Case words that look like names
    (Thor, Hannah, Captain America, Thanos)
  * **objects** — Title-Case multi-word phrases that are not known
    characters (Infinity Gauntlet, Stormbreaker, Golden Ring), plus
    lowercase nouns that recur across scenes (gauntlet, hammer,
    photograph, envelope)
- Sentence-initial capitals are heuristically excluded from the
  character pass so "She turns..." does not register "She" as a
  character — we require a second mention that is not sentence-initial.
- Per entity: ``first_scene``, ``last_scene``, ``mentions``, ``kind``.
- Output ``brief`` is a compact Markdown string (≤2KB) the skill can
  paste into its reasoning without bloating the context window.
- Stateless, stdlib only, no external dependencies.

Input shape
-----------

    {
      "canonBeats": [
        {"id": "n0", "title": "The Gauntlet", "body": "Tony slides the stones..."},
        {"id": "n1", "title": "Hesitate, look at mountain", "body": "Thor stares..."},
        ...
      ],
      "focusBeat": {
        "id": "n2",
        "title": "Thor takes it, burns with it",
        "body": "He clamps the gauntlet shut; the stones' light floods his arm..."
      }
    }

``canonBeats`` walks root → parent-of-focus in order.  The focus beat is
passed separately so the brief can highlight pronouns that refer outside
its own body.
"""

import json
import logging
import re
import unicodedata
from typing import Any, Dict, List, Optional, Set, Tuple

from tools.registry import registry

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tokenisation + filters
# ---------------------------------------------------------------------------

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
_SENT_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+|\n+")

_STOPWORDS: Set[str] = {
    "a", "an", "the", "this", "that", "these", "those", "some", "any",
    "every", "all", "no", "none", "each", "one", "other", "another",
    "of", "in", "on", "at", "by", "to", "for", "with", "without",
    "from", "about", "against", "between", "through", "into", "onto",
    "over", "under", "before", "after", "during", "while", "within",
    "out", "off", "up", "down", "across", "along", "around",
    "and", "or", "but", "if", "so", "than", "then", "though", "although",
    "because", "since", "until", "unless", "whether", "as", "like",
    "i", "me", "my", "you", "your", "he", "him", "his", "she", "her",
    "it", "its", "we", "us", "our", "they", "them", "their",
    "who", "whom", "whose", "which", "what", "where", "when", "why", "how",
    "is", "are", "was", "were", "be", "been", "being", "am",
    "has", "have", "had", "having", "do", "does", "did",
    "will", "would", "shall", "should", "can", "could", "may", "might",
    "there", "here", "yes", "not", "never", "always", "still",
    "just", "only", "even", "also", "too", "back", "away", "now",
    "again", "once", "ever",
}


def _is_upper(ch: str) -> bool:
    return unicodedata.category(ch) == "Lu"


def _sentence_initial_indices(text: str) -> Set[int]:
    """Return a set of character offsets in ``text`` where a new sentence
    begins (offset of the first word-character of each sentence)."""
    starts: Set[int] = set()
    if not text:
        return starts
    pos = 0
    length = len(text)
    while pos < length:
        while pos < length and text[pos].isspace():
            pos += 1
        if pos >= length:
            break
        starts.add(pos)
        # Skip to next sentence boundary
        m = _SENT_BOUNDARY_RE.search(text, pos)
        if not m:
            break
        pos = m.end()
    return starts


def _collect_words(text: str) -> List[Tuple[str, bool]]:
    """Return a list of (word, sentence_initial) pairs from ``text``."""
    out: List[Tuple[str, bool]] = []
    if not text:
        return out
    sent_starts = _sentence_initial_indices(text)
    # Track sentence boundaries cheaply: a word is sentence-initial if its
    # match start is in ``sent_starts``.
    for m in _WORD_RE.finditer(text):
        is_first = m.start() in sent_starts
        out.append((m.group(0), is_first))
    return out


# ---------------------------------------------------------------------------
# Entity extraction
# ---------------------------------------------------------------------------

def _is_title_case_token(tok: str) -> bool:
    return len(tok) >= 2 and _is_upper(tok[0]) and tok[1:].islower()


def _is_all_caps_token(tok: str) -> bool:
    return tok.isupper() and len(tok) >= 3


def _scan_beat(
    idx: int,
    title: str,
    body: str,
    char_counts: Dict[str, Dict[str, Any]],
    object_counts: Dict[str, Dict[str, Any]],
) -> None:
    """Scan one beat's body; update running registries.

    We scan **body only** because titles are noisy: they capitalise
    non-proper-noun words (fonts, user conventions, "Hesitate, look at
    mountain") and produce false-positive entities.  Bodies are running
    prose where Title-Case genuinely signals a proper noun *unless* the
    word is sentence-initial — which we detect explicitly.

    Algorithm:

    - Multi-token Title-Case runs are always proper-noun phrases —
      "Infinity Gauntlet", "Captain America" — even if the first token
      lands at a sentence start (multi-word capitalisation at sentence
      start is not coincidence).
    - Single Title-Case tokens count as proper nouns only when they are
      *not* sentence-initial.  "Thor stared" vs "They stared at Thor"
      — only the second registers.
    - Lowercase recurrent words (length ≥ 4, non-stopword) register as
      motif/object candidates.  Cross-beat recurrence promotes them to
      the objects list in ``_classify``.
    """
    body_toks = _collect_words(body)

    # --- multi-word proper-noun detection (body-only).  Sentence-initial
    # *common* nouns were already lowercased during normalisation, so any
    # Title-Case token remaining here is a proper-noun candidate.
    i = 0
    while i < len(body_toks):
        tok, _sent_init = body_toks[i]
        if _is_title_case_token(tok):
            run = [tok]
            j = i + 1
            while j < len(body_toks) and _is_title_case_token(body_toks[j][0]):
                run.append(body_toks[j][0])
                j += 1
            phrase = " ".join(run)
            entry = char_counts.setdefault(phrase, {
                "name": phrase,
                "first_scene": idx,
                "last_scene": idx,
                "mentions": 0,
            })
            entry["last_scene"] = idx
            entry["mentions"] += 1
            if entry["first_scene"] > idx:
                entry["first_scene"] = idx
            i = j
            continue
        i += 1

    # --- recurrent lowercase noun detection (objects / motifs)
    for tok, _sent_init in body_toks:
        low = tok.lower()
        if len(low) < 4:
            continue
        if low in _STOPWORDS:
            continue
        if _is_title_case_token(tok):
            continue  # handled as proper noun above
        entry = object_counts.setdefault(low, {
            "name": low,
            "first_scene": idx,
            "last_scene": idx,
            "mentions": 0,
            "scenes_hit": set(),
        })
        entry["last_scene"] = idx
        entry["mentions"] += 1
        if entry["first_scene"] > idx:
            entry["first_scene"] = idx
        entry["scenes_hit"].add(idx)


def _classify(
    char_counts: Dict[str, Dict[str, Any]],
    object_counts: Dict[str, Dict[str, Any]],
    total_beats: int,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split proper-noun registry into characters vs objects.

    Heuristic: a multi-word phrase or a single-word name that appears in
    more than one beat reads as a character.  A single-mention Title-Case
    that only appeared once *and* contains lowercase recurrence elsewhere
    (e.g. "Gauntlet" / "gauntlet") gets demoted to an object.
    """
    characters: List[Dict[str, Any]] = []
    objects: List[Dict[str, Any]] = []

    for key, entry in char_counts.items():
        low = key.lower()
        same_as_object = low in object_counts
        # Phrase or multi-scene name → character
        is_phrase = " " in key
        cross_scene = entry["first_scene"] != entry["last_scene"]
        if is_phrase or cross_scene:
            characters.append({**entry, "kind": "character"})
        elif same_as_object:
            # Title-Case variant of a common noun (e.g. "Gauntlet" vs
            # "gauntlet") — treat as an object.  Merge into the object
            # entry so cross-beat presence is captured correctly.
            obj = object_counts[low]
            obj["mentions"] += entry["mentions"]
            obj["first_scene"] = min(obj["first_scene"], entry["first_scene"])
            obj["last_scene"] = max(obj["last_scene"], entry["last_scene"])
            for s in range(entry["first_scene"], entry["last_scene"] + 1):
                obj["scenes_hit"].add(s)
        else:
            characters.append({**entry, "kind": "character"})

    # Promote lowercase recurrent nouns (≥2 scenes) to objects.
    for low, entry in object_counts.items():
        scenes_hit = entry.get("scenes_hit") or set()
        if len(scenes_hit) >= 2:
            clean = {k: v for k, v in entry.items() if k != "scenes_hit"}
            clean["kind"] = "object"
            objects.append(clean)

    characters.sort(key=lambda e: (-e["mentions"], e["first_scene"], e["name"]))
    objects.sort(key=lambda e: (-e["mentions"], e["first_scene"], e["name"]))

    return characters, objects


# ---------------------------------------------------------------------------
# Brief builder
# ---------------------------------------------------------------------------

def _short(text: str, cap: int) -> str:
    text = (text or "").strip().replace("\n", " ")
    return text if len(text) <= cap else text[:cap].rstrip() + "…"


def _build_brief(
    canon_beats: List[Dict[str, Any]],
    focus_beat: Dict[str, Any],
    characters: List[Dict[str, Any]],
    objects: List[Dict[str, Any]],
    signals: Dict[str, Any],
    max_chars: int = 2400,
) -> str:
    lines: List[str] = []
    lines.append("# Canon Context Brief")
    lines.append("")

    # Story fingerprint first — the skill reads this to sense genre,
    # register, and motif carry before drafting anything.
    if signals:
        lines.append("## Story fingerprint")
        reg = signals.get("register_hint", "balanced")
        lines.append(f"- register: **{reg}**")
        lines.append(f"- beats so far: {signals.get('beat_count')}")
        lines.append(
            f"- avg body: {signals.get('avg_body_words')} words · "
            f"avg sentence: {signals.get('avg_sentence_words')} words"
        )
        lines.append(
            f"- proper-noun density: {signals.get('proper_noun_density_per_100_words')} per 100 words"
        )
        mood_arc = signals.get("mood_arc") or []
        if mood_arc:
            lines.append(f"- mood arc: {' → '.join(mood_arc)}")
        motifs_top = signals.get("motifs_top") or []
        if motifs_top:
            carry = ", ".join(
                f"{m['token']} ({m['mentions']}× across {len(m['scenes'])} beats)"
                for m in motifs_top
            )
            lines.append(f"- recurring motifs: {carry}")
        lines.append("")

    if characters:
        lines.append("## Characters on stage")
        for c in characters[:10]:
            span = f"beats {c['first_scene']}-{c['last_scene']}" if c["first_scene"] != c["last_scene"] else f"beat {c['first_scene']}"
            lines.append(f"- **{c['name']}** · {c['mentions']}× · {span}")
        lines.append("")
    if objects:
        lines.append("## Objects in play")
        for o in objects[:10]:
            span = f"beats {o['first_scene']}-{o['last_scene']}" if o["first_scene"] != o["last_scene"] else f"beat {o['first_scene']}"
            lines.append(f"- **{o['name']}** · {o['mentions']}× · {span}")
        lines.append("")
    lines.append("## Canon spine (root → parent of focus)")
    for i, beat in enumerate(canon_beats):
        title = beat.get("title") or f"beat {i}"
        body = _short(beat.get("body") or "", 240)
        lines.append(f"{i}. **{title}**  \n   {body}" if body else f"{i}. **{title}**")
    lines.append("")
    focus_title = focus_beat.get("title") or "(focus)"
    focus_body = _short(focus_beat.get("body") or "", 480)
    lines.append("## Focus beat — resolve pronouns against everything above")
    lines.append(f"> **{focus_title}**")
    if focus_body:
        lines.append(f"> {focus_body}")

    brief = "\n".join(lines)
    if len(brief) > max_chars:
        brief = brief[: max_chars - 1].rstrip() + "…"
    return brief


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def _collect_lowercase_vocab(all_beats: List[Dict[str, Any]]) -> Set[str]:
    """Return every word that appears lowercase anywhere in the corpus.

    Used to disambiguate sentence-initial Title-Case.  A word whose
    lowercase form is present elsewhere is a common noun or sentence
    opener ("Sparks" in one beat, "sparks" elsewhere → not a name).
    A word whose lowercase form is never used is treated as a proper
    noun even on a single mention.
    """
    vocab: Set[str] = set()
    for beat in all_beats:
        for text in (beat.get("title", ""), beat.get("body", "")):
            for m in _WORD_RE.finditer(str(text)):
                tok = m.group(0)
                # Only register truly-lowercase occurrences — mid-sentence,
                # clearly not a proper noun.
                if tok.islower():
                    vocab.add(tok)
    return vocab


def _story_signals(all_beats: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compact statistical fingerprint of the canon.

    The skill uses this to infer *register* (clipped action vs long lyrical
    prose), *cadence* (what kind of beat typically follows) and *motif
    carry* (what symbols the caller keeps coming back to).  Stateless,
    stdlib only.
    """
    if not all_beats:
        return {}

    total_body_words = 0
    total_body_sentences = 0
    proper_noun_total = 0
    mood_arc: List[str] = []
    lowercase_counter: Dict[str, int] = {}
    lowercase_scenes: Dict[str, Set[int]] = {}

    for idx, beat in enumerate(all_beats):
        body = str(beat.get("body", "") or "")
        words = list(_WORD_RE.finditer(body))
        total_body_words += len(words)
        total_body_sentences += max(1, len(list(_SENT_BOUNDARY_RE.finditer(body))) + 1) if body else 0
        for m in words:
            tok = m.group(0)
            low = tok.lower()
            if _is_title_case_token(tok):
                proper_noun_total += 1
                continue
            if len(low) < 4 or low in _STOPWORDS:
                continue
            lowercase_counter[low] = lowercase_counter.get(low, 0) + 1
            lowercase_scenes.setdefault(low, set()).add(idx)

        mood = beat.get("mood")
        if isinstance(mood, str) and mood.strip():
            mood_arc.append(mood.strip().lower())

    avg_words = total_body_words / len(all_beats) if all_beats else 0
    avg_sentence_words = (
        total_body_words / total_body_sentences if total_body_sentences else 0
    )
    proper_noun_density = (
        proper_noun_total * 100.0 / total_body_words if total_body_words else 0.0
    )

    # Motif carry: words in ≥ 2 scenes, sorted by cross-scene breadth then raw count.
    motifs = []
    for low, scenes in lowercase_scenes.items():
        if len(scenes) < 2:
            continue
        motifs.append({
            "token": low,
            "scenes": sorted(scenes),
            "mentions": lowercase_counter[low],
            "carryStrength": round(len(scenes) / len(all_beats), 3),
        })
    motifs.sort(key=lambda m: (-m["carryStrength"], -m["mentions"], m["token"]))

    # Register hints — cheap heuristics.  Short average sentences + high
    # proper-noun density leans cinematic / action-driven.  Long sentences
    # + low density leans literary / internal.
    register = "balanced"
    if avg_sentence_words > 0:
        if avg_sentence_words < 12 and proper_noun_density > 4:
            register = "cinematic-action"
        elif avg_sentence_words > 22:
            register = "literary-interior"
        elif proper_noun_density > 8:
            register = "named-ensemble"

    return {
        "beat_count": len(all_beats),
        "avg_body_words": round(avg_words, 1),
        "avg_sentence_words": round(avg_sentence_words, 1),
        "proper_noun_density_per_100_words": round(proper_noun_density, 2),
        "mood_arc": mood_arc,
        "register_hint": register,
        "motifs_top": motifs[:5],
    }


def _handle_context_builder(args: Dict[str, Any]) -> str:
    canon_beats_in = args.get("canonBeats")
    focus_beat = args.get("focusBeat")
    if not isinstance(canon_beats_in, list):
        return json.dumps({"error": "canonBeats must be an array of {id, title, body} objects."})
    if not isinstance(focus_beat, dict):
        return json.dumps({"error": "focusBeat must be an object with at least title and body."})

    try:
        max_chars = int(args.get("max_brief_chars", 1800))
    except (TypeError, ValueError):
        max_chars = 1800
    if max_chars < 300:
        max_chars = 300

    all_beats = [*canon_beats_in, focus_beat]

    # Corpus-wide lowercase vocabulary — lets us rescue single-mention
    # proper nouns like "Thor" (never lowercase) while dropping
    # common-noun sentence openers like "Sparks" / "She" (have a
    # lowercase twin elsewhere or are obvious pronouns).
    lowercase_vocab = _collect_lowercase_vocab(all_beats)

    # Pre-filter body tokens: replace sentence-initial Title-Case tokens
    # whose lowercase form appears elsewhere OR is a stopword with a
    # marker that ``_scan_beat`` treats as non-proper-noun.  We do this
    # by substituting those words with their lowercase form before
    # scanning — cheap and localised.
    def _normalise_beat(beat: Dict[str, Any]) -> Dict[str, Any]:
        new_body = beat.get("body", "") or ""
        sent_starts = _sentence_initial_indices(new_body)
        # Build a new string with sentence-initial common-nouns lowered.
        result: List[str] = []
        cursor = 0
        for m in _WORD_RE.finditer(new_body):
            result.append(new_body[cursor : m.start()])
            tok = m.group(0)
            if (
                m.start() in sent_starts
                and _is_title_case_token(tok)
                and (tok.lower() in lowercase_vocab or tok.lower() in _STOPWORDS)
            ):
                result.append(tok.lower())
            else:
                result.append(tok)
            cursor = m.end()
        result.append(new_body[cursor:])
        return {**beat, "body": "".join(result)}

    normalised_beats = [_normalise_beat(b) for b in all_beats]

    char_counts: Dict[str, Dict[str, Any]] = {}
    object_counts: Dict[str, Dict[str, Any]] = {}
    for idx, beat in enumerate(normalised_beats):
        title = str(beat.get("title", "") or "")
        body = str(beat.get("body", "") or "")
        _scan_beat(idx, title, body, char_counts, object_counts)

    characters, objects = _classify(char_counts, object_counts, len(all_beats))
    signals = _story_signals(all_beats)
    brief = _build_brief(canon_beats_in, focus_beat, characters, objects, signals, max_chars=max_chars)

    return json.dumps({
        "brief": brief,
        "entities": [*characters, *objects],
        "signals": signals,
        "character_count": len(characters),
        "object_count": len(objects),
        "beat_count": len(all_beats),
        "params_used": {"max_brief_chars": max_chars},
    })


def check_context_builder_requirements() -> bool:
    return True


# ---------------------------------------------------------------------------
# OpenAI Function-Calling Schema
# ---------------------------------------------------------------------------

NARRATIVE_CONTEXT_BUILDER_SCHEMA = {
    "name": "narrative_context_builder",
    "description": (
        "Build a compact grounding brief for a focus beat inside a branching "
        "story tree.  Call this BEFORE any narrative generation skill "
        "(brainstorm, writer-assist, rewriter, writer) so the model resolves "
        "ambiguous referents (*it*, *he*, *they*) against the actual canon "
        "rather than its training priors.  The brief names characters and "
        "objects on stage, the canon spine up to the focus, and the focus "
        "beat itself with any pronouns it contains.  Stateless, "
        "stdlib-only."
    ),
    "parameters": {
        "type": "object",
        "required": ["canonBeats", "focusBeat"],
        "properties": {
            "canonBeats": {
                "type": "array",
                "description": (
                    "Ordered root → parent-of-focus beats.  Each entry: "
                    "{id (optional), title (string), body (string)}."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                    },
                },
            },
            "focusBeat": {
                "type": "object",
                "description": "The beat whose children are about to be written. {id, title, body}.",
                "properties": {
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                },
            },
            "max_brief_chars": {
                "type": "integer",
                "description": "Cap the markdown brief length.  Default 1800.",
            },
        },
    },
}


registry.register(
    name="narrative_context_builder",
    toolset="narrative",
    schema=NARRATIVE_CONTEXT_BUILDER_SCHEMA,
    handler=_handle_context_builder,
    check_fn=check_context_builder_requirements,
    requires_env=[],
    is_async=False,
    emoji="📜",
)
