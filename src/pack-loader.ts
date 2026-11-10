import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import type { DeclarativeRule, FunctionRule, Pack, PackManifest, ParamSpec, ScoreFn } from './pack.ts'
import { isParamRef } from './pack.ts'
import { assertLocalizedText } from './description.ts'
import type { LocalizedText } from './description.ts'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const SEVERITIES: readonly string[] = ['error', 'warning', 'info']
const RULE_KINDS: readonly string[] = ['minLength', 'maxLength', 'forbiddenKeywords', 'pattern']

/**
 * Directory-convention loader. Built-in packs ship inside the package;
 * `packsDir` entries override same-name packs (DX-H3 merge semantics).
 * Loading validates manifests, rules, prompts, and language coverage loudly:
 * a broken pack fails at plugin apply, never mid-generation.
 */

interface RawPackDirs {
  readonly extra?: readonly string[] | undefined
}

/** Strict param-spec validation: declaration is the allowlist, so a broken declaration must fail at load. */
function assertParamSpec(raw: unknown, dir: string, name: string): ParamSpec {
  const where = `pack ${dir}: manifest.params.${name}`
  if (typeof raw !== 'object' || raw === null) throw new Error(`${where} must be an object`)
  const s = raw as Partial<ParamSpec>
  if (s.type !== 'number' && s.type !== 'string' && s.type !== 'boolean' && s.type !== 'object') throw new Error(`${where}.type must be number|string|boolean|object`)
  assertLocalizedText(s.description, `${where}.description`)
  for (const flag of ['required', 'overridable', 'confirm'] as const) {
    if (s[flag] !== undefined && typeof s[flag] !== 'boolean') throw new Error(`${where}.${flag} must be a boolean when present`)
  }
  // Load-time invariant (param provenance, proposal B): an overridable param's
  // baseline must pass the user once. The confirmation gate guarantees exactly
  // that for confirm params (chain-head first call always gates), so
  // overridable without confirm would make the adjustable baseline invisible.
  // confirmPolicy "none" never gates — on that unattended lane this invariant
  // provides no guarantee by design.
  if (s.overridable === true && s.confirm !== true) {
    throw new Error(`${where}.overridable requires confirm: true (an adjustable param's baseline must pass the confirmation gate once; fix: add confirm: true or drop overridable)`)
  }
  // Extraction invariant (param provenance, proposal A): an extractable
  // param's provenance channel is the confirmation table's quote column, so
  // it must be a confirm param. This also bans extractable fan-out addressing
  // (required non-confirm): those never gate and never reach the table.
  if (s.extractable === true && s.confirm !== true) {
    throw new Error(`${where}.extractable requires confirm: true (an extracted value self-proves via the confirmation table's quote column; fix: add confirm: true or drop extractable)`)
  }
  if (s.extractable !== undefined && typeof s.extractable !== 'boolean') {
    throw new Error(`${where}.extractable must be a boolean when present`)
  }
  if (s.required === true) {
    // required + default is legal: a chain-necessary param whose default is
    // the standing value (always resolves, never confirm-gates on its own);
    // pure required (no default) still fails loud without an explicit value.
  } else if (s.default !== undefined) {
    const defaultMatches = s.type === 'number' ? typeof s.default === 'number' && Number.isFinite(s.default) : s.type === 'object' ? typeof s.default === 'object' && s.default !== null && !Array.isArray(s.default) : typeof s.default === s.type
    if (!defaultMatches) throw new Error(`${where}.default must match type "${s.type}"`)
  }
  if (s.type === 'object') {
    if (s.enum !== undefined) throw new Error(`${where}.enum is not supported for object params`)
    if (s.min !== undefined || s.max !== undefined) throw new Error(`${where}.min/max are only valid for number-typed params`)
  } else {
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.some(v => typeof v !== s.type)) {
        throw new Error(`${where}.enum must be a non-empty array of ${s.type} values`)
      }
      if (!s.enum.includes(s.default)) throw new Error(`${where}.default must be one of the declared enum values`)
    }
    if (s.type === 'number') {
      if (s.min !== undefined && (typeof s.min !== 'number' || !Number.isFinite(s.min))) throw new Error(`${where}.min must be a finite number`)
      if (s.max !== undefined && (typeof s.max !== 'number' || !Number.isFinite(s.max))) throw new Error(`${where}.max must be a finite number`)
      if (s.min !== undefined && s.max !== undefined && s.min > s.max) throw new Error(`${where}.min must be <= max`)
      const d = s.default as number | undefined
      if (d !== undefined && s.min !== undefined && d < s.min) throw new Error(`${where}.default must be >= min`)
      if (d !== undefined && s.max !== undefined && d > s.max) throw new Error(`${where}.default must be <= max`)
    } else if (s.min !== undefined || s.max !== undefined) {
      throw new Error(`${where}.min/max are only valid for number-typed params`)
    }
  }
  return s as ParamSpec
}

