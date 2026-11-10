import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readMaterialEntries } from '../src/materials.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { artifactHashOf } from '../src/receipt.ts'
import { defineDocGenerateTool, defineDocValidateTool } from '../src/tools.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))
const signal = new AbortController().signal

/** Scripted LLM port that replies with the given texts in order (stays on the last one); records call count. */
function scriptedLlm(replies: string[]): { llm: unknown; calls: () => number } {
  let n = 0
  return {
    calls: () => n,
    llm: {
      stream: async function* () {
        const reply = replies[Math.min(n, replies.length - 1)]
        n++
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: 'stop' }
      },
    },
  }
}

/** Minimal fixture pack: schema-free ({} validates), no rules, workspace-scope (reuse defaults true). */
async function writeFixturePack(root: string, name: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(join(dir, 'rules'), { recursive: true })
  await mkdir(join(dir, 'prompts'), { recursive: true })
  await mkdir(join(dir, 'templates'), { recursive: true })
  await mkdir(join(dir, 'samples'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name, version: '1.0.0', description: `${name} fixture`, consumes: [], languages: ['zh-CN'], scope: 'workspace' }), 'utf8')
  await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
  await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
  await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'p {{materials}} {{upstream}} {{params}}', 'utf8')
  await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
  await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
}

interface Harness {
  wsRoot: string
  packs: ReadonlyMap<string, unknown>
  generate(materials: string[], reply?: string, extra?: Record<string, unknown>): Promise<{ reused?: boolean; artifactPath: string; materials?: Array<{ ref: string; path: string }>; receipt: { isValid: boolean; materials?: Array<{ ref: string; hash: string }> } }>
}

/** Workspace-scope fixture pack + workspace with a references/ dir; each generate call gets a fresh scripted LLM. */
async function makeHarness(): Promise<Harness> {
  const packRoot = await mkdtemp(join(tmpdir(), 'docwright-mf-pack-'))
  await writeFixturePack(packRoot, 'ws-pack')
  const packs = await loadPacks(packsRoot, { extra: [packRoot] })
  const wsRoot = await mkdtemp(join(tmpdir(), 'docwright-mf-ws-'))
  await mkdir(join(wsRoot, 'references'), { recursive: true })
  const deps = { packs, config: { provider: 'p', model: 'm', workspaceRoot: wsRoot } as never, ctx: { llm: {} } }
  return {
    wsRoot,
    packs,
    generate(materials, reply = '{"v":1}', extra = {}) {
      deps.ctx = { llm: scriptedLlm([reply]).llm }
      return defineDocGenerateTool(deps).execute({ pack: 'ws-pack', materials, language: 'zh-CN', artifactName: 'ctx', ...extra } as never, { signal } as never) as never
    },
  }
}

async function writeMaterial(wsRoot: string, name: string, content: string): Promise<void> {
  await writeFile(join(wsRoot, 'references', name), content, 'utf8')
}

