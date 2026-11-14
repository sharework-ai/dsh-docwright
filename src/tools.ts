import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveLocalized } from './description.ts'
import { DEFAULT_CONFIRM_POLICY, DEFAULT_UPSTREAM_VERSION_POLICY, type Config, type ConfirmPolicy, type UpstreamVersionPolicy } from './config.ts'
import { generateDocument, getDocService, parseUpstreamArtifacts, summarizeArtifact, writeAtomic } from './doc-service.ts'
import { buildExtractionFile, extractionFilePath, extractableParams, processProposals, readExtractionFile, verifyExtraction, writeExtractionFile } from './extract.ts'
import { materialAnchors, readMaterialEntries } from './materials.ts'
import { createLlmPort } from './llm-port.ts'
import { installPack, installSuite, marketUrlOf } from './pack-manage.ts'
import { fetchInstallPlan, fetchSuiteInstallPlan, searchMarket } from './market-search.ts'
import { previewParams, resolveEffectiveParams, type ExtractionView, type ParamDrift, type ParamRow } from './params.ts'
import type { Pack } from './pack.ts'
import { effectiveWorkspaceRoot, normalizeWindowsPath, resolveRootWithin, type SessionWorkspaceCarrier } from './paths.ts'
import { overlayWorkspaceTier, applyDisabled, resolvePacksDir } from './pack-sources.ts'
import { readSuiteRecord } from './pack-manage.ts'
import type { ShadowedCopy } from './pack-loader.ts'
import { artifactHashOf, type MaterialAnchor, type Receipt, type UpstreamAnchor } from './receipt.ts'
import { severityCounts } from './issue.ts'

/**
 * Model-facing tools. `doc_generate` walks the closed loop; `doc_validate`
 * re-runs the pack ruleset over a stored artifact and compares its canonical
 * hash with the sidecar receipt — tamper-evident replay of the all-green
 * state. `hashMatches: null` means no sidecar receipt exists (e.g. the
 * bundled golden sample). Both tools surface pack-version staleness: a
 * receipt written by another pack version certifies the OLD ruleset, so
 * doc_validate flags it (`packVersionStale`) and chained consumption is
 * governed by the `upstreamVersionPolicy` config.
 */

export interface ToolDeps {
  readonly packs: ReadonlyMap<string, Pack>
  readonly config: Config
  readonly ctx: object & { llm?: unknown }
  /** The builtin packs root + loader, for the install lane's in-place reload (registerTools owns the values). */
  readonly builtinRoot?: string
  readonly loadPacks?: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
}

/** Suite-name expansion source: the local suites.json record at the install dir (design doc 启用与禁用). */
async function disabledMembersResolver(config: Config): Promise<(name: string) => readonly string[] | undefined> {
  const suites = await readSuiteRecord(resolvePacksDir(config.packsDir))
  return name => suites.find(s => s.name === name)?.members.map(m => m.name)
}

/**
 * Per-call pack view (docs/designs/pack-load-dirs.md): the apply-time tiers
 * (builtin/install/extra) overlaid with the workspace tier — loaded
 * dynamically per call, workspace packs shadow same-name copies — then the
 * disabled-name filter. Every tool that reads the pack map goes through this,
 * so workspace packs and disabled packs behave identically across
 * doc_packs/generate/validate/chain-status.
 */
async function packsForSession(
  deps: ToolDeps,
  exec: SessionWorkspaceCarrier | undefined,
): Promise<{ packs: ReadonlyMap<string, Pack>; shadowed: readonly ShadowedCopy[] }> {
  const workspaceRoot = effectiveWorkspaceRoot(exec, deps.config.workspaceRoot)
  const overlay = await overlayWorkspaceTier(
    deps.packs,
    workspaceRoot,
    deps.config.searchWorkspacePacksUpward === true,
    deps.config.packShadowPolicy ?? 'allow',
  )
  const packs = applyDisabled(overlay.packs, deps.config.disabledPacks, await disabledMembersResolver(deps.config))
  return { packs, shadowed: overlay.shadowed }
}

/**
 * Normalize a model-supplied params bag. Shape enforcement lives at the input
 * schema (`type: 'object'` — the runner rejects non-objects before the body
 * runs), so post-schema the value is a plain object or absent.
 */
function normalizeParams(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  // Clone: the engine injects derived params (topicNo) into this object, and
  // callers routinely share one literal across calls — mutating in place
  // would leak values between calls (a real cross-test leak).
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return { ...(raw as Record<string, unknown>) }
}

/** Resolve and lexically confine a user-supplied path to the workspace root. */
function confinePath(workspaceRoot: string, ref: string, what: string): string {
  const root = resolve(workspaceRoot)
  const abs = resolve(root, normalizeWindowsPath(ref))
  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith('../')) {
    throw new Error(`${what} path escapes the workspace root: ${ref} (root: ${root})`)
  }
  return abs
}

/** Conventional workspace-level artifact directory for workspace-scope packs (docs/designs/cosmic-context.md). */
const WORKSPACE_CONTEXT_DIR = 'context'

/** Single-segment directory name for the topic parameter. Unicode letters
 * (CJK included) and inner spaces are allowed — the topicNoPattern reads
 * only the leading work-item number, the rest is free description. Path
 * safety stays absolute: no separators, no leading dot, no `..`, trimmed,
 * bounded length. */
function assertTopicName(topic: string): string {
  const trimmed = topic.trim()
  if (
    trimmed === '' || trimmed !== topic || trimmed === '.' || trimmed === '..' || trimmed.includes('..')
    || /[/\\\0]/.test(trimmed) || /\s/.test(trimmed[0]!) || trimmed.length > 120
    || !/^[\p{L}\p{N}][\p{L}\p{N} ._\-]*$/u.test(trimmed)
  ) {
    throw new Error(`topic must be a single directory name: no path separators, no leading/trailing space or dot, no '..'; unicode letters and inner spaces allowed (1-120 chars); got ${JSON.stringify(topic)}`)
  }
  return trimmed
}

/**
 * Per-call material/output roots (docs/designs/cosmic-context.md, scopes):
 * workspace-scope packs ignore the topic and fix their homes (materials
 * `references/`, artifacts `context/`); a topic argument relocates both roots
 * under `<workspace>/<topic>/`; otherwise the configured roots apply unchanged.
 * Topic-scope packs resolve material refs against `<topic>/<dir>/` FIRST, then
 * the workspace-level `<workspace>/<dir>/` of the same name — a topic's own
 * input shadows the shared one (dir: manifest materialsRoot, default
 * config materialsRoot).
 */
function resolveScopedRoots(
  workspaceRoot: string,
  config: Config,
  pack: Pack,
  topic: string | undefined,
): { materialsRoots: readonly string[]; outputRoot: string } {
  const spec = pack.manifest.materialsRoot ?? config.materialsRoot
  if (pack.manifest.scope === 'workspace') {
    return {
      materialsRoots: [resolveRootWithin(workspaceRoot, spec, 'materialsRoot')],
      outputRoot: resolveRootWithin(workspaceRoot, WORKSPACE_CONTEXT_DIR, 'outputRoot'),
    }
  }
  if (topic !== undefined && topic.length > 0) {
    const topicRoot = confinePath(workspaceRoot, assertTopicName(topic), 'topic')
    return {
      materialsRoots: [
        resolveRootWithin(topicRoot, spec, 'materialsRoot'),
        resolveRootWithin(workspaceRoot, spec, 'materialsRoot'),
      ],
      outputRoot: resolveRootWithin(topicRoot, config.outputRoot, 'outputRoot'),
    }
  }
  return {
    materialsRoots: [resolveRootWithin(workspaceRoot, spec, 'materialsRoot')],
    outputRoot: resolveRootWithin(workspaceRoot, config.outputRoot, 'outputRoot'),
  }
}

function resolvePack(deps: ToolDeps, name: string, packs: ReadonlyMap<string, Pack> = deps.packs): Pack {
  const pack = packs.get(name)
  if (pack === undefined) {
    const marketHint = deps.config.marketSearch !== false
      ? '; if none of them fits, search the pack market with doc_market_search before authoring a new pack'
      : ''
    throw new Error(`unknown pack "${name}"; discover installed packs via doc_packs (available: ${[...packs.keys()].sort().join(', ') || 'none installed'})${marketHint}`)
  }
  return pack
}

function resolveLanguage(deps: ToolDeps, pack: Pack, language?: string): string {
  const configured = deps.config.defaultLanguage
  const chosen = language !== undefined && language.length > 0
    ? language
    : configured !== undefined && configured.length > 0 ? configured : ''
  const final = chosen.length > 0 ? chosen : pack.manifest.languages[0] ?? ''
  if (final.length === 0) throw new Error('no language available: set the tool language or config defaultLanguage')
  if (!pack.manifest.languages.includes(final)) {
    throw new Error(`pack "${pack.manifest.name}" does not support language "${final}" (supported: ${pack.manifest.languages.join(', ')})`)
  }
  return final
}

function requireRoute(deps: ToolDeps): { provider: string; model: string } {
  const { provider, model } = deps.config
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    throw new Error('docwright config needs provider and model for doc_generate; set them in cordis.yml (cause: LLM route unset; fix: add provider+model to the docwright config block)')
  }
  return { provider, model }
}

