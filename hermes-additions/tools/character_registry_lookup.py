#!/usr/bin/env python3
"""
Character Registry Lookup Tool — surface which persisted character
descriptions apply to the beat about to be rendered.

The problem this solves: when a narrative tree is rendered frame by
frame, image consistency requires every reference to the same
character to map to the same physical description.  Noustiny persists
that registry in its Zustand store, but without a lookup step the
registry is invisible — merges happen silently and the demo viewer
can't tell which character descriptions are carrying forward.

This tool runs *before* the visual-prompt-builder skill fires.  It
scans the beat's title and body for whole-word matches against the
known character names, and returns one record per hit.  The calling
route turns each record into a UI event ("REGISTRY HIT · Hannah →
freckled redhead in grey hoodie") so cross-scene continuity becomes a
visible, demonstrable feature rather than an implementation detail.

Deterministic, stdlib only, zero LLM — safe to run on every
image-prompt-build call without adding latency or inference cost.

Input shape
-----------

    {
      "body": "Thor clamps the gauntlet shut; the stones' light floods his arm.",
      "title": "THOR TAKES IT, BURNS WITH IT",
      "registry": {
        "Thor": "a tall blond bearded warrior god, thick forearms, burning blue eyes, scuffed dark armor with crimson cape",
        "Hannah": "freckled redhead in grey hoodie, mid-twenties, wary eyes"
      }
    }

Output shape
------------

    {
      "hits": [
        {"name": "Thor", "description": "a tall blond...", "source": "title"}
      ]
    }
"""

import logging
import re
from typing import Any, Dict, List

from tools.registry import registry

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")


def _lookup(body: str, title: str, character_registry: Dict[str, str]) -> List[Dict[str, str]]:
    if not character_registry:
        return []

    title_tokens = set(_WORD_RE.findall(title or ""))
    body_tokens = set(_WORD_RE.findall(body or ""))

    hits: List[Dict[str, str]] = []
    seen = set()

    for name, description in character_registry.items():
        if not name or not description or name in seen:
            continue

        # Multi-word names — exact phrase match in concatenated text.
        if " " in name:
            combined = f"{title}\n{body}"
            if name in combined:
                source = "title" if title and name in title else "body"
                hits.append({"name": name, "description": description, "source": source})
                seen.add(name)
            continue

        # Single-word names — whole-token match against tokenised sets.
        if name in title_tokens:
            hits.append({"name": name, "description": description, "source": "title"})
            seen.add(name)
            continue
        if name in body_tokens:
            hits.append({"name": name, "description": description, "source": "body"})
            seen.add(name)
            continue

        # Case-insensitive fallback — catches ALL-CAPS titles.
        upper = name.upper()
        if upper != name:
            if title and upper in title:
                hits.append({"name": name, "description": description, "source": "title"})
                seen.add(name)
            elif body and upper in body:
                hits.append({"name": name, "description": description, "source": "body"})
                seen.add(name)

    return hits


@registry.register(
    name="character_registry_lookup",
    description=(
        "Look up persisted character descriptions against a narrative beat. "
        "Returns every registered character whose name appears as a whole word "
        "in the beat's title or body, so downstream image-prompt builders can "
        "reuse the canonical visual description verbatim. Deterministic; takes "
        "no LLM calls; safe to invoke before every render."
    ),
    parameters={
        "type": "object",
        "properties": {
            "body": {
                "type": "string",
                "description": "The beat's prose body (scanned for names).",
            },
            "title": {
                "type": "string",
                "description": "The beat's title (also scanned; UPPER-CASE friendly).",
            },
            "registry": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": "Map of canonical character name → IP-free visual description.",
            },
        },
        "required": ["body", "registry"],
        "additionalProperties": False,
    },
)
def character_registry_lookup(body: str, title: str = "", registry: Dict[str, str] = None) -> Dict[str, Any]:
    """Return registry entries matching whole-word names in the beat."""
    hits = _lookup(body or "", title or "", registry or {})
    return {"hits": hits}


def _resolve_alias(character_registry: Dict[str, Any], query: str) -> str | None:
    """Reconcile an LLM-emitted name string with the canonical key under
    which a character was registered.  See `resolveCharacterAlias` in
    web/lib/character-registry-lookup.ts — both implementations stay
    algorithmically identical so any downstream Hermes consumer sees
    Noustiny's behaviour.

    Matching tiers, in order:
      1. Exact key match.
      2. Case-insensitive exact.
      3. Whole-word token from the query equals a single-word
         registered key  ("Light Yagami" → "Light").
      4. Multi-word registered key appears as a substring of the query
         ("Captain America" inside "Captain America (Steve Rogers)").

    Returns the canonical registered key (NOT the supplied alias) so
    downstream payloads stay anchored to one name per character.
    """
    if not query or not character_registry:
        return None
    if query in character_registry:
        return query
    q = query.strip()
    q_lower = q.lower()
    keys = list(character_registry.keys())
    for k in keys:
        if k.lower() == q_lower:
            return k
    tokens = {t.lower() for t in _WORD_RE.findall(q)}
    for k in keys:
        if " " not in k and k.lower() in tokens:
            return k
        if " " in k and k.lower() in q_lower:
            return k
    return None


@registry.register(
    name="character_alias_resolver",
    description=(
        "Resolve a single name string to the canonical key under which a "
        "character was registered, tolerating drift between short ('Light') "
        "and full ('Light Yagami') name forms.  Pairs with character_registry"
        "_lookup for image-pipeline name reconciliation; returns the canonical "
        "key (or null) so downstream payloads stay anchored to one identity."
    ),
    parameters={
        "type": "object",
        "properties": {
            "registry": {
                "type": "object",
                "additionalProperties": True,
                "description": "Map of canonical character name → any value.",
            },
            "query": {
                "type": "string",
                "description": "The drifted / aliased name to resolve.",
            },
        },
        "required": ["registry", "query"],
        "additionalProperties": False,
    },
)
def character_alias_resolver(registry: Dict[str, Any] = None, query: str = "") -> Dict[str, Any]:
    """Return `{"name": canonical_key}` or `{"name": None}` if no match."""
    return {"name": _resolve_alias(registry or {}, query or "")}
