import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { AUTHORING_SKILL_NAME, readAuthoringGuide, registerAuthoringSkill, type SkillsHostContext } from './authoring-skill.ts'
import { INSTALL_SKILL_NAME, readInstallGuide, registerInstallSkill } from './install-skill.ts'
import { Config, type Config as DocwrightConfig } from './config.ts'
import { mountParamsRoutes, type ConnectionLike, type WebServerLike, type WriteChannels } from './http.ts'
import { loadPacks } from './pack-loader.ts'
import { buildParamsPayload } from './params-rpc.ts'
import { checkPackUpdates, deletePack, marketUrlOf, updatePack } from './pack-manage.ts'
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
export async function registerTools(ctx: Context, config: DocwrightConfig, builtinRoot: string, guidesRoot: string = join(builtinRoot, '..', 'guides')): Promise<void> {
  // Mutable copy: the params-UI write channel hot-swaps THIS instance in
  // place (clear + refill) so the tools and the RPC payload see a new pack
  // manifest default without a restart; Map satisfies every ReadonlyMap dep.
  // Zero installed packs is a legal state since the cosmic packs moved to
  // the market: the plugin loads, doc_packs lists nothing, and (with
  // marketSearch on) the discovery layer points at the market.
  const packsDirConfiguredForLoad = config.packsDir === undefined || config.packsDir.length === 0 ? undefined : config.packsDir
  /** One wiring point: the builtin-load switch applies to the initial load, every hot-reload, and the install lane. */
  const loadPacksConfigured = (root: string, dirs: { extra?: readonly string[] | undefined }) =>
    loadPacks(root, { ...dirs, includeBuiltin: config.loadBuiltinPacks !== false })
  const packs = new Map(await loadPacksConfigured(builtinRoot, { extra: packsDirConfiguredForLoad === undefined ? undefined : [packsDirConfiguredForLoad] }))
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
    const packsDirConfigured = config.packsDir !== undefined && config.packsDir.length > 0 ? config.packsDir : undefined
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
      packLane: packsDirConfigured === undefined ? undefined : {
        checkUpdates: (pack?: string | undefined) => checkPackUpdates({ packs, packsDir: packsDirConfigured, marketUrl: marketUrlOf(config) }, pack),
        updatePack: async pack => ({ version: await updatePack({ packs, builtinRoot, packsDir: packsDirConfigured, marketUrl: marketUrlOf(config), loadPacks: loadPacksConfigured }, pack) }),
        deletePack: (pack, opts) => deletePack({ packs, builtinRoot, packsDir: packsDirConfigured, loadPacks: loadPacksConfigured }, pack, opts),
      },
    }
    host.effect(() => mountParamsRoutes(host.webServer, {
      payload: () => buildParamsPayload(packs, Config, config),
      connection: () => (ctx as unknown as { get(name: string): unknown }).get('connection') as ConnectionLike | undefined,
      writes,
    }), 'docwright: params routes')
  })
}