/** Manifest validation, exported for the params-UI write channel (S3): a proposed manifest must pass the exact load-time gate before it touches disk. */
export function assertManifest(raw: unknown, dir: string): PackManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error(`pack ${dir}: manifest.json must be an object`)
  const m = raw as Partial<PackManifest>
  if (typeof m.name !== 'string' || m.name.length === 0) throw new Error(`pack ${dir}: manifest.name must be a non-empty string`)
  if (typeof m.version !== 'string' || m.version.length === 0) throw new Error(`pack ${dir}: manifest.version must be a non-empty string`)
  try {
    assertLocalizedText(m.description, `pack ${dir}: manifest.description`)
  } catch (error) {
    throw new Error(`${(error as Error).message} (one line naming the document this pack generates; doc_packs shows the "en" entry to the model)`)
  }
  const description: LocalizedText = m.description
  if (!Array.isArray(m.languages) || m.languages.length === 0) throw new Error(`pack ${dir}: manifest.languages must be a non-empty array`)
  if (m.languages.some(l => typeof l !== 'string' || l.length === 0)) throw new Error(`pack ${dir}: manifest.languages entries must be non-empty strings`)
  if (m.consumes !== undefined && !Array.isArray(m.consumes)) throw new Error(`pack ${dir}: manifest.consumes must be an array when present`)
  if (m.scope !== undefined && m.scope !== 'workspace' && m.scope !== 'topic') {
    throw new Error(`pack ${dir}: manifest.scope must be "workspace" or "topic" (got ${JSON.stringify(m.scope)})`)
  }
  if (m.reuse !== undefined && typeof m.reuse !== 'boolean') {
    throw new Error(`pack ${dir}: manifest.reuse must be a boolean when present`)
  }
  if (m.requiresTopic !== undefined && typeof m.requiresTopic !== 'boolean') {
    throw new Error(`pack ${dir}: manifest.requiresTopic must be a boolean when present`)
  }
  if (m.materialsRoot !== undefined && (typeof m.materialsRoot !== 'string' || m.materialsRoot.length === 0 || isAbsolute(m.materialsRoot) || m.materialsRoot.split('/').includes('..'))) {
    throw new Error(`pack ${dir}: manifest.materialsRoot must be a workspace-relative directory path without ".." when present`)
  }
  if (m.artifactPrefix !== undefined && (typeof m.artifactPrefix !== 'string' || !/^[A-Za-z0-9-]{1,12}$/.test(m.artifactPrefix))) {
    throw new Error(`pack ${dir}: manifest.artifactPrefix must be a 1-12 char [A-Za-z0-9-] string when present`)
  }
  if (m.maxRounds !== undefined && (!Number.isInteger(m.maxRounds) || m.maxRounds < 1)) {
    throw new Error(`pack ${dir}: manifest.maxRounds must be a positive integer`)
  }
  if (m.paramDriftPolicy !== undefined && m.paramDriftPolicy !== 'regenerate' && m.paramDriftPolicy !== 'revalidate') {
    throw new Error(`pack ${dir}: manifest.paramDriftPolicy must be "regenerate" or "revalidate"`)
  }
  let params: Readonly<Record<string, ParamSpec>> | undefined
  if (m.params !== undefined) {
    if (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params)) {
      throw new Error(`pack ${dir}: manifest.params must be an object of { type, default, description, ... } declarations`)
    }
    const out: Record<string, ParamSpec> = {}
    for (const [name, spec] of Object.entries(m.params)) out[name] = assertParamSpec(spec, dir, name)
    params = out
  }
  // Scope/reuse defaults follow the scope semantics (docs/designs/cosmic-context.md):
  // workspace packs default reuse=true (the workspace-level analysis happens
  // once), topic packs default false (per-topic generation is progressive —
  // fan-out advances, params get retuned).
  const scope = m.scope ?? 'topic'
  if (scope === 'workspace' && m.requiresTopic === true) {
    throw new Error(`pack ${dir}: manifest.requiresTopic is meaningless on a workspace-scope pack (topic is ignored there); drop it or switch scope to "topic"`)
  }
  return {
    name: m.name,
    version: m.version,
    description,
    consumes: m.consumes ?? [],
    scope,
    reuse: m.reuse ?? scope === 'workspace',
    languages: m.languages,
    ...(m.maxRounds === undefined ? {} : { maxRounds: m.maxRounds }),
    ...(m.paramDriftPolicy === undefined ? {} : { paramDriftPolicy: m.paramDriftPolicy }),
    ...(m.requiresTopic === undefined ? {} : { requiresTopic: m.requiresTopic }),
    ...(m.materialsRoot === undefined ? {} : { materialsRoot: m.materialsRoot }),
    ...(m.artifactPrefix === undefined ? {} : { artifactPrefix: m.artifactPrefix }),
    ...(params === undefined ? {} : { params }),
  }
}

