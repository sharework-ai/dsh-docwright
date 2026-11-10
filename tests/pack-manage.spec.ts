import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPackUpdates, compareVersions, deletePack, dirHash, resolveManagedPackDir, updatePack } from '../src/pack-manage.ts'
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
async function marketServer(entries: readonly { name: string; version: string; dir?: string }[]): Promise<{ url: string; dispose: () => Promise<void>; tarballs: Map<string, Buffer> }> {
  const tarballs = new Map<string, Buffer>()
  const index = { ok: true, packs: [] as Record<string, string>[] }
  for (const entry of entries) {
    if (entry.dir === undefined) {
      index.packs.push({ name: entry.name, version: entry.version, tarball: `/tarballs/${entry.name}-${entry.version}.tgz`, tarballSha256: 'sha256:bogus', contentHash: 'sha256:bogus' })
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
    expect(rows[0]).toMatchObject({ name: 'ext', localVersion: '1', marketVersion: '2', updateAvailable: true })
    const stale = await packFixture(await mkdtemp(join(tmpdir(), 'docwright-market-')), 'ext', '1')
    const marketOld = await marketServer([{ name: 'ext', version: '1', dir: stale }])
    fx.deps.marketUrl = marketOld.url
    const rowsOld = await checkPackUpdates(fx.deps)
    expect(rowsOld[0]).toMatchObject({ marketVersion: '1', updateAvailable: false })
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
    await expect(updatePack(fx.deps, 'ext')).rejects.toThrow(/is not on the market/)
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
