/**
 * packsDir pack management for the params UI: version check against the pack
 * market, update (download → verify → atomic swap → in-place reload), and
 * delete. Managed packs are the Config.packsDir contents; builtin packs ship
 * inside the plugin package and are refused here.
 *
 * Security posture: the client passes pack NAMES, never paths. Every
 * directory is resolved server-side by scanning the packsDir root and
 * matching manifest.json names, so a crafted name cannot address a path
 * outside the root (readdir entries cannot contain path separators). The
 * update channel verifies the tarball against the market index three ways —
 * tarball sha256, archive manifest name, extracted content hash — before
 * anything lands in the packsDir (the install.mjs recipe, byte-for-byte the
 * same dirHash so the two clients agree on one number).
 *
 * The update fetch is plain HTTPS to the market; a deployment that hosts its
 * own market points config.marketUrl elsewhere. A fetch that fails (offline,
 * unreachable host) fails the check/update without touching disk.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { CodedError } from './coded-error.ts'
import type { Pack } from './pack.ts'

const execFileAsync = promisify(execFile)

/** The market this plugin's pack lane is published to (config.marketUrl default). */
export const DEFAULT_MARKET_URL = 'https://dm.shrwk.com'

export function marketUrlOf(config: { marketUrl?: string }): string {
  return config.marketUrl !== undefined && config.marketUrl.length > 0 ? config.marketUrl : DEFAULT_MARKET_URL
}

/** One packsDir pack's standing against the market (GET /api/docwright/pack-updates row). */
export interface PackUpdateStatus {
  readonly name: string
  readonly localVersion: string
  /** False when the market has no pack under this name. */
  readonly onMarket: boolean
  /** Absent when the market has no pack under this name. */
  readonly marketVersion?: string
  readonly updateAvailable: boolean
}

/** One market index row (format-2 /api/index — the fields install.mjs consumes). */
interface MarketIndexEntry {
  readonly name: string
  readonly version: string
  readonly tarball: string
  readonly tarballSha256: string
  readonly contentHash: string
  readonly consumes?: readonly unknown[]
}

function consumesOf(entry: MarketIndexEntry): readonly string[] {
  return Array.isArray(entry.consumes) ? entry.consumes.filter((c): c is string => typeof c === 'string') : []
}

interface MarketIndex {
  readonly packs: readonly MarketIndexEntry[]
}

/** Numeric x.y.z compare; non-numeric segments compare lexically, missing segments as zero. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? '0'
    const sb = pb[i] ?? '0'
    const na = /^\d+$/.test(sa) ? Number(sa) : NaN
    const nb = /^\d+$/.test(sb) ? Number(sb) : NaN
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb
      continue
    }
    if (sa !== sb) return sa < sb ? -1 : 1
  }
  return 0
}

/** Read one pack directory's manifest name (null when the dir carries no parseable manifest). */
async function manifestNameOf(dir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { name?: unknown }
    return typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : null
  } catch {
    return null
  }
}

/**
 * Resolve a pack name to its directory under the packsDir root by scanning
 * manifests. The managed pack set is whatever sits in packsDir right now —
 * NOT the loaded pack map (a dir the loader rejects must stay deletable, or
 * one broken pack would lock the user out of removing it).
 * @returns the directory path.
 * @throws packNotManaged when the name matches no directory under the root.
 */
