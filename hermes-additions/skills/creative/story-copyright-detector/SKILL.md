---
name: story-copyright-detector
author: Noustiny
license: MIT
version: 1.0.0
description: "Classify a story seed by its intellectual-property weight so downstream image pipelines can pick the right render strategy.  Returns {ip_level: known|inspired|original, franchise, model_preference: flux-photoreal|gemini-stylised} as strict JSON.  Known franchises (Marvel, Star Wars, Harry Potter, GoT, Avatar, DC, LOTR, Anime) trigger the FLUX + moderation-rewriter ladder because their vocabulary sets off BFL/Google safety filters.  Original stories get sent straight to Gemini/Nano Banana — cheaper, faster, stylised, no filter dance required.  Use once per story, at canvas-enter time."
metadata:
  hermes:
    tags: [copyright, ip-detection, router, image-pipeline, story-classifier]
    homepage: https://github.com/noustiny/noustiny-skills
    related_skills: [visual-prompt-builder, narrative-brainstorm]
---

# Story Copyright Detector

Every image pipeline wants to be the right pipeline for the story.  A Marvel-finale seed cannot go to Gemini — one mention of "Iron Man" and the render refuses.  A kitchen-sink drama seed should not be forced through FLUX's heavier photoreal render when Nano Banana would paint the scene in half the time with warmer tones.

This skill looks at the seed once and decides the route.  One JSON object, fire and forget.  Downstream stores it and every subsequent image-gen reads the preference out of memory instead of re-asking.

## When to Use

- User enters canvas with a fresh seed — fire this skill exactly once.
- User resets the story → fire again because the seed changed.
- Do NOT re-fire per beat — the decision is story-scoped, not frame-scoped.

## Input Shape

```json
{
  "seed": "Tony Stark holds the Infinity Gauntlet on the Avengers compound battlefield — every possible ending hangs on what he does next."
}
```

## Output Contract

Return **exactly one JSON object**, nothing else:

```json
{
  "ip_level": "known",
  "franchise": "marvel",
  "model_preference": "flux-photoreal",
  "reason": "Named Marvel characters (Tony Stark, Avengers), franchise-coded artifact (Infinity Gauntlet); image filters will reject verbatim prompts — route to FLUX with moderation-rewriter retry ladder."
}
```

Rules:

- `ip_level` ∈ `"known" | "inspired" | "original"`.
  - **known**: names a specific copyrighted franchise (Marvel, Star Wars, DC, Harry Potter, Game of Thrones, Lord of the Rings, Avatar (Cameron), Avatar: The Last Airbender, Dune, One Piece, Naruto, Attack on Titan, anything with a trademarked character name or title).
  - **inspired**: reads like a derivative of a known register ("a hacker with a cybernetic implant", "a farmboy called to an ancient prophecy") without naming any IP — filters are unlikely to trip.
  - **original**: a grounded, non-genre scene (a phone call, a decision, a kitchen-sink memory, an unnamed character's interior).
- `franchise`: lowercase slug (`marvel`, `star-wars`, `harry-potter`, `got`, `lotr`, `dc`, `avatar-cameron`, `avatar-airbender`, `dune`, `one-piece`, `naruto`, `attack-on-titan`, `anime-generic`, `breaking-bad`, `the-wire`, …) OR `null` for non-franchise seeds.
- `model_preference`:
  - **`flux-photoreal`** when `ip_level="known"` — FLUX handles IP-sanitized prompts best, photoreal cinematic look, goes through moderation-rewriter on refuse.
  - **`gemini-stylised`** when `ip_level` is `"inspired"` or `"original"` — Nano Banana is cheaper, faster, stylised; filter won't trip because there are no trademarks to collide with.
  - Exception: if `ip_level="inspired"` but the seed is heavy on violence / body horror, prefer `flux-photoreal` (FLUX's violence tolerance is higher than Gemini's).
- `reason`: one sentence, human-readable, explains the call.  Shown in the agent ticker so the demo viewer sees "WHY the router picked this model".

No markdown code fences, no preamble.  First character `{`, last character `}`.

## Heuristic checklist

Walk the seed in this order:

1. **Named character / franchise token** — proper nouns that are unmistakably trademarked (Tony Stark, Frodo, Hogwarts, Darth Vader, Jon Snow, Katara, Aang, Naruto Uzumaki, Luffy, Paul Atreides, Walter White).  If one or more hits → `known`.
2. **Franchise-coded artifacts / places** — Infinity Gauntlet, Mjolnir, lightsaber, the Ring, the Iron Throne, Pandora, Hogwarts, Shire, Spice, Hidden Leaf Village.  If one or more hits → `known`, franchise inferred from the token.
3. **Register archetypes without a name** — "a cybernetic hacker", "a farmboy prophecy", "a blue-skinned forest people" → `inspired`.
4. **Grounded interior / decision / memory / original character** → `original`.
5. **Empty or unintelligible seed** → `original`, `model_preference="gemini-stylised"`, `reason="empty seed — default stylised path"`.

## Model preference shorthand

| Detected franchise | model_preference | Why |
|---|---|---|
| marvel / dc / star-wars / lotr / got / harry-potter / dune / avatar-cameron | `flux-photoreal` | Live-action aesthetic — FLUX photoreal cinematic matches the register |
| **avatar-airbender / naruto / one-piece / attack-on-titan / anime-generic** | `gemini-stylised` | **Animation register — Nano Banana handles cel-shade natively AND supports multi-modal reference portraits for character consistency** |
| breaking-bad / the-wire (grounded drama) | `gemini-stylised` | Grounded realistic look — Nano Banana's warmer palette suits the register |
| null (original) | `gemini-stylised` | No IP to dodge, cheap path wins |

## Anti-patterns

- Do NOT return the full reasoning — one short `reason` line only.
- Do NOT add suggestions, alternatives, or markdown.  JSON only.
- Do NOT over-flag — "a decision at a crossroads" is NOT a franchise even if it sounds Harry Potter-ish.  Require an actual named token.
- Do NOT under-flag — "the compound battle" + "gauntlet" is Marvel even without saying Marvel.

## Example

**Input:**
```json
{ "seed": "A hacker wakes at the foot of Galata Tower with a cybernetic implant under the skin of the forearm and no memory of the last three years. It is 03:17." }
```

**Correct output:**
```json
{
  "ip_level": "inspired",
  "franchise": null,
  "model_preference": "gemini-stylised",
  "reason": "Cyberpunk register (cybernetic implant, amnesiac hacker) with original setting (Galata Tower); no trademark tokens; stylised path is cheaper and filter-safe."
}
```

**Input:**
```json
{ "seed": "Aang returns to the Southern Air Temple after a hundred years and finds it empty — every air nomad gone, their bison's bones in the snow." }
```

**Correct output:**
```json
{
  "ip_level": "known",
  "franchise": "avatar-airbender",
  "model_preference": "flux-photoreal",
  "reason": "Named IP character (Aang) + franchise-coded setting (Southern Air Temple) + species (air nomads, sky bison) — image filters will refuse verbatim; route to FLUX with moderation retry."
}
```
