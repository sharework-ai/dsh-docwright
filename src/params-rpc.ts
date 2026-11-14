import type { Config as DocwrightConfig } from './config.ts'
import { asLocalizedText } from './description.ts'
import type { LocalizedText } from './description.ts'
import type { Pack, ParamSpec } from './pack.ts'
import type { Json } from './receipt.ts'

/**
 * Read-side data for the params maintenance UI (S1 of
 * docs/designs/param-management-ui.md): the full ParamSpec metadata the model
 * face (doc_packs) deliberately omits (min/max/enum — rules-layer metadata,
 * not prompt material), the consumes graph resolved into per-declaration
 * ROLES (which manifest default actually governs a chain-shared param), and
 * the plugin Config with per-key provenance. Pure functions; the HTTP layer
 * (src/http.ts) only serializes.
 *
 * Inclusion criterion: the UI maintains DECLARED DEFAULT BEHAVIOR — only
 * params WITH a default appear. Required-without-default (cfpTotal,
 * targetIndex), derived (topicNo), call-level, and receipt values stay out:
 * they belong to the conversation/extraction/receipt channels.
 */

/** Resolved static role of one pack's declaration of a param. */
export interface ParamRole {
  readonly role: 'source' | 'shadowed'
  /** Present when shadowed: the pack whose manifest default actually governs (transitive origin, not merely the nearest declarer). */
  readonly shadowedBy?: string
}

/**
 * For every pack and every param it declares (default-carrying or not —
 * roles are computed for all declarations, the catalog filters later),
 * resolve which declaration is the effective source: walk upstream along
 * `consumes` (BFS in manifest declaration order — the same order the call's
 * upstream array is conventionally given); the nearest declarer shadows this
 * pack, and a shadowed declarer's own origin propagates transitively (the
 * chain head's default is what reaches every downstream receipt). Multi-
 * upstream ambiguity (a pack consuming several chains) resolves by consumes
 * order — deterministic, and matching how mergeUpstreamParams layers the
 * receipts. Unknown consumed pack names contribute nothing (they cannot
 * resolve at call time either).
 */
export function paramRoles(packs: ReadonlyMap<string, Pack>): ReadonlyMap<string, ReadonlyMap<string, ParamRole>> {
  const roles = new Map<string, Map<string, ParamRole>>()
  const resolve = (packName: string, param: string, seen: ReadonlySet<string>): ParamRole => {
    const cached = roles.get(packName)?.get(param)
    if (cached !== undefined) return cached
    const pack = packs.get(packName)
    if (pack === undefined || seen.has(packName)) return { role: 'source' }
    const nextSeen = new Set(seen).add(packName)
    const declared = pack.manifest.params ?? {}
    const roleOf = (p: ParamSpec): ParamRole => {
      // BFS over direct upstreams in declaration order.
      for (const upstreamName of pack.manifest.consumes) {
        const upstream = packs.get(upstreamName)
        if (upstream === undefined) continue
        if (upstream.manifest.params?.[param] !== undefined) {
          const upstreamRole = resolve(upstreamName, param, nextSeen)
          return upstreamRole.role === 'source'
            ? { role: 'shadowed', shadowedBy: upstreamName }
            : { role: 'shadowed', shadowedBy: upstreamRole.shadowedBy! }
        }
      }
      return { role: 'source' }
    }
    const spec = declared[param]
    const result = spec === undefined ? { role: 'source' } as const : roleOf(spec)
    ;(roles.get(packName) ?? roles.set(packName, new Map()).get(packName)!).set(param, result)
    return result
  }
  for (const pack of packs.values()) {
    for (const param of Object.keys(pack.manifest.params ?? {})) void resolve(pack.manifest.name, param, new Set())
  }
  return roles
}

/** One pack-scoped declaration as the UI renders it (full metadata + resolved role). */
export interface UiParamDeclaration {
  readonly pack: string
  readonly name: string
  readonly type: string
  /** Author content passed through verbatim (LocalizedText); the browser resolves the locale. */
  readonly description: LocalizedText
  readonly default: Json
  readonly required: boolean
  readonly confirm: boolean
  readonly overridable: boolean
  readonly extractable: boolean
  readonly enumValues?: readonly (number | string | boolean)[]
  readonly min?: number
  readonly max?: number
  readonly role: 'source' | 'shadowed'
  readonly shadowedBy?: string
}

