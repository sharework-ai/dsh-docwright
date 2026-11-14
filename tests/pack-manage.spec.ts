import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPackUpdates, checkSuiteStatus, compareVersions, deletePack, deleteSuite, dirHash, installPack, installSuite, resolveManagedPackDir, resolveSuiteInstallClosure, updatePack, updateSuite } from '../src/pack-manage.ts'
import { loadPacks } from '../src/pack-loader.ts'
import type { Pack } from '../src/pack.ts'

const execFileAsync = promisify(execFile)

/** A minimal valid pack (the loader fully validates it on every reload). */
async function packFixture(root: string, name: string, version: string): Promise<string> {
  const dir = join(root, name)
  for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    name, version, description: 'd', consumes: [], languages: ['zh-CN'],
    params: { limit: { type: 'number', default: 3, min: 1, max: 20, description: 'd' } },
  }), 'utf8')
  await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify([
    { id: `${name}/name-shape`, severity: 'error', given: '$', field: 'name', kind: 'pattern', pattern: '^.+$', mustMatch: true, suggestion: 's' },
  ]), 'utf8')
  await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
  await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
  await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
  await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
  return dir
}

interface ManagedDeps {
  readonly packs: Map<string, Pack>
  readonly builtinRoot: string
  readonly packsDir: string
  readonly marketUrl: string
  readonly loadPacks: (builtinRoot: string, dirs: { extra?: readonly string[] | undefined }) => Promise<ReadonlyMap<string, Pack>>
}

async function managedFixture(): Promise<{ deps: ManagedDeps; root: string; packsDir: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'docwright-manage-builtin-'))
  const packsDir = await mkdtemp(join(tmpdir(), 'docwright-manage-extra-'))
  await packFixture(root, 'wp', '1')
  await packFixture(packsDir, 'ext', '1')
  const packs = new Map(await loadPacks(root, { extra: [packsDir] }))
  return {
    packs,
    packsDir,
    dispose: async () => {
      await rm(root, { recursive: true, force: true })
      await rm(packsDir, { recursive: true, force: true })
    },
    deps: { packs, builtinRoot: root, packsDir, marketUrl: '', loadPacks: (r, d) => loadPacks(r, d) },
  }
}

/** A fake market: GET /api/index serves the given entries; GET /tarballs/<file> serves the built tarballs. */
async function marketServer(entries: readonly { name: string; version: string; dir?: string; consumes?: readonly string[] }[]): Promise<{ url: string; dispose: () => Promise<void>; tarballs: Map<string, Buffer> }> {
  const tarballs = new Map<string, Buffer>()
  const index = { ok: true, packs: [] as Record<string, unknown>[] }
  for (const entry of entries) {
    if (entry.dir === undefined) {
      index.packs.push({ name: entry.name, version: entry.version, tarball: `/tarballs/${entry.name}-${entry.version}.tgz`, tarballSha256: 'sha256:bogus', contentHash: 'sha256:bogus', consumes: entry.consumes ?? [] })
      continue
    }
    const tgz = join(entry.dir, '..', `${entry.name}-${entry.version}.tgz`)
    await execFileAsync('tar', ['-czf', tgz, '-C', entry.dir, '.'])
    const bytes = await readFile(tgz)
    tarballs.set(`/tarballs/${entry.name}-${entry.version}.tgz`, bytes)
    index.packs.push({
      name: entry.name,
      version: entry.version,
      tarball: `/tarballs/${entry.name}-${entry.version}.tgz`,
      tarballSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      contentHash: await dirHash(entry.dir),
      consumes: entry.consumes ?? [],
    })
  }
  const server: Server = createServer((request, response) => {
    if (request.url === '/api/index') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(index))
      return
    }
    const bytes = request.url !== undefined ? tarballs.get(request.url) : undefined
    if (bytes === undefined) {
      response.writeHead(404)
      response.end('no such tarball')
      return
    }
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(bytes)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no local port')
  return { url: `http://127.0.0.1:${address.port}`, dispose: async () => server.close(), tarballs }
}

const marketStack: { dispose: () => Promise<void> }[] = []
afterEach(async () => {
  while (marketStack.length > 0) await marketStack.pop()?.dispose()
})

describe('compareVersions', () => {
  it('compares numerically per segment and treats missing segments as zero', () => {
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('0.3.0', '0.3.1')).toBeLessThan(0)
  })
})

describe('resolveManagedPackDir', () => {
  it('finds a pack directory by manifest name and refuses unknown names loudly', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    expect(await resolveManagedPackDir(fx.packsDir, 'ext')).toBe(join(fx.packsDir, 'ext'))
    await expect(resolveManagedPackDir(fx.packsDir, 'ghost')).rejects.toThrow(/not managed here.*managed: ext/)
  })
})

describe('checkPackUpdates', () => {
  it('reports update-available, up-to-date, and not-on-market rows in one fetch', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '2')
    const stray = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'stray', '9')
    const market = await marketServer([{ name: 'ext', version: '2', dir: newer }, { name: 'stray', version: '9', dir: stray }])
    fx.deps.marketUrl = market.url
    const rows = await checkPackUpdates(fx.deps)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'ext', localVersion: '1', marketVersion: '2', onMarket: true, updateAvailable: true })
    const stale = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '1')
    const marketOld = await marketServer([{ name: 'ext', version: '1', dir: stale }])
    fx.deps.marketUrl = marketOld.url
    const rowsOld = await checkPackUpdates(fx.deps)
    expect(rowsOld[0]).toMatchObject({ marketVersion: '1', onMarket: true, updateAvailable: false })
    // A market that does not list the pack at all: the row stays explicit.
    const marketOther = await marketServer([{ name: 'stray', version: '9' }])
    fx.deps.marketUrl = marketOther.url
    const rowsAbsent = await checkPackUpdates(fx.deps)
    expect(rowsAbsent[0]).toMatchObject({ name: 'ext', onMarket: false, updateAvailable: false })
    expect(rowsAbsent[0].marketVersion).toBeUndefined()
    const empty = await checkPackUpdates({ ...fx.deps, packsDir: undefined })
    expect(empty).toEqual([])
  })

  it('fails the whole check with marketUnreachable when the index cannot be fetched', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    fx.deps.marketUrl = 'http://127.0.0.1:1'
    await expect(checkPackUpdates(fx.deps)).rejects.toThrow(/could not reach the pack market/)
  })
})

