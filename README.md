<h1 align="center">Noustiny</h1>

<p align="center"><em>Drop a seed. Walk a universe.</em></p>

<p align="center">
  <img alt="Built for Nous Creative Hackathon 2026" src="https://img.shields.io/badge/Nous_Creative_Hackathon-2026-FF6B35?style=flat-square">
  <img alt="Built on Hermes Agent" src="https://img.shields.io/badge/Hermes_Agent-Nous_Research-635BFF?style=flat-square">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000?style=flat-square&logo=next.js">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
</p>

---

> **The stories you keep imagining. See them, hear them, share them.**

You don't ask for *a* story. You drop a seed and walk every "what if"
branch the universe could take. Every splice becomes a real branch: the
agent re-harmonises the canon, paints the visuals, clones a fitting
narrator voice, and renders the version you picked into a video you can
post.

<p align="center">
  <img src="docs/screenshots/tree.png" alt="Story tree, early branches" width="49%">
  <img src="docs/screenshots/tree2.png" alt="Story tree, expanded canon path" width="49%">
</p>

## At a glance

| Action                    | Result                                                         |
| :------------------------ | :------------------------------------------------------------- |
| Type a seed               | A canon-tracked, live branching story canvas                   |
| Pick an option            | Hermes proposes the next 2 to 3 critical beats                 |
| Splice a beat mid-tree    | Downstream beats re-harmonise themselves automatically         |
| Hit Render                | A landscape audiobook or a vertical reel, ready to post        |
| Drop a YouTube URL        | ElevenLabs IVC clones that voice for every line of narration   |
| Save / Load               | Full tree state, with provenance, in localStorage              |

## How it works

Two distinct loops sit under the canvas. The **authoring loop** runs per
beat as you grow the tree. The **render loop** runs once, when you press
Render: the agent dispatches four registered Hermes tools in sequence on
a single chat completion, no app-side orchestration.

### Two ways to fork the story

The canvas exposes two `+` buttons with different shapes and different
jobs. Both grow the tree, but only one of them needs the council.

```mermaid
flowchart LR
  classDef canon fill:#0d1828,stroke:#4fc3f7,color:#e0f7fa,stroke-width:2px
  classDef inserted fill:#1a1208,stroke:#e9c16b,color:#fff8e1,stroke-width:2px
  classDef whatif fill:#0f1019,stroke:#7a7e8a,color:#cdd2de,stroke-dasharray: 5 3
  classDef arm fill:#0f131b,stroke:#e9c16b,color:#e9c16b,stroke-width:2px
  classDef trunk fill:#0f131b,stroke:#7a7e8a,color:#cdd2de,stroke-width:2px,stroke-dasharray: 4 3

  A["Beat 1<br/>opening"]:::canon
  B["Beat 2<br/>discovery"]:::canon
  C["Beat 3<br/>climax"]:::canon
  ARM["⬛ +<br/>arm splice"]:::arm
  INS["Beat 1.5<br/>inserted, gold"]:::inserted
  TRK(("○ +<br/>trunk")):::trunk
  WIF["Beat 2'<br/>what-if branch"]:::whatif

  A -- canon --> ARM
  ARM -- splice --> INS
  INS -- canon --> B
  B -- canon --> C
  A -. parent stub .-> TRK
  TRK -. what-if .-> WIF
```

| Gesture | Where it sits | What it does |
| :--- | :--- | :--- |
| **Square +** (gold, parallelogram) | Midpoint between a parent and its canon child | Splices a new beat *into* the canon. `narrative-writer-assist` drafts the inserted beat, then the council cascade patches every downstream beat the splice made stale. |
| **Round +** (dashed circle) | Off the parent's outgoing stub | Adds a what-if sibling, a parallel timeline that doesn't touch existing canon. No cascade fires; brainstorm just produces 3 fresh next options on this new branch. |

### Authoring loop: per-beat council

Every beat passes through a small council of narrative skills. Splice one
beat and the cascade walks downstream by itself until the canon is coherent
again.

