/**
 * character-registry-lookup — mirror of the Hermes Python tool.
 *
 * Two cooperating concerns live here:
 *   1. `lookupCharacterRegistry` — scans a beat (title + body) for
 *      proper-noun tokens that match registered character names, so
 *      "REGISTRY HIT · Hannah → freckled redhead in grey hoodie" can
 *      surface in the agent ticker before the image pipeline runs.
 *   2. `resolveCharacterAlias` — given a single name string emitted by
 *      visual-prompt-builder (e.g. "Light Yagami"), find the
 *      canonical registered key (e.g. "Light").  Required because
 *      different skills in the pipeline drift between short canonical
 *      names and full proper names; without alias resolution the
 *      portrait-reference attachment silently fails and image-gen
 *      redraws the character from scratch — visible to the user as
 *      "the same person looks different across beats".
 *
 * Both functions deterministic, stdlib only, zero LLM.  The Python
 * counterpart (see hermes-agent/tools/character_registry_lookup.py)
 * exists for upstream parity and CLI use; whenever this file gains a
 * function, the Python tool should gain the same one so any downstream
 * Hermes user who installs the tool sees Noustiny's behaviour.
 */

export interface RegistryHit {
  /** Canonical name as stored in the registry ("Hannah", "Thor"). */
  name: string
  /** The IP-free visual description the skill will reuse verbatim. */
  description: string
  /** Where the match was observed — helpful for tracing / debugging. */
  source: 'title' | 'body'
}

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g

/**
 * Return every registry entry whose name appears as a whole word in the
 * title or body.  Deduplicated by name.  Case-sensitive match — the
 * registry's keys are canonical names (Title Case), matching arbitrary
 * casing would drag in pronouns and common nouns.
 */
export function lookupCharacterRegistry(
  body: string,
  title: string,
  registry: Record<string, string>,
): RegistryHit[] {
  if (!registry || Object.keys(registry).length === 0) return []

  const hits: RegistryHit[] = []
  const seen = new Set<string>()

  const titleTokens = new Set((title.match(WORD_RE) ?? []))
  const bodyTokens = new Set((body.match(WORD_RE) ?? []))

  for (const name of Object.keys(registry)) {
    if (!name || seen.has(name)) continue
    const desc = registry[name]
    if (!desc) continue

    // Multi-word names ("Captain America", "Tony Stark") — match the
    // exact phrase anywhere in the concatenated beat text.
    if (name.includes(' ')) {
      if ((`${title}\n${body}`).includes(name)) {
        const source: 'title' | 'body' = title.includes(name) ? 'title' : 'body'
        hits.push({ name, description: desc, source })
        seen.add(name)
      }
      continue
    }

    // Single-word names — match as a whole token so "Tony" doesn't
    // trip on "tonyally" or "Tonya".  Titles often shout UPPERCASE
    // versions of names, so check the lowercased body/title tokens
    // against a case-insensitive alternate as well.
    if (titleTokens.has(name)) {
      hits.push({ name, description: desc, source: 'title' })
      seen.add(name)
      continue
    }
    if (bodyTokens.has(name)) {
      hits.push({ name, description: desc, source: 'body' })
      seen.add(name)
      continue
    }
    // Case-insensitive fallback — handles ALL-CAPS titles.
    const upper = name.toUpperCase()
    if (upper !== name && (title.includes(upper) || body.includes(upper))) {
      hits.push({ name, description: desc, source: title.includes(upper) ? 'title' : 'body' })
      seen.add(name)
    }
  }

  return hits
}


/**
 * Resolve a single name string against a registry, returning the
 * canonical registered key when it can be reconciled with one — even if
 * the supplied name is a longer / shorter / cased variant.
 *
 * Used by the image-gen reference-attachment path.  Earlier in the
 * pipeline `character-sheet-builder` registers each cast member under a
 * canonical short key ("Light") and produces the portrait that becomes
 * its visual reference.  Later, per-beat `image-prompt-build` emits a
 * `characters_seen[].source_name` per character — that string is
 * LLM-generated and routinely drifts ("Light Yagami", "light",
 * "Captain America (Steve Rogers)").  A naive `refs[query]` lookup
 * misses these drifted spellings and the portrait reference silently
 * fails to attach, so image-gen redraws the character without the
 * portrait → the same character looks different across beats.
 *
 * Matching tiers, evaluated in order:
 *   1. Exact key match.
 *   2. Case-insensitive exact.
 *   3. Whole-word token from the query equals a single-word
 *      registered key ("Light Yagami" → "Light").
 *   4. Multi-word registered key appears as a substring of the query
 *      ("Captain America" inside "Captain America (Steve Rogers)").
 *
 * Returns the canonical registered key (NOT the supplied alias) so
 * downstream payloads stay anchored to one name per character — passing
 * the LLM-supplied alias through would teach the image model that
 * "Light" and "Light Yagami" are two different identities across
 * calls.  Caller looks up the associated value (description / portrait
 * URL / whatever the registry stores) on the returned key.
 *
 * Generic over the value type because the same matching logic powers
 * both the textual character registry (name → description) and the
 * portrait-URL map (name → URL).
 */
export function resolveCharacterAlias<V>(
  registry: Record<string, V>,
  query: string,
): string | null {
  if (!query || !registry) return null
  if (registry[query] !== undefined) return query
  const q = query.trim()
  const qLower = q.toLowerCase()
  const keys = Object.keys(registry)
  const ciKey = keys.find((k) => k.toLowerCase() === qLower)
  if (ciKey) return ciKey
  const tokens = new Set(
    (q.match(WORD_RE) ?? []).map((t) => t.toLowerCase()),
  )
  for (const k of keys) {
    if (!k.includes(' ') && tokens.has(k.toLowerCase())) return k
    if (k.includes(' ') && qLower.includes(k.toLowerCase())) return k
  }
  return null
}