/**
 * Strict declarative-rule validation: a typo like severity "fatal" would
 * otherwise pass loading, never count as an error, and the loop would go
 * green over a failing rule. Kind-specific payloads are validated and
 * patterns compile-checked here.
 */
/** Numeric bound: literal or a reference to a declared number-typed param. */
function assertBound(value: unknown, dir: string, i: number, kind: string, side: string, params: Readonly<Record<string, ParamSpec>> | undefined): void {
  if (isParamRef(value)) {
    const spec = params?.[value.param]
    if (spec === undefined) {
      throw new Error(`pack ${dir}: rules[${i}].${kind}.${side} references undeclared param "${value.param}" (declared: ${params === undefined || Object.keys(params).length === 0 ? 'none' : Object.keys(params).join(', ')})`)
    }
    if (spec.type !== 'number') {
      throw new Error(`pack ${dir}: rules[${i}].${kind}.${side} references param "${value.param}" of type "${spec.type}"; bound references require a number-typed param`)
    }
    if (spec.default === undefined && spec.required !== true) {
      throw new Error(`pack ${dir}: rules[${i}].${kind}.${side} references param "${value.param}" which has no default; bound references require a param that is always present (give it a default or mark it required)`)
    }
    // Bound-referenced params are consumed by resolveBound as hard validation
    // edges; an overridable bound would let materials adjust the very rule
    // that judges the adjustment — permission and validation must not tangle.
    if (spec.overridable === true) {
      throw new Error(`pack ${dir}: rules[${i}].${kind}.${side} references param "${value.param}" which is overridable; bound-referenced params must not be overridable (an adjusted bound always trips its own rule; fix: drop overridable)`)
    }
    return
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`pack ${dir}: rules[${i}].${kind} requires a finite numeric ${side} or a { param: "..." } reference`)
  }
}