describe('updatePack', () => {
  it('downloads a verified tarball, swaps the directory, and hot-reloads the pack map in place', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '2')
    const market = await marketServer([{ name: 'ext', version: '2', dir: newer }])
    fx.deps.marketUrl = market.url
    const packsRef = fx.deps.packs
    const version = await updatePack(fx.deps, 'ext')
    expect(version).toBe('2')
    expect(fx.deps.packs).toBe(packsRef)
    expect(fx.deps.packs.get('ext')?.manifest.version).toBe('2')
    const names = (await readdir(fx.packsDir)).filter(n => !n.startsWith('.'))
    expect(names).toEqual(['ext'])
  })

  it('aborts with integrityFailed and keeps the old directory when the tarball sha does not match the index', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '2')
    // A market whose index lies about the tarball sha (compromised/rolled-back
    // index): the genuine tarball still serves, but the update must refuse.
    const market = await marketServer([{ name: 'ext', version: '2', dir: newer }])
    const lie = { ok: true, packs: [{ name: 'ext', version: '2', tarball: '/tarballs/ext-2.tgz', tarballSha256: `sha256:${'0'.repeat(64)}`, contentHash: await dirHash(newer) }] }
    const raw = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(lie))
    })
    await new Promise<void>(resolve => raw.listen(0, '127.0.0.1', resolve))
    const rawAddress = raw.address()
    if (rawAddress === null || typeof rawAddress === 'string') throw new Error('no port')
    marketStack.push({ dispose: async () => raw.close() })
    const genuineFetch = fetch
    fx.deps.fetchImpl = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/index')) return new Response(JSON.stringify(lie), { headers: { 'content-type': 'application/json' } })
      return genuineFetch(`${market.url}${url.replace(fx.deps.marketUrl, '')}`, init)
    }
    fx.deps.marketUrl = `http://127.0.0.1:${rawAddress.port}`
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/integrity check failed/)
    expect(fx.deps.packs.get('ext')?.manifest.version).toBe('1')
  })

  it('aborts with integrityFailed when the archive content hash disagrees with the index', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '2')
    const market = await marketServer([{ name: 'ext', version: '2', dir: newer }])
    // A lying contentHash (index captured a different revision than the
    // served tarball): the sha256 passes, the content check must refuse.
    const genuineFetch = fetch
    fx.deps.fetchImpl = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/index')) {
        const genuine = await (await genuineFetch(`${market.url}/api/index`, { headers: { accept: 'application/json' } })).json() as { packs: { contentHash: string }[] }
        genuine.packs[0].contentHash = 'sha256:deadbeef'
        return new Response(JSON.stringify(genuine), { headers: { 'content-type': 'application/json' } })
      }
      return genuineFetch(input, init)
    }
    fx.deps.marketUrl = market.url
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/content hash mismatch/)
    expect(fx.deps.packs.get('ext')?.manifest.version).toBe('1')
  })

  it('refuses non-managed packs: no packsDir configured, unknown name, or absent from the market', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const market = await marketServer([])
    fx.deps.marketUrl = market.url
    await expect(updatePack({ ...fx.deps, packsDir: undefined }, 'ext')).rejects.toThrow(/no packsDir is configured/)
    await expect(updatePack(fx.deps, 'ghost')).rejects.toThrow(/not managed here/)
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/not listed on the market/)
  })
})

describe('deletePack', () => {
  it('removes the directory and hot-reloads without the pack', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    await deletePack(fx.deps, 'ext')
    expect(fx.deps.packs.has('ext')).toBe(false)
    expect(fx.deps.packs.has('wp')).toBe(true)
    const names = (await readdir(fx.packsDir)).filter(n => !n.startsWith('.'))
    expect(names).toEqual([])
  })

  it('surfaces reloadFailed after the directory is already gone (the documented contract)', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const broken = { ...fx.deps, loadPacks: async () => { throw new Error('boom') } }
    await expect(deletePack(broken, 'ext')).rejects.toThrow(/reloading failed/)
    expect(fx.deps.packs.has('ext')).toBe(true)
  })

  it('refuses when no packsDir is configured or the name matches nothing', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    await expect(deletePack({ ...fx.deps, packsDir: undefined }, 'ext')).rejects.toThrow(/no packsDir is configured/)
    await expect(deletePack(fx.deps, 'ghost')).rejects.toThrow(/not managed here/)
  })
})

describe('suite-member guard (single-pack lanes refuse suite members)', () => {
  it('refuses install, update, and delete of a pack a suite lists as a member, writing nothing', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-guard-')), 'ext', '2')
    const wpDir = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-guard-wp-')), 'wp', '1')
    const market = await suiteMarketServer([{ name: 'ext', version: '2', dir: newer }, { name: 'wp', version: '1', dir: wpDir }], [{ name: 'pair', version: '1', members: ['ext'] }])
    const deps = { ...fx.deps, marketUrl: market.url }
    marketStack.push(market)
    await expect(installPack(deps, 'ext')).rejects.toThrow(/suiteManaged|member of suite "pair"/)
    await expect(updatePack(deps, 'ext')).rejects.toThrow(/suiteManaged|member of suite "pair"/)
    await expect(deletePack(deps, 'ext')).rejects.toThrow(/suiteManaged|member of suite "pair"/)
    // Nothing was written: ext still installed at its old version.
    expect(fx.deps.packs.get('ext')?.manifest.version).toBe('1')
    // A pack NO suite lists stays manageable through every single-pack lane.
    await expect(installPack(deps, 'wp')).resolves.toBeTruthy()
  })

  it('fails open on an old market or an unreachable one (single-pack lanes keep working)', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-guard-open-')), 'ext', '2')
    const oldMarket = await marketServer([{ name: 'ext', version: '2', dir: newer }])
    marketStack.push(oldMarket)
    const version = await updatePack({ ...fx.deps, marketUrl: oldMarket.url }, 'ext')
    expect(version).toBe('2')
    await expect(deletePack(fx.deps, 'ext')).resolves.toBeUndefined()
  })

  it('lets the suite lanes manage their own members (bypass)', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-guard-bypass-')), 'ext', '2')
    const market = await suiteMarketServer([{ name: 'ext', version: '2', dir: newer }], [{ name: 's', version: '1', members: ['ext'] }])
    marketStack.push(market)
    const deps = { ...fx.deps, marketUrl: market.url }
    expect(await updateSuite(deps, 's').then(r => r.updated)).toEqual([{ name: 'ext', version: '2' }])
    const { deleted } = await deleteSuite(deps, 's')
    expect(deleted).toEqual(['ext'])
  })
})