```mermaid
sequenceDiagram
  autonumber
  participant U as user
  participant N as next.js
  participant H as hermes gateway

  U->>N: enter seed
  N->>H: brainstorm
  H-->>N: 2-3 next options
  U->>N: pick / splice

  rect rgba(80,140,255,0.10)
    Note over N,H: re-harmonisation cascade
    N->>H: continuity-critic
    H-->>N: contradictions per node
    N->>H: rewriter
    H-->>N: patched beats
    N->>H: judge
    H-->>N: approve / reject
  end

  N-->>U: tree updated
```

### Render loop: autonomous tool chain

When you press Render, the agent chains four registered Hermes tools in
sequence on a single chat completion. No app-side glue.

```mermaid
sequenceDiagram
  autonumber
  participant A as agent
  participant D as narration_voice_director
  participant S as voice_sample_builder
  participant C as voice_clone_synthesize
  participant R as noustiny_storybook

  A->>D: title, seed, voice_gender
  D-->>A: persona_label, search_query, fallback_query
  A->>S: query
  S-->>A: sample_path (24 kHz mono PCM)
  A->>C: text, reference_wav
  C-->>A: audio + per-character alignment
  A->>R: voice_reference_wav, persona, render args
  R-->>A: rendered video path
```

### Character continuity: one face per character

Stories drift visually when "Tony Stark", "Mr. Stark", and "Tony" each
get a different portrait. Noustiny pins the cast at seed time and threads
the same reference image through every beat that mentions them.

```mermaid
flowchart LR
  classDef seed fill:#0d1828,stroke:#4fc3f7,color:#e0f7fa,stroke-width:2px
  classDef sheet fill:#1a1208,stroke:#e9c16b,color:#fff8e1,stroke-width:2px
  classDef beat fill:#0f131b,stroke:#7a7e8a,color:#cdd2de
  classDef tool fill:#0a1018,stroke:#4fc3f7,color:#4fc3f7,stroke-dasharray: 4 3

  seed["seed prompt"]:::seed --> sheet
  sheet["character_sheet_builder<br/>1 to 4 named cast<br/>IP-free portrait per character"]:::sheet

  beat["beat mentions a name"]:::beat --> reg
  reg{{"character_alias_resolver<br/>'Mr. Stark' → 'Tony Stark'"}}:::tool --> lookup
  lookup{{"character_registry_lookup<br/>fetch portrait reference"}}:::tool --> img

  sheet -. registers .-> lookup
  img["beat image gen<br/>conditioned on portrait"]:::beat
```

The cast sheet is built once. From then on, every beat that names a
character pulls the same portrait reference, so a face stays a face across
the whole tree, including the rendered video.

## Tools

12 registered tool names across 10 Python files. Each one fills a primitive
Hermes did not ship with.

### Story state

| Tool                        | Purpose                                                                            |
| :-------------------------- | :--------------------------------------------------------------------------------- |
| `story_tree_graph`          | Tree graph operations: canon path, descendants, splice insertion points            |
| `narrative_context_builder` | Walks the canon chain, returns the live structured context every skill reads from  |
| `motif_tracker`             | Recurring motif memory across the arc (a sword in beat 2 must reappear later)      |

### Character continuity

| Tool                        | Purpose                                                                            |
| :-------------------------- | :--------------------------------------------------------------------------------- |
| `story_copyright_detector`  | IP scrub: "Iron Man" becomes an IP-free description before the image API sees it   |
| `character_sheet_builder`   | Produces 1 to 4 named characters with IP-free visuals plus portrait prompts        |
| `character_registry_lookup` | Find a character on the cast sheet, attach the correct portrait reference          |
| `character_alias_resolver`  | "Mr. Stark" resolves to "Tony Stark" so one character keeps one portrait           |

### Voice

| Tool                        | Purpose                                                                            |
| :-------------------------- | :--------------------------------------------------------------------------------- |
| `narration_voice_director`  | Director-agent reads seed and story, returns persona plus reference search query   |
| `voice_sample_builder`      | yt-dlp + ffmpeg, accepts URL, 11-char ID, or free text. Normalises to 24 kHz mono  |
| `voice_clone_synthesize`    | ElevenLabs IVC + with-timestamps. Voice cached by reference SHA. Alignment is free |
| `voice_clone_cleanup`       | Frees the cached voice ID after render                                             |

