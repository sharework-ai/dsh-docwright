import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { defineDocGenerateTool, defineDocPacksTool, defineDocValidateTool, defineMarketInstallTool, defineMarketSearchTool } from '../src/tools.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { seedContext } from './support.ts'
import { fileURLToPath } from 'node:url'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))
const signal = new AbortController().signal

async function makeDeps(overrides: Record<string, unknown> = {}) {
  const packs = await loadPacks(packsRoot, {})
  const pack = packs.get('cosmic-plan')!
  return {
    packs,
    builtinRoot: packsRoot,
    loadPacks: (root: string, dirs: { extra?: readonly string[] | undefined }) => loadPacks(root, dirs),
    config: {
      provider: 'deepseek',
      model: 'test-model',
      workspaceRoot: await mkdtemp(join(tmpdir(), 'docwright-tools-')),
      maxIterations: 3,
      promptTokenBudget: 60_000,
      ...overrides,
    } as never,
    ctx: {
      llm: {
        stream: async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: JSON.stringify(pack.goldenSample) }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(pack.goldenSample) } }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    },
  }
}

describe('doc_packs tool', () => {
  it('lists installed packs with discovery fields and the deployment policy', async () => {
    const deps = await makeDeps()
    const tool = defineDocPacksTool(deps)
    const listing = await tool.execute({} as never, { signal } as never) as { confirmPolicy: string; packs: Array<{ name: string; version: string; description: string; languages: string[]; consumes: string[] }> }
    expect(listing.confirmPolicy).toBe('standard')
    expect(listing.packs).toHaveLength(6)
    const plan = listing.packs.find(p => p.name === 'cosmic-plan')!
    expect(plan).toMatchObject({ version: '0.7.2', languages: ['zh-CN', 'en-US'], consumes: ['cosmic-context'] })
    expect(plan.description.length).toBeGreaterThan(0)
  })

  it('renders its value as text content', async () => {
    const deps = await makeDeps()
    const tool = defineDocPacksTool(deps)
    const value = await tool.execute({} as never, { signal } as never)
    const rendered = tool.output.render({}, value as never) as Array<{ type: string; text: string }>
    expect(rendered[0]).toMatchObject({ type: 'text' })
    expect(rendered[0]!.text).toContain('cosmic-plan')
  })
})

describe('doc_generate tool', () => {
  it('walks the loop and returns artifact + receipt inline', async () => {
    const deps = await makeDeps()
    const tool = defineDocGenerateTool(deps)
    await seedContext(deps)
    const out = await tool.execute(
      { pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\n素材'], language: 'zh-CN', artifactName: 'tool1', upstream: ['context/context.json'], params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true } as never,
      { signal } as never,
    ) as { artifactPath: string; markdownPath: string; receipt: { isValid: boolean } }
    expect(out.receipt.isValid).toBe(true)
    expect(out.markdownPath.endsWith('.md')).toBe(true)
  })

  it('fails loud on an unknown pack with the discovery hint and available list', async () => {
    const deps = await makeDeps()
    const tool = defineDocGenerateTool(deps)
    await expect(tool.execute({ pack: 'nope', materials: ['#!inline\nx'] } as never, { signal } as never)).rejects.toThrow(/unknown pack "nope"; discover installed packs via doc_packs \(available: cosmic-context, cosmic-context-sync, cosmic-func, cosmic-plan, cosmic-req, cosmic-tech\)/)
    await expect(tool.execute({ pack: 'nope', materials: ['#!inline\nx'] } as never, { signal } as never)).rejects.toThrow(/search the pack market with doc_market_search/)
  })

  it('omits the market hint when marketSearch is disabled', async () => {
    const deps = await makeDeps({ marketSearch: false })
    const tool = defineDocGenerateTool(deps)
    const error = await tool.execute({ pack: 'nope', materials: ['#!inline\nx'] } as never, { signal } as never).then(() => 'no error', (e: Error) => e.message)
    expect(error).toContain('unknown pack "nope"')
    expect(error).not.toContain('doc_market_search')
  })

  it('fails loud on an unsupported language at call time', async () => {
    const deps = await makeDeps()
    const tool = defineDocGenerateTool(deps)
    await expect(tool.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'fr-FR' } as never, { signal } as never)).rejects.toThrow(/does not support language/)
  })

  it('fails loud when the LLM route is unset', async () => {
    const deps = await makeDeps({ provider: undefined, model: undefined })
    const tool = defineDocGenerateTool(deps)
    const routed = { ...deps, config: { ...(deps.config as Record<string, unknown>), provider: 'p', model: 'm' } }
    await seedContext(routed)
    await expect(tool.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], upstream: ['context/context.json'], params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true } as never, { signal } as never)).rejects.toThrow(/provider and model/)
  })
})

