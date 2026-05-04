---
name: visual-prompt-builder
author: Noustiny
license: MIT
version: 1.1.0
description: "Rewrite a narrative beat into a rich photoreal visual description suitable for text-to-image models.  Strips every named intellectual-property reference and replaces each character / prop / place with a precise physical description.  Output is strict JSON — one ≤60-word prompt (≤90 for climax beats), zero IP names, built for FLUX / Nano Banana / SeeDream."
metadata:
  hermes:
    tags: [image-prompt, text-to-image, visual-description, photoreal, narrative]
    homepage: https://github.com/noustiny/noustiny-skills
    related_skills: [narrative-brainstorm, character-sheet-builder]
---

# Visual Prompt Builder

Convert a narrative beat into a frame-specific visual description.  The output is eaten by FLUX / SeeDream / Nano Banana as their user prompt.  They are eyes without minds — give them physical specifics (8 feet tall, violet skin, rune-engraved hammer), not narrative shorthand ("Thor").

## Input — single-beat OR batch

Single beat:
```json
{
  "title": "string",
  "body":  "string",
  "seed":  "string (optional — story logline)",
  "canonBeats": [{ "title": "...", "body": "..." }],
  "characters": { "Thor": "a tall blond warrior god..." },
  "franchise": "avatar-airbender | marvel | null",
  "allow_ip_names": true
}
```

Batch — same fields except `title`+`body` are replaced by a `beats` array:
```json
{
  "beats": [{ "title": "...", "body": "..." }, { "title": "...", "body": "..." }],
  "seed":  "string",
  "canonBeats": [...],
  "characters": {...},
  "franchise": "avatar-airbender",
  "allow_ip_names": true
}
```

- `franchise` — slug from the detector (`marvel`, `avatar-airbender`, `null`, …).
- `allow_ip_names` — when `true`, prompts MAY include the IP character name in addition to the physical description.  When `false`, prompts must stay fully IP-free (the existing sanitised form).  Let `allow_ip_names` control whether "Katara" appears or whether it must be rewritten as "fourteen-year-old brown-skinned Water Tribe girl".

## Output — STRICT JSON, no prose, no code fence

Single beat → one object:
```json
{
  "storyRegister": "<register line — see table>",
  "prompt":        "<≤60 words (≤90 for climax), ends with storyRegister verbatim>",
  "characters_seen": [{ "source_name": "Thor", "visual_description": "..." }]
}
```

Batch → JSON array in input order, same storyRegister for every entry:
```json
[
  { "storyRegister": "...", "prompt": "...", "characters_seen": [...] },
  { "storyRegister": "...", "prompt": "...", "characters_seen": [...] }
]
```

First char `{` or `[`, last char `}` or `]`.  Nothing else.  **No step-by-step reasoning, no craft notes, no markdown fences.**

## Rules

- **Fidelity to body — hardest rule.**  The prompt must render the body's literal stage action.  Every concrete physical fact in `body` (spatial relationship, posture, gesture stop-point, object state, who is where relative to whom) must appear in the prompt.
    - body `"Sokka's finger stops short of touching the blue arrow — he doesn't need to."` → prompt MUST say `"a stocky arctic polar boy with a warrior's ponytail hovers his index finger a centimetre above a glowing blue arrow tattoo, not touching it"` ✓
    - prompt `"a boy pointing at a glowing forehead"` ✗ (drops the "stops short / not touching" beat — the whole reason this is the beat)
  If the body says a gesture was *withheld*, the prompt shows the withholding, not the completed version.  If the body says someone is *trapped inside ice*, the prompt shows them inside ice, not on it.  Treat the body like a stage direction, not a summary.
