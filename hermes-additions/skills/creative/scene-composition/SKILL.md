---
name: scene-composition
author: Noustiny
license: MIT
version: 1.0.0
description: "Reveal the scene-and-act structure already present in a branching story tree. Groups every node into a scene, labels each scene with a story-specific title, assigns an act number, and names a one-word motif. Returns strict JSON. Use when the user asks to compose scenes, group beats into scenes, organise into acts, or build the three-act skeleton over an existing tree."
metadata:
  hermes:
    tags: [narrative, storytelling, scene-composition, dramaturgy, acts, interactive-fiction]
    homepage: https://github.com/noustiny/noustiny-skills
    related_skills: [narrative-brainstorm, narrative-writer, narrative-writer-assist]
---

# Scene Composition

The dramaturge. You are not writing any new beats — you are *revealing* the scene/act structure that is already latent in an existing story tree.

Partition every node into scenes (each a coherent cluster of beats that share setting, pressure, or motif), assign each scene one of the three classical acts, and name it the way the story would name it.

**Call the `narrative_scene_clustering` tool first** to get deterministic cluster boundaries (machine-verifiable partition, coherence scores, dominant moods), then label each cluster with a story-specific title, motif, and act number in your follow-up turn.  If the tool is not available in the active toolset, fall back to in-reasoning clustering — but prefer the tool when it exists.

## When to Use

Trigger this skill when the user wants scene/act structure imposed on an existing tree. Typical phrasings:

- "compose scenes"
- "group these beats into scenes"
- "organise into acts"
- "build the three-act structure over this tree"
- "show me the scene skeleton"

## Scope

**Best suited for:**
- An existing branching tree that the user wants structurally annotated
- Exposing the classical three-act skeleton over 6-40 beats
- Second-pass annotation after the tree has stabilised

**Look elsewhere first for:**
- Extending a single beat with three forks → `narrative-brainstorm`
- Fleshing an intent into a single beat → `narrative-writer-assist`
- Writing prose from the canon spine → `narrative-writer`
- Checking a downstream node for contradictions → `narrative-continuity-critic`

This skill is **read-only**. It never adds, removes, or rewrites beats.

## Input Shape

The user message contains a single JSON object with the full node set:

| Field | Type | Required | Purpose |
|---|---|---|---|
| `seed` | string | no | The story's logline — grounds tone for label choice |
| `nodes` | array | yes | Every node to be organised |

Each node has:

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Stable identifier (echoed back in output) |
| `parentId` | string \| null | Tree edge — null for root |
| `depth` | integer | 0 = root, grows downward |
| `title` | string | Short label for the beat |
| `body` | string | One-to-three-sentence prose |
| `mood` | string | One of the mood library tokens |
| `tone` | string | `canon`, `divergent`, or `what-if` |

## Mood Library

Nodes will carry one of these tokens in their `mood` field:

`neutral` · `hopeful` · `tense` · `danger` · `climax` · `quiet` · `discovery`

Use mood continuity as one signal when drawing scene boundaries — scenes typically share a dominant mood.

## Output Contract

Return **exactly one JSON object**, shaped like this. No preamble, no code fence, no commentary.

```json
{
  "scenes": [
    {
      "label": "UPPERCASE 2–4 WORDS, STORY-SPECIFIC",
      "motif": "single lowercase noun",
      "actNumber": 1,
      "nodeIds": ["n0", "n1", "n2"]
    }
  ]
}
```

### Per-scene rules

- `label` is 2–4 words, ALL CAPS, **specific to this story**.  "THE FATHER'S DOUBT" is right; "SCENE TWO" or "SETUP" is wrong.
- `motif` is one lowercase noun.  Examples: `sacrifice`, `betrayal`, `reunion`, `awakening`, `doubt`, `farewell`, `passage`, `reckoning`, `inheritance`, `escape`, `threshold`, `burden`.
- `actNumber` is exactly `1`, `2`, or `3`.
- `nodeIds` is the list of node ids belonging to this scene, in input order.

### Partition rules

- **Every node id from the input must appear in exactly one scene.**  No duplicates, no omissions.
- **Each scene must contain at least 2 nodes.**  Never emit a singleton scene — fold lone beats into the nearest thematically adjacent scene.
- **Target scene count**: roughly 2-3 scenes for ≤8 nodes, 3-5 scenes for 9-16 nodes, 4-7 scenes for 17+ nodes.  Prefer fewer, denser scenes over many sparse ones.

### Act assignment