export async function resolveManagedPackDir(packsDir: string, name: string): Promise<string> {
  const available: string[] = []
  for (const dirent of await readdir(packsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    const dir = join(packsDir, dirent.name)
    const packName = await manifestNameOf(dir)
    if (packName === null) continue
    if (packName === name) return dir
    available.push(packName)
  }
  throw new CodedError('packNotManaged', `pack "${name}" is not managed here: no directory under ${packsDir} declares that manifest name${available.length > 0 ? ` (managed: ${available.sort().join(', ')})` : ''}; nothing was written`, { params: { pack: name } })
}

/**
 * Version standing of every packsDir pack against the market index (one
 * fetch). Packs the market does not list report marketVersion undefined.
 * @throws marketUnreachable when the index fetch itself fails.
 */
export async function checkPackUpdates(deps: {
  readonly packs: ReadonlyMap<string, Pack>
  readonly packsDir?: string | undefined
  readonly marketUrl: string
  readonly fetchImpl?: typeof fetch
}): Promise<readonly PackUpdateStatus[]> {
  if (deps.packsDir === undefined || deps.packsDir.length === 0) return []
  const managed = [...deps.packs.values()].filter(p => p.origin.kind === 'packsDir')
  if (managed.length === 0) return []
  let index: MarketIndex
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${deps.marketUrl}/api/index`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    index = await response.json() as MarketIndex
  } catch (error) {
    throw new CodedError('marketUnreachable', `could not reach the pack market at ${deps.marketUrl} (${(error as Error).message}); showing local state only`, { params: { url: deps.marketUrl }, detail: (error as Error).message })
  }
  const byName = new Map(index.packs.map(e => [e.name, e]))
  return managed.map(p => {
    const entry = byName.get(p.manifest.name)
    const marketVersion = entry?.version
    return {
      name: p.manifest.name,
      localVersion: p.manifest.version,
      onMarket: marketVersion !== undefined,
      ...(marketVersion === undefined ? {} : { marketVersion }),
      updateAvailable: marketVersion !== undefined && compareVersions(marketVersion, p.manifest.version) > 0,
    }
  })
}

/** Parity with install.mjs dirHash: the market and this client must agree on one number. */
export async function dirHash(dir: string): Promise<string> {
  const files: string[] = []
  async function walk(current: string): Promise<void> {
    for (const dirent of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, dirent.name)
      if (dirent.isDirectory()) await walk(full)
      else files.push(full)
    }
  }
  await walk(dir)
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(relative(dir, file).split(sep).join('/'))
    hash.update('\0')
    hash.update(await readFile(file))
  }
  return `sha256:${hash.digest('hex')}`
}

/** Fetch the tarball bytes and enforce the index sha256 (410 keeps install.mjs's disabled-pack wording). */
async function fetchTarball(marketUrl: string, entry: MarketIndexEntry, fetchImpl: typeof fetch): Promise<Buffer> {
  const url = entry.tarball.startsWith('http') ? entry.tarball : `${marketUrl}${entry.tarball}`
  let response: Response
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) })
  } catch (error) {
    throw new CodedError('marketUnreachable', `could not fetch the ${entry.name} tarball from ${url} (${(error as Error).message}); nothing was written`, { params: { url }, detail: (error as Error).message })
  }
  if (!response.ok) {
    throw new CodedError('updateFailed', `pack "${entry.name}" tarball download failed (HTTP ${response.status}) from ${url}; nothing was written`, { params: { pack: entry.name, status: response.status }, detail: `HTTP ${response.status} ${url}` })
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const gotSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (gotSha !== entry.tarballSha256) {
    throw new CodedError('integrityFailed', `integrity check failed for "${entry.name}": the market index says ${entry.tarballSha256}, the download hashes to ${gotSha}; nothing was written`, { params: { pack: entry.name, why: 'tarball sha256 mismatch' } })
  }
  return bytes
}

/** Extract the tgz and return the pack directory inside (root, or the single top-level dir). */
async function extractPackDir(tgzPath: string, extractDir: string, name: string): Promise<string> {
  try {
    await execFileAsync('tar', ['-xzf', tgzPath, '-C', extractDir])
  } catch (error) {
    throw new CodedError('updateFailed', `pack "${name}" tarball extraction failed (is tar on PATH?): ${(error as Error).message}; nothing was written`, { params: { pack: name }, detail: (error as Error).message })
  }
  const hasManifest = async (dir: string): Promise<boolean> => {
    try {
      await stat(join(dir, 'manifest.json'))
      return true
    } catch {
      return false
    }
  }
  let packDir = extractDir
  if (!(await hasManifest(packDir))) {
    const dirents = await readdir(extractDir, { withFileTypes: true })
    const dirs = dirents.filter(d => d.isDirectory())
    const sole = dirs.length === 1 ? dirs[0] : undefined
    if (sole === undefined) {
      throw new CodedError('integrityFailed', `the "${name}" archive has no single pack directory; nothing was written`, { params: { pack: name, why: 'archive layout' } })
    }
    packDir = join(extractDir, sole.name)
    if (!(await hasManifest(packDir))) {
      throw new CodedError('integrityFailed', `the "${name}" archive contains no manifest.json; nothing was written`, { params: { pack: name, why: 'no manifest' } })
    }
  }
  return packDir
}

/**
 * Update one packsDir pack from the market: download, verify (tarball sha256
 * → archive manifest name → extracted content hash), stage beside the
 * destination, swap, reload the pack map in place. A verification failure
 * aborts before the swap; a reload failure after the swap keeps the new
 * files on disk and surfaces reloadFailed (the running tools keep the old
 * spec until a successful reload — the established params-writes contract).
 * @returns the installed version.
 */
export async function updatePack(deps: {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir?: string | undefined
  readonly marketUrl: string
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
  readonly fetchImpl?: typeof fetch
}, name: string): Promise<string> {
  if (deps.packsDir === undefined || deps.packsDir.length === 0) {
    throw new CodedError('packNotManaged', `pack "${name}" is not managed here: no packsDir is configured, and builtin packs ship with the plugin package; nothing was written`, { params: { pack: name } })
  }
  const dest = await resolveManagedPackDir(deps.packsDir, name)
  let index: MarketIndex
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${deps.marketUrl}/api/index`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    index = await response.json() as MarketIndex
  } catch (error) {
    throw new CodedError('marketUnreachable', `could not reach the pack market at ${deps.marketUrl} (${(error as Error).message}); nothing was written`, { params: { url: deps.marketUrl }, detail: (error as Error).message })
  }
  const entry = index.packs.find(e => e.name === name)
  if (entry === undefined) {
    throw new CodedError('absentFromMarket', `pack "${name}" is not listed on the market at ${deps.marketUrl}, so there is nothing to update from; nothing was written. Publish it there first, or install it into the packsDir directly`, { params: { pack: name, url: deps.marketUrl } })
  }
  const packsDir = deps.packsDir
  return swapFromMarket({ ...deps, packsDir }, name, entry, dest)
}

