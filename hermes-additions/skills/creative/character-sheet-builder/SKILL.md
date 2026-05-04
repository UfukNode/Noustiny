---
name: character-sheet-builder
author: Noustiny
license: MIT
version: 1.0.0
description: "Produce a cast sheet of 1–4 named characters from a story seed.  Each entry has a canonical-but-IP-free visual description and a hero-portrait prompt ready to drop into a text-to-image model.  Downstream: portraits become the reference frames every subsequent beat image will condition on, locking character consistency across the whole storyboard.  Fires once per story at canvas-enter, after story-copyright-detector."
metadata:
  hermes:
    tags: [character-sheet, reference-image, portrait-prompt, story-bible, visual-consistency]
    homepage: https://github.com/noustiny/noustiny-skills
    related_skills: [story-copyright-detector, visual-prompt-builder]
---

# Character Sheet Builder

Every text-to-image render reinvents the characters unless the model has a reference to condition on.  This skill solves that by producing the character bible up front.  One hero portrait per principal character → cached → passed as a reference to every later beat.  Result: the same Aang face, the same Katara braid, the same Tony Stark armor, across every frame of the storyboard.

## When to use

Fire **exactly once** when the canvas opens with a fresh seed, immediately after `story-copyright-detector` tells you the franchise.  Never re-fire for the same story.

## Input shape

```json
{
  "seed": "Aang opens his eyes for the first time in a hundred years…",
  "franchise": "avatar-airbender",
  "storyRegister": "animated-feature, cel-shaded 2D animation, crisp ink outlines, vibrant saturated palette, Studio Mir-style atmospheric shading",
  "allow_ip_names": true
}
```

- `seed` — the full logline
- `franchise` — slug from the detector (`marvel`, `avatar-airbender`, `lotr`, `null`, …).  `null` means original seed.
- `storyRegister` — the visual register token set to append to every portrait_prompt so the character sheet's aesthetic matches the beat-level frames.
- `allow_ip_names` — when `true`, the caller's image model accepts franchise IP tokens (typically Gemini / SeeDream on animated franchises).  Portrait prompts MAY then include named characters ("Katara from Avatar: The Last Airbender…").  When `false` (FLUX path / strict-filter models), portrait prompts MUST stay IP-free (the existing "bald monk boy with blue arrow tattoo" sanitised form).

## Output contract

Return **exactly one JSON array**, nothing else.  First character `[`, last `]`.

```json
[
  {
    "name": "Aang",
    "description": "twelve-year-old bald monk boy, blue arrow tattoo down the brow, wide silver-grey eyes, saffron-and-orange layered robes, slim athletic child frame, bare feet, ever-curious expression",
    "portrait_prompt": "hero portrait, full-body, twelve-year-old bald monk boy with a blue arrow tattoo on his brow, wide silver-grey eyes, saffron-and-orange layered robes, bare feet, light neutral studio backdrop, three-quarter pose, soft key light, animated-feature, cel-shaded 2D animation, crisp ink outlines, vibrant saturated palette"
  },
  {
    "name": "Katara",
    "description": "fourteen-year-old brown-skinned Water Tribe girl, cobalt fur-trimmed parka with ivory trim, dark hair in twin looped front braids, bright blue eyes, hopeful open face",
    "portrait_prompt": "hero portrait, full-body, fourteen-year-old brown-skinned teenage girl, cobalt blue fur-trimmed parka, ivory bone trim, dark hair styled in twin looped front braids, bright blue eyes, light neutral studio backdrop, three-quarter pose, soft key light, animated-feature, cel-shaded 2D animation, crisp ink outlines, vibrant saturated palette"
  },
  {
    "name": "Sokka",
    "description": "fifteen-year-old brown-skinned Water Tribe boy, cobalt fur-trimmed parka, high wolf-tail topknot, sharp jaw, wry skeptical expression, boomerang sheath at his back",
    "portrait_prompt": "hero portrait, full-body, fifteen-year-old brown-skinned teenage boy, cobalt blue fur-trimmed parka, dark hair pulled into a high wolf-tail topknot, wry skeptical expression, boomerang sheath at back, light neutral studio backdrop, three-quarter pose, soft key light, animated-feature, cel-shaded 2D animation, crisp ink outlines, vibrant saturated palette"
  }
]
```