describe('materials freshness (reuse pre-check)', () => {
  it('reuses on identical materials and regenerates when a file\'s content changed', async () => {
    const h = await makeHarness()
    await writeMaterial(h.wsRoot, 'mat.txt', 'v1')
    const first = await h.generate(['mat.txt'])
    expect(first.reused).toBeUndefined()
    expect(first.receipt.materials).toEqual([{ ref: 'mat.txt', hash: await hashOf(join(h.wsRoot, 'references', 'mat.txt')) }])

    const again = await h.generate(['mat.txt'], '{"v":2}')
    expect(again.reused).toBe(true)

    await writeMaterial(h.wsRoot, 'mat.txt', 'v2-changed')
    const stale = await h.generate(['mat.txt'])
    expect(stale.reused).toBeUndefined()
    expect(stale.receipt.materials).toEqual([{ ref: 'mat.txt', hash: await hashOf(join(h.wsRoot, 'references', 'mat.txt')) }])
  })

  it('regenerates on any set drift: an extra ref or a missing ref', async () => {
    const h = await makeHarness()
    await writeMaterial(h.wsRoot, 'a.txt', 'A')
    await writeMaterial(h.wsRoot, 'b.txt', 'B')
    await h.generate(['a.txt'])

    const wider = await h.generate(['a.txt', 'b.txt'])
    expect(wider.reused).toBeUndefined()
    const narrower = await h.generate(['b.txt'])
    expect(narrower.reused).toBeUndefined()
  })

  it('regenerates when inline text changes, and records the #!inline marker as the ref', async () => {
    const h = await makeHarness()
    const first = await h.generate(['#!inline\n需求一'])
    expect(first.receipt.materials).toEqual([{ ref: '#!inline', hash: expect.any(String) }])
    const second = await h.generate(['#!inline\n需求一'], '{"v":2}')
    expect(second.reused).toBe(true)
    const changed = await h.generate(['#!inline\n需求二'])
    expect(changed.reused).toBeUndefined()
  })

  it('compares multisets canonically: order and ref spelling do not matter', async () => {
    const h = await makeHarness()
    await writeMaterial(h.wsRoot, 'a.txt', 'A')
    await writeMaterial(h.wsRoot, 'b.txt', 'B')
    await h.generate(['a.txt', 'b.txt'])
    const swapped = await h.generate(['b.txt', 'a.txt'], '{"v":2}')
    expect(swapped.reused).toBe(true)
    // The double-prefixed spelling resolves to the same file via the strip
    // fallback, so the canonical ref (and therefore the manifest) matches.
    const prefixed = await h.generate(['references/a.txt', 'references/b.txt'], '{"v":2}')
    expect(prefixed.reused).toBe(true)
  })

  it('keeps duplicates significant: a doubled ref is a different multiset', async () => {
    const h = await makeHarness()
    await writeMaterial(h.wsRoot, 'a.txt', 'A')
    await h.generate(['a.txt'])
    const doubled = await h.generate(['a.txt', 'a.txt'])
    expect(doubled.reused).toBeUndefined()
  })

  it('an unparseable artifact of the addressed name falls through to regeneration', async () => {
    const h = await makeHarness()
    await writeMaterial(h.wsRoot, 'mat.txt', 'v1')
    const first = await h.generate(['mat.txt'])
    await writeFile(first.artifactPath, '{not json', 'utf8')
    const rerun = await h.generate(['mat.txt'], '{"v":2}')
    expect(rerun.reused).toBeUndefined()
  })

  it('a legacy receipt without a materials manifest never reuses', async () => {
    const h = await makeHarness()
    await writeMaterial(h.wsRoot, 'mat.txt', 'v1')
    const first = await h.generate(['mat.txt'])
    const receiptPath = first.artifactPath.replace(/\.json$/, '.receipt.json')
    const legacy = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
    delete legacy.materials
    await writeFile(receiptPath, JSON.stringify(legacy, null, 2), 'utf8')
    const rerun = await h.generate(['mat.txt'], '{"v":2}')
    expect(rerun.reused).toBeUndefined()
    expect(JSON.parse(await readFile(receiptPath, 'utf8')).materials).toBeTruthy()
  })

  it('a deleted material file fails loud even when a reusable artifact exists', async () => {
    const h = await makeHarness()
    await writeMaterial(h.wsRoot, 'mat.txt', 'v1')
    await h.generate(['mat.txt'])
    await rm(join(h.wsRoot, 'references', 'mat.txt'))
    await expect(h.generate(['mat.txt'])).rejects.toThrow(/material not readable/)
  })

  it('doc_validate\'s seal carries the manifest forward, so reuse keeps working after a human edit', async () => {
    const h = await makeHarness()
    await writeMaterial(h.wsRoot, 'mat.txt', 'v1')
    const first = await h.generate(['mat.txt'])
    // External edit → the old receipt no longer matches the content…
    await writeFile(first.artifactPath, '{"v":999}\n', 'utf8')
    const vdeps = { packs: h.packs, config: { provider: 'p', model: 'm', workspaceRoot: h.wsRoot } as never, ctx: { llm: {} } }
    const check = await defineDocValidateTool(vdeps).execute({
      artifactPath: 'context/ctx.json', pack: 'ws-pack', language: 'zh-CN',
    } as never, { signal } as never) as { sealed?: boolean; hashMatches: boolean | null; receipt: { materials?: unknown[] } }
    expect(check.sealed).toBe(true)
    expect(check.hashMatches).toBe(false)
    expect(check.receipt.materials).toBeTruthy()
    // …and the sealed artifact is green + input-fresh, so doc_generate reuses it.
    const rerun = await h.generate(['mat.txt'], '{"v":2}')
    expect(rerun.reused).toBe(true)
    const artifact = JSON.parse(await readFile(first.artifactPath, 'utf8')) as { v: number }
    expect(artifact.v).toBe(999)
  })
})

async function hashOf(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path, 'utf8')).digest('hex')
}

/** Minimal chained fixture pack: consumes ws-pack, topic-scoped, reuse: true, one optional param. */
async function writeChainedPack(root: string, name: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(join(dir, 'rules'), { recursive: true })
  await mkdir(join(dir, 'prompts'), { recursive: true })
  await mkdir(join(dir, 'templates'), { recursive: true })
  await mkdir(join(dir, 'samples'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    name, version: '1.0.0', description: `${name} fixture`, consumes: ['ws-pack'], languages: ['zh-CN'],
    scope: 'topic', reuse: true, requiresTopic: true,
    params: { myParam: { type: 'string', default: 'x', description: 'optional tunable' } },
  }), 'utf8')
  await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
  await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
  await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'p {{materials}} {{upstream}} {{params}}', 'utf8')
  await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
  await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
}

