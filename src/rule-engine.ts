import type { DeclarativeRule, FunctionRule, Pack, ParamRef, RuleContext } from './pack.ts'
import { isParamRef } from './pack.ts'
import type { Issue } from './issue.ts'
import type { ReceiptRuleResult } from './receipt.ts'

export const SCHEMA_RULE_FAMILY = 'schema/*'

/** Compiled view of a declarative rule; regex is validated once at engine creation. */
interface CompiledRule {
  readonly rule: DeclarativeRule
  /** 'root' = the artifact itself; otherwise the hop chain to the scoped items. */
  readonly scope: 'root' | { readonly hops: { readonly key: string; readonly each: boolean }[] }
  readonly re?: RegExp
}
import { truncateSnapshot } from './issue.ts'

/**
 * Mini rule engine (bake-off winner over @stoplight/spectral-core; see
 * docs/designs/docwright-mvp.md Approach A: probe found CJS-only packaging and
 * custom-function wiring friction; the packs' rule families map here in
 * ~100 lines). Runs declarative rules then function rules over the artifact.
 */

function compileRule(rule: DeclarativeRule): CompiledRule {
  let re: RegExp | undefined
  if (rule.kind === 'pattern' && !isParamRef(rule.pattern)) {
    try {
      re = new RegExp(rule.pattern)
    } catch (error) {
      throw new Error(`rule ${rule.id}: invalid pattern "${rule.pattern}": ${(error as Error).message}`)
    }
  }
  if (rule.given === '$') return { rule, scope: 'root', ...(re === undefined ? {} : { re }) }
  // Grammar: $ followed by hops of .field or .field[*]; the LAST hop must be
  // a [*] (rules check each item of the scoped array). Nested paths like
  // $.chapters[*].processes[*] scope the inner array's items.
  const hops = [...rule.given.matchAll(/\.([A-Za-z0-9_]+)(\[\*\])?/g)]
  const rebuilt = hops.map(m => `.${m[1] ?? ''}${m[2] ?? ''}`).join('')
  if (hops.length === 0 || rebuilt !== rule.given.slice(1) || hops[hops.length - 1]?.[2] === undefined) {
    throw new Error(`rule ${rule.id}: given path not supported: ${rule.given} (supported: $, $.field[*], and nested chains like $.chapters[*].processes[*] — the last hop must be [*])`)
  }
  return {
    rule,
    scope: { hops: hops.map(m => ({ key: m[1] ?? '', each: m[2] !== undefined })) },
    ...(re === undefined ? {} : { re }),
  }
}

function scopeFor(artifact: unknown, compiled: CompiledRule): readonly unknown[] {
  if (compiled.scope === 'root') return [artifact]
  let level: unknown[] = [artifact]
  for (const hop of compiled.scope.hops) {
    const next: unknown[] = []
    for (const item of level) {
      const value = (item as Record<string, unknown> | null)?.[hop.key]
      if (hop.each) {
        if (Array.isArray(value)) next.push(...value)
      } else if (value !== undefined && value !== null) {
        next.push(value)
      }
    }
    level = next
  }
  return level
}

/** Resolve a numeric bound: literal, or a pack param reference (effective params are always complete — defaults guarantee it). */
function resolveBound(value: number | ParamRef, params: Readonly<Record<string, unknown>> | undefined, ruleId: string): number {
  if (!isParamRef(value)) return value
  const resolved = params?.[value.param]
  if (typeof resolved !== 'number') {
    throw new Error(`rule ${ruleId}: param "${value.param}" did not resolve to a number; effective params are incomplete (defaults guarantee completeness — this indicates a bug)`)
  }
  return resolved
}

/**
 * Resolve a pattern rule's regex at check time: a literal compiles once at
 * engine creation, a param reference resolves per call (the user may retune
 * it between calls). Semantics for referenced patterns (docs/designs/
 * param-object-model.md): empty string = the check is off, a non-empty
 * string must compile (invalid regex fails loud, never silently passes) and
 * the field value must match it (mustMatch of the rule applies as usual).
 */
function resolvePatternRe(rule: DeclarativeRule & { kind: 'pattern' }, params: Readonly<Record<string, unknown>> | undefined): RegExp | undefined {
  if (!isParamRef(rule.pattern)) return undefined
  const source = params?.[rule.pattern.param]
  if (typeof source !== 'string') {
    throw new Error(`rule ${rule.id}: param "${rule.pattern.param}" did not resolve to a string; effective params are incomplete (defaults guarantee completeness — this indicates a bug)`)
  }
  if (source === '') return undefined
  try {
    return new RegExp(source)
  } catch (error) {
    throw new Error(`rule ${rule.id}: param "${rule.pattern.param}" is not a valid regex "${source}": ${(error as Error).message}`)
  }
}

