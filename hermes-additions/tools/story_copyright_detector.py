#!/usr/bin/env python3
"""
Story Copyright Detector Tool — deterministic fallback classifier for a
story seed.  Companion to the ``story-copyright-detector`` skill.

Purpose
-------

A branching-narrative agent needs to route every seed to the right
image pipeline *before* it starts rendering:

- Known franchises (Marvel, Star Wars, LOTR, GoT, Avatar, Harry Potter,
  DC, Dune, major anime) → FLUX + moderation-rewriter ladder.  Image
  filters reject verbatim prompts mentioning trademark tokens; a
  sanitize-first pipeline is the only reliable path.
- Inspired / original seeds → Gemini (Nano Banana) directly.  No
  trademarks to dodge; stylised render is cheaper and faster.

The full-fidelity decision is made by the skill (LLM reasoning), but
downstream agents may want a sub-millisecond check — this tool gives
that.  Deterministic keyword match against the franchise registry
below; no LLM call required.

Input shape
-----------

    { "seed": "Tony Stark holds the Infinity Gauntlet..." }

Output shape
------------

    {
      "ip_level": "known" | "inspired" | "original",
      "franchise": "marvel" | "star-wars" | ...,
      "model_preference": "flux-photoreal" | "gemini-stylised",
      "reason": "Matched marvel token(s): tony stark, infinity gauntlet"
    }
"""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from tools.registry import registry

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Franchise registry — { franchise_slug: [token, token, ...] }.  Tokens are
# lower-cased whole-phrase patterns; matched with word-boundary regex against
# the lower-cased seed.  Curate conservatively — a false "known" classification
# sends the seed down the slower FLUX+moderation path unnecessarily.
# ---------------------------------------------------------------------------

_FRANCHISES: Dict[str, List[str]] = {
    "marvel": [
        "marvel", "avengers", "iron man", "tony stark", "stark industries",
        "thor odinson", "captain america", "steve rogers", "bruce banner",
        "hulk", "black widow", "natasha romanoff", "hawkeye", "clint barton",
        "nick fury", "s.h.i.e.l.d.", "shield", "infinity gauntlet", "infinity stones",
        "mjolnir", "stormbreaker", "wakanda", "vibranium", "asgard", "thanos",
        "loki laufeyson", "scarlet witch", "wanda maximoff", "doctor strange",
        "spider-man", "peter parker", "pepper potts", "happy hogan",
        "morgan stark", "ant-man", "black panther", "tchalla", "guardians of the galaxy",
        "star-lord", "groot", "rocket raccoon", "gamora", "nebula", "drax",
    ],
    "star-wars": [
        "star wars", "jedi", "sith", "skywalker", "darth vader", "anakin",
        "luke skywalker", "leia organa", "han solo", "chewbacca",
        "lightsaber", "death star", "millennium falcon", "obi-wan",
        "yoda", "the force", "kylo ren", "rey", "stormtrooper",
        "boba fett", "mandalorian", "tatooine", "coruscant",
    ],
    "harry-potter": [
        "harry potter", "hogwarts", "gryffindor", "slytherin", "ravenclaw",
        "hufflepuff", "hermione granger", "ron weasley", "dumbledore",
        "voldemort", "diagon alley", "quidditch", "muggle", "azkaban",
        "hagrid", "snape",
    ],
    "got": [
        "game of thrones", "westeros", "winterfell", "stark family",
        "jon snow", "daenerys targaryen", "tyrion lannister", "cersei",
        "iron throne", "the wall", "white walker", "khaleesi", "king's landing",
        "house stark", "house lannister", "house targaryen",
    ],
    "lotr": [
        "lord of the rings", "middle-earth", "middle earth", "the shire",
        "hobbit", "frodo baggins", "bilbo", "gandalf", "aragorn",
        "legolas", "gimli", "sauron", "mordor", "mount doom", "the one ring",
        "rivendell", "elrond", "galadriel", "orc",
    ],
    "dc": [
        "batman", "bruce wayne", "gotham city", "joker", "harley quinn",
        "superman", "clark kent", "metropolis", "kryptonite", "wonder woman",
        "diana prince", "themyscira", "the flash", "aquaman", "lex luthor",
    ],
    "dune": [
        "arrakis", "paul atreides", "muad'dib", "house atreides", "house harkonnen",
        "fremen", "sandworm", "the spice", "melange", "leto atreides",
        "bene gesserit", "kwisatz haderach",
    ],
    "avatar-cameron": [
        "na'vi", "navi", "pandora", "unobtanium", "rda", "jake sully",
        "neytiri", "hometree", "tree of souls", "toruk",
    ],
    "avatar-airbender": [
        "aang", "katara", "sokka", "toph beifong", "zuko", "azula",
        "appa", "momo", "air nomad", "air nomads", "southern air temple",
        "the avatar state", "fire nation", "earth kingdom", "water tribe",
        "ba sing se", "the last airbender",
    ],
    "one-piece": [
        "monkey d luffy", "one piece", "straw hat", "zoro", "nami",
        "sanji", "usopp", "chopper", "robin", "franky", "brook",
        "grand line", "devil fruit",
    ],
    "naruto": [
        "naruto uzumaki", "sasuke uchiha", "sakura haruno", "kakashi hatake",
        "hidden leaf", "konoha", "chakra", "sharingan", "rasengan",
        "akatsuki",
    ],
    "attack-on-titan": [
        "eren yeager", "mikasa ackerman", "armin arlert", "levi ackerman",
        "titan", "survey corps", "wall maria", "wall rose", "wall sina",
        "the beast titan",
    ],
    "breaking-bad": [
        "walter white", "heisenberg", "jesse pinkman", "saul goodman",
        "gus fring", "albuquerque",
    ],
}

