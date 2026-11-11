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
}, onlyPack?: string | undefined): Promise<readonly PackUpdateStatus[]> {
  if (deps.packsDir === undefined || deps.packsDir.length === 0) return []
  const managed = [...deps.packs.values()].filter(p => p.origin.kind === 'packsDir' && (onlyPack === undefined || p.manifest.name === onlyPack))
  if (managed.length === 0) return []
  // Single-pack check: the market's per-pack detail endpoint answers exactly
  // one record — no catalog-wide index fetch for one card.
  if (onlyPack !== undefined) {
    const pack = managed[0]!
    try {
      const response = await (deps.fetchImpl ?? fetch)(`${deps.marketUrl}/api/packs/${encodeURIComponent(onlyPack)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
      if (response.status === 404) {
        return [{ name: onlyPack, localVersion: pack.manifest.version, onMarket: false, updateAvailable: false }]
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { pack?: { version?: unknown } }
      const marketVersion = typeof body.pack?.version === 'string' ? body.pack.version : undefined
      return [{
        name: onlyPack,
        localVersion: pack.manifest.version,
        onMarket: marketVersion !== undefined,
        ...(marketVersion !== undefined ? { marketVersion } : {}),
        updateAvailable: marketVersion !== undefined && compareVersions(marketVersion, pack.manifest.version) > 0,
      }]
    } catch (error) {
      throw new CodedError('marketUnreachable', `could not check "${onlyPack}" against the pack market at ${deps.marketUrl} (${(error as Error).message}); showing local state only`, { params: { url: deps.marketUrl }, detail: (error as Error).message })
    }
  }
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
  const packsDir = deps.packsDir
  const outcomes = await landClosure({ ...deps, packsDir }, closure, name)
  return { installed: outcomes }
}

/** Land a resolved closure (dependencies first): members already installed at
 * the market version are skipped; every other member downloads, verifies, and
 * swaps. One in-place reload makes ALL of them visible mid-session. A
 * mid-closure failure keeps the already-landed members on disk, reloads so
 * the session sees the partial install, and surfaces the failing member. */
async function landClosure(deps: {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir: string
  readonly marketUrl: string
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
  readonly fetchImpl?: typeof fetch
}, closure: readonly MarketIndexEntry[], requester: string): Promise<readonly InstallOutcome[]> {
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
  return outcomes
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
}, name: string, opts: { force?: boolean } = {}): Promise<void> {
  if (deps.packsDir === undefined || deps.packsDir.length === 0) {
    throw new CodedError('packNotManaged', `pack "${name}" is not managed here: no packsDir is configured, and builtin packs ship with the plugin package; nothing was written`, { params: { pack: name } })
  }
  // Deleting a pack other installed packs consume breaks their chains (their
  // next generation loses the upstream stage). Refuse unless the caller
  // explicitly forces it; the UI's second confirm click is that force.
  const consumers = [...deps.packs.values()]
    .filter(p => p.manifest.name !== name && p.manifest.consumes.includes(name))
    .map(p => p.manifest.name)
    .sort()
  if (consumers.length > 0 && opts.force !== true) {
    throw new CodedError('packInUse', `pack "${name}" is consumed by installed packs (${consumers.join(', ')}); deleting it breaks their chains. Re-call with force: true to delete anyway, or keep it`, { params: { pack: name, consumers: consumers.join(', ') } })
  }
  const dir = await resolveManagedPackDir(deps.packsDir, name)
  await rm(dir, { recursive: true, force: true })
  await reloadPacksInPlace(deps)
}

/** One market suite record (GET /api/suites rows and /api/suites/{name}). */
interface MarketSuiteRecord {
  readonly name?: unknown
  readonly version?: unknown
  readonly description?: unknown
  readonly category?: unknown
  readonly members?: unknown
}

export interface SuiteDetail {
  readonly name: string
  readonly version: string
  readonly description: unknown
  readonly category: string
  readonly members: readonly string[]
}

function suiteRecordOf(record: MarketSuiteRecord): SuiteDetail {
  return {
    name: typeof record.name === 'string' ? record.name : '',
    version: typeof record.version === 'string' ? record.version : '',
    description: record.description,
    category: typeof record.category === 'string' ? record.category : '',
    members: Array.isArray(record.members) ? record.members.filter((m): m is string => typeof m === 'string') : [],
  }
}

/** GET /api/suites/{name}: null on a 404 (an old market or an unknown suite
 * — the caller words the error), CodedError marketUnreachable on fetch or
 * server failures. */
async function fetchSuiteDetail(marketUrl: string, suite: string, fetchImpl: typeof fetch): Promise<SuiteDetail | null> {
  let response: Response
  let body: unknown
  try {
    response = await fetchImpl(`${marketUrl}/api/suites/${encodeURIComponent(suite)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (response.status === 404) return null
    body = await response.json()
  } catch (error) {
    throw new CodedError('marketUnreachable', `could not reach the pack market at ${marketUrl} (${(error as Error).message}); nothing was written`, { params: { url: marketUrl }, detail: (error as Error).message })
  }
  if (!response.ok) {
    throw new CodedError('marketUnreachable', `could not read suite "${suite}" from the pack market at ${marketUrl} (HTTP ${response.status}); nothing was written`, { params: { url: marketUrl }, detail: `HTTP ${response.status}` })
  }
  // The market wraps the detail: { ok, suite: {name, version, ..., members},
  // members: expanded cards }. The suite record carries the member NAME list.
  const suiteBody = body !== null && typeof body === 'object' ? (body as { suite?: unknown }).suite : undefined
  if (suiteBody === undefined || suiteBody === null || typeof suiteBody !== 'object') {
    return null
  }
  return suiteRecordOf(suiteBody as MarketSuiteRecord)
}

/** Suite-absent error (old market or unknown suite): same family as a pack
 * absent from the market — problem + cause + fix, nothing written. */
function suiteAbsentError(suite: string, marketUrl: string): CodedError {
  return new CodedError('absentFromMarket', `suite "${suite}" is not offered by the pack market at ${marketUrl} (the market may not support suites, or the suite name is wrong); nothing was written`, { params: { pack: suite, url: marketUrl } })
}

/**
 * The merged install closure of a SUITE: every member's resolveInstallClosure
 * over ONE shared visit set, so a pack consumed by several members lands once
 * and dependencies stay first. A needed name that is neither on the market
 * nor installed locally fails loud naming the suite.
 */
export function resolveSuiteInstallClosure(index: MarketIndex, suite: SuiteDetail, installedLocally: ReadonlySet<string>): readonly MarketIndexEntry[] {
  const byName = new Map(index.packs.map(e => [e.name, e]))
  const order: MarketIndexEntry[] = []
  const seen = new Set<string>()
  const visit = (name: string, requester: string | undefined): void => {
    if (seen.has(name)) return
    seen.add(name)
    const entry = byName.get(name)
    if (entry === undefined) {
      if (installedLocally.has(name)) return // satisfied locally (installed pack or builtin-merged)
      throw new CodedError('absentFromMarket', `suite "${suite.name}" needs "${name}" (${requester === undefined ? 'a member' : `consumes chain of "${requester}"`}), but it is neither listed on the market nor installed; nothing was written`, { params: { pack: name } })
    }
    for (const up of consumesOf(entry)) visit(up, name)
    order.push(entry)
  }
  for (const member of suite.members) visit(member, undefined)
  return order
}

/**
 * Install a suite from the market into the packsDir (the doc_market_install
 * suite lane): the UNIT is the merged closure of all members — each member
 * plus its transitive consumed upstreams, deduplicated, dependencies first,
 * behind one caller-owned confirmation gate, then ONE in-place reload makes
 * everything visible mid-session. Members already installed at the market
 * version are skipped (unchanged), so retrying a partially failed install
 * only lands what is missing.
 */
export async function installSuite(deps: {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir?: string | undefined
  readonly marketUrl: string
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
  readonly fetchImpl?: typeof fetch
}, suite: string): Promise<{ suite: SuiteDetail; installed: readonly InstallOutcome[] }> {
  if (deps.packsDir === undefined || deps.packsDir.length === 0) {
    throw new CodedError('packNotManaged', `suite "${suite}" cannot be installed: no packsDir is configured (set config.packsDir — packs install there and join the builtin merge)`, { params: { pack: suite } })
  }
  let index: MarketIndex
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${deps.marketUrl}/api/index`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    index = await response.json() as MarketIndex
  } catch (error) {
    throw new CodedError('marketUnreachable', `could not reach the pack market at ${deps.marketUrl} (${(error as Error).message}); nothing was written`, { params: { url: deps.marketUrl }, detail: (error as Error).message })
  }
  const detail = await fetchSuiteDetail(deps.marketUrl, suite, deps.fetchImpl ?? fetch)
  if (detail === null || detail.members.length === 0) throw suiteAbsentError(suite, deps.marketUrl)
  const closure = resolveSuiteInstallClosure(index, detail, new Set(deps.packs.keys()))
  const installed = await landClosure({ ...deps, packsDir: deps.packsDir }, closure, suite)
  return { suite: detail, installed }
}

/**
 * Update a suite: every member that is installed locally and has a newer
 * market version goes through the existing updatePack pipeline; members
 * already current stay untouched; members missing locally (or no longer on
 * the market) are reported, not installed — installing is the suite lane's
 * job, updating only refreshes what is there.
 */
export async function updateSuite(deps: {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir?: string | undefined
  readonly marketUrl: string
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
  readonly fetchImpl?: typeof fetch
}, suite: string): Promise<{ suite: SuiteDetail; updated: readonly { name: string; version: string }[]; unchanged: readonly string[]; missing: readonly string[] }> {
  const detail = await fetchSuiteDetail(deps.marketUrl, suite, deps.fetchImpl ?? fetch)
  if (detail === null || detail.members.length === 0) throw suiteAbsentError(suite, deps.marketUrl)
  let index: MarketIndex
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${deps.marketUrl}/api/index`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    index = await response.json() as MarketIndex
  } catch (error) {
    throw new CodedError('marketUnreachable', `could not reach the pack market at ${deps.marketUrl} (${(error as Error).message}); nothing was written`, { params: { url: deps.marketUrl }, detail: (error as Error).message })
  }
  const byName = new Map(index.packs.map(e => [e.name, e]))
  const updated: { name: string; version: string }[] = []
  const unchanged: string[] = []
  const missing: string[] = []
  for (const member of detail.members) {
    const entry = byName.get(member)
    const local = deps.packs.get(member)
    const existing = await findManagedPackDir(deps.packsDir ?? '', member)
    if (entry === undefined || local === undefined || existing === undefined) {
      missing.push(member)
      continue
    }
    if (compareVersions(entry.version, local.manifest.version) <= 0) {
      unchanged.push(member)
      continue
    }
    updated.push({ name: member, version: await updatePack(deps, member) })
  }
  return { suite: detail, updated, unchanged, missing }
}

/**
 * Delete a suite: the installed members are the unit. A member that packs
 * OUTSIDE the suite consume is kept (its consumer's chain would break); the
 * rest go through the existing deletePack — force: true internally, because
 * sibling suite members legitimately consume each other and the per-pack
 * packInUse guard must not fire on them. With opts.force the kept members go
 * too (the single-pack force semantics: downstream packs keep loading and
 * fail loud on their next generation). Members never installed are skipped;
 * the market only supplies the member list.
 */
export async function deleteSuite(deps: {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir?: string | undefined
  readonly marketUrl: string
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
  readonly fetchImpl?: typeof fetch
}, suite: string, opts: { force?: boolean } = {}): Promise<{ deleted: readonly string[]; kept: readonly { name: string; consumers: readonly string[] }[] }> {
  const detail = await fetchSuiteDetail(deps.marketUrl, suite, deps.fetchImpl ?? fetch)
  if (detail === null || detail.members.length === 0) throw suiteAbsentError(suite, deps.marketUrl)
  const memberSet = new Set(detail.members)
  const consumersOf = (name: string): string[] => [...deps.packs.values()]
    .filter(p => p.manifest.name !== name && !memberSet.has(p.manifest.name) && p.manifest.consumes.includes(name))
    .map(p => p.manifest.name).sort()
  const deleted: string[] = []
  const kept: { name: string; consumers: readonly string[] }[] = []
  for (const member of detail.members) {
    const installed = deps.packs.has(member) && await findManagedPackDir(deps.packsDir ?? '', member) !== undefined
    if (!installed) continue
    const consumers = consumersOf(member)
    if (consumers.length > 0 && opts.force !== true) {
      kept.push({ name: member, consumers })
      continue
    }
    await deletePack(deps, member, { force: true })
    deleted.push(member)
  }
  return { deleted, kept }
}

/** Per-member standing of one suite against the local packsDir and the
 * market index (the settings page's Suites tab rows). */
export interface SuiteMemberStatus {
  readonly name: string
  readonly localVersion?: string
  readonly marketVersion?: string
  /** True when the member is neither installed locally nor on the market. */
  readonly missing: boolean
  readonly updateAvailable: boolean
}

export interface SuiteStatus {
  readonly name: string
  readonly version: string
  readonly description: unknown
  readonly category: string
  readonly members: readonly SuiteMemberStatus[]
  /** True when at least one member pack is not installed. */
  readonly incomplete: boolean
  readonly updateAvailable: boolean
}

/**
 * Suite standing for the settings UI: the market's suite list projected onto
 * the local packsDir (per-member local vs market version, missing members,
 * update availability). A market that does not know suites answers an EMPTY
 * list (the UI shows one explanatory line, no error); an unreachable market
 * throws marketUnreachable (the route degrades to a coded 200 envelope).
 */
export async function checkSuiteStatus(deps: {
  readonly packs: ReadonlyMap<string, Pack>
  readonly packsDir?: string | undefined
  readonly marketUrl: string
  readonly fetchImpl?: typeof fetch
}): Promise<readonly SuiteStatus[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  let rows: MarketSuiteRecord[]
  try {
    const response = await fetchImpl(`${deps.marketUrl}/api/suites`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (response.status === 404) return [] // old market: the suite lane simply has nothing to show
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as { suites?: unknown }
    rows = Array.isArray(body.suites) ? body.suites as MarketSuiteRecord[] : []
  } catch (error) {
    throw new CodedError('marketUnreachable', `could not reach the pack market at ${deps.marketUrl} (${(error as Error).message}); suite status is unavailable`, { params: { url: deps.marketUrl }, detail: (error as Error).message })
  }
  let index: MarketIndex
  try {
    const response = await fetchImpl(`${deps.marketUrl}/api/index`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    index = await response.json() as MarketIndex
  } catch (error) {
    throw new CodedError('marketUnreachable', `could not reach the pack market at ${deps.marketUrl} (${(error as Error).message}); suite status is unavailable`, { params: { url: deps.marketUrl }, detail: (error as Error).message })
  }
  const marketVersions = new Map(index.packs.map(e => [e.name, e.version]))
  // Local placement is the packsDir scan (manifest-name keyed) — NOT the
  // loaded pack map, which also contains builtin packs a suite member must
  // not be credited against.
  const localVersions = new Map<string, string>()
  if (deps.packsDir !== undefined && deps.packsDir.length > 0) {
    let entries: Dirent[]
    try {
      entries = await readdir(deps.packsDir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const dirent of entries) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
      const dir = join(deps.packsDir, dirent.name)
      const manifest = await manifestNameOf(dir)
      if (manifest === null || localVersions.has(manifest)) continue
      try {
        const read = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { version?: unknown }
        if (typeof read.version === 'string') localVersions.set(manifest, read.version)
      } catch { /* unparseable manifest version: treat as absent */ }
    }
  }
  return rows.map(record => {
    const suite = suiteRecordOf(record)
    const members: SuiteMemberStatus[] = suite.members.map(member => {
      const localVersion = localVersions.get(member)
      const marketVersion = marketVersions.get(member)
      return {
        name: member,
        ...(localVersion === undefined ? {} : { localVersion }),
        ...(marketVersion === undefined ? {} : { marketVersion }),
        missing: localVersion === undefined && marketVersion === undefined,
        updateAvailable: localVersion !== undefined && marketVersion !== undefined && compareVersions(marketVersion, localVersion) > 0,
      }
    })
    return {
      name: suite.name,
      version: suite.version,
      description: suite.description,
      category: suite.category,
      members,
      incomplete: members.some(m => m.localVersion === undefined),
      updateAvailable: members.some(m => m.updateAvailable),
    }
  })
}
