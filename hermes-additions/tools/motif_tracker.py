#!/usr/bin/env python3
"""
Motif Tracker Tool — deterministic recurring-symbol detection across an
ordered list of narrative scenes or beats.

What a narrative writer actually needs from a motif tracker is a grounded,
machine-verifiable answer to the question: *which words recur across this
story, and where?*  LLMs can confabulate — "the raven appears three times"
when it appeared once — which wrecks callback-style writing.  This tool
gives the writer skill a table of real occurrences so callback decisions
are supported by data, not invention.

Design notes
------------

- Input is the ordered canon spine (or any scene sequence) as an array
  of ``{title, body}`` objects.  Each entry is scene index ``i``.
- Tokenisation is lowercase + Unicode word-character split.  We intentionally
  keep the *casing of proper nouns* by preserving the original token form
  when we detect a non-first-word capital in the source — this is cheap,
  stdlib-only NER and good enough for narrative text where proper nouns
  are the dominant motif class.
- Common English stop-words are filtered.  A small extra filter drops
  common narrative verbs ("said", "looked", "turned") because they are
  motion, not motif.
- A token is promoted to a motif when it appears in **at least 2 scenes**
  (not just 2 occurrences in one scene).  This is the single most useful
  knob — cross-scene presence is what makes something a motif rather
  than a beat's local detail.
- ``carryStrength`` is computed as ``scenes_hit / total_scenes``, so a
  token that appears in 3 of 6 scenes has carryStrength 0.5.  It maps
  directly onto "how strong is this motif as a through-line".
- Stateless.  Runs in O(total_token_count).  Stdlib only.
"""

import json
import logging
import re
import unicodedata
from typing import Any, Dict, List, Optional, Set, Tuple

from tools.registry import registry

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

_STOPWORDS: Set[str] = {
    # articles / determiners
    "a", "an", "the", "this", "that", "these", "those", "some", "any",
    "every", "all", "no", "none", "each", "one", "two", "three", "first",
    "second", "own", "other", "another", "such", "same", "very", "most",
    "more", "less", "much", "many", "few", "several", "both",
    # prepositions / conjunctions
    "of", "in", "on", "at", "by", "to", "for", "with", "without",
    "from", "about", "against", "between", "through", "into", "onto",
    "over", "under", "before", "after", "during", "while", "within",
    "out", "off", "up", "down", "across", "along", "around",
    "and", "or", "but", "if", "so", "than", "then", "though", "although",
    "because", "since", "until", "unless", "whether", "as", "like",
    # pronouns
    "i", "me", "my", "mine", "myself",
    "you", "your", "yours", "yourself", "yourselves",
    "he", "him", "his", "himself",
    "she", "her", "hers", "herself",
    "it", "its", "itself",
    "we", "us", "our", "ours", "ourselves",
    "they", "them", "their", "theirs", "themselves",
    "who", "whom", "whose", "which", "what", "where", "when", "why", "how",
    # common auxiliaries / copulas
    "is", "are", "was", "were", "be", "been", "being", "am",
    "has", "have", "had", "having", "do", "does", "did", "doing", "done",
    "will", "would", "shall", "should", "can", "could", "may", "might",
    "must", "ought",
    "get", "got", "gets", "getting",
    "there", "here", "yes", "no", "not", "never", "always", "still",
    "just", "only", "even", "also", "too", "back", "away", "now",
    "again", "once", "twice", "ever",
    # very common narrative verbs that are motion, not motif
    "said", "says", "say", "saying",
    "looks", "looked", "looking", "look",
    "turns", "turned", "turning", "turn",
    "feels", "felt", "feeling", "feel",
    "sees", "saw", "seeing", "see", "seen",
    "knows", "knew", "knowing", "know", "known",
    "thinks", "thought", "thinking", "think",
    "goes", "going", "went", "gone", "go",
    "comes", "came", "coming", "come",
    "takes", "took", "taking", "taken", "take",
    "gives", "gave", "given", "giving", "give",
    "makes", "made", "making", "make",
    "stands", "stood", "standing", "stand",
    "sits", "sat", "sitting", "sit",
    "walks", "walked", "walking", "walk",
    "runs", "ran", "running", "run",
    "opens", "opened", "opening", "open",
    "closes", "closed", "closing", "close",
    "holds", "held", "holding", "hold",
    "reaches", "reached", "reaching", "reach",
    "moves", "moved", "moving", "move",
    "waits", "waited", "waiting", "wait",
    "starts", "started", "starting", "start",
    "stops", "stopped", "stopping", "stop",
    "finds", "found", "finding", "find",
    "leaves", "left", "leaving", "leave",
    # quantity / degree
    "something", "anything", "nothing", "everything",
    "someone", "anyone", "everyone", "nobody",
    "somewhere", "anywhere", "everywhere", "nowhere",
}

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def _is_titlecase_like(original: str) -> bool:
    """Treat a token as a possible proper noun if it starts with an upper
    Unicode letter and contains at least one other letter.  We only use
    this as a mild signal — the primary grouping is by lowercase form."""
    if len(original) < 2:
        return False
    first = original[0]
    category = unicodedata.category(first)
    return category == "Lu"