describe('doc_validate tool', () => {
  it('revalidates a green artifact deterministically (no LLM)', async () => {
    const deps = await makeDeps()
    const pack = deps.packs.get('cosmic-plan')!
    const root = (deps.config as { workspaceRoot: string }).workspaceRoot
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'output'), { recursive: true })
    await writeFile(join(root, 'output', 'a.json'), JSON.stringify(pack.goldenSample), 'utf8')
    await seedContext(deps)
    const tool = defineDocValidateTool(deps)
    const out = await tool.execute({ artifactPath: 'output/a.json', pack: 'cosmic-plan', language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } } } as never, { signal } as never) as { receipt: { isValid: boolean } }
    expect(out.receipt.isValid).toBe(true)
  })

  it('goes red on a tampered artifact', async () => {
    const deps = await makeDeps()
    const pack = deps.packs.get('cosmic-plan')!
    const root = (deps.config as { workspaceRoot: string }).workspaceRoot
    const { writeFile, mkdir } = await import('node:fs/promises')
    const tampered = JSON.parse(JSON.stringify(pack.goldenSample))
    tampered.functions[0].funcDesc = '短'
    await mkdir(join(root, 'output'), { recursive: true })
    await writeFile(join(root, 'output', 'b.json'), JSON.stringify(tampered), 'utf8')
    await seedContext(deps)
    const tool = defineDocValidateTool(deps)
    const out = await tool.execute({ artifactPath: 'output/b.json', pack: 'cosmic-plan', language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } } } as never, { signal } as never) as { receipt: { isValid: boolean } }
    expect(out.receipt.isValid).toBe(false)
  })

  it('fails loud on a non-JSON artifact file', async () => {
    const deps = await makeDeps()
    const root = (deps.config as { workspaceRoot: string }).workspaceRoot
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'output'), { recursive: true })
    await writeFile(join(root, 'output', 'c.json'), 'not json', 'utf8')
    const tool = defineDocValidateTool(deps)
    await expect(tool.execute({ artifactPath: 'output/c.json', pack: 'cosmic-plan', language: 'zh-CN' } as never, { signal } as never)).rejects.toThrow(/not valid JSON/)
  })
})

