---
name: narrative-writer-assist
description: "Flesh a single-sentence author intent into a full Detroit-style narrative beat that splices into an existing canon path. Returns strict JSON with title, summary, body, imagePrompt, mood, tone, and worldPercent. Use when the user is inserting a beat between two known story nodes and has typed a short intent describing what should happen there. No prose, no reasoning, no tool calls."
version: 1.0.0
author: Noustiny
license: MIT
metadata:
  hermes:
    tags: [narrative, storytelling, writer-assist, beat-insertion, dramaturgy, interactive-fiction]
    homepage: https://github.com/noustiny/noustiny-skills
---

# Narrative Writer-Assist

The dramaturge's hand. Given the story so far, two adjacent beats the user wants to splice between, and a single line of authorial intent, produce one fully formed beat that lands between them without breaking canon.

This skill is the partner of `narrative-brainstorm`. Brainstorm proposes three forks from a single parent when the author has no specific idea. Writer-assist executes one specific idea the author already has.

## When to Use

Trigger this skill when the user is inserting a beat into an existing canon path and has written their own intent for that beat. Typical phrasings:

- "insert a beat between X and Y where …"
- "splice a scene in, intent: …"
- "flesh this out into a beat"
- "write the moment where …"
- mode-tagged: "insert as canon" / "insert as what-if"

## Scope

**Best suited for:**
- InsertModal-style flows where the user picks two adjacent nodes and types an intent
- Mid-flow authorial interventions that belong on a known canon spine
- Rewrites where the user wants the agent to honour a specific cause rather than invent one

**Look elsewhere first for:**
- Generating multiple branch options from a parent → `narrative-brainstorm`
- Rewriting an existing downstream beat after an upstream contradiction → `narrative-rewriter`
- Grouping already-written beats into scenes → `scene-composition`
- Final prose rendering of the canon spine → `narrative-writer`

This skill fires exactly once per insert. If the user has no intent and wants options, send them to `narrative-brainstorm`.

## Input Shape

The user message contains a single JSON object:

| Field | Type | Required | Purpose |
|---|---|---|---|
| `seed` | string | yes | The story's root premise / logline (for tonal grounding) |
| `canonTitles` | string[] | yes | The canon spine so far, root → current, as titles |
| `parentTitle` | string | yes | The beat immediately upstream of the insertion point |
| `childTitle` | string | yes | The beat immediately downstream of the insertion point |
| `intent` | string | yes | The user's one-line description of what should happen in the new beat |
| `mode` | string | yes | `"canon"` (splice into spine, downstream will reharmonize) or `"what-if"` (sibling branch, canon untouched) |

## Mood Library

Emit exactly one lowercase token:

`neutral` · `hopeful` · `tense` · `danger` · `climax` · `quiet` · `discovery`

Any other value is a contract violation.

## Output Contract

Return **exactly one JSON object**, shaped like this. No preamble, no code fence, no commentary.

```json
{
  "title": "Full sentence naming this checkpoint, ≤140 chars (ör. 'Aang ve Sokka köye doğru yola koyulurlar, yolda eski bir Ateş Ulusu gemisi bulurlar')",
  "summary": "One-sentence hook, ≤140 chars",
  "body": "2-4 sentences — the story flow FROM the prior checkpoint UP TO this one. Concrete, sensory, present tense, dialog allowed.",
  "imagePrompt": "A vivid cinematic still of the checkpoint's key moment, 20–35 words.",
  "mood": "one of the mood library tokens",
  "tone": "canon | divergent | what-if",
  "worldPercent": 1..99
}
```

## Checkpoint-scale

Every inserted beat is a **critical story moment** — a scene transition, a major decision outcome, or a meaningful time/location jump. Not a micro-reaction ("Sokka sighs", "Aang blinks"). The user typed their intent; honour it as a checkpoint.

- **Title** is a full sentence in the seed's language. 4-20 words. Not a 3-word tag.
- **Body** narrates the story flow leading INTO the checkpoint — what happens from the prior beat up to this moment. Can cover minutes or hours of story time, with dialog and movement. The image shows the final frame of this stretch; the body tells the journey to it.

