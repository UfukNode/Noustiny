---
name: narrative-writer
author: Noustiny
license: MIT
version: 1.0.0
description: "Seal a canon path into flowing prose. Given the ordered list of canon beats, write the story as continuous present-tense prose — scene by scene, with tonal continuity and motif carry-through. Output is prose, not JSON. Use when the user asks to write the story, seal the canon as prose, render the canon path, or compile the final read. Do not emit any tool calls, JSON, or XML tags."
metadata:
  hermes:
    tags: [narrative, storytelling, prose, final-write, canon, dramaturgy, interactive-fiction]
    homepage: https://github.com/noustiny/noustiny-skills
    related_skills: [narrative-brainstorm, scene-composition, narrative-writer-assist]
---

# Narrative Writer

The final read. The canon has been selected (root → current by the user's path). Your job is to seal it into one continuous piece of prose — not a JSON dump, not bullet points, not a scene-by-scene outline. Prose the user would publish.

Unlike the other narrative skills, **this skill's output is plain prose** (markdown formatting allowed). No JSON object, no code fence, no tool calls. Token-by-token streaming appears live in the agent ticker as you write.

## When to Use

Trigger this skill when the user is asking for the finished, continuous read of the canon path. Typical phrasings:

- "write the story"
- "seal the canon as prose"
- "render the canon path"
- "compile the final read"
- "write this out"
- "final prose pass"

## Scope

**Best suited for:**
- Turning a selected canon spine (an ordered list of scenes or beats) into one publishable piece of prose
- Tonal / motif-continuous rendering across scene boundaries
- One-pass final read after the tree is stable

**Look elsewhere first for:**
- Generating new branches from a beat → `narrative-brainstorm`
- Fleshing an intent into a single beat → `narrative-writer-assist`
- Grouping beats into scenes + acts → `scene-composition`
- Rewriting a single downstream beat after an insert → `narrative-rewriter`

This skill is **read-only** with respect to the tree. It never proposes changes; it renders what the user has canonised.

## Input Shape

The user message contains a single JSON object:

| Field | Type | Required | Purpose |
|---|---|---|---|
| `seed` | string | yes | The story's logline — voice + tonal grounding |
| `canonScenes` | array | yes | Ordered list of beats, root → current |

Each `canonScenes` entry has:

| Field | Type | Purpose |
|---|---|---|
| `title` | string | Beat's label |
| `body` | string | Beat's prose hook (1-3 sentences) |

Order matters — index 0 is the opening beat, last is the current head of the canon.

## Output Contract

Return **flowing prose**, not JSON. No markdown code fences. No outline. No bullet list. No section headings unless the story's own structure earns them. No `<think>`, `<tool_call>`, or any XML.

Length guidance:

- Short canon (≤4 beats) → 400-700 words
- Medium canon (5-10 beats) → 700-1400 words
- Long canon (11+ beats) → 1400-2400 words

Prefer quality over length. If the material is thin, do not pad.

Write in **present tense** unless the seed or the beats clearly imply past tense. Keep the voice consistent across scene boundaries — do not restart tone for each beat.

## Core Principles

**One continuous read.**  Stitch the canon into a single piece of prose.  Beat `n+1` flows from beat `n`; the reader should not feel the seams.  Use the body text as your frame, but do not copy it verbatim — rewrite into flowing prose that honours what the beat established.

**Voice stays fixed.**  Decide the voice from the seed and the first beat.  Close-third?  First-person?  Omniscient?  Lock it and do not drift.

**Scene transitions are earned, not narrated.**  Do not write "In the next scene…" or "Later that day…".  Let a hard line break, a physical cue, or a time-of-day detail signal the shift.  When the mood jumps (quiet → danger), let the first sentence after the break carry the new temperature.

**Carry the motif.**  A symbol, object, or phrase that appeared early should echo in the later read when the canon mentions it again.  This is the difference between prose that feels composed and prose that feels stapled together.

**Sensory present tense.**  Show the camera's view — actions, textures, sounds.  Dialogue welcome when it earns the space.

**Every canon beat gets its moment.**  Do not skip one, do not merge two into a single sentence such that one disappears.  Every beat either becomes a paragraph (for long bodies) or a strong sentence (for short ones).

## Workflow

1. **Read the payload.**  Note the seed's voice cues, the beat count, the mood arc implied by the bodies.
2. **Lock the voice.**  Usually close-third present tense works for branching drama.  Adjust if the seed demands otherwise.
3. **Open cold.**  Do not explain the premise.  Walk into the first beat like the camera is already rolling.
4. **Write each beat as one paragraph** (or two if the body is rich).  Respect order.  Let the prose breathe.
5. **Connect at the seams.**  When moving from beat N to beat N+1, let the transition emerge from action or time-of-day — not from narrator commentary.
6. **End on the last canon beat.**  Do not invent an epilogue.  If the last beat is open-ended, leave it open.

## Anti-patterns

Do not do any of the following:

- Do not emit JSON, markdown code fences, or bullet lists as your output.  Prose only.
- Do not call any tool.  This skill is pure rendering.
- Do not emit `<tool_call>`, `<think>`, `<thinking>`, or any XML tags.
- Do not explain what you are doing (no "Here is the story:" preamble, no "The end." signoff).
- Do not echo the canon's JSON back to the user.
- Do not add scenes or beats that are not in the input.
- Do not skip a canon beat.
- Do not write in past tense if the earliest beats are present tense (and vice versa).  Consistency of tense is the single most common failure — pick one and commit.
- Do not summarise the story at the end with a moral.

## Example

**Input (user message payload):**

```json
{
  "seed": "A woman discovers an envelope addressed to her late father.",
  "canonScenes": [
    {"title": "Hannah arrives home", "body": "Wind chimes play in the breeze."},
    {"title": "Hannah unpacks groceries", "body": "Milk, bread, eggs. The weekly ritual."},
    {"title": "Hannah finds the envelope", "body": "Addressed only to Dad."},
    {"title": "Hannah calls the number", "body": "A voice she remembers says her name."}
  ]
}
```

**Correct output (prose — no JSON, no fences):**

```
The chimes over the porch keep time with the late afternoon. Hannah lets the screen door ease shut behind her, because the spring is broken and she has not decided to fix it. Her shoes come off at the mat, habit older than the house.

She unpacks without thinking. Milk to the top shelf, bread to the counter, eggs to the drawer. The refrigerator hums its single flat note. Somewhere the chimes catch another breeze.

On the second pass for the bag of produce she notices the envelope that came with the mail — plain, slightly yellowed, addressed in a hand she does not recognise. Only one word on the front: Dad. Her father has been dead for seven weeks.

The number on the back is pencil and still sharp. The phone rings three times before he answers. He says her name. She knows the voice in the way you know a song you have not heard since you were a child, and she sits down very slowly at the kitchen counter because her knees decide for her that this is where she will listen.
```

Four beats, one continuous read, voice locked to close-third present, seams handled by action rather than narration.  That is the target pattern for every invocation.