- **Carry canon state forward — the single biggest continuity failure mode.**  Before writing your prompt, read the *last* `canonBeats` entry (title + body + imagePrompt when present) and note every visible state change it introduced — **these are permanent unless the current beat's body explicitly reverses them.**  Never let a destroyed/altered object silently revert to its pristine state just because the current body doesn't re-mention it.  Apply this generically across any franchise:

  **What counts as a persistent visual state change (all genres):**
  - **Objects damaged / destroyed:** shattered glass, cracked ice, collapsed wall, split hull, torn cloak → STAY damaged in the next frame.  No auto-repair.
  - **Objects moved / consumed / lost:** a sword dropped into water, a document burned, a phone thrown off a cliff, a pill swallowed, a key used and left in the lock → the object is where it last was, not back in the character's hand.
  - **Characters released / captured / killed / wounded:** freed from bonds, pulled from wreckage, bleeding, unconscious, dead → the state carries forward.  A character freed from ice in beat N is NOT encased in ice again in beat N+1.  A dead character stays dead.
  - **Environment altered:** doors now open, room on fire, hallway flooded, mask removed, armor dented, face scarred → the alteration persists.
  - **Spatial position:** a character who climbed a ladder is now on the upper level; a vehicle that crashed is wrecked on the ground.

  Examples of the failure this rule prevents (any franchise, any medium):
    - ❌ Beat N: *"Katara shatters the ice block and pulls Aang free."* · Beat N+1: body says *"Aang drifts in the cold cavern."* · Prompt shows Aang **back inside an intact iceberg** with Katara and Sokka peering in from outside — WRONG.  The ice is already shattered; Aang is already out.  Prompt MUST show **broken ice shards on the cavern floor with Aang standing amid them**, not a new intact prison.
    - ❌ Beat N: *"Tony crushes the gauntlet; the stones go dark."* · Beat N+1: body says *"Tony kneels in the rubble."* · Prompt shows **a glowing intact gauntlet** on Tony's hand — WRONG.  The gauntlet is destroyed; prompt MUST show burnt/twisted metal on his arm or no gauntlet at all.
    - ❌ Beat N: *"Walt drops the phone into the river."* · Beat N+1: body says *"Walt walks down the dirt road."* · Prompt shows **a phone in Walt's hand** — WRONG.  The phone is gone; his hand is empty.

  Rule of thumb: if beat N's image shows the world visibly changed (something broken, someone freed, fire lit, person wounded), beat N+1's prompt must **inherit that changed world visually**, not reset it.  Read `canonBeats[canonBeats.length - 1].imagePrompt` when present — it tells you what the last frame actually depicted.
- **Prompt MUST open with the established setting.**  First phrase of the prompt is the location/environment inherited from the most recent `canonBeats` entry.  Do NOT lead with emotion or gesture and trust the model to infer location — if the parent beat is inside a cracking iceberg at the South Pole, the child prompt starts `"Inside the cracking South Pole iceberg, …"` even if the child body doesn't re-mention it.  Models latch onto the first phrase; an abstract opener ("Overwhelmed by sudden faces, Aang gasps…") makes them invent a new setting (desert ruins, stone statues) instead of reusing the iceberg.
    - canon `"Aang opens his eyes inside a cracking iceberg"` + child body `"Overwhelmed by the sudden faces, Aang gasps and airbends, shooting upward"` → prompt: `"Inside the cracking South Pole iceberg, Aang, a twelve-year-old bald monk boy with a blue arrow tattoo, looks up through the fractured ice at Katara and Sokka; he gasps and airbends violently, a swirling vortex of wind propelling him upward through the shattered shell, …"` ✓
    - prompt `"Overwhelmed by sudden faces beneath him, Aang gasps and airbends, shoots upward above stone temple ruins, …"` ✗ (drops iceberg, drops Katara/Sokka, invents "stone ruins")
- **Resolve ambiguous nouns against canon.**  The word "faces" in a body usually means the human faces already in the scene (Katara, Sokka).  Never interpret it as decorative motifs, stone carvings, or crowds the canon hasn't established.
- **IP naming rule** — conditional on `allow_ip_names`:
  - `allow_ip_names: true` → prompts MAY keep canonical IP names in addition to rich physical descriptions.  "Katara kneels beside the fractured ice…" is fine; back it up with the registry description so a model that doesn't recognise the name still renders faithfully.
  - `allow_ip_names: false` → prompts MUST be IP-free.  *Thor → thunder-god warrior*, *Mjolnir → rune-engraved war hammer*, *Stormbreaker → short-handled thunder axe*, *Infinity Gauntlet → six-gem golden armor glove*, *Thanos → eight-foot violet-skinned titan warlord*, *Na'vi → ten-foot blue-skinned forest humanoid*, *Aang → bald monk boy with a blue arrow tattoo*.