describe('local suite record (packsDir/suites.json)', () => {
  it('writes the suite on install, refreshes member versions on update, and drops it on delete', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const parent = await mkdtemp(join(tmpdir(), 'docwright-suite-rec-'))
    marketStack.push({ dispose: async () => { await rm(parent, { recursive: true, force: true }) } })
    const extDir = await packFixture(parent, 'ext', '1')
    const market = await suiteMarketServer([{ name: 'ext', version: '1', dir: extDir }], [{ name: 's', version: '1', members: ['ext'] }])
    marketStack.push(market)
    const deps = { ...fx.deps, marketUrl: market.url }
    const recordPath = join(fx.packsDir, 'suites.json')

    await installSuite(deps, 's')
    let record = JSON.parse(await readFile(recordPath, 'utf8')) as { suites: { name: string; version: string; members: { name: string; version: string }[] }[] }
    expect(record.suites).toEqual([{ name: 's', version: '1', members: [{ name: 'ext', version: '1' }], updatedAt: expect.any(String) }])

    // Update bumps the member's recorded version (market has ext@2).
    const newer = await packFixture(parent, 'ext', '2')
    const market2 = await suiteMarketServer([{ name: 'ext', version: '2', dir: newer }], [{ name: 's', version: '2', members: ['ext'] }])
    marketStack.push(market2)
    await updateSuite({ ...fx.deps, marketUrl: market2.url }, 's')
    record = JSON.parse(await readFile(recordPath, 'utf8'))
    expect(record.suites[0]).toMatchObject({ name: 's', version: '2', members: [{ name: 'ext', version: '2' }] })

    // Delete removes the whole entry.
    await deleteSuite({ ...fx.deps, marketUrl: market2.url }, 's')
    record = JSON.parse(await readFile(recordPath, 'utf8'))
    expect(record.suites).toEqual([])
  })

  it('answers offline from the record instead of throwing', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const parent = await mkdtemp(join(tmpdir(), 'docwright-suite-off-'))
    marketStack.push({ dispose: async () => { await rm(parent, { recursive: true, force: true }) } })
    const extDir = await packFixture(parent, 'ext', '1')
    const market = await suiteMarketServer([{ name: 'ext', version: '1', dir: extDir }], [{ name: 's', version: '1', members: ['ext'] }])
    marketStack.push(market)
    const deps = { ...fx.deps, marketUrl: market.url }
    await installSuite(deps, 's')

    // Market down: the record answers — local versions, no update claims.
    const offline = await checkSuiteStatus({ packs: fx.packs, packsDir: fx.packsDir, marketUrl: 'http://127.0.0.1:1' })
    expect(offline).toHaveLength(1)
    expect(offline[0]).toMatchObject({ name: 's', version: '1', incomplete: false, updateAvailable: false })
    expect(offline[0]!.members[0]).toMatchObject({ name: 'ext', localVersion: '1', missing: false })
    expect(offline[0]!.members[0].marketVersion).toBeUndefined()

    // No record + unreachable market stays a loud failure.
    await rm(join(fx.packsDir, 'suites.json'))
    await expect(checkSuiteStatus({ packs: fx.packs, packsDir: fx.packsDir, marketUrl: 'http://127.0.0.1:1' })).rejects.toThrow(/marketUnreachable|could not reach/)
  })

  it('backfills the record on a successful online check (pre-record installs)', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const parent = await mkdtemp(join(tmpdir(), 'docwright-suite-bf-'))
    marketStack.push({ dispose: async () => { await rm(parent, { recursive: true, force: true }) } })
    const extDir = await packFixture(parent, 'ext', '1')
    const market = await suiteMarketServer([{ name: 'ext', version: '1', dir: extDir }], [{ name: 's', version: '1', members: ['ext'] }])
    marketStack.push(market)
    const deps = { ...fx.deps, marketUrl: market.url }
    // Simulate a pre-record install: member on disk, no suites.json.
    await installSuite(deps, 's')
    await rm(join(fx.packsDir, 'suites.json'))

    await checkSuiteStatus(deps)
    const record = JSON.parse(await readFile(join(fx.packsDir, 'suites.json'), 'utf8'))
    expect(record.suites).toEqual([{ name: 's', version: '1', members: [{ name: 'ext', version: '1' }], updatedAt: expect.any(String) }])
  })
})