describe('chained reuse pre-check (upstream anchors, addressing, params)', () => {
  interface ChainHarness {
    wsRoot: string
    generate(upstream: string[], extra?: Record<string, unknown>): Promise<{ reused?: boolean; artifactPath: string }>
    rewriteUpstream(path: string, content: unknown): Promise<void>
  }

  async function makeChainHarness(): Promise<ChainHarness> {
    const packRoot = await mkdtemp(join(tmpdir(), 'docwright-cr-pack-'))
    await writeFixturePack(packRoot, 'ws-pack')
    await writeChainedPack(packRoot, 'ch-pack')
    const packs = await loadPacks(packsRoot, { extra: [packRoot] })
    const wsRoot = await mkdtemp(join(tmpdir(), 'docwright-cr-ws-'))
    await mkdir(join(wsRoot, 'context'), { recursive: true })
    await writeFile(join(wsRoot, 'context', 'wsart.json'), '{"v":1}\n', 'utf8')
    await writeFile(join(wsRoot, 'context', 'wsart.receipt.json'), JSON.stringify({
      pack: 'ws-pack', packVersion: '1.0.0', isValid: true, artifactHash: artifactHashOf({ v: 1 }),
    }), 'utf8')
    const deps = { packs, config: { provider: 'p', model: 'm', workspaceRoot: wsRoot } as never, ctx: { llm: {} } }
    return {
      wsRoot,
      generate(upstream, extra = {}) {
        deps.ctx = { llm: scriptedLlm(['{"d":1}']).llm }
        return defineDocGenerateTool(deps).execute({
          pack: 'ch-pack', topic: 't1', materials: [], language: 'zh-CN', artifactName: 'one', upstream, confirm: true, ...extra,
        } as never, { signal } as never) as never
      },
      async rewriteUpstream(path, content) {
        await writeFile(join(wsRoot, path), `${JSON.stringify(content)}\n`, 'utf8')
        const receiptPath = join(wsRoot, path.replace(/\.json$/, '.receipt.json'))
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { artifactHash: string }
        receipt.artifactHash = artifactHashOf(content)
        await writeFile(receiptPath, JSON.stringify(receipt), 'utf8')
      },
    }
  }

  it('reuses a green chained artifact on identical inputs and regenerates when the upstream changed', async () => {
    const h = await makeChainHarness()
    const first = await h.generate(['context/wsart.json'])
    expect(first.reused).toBeUndefined()
    const again = await h.generate(['context/wsart.json'], { artifactName: 'one', topic: 't1' })
    expect(again.reused).toBe(true)
    await h.rewriteUpstream('context/wsart.json', { v: 2 })
    const stale = await h.generate(['context/wsart.json'], { artifactName: 'one', topic: 't1' })
    expect(stale.reused).toBeUndefined()
  })

  it('an explicit non-addressing param skips reuse; a different addressed name is simply another artifact', async () => {
    const h = await makeChainHarness()
    await h.generate(['context/wsart.json'])
    const drifted = await h.generate(['context/wsart.json'], { artifactName: 'one', topic: 't1', params: { myParam: 'y' } })
    expect(drifted.reused).toBeUndefined()
    const other = await h.generate(['context/wsart.json'], { artifactName: 'two', topic: 't1' })
    expect(other.reused).toBeUndefined()
    expect(other.artifactPath).toContain('two.json')
  })
})

describe('resolved material paths surface in the doc_generate result', () => {
  it('the result reports the anchored file path on generation and on reuse', async () => {
    const h = await makeHarness()
    await writeMaterial(h.wsRoot, 'a.md', 'A')
    const expectedPath = join(h.wsRoot, 'references', 'a.md')
    const first = await h.generate(['a.md'])
    expect(first.receipt.isValid).toBe(true)
    expect(first.materials).toEqual([{ ref: 'a.md', path: expectedPath }])
    const second = await h.generate(['a.md'])
    expect(second.reused).toBe(true)
    expect(second.materials).toEqual([{ ref: 'a.md', path: expectedPath }])
  })

  it('dual roots: the topic-level file wins and its path is what the entry records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-dual-root-'))
    try {
      const topicDir = join(root, 'T1 topic')
      await mkdir(join(topicDir, 'input'), { recursive: true })
      await mkdir(join(root, 'input'), { recursive: true })
      await writeFile(join(topicDir, 'input', 'm.md'), 'topic-level', 'utf8')
      await writeFile(join(root, 'input', 'm.md'), 'workspace-level', 'utf8')
      const entries = await readMaterialEntries(['m.md'], root, [join(topicDir, 'input'), join(root, 'input')])
      expect(entries).toHaveLength(1)
      expect(entries[0]!.text).toBe('topic-level')
      expect(entries[0]!.path).toBe(join(topicDir, 'input', 'm.md'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