### Render

| Tool                        | Purpose                                                                            |
| :-------------------------- | :--------------------------------------------------------------------------------- |
| `noustiny_storybook`        | Render entry. Agent dispatches it; one call drives the FastAPI service end to end  |

## Skills

13 agentskills.io bundles, each one a system prompt for a single creative
concern. Next reads them from the local mirror and sends them as the
system role on every chat completion; the autonomous storybook chain pulls
its own from the gateway side.

### Tree authoring

| Skill                         | Role                                                              |
| :---------------------------- | :---------------------------------------------------------------- |
| `narrative-brainstorm`        | Proposes 2 to 3 next-checkpoint options from the canon chain      |
| `narrative-writer-assist`     | Writes a spliced insert beat that fits parent and child           |
| `narrative-continuity-critic` | Audits downstream beats against any insert                        |
| `narrative-rewriter`          | Patches the stale beats the critic flagged                        |
| `narrative-judge`             | Approves or rejects the rewrite against the original              |
| `narrative-scene-qa`          | Per-beat sanity check (consistency, length, register)             |
| `narrative-writer`            | Seals the chosen branch as final prose                            |

### Visual + IP

| Skill                       | Role                                                              |
| :-------------------------- | :---------------------------------------------------------------- |
| `story-copyright-detector`  | Skill counterpart of the same-named tool                          |
| `character-sheet-builder`   | Cast extraction rules + IP-free portrait prompt format            |
| `visual-prompt-builder`     | Turns a beat into an IP-free image prompt; reads character sheet  |
| `scene-composition`         | Shot framing and layout rules                                     |
| `storybook-intro`           | Cinematic intro page generator                                    |

### Voice

| Skill                      | Role                                                               |
| :------------------------- | :----------------------------------------------------------------- |
| `narration-voice-director` | Persona reasoning rules backing the same-named tool                |

## Architecture

```mermaid
flowchart TB
  subgraph windows[Windows side]
    nx[Next.js<br/>:3000]
    mirror[hermes-skills-local<br/>NTFS mirror]
  end

  subgraph wslblock[WSL]
    gw[Hermes gateway<br/>:8642]
    svc[Storybook render<br/>:8643]
    tools[hermes-agent tools]
    skills[hermes-agent skills<br/>canonical]
  end

  subgraph cloud[Cloud]
    nous[Nous Portal]
    el[ElevenLabs]
    yt[YouTube / yt-dlp]
  end

  browser([browser]) --> nx
  nx -- chat completion --> gw
  nx -. "read SKILL.md" .-> mirror
  gw -- forward --> nous
  gw --> tools
  tools --> el
  tools --> yt
  tools --> svc
  svc --> nx
```

The `hermes-skills-local` directory is a Windows-side mirror of the canonical
skills folder in WSL. Reading SKILL.md over UNC stalls under parallel reads
(25 second timeouts on canvas-enter), so Next reads from local NTFS instead.
Resync after editing a SKILL.md:

```bash
cp -r //wsl.localhost/Ubuntu/home/<user>/hermes-agent/skills/creative \
      ./hermes-skills-local/
```

## Repo layout

```
.
├── hermes-additions/          tools + skills we authored for Hermes
│   ├── tools/                 10 .py files, 12 registered tool names
│   ├── skills/creative/       13 SKILL.md bundles
│   └── README.md              install + integration notes
├── hermes-skills-local/       Windows mirror (gitignored)
└── web/                       Next.js 16 app
    ├── app/                   routes, pages, layouts
    ├── components/            canvas, modals, agent ticker, etc.
    ├── lib/                   store, hermes client, save system
    └── public/                static assets
```

## Built for

Nous Creative Hackathon, 2026.

## Credits

Hermes Agent · Nous Research
ElevenLabs Instant Voice Cloning
yt-dlp
ffmpeg + libass