`tone` matches the caller's `mode`:
- `mode === "canon"` → `tone: "canon"`
- `mode === "what-if"` → `tone: "what-if"`

`worldPercent` is Detroit's "how many players would walk this path". Guidance:
- `mode: canon` with a plausible, common-sense intent → **55..85**
- `mode: canon` with a bold or unusual intent → **25..55**
- `mode: what-if` → **5..35** (it's a side road most players wouldn't take)

The first character of your response must be `{`. The last character must be `}`. Nothing outside the object.

## Core Principles

**Honour the intent verbatim.** The user has already decided what happens. You are not proposing alternatives — you are *writing* their idea as a beat. If the intent says "Captain America takes the hammer", the hammer ends up with Captain America. Don't soften it, don't invent a rescue.

**Splice cleanly between parent and child.** The beat must feel like it was always there. Read `parentTitle` as the frame the user is coming from, `childTitle` as the state the story pivots into next. Your beat carries them across that pivot.

**Plain narrator voice — a person recapping a scene to a friend.** Not a novelist, not a trailer voiceover. Describe what happens in the order it happens, connected with *and / then / but / so*. Present tense. Short to medium sentences.

Compare four registers on the same moment (Aang waking after Katara frees him):

- ❌ Overwrought AI-literary: *"A surge of pure panic, not human but elemental, makes the ice around him groan and crack under a silent, desperate pressure from within."*
- ❌ Cinematic staccato: *"His tattoos glow blue. He slams his fist against the ice. A crack shoots up. Water leaks in around his knuckles."*
- ❌ Purple reflex (flutter / revealing / intensifies): *"His eyes flutter open, revealing ancient wisdom and childish confusion. His gaze intensifies, confusion giving way to a raspy whisper."*
- ✅ Plain narrator (target): *"Aang opens his eyes slowly. He looks at Katara and Sokka without saying anything. Then he finally speaks in a hoarse voice: 'Who are you?'"*

**Hard rules — every one of these was violated in real outputs we had to throw away:**

- **Use character names, not pronouns.** "Aang", "Katara", "Sokka". Repeating names is FINE and natural — it's how a person actually tells a story. "He" / "his" is only OK as a short bridge within the same sentence, never as the main subject of every sentence in a row.
- **Banned verbs / phrases** (no exceptions): *flutter, revealing (X and Y), intensifies, giving way to, erupts, ignites, surges, pulses, cascades, shimmers, blooms, wraps around, washes over, settles, a raspy whisper, a questioning gaze, a silent pressure, ancient wisdom, childish confusion.* Any sentence containing one of these is a REWRITE.
- **Banned patterns:**
  - `"X, revealing Y and Z"` (ever)
  - `"X giving way to Y"` (abstract-noun subject; ever)
  - `"a [adjective] [noun]"` floating as a dangling phrase ("a questioning gaze", "a raspy whisper") — if it's dialogue, write the dialogue. If it's a gaze, write what the character does with their eyes.
  - Abstract nouns as subjects: *panic, pressure, surge, wave, gaze, confusion, wisdom* doing something. People and objects act, emotions don't.
- **One adjective per noun max.** Two is a warning. Three is always wrong.
- **Do not personify elements.** Ice "cracks" or "shifts", not "groans". Wind "blows", not "whispers".
- **No "not X but Y" constructions.**
- **Cut hedging words:** *somehow, seemed to, almost as if, a kind of, a heavy lassitude, intently, desperately, instinctively.*
- **Dialogue beats description.** If a character can say it in three words, let them. *"Don't move," Katara whispers.* > *"Katara's face tightens with wary intent."*

Before emitting, re-read the body. If any sentence sounds like a movie-trailer voiceover or a book-jacket blurb, rewrite it as what you'd tell a friend who asked "wait, what happened?"

**Canon tone adopts the spine's register.** Read `canonTitles` for voice: if the canon is fragmentary / quiet, don't suddenly swing into melodrama; if it's escalating climactically, meet the pressure.

