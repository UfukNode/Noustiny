---
name: storybook-intro
author: Noustiny
license: MIT
version: 1.0.0
description: "Decide cinematic intro parameters for the Noustiny storybook tool. Given a story title, snapshot path beats and an image count, choose the right pace, tone, transition and duration so the opening montage matches the story's energy. Use this skill whenever the noustiny_storybook tool is being invoked in audiobook mode and any of intro_pace, intro_tone, intro_transition, intro_duration_secs are left for the agent to decide."
metadata:
  hermes:
    tags: [video, intro, storybook, marvel, noustiny, cinematic, montage]
    homepage: https://github.com/noustiny/noustiny-skills
    related_skills: []
---

# Storybook Intro Director

You are deciding **how the opening cinematic of a Noustiny storybook plays**. The tool you'll dispatch to is `noustiny_storybook`. Your output is the parameter set, not the video — the tool's render service does the actual ffmpeg / Playwright work.

This is a directing decision: pace, colour palette, transition style and total length. A wrong call here makes a story about a dystopian detective feel like a children's birthday slideshow, or compresses an epic fantasy into a 3-second blink.

## When to invoke

Trigger this skill whenever:

1. The web app message contains `mode=audiobook` (intros only run in audiobook mode — `mode=intro` is itself a standalone teaser, no separate intro is rendered).
2. The user message says **"intro_style=auto"** or omits the cinematic parameters (`intro_pace`, `intro_tone`, `intro_transition`, `intro_duration_secs`). Auto mode is the contract that says "AI, you choose."

If the user message **explicitly** sets `intro_pace=fast intro_tone=marvel-red ...`, respect those — they overrode you. Only fill what's missing.

## Inputs you have

The web app composes a user message like:

```
Render a Noustiny storybook. snapshot_id=<id>, endpoint_id=<id>, mode=audiobook,
audio=true, language=tr, intro_style=marvel, intro_duration_secs=auto.
Story tone hint: dark psychological thriller. Image count: 7.
```

Extract:

- **story_title** — the title field if present, otherwise infer from `endpoint_id` slug
- **tone_hint** — explicit phrase like *"dark psychological thriller"* or *"epic heroic fantasy"*
- **image_count** — number of images that will feed the montage (typically the path length, capped at 12)
- **user_duration** — slider value if the user picked one (e.g. `intro_duration_secs=10`); `auto` means you choose
- **language** — `tr | en | es | fr | de` (doesn't change pace/tone but adjusts how you label the title beat)

## Decision rules

### 1. intro_tone — colour palette

Map tone hint to one palette key:

| Story tone hint | Pick |
|---|---|
| epic, heroic, superhero, action, blockbuster | `marvel-red` |
| triumphant, mythic, royalty, fantasy hero, coming-of-age | `hero-gold` |
| sci-fi, tech, mystery, cyberpunk, neon noir | `cinematic-cyan` |
| dark, detective, dystopian, thriller, war | `noir-gray` |
| magical, arcane, dream, fairytale, witch, sorcery | `magical-purple` |
| horror, gore, slasher, blood, demonic | `horror-blood` |

If the hint is empty or ambiguous, fall back to `cinematic-cyan` — it's the cleanest default and reads as "premium movie trailer" without committing to a sub-genre.

### 2. intro_pace — per-image visible time

`pace` controls cuts-per-second.  Higher cut density = more energy
regardless of tone; the chosen tone palette colours the visuals, not
the cadence.  Use these HARD rules in order:

1. **`image_count >= 5` → ALWAYS `fast`.** Many images at slow pace
   reads as a slideshow no matter the tone.  The renderer auto-loops
   the stack to fill duration; the cycle cap (3×) keeps it sane.
2. `image_count == 4` → `medium` by default; bump to `fast` if tone is
   `marvel-red`/`horror-blood`/`hero-gold`; bump to `slow` if tone is
   `noir-gray`/`magical-purple`.
3. `image_count <= 3` → `slow` (each beat earns the screen).  Bump to
   `medium` only if tone is `marvel-red`/`horror-blood`.

Implementation seconds (reference only, not your decision):
fast=0.30s/img, medium=0.70s, slow=1.30s.  Don't recompute pace from
`duration / image_count` — that math fights the loop logic.

### 3. image_loop — repeat the stack

**Default is `image_loop=true` whenever `pace=fast`.**  At fast pace each
image gets ~0.45s on screen, which means the stack burns through quickly
and the rest of the timeline would go black if we don't cycle.  Marvel's
opening montage works precisely *because* the imagery keeps flooding — a
held-still tail kills the energy.

Concrete rules:

- `pace=fast`  → `image_loop=true`, full stop.  The viewer should feel
  the same images cycling on top of each other to drive momentum.
- `pace=medium` → `image_loop=true` only when `image_count <= 4` AND
  `duration >= 7s` (otherwise the stack covers the timeline naturally).
- `pace=slow`  → `image_loop=false` always.  Slow pace + loop reads as
  cheap padding.

### 4. intro_transition — keyframe profile

| Pace × tone | Pick |
|---|---|
| `fast` + any tone | `cut` (Marvel rapid cuts) |
| `medium` + `marvel-red`/`horror-blood` | `whip` (motion energy) |
| `medium` + any other | `fade` (cinematic crossfade) |
| `slow` + any tone | `fade` (let images breathe) |

Edge case: if `image_count >= 8`, force `cut` — too many slow fades blur the montage into mush.

### 5. intro_outro — exit overlay to the audiobook body

The intro's settle frame holds at scale 1.0, then the audiobook's first
narrated page lands.  Without an outro the cut feels brutal.  Pick the
overlay that bridges the energy:

| Tone × pace | Pick |
|---|---|
| `marvel-red` or `horror-blood` (any pace) | `fade-black` (theatrical curtain) |
| `hero-gold` or `magical-purple` (any pace) | `page-close` (book-closing storybook feel) |
| `cinematic-cyan` (any pace) | `split-vertical` (sci-fi vault close) |
| `noir-gray` (any pace) | `split-vertical` (detective-room reveal) |
| `pace=slow` (any tone) | prefer `hold` — the stillness IS the moment |

If the user explicitly chose `intro_outro=<value>`, respect it.

Default if unclear: `fade-black` for fast pace, `hold` for slow pace,
`page-close` for medium pace.

### 6. beat_transition — how audiobook beats connect

After the intro outro lands, the audiobook body plays each path beat in
sequence.  This param decides how those beats join:

- `hardcut` — no fade, beat hard-cuts to next beat.  Fits urgent / fast
  pace and tones with built-in adrenaline (marvel-red, horror-blood).
- `fade-chapter` — each beat fades in from black + out to black.  Reads
  as a chapter break and matches storybook narration cadence.

Rules:

- `pace=fast` AND tone in (marvel-red, horror-blood) → `hardcut`
- `pace=slow` (any tone) → `fade-chapter`
- otherwise → `fade-chapter` (default — most stories want chapter feel)
- if path length ≥ 12 → still `fade-chapter` but the renderer auto-shortens
  the per-beat fade; you don't need to bump anything

### 7. voice_gender — TTS narrator gender

Picks a male or female neural voice within the chosen language locale.
Drive from tone:

| Story tone | Pick |
|---|---|
| horror, war, dark detective, dystopian, gore | `male` (gravelly storyteller) |
| magical, fairytale, coming-of-age, fantasy, sci-fi | `female` (warm narrator) |
| epic hero, heroic fantasy, action | `male` (heroic narrator) |
| triumphant / royal / mythic | `female` (regal voice) |

If the user explicitly chose `voice_gender=<x>`, respect it.

Default if unclear: `female`.

### 8. voice_style — TTS prosody profile

Drives `rate` + `pitch` on the neural voice for narrative texture.

| Story tone | Pick |
|---|---|
| horror, war, dystopian, gore | `dramatic` (slow + deeper) |
| thriller, detective, noir | `whisper` (hushed intimate) |
| fairytale, coming-of-age, magical | `bright` (lively + brighter) |
| epic hero, triumphant, sci-fi, default | `narrator` (warm storyteller) |

### 9. subtitle_source — caption text origin

Decides which node field becomes the on-screen caption.

- `audiobook` mode (default) → `body-snippet` so subtitles match the
  spoken language, since both come from the same field.
- `intro` mode → `title` (cinematic identity, short label is enough).
- User explicitly wants no captions → `none`.

### 10. chapter_markers — seek-bar bookmarks

Embed FFMETADATA chapter list?

- `audiobook` → `true` (long content benefits from MPC/VLC navigation).
- `intro` → `false` (too short to matter).

### 11. narration_translate — translate body to audio locale before TTS

When the snapshot's narrative bodies are likely in a different language
than the requested `language`, the renderer can translate each body via
Hermes before TTS — keeping spoken line and subtitle in the same locale.

Rules:

- The user message tells you `language=<x>`.
- Inspect the **Story tone hint** + **Ending beat** snippets the route
  forwards.  If those phrases look like the audio language, body is
  probably already in that language → `narration_translate=false`.
- If the tone hint contains characters from a different alphabet than
  the requested locale (Turkish letters `ı`, `ş`, `ğ`, `ç` while
  `language=en`; or Latin while `language=tr` and the hint mentions
  Turkish words) → `narration_translate=true`.
- When in doubt and `language != tr` → set `narration_translate=true`.
  Snapshot bodies are most often Turkish in this Noustiny instance.

Default: `false` for `language=tr` renders, `true` otherwise.

### 12. intro_sfx — synthetic SFX track on the intro mp4

The renderer mirrors the JS plan composer in Python and places one
audio "hit" at every visual cut, so SFX cadence locks to image
cadence — no manual timing math.  A final settle hit lands at the
outro start.  Pick by tone:

| Story tone | Pick |
|---|---|
| marvel-red, horror-blood, action | `marvel-jet` (whip whoosh per cut + final jet pass) |
| hero-gold, magical-purple, fairytale | `page-turn` (paper crinkle per cut) |
| cinematic-cyan, sci-fi | `whoosh` (soft low pass + deep settle) |
| noir-gray, dystopian, dread | `cinematic-rumble` (sustained low rumble, no per-cut hits) |
| user explicitly wants silent intro | `none` |

Default if unclear: `marvel-jet` (most generic energetic option).

### 13. intro_duration_secs — total seconds

If the user picked a slider value (e.g. `intro_duration_secs=10`), respect it.

If `auto`, the rule is **static, not math-derived**: the NOUSTINY logo
needs a fixed window to read its zoom-out smoothly regardless of how many
images are stacked behind it. The renderer auto-loops the image stack
inside that window at 50ms-per-image cuts (fast pace), so adding more
images doesn't lengthen the intro — it just packs more cycles into the
same 10 seconds.

```
if image_loop:
    duration = 10.0     # static — many-image case, loops within window
else:
    # No-loop mode: per-image pace × image_count + 1s tail, but still
    # clamped to a minimum so the logo animation doesn't strobe.
    duration = clamp(round(pace_seconds * image_count + 1.0), 6, 10)
```

Concrete picks:

| image_count | image_loop | duration |
|---|---|---|
| 40, fast | true | **10s** (5 cycles of 40×50ms) |
| 15, fast | true | **10s** (~13 cycles of 15×50ms) |
| 6, fast | true | **10s** (~33 cycles — pleasant flicker, but logo reads) |
| 6, slow | false | clamp(round(0.7×6+1), 6, 10) = **6s** |
| 3, slow | false | clamp(round(0.7×3+1), 6, 10) = **6s** (clamp floor) |

## Output contract

You don't write prose for this skill. You produce a **single tool call** to `noustiny_storybook` with all parameters filled. Pass through the snapshot_id / endpoint_id / mode / audio / language exactly as the user message stated. Decide the cinematic params per the rules above.

Example — user said `intro_style=auto`, tone hint *"epic Avatar-style hero quest"*, 6 images:

```json
{
  "snapshot_id": "abc123...",
  "endpoint_id": "n_xyz",
  "mode": "audiobook",
  "audio": true,
  "language": "tr",
  "intro_style": "marvel",
  "intro_pace": "fast",
  "intro_tone": "hero-gold",
  "intro_transition": "cut",
  "intro_outro": "page-close",
  "intro_duration_secs": 5.5,
  "image_loop": false
}
```

Reasoning trace (don't include in the tool call, but think it):

> 6 images, "epic hero quest" → hero-gold for triumph, fast pace because we have enough images to cut through, cut transition (Marvel rapid montage). Duration 6×0.45 + 1.5 = 4.2 → clamped up to 5.5s. No loop needed.

## Anti-patterns

- Picking `slow` + 8 images + 12 seconds — produces a sluggish slideshow.
- `marvel-red` for a kids' fairytale — pick `hero-gold` or `magical-purple`.
- `image_loop=true` with `pace=slow` — the loop becomes obvious and cheap.
- Forgetting `intro_style=marvel` when filling `intro_pace/tone/transition` — those atomic params only apply when the high-level style is `marvel`. If the user wants `detroit` or `cinematic`, leave atomic params at defaults.
- Returning prose advice instead of dispatching the tool. The web app is waiting on a video URL, not your essay.
