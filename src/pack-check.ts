import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DocService } from './doc-service.ts'
import type { Issue } from './issue.ts'
import { loadPacks } from './pack-loader.ts'
import type { Pack } from './pack.ts'
import { resolveEffectiveParams } from './params.ts'

/**
 * pack:check — the authoring runner (docs/designs/pack-authoring.md,
 * verification ladder layers 1-2). Loads a pack directory through the real
 * loader gate, then validates every pack's golden sample per language through
 * the real DocService (ajv schema + all rules). Reuses loadPacks/getDocService
 * exclusively — zero second validation surface, the loader IS the linter.
 * Also emits a health sheet (rule inventory, severity distribution, param
 * table) as the authoring body-check.
 */

export interface PackCheckLanguage {
  readonly language: string
  readonly errors: number
  readonly warnings: number
  readonly infos: number
}

export interface PackCheckEntry {
  readonly pack: string
  readonly version: string
  readonly scope: string
  readonly consumes: readonly string[]
  readonly languages: readonly PackCheckLanguage[]
  readonly declarativeRules: number
  readonly functionRules: number
  readonly customScore: boolean
  readonly params: readonly { name: string; type: string; required: boolean; hasDefault: boolean; confirm: boolean; overridable: boolean; extractable: boolean }[]
}

export interface PackCheckReport {
  readonly root: string
  readonly packs: readonly PackCheckEntry[]
  /** Per-language golden failures (rule ids + messages); loader errors throw instead. */
  readonly failures: readonly string[]
  readonly green: boolean
}

export interface PackCheckOptions {
  /** Additional pack roots merged under `root` (same-name wins), so a packsDir pack can resolve consumed upstreams from other roots (e.g. the built-in packs). */
  readonly extraRoots?: readonly string[]
}

/**
 * Optional `samples/golden.params.json`: raw values for required-no-default
 * params during golden validation only (e.g. a budget param the chain head
 * normally receives via the confirmation gate). Resolution and spec checks
 * happen through the same resolveEffectiveParams path as real calls.
 */
async function goldenParamsOf(pack: Pack): Promise<Record<string, unknown> | undefined> {
  const path = join(pack.dir, 'samples', 'golden.params.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`pack ${pack.manifest.name}: samples/golden.params.json is not readable: ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`pack ${pack.manifest.name}: samples/golden.params.json is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pack ${pack.manifest.name}: samples/golden.params.json must be a JSON object of { paramName: value }`)
  }
  return parsed as Record<string, unknown>
}

function severityCountOf(issues: readonly Issue[], severity: Issue['severity']): number {
  return issues.filter(issue => issue.severity === severity).length
}

/**
 * Check one root directory: loader gate (throws on any fail-loud assertion),
 * then per-pack per-language golden validation. Golden upstreams are the
 * golden samples of the consumed packs (the same deterministic chain the
 * repository test suite seeds), and golden params resolve through the real
 * effective-params path (declared defaults + samples/golden.params.json).
 * Never returns non-green silently — every golden error lands in `failures`
 * with rule ids.
 */