/** Per-pack view: the pack's default-carrying params with full metadata. */
export interface UiPackEntry {
  readonly name: string
  readonly version: string
  /** Author content passed through verbatim (LocalizedText); the browser resolves the locale. */
  readonly description: LocalizedText
  readonly scope: 'workspace' | 'topic'
  readonly consumes: readonly string[]
  readonly paramDriftPolicy?: string
  /** Where the pack was loaded from — the UI shows it so an edit's destination is never a surprise (write lands in the same root's manifest.json). */
  readonly origin: { readonly kind: 'builtin' | 'packsDir' | 'extraPacksDir' | 'workspace'; readonly root: string; readonly depth?: number }
  readonly params: readonly UiParamDeclaration[]
}

/** Aggregated view: same-name declarations across packs collapse into one row. */
export interface UiParamGroup {
  readonly name: string
  /** Packs whose declaration governs (role "source") — the edit routes. */
  readonly sources: readonly string[]
  readonly declarations: readonly UiParamDeclaration[]
}

export interface ParamsCatalog {
  readonly packs: readonly UiPackEntry[]
  readonly groups: readonly UiParamGroup[]
}

function uiDeclaration(pack: Pack, name: string, spec: ParamSpec, role: ParamRole): UiParamDeclaration {
  return {
    pack: pack.manifest.name,
    name,
    type: spec.type,
    description: spec.description,
    default: spec.default as Json,
    required: spec.required === true,
    confirm: spec.confirm === true,
    overridable: spec.overridable === true,
    extractable: spec.extractable === true,
    ...(spec.enum !== undefined ? { enumValues: [...spec.enum] } : {}),
    ...(spec.min === undefined ? {} : { min: spec.min }),
    ...(spec.max === undefined ? {} : { max: spec.max }),
    role: role.role,
    ...(role.shadowedBy === undefined ? {} : { shadowedBy: role.shadowedBy }),
  }
}

/**
 * The two pack-param views. Only default-carrying declarations appear (the
 * inclusion criterion); both views share the same declaration objects so the
 * UI renders one row shape.
 */
export function buildParamsCatalog(packs: ReadonlyMap<string, Pack>): ParamsCatalog {
  const roles = paramRoles(packs)
  const packEntries: UiPackEntry[] = []
  const byName = new Map<string, UiParamDeclaration[]>()
  for (const pack of [...packs.values()].sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1))) {
    const declared = pack.manifest.params ?? {}
    const packRoles = roles.get(pack.manifest.name) ?? new Map<string, ParamRole>()
    const params: UiParamDeclaration[] = []
    for (const name of Object.keys(declared).sort()) {
      const spec = declared[name]!
      if (spec.default === undefined) continue
      const entry = uiDeclaration(pack, name, spec, packRoles.get(name) ?? { role: 'source' })
      params.push(entry)
      ;(byName.get(name) ?? byName.set(name, []).get(name)!).push(entry)
    }
    packEntries.push({
      name: pack.manifest.name,
      version: pack.manifest.version,
      description: pack.manifest.description,
      scope: pack.manifest.scope,
      consumes: [...pack.manifest.consumes],
      ...(pack.manifest.paramDriftPolicy === undefined ? {} : { paramDriftPolicy: pack.manifest.paramDriftPolicy }),
      origin: pack.origin,
      params,
    })
  }
  const groups: UiParamGroup[] = [...byName.keys()].sort().map(name => {
    // The governing declaration leads the row; shadowed ones follow.
    const declarations = byName.get(name)!.sort((a, b) => {
      if (a.role !== b.role) return a.role === 'source' ? -1 : 1
      return a.pack < b.pack ? -1 : 1
    })
    return {
      name,
      sources: declarations.filter(d => d.role === 'source').map(d => d.pack),
      declarations,
    }
  })
  return { packs: packEntries, groups }
}