def _tokenise(text: str) -> List[str]:
    """Return raw word tokens preserving original case."""
    if not text:
        return []
    return [m.group(0) for m in _WORD_RE.finditer(text)]


def _is_sentence_initial(index: int, tokens: List[str]) -> bool:
    """Best-effort: a token is sentence-initial if it's the first token
    or the previous token (stripped of casing) ends a sentence.  Since
    we dropped punctuation during tokenisation we fall back to: it's
    the first token, OR the previous token is in a very short list of
    end-of-sentence signals inferred from original text.  To keep this
    cheap we only treat index 0 as sentence-initial.  Callers pass
    short bodies so the impact on NER accuracy is acceptable."""
    return index == 0


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def _extract_motifs(
    scenes: List[Dict[str, Any]],
    *,
    min_scene_presence: int,
    top_n: Optional[int],
    min_token_len: int,
) -> Dict[str, Any]:
    if not scenes:
        return {"motifs": [], "scene_count": 0, "noise_filtered": 0}

    total_scenes = len(scenes)
    # token_key -> { scenes_hit: set, total_count: int, preferred_form: str, proper_noun_hits: int }
    stats: Dict[str, Dict[str, Any]] = {}
    noise_filtered = 0

    for scene_idx, scene in enumerate(scenes):
        title = str(scene.get("title", "") or "")
        body = str(scene.get("body", "") or "")
        combined_tokens = _tokenise(title) + _tokenise(body)

        seen_in_scene: Set[str] = set()

        for tok_idx, tok in enumerate(combined_tokens):
            key = tok.lower()
            if len(key) < min_token_len:
                noise_filtered += 1
                continue
            if key in _STOPWORDS:
                noise_filtered += 1
                continue

            entry = stats.setdefault(key, {
                "scenes_hit": set(),
                "total_count": 0,
                "preferred_form": key,
                "proper_noun_hits": 0,
            })
            entry["scenes_hit"].add(scene_idx)
            entry["total_count"] += 1
            if _is_titlecase_like(tok) and not _is_sentence_initial(tok_idx, combined_tokens):
                entry["proper_noun_hits"] += 1
                # Remember the original form for display when it looks like
                # a proper noun.
                entry["preferred_form"] = tok
            seen_in_scene.add(key)

    motifs = []
    for key, data in stats.items():
        scenes_hit: Set[int] = data["scenes_hit"]
        if len(scenes_hit) < min_scene_presence:
            continue
        motifs.append({
            "token": data["preferred_form"],
            "scenes": sorted(scenes_hit),
            "totalOccurrences": data["total_count"],
            "carryStrength": round(len(scenes_hit) / total_scenes, 3),
            "properNounLikelihood": round(
                min(1.0, data["proper_noun_hits"] / max(1, data["total_count"])), 3,
            ),
        })

    # Primary sort: carryStrength desc.  Secondary: proper-noun likelihood
    # desc (prefer names/places over generic nouns).  Tertiary: total
    # occurrences desc.  Tie-break alphabetical for stability.
    motifs.sort(key=lambda m: (
        -m["carryStrength"],
        -m["properNounLikelihood"],
        -m["totalOccurrences"],
        m["token"].lower(),
    ))

    if top_n is not None:
        motifs = motifs[:top_n]

    return {
        "motifs": motifs,
        "scene_count": total_scenes,
        "noise_filtered": noise_filtered,
    }


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def _handle_motif_tracker(args: Dict[str, Any]) -> str:
    scenes = args.get("scenes")
    if not isinstance(scenes, list):
        return json.dumps({"error": "scenes must be an array of {title, body} objects."})

    try:
        min_presence = int(args.get("min_scene_presence", 2))
    except (TypeError, ValueError):
        min_presence = 2
    if min_presence < 1:
        min_presence = 1

    top_n_raw = args.get("top_n")
    top_n: Optional[int]
    if top_n_raw is None:
        top_n = None
    else:
        try:
            top_n = int(top_n_raw)
            if top_n < 1:
                top_n = None
        except (TypeError, ValueError):
            top_n = None

    try:
        min_len = int(args.get("min_token_length", 3))
    except (TypeError, ValueError):
        min_len = 3
    if min_len < 1:
        min_len = 1

    try:
        result = _extract_motifs(
            scenes,
            min_scene_presence=min_presence,
            top_n=top_n,
            min_token_len=min_len,
        )
    except Exception as exc:
        logger.exception("motif_tracker failed")
        return json.dumps({"error": f"internal motif-tracker error: {exc}"})

    result["params_used"] = {
        "min_scene_presence": min_presence,
        "top_n": top_n,
        "min_token_length": min_len,
    }
    return json.dumps(result)


