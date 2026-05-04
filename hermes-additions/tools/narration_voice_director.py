"""Generic Hermes tool: pick a narrator persona + YouTube search query.

Pairs with the existing `narration-voice-director` skill (which lives at
``skills/creative/narration-voice-director/SKILL.md``).  Hermes's
OpenAI-compatible gateway does not auto-load skills into agent context, so
the skill alone is unreachable from the chat-completions endpoint.  This
tool wraps the skill's persona-selection rules and emits the JSON contract
(``persona_label``, ``search_query``, ``fallback_query``, ``reasoning``) by
running a one-shot Gemini call.

Designed to chain with ``voice_sample_builder`` and ``voice_clone_synthesize``:
the agent calls this tool first to decide WHO is narrating, then calls
voice_sample_builder with the returned search_query to fetch a clean
reference wav, then voice_clone_synthesize at render time.

Pure-function core (``narration_voice_director(...)``) so non-Hermes
consumers can import the same logic; registry hook at the bottom (top-level
register call so AST discovery picks it up — wrapping in try/except hides
the registration from `tools/registry.py:_module_registers_tools`).
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

from tools.registry import registry  # type: ignore


# -----------------------------------------------------------------------------
# Configuration — model + endpoint resolution.
# -----------------------------------------------------------------------------

_HERMES_CONFIG = Path.home() / ".hermes" / "config.yaml"
_DEFAULT_MODEL = "google/gemini-2.5-flash"


def _load_hermes_config() -> Dict[str, Any]:
    """Read the Hermes user config without pulling in PyYAML.

    The file is small and we only need a couple of strings; a hand-rolled
    line-walk avoids the dep tax (nothing else in the bare hermes-agent
    venv requires yaml).  On any error we return an empty dict — the tool
    falls back to environment variables.
    """
    out: Dict[str, Any] = {}
    try:
        text = _HERMES_CONFIG.read_text(encoding="utf-8")
    except OSError:
        return out

    # Two-key flat parser: model.default and custom_providers[0].api_key /
    # base_url / default_model.  We don't need a full YAML.
    in_model = False
    in_custom = False
    custom_first: Dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith("model:"):
            in_model, in_custom = True, False
            continue
        if line.startswith("custom_providers:"):
            in_model, in_custom = False, True
            continue
        if line and not line.startswith(" ") and not line.startswith("\t"):
            in_model, in_custom = False, False

        if in_model:
            m = re.match(r"\s+(\w+):\s*\"?([^\"]+)\"?", line)
            if m:
                out.setdefault("model", {})[m.group(1)] = m.group(2)
        elif in_custom:
            m = re.match(r"\s+(\w+):\s*\"?([^\"]+)\"?", line)
            if m and m.group(1) in {"name", "base_url", "api_key", "default_model"}:
                # Capture only the FIRST custom_providers entry — config.yaml
                # may list more but we only need one for fallback routing.
                if m.group(1) in custom_first:
                    continue
                custom_first[m.group(1)] = m.group(2)
    if custom_first:
        out["custom_providers"] = [custom_first]
    return out


def _resolve_endpoint() -> Dict[str, str]:
    """Return {base_url, api_key, model} for the LLM call.

    Resolution order:
      1. Explicit env vars HERMES_DIRECTOR_BASE_URL / HERMES_DIRECTOR_API_KEY
         / HERMES_DIRECTOR_MODEL — escape hatch for test environments.
      2. Hermes config.yaml's first custom_providers entry — same backend
         the rest of Hermes uses, no extra credential plumbing.
      3. OPENROUTER_API_KEY env var (community fallback) targeting
         openrouter.ai with the default Gemini model.
    """
    if os.getenv("HERMES_DIRECTOR_BASE_URL") and os.getenv("HERMES_DIRECTOR_API_KEY"):
        return {
            "base_url": os.environ["HERMES_DIRECTOR_BASE_URL"].rstrip("/"),
            "api_key": os.environ["HERMES_DIRECTOR_API_KEY"],
            "model": os.getenv("HERMES_DIRECTOR_MODEL", _DEFAULT_MODEL),
        }

    cfg = _load_hermes_config()
    providers = cfg.get("custom_providers") or []
    if providers:
        p = providers[0]
        if p.get("api_key") and p.get("base_url"):
            return {
                "base_url": p["base_url"].rstrip("/"),
                "api_key": p["api_key"],
                "model": p.get("default_model")
                    or (cfg.get("model") or {}).get("default")
                    or _DEFAULT_MODEL,
            }

    or_key = os.getenv("OPENROUTER_API_KEY")
    if or_key:
        return {
            "base_url": "https://openrouter.ai/api/v1",
            "api_key": or_key,
            "model": _DEFAULT_MODEL,
        }

    raise RuntimeError(
        "narration_voice_director: no LLM endpoint available — set "
        "HERMES_DIRECTOR_* env vars, populate ~/.hermes/config.yaml's "
        "custom_providers, or set OPENROUTER_API_KEY."
    )


# -----------------------------------------------------------------------------
# Director rules — inline fork of the SKILL.md so the tool is self-contained.
# Update both files together if the persona-selection logic changes.
# -----------------------------------------------------------------------------

_DIRECTOR_SYSTEM = """You are the narration-voice-director skill.  You read a story and pick the single narrator persona + a YouTube search query that will surface a clean speaking-voice reference clip.  Output exactly ONE JSON object, first character "{", last character "}", no prose, no code fences.

