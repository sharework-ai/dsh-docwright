import type { Context } from '@deepseek-ai/cordis'
import { join, resolve } from 'node:path'
import { AUTHORING_SKILL_NAME, readAuthoringGuide, registerAuthoringSkill, type SkillsHostContext } from './authoring-skill.ts'
import { INSTALL_SKILL_NAME, readInstallGuide, registerInstallSkill } from './install-skill.ts'
import { Config, type Config as DocwrightConfig } from './config.ts'
import { mountParamsRoutes, type ConnectionLike, type WebServerLike, type WriteChannels } from './http.ts'
import { loadPackSet, type PackRootSpec } from './pack-loader.ts'
import type { Pack } from './pack.ts'
import { applyDisabled, resolvePacksDir } from './pack-sources.ts'
import { buildParamsPayload } from './params-rpc.ts'
import { checkPackUpdates, checkSuiteStatus, deletePack, deleteSuite, marketUrlOf, readSuiteRecord, setPackDisabled, updatePack, updateSuite } from './pack-manage.ts'
import { setPackParamDefault, updateConfigViaEditor, type ConfigEditorLike } from './params-writes.ts'
import { defineDocChainStatusTool, defineDocExtractTool, defineDocGenerateTool, defineDocPacksTool, defineDocValidateTool, defineMarketInstallTool, defineMarketSearchTool } from './tools.ts'

/**
 * docwright — closed-loop document generation for deepseek-harness.
 * JSON is the single source of truth; every document ships with a
 * replayable validation receipt. See docs/designs/docwright-mvp.md.
 * @module @sharework-ai/dsh-docwright
 */

export const name = 'docwright'
export const inject = ['tools', 'llm']
export { Config }
export type { DocwrightConfig }
export * from './pack.ts'
export { AUTHORING_SKILL_NAME, AUTHORING_SKILL_DESCRIPTION, AUTHORING_SKILL_WHEN_TO_USE } from './authoring-skill.ts'
export { INSTALL_SKILL_NAME, INSTALL_SKILL_DESCRIPTION, INSTALL_SKILL_WHEN_TO_USE } from './install-skill.ts'
export { createScoring, defaultScore, type Scoring } from './convergence.ts'
export { resolveEffectiveParams, type ExtractionView } from './params.ts'
export { readExtractionFile, writeExtractionFile, verifyExtraction, type ExtractionFile, type ExtractionRecord } from './extract.ts'
export { buildParamsCatalog, buildConfigCatalog, paramRoles, type ParamsCatalog, type UiConfigEntry } from './params-rpc.ts'
export { DocService, generateDocument } from './doc-service.ts'
export { runRepairLoop, type LoopExhaustReason } from './loop.ts'
export { loadPacks, assertManifest } from './pack-loader.ts'
export { checkPacks, renderPackCheckReport, type PackCheckReport, type PackCheckEntry } from './pack-check.ts'

export async function apply(ctx: Context, config: DocwrightConfig): Promise<void> {
  await registerTools(ctx, config, join(import.meta.dirname, '..', 'packs'))
}

/**
 * Pack loading is apply-time (decision #9): load failures — bad manifest,
 * broken ruleset, missing Config-default language — fail loud here.
 * Split from {@link apply} so the packs root is injectable for tests.
 * `guidesRoot` defaults to the sibling of the packs root (shipped layout)
 * and is injectable for tests; its guide feeds the pack-authoring skill
 * (docs/designs/pack-authoring.md).
 */
/** Prune disabled-list entries whose names just got deleted (docs/designs/pack-load-dirs.md 启用与禁用: delete flows clean the list). */
function pruneDisabled(config: DocwrightConfig, names: readonly string[]): readonly string[] {
  const removed = new Set(names)
  return (config.disabledPacks ?? []).filter(name => !removed.has(name))
}

