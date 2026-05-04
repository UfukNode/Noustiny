# hermes-additions

Generic Hermes Agent tools and skills authored for **Noustiny**, ready to drop
into any [Hermes Agent](https://github.com/NousResearch/Hermes-Agent) deployment.

Nothing here is app-specific. Every tool registers itself through the standard
Hermes registry, every skill is an
[agentskills.io](https://agentskills.io)-compatible bundle. Drop the files in,
restart the gateway, and the same tools become callable from a Telegram bot,
Discord bot, CLI session, or any custom app that hits the OpenAI-compatible
gateway endpoint.

## Contents

```
hermes-additions/
├── tools/              10 Python files (12 registered tool names)
└── skills/creative/    13 SKILL.md bundles
```

### Tools (12 registered names across 10 files)

| File | Registered tool(s) | What it does |
|---|---|---|
| `narration_voice_director.py` | `narration_voice_director` | Director-agent: reads seed + story, returns persona + voice search query |
| `voice_sample_builder.py` | `voice_sample_builder` | yt-dlp + ffmpeg → clean reference clip (URL / 11-char ID / free-text query); ytsearch5 with dead-video tolerance; normalises to 24 kHz mono PCM |
| `voice_clone_synthesize.py` | `voice_clone_synthesize`, `voice_clone_cleanup` | ElevenLabs IVC + `with-timestamps` endpoint; voice ID cached by reference SHA; per-character alignment rides on the audio call |
| `noustiny_storybook_tool.py` | `noustiny_storybook` | Render entry. Agent dispatches it as the final step; one tool call drives the FastAPI render service end-to-end and emits the mp4 |
| `story_tree_graph.py` | `story_tree_graph` | Tree graph operations: canon path, descendants, splice insertion points |
| `narrative_context_builder.py` | `narrative_context_builder` | Walks the canon chain and returns the live structured context (recent chain, mood, character state) every narrative skill should reason against |
| `motif_tracker.py` | `motif_tracker` | Remembers recurring motifs across the arc (a sword introduced in beat 2 must reappear meaningfully later) |
| `character_sheet_builder.py` | `character_sheet_builder` | Produces 1–4 named characters from a seed; IP-free visual descriptions + hero-portrait prompts. Output becomes the reference frames downstream beats condition on |
| `character_registry_lookup.py` | `character_registry_lookup`, `character_alias_resolver` | Find a character by name on the cast sheet; resolve aliases ("Mr. Stark" → "Tony Stark") so a single character keeps one portrait reference |
| `story_copyright_detector.py` | `story_copyright_detector` | IP scrub: "Iron Man" → IP-free description before the image API ever sees it |

### Skills (13 agentskills.io bundles)

Tree authoring cascade:
- `narrative-brainstorm`: proposes 2 to 3 next-checkpoint options from the canon chain
- `narrative-writer-assist`: writes a spliced insert beat that fits parent and child
- `narrative-continuity-critic`: audits downstream beats against any new insert
- `narrative-rewriter`: patches stale beats so the canon stays coherent
- `narrative-judge`: approves or rejects the rewrite against the original
- `narrative-scene-qa`: per-beat sanity check (consistency, length, register)
- `narrative-writer`: seals a branch as final prose

Visual + IP pipeline:
- `story-copyright-detector`: skill counterpart of the same-named tool
- `character-sheet-builder`: skill counterpart of the same-named tool
- `visual-prompt-builder`: turns a beat into an IP-free image prompt; reads character-sheet references
- `scene-composition`: shot framing and layout rules
- `storybook-intro`: generates the cinematic intro page for the render

Voice:
- `narration-voice-director`: persona reasoning rules backing the same-named tool

## Install

Clone your Hermes Agent fork, then copy the additions over:

```bash
# from the repo root
cp hermes-additions/tools/*.py            <hermes-agent>/tools/
cp -r hermes-additions/skills/creative/*  <hermes-agent>/skills/creative/

# restart the gateway so the registry re-discovers the new tools
hermes gateway restart
```

The `narrative` toolset in `<hermes-agent>/toolsets.py` should list the new
tool names so the agent loop can dispatch them. Example:

```python
"narrative": {
    "tools": [
        "story_tree_graph",
        "narrative_context_builder",
        "motif_tracker",
        "story_copyright_detector",
        "character_sheet_builder",
        "character_registry_lookup",
        "character_alias_resolver",
        "narration_voice_director",
        "voice_sample_builder",
        "voice_clone_synthesize",
        "voice_clone_cleanup",
        "noustiny_storybook",
    ],
}
```

## Runtime dependencies

Beyond Hermes Agent's own requirements:

- `yt-dlp`: `voice_sample_builder` audio fetch
- `ffmpeg` (binary on PATH): audio normalisation, render service
- `elevenlabs` Python SDK: `voice_clone_synthesize`
- A reachable Noustiny render service for `noustiny_storybook` to dispatch to

The render service lives in a sibling repo and listens on `:8643` by default.

## License

Same as the parent project.