Schema: {"persona_label": string (max 8 words, human-readable narrator description), "search_query": string (6-12 words, YouTube-friendly), "fallback_query": string (6-12 words, different angle from search_query), "reasoning": string (max 30 words)}.

Required modifiers in queries (pick at least one): narration, prologue, monologue, interview, audiobook reading, voice over, speech excerpt.
Forbidden in queries: scene, fight, battle, clash, action, climax, screaming, crying, shouting, INSANE, MIND-BLOWING, DESTROYS.

Persona-selection hierarchy:
0. Gender hint (male / female) is sometimes provided as the voice_gender argument.  It is ALSO sometimes baked into the seed or title as a literal bracketed clause like "[NARRATOR MUST BE FEMALE GENDER] ..." — TREAT THAT CLAUSE AS AUTHORITATIVE EVEN IF voice_gender is null.  Whichever source carries the gender, the chosen persona MUST match it.  Look at the title and seed for character names — if a same-gender character from that story exists (e.g. story is about Avatar: the Last Airbender with both Aang and Katara, hint is female → pick Katara, hint male → pick Aang or Iroh), prefer that character.  Otherwise pick a same-gender franchise narrator (lotr+female=Galadriel, lotr+male=Gandalf; avatar-airbender+male=Iroh, avatar-airbender+female=Katara; star-wars+female=Princess Leia, star-wars+male=Obi-Wan).  Original story + female hint → pick a female actor with audiobook work; male hint → male actor.  The gender hint OVERRIDES the canonical-narrator default in step 1 if they conflict.
1. Franchise has canonical narrator → use it.  lotr=Galadriel prologue, marvel=Stan Lee narration, avatar-airbender=Iroh storyteller, dune=Princess Irulan voiceover, harry-potter=Stephen Fry audiobook, got=Sean Bean audiobook, star-wars=Obi-Wan or Yoda monologue.
2. No canonical or tone clashes → tonal match (gravelly elder for grim, warm elder for nostalgic, hushed for noir).
3. Original / grounded story → describe voice + actor with audiobook work ("Tom Hanks audiobook reading", "Anne Hathaway narration", "Julianne Moore interview").
4. Empty seed → "professional male audiobook narrator" / "audiobook narrator male voice over excerpt".

CRITICAL: characters famous for a dramatic moment (Galadriel ring scene, Joker laugh, Vader breath, Hulk smash) MUST be queried via the actor name or a different role context — never the dramatic moment itself.  Example: "Galadriel prologue narration" not "Galadriel ring scene".  "Cate Blanchett interview" is also fine.