function assertRule(raw: unknown, dir: string, i: number, params: Readonly<Record<string, ParamSpec>> | undefined): DeclarativeRule {
  if (typeof raw !== 'object' || raw === null) throw new Error(`pack ${dir}: rules[${i}] must be an object`)
  const r = raw as Record<string, unknown>
  for (const k of ['id', 'severity', 'given', 'field', 'suggestion']) {
    if (typeof r[k] !== 'string' || (r[k] as string).length === 0) throw new Error(`pack ${dir}: rules[${i}].${k} must be a non-empty string`)
  }
  if (!SEVERITIES.includes(String(r.severity))) {
    throw new Error(`pack ${dir}: rules[${i}].severity must be one of error|warning|info (got ${JSON.stringify(r.severity)})`)
  }
  if (!RULE_KINDS.includes(String(r.kind))) {
    throw new Error(`pack ${dir}: rules[${i}].kind must be one of ${RULE_KINDS.join('|')}`)
  }
  switch (r.kind) {
    case 'minLength':
      assertBound(r.min, dir, i, 'minLength', 'min', params)
      break
    case 'maxLength':
      assertBound(r.max, dir, i, 'maxLength', 'max', params)
      break
    case 'forbiddenKeywords':
      if (!Array.isArray(r.keywords) || r.keywords.length === 0 || r.keywords.some(k => typeof k !== 'string' || k.length === 0)) {
        throw new Error(`pack ${dir}: rules[${i}].forbiddenKeywords requires a non-empty array of non-empty strings`)
      }
      break
    case 'pattern':
      if (isParamRef(r.pattern)) {
        const spec = params?.[r.pattern.param]
        if (spec === undefined) {
          throw new Error(`pack ${dir}: rules[${i}].pattern references undeclared param "${r.pattern.param}" (declared: ${params === undefined || Object.keys(params).length === 0 ? 'none' : Object.keys(params).join(', ')})`)
        }
        if (spec.type !== 'string') {
          throw new Error(`pack ${dir}: rules[${i}].pattern references param "${r.pattern.param}" of type "${spec.type}"; pattern references require a string-typed param`)
        }
        if (spec.overridable === true) {
          throw new Error(`pack ${dir}: rules[${i}].pattern references param "${r.pattern.param}" which is overridable; pattern-referenced params must not be overridable (an adjusted pattern always trips its own rule; fix: drop overridable)`)
        }
        if (spec.default === undefined && spec.required !== true) {
          throw new Error(`pack ${dir}: rules[${i}].pattern references param "${r.pattern.param}" which has no default; pattern references require a param that is always present (give it a default or mark it required)`)
        }
        // A non-empty default must compile: a broken shipped pattern fails at
        // load, and the same gate later rejects UI edits to garbage (the
        // proposed manifest re-runs assertManifest). Empty default is legal —
        // it means the check ships disabled (empty = no check).
        if (typeof spec.default === 'string' && spec.default.length > 0) {
          try {
            void new RegExp(spec.default)
          } catch (error) {
            throw new Error(`pack ${dir}: rules[${i}].pattern references param "${r.pattern.param}" whose default does not compile: ${(error as Error).message}`)
          }
        }
      } else {
        if (typeof r.pattern !== 'string' || r.pattern.length === 0) throw new Error(`pack ${dir}: rules[${i}].pattern must be a non-empty string`)
        try {
          void new RegExp(r.pattern)
        } catch (error) {
          throw new Error(`pack ${dir}: rules[${i}].pattern does not compile: ${(error as Error).message}`)
        }
      }
      if (typeof r.mustMatch !== 'boolean') throw new Error(`pack ${dir}: rules[${i}].pattern requires a boolean mustMatch`)
      break
  }
  return r as unknown as DeclarativeRule
}

/** Function-rule modules authored by pack maintainers; validated on load. */
async function loadFunctionRules(dir: string): Promise<{ rules: readonly FunctionRule[]; sourceHash: string; score: ScoreFn | undefined }> {
  const rulesPath = join(dir, 'rules', 'functions.js')
  let source: string
  try {
    source = await readFile(rulesPath, 'utf8')
  } catch {
    return { rules: [], sourceHash: '', score: undefined }
  }
  let mod: Record<string, unknown>
  try {
    // Dynamic import needs a URL, not a raw OS path: on Windows a bare `C:\...`
    // specifier is parsed as protocol `c:` (and `#` in a path would act as a
    // URL fragment on every platform).
    mod = await import(pathToFileURL(rulesPath).href)
  } catch (error) {
    // A present-but-broken functions.js must never silently disable rules.
    throw new Error(`pack ${dir}: rules/functions.js failed to import (${(error as Error).message}); fix the module or remove the file`)
  }
  const exported = mod.rules
  if (exported === undefined) throw new Error(`pack ${dir}: rules/functions.js must export a \`rules\` array`)
  if (!Array.isArray(exported)) throw new Error(`pack ${dir}: rules/functions.js \`rules\` must be an array`)
  const rules = exported.map((raw, i) => {
    const r = raw as Partial<FunctionRule>
    if (typeof r.id !== 'string' || r.id.length === 0) throw new Error(`pack ${dir}: functions.rules[${i}].id must be a non-empty string`)
    if (typeof r.suggestion !== 'string' || r.suggestion.length === 0) throw new Error(`pack ${dir}: functions.rules[${i}] must carry a suggestion`)
    if (typeof r.check !== 'function') throw new Error(`pack ${dir}: functions.rules[${i}].check must be a function`)
    if (r.severity !== undefined && !SEVERITIES.includes(String(r.severity))) {
      throw new Error(`pack ${dir}: functions.rules[${i}].severity must be error|warning|info`)
    }
    return { ...r, severity: r.severity ?? 'error' } as FunctionRule
  })
  const score = mod.score
  if (score !== undefined && typeof score !== 'function') {
    throw new Error(`pack ${dir}: rules/functions.js \`score\` export must be a function (artifact, issues) => 0-100 number`)
  }
  return { rules, sourceHash: sha256(source), score: score as ScoreFn | undefined }
}

