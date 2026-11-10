import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineDocGenerateTool, defineDocPacksTool, defineDocValidateTool } from '../src/tools.ts'
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
    expect(plan).toMatchObject({ version: '0.7.1', languages: ['zh-CN', 'en-US'], consumes: ['cosmic-context'] })
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
