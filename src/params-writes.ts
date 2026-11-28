import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CodedError } from './coded-error.ts'
import { assertManifest } from './pack-loader.ts'
import { isParamRef } from './pack.ts'
import type { Pack } from './pack.ts'

/**
 * Write channels for the params maintenance UI (S3 of
 * docs/designs/param-management-ui.md). Two classes of write, each with its
 * persistence owner:
 *
 * - Config edits go through the HOST config editor
 *   (`ctx.configEditor.edit()`): the host writes the merged config into the
 *   profile patch under a file lock, runs Loader reconciliation, and the
 *   plugin re-composes with the new config — persistence, conflict
 *   detection, and reload stay the host's job. (The settings FORM service
 *   was the first choice but projects only `.volatile()` schema fields,
 *   whose value semantics would infect every config read here; the editor's
 *   entry-level edit keeps plain config values.)
 * - Pack-param default edits rewrite the pack's manifest.json directly
 *   (packs are not profile entries — the host has no channel for them).
 *   The proposed manifest must pass the exact load-time validation before
 *   it touches disk, the write is atomic, and the loaded pack map is
 *   hot-swapped IN PLACE (clear + re-fill of the same Map instance the
 *   tools hold) so the next doc_generate sees the new default without a
 *   restart. A concurrent generation keeps its old Pack object and finishes
 *   under the spec it started with — the swap only affects new calls.
 */