/** Loads one pack's assets; `origin` is attached by loadPacks (it owns the root context). */
async function loadOnePack(dir: string): Promise<Omit<Pack, 'origin'>> {
  const manifest = assertManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')), dir)
  const schema = JSON.parse(await readFile(join(dir, 'schema.json'), 'utf8')) as Record<string, unknown>

  const rules = new Map<string, readonly DeclarativeRule[]>()
  const prompts = new Map<string, string>()
  const templates = new Map<string, string>()
  for (const lang of manifest.languages) {
    const rawRules = JSON.parse(await readFile(join(dir, 'rules', `${lang}.json`), 'utf8')) as unknown[]
    if (!Array.isArray(rawRules)) throw new Error(`pack ${dir}: rules/${lang}.json must be an array`)
    rules.set(lang, rawRules.map((r, i) => assertRule(r, dir, i, manifest.params)))
    const prompt = await readFile(join(dir, 'prompts', `${lang}.md`), 'utf8')
    if (!prompt.includes('{{materials}}')) {
      throw new Error(`pack ${dir}: prompts/${lang}.md is missing the {{materials}} slot; materials would be silently dropped`)
    }
    prompts.set(lang, prompt)
    templates.set(lang, await readFile(join(dir, 'templates', `${lang}.hbs`), 'utf8'))
  }
  const goldenSample = JSON.parse(await readFile(join(dir, 'samples', 'golden.json'), 'utf8'))
  const { rules: functionRules, sourceHash, score } = await loadFunctionRules(dir)
  return { manifest, schema, rules, functionRules, score, functionsSourceHash: sourceHash, prompts, templates, goldenSample, dir }
}

async function listPackRoots(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => join(root, e.name))
  } catch {
    return []
  }
}

/**
 * Load built-in packs then `packsDir` overrides. Same-name later entries win
 * (Config over built-in); failures inside a directory fail loud (ruleset
 * syntax belongs to load time, decision #11).
 */
export async function loadPacks(builtinRoot: string, dirs: RawPackDirs): Promise<ReadonlyMap<string, Pack>> {
  const roots = [builtinRoot, ...(dirs.extra ?? [])]
  const packs = new Map<string, Pack>()
  for (const [rootIndex, root] of roots.entries()) {
    const origin = { kind: rootIndex === 0 ? 'builtin' : 'packsDir', root } as const
    const seen = new Map<string, string>()
    for (const dir of await listPackRoots(root)) {
      const pack = await loadOnePack(dir)
      const clash = seen.get(pack.manifest.name)
      if (clash !== undefined) {
        throw new Error(`duplicate pack name "${pack.manifest.name}" within ${root}: both ${clash} and ${dir} declare it; rename or remove one. (An extra packsDir overriding a same-name builtin pack is intended merge semantics, but packs within one root must have unique names.)`)
      }
      seen.set(pack.manifest.name, dir)
      packs.set(pack.manifest.name, { ...pack, origin })
    }
  }
  return packs
}