/** The shared download → verify → stage → swap → reload pipeline behind
 * updatePack and installPack (the params-writes hot-swap contract: the SAME
 * Map instance the tools hold, so the change is visible mid-session). */
async function swapFromMarket(deps: {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir: string
  readonly marketUrl: string
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
  readonly fetchImpl?: typeof fetch
}, name: string, entry: MarketIndexEntry, dest: string): Promise<string> {
  const bytes = await fetchTarball(deps.marketUrl, entry, deps.fetchImpl ?? fetch)
  const staging = join(deps.packsDir, `.${name}.staging`)
  const tmpRoot = await mkdtemp(join(tmpdir(), `docwright-update-${name}-`))
  let installedVersion = ''
  try {
    const tgzPath = join(tmpRoot, 'pack.tgz')
    await writeFile(tgzPath, bytes)
    const extractDir = join(tmpRoot, 'x')
    await execFileAsync('mkdir', ['-p', extractDir])
    const packDir = await extractPackDir(tgzPath, extractDir, name)
    let manifest: { name?: unknown; version?: unknown }
    try {
      manifest = JSON.parse(await readFile(join(packDir, 'manifest.json'), 'utf8')) as { name?: unknown; version?: unknown }
    } catch (error) {
      throw new CodedError('integrityFailed', `the "${name}" archive manifest is not valid JSON (${(error as Error).message}); nothing was written`, { params: { pack: name, why: 'manifest not parseable' }, detail: (error as Error).message })
    }
    if (manifest.name !== name) {
      throw new CodedError('integrityFailed', `integrity mismatch for "${name}": the market index serves an archive whose manifest declares "${String(manifest.name)}"; nothing was written`, { params: { pack: name, why: 'manifest name mismatch' } })
    }
    const hash = await dirHash(packDir)
    if (hash !== entry.contentHash) {
      throw new CodedError('integrityFailed', `content hash mismatch for "${name}": the market index says ${entry.contentHash}, the archive hashes to ${hash}; nothing was written`, { params: { pack: name, why: 'content hash mismatch' } })
    }
    // Atomic-ish landing (install.mjs parity): stage inside the packsDir so
    // the final rename stays on one filesystem, then swap.
    await rm(staging, { recursive: true, force: true })
    await cp(packDir, staging, { recursive: true })
    await rm(dest, { recursive: true, force: true })
    await rename(staging, dest)
    installedVersion = typeof manifest.version === 'string' ? manifest.version : String(manifest.version)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
  await reloadPacksInPlace(deps)
  return installedVersion
}

/** One landed pack of an install. */
export interface InstallOutcome {
  readonly name: string
  readonly version: string
  readonly dest: string
  /** True when a pack directory declaring this manifest name already existed. */
  readonly existed: boolean
  /** True when the installed version already matched the market — nothing was downloaded. */
  readonly unchanged?: boolean
}

/**
 * The install closure of `requested`: the pack plus its transitive consumed
 * upstreams, dependencies first — the unit "installing a chain pack" actually
 * lands. A consumes target that is neither on the market nor installed
 * locally fails loud naming the requester.
 */
export function resolveInstallClosure(index: MarketIndex, requested: string, installedLocally: ReadonlySet<string>): readonly MarketIndexEntry[] {
  const byName = new Map(index.packs.map(e => [e.name, e]))
  const order: MarketIndexEntry[] = []
  const seen = new Set<string>()
  const visit = (name: string, requester: string | undefined): void => {
    if (seen.has(name)) return
    seen.add(name)
    const entry = byName.get(name)
    if (entry === undefined) {
      if (installedLocally.has(name)) return // satisfied locally (installed pack or builtin-merged)
      throw new CodedError('absentFromMarket', `pack "${requested}" needs "${name}" (consumes chain${requester !== undefined ? ` of "${requester}"` : ''}), but it is neither listed on the market nor installed; nothing was written`, { params: { pack: requested } })
    }
    for (const up of consumesOf(entry)) visit(up, name)
    order.push(entry)
  }
  visit(requested, undefined)
  return order
}

/**
 * Install a pack from the market into the packsDir (the doc_market_install
 * lane): the CONSUMES CLOSURE is the unit — the requested pack plus its
 * transitive upstreams land behind one caller-owned confirmation gate, then
 * ONE in-place reload makes all of them visible mid-session. Members whose
 * installed version already matches the market are skipped (unchanged);
 * installing an existing name updates it in place.
 */
export async function installPack(deps: {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir?: string | undefined
  readonly marketUrl: string
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
  readonly fetchImpl?: typeof fetch
}, name: string): Promise<{ installed: readonly InstallOutcome[] }> {
  if (deps.packsDir === undefined || deps.packsDir.length === 0) {
    throw new CodedError('packNotManaged', `pack "${name}" cannot be installed: no packsDir is configured (set config.packsDir — packs install there and join the builtin merge)`, { params: { pack: name } })
  }
  let index: MarketIndex
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${deps.marketUrl}/api/index`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    index = await response.json() as MarketIndex
  } catch (error) {
    throw new CodedError('marketUnreachable', `could not reach the pack market at ${deps.marketUrl} (${(error as Error).message}); nothing was written`, { params: { url: deps.marketUrl }, detail: (error as Error).message })
  }
  const closure = resolveInstallClosure(index, name, new Set(deps.packs.keys()))
  const outcomes: InstallOutcome[] = []
  try {
    for (const entry of closure) {
      const local = deps.packs.get(entry.name)
      const existing = await findManagedPackDir(deps.packsDir, entry.name)
      if (local !== undefined && existing !== undefined && local.manifest.version === entry.version) {
        outcomes.push({ name: entry.name, version: entry.version, dest: existing, existed: true, unchanged: true })
        continue
      }
      const dest = existing ?? join(deps.packsDir, entry.name)
      const version = await swapFromMarket({ ...deps, packsDir: deps.packsDir }, entry.name, entry, dest)
      outcomes.push({ name: entry.name, version, dest, existed: existing !== undefined })
    }
  } catch (error) {
    // Members before the failure landed on disk; reload so the session sees
    // the partial install instead of a stale map, then surface the failure.
    await reloadPacksInPlace(deps).catch(() => {})
    throw error
  }
  await reloadPacksInPlace(deps)
  return { installed: outcomes }
}

/** Manifest-name scan without the throw (install's existing-vs-new branch).
 * A packsDir that does not exist yet simply has no existing pack — the swap
 * stage creates it (staging copy + rename). */
async function findManagedPackDir(packsDir: string, name: string): Promise<string | undefined> {
  let entries: Dirent[]
  try {
    entries = await readdir(packsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
    const dir = join(packsDir, dirent.name)
    if (await manifestNameOf(dir) === name) return dir
  }
  return undefined
}

/** Hot-swap the pack map in place (params-writes contract: the SAME Map instance the tools hold). */
async function reloadPacksInPlace(deps: {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir?: string | undefined
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
}): Promise<void> {
  let reloaded: ReadonlyMap<string, Pack>
  try {
    reloaded = await deps.loadPacks(deps.builtinRoot, { extra: deps.packsDir === undefined ? undefined : [deps.packsDir] })
  } catch (error) {
    throw new CodedError('reloadFailed', `packs updated on disk, but reloading failed: ${(error as Error).message}; the running tools keep the previous configuration until a successful reload`, { detail: (error as Error).message })
  }
  deps.packs.clear()
  for (const [name, loaded] of reloaded) deps.packs.set(name, loaded)
}

/**
 * Delete one packsDir pack: resolve by manifest name, remove the directory,
 * reload in place (which also restores a same-name builtin override if one
 * exists). Chained packs that consume the deleted name keep loading; their
 * next generation fails loud on the missing upstream.
 */
export async function deletePack(deps: {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir?: string | undefined
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
}, name: string): Promise<void> {
  if (deps.packsDir === undefined || deps.packsDir.length === 0) {
    throw new CodedError('packNotManaged', `pack "${name}" is not managed here: no packsDir is configured, and builtin packs ship with the plugin package; nothing was written`, { params: { pack: name } })
  }
  const dir = await resolveManagedPackDir(deps.packsDir, name)
  await rm(dir, { recursive: true, force: true })
  await reloadPacksInPlace(deps)
}