/** The slice of the host config editor this module consumes. */
export interface ConfigEditorLike {
  entries(): readonly ConfigEntryLike[]
  edit(entry: ConfigEntryLike, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

export interface ConfigEntryLike {
  readonly options?: { readonly id?: unknown; readonly name?: unknown; readonly config?: Record<string, unknown> } | undefined
}

/** Plugin package name the docwright profile entry is located by. */
export const PLUGIN_PACKAGE_NAME = '@sharework-ai/dsh-docwright'

/** Locate the docwright profile entry; loud when the host serves no editor or the entry is missing. */
export function findOwnEntry(entries: readonly ConfigEntryLike[]): ConfigEntryLike {
  const own = entries.find(e => e.options?.name === PLUGIN_PACKAGE_NAME)
    ?? entries.find(e => typeof e.options?.name === 'string' && e.options.name.endsWith('/dsh-docwright'))
  if (own === undefined) {
    throw new CodedError('noProfileEntry', 'no profile entry for docwright: the host config editor did not list this plugin (cause: the entry composes the running plugin and must be in the active profile; fix: configure docwright via cordis.yml or the profile patch)')
  }
  return own
}

/** Merge a Config patch through the host config editor (profile patch write + Loader reconciliation). */
export async function updateConfigViaEditor(editor: ConfigEditorLike, patch: Record<string, unknown>): Promise<void> {
  const entry = findOwnEntry(editor.entries())
  await editor.edit(entry, (current) => ({ ...current, ...patch }))
}

/**
 * Set one pack param's default: validate at load strength, write atomically,
 * hot-swap the pack map in place. `value` replaces `params.<name>.default`;
 * the param must already declare one (the UI's inclusion criterion —
 * structural manifest changes are a pack-author job with a version bump).
 */
export async function setPackParamDefault(deps: {
  packs: Map<string, Pack>
  /** Config root the builtin packs load from (to rebuild the full map). */
  builtinRoot: string
  extraPacksDir?: string | undefined
  loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
}, packName: string, paramName: string, value: unknown, expectedOrigin?: { readonly kind: string; readonly root: string } | undefined): Promise<void> {
  const pack = deps.packs.get(packName)
  if (pack === undefined) {
    throw new CodedError('unknownPack', `unknown pack "${packName}" (available: ${[...deps.packs.keys()].sort().join(', ')}); nothing was written`, { params: { pack: packName, available: [...deps.packs.keys()].sort().join(', ') } })
  }
  // Seen-vs-written guard: the UI renders a card from the ACTIVE pack map and
  // echoes its origin back; when a same-name shadowed copy changed the
  // active root between render and click, the echo no longer matches and the
  // write refuses instead of landing in a manifest the user was not shown.
  if (expectedOrigin !== undefined && (pack.origin.kind !== expectedOrigin.kind || pack.origin.root !== expectedOrigin.root)) {
    throw new CodedError('originMismatch', `pack "${packName}" now resolves from ${pack.origin.kind} (${pack.origin.root}), but the edit was addressed at ${expectedOrigin.kind} (${expectedOrigin.root}) — the views were reloaded in between; nothing was written`, { params: { pack: packName }, detail: `expected ${expectedOrigin.kind} ${expectedOrigin.root}, actual ${pack.origin.kind} ${pack.origin.root}` })
  }
  const spec = pack.manifest.params?.[paramName]
  if (spec === undefined || spec.default === undefined) {
    throw new CodedError('paramNotEditable', `pack "${packName}" param "${paramName}" does not declare a default (the UI maintains declared defaults only; a structural manifest change is a pack-author edit with a version bump); nothing was written`, { params: { pack: packName, param: paramName } })
  }
  const manifestPath = join(pack.dir, 'manifest.json')
  const raw = await readFile(manifestPath, 'utf8')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    throw new CodedError('manifestCorrupt', `pack "${packName}" manifest.json is not valid JSON (${(error as Error).message}); fix the file first; nothing was written`, { params: { pack: packName }, detail: (error as Error).message })
  }
  const params = manifest.params as Record<string, unknown> | undefined
  if (typeof params !== 'object' || params === null || Array.isArray(params) || !(paramName in params) || typeof params[paramName] !== 'object' || params[paramName] === null) {
    throw new CodedError('paramVanished', `pack "${packName}" manifest no longer declares params.${paramName}; nothing was written`, { params: { param: paramName } })
  }
  const nextParams: Record<string, unknown> = { ...params }
  nextParams[paramName] = { ...(params[paramName] as Record<string, unknown>), default: value }
  const nextManifest = { ...manifest, params: nextParams }
  // Pattern-referenced params (declarative rules compile their regex from the
  // value) must stay valid: a non-empty string has to compile, an empty
  // string disables the check. assertManifest cannot see the rule files, so
  // this guard runs against the LOADED pack's rules — the same gate the
  // loader applies, just before disk instead of at the reload.
  for (const rules of pack.rules.values()) {
    for (const rule of rules) {
      if (rule.kind !== 'pattern' || !isParamRef(rule.pattern) || rule.pattern.param !== paramName) continue
      if (value === '') continue
      if (typeof value !== 'string') {
        throw new CodedError('patternParamInvalid', `param "${paramName}" drives rule "${rule.id}" and must be a string (regex source); nothing was written`, { params: { param: paramName } })
      }
      try {
        void new RegExp(value)
      } catch (error) {
        throw new CodedError('patternParamInvalid', `param "${paramName}" drives rule "${rule.id}" and the proposed value is not a valid regex: ${(error as Error).message}; nothing was written`, { params: { param: paramName }, detail: (error as Error).message })
      }
    }
  }
  // The EXACT load-time gate: a manifest the loader would reject never
  // reaches disk (misconfiguration fails loud, not at the next boot). The
  // loader's message stays the `message` (tests + logs match on it) and rides
  // as `detail` so the browser can render a localized template above it.
  try {
    assertManifest(nextManifest, pack.dir)
  } catch (error) {
    throw new CodedError('manifestInvalid', (error as Error).message, { detail: (error as Error).message })
  }
  await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8')
  await rename(`${manifestPath}.tmp`, manifestPath)
  // Hot-swap: reload every root and refill the SAME Map instance the tools
  // hold, so resolvePack and the RPC payload see the new spec immediately.
  let reloaded: ReadonlyMap<string, Pack>
  try {
    reloaded = await deps.loadPacks(deps.builtinRoot, { extra: deps.extraPacksDir === undefined ? undefined : [deps.extraPacksDir] })
  } catch (error) {
    throw new CodedError('reloadFailed', `manifest written, but reloading packs failed: ${(error as Error).message}; fix or revert ${manifestPath} — the running tools still hold the previous spec until a successful reload`, { params: { path: manifestPath }, detail: (error as Error).message })
  }
  deps.packs.clear()
  for (const [name, loaded] of reloaded) deps.packs.set(name, loaded)
}