## Rules

- 1 to 4 characters max.  Focus on PRINCIPALS actually named or strongly implied in the seed.  Skip incidental / unnamed bystanders.
- `name` — the canonical short name used in the source (first-name only unless ambiguous).  Used as the key in the downstream character registry, so it must match whatever the beat prose will reference.
- `description` — rich physical detail, **no** IP names, no franchise terms.  *Thor → thunder-god warrior with blond beard and Norse-style plate armor with red cape*, not "Thor".  Every description must be reusable verbatim in every subsequent beat.
- `portrait_prompt` — a full-body hero portrait prompt for a text-to-image model.  Must end with the provided `storyRegister` string verbatim so every portrait and every beat share the same aesthetic grammar.
- **IP naming rule** — conditional on `allow_ip_names`:
  - `allow_ip_names: true` → portrait_prompt MAY name the canonical character ("hero portrait of Katara from Avatar: The Last Airbender, cobalt fur-trimmed parka, twin looped front braids…").  Always follow the name with the rich physical description anyway — the image model gets the best of both if it recognises the name, and the description if it doesn't.
  - `allow_ip_names: false` → portrait_prompt MUST be fully sanitised (IP-free).  "Katara" becomes "fourteen-year-old brown-skinned Water Tribe girl…" every time.
- The `description` field is ALWAYS the IP-free version (downstream beats reuse it regardless of model).  Only the `portrait_prompt` is conditional.
- For original seeds (`franchise: null`): invent characters from what the seed implies.  If the seed doesn't name anyone, produce one default protagonist + any strongly implied secondary.  `allow_ip_names` is moot for originals — no IP to name anyway.
- Output is strict JSON array.  No markdown code fences.  No preamble prose ("Here are the characters…").  No trailing notes.  First char `[`, last `]`.

## Anti-patterns

- Do not name an IP character in the portrait_prompt when `allow_ip_names: false` — that tells the caller the image model will reject named prompts.
- When `allow_ip_names: true`, do not rely on the name alone — always include the rich physical description as well.
- Do not invent characters not implied by seed or canon.
- Do not exceed 4 entries.  A bloated cast sheet wastes image-gen calls.
- Do not output reasoning, step-by-step notes, or "here's my thinking" prose.  JSON array only.
- Do not wrap the portrait prompt in quotes or add "--style" flags.  Plain prose only.

## Worked examples

### Marvel Endgame seed

```json
{
  "seed": "Tony Stark holds the Infinity Gauntlet on the Avengers compound battlefield — every possible ending hangs on what he does next.",
  "franchise": "marvel",
  "storyRegister": "superhero-finale, operatic cosmic, IMAX 70mm color grade, high dynamic range, heroic silhouettes"
}
```

Correct output:

```json
[
  {
    "name": "Tony Stark",
    "description": "lean mid-forties man, dark close-cropped hair, sharp goatee, sharp brown eyes, cracked and battle-worn red-and-gold articulated plate armor with a glowing chest core",
    "portrait_prompt": "hero portrait, full-body, lean mid-forties man with dark close-cropped hair and a sharp goatee, cracked red-and-gold articulated plate armor with a faintly glowing chest core, sharp brown eyes, three-quarter pose, soft key light on a neutral grey backdrop, superhero-finale, operatic cosmic, IMAX 70mm color grade, high dynamic range, heroic silhouettes"
  }
]
```

### Grounded original seed

```json
{
  "seed": "Walt is on the payphone outside the diner in New Hampshire. Everything he is considering would end something.",
  "franchise": null,
  "storyRegister": "quiet literary drama, natural window light, muted earth tones, medium-format stills"
}
```

Correct output:

```json
[
  {
    "name": "Walt",
    "description": "bald late-fifties man, neat greying goatee, wire-frame glasses, heavy navy winter parka, tired grey-blue eyes, slight hunch at the shoulders",
    "portrait_prompt": "hero portrait, full-body, bald late-fifties man with a neat greying goatee, wire-frame glasses, heavy navy winter parka, tired grey-blue eyes, three-quarter pose, soft key light on a neutral grey backdrop, quiet literary drama, natural window light, muted earth tones, medium-format stills"
  }
]
```
