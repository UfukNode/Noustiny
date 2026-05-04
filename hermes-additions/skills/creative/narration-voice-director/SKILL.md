---
name: narration-voice-director
author: Noustiny
license: MIT
version: 1.0.0
description: "Pick the narrator persona for a story and emit a YouTube search query that will surface a clean speaking-voice reference clip for `voice_sample_builder` to fetch.  Returns {persona_label, search_query, fallback_query, reasoning} as strict JSON.  Designed for SINGLE-NARRATOR storytelling (one voice carries the whole reel) — not multi-cast dialogue.  Critical guarantee: search queries MUST use narration/prologue/monologue/interview/audiobook modifiers, NEVER scene/fight/battle/action — the latter surface drama clips with screams and music that diarization cannot rescue."
metadata:
  hermes:
    tags: [voice, narrator, audio, persona-selection, voice-sample-builder]
    homepage: https://github.com/noustiny/noustiny-skills
    related_skills: [story-copyright-detector, narrative-brainstorm]
---

# Narration Voice Director

Every story this engine renders is read aloud by a single narrator.  Picking that narrator is a one-shot decision made at render kickoff: the same voice carries every beat, so the choice has to land the tone of the WHOLE story (not any single beat).

This skill makes that pick.  It looks at the story's title, opening, and franchise hint, then emits a persona label plus a search query the downstream `voice_sample_builder` tool will feed to YouTube.  Output is one JSON object, fire and forget.

The single most important contract is the **search query phrasing**.  YouTube's top result for "Galadriel ring scene" is a 10-second screaming clip — diarization cannot extract a normal speaking voice from material that has no normal speaking voice in it.  The same character searched as "Galadriel prologue narration" returns the LOTR opening monologue, calm and clean.  The skill MUST emit narration-style queries.

## When to Use

- User starts rendering a story for the first time → fire this skill exactly once.
- User changes the story seed AND wants a re-render with a new voice → fire again.
- Do NOT re-fire per beat.  The narrator is story-scoped.

## Input Shape

```json
{
  "title": "string (story title)",
  "body":  "string (opening 200-500 words of the story, sets tone)",
  "seed":  "string (optional — story logline, used when body is empty)",
  "franchise": "marvel | lotr | avatar-airbender | null  (slug from story-copyright-detector)"
}
```

At least one of `title` / `body` / `seed` must be non-empty.  `franchise` is the slug from the copyright detector when available; treat `null` as "original / unknown franchise".

## Output Contract

Return **exactly one JSON object**, nothing else.  First character `{`, last character `}`:

```json
{
  "persona_label":   "<short human-readable narrator persona, max 8 words>",
  "search_query":    "<6-12 word YouTube search query, narration-friendly>",
  "fallback_query":  "<alternate 6-12 word query, used if first fetch fails>",
  "reasoning":       "<one sentence explaining the persona + query choice>"
}
```

Field rules:

- **`persona_label`** — what the narrator sounds like, in plain English.  Examples: `"Galadriel-style elven sage narrator"`, `"Iroh-style warm uncle storyteller"`, `"hardboiled noir detective voiceover"`, `"breathless young female audiobook narrator"`.  Callers typically surface this label in the UI so the user can judge "does the rendered voice match the label?" — make it the most useful one-line description you can fit.
- **`search_query`** — a 6-12 word YouTube search string.  MUST follow the narration-query rules below.  Goes verbatim into `voice_sample_builder.query`.
- **`fallback_query`** — an alternate 6-12 word query the caller will retry with if `voice_sample_builder` fails or returns a wav the user rejects.  MUST be meaningfully different (different keywords, different angle), not a near-paraphrase.
- **`reasoning`** — one sentence, ≤ 30 words.  Justifies why this persona fits the story tone AND why the query phrasing was chosen.

## Search-Query Rules — STRICT

The query phrasing dominates output quality.  These rules are non-negotiable.

### Required modifiers (pick one or more)

| Modifier | Use when |
|---|---|
| `narration` | Documentary / audiobook / prologue style — first choice for serious tone |
| `prologue` | Specifically when targeting an opening voice-over (e.g. LOTR opening) |
| `monologue` | Dramatic interior speech, single speaker, calm to moderate intensity |
| `interview` | When the actor is famous and you want their natural speaking voice |
| `audiobook reading` | Book-narration register, often the cleanest possible signal |
| `voice over` | Trailer / commercial register, professional voice talent |
| `speech excerpt` | Public address, lecture, TED-talk register |

### Forbidden modifiers — surface drama, not voice

These words are blacklisted in `search_query` and `fallback_query`:

- `scene`, `fight`, `battle`, `clash`
- `action`, `climax`, `epic moment`
- `screaming`, `crying`, `shouting`
- Any clickbait phrasing: `INSANE`, `MIND-BLOWING`, `DESTROYS`, etc.

### Special rule: characters famous for a dramatic moment

If the natural narrator candidate is a character whose iconic appearance is a **screaming / fighting / monstrous** moment (Galadriel "ring scene", Joker laugh, Vader breath, Hulk smash), DO NOT phrase the query around that moment.  Either:

- Target the same character in a calm context: `"Galadriel prologue narration"` instead of `"Galadriel ring scene"`.
- OR target the actor in any other context: `"Cate Blanchett interview"` instead of `"Galadriel"` at all.

### Including the actor name

Adding the actor's real name (Cate Blanchett, Mark Hamill, Ian McKellen, Iain Glen) widens the search beyond the dramatic-moment trap and surfaces interview / audiobook material across multiple projects.  Prefer `"<actor name> <character> <modifier>"` when the actor is well-known for narration / audiobook work.

