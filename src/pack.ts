import type { Issue, Severity } from './issue.ts'
import type { Json } from './receipt.ts'
import type { LocalizedText } from './description.ts'

/**
 * Hybrid pack: declarative JSON rules for simple families plus a JS function
 * manifest for cross-field rules (CFP sums, uniqueness across arrays).
 * Decided at the /autoplan final gate (UC2) after the spectral-core probe.
 */

/** Declarative rule families; each targets one field across an array scope. Numeric bounds and pattern sources may reference pack params. */
export type DeclarativeRule =
  | { id: string; severity: Severity; given: string; field: string; kind: 'minLength'; min: number | ParamRef; suggestion: string }
  | { id: string; severity: Severity; given: string; field: string; kind: 'maxLength'; max: number | ParamRef; suggestion: string }
  | { id: string; severity: Severity; given: string; field: string; kind: 'forbiddenKeywords'; keywords: readonly string[]; suggestion: string }
  | { id: string; severity: Severity; given: string; field: string; kind: 'pattern'; pattern: string | ParamRef; mustMatch: boolean; suggestion: string }

/**
 * Execution context handed to function rules as an optional second argument:
 * everything the current doc_generate/doc_validate call has beyond the
 * artifact itself. Chained packs use it for cross-artifact rules (upstream),
 * deployment allowlists (params), and reference material checks (materials).
 */
export interface RuleContext {
  /** Upstream artifacts of the call, parsed (best-effort; unparseable entries are skipped). */
  readonly upstream?: readonly unknown[]
  /** Raw material texts of the call (#!inline markers already stripped). */
  readonly materials?: readonly string[]
  /** Effective pack params as-run (defaults + call overrides, validated). */
  readonly params?: Readonly<Record<string, unknown>>
}

/** JS rule: receives the whole artifact plus the optional call context. Pack-author authored. */
export interface FunctionRule {
  readonly id: string
  readonly severity: Severity
  readonly suggestion: string
  check(artifact: unknown, context?: RuleContext): RuleIssue[]
}

/** Shape function rules may return (structural subset of Issue). */
export interface RuleIssue {
  readonly jsonPath: string
  readonly message: string
  readonly snapshot?: string
}

/**
 * Pack-provided convergence score (layer 1 of the termination policy):
 * a 0-100 quality estimate, higher is better. Receives the artifact and the
 * round's issues so cross-field and rule-aware scoring are both possible.
 * Never decides green — 0 errors does; it only informs early termination.
 */
export type ScoreFn = (artifact: unknown, issues: readonly Issue[]) => number

/**
 * Reference to a pack-declared parameter, usable in declarative-rule numeric
 * bounds (minLength.min / maxLength.max). Resolved per call from the
 * effective params; unknown names fail at pack load time.
 */
export interface ParamRef {
  readonly param: string
}

export function isParamRef(value: unknown): value is ParamRef {
  return typeof value === 'object' && value !== null && typeof (value as { param?: unknown }).param === 'string'
}

/** Declaration of one pack tunable (manifest `params`); declaration IS the allowlist. */
export interface ParamSpec {
  readonly type: 'number' | 'string' | 'boolean' | 'object'
  /** Absent on required params (the caller must state the value) and on optional-without-default params (present only when inherited or passed). */
  readonly default?: number | string | boolean | { readonly [key: string]: Json } | undefined
  /** No default: resolution fails loud unless the call or the upstream receipt provides the value. */
  readonly required?: boolean | undefined
  /** Materials content may adjust this param (prompt-rendered permission; the as-run value is still what validation replays). Load-time requires confirm (docs/designs/params-and-chain-contract.md). */
  readonly overridable?: boolean | undefined
  /** Included in the doc_generate confirmation gate (docs/designs/params-and-chain-contract.md). */
  readonly confirm?: boolean | undefined
  /**
   * The param may be extracted from materials by doc_extract_params: the
   * model proposes {value, quote} and the engine verifies the quote is a
   * verbatim material excerpt. Load-time requires confirm — the extraction's
   * self-evidence channel IS the confirmation table's quote column, and a
   * param that never gates (fan-out addressing) has no such channel.
   */
  readonly extractable?: boolean | undefined
  readonly enum?: readonly (number | string | boolean)[] | undefined
  /** Numeric bounds (number-typed params only); the default must satisfy them. */
  readonly min?: number | undefined
  readonly max?: number | undefined
  /** Author content in the UI's说明 line; LocalizedText (en required on locale maps). */
  readonly description: LocalizedText
}