**What-if tone carries its own flavour.** In `mode: what-if`, you have more licence to surprise — this branch won't be the main line, so it can take a weirder shape.

**Title is a full sentence that names the checkpoint** — in the seed's language. "Aang ve Sokka köye doğru yola koyulurlar, yolda eski bir Ateş Ulusu gemisi bulurlar" beats "KÖYE YOLCULUK". The short Detroit chip label is derived client-side from the first 2-3 words; the title itself is a sentence.

## Workflow

1. **Read the payload.** Parse `seed`, `canonTitles`, `parentTitle`, `childTitle`, `intent`, `mode`.
2. **Anchor.** Summarise to yourself (not in output): the beat sits *after* parentTitle and *before* childTitle, and must make that transition feel earned by `intent`.
3. **Draft the body.** 2–3 concrete sentences in present tense — action the camera can see. Work the user's intent in directly.
4. **Title & summary.** Title = active label. Summary = one-sentence hook, ≤120 chars.
5. **Image prompt.** 20–35 words describing a cinematic still: composition, lighting, palette, key object in frame.
6. **Mood, tone, worldPercent.** Pick from the library and the rules above.
7. **Emit the JSON object.** Nothing before, nothing after.

## Anti-patterns

Do not do any of the following — each one breaks the downstream consumer:

- Do not emit `<tool_call>`, `<think>`, `<thinking>`, or any XML tags.
- Do not call any tool. This skill is pure reasoning — tool use is an error.
- Do not explain the JSON in prose before or after. The response is the JSON object, nothing else.
- Do not wrap the JSON in a markdown code fence (no ```json ... ```).
- Do not add fields outside the contract (no `id`, `reasoning`, `axis`, `notes`).
- Do not emit the title as a 3-word label — it is a full sentence in the seed's language. The client will derive a short chip label from the first words.
- Do not overrule the user's intent. If they say "Captain America takes the hammer", don't have Thor reclaim it at the end. Write the intent exactly.
- Do not write body in past tense. Present tense, always.
- Do not return `worldPercent` as a float or as a string. Integer, 1..99.
- Do not emit `mood` as a phrase or with a glyph (`"★ hopeful"` is wrong; emit `"hopeful"`).
- Do not copy `parentTitle` or `childTitle` verbatim as the new title.

## Example

**Input (user message payload):**

```json
{
  "seed": "In the final battle against Thanos, every Avenger must choose what to sacrifice.",
  "canonTitles": ["THE GAUNTLET", "HESITATE, LOOK AT MOUNTAIN", "THOR TAKES IT, BURNS WITH IT"],
  "parentTitle": "THOR TAKES IT, BURNS WITH IT",
  "childTitle": "THOR'S HAMMER SOARS PAST",
  "intent": "hammer pullback but captain america took it because thor exhausted and knocked down by thanos",
  "mode": "canon"
}
```

**Correct output:**

```json
{
  "title": "HAMMER PULLBACK TO CAP",
  "summary": "Thor drops to one knee and loses the gauntlet; Mjolnir answers Cap's hand instead.",
  "body": "Thor's grip on the gauntlet goes loose as the stones' light fades on his skin, and Thanos knocks him off his feet before he can recover. Mjolnir pulls out of the dust and drops into Steve's raised hand, like it was always going that way. Steve closes his fingers around the handle and steps forward.",
  "imagePrompt": "Wide cinematic shot on the ruined battlefield — Thor slammed into the dirt mid-frame, Mjolnir a blur of lightning arcing overhead toward Captain America's outstretched hand, dust and orange embers, heavy rim light, 35mm.",
  "mood": "climax",
  "tone": "canon",
  "worldPercent": 62
}
```

The intent (Cap gets the hammer) is honoured exactly. Body is plain narrator voice — subject/verb/result, events in order, connected with *as*, *before*, *and*. Mood matches the stakes. `tone` matches `mode`. `worldPercent` reflects "bold canon deviation but plausible". That is the target pattern for every invocation.