export type GenerateToolResult = {
  readonly artifactPath: string
  readonly markdownPath: string
  readonly receipt: Receipt
  /** Best-effort artifact metrics (counts, totalCfps) — saves a file read. */
  readonly summary: ReturnType<typeof summarizeArtifact>
  /** true: a green, hash-intact artifact of this pack was reused; no generation ran (docs/designs/cosmic-context.md). */
  readonly reused?: boolean
  /** Present under upstreamVersionPolicy: "warn" when an upstream receipt records a different pack version. */
  readonly upstreamWarnings?: string[]
  /** Fan-out progress for per-function packs: this stage's green artifacts vs the reference function set. */
  readonly coverage?: CoverageProgress
  /** The resolved files the engine anchored this generation to (file entries
   * only; inline text is verbatim in the receipt). The authoritative input
   * set for any content verification — under dual materials roots the
   * topic-level file wins, and a session-cwd pre-read of the same ref can
   * easily have read the shared one instead (real-session finding). */
  readonly materials?: { ref: string; path: string }[]
}

/** Fan-out coverage of one stage (docs/designs/params-and-chain-contract.md). */
export type CoverageProgress = {
  readonly covered: number
  readonly total: number
  readonly missing: string[]
}

/** One selectable function of the upstream plan (or the chain's current function). */
export type FunctionCandidate = {
  readonly index: number
  readonly funcId: string
  readonly l2Name?: string
}

/**
 * Confirmation gate result (docs/designs/params-and-chain-contract.md): the
 * effective param table to present to the user before executing. Zero LLM
 * cost — the call is refused before any route/model work until the caller
 * re-invokes with confirm: true.
 */
export type PendingConfirmationResult = {
  readonly pendingConfirmation: true
  readonly pack: string
  readonly language: string
  readonly paramTable: ParamRow[]
  readonly missingRequired: string[]
  /** Selectable functions when targetIndex is among the missing required params. */
  readonly candidates?: FunctionCandidate[]
  readonly paramDrift?: ParamDrift[]
  readonly driftImpact?: string
  readonly hint: string
}

/** doc_generate returns either the generation result or the confirmation gate. */
export type DocGenerateResult = GenerateToolResult | PendingConfirmationResult

export type ValidateToolResult = {
  readonly artifactPath: string
  readonly receipt: Receipt
  /** true: hash matches sidecar; false: artifact changed after generation; null: no sidecar receipt. */
  readonly hashMatches: boolean | null
  /** true: sidecar receipt records another pack version (stale — regenerate); false: versions match; null: no sidecar receipt. */
  readonly packVersionStale: boolean | null
  /** true: the green re-validation re-issued the sidecar receipt (seal) so downstream consumption can proceed. */
  readonly sealed?: boolean
  /** Best-effort artifact metrics (counts, totalCfps). */
  readonly summary: ReturnType<typeof summarizeArtifact>
}

/**
 * Pull-based capability discovery: the model calls this before doc_generate
 * to learn which packs are installed and pick the right one. Tool descriptions
 * stay static — the registry lives here, not in copy (docs/designs/capability-discovery.md).
 */
export function defineDocPacksTool(deps: ToolDeps) {
  return defineTool({
    name: 'doc_packs',
    description: 'List installed document packs: name, one-line description, supported languages, and consumed upstream types, plus the deployment\'s effective confirmation-gate policy (confirmPolicy — the boundary you must respect; interaction style beyond it is yours to read from the user\'s pace) and whether pack-market search is enabled (marketSearch). '
      + 'Call this before doc_generate to pick the right pack for the document the user wants. '
      + 'If no installed pack fits the document type the user needs — including requests phrased as "make/create a document-generation skill" — search the pack market with doc_market_search (when marketSearch is on; the result carries the install command) before falling back to loading the docwright-pack-authoring skill to author a new pack (the how-to guide ships with this plugin).',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args: Record<string, never>, exec?: SessionWorkspaceCarrier) {
      const { packs, shadowed } = await packsForSession(deps, exec)
      return {
        confirmPolicy: deps.config.confirmPolicy ?? DEFAULT_CONFIRM_POLICY,
        marketSearch: deps.config.marketSearch !== false,
        packs: [...packs.values()].map(p => ({
        name: p.manifest.name,
        version: p.manifest.version,
        // Model face projects `en` regardless of UI locale: prompt material
        // must be stable across surfaces (description.ts).
        description: resolveLocalized(p.manifest.description, 'en'),
        languages: [...p.manifest.languages],
        consumes: [...p.manifest.consumes],
        // Which tier the pack came from (docs/designs/pack-load-dirs.md, P3):
        // builtin / packsDir / extraPacksDir / workspace — answers "which
        // copy is active" whenever several tiers carry the same name.
        origin: p.origin.kind,
        ...(p.origin.kind === 'workspace' && p.origin.depth !== undefined && p.origin.depth > 0
          ? { workspaceDepth: p.origin.depth }
          : {}),
        params: Object.entries(p.manifest.params ?? {}).map(([name, spec]) => ({
          name,
          type: spec.type,
          description: resolveLocalized(spec.description, 'en'),
          ...(spec.default !== undefined ? { default: spec.default } : {}),
          required: spec.required === true,
          confirm: spec.confirm === true,
          overridable: spec.overridable === true,
          extractable: spec.extractable === true,
        })),
      })),
      // Shadowed copies: same-name losers from earlier tiers, so a user can
      // always tell which copy actually governs.
      ...(shadowed.length > 0 ? { shadowed: shadowed.map(copy => ({
        name: copy.name,
        shadowedOrigin: copy.origin.kind,
        shadowedVersion: copy.version,
        shadowedDir: copy.dir,
        activeOrigin: copy.activeOrigin.kind,
        activeVersion: copy.activeVersion,
      })) } : {}),
      }
    },
  })
}

/** Layer-3 capability discovery: when no installed pack serves the document
 * the user needs, the model searches the pack market before falling back to
 * pack authoring. The MODEL composes the keyword terms (it reads the
 * intent); the market does traditional keyword matching — no vectors at
 * catalog scale. Registered only when the deployment enables market search
 * (Config.marketSearch); the description stays static either way — the
 * tool's absence is the false signal. */