export async function registerTools(ctx: Context, config: DocwrightConfig, builtinRoot: string, guidesRoot: string = join(builtinRoot, '..', 'guides')): Promise<void> {
  // Mutable copy: the params-UI write channel hot-swaps THIS instance in
  // place (clear + refill) so the tools and the RPC payload see a new pack
  // manifest default without a restart; Map satisfies every ReadonlyMap dep.
  // Zero installed packs is a legal state since the cosmic packs moved to
  // the market: the plugin loads, doc_packs lists nothing, and (with
  // marketSearch on) the discovery layer points at the market.
  //
  // Load tiers (docs/designs/pack-load-dirs.md): builtin < install dir
  // (packsDir, default $DSH_HOME/docwright/packs) < extraPacksDir — later
  // roots shadow same-name packs, records kept for the UI. The workspace
  // tier loads dynamically per call (see tools.ts), never here.
  const installDir = resolvePacksDir(config.packsDir)
  const extraDir = config.extraPacksDir !== undefined && config.extraPacksDir.trim().length > 0 ? resolve(config.extraPacksDir.trim()) : undefined
  const shadowPolicy = config.packShadowPolicy ?? 'allow'
  const canonicalRoots = (): PackRootSpec[] => [
    { dir: installDir, origin: { kind: 'packsDir', root: installDir } },
    ...(extraDir !== undefined ? [{ dir: extraDir, origin: { kind: 'extraPacksDir' as const, root: extraDir } }] : []),
  ]
  /** One wiring point: the builtin-load switch applies to the initial load, every hot-reload, and the install lane. The legacy positional args (builtinRoot, { extra: [packsDir] }) are accepted and ignored — canonical roots resolve the same tiers plus extraPacksDir, shadow policy, and the disabled filter. */
  const loadPacksConfigured = (_root?: string, _dirs?: { extra?: readonly string[] | undefined }): Promise<ReadonlyMap<string, Pack>> =>
    loadPackSet(builtinRoot, { includeBuiltin: config.loadBuiltinPacks !== false, roots: canonicalRoots(), shadowPolicy }).then(async set => {
      // Disabled names expand via the local suites.json record (suite names
      // map to their member packs); disabled packs drop out of the map and an
      // enabled pack consuming a disabled one fails loud.
      const suites = await readSuiteRecord(installDir)
      const membersOf = (name: string): readonly string[] | undefined =>
        suites.find(s => s.name === name)?.members.map(m => m.name)
      return new Map(applyDisabled(set.packs, config.disabledPacks, membersOf))
    })
  // Legacy-signature shim: the install lane and older callers pass
  // (builtinRoot, { extra: [packsDir] }); canonical roots resolve the same tiers.
  const packs = new Map(await loadPacksConfigured())
  if (config.defaultLanguage !== undefined && config.defaultLanguage.length > 0) {
    const missing = [...packs.values()].filter(p => !p.manifest.languages.includes(config.defaultLanguage ?? ''))
    if (missing.length > 0) {
      throw new Error(`docwright: defaultLanguage "${config.defaultLanguage}" missing from packs: ${missing.map(p => p.manifest.name).join(', ')} (available per pack: ${[...packs.values()].map(p => `${p.manifest.name}=[${p.manifest.languages.join(',')}]`).join(' ')})`)
    }
  }
  const deps = { packs, config, ctx, builtinRoot, loadPacks: loadPacksConfigured }
  ctx.tools.register(defineDocPacksTool(deps))
  ctx.tools.register(defineDocGenerateTool(deps))
  ctx.tools.register(defineDocExtractTool(deps))
  ctx.tools.register(defineDocValidateTool(deps))
  ctx.tools.register(defineDocChainStatusTool(deps))
  // Layer-3 capability discovery: the market-search tool exists only when
  // the deployment enables it (default on); its absence is the off signal —
  // no copy changes at runtime.
  if (config.marketSearch !== false) {
    ctx.tools.register(defineMarketSearchTool(deps))
    ctx.tools.register(defineMarketInstallTool(deps))
  }
  // Pack-authoring skill (docs/designs/pack-authoring.md): the model face
  // teaches authoring, not only consuming. The guide is read eagerly — a
  // broken package fails loud even on hosts where the skill stays dormant.
  const guide = await readAuthoringGuide(guidesRoot)
  // The install skill mirrors the authoring one for the market lane: users
  // phrase installs as "装一个技能", which would otherwise read as
  // filesystem-skill authoring.
  const installGuide = await readInstallGuide(guidesRoot)
  ctx.inject(['skills'], (skillsCtx: Context) => {
    registerAuthoringSkill(skillsCtx as unknown as SkillsHostContext, guidesRoot, guide)
    registerInstallSkill(skillsCtx as unknown as SkillsHostContext, guidesRoot, installGuide)
  })
  // Params maintenance UI (docs/designs/param-management-ui.md): mounts on
  // the host webServer when the host provides one. A headless/CLI host never
  // resolves the service, this inject stays dormant, and the tools are
  // unaffected. Payload and connection resolve lazily per request — the
  // connection service only exists after the host's async init.
  ctx.inject(['webServer'], (hostCtx: Context) => {
    const host = hostCtx as unknown as {
      effect(fn: () => () => void, name?: string): void
      webServer: WebServerLike
    }
    // Config writes proxy the HOST config editor (entry-level edit into the
    // profile patch + Loader reconciliation). Resolved lazily per call for
    // the same async-init reason as the connection gate; a host without the
    // service surfaces a clear error from the write route instead.
    const editorOf = (): ConfigEditorLike => {
      const editor = (ctx as unknown as { get(name: string): unknown }).get('configEditor') as ConfigEditorLike | undefined
      if (editor === undefined || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
        throw new Error('the host config editor is not available (cause: this dsh does not expose profile patch editing; fix: configure docwright via cordis.yml)')
      }
      return editor
    }
    const packsDirConfigured = installDir
    const writes: WriteChannels = {
      updateConfig: patch => updateConfigViaEditor(editorOf(), patch),
      setPackParamDefault: (pack, param, value) => setPackParamDefault({
        packs,
        builtinRoot,
        extraPacksDir: packsDirConfigured,
        loadPacks: loadPacksConfigured,
      }, pack, param, value),
      // The pack lane exists only when a packsDir is configured — without one
      // there is nothing to manage and the routes stay unmounted.
      packLane: {
        checkUpdates: (pack?: string | undefined) => checkPackUpdates({ packs, packsDir: packsDirConfigured, marketUrl: marketUrlOf(config) }, pack),
        updatePack: async pack => ({ version: await updatePack({ packs, builtinRoot, packsDir: packsDirConfigured, marketUrl: marketUrlOf(config), loadPacks: loadPacksConfigured }, pack) }),
        deletePack: (pack, opts) => deletePack({ packs, builtinRoot, packsDir: packsDirConfigured, marketUrl: marketUrlOf(config), loadPacks: loadPacksConfigured, cleanupDisabled: names => updateConfigViaEditor(editorOf(), { disabledPacks: pruneDisabled(config, names) }) }, pack, opts),
        // The suite lane (docs/designs/pack-suites.md): status read + per-suite
        // update/delete, same packsDir, same market, same hot-reload contract.
        suiteStatus: () => checkSuiteStatus({ packs, packsDir: packsDirConfigured, marketUrl: marketUrlOf(config) }),
        updateSuite: suite => updateSuite({ packs, builtinRoot, packsDir: packsDirConfigured, marketUrl: marketUrlOf(config), loadPacks: loadPacksConfigured }, suite),
        deleteSuite: suite => deleteSuite({ packs, builtinRoot, packsDir: packsDirConfigured, marketUrl: marketUrlOf(config), loadPacks: loadPacksConfigured, cleanupDisabled: names => updateConfigViaEditor(editorOf(), { disabledPacks: pruneDisabled(config, names) }) }, suite),
        // The enable/disable toggle (docs/designs/pack-load-dirs.md 启用与禁用):
        // reads the live disabledPacks array, guards suite members and
        // in-use packs like the delete lanes, persists via the host editor.
        setPackDisabled: (pack, disabled, opts) => setPackDisabled(
          {
            packs,
            packsDir: packsDirConfigured,
            marketUrl: marketUrlOf(config),
            currentDisabled: config.disabledPacks,
            editConfig: next => updateConfigViaEditor(editorOf(), { disabledPacks: next }),
          },
          pack,
          disabled,
          opts,
        ),
      },
    }
    host.effect(() => mountParamsRoutes(host.webServer, {
      payload: () => buildParamsPayload(packs, Config, config),
      connection: () => (ctx as unknown as { get(name: string): unknown }).get('connection') as ConnectionLike | undefined,
      writes,
    }), 'docwright: params routes')
  })
}