describe('updatePack failure branches (integrity ladder coverage)', () => {
  it('maps tarball fetch refusal and download failure to their codes', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '2')
    const market = await marketServer([{ name: 'ext', version: '2', dir: newer }])
    // Refused connection -> marketUnreachable.
    fx.deps.marketUrl = 'http://127.0.0.1:1'
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/could not reach the pack market/)
    // Index ok but tarball 404s -> updateFailed with the status in the detail.
    const genuineFetch = fetch
    fx.deps.fetchImpl = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/index')) return genuineFetch(`${market.url}/api/index`, { headers: { accept: 'application/json' }, ...(init ?? {}) })
      return new Response('gone', { status: 404 })
    }
    fx.deps.marketUrl = market.url
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/tarball download failed \(HTTP 404\)/)
  })

  it('maps archive-shape failures to integrityFailed', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '2')
    const market = await marketServer([{ name: 'ext', version: '2', dir: newer }])
    const lie = (packs: unknown[]) => {
      const raw = createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, packs }))
      })
      marketStack.push({ dispose: async () => raw.close() })
      return new Promise<string>(resolve => { raw.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(raw.address() as { port: number }).port}`)) })
    }
    // The fetch stub serves a lying index plus EXACT tarball bytes we control,
    // so each integrity branch can be exercised independently.
    const withIndex = (packs: unknown[], tarball: Buffer) => {
      fx.deps.fetchImpl = async input => {
        const target = String(input)
        if (target.endsWith('/api/index')) return new Response(JSON.stringify({ ok: true, packs }), { headers: { 'content-type': 'application/json' } })
        return new Response(tarball, { headers: { 'content-type': 'application/gzip' } })
      }
    }
    const shaOf = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`
    const tarballBytes = market.tarballs.get('/tarballs/ext-2.tgz')!
    const baseEntry = { name: 'ext', version: '2', tarball: '/tarballs/ext-2.tgz', tarballSha256: shaOf(tarballBytes), contentHash: 'sha256:x' }
    await withIndex([baseEntry], tarballBytes)
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/content hash mismatch/)
    // Unparseable manifest + name mismatch + no-single-dir via raw tarballs.
    const rawTar = async (build: (dir: string) => Promise<void>): Promise<Buffer> => {
      const parent = await mkdtemp(join(tmpdir(), 'docwright-rawtar-'))
      const content = join(parent, 'content')
      await mkdir(content, { recursive: true })
      await build(content)
      await execFileAsync('tar', ['-czf', join(parent, 'a.tgz'), '-C', content, '.'])
      const bytes = await readFile(join(parent, 'a.tgz'))
      await rm(parent, { recursive: true, force: true })
      return bytes
    }
    const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`
    // 1. no manifest anywhere (empty dir archive)
    let bytes = await rawTar(async dir => { await mkdir(join(dir, 'a'), { recursive: true }); await mkdir(join(dir, 'b'), { recursive: true }) })
    await withIndex([{ ...baseEntry, tarballSha256: shaOf(bytes), contentHash: 'sha256:x' }], bytes)
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/no single pack directory/)
    // 2. single dir without manifest
    bytes = await rawTar(async dir => { await mkdir(join(dir, 'only'), { recursive: true }) })
    await withIndex([{ ...baseEntry, tarballSha256: shaOf(bytes), contentHash: 'sha256:x' }], bytes)
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/contains no manifest\.json/)
    // 3. manifest not parseable
    bytes = await rawTar(async dir => { await mkdir(join(dir, 'p'), { recursive: true }); await writeFile(join(dir, 'p', 'manifest.json'), 'not-json', 'utf8') })
    await withIndex([{ ...baseEntry, tarballSha256: shaOf(bytes), contentHash: 'sha256:x' }], bytes)
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/manifest is not valid JSON/)
    // 4b. not-a-gzip archive -> extraction failure
    bytes = Buffer.from('definitely-not-a-gzip-archive')
    await withIndex([{ ...baseEntry, tarballSha256: shaOf(bytes), contentHash: 'sha256:x' }], bytes)
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/tarball extraction failed/)
    // 4. manifest name mismatch
    bytes = await rawTar(async dir => {
      await mkdir(join(dir, 'p'), { recursive: true })
      await writeFile(join(dir, 'p', 'manifest.json'), JSON.stringify({ name: 'other', version: '2' }), 'utf8')
    })
    await withIndex([{ ...baseEntry, tarballSha256: shaOf(bytes), contentHash: 'sha256:x' }], bytes)
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/manifest declares "other"/)
  })

  it('distinguishes the tarball-stage failures: network refusal vs HTTP error', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '2')
    const market = await marketServer([{ name: 'ext', version: '2', dir: newer }])
    fx.deps.marketUrl = market.url
    // Index answers, tarball fetch refuses: fetchTarball's own catch.
    fx.deps.fetchImpl = async input => {
      if (String(input).endsWith('/api/index')) return new Response(JSON.stringify({ packs: [{ name: 'ext', version: '2', tarball: '/tarballs/ext-2.tgz', tarballSha256: 'sha256:x', contentHash: 'sha256:x' }] }), { headers: { 'content-type': 'application/json' } })
      throw new Error('ECONNRESET')
    }
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/could not fetch the ext tarball.*nothing was written/)
    // Tarball answers with an HTTP error: the updateFailed branch.
    fx.deps.fetchImpl = async input => {
      if (String(input).endsWith('/api/index')) return new Response(JSON.stringify({ packs: [{ name: 'ext', version: '2', tarball: '/tarballs/ext-2.tgz', tarballSha256: 'sha256:x', contentHash: 'sha256:x' }] }), { headers: { 'content-type': 'application/json' } })
      return new Response('nope', { status: 503 })
    }
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/tarball download failed \(HTTP 503\)/)
  })

  it('compares non-numeric segments lexically', async () => {
    expect(compareVersions('1.2.alpha', '1.2.beta')).toBeLessThan(0)
    expect(compareVersions('1.2.beta', '1.2.alpha')).toBeGreaterThan(0)
    expect(compareVersions('1.2.same', '1.2.same')).toBe(0)
  })
})

describe('installPack', () => {
  it('lands a new pack at packsDir/<name> and hot-reloads the SAME map (usable mid-session)', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const source = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'fresh', '3')
    const market = await marketServer([{ name: 'fresh', version: '3', dir: source }])
    fx.deps.marketUrl = market.url
    const packsRef = fx.deps.packs
    const out = await installPack(fx.deps, 'fresh')
    expect(out.installed).toEqual([{ name: 'fresh', version: '3', dest: join(fx.packsDir, 'fresh'), existed: false }])
    expect(fx.deps.packs).toBe(packsRef)
    expect(fx.deps.packs.get('fresh')?.manifest.version).toBe('3')
    expect(fx.deps.packs.has('ext')).toBe(true)
  })

  it('treats an already-installed name as an in-place update', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const newer = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '4')
    const market = await marketServer([{ name: 'ext', version: '4', dir: newer }])
    fx.deps.marketUrl = market.url
    const out = await installPack(fx.deps, 'ext')
    expect(out.installed[0]).toMatchObject({ name: 'ext', version: '4', existed: true })
    expect(fx.deps.packs.get('ext')?.manifest.version).toBe('4')
  })

  it('refuses without a packsDir; an absent member fails loud only when not satisfied locally', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const market = await marketServer([])
    fx.deps.marketUrl = market.url
    await expect(installPack({ ...fx.deps, packsDir: undefined }, 'ext')).rejects.toThrow(/no packsDir is configured/)
    // 'ext' is installed locally, so an empty market is a no-op closure
    // (a locally-satisfied member absent from the market lands no row).
    const out = await installPack(fx.deps, 'ext')
    expect(out.installed).toEqual([])
    // 'ghost' is neither local nor listed: the closure fails naming it.
    await expect(installPack(fx.deps, 'ghost')).rejects.toThrow(/needs "ghost".*neither listed on the market nor installed/)
  })

  it('installs the consumes closure: one call lands the whole chain, upstreams first', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    // A three-pack chain: chain-top consumes mid consumes base.
    const baseDir = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'base', '1')
    const midDir = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'mid', '1')
    await writeFile(join(midDir, 'manifest.json'), JSON.stringify({
      name: 'mid', version: '1', description: 'd', consumes: ['base'], languages: ['zh-CN'],
      params: { limit: { type: 'number', default: 3, min: 1, max: 20, description: 'd' } },
    }), 'utf8')
    const topDir = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'top', '1')
    await writeFile(join(topDir, 'manifest.json'), JSON.stringify({
      name: 'top', version: '1', description: 'd', consumes: ['mid'], languages: ['zh-CN'],
      params: { limit: { type: 'number', default: 3, min: 1, max: 20, description: 'd' } },
    }), 'utf8')
    const market = await marketServer([{ name: 'base', version: '1', dir: baseDir }, { name: 'mid', version: '1', dir: midDir, consumes: ['base'] }, { name: 'top', version: '1', dir: topDir, consumes: ['mid'] }])
    fx.deps.marketUrl = market.url
    const packsRef = fx.deps.packs
    const out = await installPack(fx.deps, 'top')
    expect(out.installed.map(o => o.name)).toEqual(['base', 'mid', 'top'])
    expect(fx.deps.packs).toBe(packsRef)
    for (const name of ['base', 'mid', 'top']) expect(fx.deps.packs.has(name)).toBe(true)
    // Re-install: everything already current — nothing re-downloaded.
    const again = await installPack(fx.deps, 'top')
    expect(again.installed.every(o => o.unchanged)).toBe(true)
  })
})

describe('installPack edge coverage', () => {
  it('creates a missing packsDir on install and reports market-unreachable distinctly', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const { mkdtemp: mkTmp, rm } = await import('node:fs/promises')
    const fresh = await mkTmp(join(tmpdir(), 'docwright-install-fresh-'))
    await rm(fresh, { recursive: true, force: true }) // the dir does not exist yet
    const source = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'solo', '1')
    const market = await marketServer([{ name: 'solo', version: '1', dir: source }])
    fx.deps.marketUrl = market.url
    const out = await installPack({ ...fx.deps, packsDir: fresh }, 'solo')
    expect(out.installed[0]).toMatchObject({ name: 'solo', version: '1', existed: false })
    expect(fx.deps.packs.get('solo')?.manifest.version).toBe('1')
    await rm(fresh, { recursive: true, force: true })
    // Dead market on the install lane: marketUnreachable, not absentFromMarket.
    fx.deps.marketUrl = 'http://127.0.0.1:1'
    await expect(installPack(fx.deps, 'ext')).rejects.toThrow(/could not reach the pack market/)
  })

  it('skips unparseable and dot directories during the manifest scan', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(fx.packsDir, 'junk'), { recursive: true })
    await writeFile(join(fx.packsDir, 'junk', 'manifest.json'), 'not-json', 'utf8')
    await mkdir(join(fx.packsDir, '.hidden'), { recursive: true })
    // 'ext' still resolves; junk/.hidden never abort the scan.
    expect(await resolveManagedPackDir(fx.packsDir, 'ext')).toBe(join(fx.packsDir, 'ext'))
    await expect(resolveManagedPackDir(fx.packsDir, 'junk')).rejects.toThrow(/not managed here/)
  })
})

describe('installPack mid-closure failure', () => {
  it('reloads the partial install and surfaces the failing member', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const baseDir = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'base', '1')
    const topDir = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'top', '1')
    const topBytes = Buffer.concat([await readFile(join(topDir, 'manifest.json'))]) // placeholder
    const market = await marketServer([{ name: 'base', version: '1', dir: baseDir }, { name: 'top', version: '1', dir: topDir, consumes: ['base'] }])
    // 'top' cannot load (its tarball sha lies): base lands, top fails.
    const realFetch = globalThis.fetch
    globalThis.fetch = async input => {
      const url = String(input)
      if (url.endsWith('/api/index')) {
        return new Response(JSON.stringify({ packs: [
          { name: 'base', version: '1', tarball: `/tarballs/base-1.tgz`, tarballSha256: `sha256:${createHash('sha256').update(market.tarballs.get('/tarballs/base-1.tgz')!).digest('hex')}`, contentHash: await dirHash(baseDir), consumes: [] },
          { name: 'top', version: '1', tarball: `/tarballs/top-1.tgz`, tarballSha256: 'sha256:lie', contentHash: 'sha256:x', consumes: ['base'] },
        ] }), { headers: { 'content-type': 'application/json' } })
      }
      const bytes = market.tarballs.get(url.slice('https://market.test'.length))!
      return new Response(bytes, { headers: { 'content-type': 'application/gzip' } })
    }
    fx.deps.marketUrl = 'https://market.test'
    void topBytes
    try {
      await expect(installPack(fx.deps, 'top')).rejects.toThrow(/integrity check failed/)
      // The partial install reloaded: base is usable even though top failed.
      expect(fx.deps.packs.get('base')?.manifest.version).toBe('1')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('checkPackUpdates per-pack scope', () => {
  it('queries the market per-pack endpoint and scopes the answer to that card', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    fx.deps.marketUrl = 'https://market.test'
    const calls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/api/packs/ext')) return new Response(JSON.stringify({ ok: true, pack: { name: 'ext', version: '9' } }), { headers: { 'content-type': 'application/json' } })
      throw new Error(`unexpected ${url}`)
    }) as typeof fetch
    try {
      const rows = await checkPackUpdates(fx.deps, 'ext')
      expect(rows).toEqual([{ name: 'ext', localVersion: '1', onMarket: true, marketVersion: '9', updateAvailable: true }])
      expect(calls).toEqual(['https://market.test/api/packs/ext']) // the per-pack endpoint, not the index
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('reports an absent pack via the market 404 without touching the index', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    fx.deps.marketUrl = 'https://market.test'
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/packs/ext')) return new Response('not found', { status: 404 })
      throw new Error(`unexpected ${url}`)
    }) as typeof fetch
    try {
      const rows = await checkPackUpdates(fx.deps, 'ext')
      expect(rows).toEqual([{ name: 'ext', localVersion: '1', onMarket: false, updateAvailable: false }])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('deletePack in-use guard', () => {
  it('refuses to delete a pack other installed packs consume unless forced', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    // Give the installed 'ext' a consumer: a local pack that consumes it.
    const consumerDir = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-consumer-')), 'consumer', '1')
    const manifestPath = join(consumerDir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, JSON.stringify({ ...manifest, consumes: ['ext'] }), 'utf8')
    const { cp } = await import('node:fs/promises')
    await cp(consumerDir, join(fx.packsDir, 'consumer'), { recursive: true })
    // Reload so the map sees the consumer.
    const reloaded = await fx.deps.loadPacks(fx.deps.builtinRoot, { extra: [fx.packsDir] })
    fx.deps.packs.clear()
    for (const [n, p] of reloaded) fx.deps.packs.set(n, p)
    await expect(deletePack(fx.deps, 'ext')).rejects.toThrow(/is consumed by installed packs \(consumer\).*force: true/)
    // The guard fires before any disk change.
    expect(fx.deps.packs.has('ext')).toBe(true)
    await deletePack(fx.deps, 'ext', { force: true })
    expect(fx.deps.packs.has('ext')).toBe(false)
  })
})

describe('checkPackUpdates per-pack scope: failure path', () => {
  it('maps a per-pack network failure to marketUnreachable', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    fx.deps.marketUrl = 'http://127.0.0.1:1'
    await expect(checkPackUpdates(fx.deps, 'ext')).rejects.toThrow(/could not check "ext" against the pack market/)
  })
})

/** A suite-aware fake market: /api/index, /api/suites, /api/suites/<name>,
 * and tarballs for entries that carry a dir. */
async function suiteMarketServer(
  packs: readonly { name: string; version: string; dir?: string; consumes?: readonly string[] }[],
  suites: readonly { name: string; version: string; members: readonly string[]; description?: unknown; category?: string }[],
): Promise<{ url: string; dispose: () => Promise<void> }> {
  const tarballs = new Map<string, Buffer>()
  const indexPacks: Record<string, unknown>[] = []
  for (const entry of packs) {
    let sha = 'sha256:bogus'
    let content = 'sha256:bogus'
    if (entry.dir !== undefined) {
      const tgz = join(entry.dir, '..', `${entry.name}-${entry.version}.tgz`)
      await execFileAsync('tar', ['-czf', tgz, '-C', entry.dir, '.'])
      const bytes = await readFile(tgz)
      tarballs.set(`/tarballs/${entry.name}-${entry.version}.tgz`, bytes)
      sha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      content = await dirHash(entry.dir)
    }
    indexPacks.push({ name: entry.name, version: entry.version, tarball: `/tarballs/${entry.name}-${entry.version}.tgz`, tarballSha256: sha, contentHash: content, consumes: entry.consumes ?? [] })
  }
  const json = (response: import('node:http').ServerResponse, body: unknown): void => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  const server: Server = createServer((request, response) => {
    const url = request.url ?? ''
    if (url === '/api/index') return json(response, { packs: indexPacks })
    if (url === '/api/suites') return json(response, { suites })
    if (url.startsWith('/api/suites/')) {
      const name = decodeURIComponent(url.slice('/api/suites/'.length))
      const suite = suites.find(s => s.name === name)
      if (suite === undefined) {
        response.writeHead(404)
        response.end('no such suite')
        return
      }
      return json(response, { ok: true, suite, members: suite.members.map(m => ({ name: m, missing: false })) })
    }
    const bytes = tarballs.get(url)
    if (bytes === undefined) {
      response.writeHead(404)
      response.end('no such tarball')
      return
    }
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(bytes)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no local port')
  return { url: `http://127.0.0.1:${address.port}`, dispose: async () => server.close() }
}