export function defineMarketSearchTool(deps: ToolDeps) {
  return defineTool({
    name: 'doc_market_search',
    description: 'Search the docwright pack market for document packs by keyword. Use it when the user asks for a document type the installed packs cannot serve (doc_packs found no fit): compose the terms from the user\'s intent — domain words and document genre ("COSMIC function point estimation", "meeting minutes", "resume") — never guessed pack names. Returns per hit: name, one-line description, version, languages, consumed upstream types, and the suites the pack belongs to. Packs that BELONG to a suite are NOT listed on the market — the SUITE card represents them (members list included; a member-name query lands on its suite card): when the user wants the whole set, install it with doc_market_install { "suite": "<name>" }. To act on a hit, install it with doc_market_install (the user confirms first; the pack is usable in this session right after) — never fabricate a local pack from a search hit.',
    parameters: {
      query: { type: 'string', required: true, description: 'Free-text keywords, whitespace-separated; ALL terms must match. Compose from document genre and domain words; English matches best (descriptions are matched in en and zh)' },
      limit: { type: 'number', description: 'Max hits to return (default 20, cap 50)' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { query: string; limit?: number }) {
      return searchMarket({ marketUrl: marketUrlOf(deps.config), packsDir: deps.config.packsDir }, args.query, args.limit)
    },
  })
}

/** The install half of market discovery: lands a market pack — or a whole
 * market SUITE (docs/designs/pack-suites.md) — into the packsDir behind the
 * SAME confirmation grammar as doc_generate — the first call (no confirm)
 * returns a pendingConfirmation table the model presents; the user's approval
 * is the second call with confirm: true. The install hot-reloads the pack map
 * in place, so the packs are usable in THIS session immediately — no restart,
 * no new session. */
export function defineMarketInstallTool(deps: ToolDeps) {
  return defineTool({
    name: 'doc_market_install',
    description: 'Install a pack from the docwright pack market into the deployment\'s packsDir. Use it when the user asks to install/add/fetch a pack by name or need ("帮我安装 cosmic-context", "install the resume pack"), and for doc_market_search hits. A whole SUITE installs with { "suite": "<name>" } (mutually exclusive with pack): every member pack plus their consumed upstreams lands in one confirmed call. Packs that BELONG to a suite cannot be installed, updated, or deleted on their own — install the suite instead (search cards show the suites field). CONFIRMATION GATE: call without confirm first — the result is a pendingConfirmation table (pack/suite, versions, source market, target packsDir); present it to the user and only re-call with confirm: true after they approve (never self-confirm). The install verifies the tarball against the market index (sha256 + manifest name + content hash), lands atomically, and hot-reloads the pack map — doc_packs lists the packs in THIS session right after, no restart needed. Installing an already-installed pack name updates it in place; members already current are skipped.',
    parameters: {
      pack: { type: 'string', description: 'Pack name exactly as doc_market_search reported it (mutually exclusive with suite)' },
      suite: { type: 'string', description: 'Suite name exactly as doc_market_search reported it — installs EVERY member pack plus their consumed upstreams (mutually exclusive with pack)' },
      confirm: { type: 'boolean', description: 'Set true only after the user approved the pendingConfirmation table' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { pack?: string; suite?: string; confirm?: boolean }) {
      if (deps.builtinRoot === undefined || deps.loadPacks === undefined) {
        throw new Error('doc_market_install requires the plugin wiring (builtinRoot/loadPacks); nothing was written')
      }
      if ((args.pack === undefined) === (args.suite === undefined)) {
        throw new Error('doc_market_install takes exactly one of pack or suite (pass "pack": "<name>" for one pack, or "suite": "<name>" for every member pack of a suite); nothing was written')
      }
      const laneDeps = {
        packs: deps.packs as Map<string, Pack>,
        builtinRoot: deps.builtinRoot,
        packsDir: deps.config.packsDir,
        marketUrl: marketUrlOf(deps.config),
        loadPacks: deps.loadPacks,
      }
      const suite = args.suite
      if (args.confirm !== true) {
        // The pending table reads the market index (and the suite detail) so
        // the user approves a CONCRETE plan: for a pack, its consumes closure;
        // for a suite, every member plus the upstreams members pull in —
        // suite MEMBERS and consumed upstreams are labeled differently. An
        // unreachable market or an absent member surfaces here, before
        // anything is asked or written.
        const plan = suite !== undefined
          ? await fetchSuiteInstallPlan(laneDeps.marketUrl, suite)
          : await fetchInstallPlan(laneDeps.marketUrl, args.pack!)
        const rows: string[] = plan.members.map(m => `${m.name}@${m.version}${m.requested ? (suite !== undefined ? ' (suite member)' : ' (requested)') : ' (consumed upstream)'}`)
        const table: Record<string, string | string[]> = {
          ...(suite !== undefined ? { requestedSuite: suite } : { requested: args.pack! }),
          sourceMarket: laneDeps.marketUrl,
          target: deps.config.packsDir !== undefined && deps.config.packsDir.length > 0 ? deps.config.packsDir : '(no packsDir configured — set config.packsDir first)',
          installs: rows,
        }
        return {
          status: 'pendingConfirmation',
          table,
          note: 'Present this table to the user; re-call with confirm: true after they approve.',
        }
      }
      const { installed } = suite !== undefined
        ? await installSuite(laneDeps, suite)
        : await installPack(laneDeps, args.pack!)
      const unchanged = installed.filter(o => o.unchanged)
      return {
        status: 'installed',
        ...(suite !== undefined ? { suite } : { pack: args.pack! }),
        installed: installed.map(o => `${o.name}@${o.version}${o.unchanged ? ' (already current)' : o.existed ? ' (updated in place)' : ''}`),
        ...(unchanged.length === installed.length ? { note: 'everything already current; nothing was downloaded' } : {}),
        sessionNote: 'the packs are usable in this session immediately (doc_packs lists them now)',
      }
    },
  })
}

/** Merged inheritance base from the upstream receipts' as-run params. */
function mergeUpstreamParams(records: readonly { params: Record<string, unknown> | undefined }[]): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {}
  for (const record of records) {
    if (record.params !== undefined) Object.assign(merged, record.params)
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function shortValue(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

/**
 * Deterministic revalidation of the upstream artifacts under drifted param
 * values (paramDriftPolicy "revalidate"): each upstream artifact is checked
 * by its OWN pack service with the drifted values intersected to that pack's
 * declared params. Returns human-readable failures; [] means all green.
 */
function revalidateUpstreamUnderParams(
  records: readonly { pack: string; language: string | undefined; params: Record<string, unknown> | undefined; artifact: unknown }[],
  packs: ReadonlyMap<string, Pack>,
  overrides: Readonly<Record<string, unknown>>,
): string[] {
  const failures: string[] = []
  for (const record of records) {
    // verifyUpstreamReceipts already rejected records whose pack is not installed.
    const upstreamPack = packs.get(record.pack)!
    const declared = Object.keys(upstreamPack.manifest.params ?? {})
    const picked = Object.fromEntries(Object.entries(overrides).filter(([name]) => declared.includes(name)))
    let effective: Record<string, unknown>
    try {
      // Drifted values on top of the receipt-recorded as-run params: the
      // artifact is re-checked under the chain's own baseline plus the drift.
      effective = resolveEffectiveParams(upstreamPack, picked, record.params)
    } catch (error) {
      failures.push(`${record.pack}: ${(error as Error).message}`)
      continue
    }
    const language = record.language !== undefined && upstreamPack.manifest.languages.includes(record.language)
      ? record.language
      : upstreamPack.manifest.languages[0]!
    const issues = getDocService(upstreamPack, language).validate(record.artifact, effective, undefined)
    const errorRules = [...new Set(issues.filter(i => i.severity === 'error').map(i => i.ruleId))]
    if (errorRules.length > 0) failures.push(`${record.pack}: ${errorRules.join(', ')}`)
  }
  return failures
}

const CONFIRM_HINT = 'Present the paramTable to the user (values, sources, missing required entries, drift impact); then re-call with the same arguments plus confirm: true to execute.'

/**
 * Selectable functions of the fan-out: a plan-shaped upstream lists its
 * functions; a single-function upstream (req/func stage) contributes itself.
 * Drives the targetIndex candidate list and the per-function artifact naming
 * (docs/designs/params-and-chain-contract.md, fan-out contract).
 */
function planCandidates(records: readonly { artifact: unknown }[]): FunctionCandidate[] {
  for (const record of records) {
    const artifact = record.artifact as { functions?: unknown } | null
    if (artifact !== null && typeof artifact === 'object' && Array.isArray(artifact.functions)) {
      const out: FunctionCandidate[] = []
      for (const [i, fn] of (artifact.functions as unknown[]).entries()) {
        const funcId = (fn as { funcId?: unknown } | null)?.funcId
        if (typeof funcId !== 'string') continue
        const l2Name = (fn as { l2Name?: unknown } | null)?.l2Name
        out.push({ index: i + 1, funcId, ...(typeof l2Name === 'string' && l2Name !== '' ? { l2Name } : {}) })
      }
      return out
    }
  }
  const first = records[0]?.artifact as { index?: unknown; funcId?: unknown } | null
  if (first !== null && typeof first === 'object' && typeof first.funcId === 'string' && typeof first.index === 'number') {
    return [{ index: first.index, funcId: first.funcId }]
  }
  return []
}

/** Order-insensitive multiset equality of two upstream anchor lists. */
function sameAnchors(a: readonly UpstreamAnchor[] | undefined, b: readonly UpstreamAnchor[] | undefined): boolean {
  const key = (list: readonly UpstreamAnchor[] | undefined) => JSON.stringify(
    [...(list ?? [])].sort((x, y) => (x.pack < y.pack ? -1 : x.pack > y.pack ? 1 : x.artifactHash < y.artifactHash ? -1 : x.artifactHash > y.artifactHash ? 1 : 0)),
  )
  return key(a) === key(b)
}

/**
 * Reuse pre-check (docs/designs/cosmic-context.md): a pack declaring reuse
 * skips generation when its output root already holds an artifact of the same
 * pack whose sidecar receipt is green, whose canonical hash still matches
 * the file (staleness reconciliation — no LLM re-validation), whose materials
 * manifest equals this call's resolved ref+hash anchors (input freshness: a
 * changed, added, or dropped material forces regeneration), whose upstream
 * anchors equal this call's verified anchors (a regenerated upstream forces
 * downstream regeneration), and — when the call addresses a deterministic
 * artifact name (explicit, engine-named, or prefix-derived) — which is THAT
 * artifact (fan-out addressing: targetIndex 2 must never reuse function 1's
 * file; only timestamp-default calls scan name-agnostically). A receipt from
 * another installed pack version certifies the OLD ruleset and never reuses,
 * nor does a legacy receipt without a materials manifest; a red receipt or an
 * edited artifact falls through to normal generation. Verified extraction
 * values must equal the receipt's as-run params too — a re-extraction with a
 * different value is an input change (same tier as explicit params), so the
 * artifact is rebuilt and the new value reaches the confirmation gate.
 */
async function findReusableArtifact(
  outputRoot: string,
  pack: Pack,
  materialAnchors: readonly MaterialAnchor[],
  expectedName?: string | undefined,
  upstreamAnchors?: readonly UpstreamAnchor[] | undefined,
  extracted?: ExtractionView | undefined,
): Promise<{ artifactPath: string; markdownPath: string; receipt: Receipt; summary: ReturnType<typeof summarizeArtifact> } | undefined> {
  let entries
  try {
    entries = await readdir(outputRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const expectedFile = expectedName === undefined ? undefined : `${expectedName}.json`
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.receipt.json')) continue
    if (expectedFile !== undefined && entry.name !== expectedFile) continue
    const base = entry.name.slice(0, -'.json'.length)
    try {
      const receipt = JSON.parse(await readFile(join(outputRoot, `${base}.receipt.json`), 'utf8')) as Partial<Receipt>
      if (receipt.pack !== pack.manifest.name || receipt.isValid !== true) continue
      if ((receipt.packVersion ?? '') !== pack.manifest.version) continue
      // Input freshness: the receipt must carry a materials manifest (legacy
      // receipts certify unknown inputs) and it must equal this call's
      // canonical anchors element-wise (both sides sorted the same way).
      if (JSON.stringify(receipt.materials) !== JSON.stringify(materialAnchors)) continue
      // Upstream freshness (chained packs): a regenerated upstream changes
      // its hash and invalidates every downstream reuse.
      if (!sameAnchors(receipt.upstreamHashes, upstreamAnchors)) continue
      // Extraction freshness: the receipt's as-run value must match the
      // current proven extraction (a re-extracted different value rebuilds).
      if (extracted !== undefined && Object.entries(extracted.values).some(([name, v]) => stableStringify((receipt.params as Record<string, unknown> | undefined)?.[name]) !== stableStringify(v.value))) continue
      const artifact: unknown = JSON.parse(await readFile(join(outputRoot, entry.name), 'utf8'))
      if (receipt.artifactHash !== artifactHashOf(artifact)) continue
      return {
        artifactPath: join(outputRoot, entry.name),
        markdownPath: join(outputRoot, `${base}.md`),
        receipt: receipt as Receipt,
        summary: summarizeArtifact(artifact),
      }
    } catch {
      continue
    }
  }
  return undefined
}

/** Green sidecar-receipted artifacts of one pack in the output root: funcId → artifact basename. */
async function scanStageArtifacts(outputRoot: string, packName: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  // The output root always exists here (it holds the plan or was just written
  // by doc_generate); a vanished directory is a real anomaly and fails loud.
  const entries = await readdir(outputRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.receipt.json')) continue
    const base = entry.name.slice(0, -'.json'.length)
    try {
      const receipt = JSON.parse(await readFile(join(outputRoot, `${base}.receipt.json`), 'utf8')) as { pack?: unknown; isValid?: unknown }
      if (receipt.pack !== packName || receipt.isValid !== true) continue
      const artifact = JSON.parse(await readFile(join(outputRoot, entry.name), 'utf8')) as { funcId?: unknown }
      if (typeof artifact.funcId === 'string') out.set(artifact.funcId, base)
    } catch {
      continue
    }
  }
  return out
}

/** Fan-out progress for a per-function pack relative to its reference function set (plan functions, or the upstream stage's covered set). */
async function coverageProgress(
  pack: Pack,
  records: readonly { pack: string; artifact: unknown }[],
  outputRoot: string,
): Promise<CoverageProgress | undefined> {
  if (pack.manifest.params?.targetIndex === undefined || records.length === 0) return undefined
  const covered = await scanStageArtifacts(outputRoot, pack.manifest.name)
  const planLike = records.find(r => {
    const artifact = r.artifact as { functions?: unknown } | null
    return artifact !== null && typeof artifact === 'object' && Array.isArray(artifact.functions)
  })
  let total: string[]
  if (planLike !== undefined) {
    total = ((planLike.artifact as { functions: unknown }).functions as unknown[])
      .map(fn => (fn as { funcId?: unknown } | null)?.funcId)
      .filter((id): id is string => typeof id === 'string')
  } else {
    total = [...(await scanStageArtifacts(outputRoot, records[0]!.pack)).keys()]
  }
  const missing = total.filter(id => !covered.has(id))
  return { covered: total.length - missing.length, total: total.length, missing }
}

/** Stable JSON text: key order must not distinguish "changed" from "re-passed". */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Per-call override of the config-level confirmation-gate policy; unknown values fail loud. */
function resolveConfirmPolicy(override: unknown, configValue: ConfirmPolicy | undefined): ConfirmPolicy {
  const value = override ?? configValue ?? DEFAULT_CONFIRM_POLICY
  if (value !== 'none' && value !== 'standard' && value !== 'strict') {
    throw new Error(`confirmPolicy must be "none", "standard" or "strict" (got ${JSON.stringify(value)})`)
  }
  return value
}

export function defineDocGenerateTool(deps: ToolDeps) {
  return defineTool({
    name: 'doc_generate',
    description: 'Generate a structured document via the pack\'s closed loop (generate → validate → repair until green). '
      + 'Call doc_packs first to see which packs are installed, then pass its name as pack. '
      + 'Returns artifactPath, markdownPath, and the validation receipt. '
      + 'Materials are paths relative to the active materials dir or inline text starting with "#!inline". The two dirs mean different things: references/ holds project reference knowledge (system architecture, module map, numbering conventions — workspace analysis packs read it), while input/ holds the user\'s per-work-item document (e.g. the requirement analysis brief); topic-scoped packs resolve refs against <topic>/<dir>/ first, then the workspace-level <workspace>/<dir>/. '
      + 'The result carries `materials` — the resolved absolute paths the engine anchored: treat it as the authoritative input set and verify content against THOSE files, never against your own pre-reads (under dual materials roots a session-cwd read of the same ref hits the shared dir, not the topic one that won). '
      + 'Artifacts land under the output root — <topic>/output/ when topic is given (topic-scoped packs REQUIRE topic: one work item, one topic directory — e.g. a requirement analysis, a functional design, and a technical design for the same work item share one topic), <workspace>/output/ otherwise; '
      + 'reuse: a green, unchanged artifact of a reuse pack that was generated from exactly this call\'s inputs (same materials manifest — refs and content hashes — and, for chained packs, hash-matching upstream anchors and the same addressed artifact name) is returned as-is (reused: true, zero LLM); a changed or added/dropped material, a regenerated upstream, an edited artifact, an explicit non-addressing param, or force: true rebuilds it. '
      + 'Pack-declared tunables can be overridden via params; required params (no default) must be provided. '
      + 'Packs marking params extractable (see doc_packs): run doc_extract_params on the materials FIRST — extracted values carry a verbatim material quote as provenance (confirmation-table source "extracted"); a required param the materials do not state must be asked from the user, never assumed. '
      + 'Passing params that change the upstream-recorded values — or generating a pack with confirm-flagged params whose values are not yet confirmed upstream — returns a pendingConfirmation param table first: present it to the user for approval, then re-call with confirm: true (do not self-confirm a gate the user has not seen; re-passing values identical to the upstream receipt counts as inheritance and does not gate). '
      + 'maxRounds caps this call\'s loop rounds.',
    parameters: {
      pack: { type: 'string', required: true, description: 'Pack name; discover installed packs with doc_packs (e.g. cosmic-plan)' },
      materials: { type: 'array', items: { type: 'string' }, description: 'Material references: paths relative to the active materials dir (references/ for reference knowledge, input/ for the user\'s per-work-item document — packs declare which; topic-level dir wins over the workspace-level one) or #!inline text. Optional for chained packs whose upstream artifacts carry the context' },
      language: { type: 'string', description: 'Output language (default: config defaultLanguage)' },
      upstream: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths to upstream artifacts for chained packs; each must carry a green sidecar receipt (hash-verified, and recording the installed pack version unless config upstreamVersionPolicy is "warn"). Extra green artifacts of installed packs may ride along as context (e.g. the project context), but at least one consumed-type artifact is required' },
      artifactName: { type: 'string', description: 'Output base name, a plain filesystem basename (unicode letters allowed; no path separators, no leading dot; default: <pack>-<timestamp>); REFUSED on engine-named calls — packs declaring artifactPrefix + topicNoPattern name artifacts <PREFIX>-<topicNo> themselves' },
      topic: { type: 'string', description: 'Topic directory name — the work item\'s id plus a free description ("REQ-142 favorites" or "REQ-142-收藏夹"): relocates the output root to <topic>/output/ and the materials dir to <topic>/<materials-dir>/; REQUIRED by packs declaring requiresTopic (per-topic documents such as a requirement analysis, functional design, or technical design), ignored by workspace-scope packs. A topic entering the chain for the first time is confirm-flagged: the call returns a pendingConfirmation whose table leads with the topic row — present it to the user to confirm or correct (infer a sensible default from the inputs when the user did not name one), then re-call with confirm: true' },
      maxRounds: { type: 'number', description: 'Round cap for this call (e.g. when the user asks to try more rounds); clamped to config maxRoundsCeiling' },
      force: { type: 'boolean', description: 'Rebuild even when a reusable green artifact of this pack already exists (bypasses the reuse pre-check)' },
      params: { type: 'object', additionalProperties: true, description: 'Overrides for pack-declared tunables (discovered via doc_packs), e.g. {"cfpTotal": {"value": 100, "downFactor": 0.9, "upFactor": 1.2}}; unknown names, out-of-range values, and missing required params fail loud; explicit params always trigger the confirmation gate; NEVER pass "topicNoPattern" (pack-declared naming convention — refused)' },
      confirm: { type: 'boolean', description: 'Execute after the pendingConfirmation param table was presented to and approved by the user' },
      confirmPolicy: { type: 'string', description: 'Per-call confirmation-gate policy overriding config confirmPolicy: "none" never gates (headless/CI; required params still fail loud), "standard" gates on param changes or unconfirmed confirm-params (default), "strict" gates every call that has a param table to show. '
        + 'Read the user\'s pace per request instead of fixing a style: "just generate it / don\'t ask" → pass "none" for that call (or under "standard" state inferred topic rows inline and confirm); "step by step / let me check each one" → "strict"; no stated pace → omit this arg and follow the deployment default (doc_packs reports it). The config value is a deployment boundary (CI/headless sets "none"; a strict org pins "strict") — never override it upward without the user asking for more interaction' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { pack: string; materials?: unknown[]; language?: string; upstream?: unknown[]; artifactName?: string; topic?: string; maxRounds?: number; force?: boolean; params?: unknown; confirm?: boolean; confirmPolicy?: unknown }, exec) {
      const sessionPacks = await packsForSession(deps, exec as SessionWorkspaceCarrier | undefined)
      const pack = resolvePack(deps, args.pack, sessionPacks.packs)
      const language = resolveLanguage(deps, pack, args.language)
      const materials = (args.materials as string[] | undefined) ?? []
      const upstream = args.upstream as string[] | undefined
      const workspaceRoot = effectiveWorkspaceRoot(exec as SessionWorkspaceCarrier | undefined, deps.config.workspaceRoot)
      const { materialsRoots, outputRoot } = resolveScopedRoots(workspaceRoot, deps.config, pack, args.topic)
      // Topic-scoped packs refuse to generate without a topic
      // (docs/designs/cosmic-context.md): one work item, one topic
      // directory, so chain paths and coverage scans key off it.
      if (pack.manifest.requiresTopic === true && (args.topic === undefined || args.topic.length === 0)) {
        throw new Error(`pack "${pack.manifest.name}" scopes its artifacts to one topic: pass topic (a single directory name, e.g. "REQ-142 favorites") — artifacts land under <topic>/output/ and upstream/doc_chain_status paths key off it`)
      }
      let upstreamTexts: string[] | undefined
      let upstreamAnchors: UpstreamAnchor[] | undefined
      let upstreamWarnings: readonly string[] | undefined
      let upstreamRecords: readonly { pack: string; language: string | undefined; params: Record<string, unknown> | undefined; artifact: unknown }[] = []
      if (pack.manifest.consumes.length > 0) {
        if (upstream === undefined || upstream.length === 0) {
          throw new Error(`pack "${pack.manifest.name}" consumes upstream artifacts [${pack.manifest.consumes.join(', ')}]; pass their workspace paths via the upstream parameter`)
        }
        const policy = deps.config.upstreamVersionPolicy ?? DEFAULT_UPSTREAM_VERSION_POLICY
        const verified = await verifyUpstreamReceipts(workspaceRoot, upstream, pack, sessionPacks.packs, policy)
        upstreamTexts = verified.texts
        upstreamAnchors = verified.anchors
        upstreamWarnings = verified.warnings.length > 0 ? verified.warnings : undefined
        upstreamRecords = verified.records
      }
      // Confirmation gate (docs/designs/params-and-chain-contract.md): zero
      // LLM cost — resolved before the route check. Explicit params always
      // gate; confirm-flagged params gate until confirmed at the chain head,
      // after which downstream stages inherit the recorded values. Params and
      // naming resolve BEFORE the reuse pre-check, so a chained reuse hit can
      // verify the receipt's upstream anchors and the addressed artifact name.
      let overrides = normalizeParams(args.params)
      const paramsProvided = overrides !== undefined && Object.keys(overrides).length > 0
      const paramsBase = mergeUpstreamParams(upstreamRecords)
      // topicNoPattern is a pack-declared naming convention, never a caller
      // value: a caller override lands in addressingParams (required, not
      // confirm) so it bypasses the gate, and a pattern that fails to match
      // the topic silently degrades engine naming to timestamps (real
      // session: the model passed a Latin-only pattern for a CJK topic).
      // Same class of footgun as fan-out hand-naming, which also fails loud.
      if (overrides?.topicNoPattern !== undefined) {
        throw new Error('doc_generate: params must not include "topicNoPattern" — it is a pack-declared naming convention (manifest), not a caller value, and an override that fails to match the topic silently degrades engine naming to timestamps; fix: drop it from params and let the pack default (or receipt inheritance) supply the pattern')
      }
      // Derived param topicNo: extracted from the topic name via the pack's
      // topicNoPattern (explicit params.topicNo wins; the inherited value
      // also wins — downstream stages re-extract identically anyway).
      // Topic-scope packs only: a workspace-scope pack ignores topic (its
      // artifact is shared across topics), so it must not record one topic's
      // number into a shared receipt. When absent (no topic or no match) the
      // numbering rule skips and naming falls back to <pack>-<funcId>.
      if (typeof args.topic === 'string' && pack.manifest.scope !== 'workspace' && pack.manifest.params?.topicNoPattern !== undefined && overrides?.topicNo === undefined && paramsBase?.topicNo === undefined) {
        const pattern = overrides?.topicNoPattern ?? paramsBase?.topicNoPattern ?? pack.manifest.params.topicNoPattern.default
        try {
          const m = typeof pattern === 'string' ? args.topic.match(new RegExp(pattern, 'u')) : undefined
          if (m) (overrides ??= {}).topicNo = m[1] ?? m[0]
        } catch (error) {
          throw new Error(`topicNoPattern is not a valid regex: ${(error as Error).message}`)
        }
      }
      // Fan-out naming: a per-function call is ENGINE-named `<pack>-<funcId>`
      // from the upstream plan — distinct functions never collide and
      // regeneration is idempotent. An explicit artifactName on a
      // per-function call fails loud: in a real session hand-picked names
      // collided (two req artifacts shared one file and a function's output
      // was silently overwritten). Non-per-function defaults keep the
      // timestamp form — the reuse scan stays name-agnostic there.
      const targetIndex = (overrides?.targetIndex ?? paramsBase?.targetIndex)
      const target = typeof targetIndex === 'number' ? planCandidates(upstreamRecords).find(c => c.index === targetIndex) : undefined
      const topicNo = overrides?.topicNo ?? paramsBase?.topicNo
      if (pack.manifest.artifactPrefix !== undefined && args.artifactName !== undefined && (target !== undefined || typeof topicNo === 'string')) {
        throw new Error(`pack "${pack.manifest.name}" is engine-named (artifactPrefix "${pack.manifest.artifactPrefix}"): omit artifactName${target !== undefined ? ` — this artifact is ${pack.manifest.artifactPrefix}-${topicNo ?? '<topicNo>'}-${String(targetIndex).padStart(2, '0')}` : ` — this artifact is ${pack.manifest.artifactPrefix}-${topicNo ?? '<topicNo>'}`}`)
      }
      const deterministicName = target !== undefined
        ? (typeof pack.manifest.artifactPrefix === 'string' && typeof topicNo === 'string'
            ? `${pack.manifest.artifactPrefix}-${topicNo}-${String(target.index).padStart(2, '0')}`
            : `${pack.manifest.name}-${target.funcId}`)
        : args.artifactName ?? (typeof pack.manifest.artifactPrefix === 'string' && typeof topicNo === 'string'
            ? `${pack.manifest.artifactPrefix}-${topicNo}`
            : undefined)
      const artifactName = deterministicName ?? `${pack.manifest.name}-${Date.now()}`
      // Reuse pre-check (docs/designs/cosmic-context.md): a green, hash-intact
      // artifact of a reuse pack — generated from exactly this call's
      // materials (same canonical refs, same content hashes), the same
      // upstream anchors (a regenerated upstream forces downstream
      // regeneration), and addressed by the same deterministic name — is
      // returned as-is; force: true always rebuilds. Explicit non-addressing
      // params are a drift signal the anchor comparison cannot see, so they
      // skip reuse and let the normal path apply paramDriftPolicy. Materials
      // resolve first, so an unreadable ref fails loud even when a reusable
      // artifact exists (the caller explicitly named it). On a miss the files
      // are re-read inside generateDocument, which owns the receipt's
      // manifest — the double read keeps the service self-contained.
      const addressingParams = new Set(Object.entries(pack.manifest.params ?? {})
        .filter(([, spec]) => spec.required === true && spec.confirm !== true)
        .map(([name]) => name))
      const paramOverrideDrift = paramsProvided && overrides !== undefined
        && Object.keys(overrides).some(name => !addressingParams.has(name))
      // Materials resolve once here: anchors for the reuse pre-check and
      // texts for extraction-quote re-verification (generateDocument re-reads
      // for the receipt's manifest — the double read keeps the service
      // self-contained). An unreadable ref fails loud regardless of reuse.
      const materialEntries = await readMaterialEntries(materials, workspaceRoot, materialsRoots)
      const materialPaths = materialEntries
        .filter((entry): entry is typeof entry & { path: string } => entry.path !== undefined)
        .map(entry => ({ ref: entry.ref, path: entry.path }))
      const extractionFile = await readExtractionFile(extractionFilePath(outputRoot, pack.manifest.name))
      const extracted = extractionFile !== undefined ? verifyExtraction(pack, extractionFile, materialEntries) : { values: {}, notFound: {} }
      // A re-extracted value that differs from a reusable receipt's as-run
      // params is an input change the anchor comparison cannot see —
      // findReusableArtifact refuses such a match, so the new value reaches
      // the confirmation gate like any other param change.
      if (pack.manifest.reuse === true && args.force !== true && !paramOverrideDrift) {
        const reused = await findReusableArtifact(outputRoot, pack, materialAnchors(materialEntries), deterministicName, upstreamAnchors, extracted)
        if (reused !== undefined) return { ...reused, reused: true, materials: materialPaths } as unknown as DocGenerateResult
      }
      // Some input must exist: materials, or the upstream artifacts of a
      // chained pack (whose text already feeds the prompt).
      if (materials.length === 0 && upstreamTexts === undefined) {
        throw new Error('materials must not be empty: provide at least one material reference (a workspace file path or #!inline text), or pass upstream artifacts for chained packs')
      }
      const preview = previewParams(pack, overrides, paramsBase, extracted)
      const confirmNames = Object.entries(pack.manifest.params ?? {}).filter(([, spec]) => spec.confirm === true).map(([name]) => name)
      const satisfiedUpstream = confirmNames.length > 0 && paramsBase !== undefined && confirmNames.every(name => paramsBase[name] !== undefined)
      // Gate policy: the policy decides WHETHER the gate stands; discharging
      // it (presenting the table to the user) stays the caller's duty.
      // Explicit params that equal the upstream-recorded values are
      // inheritance, not a change; required non-confirm params (fan-out
      // addressing like targetIndex) are call routing and never gate
      // (docs/designs/params-and-chain-contract.md). Extracted values sit
      // BELOW the receipt base in the resolution order, so they never
      // override an inherited param — their change surface is the reuse
      // pre-check (receipt.params vs extraction) plus the chain-head gate.
      const policy = resolveConfirmPolicy(args.confirmPolicy, deps.config.confirmPolicy)
      const changedOverrides = paramsProvided && (paramsBase === undefined
        || Object.entries(overrides!).some(([name, value]) => !addressingParams.has(name) && stableStringify(paramsBase[name]) !== stableStringify(value)))
      // Topic confirmation: a topic entering the chain for the first time
      // (no upstream receipt records its topicNo yet) is confirm-flagged —
      // the caller's topic may be inferred from the requirement text rather
      // than named by the user, so the user signs off on it through the same
      // pendingConfirmation table as pack params. Once any upstream receipt
      // records topicNo, downstream stages inherit it and never re-gate.
      const topicRow: ParamRow | undefined = pack.manifest.requiresTopic === true
        && typeof args.topic === 'string' && args.topic.length > 0
        && paramsBase?.topicNo === undefined
        ? {
            name: 'topic', type: 'string', value: args.topic, source: 'explicit',
            required: true, confirm: true, overridable: false,
            description: 'Topic directory name establishing this document chain (inferred from the inputs if the user did not name it) — confirm it or correct it',
          }
        : undefined
      const gateHit = policy === 'strict'
        ? preview.rows.length > 0 || topicRow !== undefined
        : policy === 'standard' && (changedOverrides || (confirmNames.length > 0 && !satisfiedUpstream) || topicRow !== undefined)
      if (gateHit && args.confirm !== true) {
        let driftImpact: string | undefined
        if (preview.drift.length > 0) {
          const policy = pack.manifest.paramDriftPolicy ?? 'regenerate'
          if (policy === 'regenerate') {
            driftImpact = `paramDriftPolicy is "regenerate": confirming these params requires regenerating the upstream artifacts first; the call will be refused until then.`
          } else {
            const failures = revalidateUpstreamUnderParams(upstreamRecords, sessionPacks.packs, overrides ?? {})
            driftImpact = failures.length === 0
              ? 'paramDriftPolicy is "revalidate": upstream artifacts revalidated green under the new params; safe to continue.'
              : `paramDriftPolicy is "revalidate": upstream artifacts fail under the new params (${failures.join('; ')}); the call will be refused.`
          }
        }
        const driftFields = preview.drift.length > 0
          ? { paramDrift: [...preview.drift], ...(driftImpact === undefined ? {} : { driftImpact }) }
          : {}
        const candidateFields = preview.missingRequired.includes('targetIndex')
          ? { candidates: planCandidates(upstreamRecords) }
          : {}
        return {
          pendingConfirmation: true,
          pack: pack.manifest.name,
          language,
          paramTable: [...(topicRow !== undefined ? [topicRow] : []), ...preview.rows],
          missingRequired: [...preview.missingRequired],
          ...candidateFields,
          ...driftFields,
          hint: CONFIRM_HINT,
        } satisfies PendingConfirmationResult as unknown as DocGenerateResult
      }
      if (preview.missingRequired.length > 0) {
        const candidates = preview.missingRequired.includes('targetIndex') ? planCandidates(upstreamRecords) : []
        const listed = candidates.length > 0
          ? ` Candidates from the upstream plan: ${candidates.map(c => `${c.index}. ${c.funcId}${c.l2Name === undefined ? '' : ` (${c.l2Name})`}`).join('; ')}.`
          : ''
        // Extraction ran but found nothing quotable: say so per param and
        // surface the model's suggestion — the user may give the value or
        // explicitly endorse the suggestion (never auto-applied).
        const hints = preview.missingRequired.map(name => {
          const nf = extracted.notFound[name]
          if (nf?.suggestion === undefined) return name
          return `${name} (extraction found no quotable value in the materials; suggested ${shortValue(nf.suggestion)}${nf.rationale === undefined ? '' : ` — ${nf.rationale}`}; pass it via params to endorse)`
        })
        throw new Error(`missing required pack params for "${pack.manifest.name}": ${hints.join(', ')} (declared without defaults; cause: these values must come from the caller; fix: ask the user for the value(s) and pass them via params).${listed}`)
      }
      if (preview.drift.length > 0) {
        const policy = pack.manifest.paramDriftPolicy ?? 'regenerate'
        if (policy === 'regenerate') {
          const detail = preview.drift.map(d => `${d.name}: ${shortValue(d.from)} → ${shortValue(d.to)}`).join('; ')
          throw new Error(`params drift from the upstream receipts (${detail}); pack "${pack.manifest.name}" paramDriftPolicy is "regenerate" — regenerate the upstream artifacts under the new params first, then re-run this call`)
        }
        const failures = revalidateUpstreamUnderParams(upstreamRecords, sessionPacks.packs, overrides ?? {})
        if (failures.length > 0) {
          throw new Error(`upstream artifacts fail validation under the new params (${failures.join('; ')}); pack "${pack.manifest.name}" paramDriftPolicy is "revalidate" — regenerate the upstream under the new params or revert the param change`)
        }
      }
      const route = requireRoute(deps)
      const llm = createLlmPort(deps.ctx as never, route)
      const result = await generateDocument({
        pack,
        language,
        materials,
        materialsRoots,
        upstream: upstreamTexts,
        upstreamAnchors,
        maxRounds: args.maxRounds,
        params: overrides,
        paramsBase,
        extracted: Object.keys(extracted.values).length > 0 ? extracted : undefined,
        artifactName,
        workspaceRoot,
        outputRoot,
        config: deps.config,
        llm,
        signal: exec.signal,
        // Round data (incl. per-round prompt hash) lives in the receipt, which
        // rides the tool result content into the session log verbatim. A
        // dedicated session event type stays deferred: dsh has no write-side
        // knob to mark plugin event types ignorable (see TODOS.md).
        onRound: () => {},
      })
      const coverage = await coverageProgress(pack, upstreamRecords, outputRoot)
      const withCoverage = coverage === undefined ? result : { ...result, coverage }
      const withMaterials = { ...withCoverage, materials: materialPaths }
      return (upstreamWarnings === undefined ? withMaterials : { ...withMaterials, upstreamWarnings }) as unknown as DocGenerateResult
    },
  })
}

export function defineDocExtractTool(deps: ToolDeps) {
  return defineTool({
    name: 'doc_extract_params',
    description: 'Extract pack params from materials with machine-checkable provenance, BEFORE doc_generate on packs that declare extractable params (doc_packs marks them). '
      + 'For each extractable param propose either { value, quote } — quote MUST be a verbatim excerpt from the materials (whitespace-insensitive; the engine verifies it and refuses unproven values) — or { notFound: true }. '
      + '"Not found" is a first-class result: NEVER invent or assume a value the materials do not literally state; a required param left notFound is intercepted before generation and must be asked from the user. '
      + 'A suggestion (with an optional rationale) may accompany notFound for the user to endorse — it is never auto-applied; endorsing it means passing it via doc_generate params. '
      + 'Results persist as <pack>.extracted.json next to the pack\'s artifacts; doc_generate re-verifies every quote against the generation-time materials, so changed materials invalidate unproven entries.',
    parameters: {
      pack: { type: 'string', required: true, description: 'Pack name whose extractable params to fill (see doc_packs, extractable: true)' },
      materials: { type: 'array', items: { type: 'string'}, required: true, description: 'Material references to extract from — same ref semantics as doc_generate (paths relative to the active materials dir or #!inline text); extraction proves values FROM these texts, so the list must not be empty' },
      topic: { type: 'string', description: 'Topic directory name for topic-scoped packs (same semantics as doc_generate; locates the extraction cache under <topic>/output/)' },
      extractions: { type: 'object', additionalProperties: true, required: true, description: 'Proposed extractions keyed by param name: {"cfpTotal": {"value": {...}, "quote": "the expected CFPs is 70"}} or {"cfpTotal": {"notFound": true, "suggestion": {...}, "rationale": "..."}}. Only doc_packs-marked extractable params are accepted' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { pack: string; materials: unknown[]; topic?: string; extractions: unknown }, exec: SessionWorkspaceCarrier) {
      const pack = resolvePack(deps, args.pack)
      const extractable = extractableParams(pack)
      if (extractable.length === 0) {
        throw new Error(`pack "${pack.manifest.name}" declares no extractable params; doc_extract_params applies to packs marking params extractable: true (see doc_packs)`)
      }
      const refs = (args.materials as string[] | undefined) ?? []
      if (refs.length === 0) {
        throw new Error(`materials must not be empty: extraction proves values from the materials' own text (pass at least one reference, e.g. the requirement doc)`)
      }
      const workspaceRoot = effectiveWorkspaceRoot(exec, deps.config.workspaceRoot)
      const { materialsRoots, outputRoot } = resolveScopedRoots(workspaceRoot, deps.config, pack, args.topic)
      const entries = await readMaterialEntries(refs, workspaceRoot, materialsRoots)
      // Shape enforcement lives at the input schema (type: 'object' — the
      // runner rejects non-objects before the body runs), matching
      // normalizeParams; post-schema this is a plain object.
      const { extractions, results } = processProposals(pack, entries, args.extractions as Record<string, unknown>)
      // Extraction usually runs before any generation — the output root may
      // not exist yet (generateDocument mkdirs its own writes).
      await mkdir(outputRoot, { recursive: true })
      const path = extractionFilePath(outputRoot, pack.manifest.name)
      await writeExtractionFile(path, buildExtractionFile(pack, entries, extractions))
      return {
        pack: pack.manifest.name,
        extractionPath: path,
        extractable: [...extractable],
        results,
        hint: 'Values quoted from the materials now carry provenance: doc_generate resolves them ahead of declared defaults and the confirmation table shows their quotes. Present any notFound rows to the user — a required param left notFound will be refused before generation.',
      }
    },
  })
}

export function defineDocValidateTool(deps: ToolDeps) {
  return defineTool({
    name: 'doc_validate',
    description: 'Re-validate an existing document artifact against its pack ruleset and compare its hash with the sidecar receipt. '
      + 'Deterministic, no LLM. A GREEN validation re-issues (seals) the sidecar receipt for the current content, so externally edited artifacts can rejoin a chain; a red validation never touches it. '
      + 'Call doc_packs to see which packs are installed. '
      + 'Returns a fresh receipt; hashMatches=false means the artifact changed after generation; hashMatches=null means no prior receipt exists. '
      + 'The prior receipt\'s generation-time materials manifest is carried over unchanged, so doc_generate reuse checks keep comparing against the original inputs. '
      + 'packVersionStale=true means the sidecar receipt was written by a different pack version — the artifact predates the installed pack and its green receipt certifies the OLD rules; regenerate it.',
    parameters: {
      artifactPath: { type: 'string', required: true, description: 'Workspace-relative path to the artifact JSON' },
      pack: { type: 'string', required: true, description: 'Pack name the artifact belongs to' },
      language: { type: 'string', description: 'Language whose ruleset to run; defaults to the receipt-recorded language, then config defaultLanguage' },
      params: { type: 'object', additionalProperties: true, description: 'Optional pack-param overrides; defaults to the receipt-recorded as-run params (revalidate by the original standards)' },
      upstream: { type: 'array', items: { type: 'string' }, description: 'For chained packs: workspace-relative paths to the same upstream artifacts used at generation (green-receipt verified); required to replay chained-pack rules like plan-alignment checks' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { artifactPath: string; pack: string; language?: string; params?: unknown; upstream?: unknown[] }, exec) {
      const sessionPacks = await packsForSession(deps, exec as SessionWorkspaceCarrier | undefined)
      const pack = resolvePack(deps, args.pack, sessionPacks.packs)
      const workspaceRoot = effectiveWorkspaceRoot(exec as SessionWorkspaceCarrier | undefined, deps.config.workspaceRoot)
      const artifactPath = confinePath(workspaceRoot, args.artifactPath, 'artifactPath')
      const upstreamRefs = args.upstream as string[] | undefined
      const verifiedUpstream = upstreamRefs !== undefined && upstreamRefs.length > 0 && pack.manifest.consumes.length > 0
        ? await verifyUpstreamReceipts(workspaceRoot, upstreamRefs, pack, sessionPacks.packs, deps.config.upstreamVersionPolicy ?? DEFAULT_UPSTREAM_VERSION_POLICY)
        : undefined
      const raw = await readFile(artifactPath, 'utf8')
      let artifact: unknown
      try {
        artifact = JSON.parse(raw)
      } catch (error) {
        throw new Error(`artifact ${args.artifactPath} is not valid JSON: ${(error as Error).message}; regenerate via doc_generate or fix the file`)
      }

      // Tamper evidence: compare the canonical hash against the sidecar
      // receipt written at generation time (absent for bundled samples).
      let storedReceipt: { artifactHash?: string; language?: string; packVersion?: string; params?: Record<string, unknown>; materials?: readonly MaterialAnchor[] } | undefined
      let hashMatches: boolean | null = null
      try {
        const parsed: unknown = JSON.parse(await readFile(`${artifactPath.replace(/\.json$/, '')}.receipt.json`, 'utf8'))
        storedReceipt = typeof parsed === 'object' && parsed !== null ? parsed as { artifactHash?: string; language?: string; packVersion?: string; params?: Record<string, unknown>; materials?: readonly MaterialAnchor[] } : undefined
        hashMatches = storedReceipt?.artifactHash === artifactHashOf(artifact)
      } catch {
        storedReceipt = undefined
      }

      // Staleness: a receipt from another pack version certifies the OLD
      // ruleset — green under it does not mean compliant with the installed
      // pack. Receipts without a recorded version count as stale.
      const packVersionStale: boolean | null = storedReceipt === undefined
        ? null
        : (storedReceipt.packVersion ?? '') !== pack.manifest.version

      // Language: explicit param (must match the recorded one) > receipt-recorded > config default > pack first.
      const recorded = storedReceipt?.language
      if (args.language !== undefined && args.language.length > 0 && recorded !== undefined && args.language !== recorded) {
        throw new Error(`language "${args.language}" does not match the receipt-recorded language "${recorded}"; omit the parameter to revalidate as recorded`)
      }
      const language = args.language !== undefined && args.language.length > 0
        ? args.language
        : recorded !== undefined && recorded.length > 0 ? recorded! : undefined
      const resolvedLang = resolveLanguage(deps, pack, language)

      const service = getDocService(pack, resolvedLang)
      // Replay by the receipt-recorded as-run params (original standards);
      // explicit args.params override them for what-if validation.
      const receiptParams = storedReceipt?.params !== undefined && typeof storedReceipt.params === 'object'
        ? storedReceipt.params as Record<string, unknown>
        : undefined
      const effectiveParams = resolveEffectiveParams(pack, normalizeParams(args.params), receiptParams)
      // Chained replay: verified upstream artifacts feed rules like plan-alignment.
      const upstreamArtifacts = parseUpstreamArtifacts(verifiedUpstream?.texts)
      const ruleContext = upstreamArtifacts === undefined ? undefined : { upstream: upstreamArtifacts }
      const issues = service.validate(artifact, effectiveParams, ruleContext)
      const counts = severityCounts(issues)
      const isValid = counts.errors === 0
      const receipt = service.buildReceipt({
        artifact,
        isValid,
        unresolved: issues,
        iterations: 0,
        rounds: [{ round: 0, errorCount: counts.errors, warningCount: counts.warnings }],
        model: 'revalidate',
        ...(verifiedUpstream !== undefined ? { upstream: verifiedUpstream.anchors } : {}),
        // Carry the generation-time material manifest forward unchanged: a
        // re-validation certifies content, not inputs — the recorded anchors
        // stay the reuse pre-check's freshness baseline.
        ...(storedReceipt?.materials !== undefined ? { materials: storedReceipt.materials } : {}),
        ...(Object.keys(effectiveParams).length > 0 ? { params: effectiveParams } : {}),
      })
      // Seal (docs/designs/params-and-chain-contract.md): a green re-validation
      // re-issues the sidecar receipt for the CURRENT content — the quality
      // station earns the same issuing right as the generation line. Failing
      // validation never touches the sidecar; the hash still binds the
      // certificate to the exact content version.
      let sealed: boolean | undefined
      if (isValid) {
        await writeAtomic(artifactPath.replace(/\.json$/, '') + '.receipt.json', `${JSON.stringify(receipt, null, 2)}\n`)
        sealed = true
      }
      return { artifactPath, receipt, hashMatches, packVersionStale, ...(sealed === undefined ? {} : { sealed }), summary: summarizeArtifact(artifact) } as unknown as ValidateToolResult
    },
  })
}

/**
 * Fan-out coverage accounting (docs/designs/params-and-chain-contract.md):
 * which plan functions have green artifacts at each downstream stage.
 * Deterministic, no LLM — the check the agent runs before presenting a
 * per-function chain as complete.
 */
export function defineDocChainStatusTool(deps: ToolDeps) {
  return defineTool({
    name: 'doc_chain_status',
    description: 'Report per-function chain coverage for a fan-out chain: which functions of a plan artifact have green artifacts at each downstream stage (e.g. cosmic-req/cosmic-func/cosmic-tech), plus counts and any artifacts whose funcId matches no plan function. Deterministic, no LLM. Run this before presenting a per-function chain as complete.',
    parameters: {
      plan: { type: 'string', required: true, description: 'Workspace-relative path to the plan artifact JSON (must carry a green sidecar receipt); the directory holding it is the output root, so plan paths inside a topic directory scope the coverage scan to that topic' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { plan: string }, exec) {
      const workspaceRoot = effectiveWorkspaceRoot(exec as SessionWorkspaceCarrier | undefined, deps.config.workspaceRoot)
      const planPath = confinePath(workspaceRoot, args.plan, 'plan')
      // The plan's own directory is the output root (docs/designs/cosmic-context.md):
      // a plan generated under <topic>/output/ scopes the coverage scan to
      // that topic without an extra parameter.
      const outputRoot = dirname(planPath)
      let planArtifact: { functions?: unknown }
      let planPackName: string
      try {
        planArtifact = JSON.parse(await readFile(planPath, 'utf8')) as { functions?: unknown }
      } catch (error) {
        throw new Error(`plan artifact ${args.plan} is not readable JSON: ${(error as Error).message}`)
      }
      try {
        const receipt = JSON.parse(await readFile(planPath.replace(/\.json$/, '') + '.receipt.json', 'utf8')) as { pack?: unknown; isValid?: unknown }
        if (typeof receipt.pack !== 'string') throw new Error('receipt records no pack')
        if (receipt.isValid !== true) throw new Error('its receipt is RED; finish or regenerate the plan first')
        planPackName = receipt.pack
      } catch (error) {
        throw new Error(`plan artifact ${args.plan} has no usable sidecar receipt (${(error as Error).message}); generate it with doc_generate first`)
      }
      if (!Array.isArray(planArtifact.functions) || planArtifact.functions.length === 0) {
        throw new Error(`plan artifact ${args.plan} declares no functions[]; coverage is defined over plan functions`)
      }
      const planFuncIds = new Set(planArtifact.functions.map(fn => (fn as { funcId?: unknown } | null)?.funcId).filter((id): id is string => typeof id === 'string'))
      // Stage order: the plan pack, then every topic-scope pack consuming the
      // frontier. Workspace-scope packs (project-level artifacts like context
      // or its sync) never enter the fan-out: coverage is defined over plan
      // functions, not project-level single artifacts.
      const stages: string[] = [planPackName]
      let frontier = [planPackName]
      while (frontier.length > 0) {
        const { packs: chainPacks } = await packsForSession(deps, exec as SessionWorkspaceCarrier | undefined)
        const next = [...chainPacks.values()]
          .filter(p => p.manifest.scope !== 'workspace' && p.manifest.consumes.some(c => frontier.includes(c)) && !stages.includes(p.manifest.name))
          .map(p => p.manifest.name)
        stages.push(...next)
        frontier = next
      }
      const rows: Array<{ index: number; funcId: string; l2Name?: string; coverage: Record<string, string | null> }> = []
      const stageMaps = new Map<string, Map<string, string>>()
      for (const stage of stages.slice(1)) {
        stageMaps.set(stage, await scanStageArtifacts(outputRoot, stage))
      }
      const orphaned: Array<{ stage: string; file: string }> = []
      for (const [i, fn] of (planArtifact.functions as unknown[]).entries()) {
        const funcId = (fn as { funcId?: unknown } | null)?.funcId
        if (typeof funcId !== 'string') continue
        const l2Name = (fn as { l2Name?: unknown } | null)?.l2Name
        const coverage: Record<string, string | null> = {}
        for (const stage of stages.slice(1)) {
          const map = stageMaps.get(stage)!
          coverage[stage] = map.get(funcId) ?? null
          map.delete(funcId)
        }
        rows.push({
          index: i + 1,
          funcId,
          ...(typeof l2Name === 'string' && l2Name !== '' ? { l2Name } : {}),
          coverage,
        })
      }
      for (const [stage, map] of stageMaps) {
        for (const [funcId, file] of map) {
          orphaned.push({ stage, file: `${file}.json (funcId ${funcId} matches no plan function)` })
        }
      }
      const coverage: Record<string, { covered: number; total: number }> = {}
      for (const stage of stages.slice(1)) {
        coverage[stage] = { covered: rows.filter(r => r.coverage[stage] !== null).length, total: rows.length }
      }
      return {
        plan: args.plan,
        stages: stages.slice(1),
        functions: rows,
        coverage,
        ...(orphaned.length > 0 ? { orphaned } : {}),
      }
    },
  })
}

/**
 * Chain integrity: each upstream reference is a workspace path whose artifact
 * must carry a GREEN sidecar receipt with a matching canonical hash and a
 * pack type the consumer declares in `consumes`. Red drafts, tampered
 * artifacts, and wrong-type documents never feed downstream packs. A receipt
 * recording another pack version certifies the OLD ruleset: `strict` rejects
 * the stale upstream, `warn` proceeds and reports it. Records additionally
 * carry each receipt's language and as-run params — the inheritance base for
 * chain-shared params (docs/designs/params-and-chain-contract.md).
 */
export interface UpstreamRecord {
  readonly pack: string
  readonly packVersion: string
  readonly artifactHash: string
  readonly language: string | undefined
  readonly params: Record<string, unknown> | undefined
  readonly artifact: unknown
}

export async function verifyUpstreamReceipts(
  workspaceRoot: string,
  upstreamPaths: readonly string[],
  pack: Pack,
  packs: ReadonlyMap<string, Pack>,
  policy: UpstreamVersionPolicy,
): Promise<{ texts: string[]; anchors: UpstreamAnchor[]; warnings: string[]; records: UpstreamRecord[] }> {
  const texts: string[] = []
  const anchors: UpstreamAnchor[] = []
  const warnings: string[] = []
  const records: UpstreamRecord[] = []
  for (const ref of upstreamPaths) {
    const artifactPath = confinePath(workspaceRoot, ref, 'upstream')
    const receiptPath = `${artifactPath.replace(/\.json$/, '')}.receipt.json`
    let raw: string
    let stored: { pack?: string; packVersion?: string; artifactHash?: string; isValid?: boolean; language?: string; params?: Record<string, unknown> } | undefined
    try {
      raw = await readFile(artifactPath, 'utf8')
    } catch (error) {
      throw new Error(`upstream artifact not readable: ${ref} (${(error as Error).message})`)
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(receiptPath, 'utf8'))
      stored = typeof parsed === 'object' && parsed !== null ? parsed as typeof stored : undefined
    } catch {
      stored = undefined
    }
    if (stored === undefined) {
      throw new Error(`upstream artifact ${ref} has no sidecar receipt; generate it with doc_generate first (cause: chain integrity requires a green receipt; fix: run doc_generate on the upstream pack)`)
    }
    if (stored.isValid !== true) {
      throw new Error(`upstream artifact ${ref} has a RED receipt; red drafts must never feed downstream packs (fix: repair or regenerate the upstream document until green)`)
    }
    let artifact: unknown
    try {
      artifact = JSON.parse(raw)
    } catch {
      throw new Error(`upstream artifact ${ref} is not valid JSON`)
    }
    if (stored.artifactHash !== artifactHashOf(artifact)) {
      throw new Error(`upstream artifact ${ref} was modified after generation (hash mismatch vs receipt); regenerate it before consuming`)
    }
    if (stored.pack === undefined) {
      throw new Error(`upstream artifact ${ref} records no pack in its receipt; regenerate it with doc_generate`)
    }
    // Version staleness is judged against the INSTALLED version of the
    // upstream pack (version lines are independent per pack): a receipt from
    // an older upstream version certifies the OLD ruleset.
    const upstreamPack = packs.get(stored.pack)
    if (upstreamPack === undefined) {
      throw new Error(`upstream artifact ${ref} is of pack "${stored.pack}" but no such pack is installed (fix: install the pack or correct the consumer's consumes list)`)
    }
    // A consumed type is a chain edge; any other installed-pack artifact is a
    // rider — still green/hash/version-verified above, and allowed to ride
    // along as prompt context (e.g. the project context beside a plan,
    // docs/designs/cosmic-context.md). The chain contract itself is enforced
    // after the loop: at least one record must match `consumes`.
    const upstreamVersion = stored.packVersion ?? 'unknown'
    if (upstreamVersion !== upstreamPack.manifest.version) {
      const detail = `upstream artifact ${ref} was generated by "${stored.pack}" v${upstreamVersion} but the installed pack is v${upstreamPack.manifest.version}; its green receipt does not certify the current pack rules`
      if (policy === 'strict') {
        throw new Error(`${detail} (fix: regenerate the upstream via doc_generate, or set config upstreamVersionPolicy: "warn" to allow stale upstreams)`)
      }
      warnings.push(detail)
    }
    texts.push(JSON.stringify(artifact))
    anchors.push({ pack: stored.pack, packVersion: stored.packVersion ?? 'unknown', artifactHash: stored.artifactHash ?? '' })
    records.push({
      pack: stored.pack,
      packVersion: stored.packVersion ?? 'unknown',
      artifactHash: stored.artifactHash ?? '',
      language: typeof stored.language === 'string' && stored.language.length > 0 ? stored.language : undefined,
      params: typeof stored.params === 'object' && stored.params !== null ? stored.params as Record<string, unknown> : undefined,
      artifact,
    })
  }
  if (pack.manifest.consumes.length > 0 && !records.some(r => pack.manifest.consumes.includes(r.pack))) {
    throw new Error(`pack "${pack.manifest.name}" consumes [${pack.manifest.consumes.join(', ')}] but none of the upstream artifacts is of a consumed type; pass at least one of them (extra artifacts may ride along as context)`)
  }
  return { texts, anchors, warnings, records }
}