fallback_query MUST approach the persona from a different angle than search_query (different keywords, different actor, different project) — not a near-paraphrase, so retries actually retry.
"""


def _build_user_message(
    title: str,
    seed: str,
    voice_gender: Optional[str],
    franchise: Optional[str],
) -> str:
    gender_line = (
        f"voice_gender: {voice_gender} (the persona MUST be this gender)"
        if voice_gender in {"male", "female"}
        else "voice_gender: (none — pick whichever fits the story tone)"
    )
    franchise_line = (
        f"franchise: {franchise}"
        if franchise
        else "franchise: infer from seed/title (lotr, marvel, avatar-airbender, dune, harry-potter, got, star-wars, dc, anime-generic, or null for original/unknown)."
    )
    return "\n".join([
        f"title: {title or '(none)'}",
        f"seed: {seed or '(none)'}",
        gender_line,
        franchise_line,
        "",
        "Emit the JSON now.",
    ])


# -----------------------------------------------------------------------------
# HTTP — minimal urllib client (no aiohttp / httpx / requests dep).
# -----------------------------------------------------------------------------


def _post_chat_completion(
    base_url: str,
    api_key: str,
    model: str,
    system: str,
    user: str,
    *,
    timeout: float = 30.0,
) -> str:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": 400,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    parsed = json.loads(raw)
    msg = parsed.get("choices", [{}])[0].get("message", {})
    content = msg.get("content")
    if not isinstance(content, str):
        raise RuntimeError(
            f"narration_voice_director: model returned non-string content "
            f"({type(content).__name__})"
        )
    return content


# -----------------------------------------------------------------------------
# JSON extraction — tolerate code fences, leading prose, etc.
# -----------------------------------------------------------------------------


_JSON_RE = re.compile(r"\{[\s\S]*\}", re.MULTILINE)


def _extract_json_object(text: str) -> Dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"```\s*$", "", cleaned, flags=re.IGNORECASE).strip()
    m = _JSON_RE.search(cleaned)
    if not m:
        raise ValueError("director response did not contain a JSON object")
    return json.loads(m.group(0))


# -----------------------------------------------------------------------------
# Public entry point.
# -----------------------------------------------------------------------------


def narration_voice_director(
    title: str = "",
    seed: str = "",
    voice_gender: Optional[str] = None,
    franchise: Optional[str] = None,
) -> Dict[str, Any]:
    """Pick a narrator persona + YouTube search query for a story.

    Args:
      title: Story title (or beat title) — short, ≤120 chars typical.
      seed: Logline / seed text — ≤240 chars typical, sets the tone.
      voice_gender: Optional 'male' | 'female'.  When set, persona MUST
        match that gender (overrides default canonical narrator).
      franchise: Optional slug ('lotr', 'avatar-airbender', etc.).  Pass
        None to let the model infer from the seed/title.

    Returns a dict with keys:
      persona_label   — short human-readable narrator description
      search_query    — 6-12 word YouTube query for voice_sample_builder
      fallback_query  — alternate query (different angle)
      reasoning       — one sentence justification
      model           — which LLM produced the answer (for telemetry)
    """
    # Light input validation — keep the LLM call focused.
    title = (title or "").strip()
    seed = (seed or "").strip()
    if not title and not seed:
        raise ValueError(
            "narration_voice_director: at least one of title / seed must be non-empty"
        )
    if voice_gender is not None:
        voice_gender = voice_gender.strip().lower() or None
        if voice_gender not in {None, "male", "female"}:
            voice_gender = None
    if franchise is not None:
        franchise = franchise.strip() or None

    endpoint = _resolve_endpoint()
    user_msg = _build_user_message(title, seed, voice_gender, franchise)
    raw = _post_chat_completion(
        base_url=endpoint["base_url"],
        api_key=endpoint["api_key"],
        model=endpoint["model"],
        system=_DIRECTOR_SYSTEM,
        user=user_msg,
    )
    obj = _extract_json_object(raw)

    persona_label = str(obj.get("persona_label") or "").strip()
    search_query = str(obj.get("search_query") or "").strip()
    fallback_query = str(obj.get("fallback_query") or "").strip()
    reasoning = str(obj.get("reasoning") or "").strip()

    if not persona_label or not search_query:
        raise RuntimeError(
            "narration_voice_director: model returned incomplete JSON "
            f"(persona_label={persona_label!r}, search_query={search_query!r})"
        )

    # If the model neglected the fallback rule, mirror the search_query so
    # callers always get a non-empty value (downstream retry logic checks
    # for empty and bails out).
    if not fallback_query:
        fallback_query = search_query

    return {
        "persona_label": persona_label,
        "search_query": search_query,
        "fallback_query": fallback_query,
        "reasoning": reasoning,
        "model": endpoint["model"],
    }


# -----------------------------------------------------------------------------
# Hermes registry hook.
# -----------------------------------------------------------------------------


_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {
            "type": "string",
            "description": (
                "Story title or ending beat title.  Keep ≤120 chars; the "
                "tool only needs it as a tonal hint."
            ),
        },
        "seed": {
            "type": "string",
            "description": (
                "Story seed / logline (≤240 chars) — what the story is "
                "about.  Used together with the title to infer franchise, "
                "tone, and main characters.  At least one of title / seed "
                "must be non-empty."
            ),
        },
        "voice_gender": {
            "type": ["string", "null"],
            "enum": ["male", "female", None],
            "description": (
                "REQUIRED — pass it on every call (use null only if the "
                "calling context truly has no gender preference).  When "
                "the user message includes a clause like "
                "'voice_gender=\"female\"' or any 'voice_gender:' line, "
                "forward that value verbatim.  When the user has picked "
                "a male/female narrator in the UI, the chosen persona "
                "MUST match this gender — it overrides canonical "
                "narrator defaults (e.g. female + Avatar story → "
                "Katara, NOT Iroh).  Dropping this argument silently "
                "yields the canonical default and is almost always "
                "wrong when the caller cared about gender."
            ),
        },
        "franchise": {
            "type": ["string", "null"],
            "description": (
                "Optional franchise slug ('lotr', 'avatar-airbender', "
                "'marvel', 'dune', 'harry-potter', 'got', 'star-wars', "
                "'dc', 'anime-generic').  Pass null to let the model "
                "infer from title/seed."
            ),
        },
    },
    "required": ["title", "seed", "voice_gender"],
}


def _handle_narration_voice_director(args: Dict[str, Any], **_kwargs: Any) -> str:
    """Hermes dispatch handler — returns JSON string per Hermes convention."""
    # Trace incoming args + outgoing result so the demo log can prove what
    # the agent forwarded (esp. voice_gender — easy to drop accidentally).
    try:
        with open("/tmp/noustiny-tool.log", "a", encoding="utf-8") as _f:
            import datetime as _dt
            _f.write(json.dumps({
                "ts": _dt.datetime.utcnow().isoformat(),
                "tool": "narration_voice_director.dispatch_in",
                "args": args,
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass
    result = narration_voice_director(
        title=args.get("title", ""),
        seed=args.get("seed", ""),
        voice_gender=args.get("voice_gender"),
        franchise=args.get("franchise"),
    )
    try:
        with open("/tmp/noustiny-tool.log", "a", encoding="utf-8") as _f:
            import datetime as _dt
            _f.write(json.dumps({
                "ts": _dt.datetime.utcnow().isoformat(),
                "tool": "narration_voice_director.dispatch_out",
                "result": result,
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return json.dumps(result, ensure_ascii=False)


registry.register(
    name="narration_voice_director",
    toolset="narrative",
    schema=_SCHEMA,
    handler=_handle_narration_voice_director,
    is_async=False,
    description=(
        "Pick the narrator persona for a story and emit a YouTube search "
        "query that will surface a clean speaking-voice reference clip "
        "for voice_sample_builder.  Pairs with voice_sample_builder + "
        "voice_clone_synthesize: this picks WHO is narrating, the others "
        "fetch the reference wav and clone it.  Returns "
        "{persona_label, search_query, fallback_query, reasoning, model} "
        "as a JSON object.  Honours an optional voice_gender hint — when "
        "provided, persona is constrained to that gender (e.g. female + "
        "Avatar story → Katara, not Iroh)."
    ),
    emoji="🎙️",
)
