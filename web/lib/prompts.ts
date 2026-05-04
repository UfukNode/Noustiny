/**
 * Deprecated.  The narrative agent prompts that used to live here have been
 * promoted to agentskills.io-compatible SKILL.md bundles under
 * ``hermes-agent/skills/creative/narrative-*``.  Every ``/api/hermes`` kind
 * now resolves its system prompt by reading the matching SKILL.md at request
 * time and forwarding it to the Hermes gateway (see ``app/api/hermes/route.ts``).
 *
 * If you are looking for the brainstorm / writer-assist / critic / rewriter /
 * judge / scene-composition / writer prompts, open:
 *
 *     hermes-agent/skills/creative/narrative-brainstorm/SKILL.md
 *     hermes-agent/skills/creative/narrative-writer-assist/SKILL.md
 *     hermes-agent/skills/creative/narrative-continuity-critic/SKILL.md
 *     hermes-agent/skills/creative/narrative-rewriter/SKILL.md
 *     hermes-agent/skills/creative/narrative-judge/SKILL.md
 *     hermes-agent/skills/creative/scene-composition/SKILL.md
 *     hermes-agent/skills/creative/narrative-writer/SKILL.md
 *
 * This file is intentionally empty so the import path stays valid until the
 * last references are scrubbed from the codebase.  It can be deleted once
 * the codebase is clean.
 */

export {}