describe('doc_market_search tool', () => {
  it('queries the configured market with the composed terms and projects hits', async () => {
    const deps = await makeDeps({ marketUrl: 'https://market.test', packsDir: '/w/.docwright/packs' })
    const tool = defineMarketSearchTool(deps)
    const calls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ packs: [{ name: 'cosmic-plan', version: '1', description: { en: 'plan pack' }, consumes: ['cosmic-context'], languages: ['zh-CN'], requires_topic: true }] }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const args = { query: 'cosmic plan' }
      const out = await tool.execute(args as never, { signal } as never) as { count: number; market: string; suites: unknown[]; packs: Array<{ install: string; requiresTopic: boolean }> }
      // The catalog read is /api/packs; the suite lane reads /api/suites and
      // degrades to [] when the market answers without suite data.
      expect(calls[0]).toBe('https://market.test/api/packs?q=cosmic%20plan')
      expect(calls.some(c => c === 'https://market.test/api/suites')).toBe(true)
      expect(out).toMatchObject({ market: 'https://market.test', count: 1 })
      expect(out.suites).toEqual([])
      expect(out.packs[0]).toMatchObject({ requiresTopic: true })
      expect(out.packs[0].install).toContain('doc_market_install')
      expect(out.packs[0].install).toContain('cosmic-plan')
      expect((tool.output!.render as (a: unknown, v: unknown) => unknown)(args, out)).toEqual([{ type: 'text', text: JSON.stringify(out) }])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('fails loud with retry guidance when the market is unreachable', async () => {
    const deps = await makeDeps({ marketUrl: 'http://127.0.0.1:1' })
    const tool = defineMarketSearchTool(deps)
    await expect(tool.execute({ query: 'x' } as never, { signal } as never)).rejects.toThrow(/could not search the pack market/)
  })
})

describe('doc_market_install tool', () => {
  const marketCatalog = (tarball: Buffer) => async (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/api/index')) {
      return new Response(JSON.stringify({ packs: [{ name: 'gw', version: '2', tarball: '/tarballs/gw-2.tgz', tarballSha256: `sha256:${createHash('sha256').update(tarball).digest('hex')}`, contentHash: 'sha256:placeholder' }] }), { headers: { 'content-type': 'application/json' } })
    }
    return new Response(tarball, { headers: { 'content-type': 'application/gzip' } })
  }

  it('asks through a pendingConfirmation table first (no disk writes)', async () => {
    const deps = await makeDeps({ marketUrl: 'https://market.test', packsDir: '/w/.docwright/packs' })
    const tool = defineMarketInstallTool(deps)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/index')) return new Response(JSON.stringify({ packs: [{ name: 'gw', version: '2', tarball: '/tarballs/gw-2.tgz', tarballSha256: 'sha256:x', contentHash: 'sha256:x' }] }), { headers: { 'content-type': 'application/json' } })
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    try {
      const out = await tool.execute({ pack: 'gw' } as never, { signal } as never) as { status: string; table: Record<string, unknown> }
      expect(out.status).toBe('pendingConfirmation')
      expect(out.table.requested).toBe('gw')
      expect(out.table.sourceMarket).toBe('https://market.test')
      expect(out.note).toContain('confirm: true')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('fails loud when the plugin wiring omits the install lane deps', async () => {
    const deps = await makeDeps({ marketUrl: 'https://market.test', packsDir: '/w/.docwright/packs' })
    const bare = { packs: deps.packs, config: deps.config }
    const tool = defineMarketInstallTool(bare as never)
    await expect(tool.execute({ pack: 'gw', confirm: true } as never, { signal } as never)).rejects.toThrow(/requires the plugin wiring/)
  })

  it('installs on confirm, hot-reloads the map, and the pack is immediately present', async () => {
    const packsDir = await mkdtemp(join(tmpdir(), 'docwright-install-lane-'))
    const deps = await makeDeps({ marketUrl: 'https://market.test', packsDir })
    const tool = defineMarketInstallTool(deps)
    // A real fixture pack tarball with a consistent content hash (built the
    // way the market serves archives: contents at the archive root).
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { mkdir, mkdtemp: mkTmp, readFile, rm } = await import('node:fs/promises')
    const execFileAsync = promisify(execFile)
    const parent = await mkTmp(join(tmpdir(), 'docwright-install-'))
    const content = join(parent, 'content')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(content, sub), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(content, 'manifest.json'), JSON.stringify({ name: 'gw', version: '2', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(content, 'rules', 'zh-CN.json'), JSON.stringify([{ id: 'gw/r', severity: 'error', given: '$', field: 'name', kind: 'minLength', min: 1, suggestion: 's' }]), 'utf8')
    await writeFile(join(content, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(content, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(content, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(content, 'samples', 'golden.json'), '{}', 'utf8')
    await execFileAsync('tar', ['-czf', join(parent, 'a.tgz'), '-C', content, '.'])
    const tarball = await readFile(join(parent, 'a.tgz'))
    const { dirHash } = await import('../src/pack-manage.ts')
    const hash = await dirHash(content)
    const realFetch = globalThis.fetch
    globalThis.fetch = marketCatalog(tarball) as typeof fetch
    // The index's contentHash must match the archive contents; patch it in.
    const indexPatch = globalThis.fetch
    globalThis.fetch = async (input: unknown) => {
      const url = String(input)
      const response = await (indexPatch as (i: unknown) => Promise<Response>)(input)
      if (url.endsWith('/api/index')) {
        const body = JSON.parse(await response.clone().text()) as { packs: Array<{ contentHash: string }> }
        body.packs[0].contentHash = hash
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      }
      return response
    }
    try {
      const out = await tool.execute({ pack: 'gw', confirm: true } as never, { signal } as never) as { status: string; installed: string[] }
      expect(out.status).toBe('installed')
      expect(out.installed[0]).toContain('gw@2')
      expect((tool.output!.render as (a: unknown, v: unknown) => unknown)({ pack: 'gw', confirm: true }, out)).toEqual([{ type: 'text', text: JSON.stringify(out) }])
      expect(deps.packs.get('gw')?.manifest.version).toBe('2')
    } finally {
      globalThis.fetch = realFetch
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe('doc_market_install tool: suites', () => {
  const suiteMarket = () => async (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/api/index')) {
      return new Response(JSON.stringify({ packs: [
        { name: 'base', version: '1', description: { en: 'base' } },
        { name: 'top', version: '1', description: { en: 'top' }, consumes: ['base'] },
        { name: 'solo', version: '3', description: { en: 'solo' } },
      ] }), { headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/suites/')) {
      return new Response(JSON.stringify({ name: 'cosmic', version: '2', members: ['top', 'solo'] }), { headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }

  it('asks through a pendingConfirmation table labeling suite members vs consumed upstreams', async () => {
    const deps = await makeDeps({ marketUrl: 'https://market.test', packsDir: '/w/.docwright/packs' })
    const tool = defineMarketInstallTool(deps)
    const realFetch = globalThis.fetch
    globalThis.fetch = suiteMarket() as typeof fetch
    try {
      const out = await tool.execute({ suite: 'cosmic' } as never, { signal } as never) as { status: string; table: Record<string, unknown> }
      expect(out.status).toBe('pendingConfirmation')
      expect(out.table.requestedSuite).toBe('cosmic')
      expect(out.table.installs).toEqual(['base@1 (consumed upstream)', 'top@1 (suite member)', 'solo@3 (suite member)'])
      // Old market: the suite fetch 404s → a clear error, nothing asked.
      globalThis.fetch = (async () => new Response('no', { status: 404 })) as typeof fetch
      await expect(tool.execute({ suite: 'cosmic' } as never, { signal } as never)).rejects.toThrow(/is not offered by the pack market/)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('refuses a call that passes both or neither of pack and suite', async () => {
    const deps = await makeDeps({ marketUrl: 'https://market.test', packsDir: '/w/.docwright/packs' })
    const tool = defineMarketInstallTool(deps)
    await expect(tool.execute({ pack: 'a', suite: 'b' } as never, { signal } as never)).rejects.toThrow(/exactly one of pack or suite/)
    await expect(tool.execute({} as never, { signal } as never)).rejects.toThrow(/exactly one of pack or suite/)
  })

  it('installs the whole suite on confirm and reports the suite name', async () => {
    const deps = await makeDeps({ marketUrl: 'https://market.test', packsDir: '/w/.docwright/packs' })
    const tool = defineMarketInstallTool(deps)
    const calls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input))
      return suiteMarket()(input)
    }) as typeof fetch
    // The confirm path needs a real packsDir + loader; use the tool with the
    // bare-deps error instead: the wiring guard fires before any fetch.
    const bare = { packs: deps.packs, config: deps.config }
    const bareTool = defineMarketInstallTool(bare as never)
    await expect(bareTool.execute({ suite: 'cosmic', confirm: true } as never, { signal } as never)).rejects.toThrow(/requires the plugin wiring/)
    expect(calls).toEqual([])
    void tool
    void globalThis.fetch
    globalThis.fetch = realFetch
  })
})

describe('doc_market_install tool: suite confirm (real install)', () => {
  it('lands the suite members plus upstreams on confirm and hot-reloads the map', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { dirHash } = await import('../src/pack-manage.ts')
    const execFileAsync = promisify(execFile)
    const packsDir = await mkdtemp(join(tmpdir(), 'docwright-suite-tool-'))
    const parent = await mkdtemp(join(tmpdir(), 'docwright-suite-tgz-'))
    const makePack = async (name: string): Promise<Buffer> => {
      const content = join(parent, name)
      for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(content, sub), { recursive: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(content, 'manifest.json'), JSON.stringify({ name, version: '1', description: 'd', consumes: name === 'top' ? ['base'] : [], languages: ['zh-CN'] }), 'utf8')
      await writeFile(join(content, 'rules', 'zh-CN.json'), JSON.stringify([{ id: `${name}/r`, severity: 'error', given: '$', field: 'name', kind: 'minLength', min: 1, suggestion: 's' }]), 'utf8')
      await writeFile(join(content, 'schema.json'), '{"type":"object"}', 'utf8')
      await writeFile(join(content, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
      await writeFile(join(content, 'templates', 'zh-CN.hbs'), 't', 'utf8')
      await writeFile(join(content, 'samples', 'golden.json'), '{}', 'utf8')
      const tgzPath = join(parent, `${name}.tgz`)
      await execFileAsync('tar', ['-czf', tgzPath, '-C', content, '.'])
      return readFile(tgzPath)
    }
    const [baseTgz, topTgz] = [await makePack('base'), await makePack('top')]
    const hashes = { base: await dirHash(join(parent, 'base')), top: await dirHash(join(parent, 'top')) }
    const deps = await makeDeps({ marketUrl: 'https://market.test', packsDir })
    const tool = defineMarketInstallTool(deps)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/index')) {
        return new Response(JSON.stringify({ packs: [
          { name: 'base', version: '1', tarball: '/tarballs/base.tgz', tarballSha256: `sha256:${createHash('sha256').update(baseTgz).digest('hex')}`, contentHash: hashes.base, consumes: [] },
          { name: 'top', version: '1', tarball: '/tarballs/top.tgz', tarballSha256: `sha256:${createHash('sha256').update(topTgz).digest('hex')}`, contentHash: hashes.top, consumes: ['base'] },
        ] }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/api/suites/')) {
        return new Response(JSON.stringify({ name: 'cosmic', version: '1', members: ['top'] }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/tarballs/base.tgz')) return new Response(baseTgz, { headers: { 'content-type': 'application/gzip' } })
      if (url.endsWith('/tarballs/top.tgz')) return new Response(topTgz, { headers: { 'content-type': 'application/gzip' } })
      throw new Error(`unexpected fetch ${url}`)
    }) as typeof fetch
    try {
      const out = await tool.execute({ suite: 'cosmic', confirm: true } as never, { signal } as never) as { status: string; suite?: string; installed: string[] }
      expect(out.status).toBe('installed')
      expect(out.suite).toBe('cosmic')
      expect(out.installed.map(row => row.split('@')[0])).toEqual(['base', 'top'])
      expect(deps.packs.get('top')?.manifest.name).toBe('top')
    } finally {
      globalThis.fetch = realFetch
      await rm(packsDir, { recursive: true, force: true })
      await rm(parent, { recursive: true, force: true })
    }
  })
})
