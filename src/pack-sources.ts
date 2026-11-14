import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pack } from './pack.ts'
import { loadPackSet, type PackRootSpec, type ShadowedCopy } from './pack-loader.ts'

/**
 * Pack source resolution (docs/designs/pack-load-dirs.md): the home-level
 * install dir default, the workspace tier roots (with opt-in upward search),
 * and the disabled-name filter. Split from the loader so every consumer
 * (apply-time load, per-call workspace overlay, the check runner) shares one
 * resolution path.
 */

/** Fallback DSH home when the env var is absent — matches the harness's own default. */
export function dshHome(): string {
  const env = process.env.DSH_HOME
  return env !== undefined && env.length > 0 ? env : join(homedir(), '.dsh')
}

/** Install dir: config override wins; otherwise $DSH_HOME/docwright/packs. Empty string counts as unset. */
export function resolvePacksDir(configured: string | undefined): string {
  const dir = configured !== undefined && configured.trim().length > 0 ? configured.trim() : undefined
  return dir !== undefined ? resolve(dir) : join(dshHome(), 'docwright', 'packs')
}

const WORKSPACE_PACKS_DIR = '.docwright/packs'

/**
 * Workspace-tier roots, ordered inner-first (the tier loads last and inner
 * wins, so the array runs inner → outer). Without `upward` only the
 * workspace's own tier exists; with it, ancestor directories join the search
 * (inner wins), stopping at the filesystem root. Missing dirs are skipped —
 * absence of a tier is normal, not an error.
 */
export function workspacePackRoots(workspaceRoot: string, upward: boolean): readonly PackRootSpec[] {
  const collect: string[] = []
  let current = resolve(workspaceRoot)
  // Bound the walk: filesystem root has no parent (its parent resolves to itself).
  for (;;) {
    collect.push(current)
    const parent = resolve(current, '..')
    if (!upward || parent === current) break
    current = parent
  }
  // collect runs inner → outer already; inner wins because roots load in order.
  return collect.map((dir, depth) => {
    const packsDir = join(dir, WORKSPACE_PACKS_DIR)
    return { dir: packsDir, origin: { kind: 'workspace' as const, root: packsDir, depth } }
  })
}

/** Result of overlaying the workspace tier onto the apply-time pack map. */
export interface WorkspaceOverlay {
  readonly packs: ReadonlyMap<string, Pack>
  readonly shadowed: readonly ShadowedCopy[]
}

/**
 * Overlay the workspace tier onto an already-loaded pack map: workspace
 * packs win same-name clashes (the tier loads last), losers are recorded as
 * shadowed copies. Loads with `includeBuiltin: false` — the base map already
 * carries the other tiers.
 */
export async function overlayWorkspaceTier(base: ReadonlyMap<string, Pack>, workspaceRoot: string, upward: boolean, shadowPolicy: 'allow' | 'error'): Promise<WorkspaceOverlay> {
  const roots = workspacePackRoots(workspaceRoot, upward)
  if (roots.length === 0) return { packs: base, shadowed: [] }
  const { packs, shadowed } = await loadPackSet('', { includeBuiltin: false, roots, shadowPolicy })
  const merged = new Map(base)
  const records: ShadowedCopy[] = [...shadowed]
  for (const [name, pack] of packs) {
    const existing = merged.get(name)
    if (existing !== undefined) {
      records.push({
        name,
        origin: existing.origin,
        dir: existing.dir,
        version: existing.manifest.version,
        activeOrigin: pack.origin,
        activeDir: pack.dir,
        activeVersion: pack.manifest.version,
      })
    }
    merged.set(name, pack)
  }
  return { packs: merged, shadowed: records }
}

/**
 * Disabled-name filter (docs/designs/pack-load-dirs.md, 启用与禁用). Names may
 * reference packs or suites — suite names expand via `suiteMembers`. A
 * disabled pack does not load; an ENABLED pack whose consumes references a
 * disabled name fails loud (a silent skip would let the downstream pack enter
 * the session with a broken chain).
 */
export function applyDisabled(
  packs: ReadonlyMap<string, Pack>,
  disabledNames: readonly string[] | undefined,
  suiteMembers: (name: string) => readonly string[] | undefined,
): ReadonlyMap<string, Pack> {
  const entries = disabledNames ?? []
  if (entries.length === 0) return packs
  const disabled = new Set<string>()
  for (const raw of entries) {
    const name = raw.trim()
    if (name.length === 0) continue
    disabled.add(name)
    for (const member of suiteMembers(name) ?? []) disabled.add(member)
  }
  if (disabled.size === 0) return packs
  const enabled = new Map<string, Pack>()
  for (const [name, pack] of packs) {
    if (disabled.has(name)) continue
    for (const consumed of pack.manifest.consumes ?? []) {
      if (disabled.has(consumed)) {
        throw new Error(`pack "${name}" consumes "${consumed}", which is disabled (disabledPacks); a disabled upstream would leave this pack with a broken chain. Re-enable "${consumed}" or also disable "${name}"`)
      }
    }
    enabled.set(name, pack)
  }
  return enabled
}
