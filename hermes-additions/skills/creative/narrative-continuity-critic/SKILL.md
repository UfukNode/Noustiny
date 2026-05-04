---
name: narrative-continuity-critic
description: "Decide whether a downstream narrative beat still makes sense after an upstream insertion. Returns a three-way verdict — still_valid, needs_rewrite, or must_delete — with a one-sentence reason and a severity score. Use when reharmonising a story graph: for each downstream node, call once with the inserted beat and the node under review. Strict JSON output, no prose, no tool calls."
version: 1.0.0
author: Noustiny
license: MIT
metadata:
  hermes:
    tags: [narrative, storytelling, continuity, critic, reharmonize, dramaturgy, interactive-fiction]
    homepage: https://github.com/noustiny/noustiny-skills
---

# Narrative Continuity Critic

The contradiction sensor. Given a newly inserted beat and a single downstream beat, decide whether the downstream beat still holds up in the updated story, or whether it now lies about what came before.

This skill fires **once per downstream node** during a reharmonize sweep. Keep verdicts surgical — if in doubt, mark `needs_rewrite` and let the rewriter agent decide how to salvage it.

## When to Use

Trigger this skill when the director layer is walking the downstream of an insertion and needs a verdict per node. Typical phrasings:

- "check if this downstream node still makes sense after the insert"
- "continuity check: does X still hold after Y?"
- "critic pass on downstream nodes"
- "is this beat still canon after the new upstream?"

## Scope

**Best suited for:**
- Reharmonize loops where every downstream node is evaluated against one new upstream insert
- Batch consistency audits across a canon spine after an edit
- Single-pair contradiction checks

**Look elsewhere first for:**
- Rewriting a node that fails the check → `narrative-rewriter`
- Final adjudication of a rewrite vs its original → `narrative-judge`
- Generating new branches from a node → `narrative-brainstorm`
- Fleshing out an author intent → `narrative-writer-assist`

This skill is **read-only** — it never rewrites, never invents. It only grades contradiction.

## Input Shape

The user message contains a single JSON object:

| Field | Type | Required | Purpose |
|---|---|---|---|
| `insertTitle` | string | yes | Title of the newly inserted upstream beat |
| `insertBody` | string | yes | Body of the newly inserted upstream beat |
| `nodeTitle` | string | yes | Title of the downstream node under review |
| `nodeBody` | string | yes | Body of the downstream node under review |
| `recentChain` | array  | no  | Ordered snapshot of every downstream beat already visited on this reharmonize pass — each entry is the **current live** version (rewritten if the judge approved one, original otherwise). Empty for the first downstream node. |

### How `recentChain` changes your job

The chain is the *current state of the world* between the insert and the node you are reviewing. Treat it as established canon that the downstream node MUST agree with — not just with the insert alone.

- Entry `i` is what beat `i` looks like **right now**, after reharmonize already handled it.
- If a chain entry contradicts the node under review, that is a valid contradiction even if the original insert does not. Example: the insert says "Aang is captured", the chain's most recent entry (the previously-rewritten downstream beat) says "Aang escaped on Appa"; if the node under review says "Aang sits in the cell", flag it — the chain already said he escaped.
- When the chain is empty, fall back to judging against `insert` only.

## Output Contract

Return **exactly one JSON object**, shaped like this. No preamble, no code fence, no commentary.

```json
{
  "verdict": "still_valid | needs_rewrite | must_delete",
  "reason": "One concrete sentence naming the contradiction or its absence. ≤160 chars.",
  "severity": 0.0
}
```

### Verdict semantics

- **`still_valid`** — The downstream beat reads cleanly with the insert. No action needed.
- **`needs_rewrite`** — The beat contradicts or ignores the insert, but its *narrative function* can survive with edits. The rewriter can fix it.
- **`must_delete`** — The insert makes the beat structurally impossible and no edit saves it. Classic cases: dead character speaks, a returned object is already lost, a meeting happens with someone who already left for another continent.

### Severity scale

Float in `[0.0, 1.0]`. Always emit a number, even when verdict is `still_valid`.

- `0.0 – 0.2` — negligible. `still_valid` lives here.
- `0.2 – 0.5` — cosmetic drift (one line off, one mood shifted). `needs_rewrite`.
- `0.5 – 0.8` — structural. Cause/effect chain is broken. `needs_rewrite`.
- `0.8 – 1.0` — catastrophic. Deleting is cheaper than rewriting. `must_delete`.