- Reuse `characters[name]` verbatim when the beat names that character.  If a character is on-frame but missing from the map, synthesise one description and include it in `characters_seen`.
- Every pronoun resolved to its noun phrase.  No "he / she / it" in the prompt.
- `storyRegister` is **derived from `seed` once** and appended verbatim to the `prompt`.  Consistent storyRegister across every beat locks the storyboard's look.
- Climax beats (mood = `climax`): budget 90 words, may add one intensifier clause after the register.
- Non-climax beats: 60 words, no intensifier.

## Story register table — pick one row from the seed

| Seed fingerprint | storyRegister |
|---|---|
| Superhero finale, ensemble (Marvel/DC vibe) | `superhero-finale, operatic cosmic, IMAX 70mm color grade, high dynamic range, heroic silhouettes` |
| Space opera, starships, alien worlds | `space-opera, practical-effects cinematic, anamorphic lens flares, deep navy shadows, amber cockpit glow` |
| Anime / bending / cel-shade (Airbender, Naruto, One Piece) | `animated-feature, cel-shaded 2D animation, crisp ink outlines, vibrant saturated palette, Studio Mir-style atmospheric shading` |
| High fantasy, sword and sorcery | `high-fantasy epic, oil-painting detail, volumetric cathedral light, earth-and-ember palette` |
| Noir / neo-noir crime | `neo-noir, chiaroscuro lighting, desaturated navy and sodium yellow, wet asphalt reflections` |
| Horror, supernatural dread | `gothic horror, candle-flame key light, cold mist, near-black shadows, shallow focus terror` |
| Domestic drama, literary interior | `quiet literary drama, natural window light, muted earth tones, medium-format stills` |
| Coming-of-age, YA | `warm coming-of-age, golden-hour sun, pastel sky, soft grain` |
| Period piece / historical | `period drama, candle-lit interiors, hand-dyed fabric tones, academy 1.66 framing` |
| Cyberpunk megacity | `cyberpunk neon-noir, magenta and teal key lights, wet neon reflections, low-angle anamorphic` |
| Unclear / default | `cinematic, balanced naturalism, 35mm film` |

Same row for every beat in the story — do not vary mid-storyboard.

## Prompt composition order

primary subject → their posture/action → what they hold → secondary subjects → setting → lighting → **storyRegister (verbatim)**.

## Anti-patterns

- Never name a copyrighted character, place, faction, or artifact.
- Never break the 60/90 word budget (storyRegister counts toward it).
- Never narrate internal state ("feeling scared") — show the body.
- Never output reasoning steps or "Step 1…" sections.  JSON only.
- Never wrap JSON in triple backticks.

## Example

Input:
```json
{
  "title": "Thor takes it, burns with it",
  "body":  "Thor clamps the gauntlet shut; the stones flood his arm. Skin goes white, then blackens.",
  "seed":  "In the final battle against Thanos, every Avenger must choose what to sacrifice.",
  "characters": {"Thor": "a tall blond bearded warrior god, scuffed dark plate armor with crimson cape"}
}
```

Output:
```json
{
  "storyRegister": "superhero-finale, operatic cosmic, IMAX 70mm color grade, high dynamic range, heroic silhouettes",
  "prompt": "A tall blond bearded warrior god clamps a six-gem golden armor glove on his left fist, skin bleaching white then blackening as radiant light of six stones floods his arm; standing on a ruined temple plaza, dust and embers, low amber rim-light, superhero-finale, operatic cosmic, IMAX 70mm color grade, high dynamic range, heroic silhouettes.",
  "characters_seen": [
    {"source_name": "Thor", "visual_description": "a tall blond bearded warrior god, scuffed dark plate armor with crimson cape"}
  ]
}
```