/** One Config key (dotted path for nested keys) as the UI renders it. */
export interface UiConfigEntry {
  readonly key: string
  readonly type: string
  readonly description?: LocalizedText
  /** Absent when unset (no schema default and not configured). */
  readonly value?: Json
  /** Schema default; absent when the key has none (provider, model, paths). */
  readonly default?: Json
  readonly origin: 'default' | 'configured'
  /** Union members (e.g. confirmPolicy's none/standard/strict) for the dropdown. */
  readonly choices?: readonly (number | string | boolean)[]
}

/** Probed schemastery node shape (type/meta/dict/list) — cast boundary for the config walk. */
export interface SchemaNode {
  readonly type?: unknown
  readonly meta?: { readonly description?: unknown; readonly default?: unknown }
  readonly dict?: Readonly<Record<string, SchemaNode>> | null
  /** Union members expose `type`/`value` own properties (uid/refs exist only in the toJSON projection). */
  readonly list?: readonly { readonly type?: unknown; readonly value?: unknown }[]
}

/** Union member values; absent when the union carries non-const members. */
function unionChoices(node: SchemaNode): readonly (number | string | boolean)[] | undefined {
  const values = (node.list ?? [])
    .filter(entry => (typeof entry.value === 'number' || typeof entry.value === 'string' || typeof entry.value === 'boolean'))
    .map(entry => entry.value as number | string | boolean)
  return values.length > 0 ? values : undefined
}

/** The full GET payload: pack-param views + config provenance in one response. */
export function buildParamsPayload(packs: ReadonlyMap<string, Pack>, configSchema: unknown, resolved: DocwrightConfig): {
  packs: readonly UiPackEntry[]
  groups: readonly UiParamGroup[]
  config: readonly UiConfigEntry[]
  disabledPacks: readonly string[]
} {
  return { ...buildParamsCatalog(packs), config: buildConfigCatalog(configSchema as SchemaNode, resolved), disabledPacks: resolved.disabledPacks ?? [] }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Plugin Config with provenance (S1 scope): schema-walked dotted keys with
 * description/default/choices from the schema itself (single fact source —
 * the same meta the host's config catalog renders) and the resolved value
 * compared against the schema default. File-level origin (cordis.yml vs
 * patch layer) lands with S3's write channel, which must locate those files
 * anyway; until then `origin: "default" | "configured"` is what the static
 * comparison can honestly state.
 */
export function buildConfigCatalog(schema: SchemaNode, resolved: DocwrightConfig): UiConfigEntry[] {
  const entries: UiConfigEntry[] = []
  const walk = (node: SchemaNode, path: readonly string[]): void => {
    const meta = node.meta ?? {}
    // Schema meta is the single home of Config copy; LocalizedText dicts pass
    // through for the browser to resolve (schemastery meta: string | Dict).
    const description = asLocalizedText(meta.description)
    const hasDefault = 'default' in meta && meta.default !== undefined
    if (node.dict !== undefined && node.dict !== null && Object.keys(node.dict).length > 0) {
      if (path.length > 0 && description !== undefined) {
        // Non-leaf nodes with a description surface as read-only group headers
        // alongside their leaves (the leaves carry the editable values).
        const groupValue = path.reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], resolved)
        entries.push({
          key: path.join('.'),
          type: 'object',
          ...(description === undefined ? {} : { description }),
          ...(groupValue === undefined ? {} : { value: groupValue as Json }),
          origin: 'default',
        })
      }
      for (const [key, child] of Object.entries(node.dict)) walk(child, [...path, key])
      return
    }
    const value = path.reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], resolved)
    const defaultJson = hasDefault ? (meta.default as Json) : undefined
    entries.push({
      key: path.join('.'),
      type: typeof node.type === 'string' ? node.type : 'unknown',
      ...(description === undefined ? {} : { description }),
      ...(value === undefined ? {} : { value: value as Json }),
      ...(defaultJson === undefined ? {} : { default: defaultJson }),
      // Display semantics: "default" = the unset/schema-governed state (value
      // absent, or explicitly equal to the schema default); "configured" = a
      // set value that the schema default does not already account for.
      origin: value === undefined || (hasDefault && sameJson(value, meta.default)) ? 'default' : 'configured',
      ...(node.type === 'union' ? { ...(unionChoices(node) === undefined ? {} : { choices: unionChoices(node)! }) } : {}),
    })
  }
  walk(schema, [])
  return entries
}