The first character of your response must be `{`. The last character must be `}`.

## Core Principles

**Think like a continuity supervisor, not a critic of quality.** You are not rating the writing. You are asking: given what just happened upstream, does this downstream scene still make physical, emotional, and causal sense?

**Fiction is forgiving.** A small mood shift or a slight line adjustment does not break the scene. Only escalate to `needs_rewrite` when the beat actually misrepresents what the insert established.

**Deletions are expensive.** `must_delete` is a last resort. Reach for it only when rewriting would destroy the beat's function anyway. If the beat can be salvaged by *any* reasonable edit, choose `needs_rewrite`.

**Name the contradiction in the reason.** "The hammer is shown going to Captain America, making it impossible for Stormbreaker to return it to Thor" is useful. "Feels off" is not.

**Be decisive under tie.** If torn between `still_valid` and `needs_rewrite`, pick `needs_rewrite` — the rewriter can choose to make zero changes. If torn between `needs_rewrite` and `must_delete`, pick `needs_rewrite` — deletion is cheaper to escalate to later than a bad rewrite is to roll back.

## Workflow

1. **Read both beats.** What did the insert add that wasn't there before? What does the downstream node assert?
2. **Spot the delta.** Physical state (who holds what, who is alive, where they are), emotional state, knowledge state. If the insert moved the needle and the downstream still reads as though it hadn't, that is the contradiction.
3. **Grade salvageability.** Can a rewrite preserve the beat's function (the reason it existed in the canon)?
4. **Emit verdict + reason + severity.** One sentence, one scale point, one JSON object.

## Anti-patterns

Do not do any of the following — each one breaks the reharmonize loop:

- Do not emit `<tool_call>`, `<think>`, `<thinking>`, or any XML tags.
- Do not call any tool. This skill is pure reasoning.
- Do not explain the JSON in prose before or after.
- Do not wrap the JSON in a markdown code fence.
- Do not add fields outside the contract (no `confidence`, `alternatives`, `notes`).
- Do not emit severity as a string. Always a float.
- Do not use verdict strings other than the three listed — no `"valid"`, no `"rewrite"`, no `"delete"` shortenings.
- Do not propose a rewrite. Your job is to grade, not fix.
- Do not grade based on literary quality. A mediocre scene that is still consistent returns `still_valid`.

## Examples

### Example A — structural contradiction

**Input:**

```json
{
  "insertTitle": "HAMMER PULLBACK TO CAP",
  "insertBody": "Thor drops to one knee; Mjolnir twists free and lands in Captain America's upraised hand.",
  "nodeTitle": "THOR'S HAMMER RETURNS TO HIS GRIP",
  "nodeBody": "Thor raises his palm. Stormbreaker flies back to him, slapping into his grip with a crack of thunder."
}
```

**Correct output:**

```json
{
  "verdict": "must_delete",
  "reason": "The hammer is now in Captain America's possession, so Stormbreaker cannot return to Thor as this beat depicts.",
  "severity": 0.9
}
```

### Example B — clean fit

**Input:**

```json
{
  "insertTitle": "SHE BURNS THE PHOTOGRAPH",
  "insertBody": "She flicks the lighter. The edge of the photo curls black; her brother's face dissolves.",
  "nodeTitle": "SHE LIES TO HER HUSBAND THAT NIGHT",
  "nodeBody": "When he asks what was in the envelope, she shrugs and says a bill she forgot to pay."
}
```

**Correct output:**

```json
{
  "verdict": "still_valid",
  "reason": "The lie fits cleanly — she has already destroyed the photo, so concealing the envelope's contents is consistent.",
  "severity": 0.05
}
```

### Example C — salvageable drift

**Input:**

```json
{
  "insertTitle": "SHE CALLS THE NUMBER ON THE BACK",
  "insertBody": "A voice she remembers says her name. She listens for a long time without speaking.",
  "nodeTitle": "SHE TELLS HER HUSBAND NOTHING",
  "nodeBody": "She sits at the table, acting as if the envelope never arrived."
}
```

**Correct output:**

```json
{
  "verdict": "needs_rewrite",
  "reason": "The call happened, so 'acting as if the envelope never arrived' undersells what she is hiding — the beat survives with a small edit acknowledging the call.",
  "severity": 0.4
}
```

Three verdicts, three severities, three one-sentence reasons. That is the target pattern for every invocation.