/** A fixture pack whose manifest declares the given consumes edges. */
async function packFixtureConsuming(root: string, name: string, version: string, consumes: readonly string[]): Promise<string> {
  const dir = await packFixture(root, name, version)
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { consumes?: string[] }
  manifest.consumes = [...consumes]
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  return dir
}

describe('resolveSuiteInstallClosure', () => {
  it('merges every member closure into one deduplicated dependencies-first list', async () => {
    const index = {
      ok: true,
      packs: [
        { name: 'base', version: '1', tarball: '', tarballSha256: '', contentHash: '', consumes: [] },
        { name: 'mid', version: '1', tarball: '', tarballSha256: '', contentHash: '', consumes: ['base'] },
        { name: 'top', version: '1', tarball: '', tarballSha256: '', contentHash: '', consumes: ['mid'] },
        { name: 'other', version: '1', tarball: '', tarballSha256: '', contentHash: '', consumes: ['base'] },
      ],
    } as unknown as Parameters<typeof resolveSuiteInstallClosure>[0]
    const suite = { name: 'cosmic', version: '1', description: {}, category: '', members: ['top', 'other', 'locally-there'] }
    const closure = resolveSuiteInstallClosure(index, suite, new Set(['locally-there']))
    expect(closure.map(e => e.name)).toEqual(['base', 'mid', 'top', 'other'])
  })

  it('fails loud naming the suite when a needed name is neither on the market nor installed', async () => {
    const index = { ok: true, packs: [{ name: 'solo', version: '1', tarball: '', tarballSha256: '', contentHash: '', consumes: ['ghost'] }] } as unknown as Parameters<typeof resolveSuiteInstallClosure>[0]
    const suite = { name: 'cosmic', version: '1', description: {}, category: '', members: ['solo'] }
    expect(() => resolveSuiteInstallClosure(index, suite, new Set())).toThrow(/suite "cosmic" needs "ghost"/)
  })
})