export async function checkPacks(root: string, options: PackCheckOptions = {}): Promise<PackCheckReport> {
  const packs = await loadPacks(root, { extra: options.extraRoots ?? [] })
  // An empty root would be vacuously green — a typo'd directory must fail, not pass.
  if (packs.size === 0) {
    throw new Error(`pack:check: no packs found under ${root} (each subdirectory must be a pack with a manifest.json)`)
  }
  const entries: PackCheckEntry[] = []
  const failures: string[] = []
  for (const pack of packs.values()) {
    // Prefix/pattern pairing (guide Stage 4): a declared artifactPrefix only
    // engages when topicNo resolves, and topicNo resolves only through a
    // topicNoPattern param — declared at the pack itself (root pack) or
    // inherited via receipt re-declaration (downstream). A prefix without
    // the param silently degrades to timestamp names — red now, not a
    // surprise at generation time.
    if (pack.manifest.artifactPrefix !== undefined && pack.manifest.params?.topicNoPattern === undefined) {
      failures.push(
        `${pack.manifest.name}: manifest declares artifactPrefix "${pack.manifest.artifactPrefix}" without a topicNoPattern param `
        + '— engine naming needs a resolvable topicNo, so the prefix silently degrades to timestamp names; '
        + 'fix: declare the derivation pair (topicNoPattern with the convention regex, plus the topicNo param the engine injects; '
        + 'see the loader gate for the exact shapes) or drop the prefix',
      )
    }
    const missingConsumed = pack.manifest.consumes.filter(name => !packs.has(name))
    if (missingConsumed.length > 0) {
      failures.push(`${pack.manifest.name}: consumed upstream pack(s) absent from the checked roots: ${missingConsumed.join(', ')} — golden validation needs their golden samples as upstream; fix: re-run with --with <root> pointing at a root that ships them`)
      entries.push({
        pack: pack.manifest.name,
        version: pack.manifest.version,
        scope: pack.manifest.scope,
        consumes: [...pack.manifest.consumes],
        languages: [],
        declarativeRules: pack.rules.get(pack.manifest.languages[0]!)?.length ?? 0,
        functionRules: pack.functionRules.length,
        customScore: pack.score !== undefined,
        params: [],
      })
      continue
    }
    // Deterministic golden chain: consumed packs' golden samples as upstream.
    const upstream = pack.manifest.consumes.map(name => packs.get(name)!.goldenSample)
    const goldenParams = await goldenParamsOf(pack)
    const languages: PackCheckLanguage[] = []
    for (const language of pack.manifest.languages) {
      const service = new DocService(pack, language)
      let issues: readonly Issue[]
      try {
        const effective = resolveEffectiveParams(pack, goldenParams, undefined)
        issues = service.validate(pack.goldenSample, effective, { upstream })
      } catch (error) {
        failures.push(`${pack.manifest.name}/${language}: golden validation crashed: ${(error as Error).message}`)
        continue
      }
      const errors = severityCountOf(issues, 'error')
      const warnings = severityCountOf(issues, 'warning')
      const infos = severityCountOf(issues, 'info')
      languages.push({ language, errors, warnings, infos })
      for (const issue of issues.filter(i => i.severity === 'error')) {
        failures.push(`${pack.manifest.name}/${language}: [${issue.ruleId}] ${issue.jsonPath}: ${issue.message} (fix: ${issue.suggestion})`)
      }
    }
    entries.push({
      pack: pack.manifest.name,
      version: pack.manifest.version,
      scope: pack.manifest.scope,
      consumes: [...pack.manifest.consumes],
      languages,
      declarativeRules: pack.rules.get(pack.manifest.languages[0]!)?.length ?? 0,
      functionRules: pack.functionRules.length,
      customScore: pack.score !== undefined,
      params: Object.entries(pack.manifest.params ?? {}).map(([name, spec]) => ({
        name,
        type: spec.type,
        required: spec.required === true,
        hasDefault: spec.default !== undefined,
        confirm: spec.confirm === true,
        overridable: spec.overridable === true,
        extractable: spec.extractable === true,
      })),
    })
  }
  return { root, packs: entries, failures, green: failures.length === 0 }
}

/** Render the health sheet (human/agent-readable CLI output). */
export function renderPackCheckReport(report: PackCheckReport): string {
  const lines: string[] = []
  for (const entry of report.packs) {
    lines.push(
      `${entry.pack}@${entry.version} scope=${entry.scope} consumes=[${entry.consumes.join(', ')}] `
      + `rules=${entry.declarativeRules} declarative + ${entry.functionRules} functions `
      + `score=${entry.customScore ? 'custom' : 'builtin-default'}`,
    )
    for (const param of entry.params) {
      const flags = [param.required && 'required', param.confirm && 'confirm', param.overridable && 'overridable', param.extractable && 'extractable'].filter(Boolean).join(',')
      lines.push(`  param ${param.name}: ${param.type}${flags === '' ? '' : ` (${flags})`}${param.hasDefault ? '' : ' (no default)'}`)
    }
    for (const language of entry.languages) {
      lines.push(`  ${language.language}: golden ${language.errors === 0 ? 'GREEN' : 'RED'} — ${language.errors} error(s), ${language.warnings} warning(s), ${language.infos} info(s)`)
    }
  }
  for (const failure of report.failures) lines.push(`FAIL ${failure}`)
  lines.push(report.green ? `pack:check: PASS — ${report.packs.length} pack(s) green under ${report.root}` : `pack:check: FAIL — ${report.failures.length} failure(s) under ${report.root}`)
  return lines.join('\n')
}