function checkField(compiled: CompiledRule, item: unknown, index: number, params: Readonly<Record<string, unknown>> | undefined): Issue | undefined {
  const rule = compiled.rule
  const obj = item as Record<string, unknown> | null
  const value = obj?.[rule.field]
  const at = rule.given === '$' ? `$.${rule.field}` : `${rule.given.slice(0, -3)}[${index}].${rule.field}`
  const snapshot = truncateSnapshot(value)
  switch (rule.kind) {
    case 'minLength': {
      const min = resolveBound(rule.min, params, rule.id)
      const len = typeof value === 'string' ? value.length : -1
      return len >= min ? undefined : { ruleId: rule.id, severity: rule.severity, jsonPath: at, message: `length ${len} < min ${min}`, ...(snapshot === undefined ? {} : { snapshot }), suggestion: rule.suggestion }
    }
    case 'maxLength': {
      const max = resolveBound(rule.max, params, rule.id)
      const len = typeof value === 'string' ? value.length : Number.POSITIVE_INFINITY
      return len <= max ? undefined : { ruleId: rule.id, severity: rule.severity, jsonPath: at, message: `length ${len} > max ${max}`, ...(snapshot === undefined ? {} : { snapshot }), suggestion: rule.suggestion }
    }
    case 'forbiddenKeywords': {
      const text = typeof value === 'string' ? value : ''
      const hit = rule.keywords.find(k => text.includes(k))
      return hit === undefined ? undefined : { ruleId: rule.id, severity: rule.severity, jsonPath: at, message: `forbidden keyword "${hit}"`, ...(snapshot === undefined ? {} : { snapshot }), suggestion: rule.suggestion }
    }
    case 'pattern': {
      const re = compiled.re ?? resolvePatternRe(rule, params)
      if (re === undefined) return undefined
      const text = typeof value === 'string' ? value : ''
      const source = isParamRef(rule.pattern) ? `param ${rule.pattern.param}` : `"${rule.pattern}"`
      const matches = re.test(text)
      return matches === rule.mustMatch ? undefined : { ruleId: rule.id, severity: rule.severity, jsonPath: at, message: `pattern ${source} ${rule.mustMatch ? 'not matched' : 'matched (forbidden)'}`, ...(snapshot === undefined ? {} : { snapshot }), suggestion: rule.suggestion }
    }
  }
}

export function createRuleEngine(pack: Pack, language: string): (artifact: unknown, params?: Readonly<Record<string, unknown>> | undefined, context?: RuleContext | undefined) => readonly Issue[] {
  const declarative = pack.rules.get(language)
  if (declarative === undefined) {
    throw new Error(`pack ${pack.manifest.name} has no rules for language "${language}"`)
  }
  const compiledRules = declarative.map(compileRule)
  return (artifact: unknown, params?: Readonly<Record<string, unknown>> | undefined, context?: RuleContext | undefined): readonly Issue[] => {
    const issues: Issue[] = []
    const ruleContext: RuleContext = { ...(params === undefined ? {} : { params }), ...(context === undefined ? {} : context) }
    for (const compiled of compiledRules) {
      for (const [index, item] of scopeFor(artifact, compiled).entries()) {
        const issue = checkField(compiled, item, index, params)
        if (issue !== undefined) issues.push(issue)
      }
    }
    for (const rule of pack.functionRules) {
      try {
        for (const found of rule.check(artifact, ruleContext)) {
          issues.push({ ruleId: rule.id, severity: rule.severity, jsonPath: found.jsonPath, message: found.message, ...(found.snapshot === undefined ? {} : { snapshot: found.snapshot }), suggestion: rule.suggestion })
        }
      } catch (error) {
        throw new Error(`rule ${rule.id} crashed: ${(error as Error).message}`)
      }
    }
    return issues
  }
}

/**
 * Issue set → per-rule rollup for receipts. Schema violations roll up under
 * the `schema/*` family; loop-internal issues (`internal/*`) appear as
 * themselves; rules that never failed list as pass.
 */
export function rollupRules(pack: Pack, language: string, issues: readonly Issue[]): ReceiptRuleResult[] {
  const failed = new Map<string, number>()
  let schemaFailures = 0
  for (const i of issues) {
    if (i.ruleId.startsWith('schema/')) schemaFailures++
    else failed.set(i.ruleId, (failed.get(i.ruleId) ?? 0) + 1)
  }
  const severityOf = new Map<string, string>([
    ...(pack.rules.get(language) ?? []).map(r => [r.id, r.severity] as const),
    ...pack.functionRules.map(r => [r.id, r.severity] as const),
  ])
  const ids = new Set<string>([
    ...(pack.rules.get(language) ?? []).map(r => r.id),
    ...pack.functionRules.map(r => r.id),
    SCHEMA_RULE_FAMILY,
    ...failed.keys(),
  ])
  return [...ids].sort().map(ruleId => ({
    ruleId,
    severity: ruleId === SCHEMA_RULE_FAMILY ? 'error' : severityOf.get(ruleId) ?? 'error',
    status: ruleId === SCHEMA_RULE_FAMILY
      ? (schemaFailures > 0 ? ('fail' as const) : ('pass' as const))
      : failed.has(ruleId) ? ('fail' as const) : ('pass' as const),
    count: ruleId === SCHEMA_RULE_FAMILY ? schemaFailures : failed.get(ruleId) ?? 0,
  }))
}