describe('installSuite', () => {
  it('lands every member plus their merged upstreams in one call and reloads once', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const parent = await mkdtemp(join(tmpdir(), 'docwright-suite-mkt-'))
    marketStack.push({ dispose: async () => { await rm(parent, { recursive: true, force: true }) } })
    await packFixtureConsuming(parent, 'base', '1', [])
    await packFixtureConsuming(parent, 'mid', '1', ['base'])
    await packFixtureConsuming(parent, 'top', '1', ['mid'])
    const market = await suiteMarketServer(
      [
        { name: 'base', version: '1', dir: join(parent, 'base') },
        { name: 'mid', version: '1', dir: join(parent, 'mid'), consumes: ['base'] },
        { name: 'top', version: '1', dir: join(parent, 'top'), consumes: ['mid'] },
      ],
      [{ name: 'cosmic', version: '1', members: ['top', 'ext'] }],
    )
    marketStack.push(market)
    const deps = { ...fx.deps, marketUrl: market.url }
    const { suite, installed } = await installSuite(deps, 'cosmic')
    expect(suite.name).toBe('cosmic')
    // ext is a member satisfied locally (not on this market): the closure is
    // base, mid, top — dependencies first, no duplicate entries.
    expect(installed.map(o => [o.name, o.unchanged ?? false])).toEqual([['base', false], ['mid', false], ['top', false]])
    for (const name of ['base', 'mid', 'top']) {
      expect(fx.packs.has(name)).toBe(true)
      expect(readdir(join(fx.packsDir, name))).resolves.toBeTruthy()
    }
  })

  it('fails loud on an old market (404) or an unreachable one, writing nothing', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const dead = { ...fx.deps, marketUrl: 'http://127.0.0.1:1' }
    await expect(installSuite(dead, 'cosmic')).rejects.toThrow(/could not reach the pack market/)
    const market = await suiteMarketServer([{ name: 'solo', version: '1', dir: undefined }], [])
    marketStack.push(market)
    await expect(installSuite({ ...fx.deps, marketUrl: market.url }, 'cosmic')).rejects.toThrow(/suite "cosmic" is not offered by the pack market/)
  })

  it('skips members already installed at the market version (retry tops up)', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const parent = await mkdtemp(join(tmpdir(), 'docwright-suite-retry-'))
    marketStack.push({ dispose: async () => { await rm(parent, { recursive: true, force: true }) } })
    const extDir = await packFixture(parent, 'ext', '2')
    const market = await suiteMarketServer([{ name: 'ext', version: '2', dir: extDir }], [{ name: 's', version: '1', members: ['ext'] }])
    marketStack.push(market)
    const first = await installSuite({ ...fx.deps, marketUrl: market.url }, 's')
    expect(first.installed).toEqual([{ name: 'ext', version: '2', dest: join(fx.packsDir, 'ext'), existed: true }])
    const second = await installSuite({ ...fx.deps, marketUrl: market.url }, 's')
    expect(second.installed).toEqual([{ name: 'ext', version: '2', dest: join(fx.packsDir, 'ext'), existed: true, unchanged: true }])
  })
})