# Optional inspired-register tokens — hits here downgrade the confidence
# from ``known`` to ``inspired`` if no franchise-specific token matched.
_INSPIRED_REGISTERS: List[str] = [
    "cybernetic implant", "cybernetic eye", "neural jack", "corporate dystopia",
    "farmboy", "prophecy", "chosen one", "the old gods",
    "neon-drenched", "hover-bike", "mech suit",
]


def _lower(text: str) -> str:
    return (text or "").lower()


def _match_franchise(seed_lc: str) -> Tuple[Optional[str], List[str]]:
    """Return (franchise_slug, matched_tokens) — lowest-token winner is fine
    because the heuristic is "any hit means known franchise"."""
    for slug, tokens in _FRANCHISES.items():
        hits: List[str] = []
        for token in tokens:
            # whole-phrase match, word boundaries.
            safe = re.escape(token)
            pattern = re.compile(rf"(?<![A-Za-z0-9]){safe}(?![A-Za-z0-9])")
            if pattern.search(seed_lc):
                hits.append(token)
        if hits:
            return slug, hits
    return None, []


def _match_inspired(seed_lc: str) -> List[str]:
    hits: List[str] = []
    for token in _INSPIRED_REGISTERS:
        safe = re.escape(token)
        pattern = re.compile(rf"(?<![A-Za-z0-9]){safe}(?![A-Za-z0-9])")
        if pattern.search(seed_lc):
            hits.append(token)
    return hits


_STYLISED_FRANCHISES = {
    "avatar-airbender", "naruto", "one-piece", "attack-on-titan",
}


def _pick_model(ip_level: str, franchise: Optional[str]) -> str:
    if ip_level == "known":
        # Animated franchises want stylised render + multi-modal refs → Gemini.
        # Live-action franchises stay on FLUX photoreal cinematic.
        if franchise in _STYLISED_FRANCHISES:
            return "gemini-stylised"
        return "flux-photoreal"
    return "gemini-stylised"


@registry.register(
    name="story_copyright_detector",
    description=(
        "Classify a story seed by intellectual-property weight.  Returns ip_level "
        "(known/inspired/original), franchise slug, and model_preference "
        "(flux-photoreal for known IP, gemini-stylised for inspired/original).  "
        "Deterministic keyword match against a curated franchise registry — no LLM call."
    ),
    parameters={
        "type": "object",
        "properties": {
            "seed": {
                "type": "string",
                "description": "The story's logline / seed text.",
            },
        },
        "required": ["seed"],
        "additionalProperties": False,
    },
)
def story_copyright_detector(seed: str) -> Dict[str, Any]:
    """Classify a seed by IP weight; pick the matching image model."""
    seed_lc = _lower(seed)
    if not seed_lc.strip():
        return {
            "ip_level": "original",
            "franchise": None,
            "model_preference": "gemini-stylised",
            "reason": "empty seed — default stylised path",
        }

    franchise, franchise_hits = _match_franchise(seed_lc)
    if franchise:
        return {
            "ip_level": "known",
            "franchise": franchise,
            "model_preference": "flux-photoreal",
            "reason": f"Matched {franchise} token(s): {', '.join(franchise_hits[:4])}",
        }

    inspired_hits = _match_inspired(seed_lc)
    if inspired_hits:
        return {
            "ip_level": "inspired",
            "franchise": None,
            "model_preference": "gemini-stylised",
            "reason": f"Inspired-register hits: {', '.join(inspired_hits[:4])}",
        }

    return {
        "ip_level": "original",
        "franchise": None,
        "model_preference": "gemini-stylised",
        "reason": "no franchise tokens detected — grounded/original seed",
    }