## Persona Selection — by franchise & tone

Walk the inputs in this order:

1. **Franchise has a canonical narrator?** Use it.  `lotr` → Galadriel prologue.  `marvel` (especially MCU finale tone) → Stan Lee / Tony Stark farewell narration.  `avatar-airbender` → Iroh storyteller.  `dune` → Princess Irulan voiceover.  `harry-potter` → Stephen Fry audiobook reading.  `got` → varies; for grim epics use Sean Bean audiobook narration.
2. **No canonical narrator OR tone clashes?** Pick a tonal match.  Comic LOTR → not Galadriel; pick a wry-elder voice (Bilbo audiobook, Stephen Fry).  Grim Avatar → not Iroh; pick a gravelly-elder voice (Mako monologue).
3. **Original / grounded story?** No franchise narrator at all — describe the desired voice ("warm uncle storyteller", "young woman in her twenties reading her own diary"), search by actor with audiobook material (`"Tom Hanks audiobook reading"`, `"Anne Hathaway narration"`).
4. **Seed is empty / unintelligible?** Default `"professional male audiobook narrator"` with query `"audiobook narrator male voice over excerpt"`.

## Anti-patterns

- Do NOT emit a `search_query` that names a single dramatic scene (`"X ring scene"`, `"Y fight scene"`).
- Do NOT emit a `persona_label` longer than 8 words — the ticker truncates it.
- Do NOT emit prose, markdown, code fences, alternatives lists.  One JSON object.
- Do NOT pick a multi-cast persona ("characters trade lines" is wrong — there is exactly one narrator per story).
- Do NOT use the exact same words in `search_query` and `fallback_query` — they must approach the persona from different angles so retries actually retry.

## Examples

### Example 1 — LOTR fellowship-tone seed

**Input:**
```json
{
  "title": "The Quiet Watch on the Last Bridge",
  "body":  "Frodo lifts the chain off his neck; the ring slides into his palm, cold beyond cold. The hobbits' breath fogs the air. Above them the Bridge of Khazad-dûm groans. Whatever they choose now, the Shire stays a memory.",
  "seed":  "A young hobbit must choose whether to surrender the Ring at the bridge.",
  "franchise": "lotr"
}
```

**Correct output:**
```json
{
  "persona_label":  "Galadriel-style elven sage narrator",
  "search_query":   "Galadriel prologue The world is changed Lord of the Rings narration",
  "fallback_query": "Cate Blanchett LOTR audiobook reading interview",
  "reasoning":      "LOTR + grave Fellowship tone matches the canonical Galadriel prologue voice; query targets the calm narration not the drama."
}
```

### Example 2 — Death Note grim-detective tone

**Input:**
```json
{
  "title": "The Notebook in the Rain",
  "body":  "Light Yagami picks up the notebook from the wet pavement. The rules are written in a hand he does not know. He is seventeen and bored. The first name he writes will end a kidnapping he saw on the news that morning.",
  "seed":  "A bright high schooler finds a death note on the way home.",
  "franchise": "anime-generic"
}
```

**Correct output:**
```json
{
  "persona_label":  "Light Yagami-style cold internal monologue",
  "search_query":   "Death Note Light Yagami monologue English dub voice over",
  "fallback_query": "Brad Swaile interview voice actor narration",
  "reasoning":      "Death Note's signature register is the protagonist's calm internal monologue; English dub VO captures the cold-voiceover tone we want."
}
```

### Example 3 — Original grounded drama

**Input:**
```json
{
  "title": "The Phone Call",
  "body":  "Sarah's mother answered on the third ring, the way she always did, even though Sarah knew the answering machine had been picking up for a year now. Sarah did not say hello. She said the thing she had driven six hours to say.",
  "seed":  "A woman calls her dead mother and finally speaks the truth.",
  "franchise": null
}
```

**Correct output:**
```json
{
  "persona_label":  "warm middle-aged female audiobook narrator",
  "search_query":   "Anne Hathaway audiobook reading narration excerpt",
  "fallback_query": "Julianne Moore interview narration voice over",
  "reasoning":      "Grounded interior drama needs an empathetic mid-range female voice; audiobook actresses give the cleanest reference signal."
}
```

### Example 4 — Avatar (the airbender), warm-storyteller tone

**Input:**
```json
{
  "title": "The Last Tea Of Iroh",
  "body":  "Aang sits cross-legged across from Iroh. The tea is jasmine, the steam is small. Iroh tells the boy a story he has told before, but tonight the ending will be different.",
  "seed":  "Aang and Iroh share a final tea before the comet arrives.",
  "franchise": "avatar-airbender"
}
```

**Correct output:**
```json
{
  "persona_label":  "Iroh-style warm uncle storyteller",
  "search_query":   "Mako Iroh monologue Avatar Last Airbender narration",
  "fallback_query": "Greg Baldwin Iroh tea audiobook voice over",
  "reasoning":      "Avatar's emotional core is Iroh's storyteller voice; both Mako and his successor Greg Baldwin recordings exist as clean monologue material."
}
```

## Model preference

This is a templated, low-creativity classification — it benefits from a fast Gemini-class model rather than a deep reasoner.  The skill's correctness is in following the query rules, not in original ideation.

## Failure modes the caller must guard

- `search_query` returns nothing on YouTube → caller retries with `fallback_query`.
- Both queries fail → caller falls back to its baseline non-cloning TTS so the render never stalls on a missing voice sample.
- `voice_sample_builder` returns a wav the user rejects → caller may surface a regenerate button that re-fires this skill with the rejected query in a "blacklist" hint (extension; not part of v1.0).