describe('updateSuite', () => {
  it('updates the outdated member, keeps the current one, and reports missing members', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const parent = await mkdtemp(join(tmpdir(), 'docwright-suite-upd-'))
    marketStack.push({ dispose: async () => { await rm(parent, { recursive: true, force: true }) } })
    const v2Dir = await packFixture(parent, 'ext', '2')
    const market = await suiteMarketServer(
      [{ name: 'ext', version: '2', dir: v2Dir }],
      [{ name: 's', version: '1', members: ['ext', 'wp', 'ghost-member'] }],
    )
    marketStack.push(market)
    const result = await updateSuite({ ...fx.deps, marketUrl: market.url }, 's')
    // ext updates to v2; wp is installed but not in this packsDir → reported
    // missing (updating only refreshes what the packsDir manages); the
    // never-installed member is missing too; nothing is "unchanged" here.
    expect(result.updated).toEqual([{ name: 'ext', version: '2' }])
    expect(result.unchanged).toEqual([])
    expect(result.missing.sort()).toEqual(['ghost-member', 'wp'])
    // Second pass: ext is now current → unchanged, nothing re-downloaded.
    const second = await updateSuite({ ...fx.deps, marketUrl: market.url }, 's')
    expect(second.updated).toEqual([])
    expect(second.unchanged).toEqual(['ext'])
    expect(second.missing.sort()).toEqual(['ghost-member', 'wp'])
  })

  it('refuses a suite the market does not know', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const market = await suiteMarketServer([], [])
    marketStack.push(market)
    await expect(updateSuite({ ...fx.deps, marketUrl: market.url }, 'nope')).rejects.toThrow(/suite "nope" is not offered/)
    await expect(deleteSuite({ ...fx.deps, marketUrl: market.url }, 'nope')).rejects.toThrow(/suite "nope" is not offered/)
  })
})

describe('deleteSuite', () => {
  it('deletes EVERY installed member, even one consumed by a pack outside the suite', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    // packsDir: a and b are the suite; c (outside) consumes a — a still goes:
    // members are consumed inside their suite by design, so there is no
    // keep/force split. c keeps loading and fails loud on its next generation.
    await packFixtureConsuming(fx.packsDir, 'a', '1', [])
    await packFixtureConsuming(fx.packsDir, 'b', '1', [])
    await packFixtureConsuming(fx.packsDir, 'c', '1', ['a'])
    const reloaded = await loadPacks(fx.deps.builtinRoot, { extra: [fx.packsDir] })
    fx.packs.clear()
    for (const [name, pack] of reloaded) fx.packs.set(name, pack)
    const market = await suiteMarketServer([], [{ name: 'pair', version: '1', members: ['a', 'b', 'never-installed'] }])
    marketStack.push(market)
    const result = await deleteSuite({ ...fx.deps, marketUrl: market.url }, 'pair')
    expect([...result.deleted].sort()).toEqual(['a', 'b'])
    await expect(readdir(join(fx.packsDir, 'a'))).rejects.toThrow()
    await expect(readdir(join(fx.packsDir, 'b'))).rejects.toThrow()
    await expect(readdir(join(fx.packsDir, 'c'))).resolves.toBeTruthy()
    // Retrying never double-deletes: the unit is "installed members".
    const again = await deleteSuite({ ...fx.deps, marketUrl: market.url }, 'pair')
    expect(again.deleted).toEqual([])
  })
})