/** Pack manifest (`manifest.json`); version gates breaking pack changes. */
export interface PackManifest {
  readonly name: string
  readonly version: string
  /** One line naming the document this pack generates; `doc_packs` shows it to the model (projected to `en`). */
  readonly description: LocalizedText
  /** Artifact type names this pack consumes (chained generation); root packs use []. */
  readonly consumes: readonly string[]
  /**
   * Artifact home scope (docs/designs/cosmic-context.md): "workspace" packs
   * share project-level directories (materials `references/`, artifacts
   * `context/`) and ignore the call's topic; "topic" packs (the default)
   * work inside one topic's directories.
   */
  readonly scope: 'workspace' | 'topic'
  /**
   * Whether doc_generate may reuse an existing green, hash-intact artifact of
   * this pack without regenerating. Defaults differ by scope semantics
   * (workspace packs true — the workspace-level analysis happens once; topic
   * packs false — per-topic generation is progressive: fan-out advances and
   * params get retuned, so a fresh document is the expected outcome). A
   * manifest declaration overrides the default; declaring reuse on a chained
   * pack is safe only because every input class is anchor-verified at the
   * reuse pre-check (materials manifest, upstream hashes, pack version).
   */
  readonly reuse: boolean
  /** IETF-ish language tags the pack provides prompts/templates/keyword rules for. */
  readonly languages: readonly string[]
  /** Optional per-pack round-count default for the repair loop (clamped by config maxRoundsCeiling). */
  readonly maxRounds?: number | undefined
  /** Behavior when call-time params drift from the upstream receipt's recorded params (docs/designs/params-and-chain-contract.md). */
  readonly paramDriftPolicy?: 'regenerate' | 'revalidate' | undefined
  /**
   * Material directory name overriding config materialsRoot (default
   * "references" — project reference knowledge). A different name separates
   * a different input semantic: e.g. "input" marks user-provided requirement
   * docs. Topic-scope packs resolve refs against `<topic>/<dir>/` first, then
   * the workspace-level `<workspace>/<dir>/`.
   */
  readonly materialsRoot?: string | undefined
  /**
   * Require the call's `topic` parameter (docs/designs/cosmic-context.md):
   * topic-scoped packs refuse to generate without one, so a work item's
   * artifacts all land under `<topic>/output/`. Meaningless on
   * workspace-scope packs (topic is ignored there) and rejected at load time.
   */
  readonly requiresTopic?: boolean | undefined
  /**
   * Stage prefix for engine-named artifacts (e.g. REQ/FUNC/TECH/PLAN):
   * per-function artifacts become `<prefix>-<topicNo>-<NN>`, whole-scope
   * ones `<prefix>-<topicNo>`; absent keeps `<pack>-<funcId>` / timestamp.
   */
  readonly artifactPrefix?: string | undefined
  /** Declared tunables; declaration is the allowlist — undeclared names are rejected at call time. */
  readonly params?: Readonly<Record<string, ParamSpec>> | undefined
}

/** A loaded, resolved pack ready for the loop. */
export interface Pack {
  readonly manifest: PackManifest
  /** JSON Schema (draft-07 or 2020-12) the artifact must satisfy. */
  readonly schema: Record<string, unknown>
  /** Declarative rules; language-scoped keyword rules keyed per language. */
  readonly rules: ReadonlyMap<string, readonly DeclarativeRule[]>
  readonly functionRules: readonly FunctionRule[]
  /** Optional convergence scorer exported from rules/functions.js (0-100). */
  readonly score?: ScoreFn | undefined
  /** sha256 of rules/functions.js source bytes; '' when the pack ships none. */
  readonly functionsSourceHash: string
  /** Generator prompt per language; `{{materials}}`, `{{upstream}}` slots. */
  readonly prompts: ReadonlyMap<string, string>
  /** Handlebars template per language rendering the artifact to Markdown. */
  readonly templates: ReadonlyMap<string, string>
  /** Audited reference document that must pass all-green. */
  readonly goldenSample: unknown
  /** Working directory the pack was loaded from (diagnostics). */
  readonly dir: string
  /**
   * Which root the pack was loaded from (params-UI provenance + write-path
   * routing): 'builtin' packages ship inside the plugin, 'packsDir' packs
   * come from the config's install root (a same-name override or a custom
   * pack), 'extraPacksDir' from the profile's additional root, 'workspace'
   * from the session workspace's .docwright/packs tier (loaded dynamically
   * per call; depth counts how many levels above the workspace the tier sits,
   * 0 = the workspace itself — docs/designs/pack-load-dirs.md). A pack-param
   * default edit must persist to `dir` — which IS the origin's pack
   * directory — so provenance is display-only for correctness and
   * load-bearing for user trust ("where will my edit land?").
   */
  readonly origin: { readonly kind: 'builtin' | 'packsDir' | 'extraPacksDir' | 'workspace'; readonly root: string; readonly depth?: number }
}
