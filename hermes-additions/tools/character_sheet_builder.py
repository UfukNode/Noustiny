#!/usr/bin/env python3
"""
Character Sheet Builder Tool — deterministic heuristic mirror of the
``character-sheet-builder`` skill.

The full-fidelity character sheet is produced by the LLM skill (see
hermes-agent/skills/creative/character-sheet-builder/SKILL.md).  This
tool exists so downstream agents can ground a fallback synchronously:
when the gateway is slow or unreachable, route handlers can still
emit a best-effort cast list based on a curated registry of franchise
principals.

The sheet is 1–4 characters.  Each entry carries:

- ``name``          — canonical short name, matches beat prose
- ``description``   — rich IP-free physical detail, reusable verbatim
  by the visual-prompt-builder skill
- ``portrait_prompt`` — full-body hero portrait prompt for a
  text-to-image model, ending with the caller-supplied ``story_register``
  so the portrait matches the beat-level visual grammar

Deterministic, stdlib only, zero LLM.  When no franchise is known the
function returns a single neutral protagonist so downstream never
crashes on an empty cast.

Input shape
-----------

    {
      "seed": "Aang opens his eyes for the first time…",
      "franchise": "avatar-airbender",
      "story_register": "animated-feature, cel-shaded 2D animation, …"
    }
"""

import logging
from typing import Any, Dict, List, Optional

from tools.registry import registry

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Principal cast per franchise.  Tight on purpose — these are fallbacks; the
# LLM skill produces the full list.  Descriptions are IP-free: physical
# attributes only, no named tokens ("Aang", "Stormbreaker", etc.).
# ---------------------------------------------------------------------------

_PRINCIPALS: Dict[str, List[Dict[str, str]]] = {
    "avatar-airbender": [
        {
            "name": "Aang",
            "description": (
                "twelve-year-old bald monk boy, blue arrow tattoo down the brow, "
                "wide silver-grey eyes, saffron-and-orange layered robes, "
                "slim athletic child frame, bare feet"
            ),
        },
        {
            "name": "Katara",
            "description": (
                "fourteen-year-old brown-skinned Water Tribe girl, "
                "cobalt fur-trimmed parka with ivory trim, dark hair in twin "
                "looped front braids, bright blue eyes, hopeful open face"
            ),
        },
        {
            "name": "Sokka",
            "description": (
                "fifteen-year-old brown-skinned Water Tribe boy, "
                "cobalt fur-trimmed parka, high wolf-tail topknot, sharp jaw, "
                "wry skeptical expression, boomerang sheath at back"
            ),
        },
    ],
    "marvel": [
        {
            "name": "Tony Stark",
            "description": (
                "lean mid-forties man, dark close-cropped hair, sharp goatee, "
                "sharp brown eyes, cracked and battle-worn red-and-gold articulated "
                "plate armor with a glowing chest core"
            ),
        },
        {
            "name": "Thor",
            "description": (
                "tall blond bearded warrior god, thick forearms, burning blue eyes, "
                "scuffed dark Norse-style plate armor with a crimson cape"
            ),
        },
    ],
    "star-wars": [
        {
            "name": "Luke",
            "description": (
                "young blond man in late teens, blue eyes, beige desert tunic and "
                "rough cloth belt, glowing green blade lightstaff at his hip"
            ),
        },
    ],
    "harry-potter": [
        {
            "name": "Harry",
            "description": (
                "thin black-haired eleven-year-old boy, round wire-frame glasses, "
                "bright green eyes, lightning-shaped scar on the forehead, "
                "oversized school uniform with a scarlet-and-gold striped scarf"
            ),
        },
    ],
    "lotr": [
        {
            "name": "Frodo",
            "description": (
                "small barefoot hobbit with dark curly hair, large blue eyes, "
                "travel-worn green cloak pinned at the shoulder, gentle wary expression"
            ),
        },
    ],
    "got": [
        {
            "name": "Jon",
            "description": (
                "brooding young man with long dark curly hair, grey eyes, "
                "heavy black fur-lined northern cloak, longsword at his hip"
            ),
        },
    ],
    "dune": [
        {
            "name": "Paul",
            "description": (
                "serious young man with dark hair and piercing blue-within-blue eyes, "
                "desert survival stillsuit of black ribbed rubber and mesh"
            ),
        },
    ],
    "breaking-bad": [
        {
            "name": "Walt",
            "description": (
                "bald late-fifties man, neat greying goatee, wire-frame glasses, "
                "pale skin, tired grey-blue eyes, slight hunch at the shoulders"
            ),
        },
    ],
}


def _portrait_prompt(description: str, story_register: str) -> str:
    register = story_register.strip() if story_register else "cinematic, balanced naturalism, 35mm film"
    return (
        f"hero portrait, full-body, {description}, "
        f"three-quarter pose, soft key light on a neutral grey backdrop, {register}"
    )


def _default_protagonist(story_register: str) -> List[Dict[str, str]]:
    description = (
        "a thoughtful adult protagonist, medium build, neutral unstyled hair, "
        "attentive eyes, contemporary everyday clothing, a quiet considered expression"
    )
    return [
        {
            "name": "Protagonist",
            "description": description,
            "portrait_prompt": _portrait_prompt(description, story_register),
        }
    ]


@registry.register(
    name="character_sheet_builder",
    description=(
        "Return a compact cast sheet (1–4 characters) for a story seed: canonical "
        "name, IP-free visual description, and a hero-portrait prompt for a "
        "text-to-image model.  Downstream callers render each portrait and use "
        "it as a reference when drawing subsequent beats.  Deterministic fallback: "
        "falls back to a curated franchise cast or a neutral protagonist when no "
        "known franchise is provided.  No LLM call."
    ),
    parameters={
        "type": "object",
        "properties": {
            "seed": {"type": "string", "description": "The story's logline."},
            "franchise": {
                "type": "string",
                "description": "Franchise slug from story_copyright_detector, or empty for original seeds.",
            },
            "story_register": {
                "type": "string",
                "description": "Visual register string to append to every portrait_prompt so portraits match beat-level aesthetics.",
            },
        },
        "required": ["seed"],
        "additionalProperties": False,
    },
)
def character_sheet_builder(
    seed: str,
    franchise: str = "",
    story_register: str = "",
) -> List[Dict[str, str]]:
    """Return a 1–4 entry cast sheet for this seed / franchise."""
    slug = (franchise or "").strip().lower()
    cast = _PRINCIPALS.get(slug)
    if not cast:
        return _default_protagonist(story_register)

    return [
        {
            "name": entry["name"],
            "description": entry["description"],
            "portrait_prompt": _portrait_prompt(entry["description"], story_register),
        }
        for entry in cast
    ]