describe('checkSuiteStatus', () => {
  it('projects the market suite list onto the local packsDir (versions, missing, updateAvailable)', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const parent = await mkdtemp(join(tmpdir(), 'docwright-suite-status-'))
    marketStack.push({ dispose: async () => { await rm(parent, { recursive: true, force: true }) } })
    const v2Dir = await packFixture(parent, 'ext', '2')
    const market = await suiteMarketServer(
      [{ name: 'ext', version: '2', dir: v2Dir }],
      [{
        name: 'cosmic', version: '3', category: 'estimation',
        description: { en: 'COSMIC suite', zh: 'COSMIC 套件' },
        members: ['ext', 'wp', 'ghost'],
      }],
    )
    marketStack.push(market)
    const suites = await checkSuiteStatus({ packs: fx.packs, packsDir: fx.packsDir, marketUrl: market.url })
    expect(suites).toHaveLength(1)
    const suite = suites[0]!
    expect(suite).toMatchObject({ name: 'cosmic', version: '3', category: 'estimation', incomplete: true, updateAvailable: true })
    expect(suite.members).toEqual([
      { name: 'ext', localVersion: '1', marketVersion: '2', missing: false, updateAvailable: true },
      // wp is a BUILTIN fixture pack — suite placement is the packsDir scan,
      // so a builtin-only member counts as missing (suites land in packsDir).
      { name: 'wp', missing: true, updateAvailable: false },
      { name: 'ghost', missing: true, updateAvailable: false },
    ])
  })

  it('answers an empty list on an old market and marketUnreachable when unreachable', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    const packless = await suiteMarketServer([{ name: 'x', version: '1', dir: undefined }], [])
    marketStack.push(packless)
    expect(await checkSuiteStatus({ packs: fx.packs, packsDir: fx.packsDir, marketUrl: packless.url })).toEqual([])
    await expect(checkSuiteStatus({ packs: fx.packs, packsDir: fx.packsDir, marketUrl: 'http://127.0.0.1:1' })).rejects.toThrow(/marketUnreachable|could not reach/)
  })
})

describe('suite lane failure branches', () => {
  it('maps suite-detail HTTP failures, missing packsDir, and index failures to their codes', async () => {
    const fx = await managedFixture()
    marketStack.push(fx)
    // Suite detail answers HTTP 500 → marketUnreachable with the per-suite wording.
    const broken = createServer((request, response) => {
      if ((request.url ?? '').includes('/api/suites/cosmic')) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'boom' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ packs: [] }))
    })
    await new Promise<void>(resolve => broken.listen(0, '127.0.0.1', resolve))
    const brokenPort = (broken.address() as { port: number }).port
    marketStack.push({ dispose: async () => broken.close() })
    await expect(installSuite({ ...fx.deps, marketUrl: `http://127.0.0.1:${brokenPort}` }, 'cosmic')).rejects.toThrow(/could not read suite "cosmic".*HTTP 500/)
    // No packsDir configured → the suite cannot install anywhere.
    await expect(installSuite({ ...fx.deps, packsDir: undefined, marketUrl: 'https://market.test' }, 'cosmic')).rejects.toThrow(/no packsDir is configured/)
    // Suite detail fine, index fetch dead → marketUnreachable from the update path.
    const detailOnly = createServer((request, response) => {
      if ((request.url ?? '').includes('/api/suites/cosmic')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, suite: { name: 'cosmic', version: '1', members: ['ext'] }, members: [{ name: 'ext', missing: false }] }))
        return
      }
      response.writeHead(500)
      response.end('boom')
    })
    await new Promise<void>(resolve => detailOnly.listen(0, '127.0.0.1', resolve))
    const detailPort = (detailOnly.address() as { port: number }).port
    marketStack.push({ dispose: async () => detailOnly.close() })
    await expect(updateSuite({ ...fx.deps, marketUrl: `http://127.0.0.1:${detailPort}` }, 'cosmic')).rejects.toThrow(/could not reach the pack market/)
    // checkSuiteStatus: index read failing after the suite list is read.
    const statusOnly = createServer((request, response) => {
      if ((request.url ?? '') === '/api/suites') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ suites: [{ name: 'cosmic', version: '1', members: ['ext'] }] }))
        return
      }
      response.writeHead(500)
      response.end('boom')
    })
    await new Promise<void>(resolve => statusOnly.listen(0, '127.0.0.1', resolve))
    const statusPort = (statusOnly.address() as { port: number }).port
    marketStack.push({ dispose: async () => statusOnly.close() })
    await expect(checkSuiteStatus({ packs: fx.packs, packsDir: fx.packsDir, marketUrl: `http://127.0.0.1:${statusPort}` })).rejects.toThrow(/suite status is unavailable/)
    // A packsDir that does not exist: no local placement, suites still listed.
    const emptyDir = await suiteMarketServer([], [{ name: 'cosmic', version: '1', members: ['ext'] }])
    marketStack.push(emptyDir)
    const suites = await checkSuiteStatus({ packs: fx.packs, packsDir: join(fx.packsDir, 'does-not-exist'), marketUrl: emptyDir.url })
    expect(suites[0]!.members[0]).toMatchObject({ name: 'ext', missing: true })
    // The suite-detail fetch itself dying (index fine) → marketUnreachable.
    await expect(installSuite({
      ...fx.deps,
      marketUrl: emptyDir.url,
      fetchImpl: (async (input: unknown) => {
        if (String(input).includes('/api/suites/')) throw new Error('ECONNRESET')
        return new Response(JSON.stringify({ packs: [] }), { headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    }, 'cosmic')).rejects.toThrow(/could not reach the pack market/)
  })
})