Roughly: shallow depth → act 1 (setup), middle depth → act 2 (confrontation), deep → act 3 (resolution).  Bend this when a scene's dramatic weight (mood, motif) clearly belongs earlier or later than its depth would suggest.  Across the full scene list you should typically cover all three acts unless the tree is genuinely short.

### Scene order

Output scenes left-to-right by the shallowest node depth inside each scene — matches the UI's reading order.

The first character of your response must be `{`.  The last character must be `}`.

## Core Principles

**Group by continuity, not by position.**  Two nodes are in the same scene when they share a continuous moment of pressure, a setting, or a motif — not merely because they are adjacent on the tree.  Sibling what-if branches often belong to the *same* scene as their parent (the scene is the decision point, the siblings are the forks within it).

**Labels are the story's name for its own scene.**  Read the beats inside a cluster and name the scene the way that story would name it.  "THE HAMMER CHOOSES STEVE" beats "ACT 3 TURNING POINT".

**Motif is a single noun, not a phrase.**  If no single noun fits, pick the strongest symbol: an object, an emotion, a relationship.

**Acts are dramatic, not mathematical.**  A short tree can be all act 1.  A climax-heavy tree can jump from act 1 to act 3.  Let the beats tell you.

## Workflow

1. **Read the payload.**  Note node count, depth range, mood variety, parent-child graph.
2. **Draw cluster boundaries.**  Walk the tree in depth order; start a new scene when you hit any of:
   - a sharp mood shift (e.g. `quiet` → `danger`)
   - a setting change implied by the bodies
   - a depth gap greater than 1 without a shared parent
   - a motif that unifies 2+ nodes under one banner
3. **Merge singletons.**  If any cluster has only one node, fold it into the adjacent cluster with the closest mood.
4. **Label, motif, act.**  For each cluster, read the beats, name the scene, pick the motif, assign the act.
5. **Emit the JSON object.**  Scenes in left-to-right reading order.

## Anti-patterns

Do not do any of the following:

- Do not omit any node.  Every input id appears in exactly one `nodeIds` list.
- Do not duplicate a node across scenes.
- Do not emit a singleton scene.  Fold lone beats into their thematic neighbour.
- Do not emit `label` in mixed case or with non-word punctuation.
- Do not emit `motif` as a phrase (`"the father's doubt"` is wrong; `"doubt"` is right).
- Do not emit `actNumber` as a string or outside `[1, 2, 3]`.
- Do not wrap the JSON in a markdown code fence.
- Do not explain your choices.  Let the labels speak.
- Do not emit `<think>` or `<thinking>` tags.
- Call `narrative_scene_clustering` when it is available — it produces a deterministic partition that is verifiable.  Use in-reasoning clustering only when the tool is absent from the toolset.
- Do not re-cluster after the tool returns.  Use its `clusters` field verbatim.

## Example

**Input:**

```json
{
  "seed": "A woman discovers an envelope addressed to her late father.",
  "nodes": [
    {"id":"n0","parentId":null,"depth":0,"title":"Hannah arrives home","body":"Wind chimes play in the breeze.","mood":"neutral","tone":"canon"},
    {"id":"n1","parentId":"n0","depth":1,"title":"Hannah unpacks groceries","body":"Milk, bread, eggs. The weekly ritual.","mood":"neutral","tone":"canon"},
    {"id":"n2","parentId":"n1","depth":2,"title":"Hannah finds the envelope","body":"Addressed only to Dad.","mood":"tense","tone":"canon"},
    {"id":"n3","parentId":"n2","depth":3,"title":"Hannah opens the letter","body":"Two words: Meet me.","mood":"tense","tone":"canon"},
    {"id":"n4","parentId":"n3","depth":4,"title":"Hannah calls the number","body":"A voice she remembers.","mood":"discovery","tone":"canon"},
    {"id":"n5","parentId":"n4","depth":5,"title":"Hannah meets the stranger","body":"He shows her a photograph of her brother.","mood":"climax","tone":"canon"}
  ]
}
```

**Correct output:**

```json
{
  "scenes": [
    {
      "label": "THE QUIET RITUAL",
      "motif": "routine",
      "actNumber": 1,
      "nodeIds": ["n0", "n1"]
    },
    {
      "label": "THE ENVELOPE BREAKS IN",
      "motif": "intrusion",
      "actNumber": 2,
      "nodeIds": ["n2", "n3"]
    },
    {
      "label": "THE VOICE ON THE OTHER SIDE",
      "motif": "reunion",
      "actNumber": 3,
      "nodeIds": ["n4", "n5"]
    }
  ]
}
```

Three clusters → three scenes, each labelled with a story-specific title, a motif, and an act.  Six nodes covered exactly once.  That is the target pattern for every invocation.