def check_motif_tracker_requirements() -> bool:
    """Pure stdlib — always available."""
    return True


# ---------------------------------------------------------------------------
# OpenAI Function-Calling Schema
# ---------------------------------------------------------------------------

MOTIF_TRACKER_SCHEMA = {
    "name": "motif_tracker",
    "description": (
        "Return the real recurring motifs across an ordered sequence of scenes "
        "or beats, with cross-scene presence counts and carry-strength scores.  "
        "Use this when a writer agent needs to decide whether to call back a "
        "symbol, a name, or an object — the tool gives machine-verified answers "
        "('the photograph appears in scenes 0, 2, 4 with carry 0.75') rather "
        "than guessed ones.  It does NOT invent motifs; it only surfaces ones "
        "the text actually contains.\n\n"
        "Tokens below ``min_token_length`` (default 3) and stop-words are "
        "filtered.  A token is promoted to a motif only if it appears in at "
        "least ``min_scene_presence`` scenes (default 2)."
    ),
    "parameters": {
        "type": "object",
        "required": ["scenes"],
        "properties": {
            "scenes": {
                "type": "array",
                "description": (
                    "Ordered list of scenes or beats.  Each entry is an object "
                    "with ``title`` and ``body`` string fields.  Order is "
                    "preserved in the output ``scenes`` indexing."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                    },
                },
            },
            "min_scene_presence": {
                "type": "integer",
                "description": (
                    "Minimum number of scenes a token must appear in before "
                    "it is reported as a motif.  Default 2 — cross-scene "
                    "presence is what distinguishes a motif from a local "
                    "detail."
                ),
            },
            "top_n": {
                "type": "integer",
                "description": (
                    "If set, return only the top-N motifs sorted by carry "
                    "strength then proper-noun likelihood then occurrence "
                    "count."
                ),
            },
            "min_token_length": {
                "type": "integer",
                "description": (
                    "Drop tokens shorter than this.  Default 3.  Use 4 to "
                    "cut common three-letter words that slipped past the "
                    "stop-list; use 2 for languages where short words "
                    "carry real meaning."
                ),
            },
        },
    },
}


registry.register(
    name="motif_tracker",
    toolset="narrative",
    schema=MOTIF_TRACKER_SCHEMA,
    handler=_handle_motif_tracker,
    check_fn=check_motif_tracker_requirements,
    requires_env=[],
    is_async=False,
    emoji="🕯",
)
