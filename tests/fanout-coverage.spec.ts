import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadPacks } from '../src/pack-loader.ts'
import type { Pack } from '../src/pack.ts'
import { defineDocChainStatusTool, defineDocGenerateTool } from '../src/tools.ts'
import { seedContext } from './support.ts'
import type { LlmPort } from '../src/llm-port.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))
const signal = new AbortController().signal
const BUDGET = { value: 70, downFactor: 0.9, upFactor: 1.2 }

async function packs(): Promise<{ req: Pack; plan: Pack }> {
  const all = await loadPacks(packsRoot, {})
  return { req: all.get('cosmic-req')!, plan: all.get('cosmic-plan')! }
}

/** Scripted multi-reply LLM seam (one reply per model call). */
/** dsh-web-style host ctx: the tool layer reads ctx.llm through createLlmPort. */
async function makeDeps(replies: string[]) {
  const all = await loadPacks(packsRoot, {})
  const ws = await mkdtemp(join(tmpdir(), 'docwright-fanout-'))
  const replyHolder = { lastReply: replies[0] ?? '{}' }
  let call = 0
  const ctx = {
    llm: {
      stream: async function* () {
        const reply = replies[Math.min(call, replies.length - 1)]!
        call++
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: 'stop' }
      },
    },
  }
  return {
    packs: all,
    ws,
    ctx,
    config: { provider: 'p', model: 'm', workspaceRoot: ws, maxIterations: 2, promptTokenBudget: 60_000 },
    replyHolder,
  }
}

describe('fan-out contract: targetIndex selection', () => {
  it('fails loud with the plan candidates when targetIndex is missing', async () => {
    const deps = await makeDeps([JSON.stringify((await packs()).plan.goldenSample)])
    await seedContext(deps as never)
    await defineDocGenerateTool(deps as never).execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: BUDGET }, confirm: true, artifactName: 'plan' } as never, { signal } as never)
    await expect(defineDocGenerateTool(deps as never).execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n素材'], language: 'zh-CN', artifactName: 'req', upstream: ['topic-a/output/plan.json'], confirm: true,
    } as never, { signal } as never)).rejects.toThrow(/missing required pack params for "cosmic-req": targetIndex.*Candidates from the upstream plan: 1\. KERQ-352-01 \(添加收藏\); 2\. KERQ-352-02 \(删除收藏\)/)
  })

  it('auto-names per-function artifacts `<pack>-<funcId>` and reports stage coverage', async () => {
    const { req } = await packs()
    const deps = await makeDeps([JSON.stringify((await packs()).plan.goldenSample), JSON.stringify(req.goldenSample)])
    const gen = defineDocGenerateTool(deps as never)
    await seedContext(deps as never)
    await gen.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: BUDGET }, confirm: true, artifactName: 'plan' } as never, { signal } as never)
    const out = await gen.execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n收藏功能需求素材'], language: 'zh-CN', upstream: ['topic-a/output/plan.json'], params: { targetIndex: 1 }, confirm: true,
    } as never, { signal } as never) as { artifactPath: string; coverage?: { covered: number; total: number; missing: string[] } }
    expect(out.artifactPath.endsWith('cosmic-req-KERQ-352-01.json')).toBe(true)
    expect(out.coverage).toEqual({ covered: 1, total: 2, missing: ['KERQ-352-02'] })
  })

  it('refuses an explicit artifactName on a per-function call (naming is engine-owned)', async () => {
    const { req } = await packs()
    const deps = await makeDeps([JSON.stringify((await packs()).plan.goldenSample), JSON.stringify(req.goldenSample)])
    const gen = defineDocGenerateTool(deps as never)
    await seedContext(deps as never)
    await gen.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: BUDGET }, confirm: true, artifactName: 'plan' } as never, { signal } as never)
    await expect(gen.execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n素材'], language: 'zh-CN', upstream: ['topic-a/output/plan.json'], params: { targetIndex: 1 }, confirm: true, artifactName: 'req' } as never, { signal } as never))
      .rejects.toThrow(/engine-named \(artifactPrefix "REQ"\)[\s\S]*REQ-<topicNo>/)
  })

  it('numbers funcIds from the topic and names artifacts REQ-<topicNo>-<NN>', async () => {
    const { plan, req } = await packs()
    const planScript = JSON.parse(JSON.stringify(plan.goldenSample)) as { functions: Array<{ funcId: string }> }
    planScript.functions[0]!.funcId = 'KERQ-352-01'
    planScript.functions[1]!.funcId = 'KERQ-352-02'
    const reqScript = JSON.parse(JSON.stringify(req.goldenSample)) as { funcId: string }
    reqScript.funcId = 'KERQ-352-01'
    const deps = await makeDeps([JSON.stringify(planScript), JSON.stringify(reqScript)])
    const gen = defineDocGenerateTool(deps as never)
    await seedContext(deps as never)
    await gen.execute({ pack: 'cosmic-plan', topic: 'KERQ-352-favorites', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: BUDGET }, confirm: true } as never, { signal } as never)
    const out = await gen.execute({ pack: 'cosmic-req', topic: 'KERQ-352-favorites', materials: ['#!inline\n素材'], language: 'zh-CN', upstream: ['KERQ-352-favorites/output/PLAN-KERQ-352.json'], params: { targetIndex: 1 }, confirm: true } as never, { signal } as never) as { artifactPath: string; receipt: { isValid: boolean } }
    expect(out.receipt.isValid).toBe(true)
    expect(out.artifactPath.endsWith('REQ-KERQ-352-01.json')).toBe(true)
  })

  it('fails loud on an invalid topicNoPattern regex', async () => {
    const deps = await makeDeps([JSON.stringify((await packs()).plan.goldenSample)])
    const gen = defineDocGenerateTool(deps as never)
    await seedContext(deps as never)
    await expect(gen.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: BUDGET, topicNoPattern: '(' }, confirm: true } as never, { signal } as never))
      .rejects.toThrow(/topicNoPattern is not a valid regex/)
  })

  it('fails loud on a malformed artifactPrefix at load time', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const root = await mkdtemp(join(tmpdir(), 'docwright-prefix-'))
    const dir = join(root, 'bad-pack')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'bad-pack', version: '1', description: 'd', scope: 'topic', languages: ['zh-CN'], artifactPrefix: '!!!' }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'C {{materials}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(import('../src/pack-loader.ts').then(m => m.loadPacks(root, {}))).rejects.toThrow(/artifactPrefix must be/)
  })

  it('refuses an explicit artifactName on a prefixed whole-requirement call', async () => {
    const { plan } = await packs()
    const deps = await makeDeps([JSON.stringify(plan.goldenSample)])
    const gen = defineDocGenerateTool(deps as never)
    await seedContext(deps as never)
    await expect(gen.execute({ pack: 'cosmic-plan', topic: 'KERQ-352-x', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: BUDGET }, confirm: true, artifactName: 'plan' } as never, { signal } as never))
      .rejects.toThrow(/engine-named \(artifactPrefix "PLAN"\)[\s\S]*PLAN-KERQ-352/)
  })

  it('generates the second function when targetIndex picks it', async () => {
    const { req } = await packs()
    const second = JSON.parse(JSON.stringify(req.goldenSample)) as { index: number; funcId: string; desiredCfps: number; l2Name: string }
    second.index = 2
    second.funcId = 'KERQ-352-02'
    // The display hierarchy is anchored to the picked plan function (req/plan-alignment).
    second.l2Name = '删除收藏'
    const deps = await makeDeps([JSON.stringify((await packs()).plan.goldenSample), JSON.stringify(second)])
    const gen = defineDocGenerateTool(deps as never)
    await seedContext(deps as never)
    await gen.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: BUDGET }, confirm: true, artifactName: 'plan' } as never, { signal } as never)
    const out = await gen.execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n素材'], language: 'zh-CN', upstream: ['topic-a/output/plan.json'], params: { targetIndex: 2 }, confirm: true,
    } as never, { signal } as never) as { artifactPath: string; receipt: { isValid: boolean } }
    expect(out.receipt.isValid).toBe(true)
    expect(out.artifactPath.endsWith('cosmic-req-KERQ-352-02.json')).toBe(true)
  })

  it('lists the candidates in pendingConfirmation when the chain head was never confirmed', async () => {
    const { plan } = await packs()
    const deps = await makeDeps(['{}'])
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { artifactHashOf } = await import('../src/receipt.ts')
    await mkdir(join(deps.ws, 'topic-a', 'output'), { recursive: true })
    await writeFile(join(deps.ws, 'topic-a', 'output', 'plan.json'), JSON.stringify(plan.goldenSample), 'utf8')
    // Green receipt WITHOUT recorded params: the confirm params are unsatisfied.
    await writeFile(join(deps.ws, 'topic-a', 'output', 'plan.receipt.json'), JSON.stringify({
      pack: 'cosmic-plan', packVersion: '0.7.0', artifactHash: artifactHashOf(plan.goldenSample), isValid: true,
    }), 'utf8')
    const out = await defineDocGenerateTool(deps as never).execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n素材'], language: 'zh-CN', upstream: ['topic-a/output/plan.json'],
    } as never, { signal } as never) as { pendingConfirmation: boolean; missingRequired: string[]; candidates?: Array<{ index: number; funcId: string }> }
    expect(out.pendingConfirmation).toBe(true)
    expect(out.missingRequired).toContain('targetIndex')
    expect(out.candidates?.map(c => c.funcId)).toEqual(['KERQ-352-01', 'KERQ-352-02'])
  })
})

describe('doc_chain_status: coverage accounting', () => {
  async function workspaceWithReq1() {
    const { req } = await packs()
    const deps = await makeDeps([JSON.stringify((await packs()).plan.goldenSample), JSON.stringify(req.goldenSample)])
    const gen = defineDocGenerateTool(deps as never)
    await seedContext(deps as never)
    await gen.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: BUDGET }, confirm: true, artifactName: 'plan' } as never, { signal } as never)
    await gen.execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n素材'], language: 'zh-CN', upstream: ['topic-a/output/plan.json'], params: { targetIndex: 1 }, confirm: true,
    } as never, { signal } as never)
    return deps
  }

  it('builds the coverage matrix over the consuming stages', async () => {
    const deps = await workspaceWithReq1()
    const out = await defineDocChainStatusTool(deps as never).execute({ plan: 'topic-a/output/plan.json' } as never, { signal } as never) as {
      stages: string[]
      functions: Array<{ index: number; funcId: string; l2Name?: string; coverage: Record<string, string | null> }>
      coverage: Record<string, { covered: number; total: number }>
      orphaned?: unknown[]
    }
    expect(out.stages).toEqual(['cosmic-req', 'cosmic-func', 'cosmic-tech'])
    expect(out.functions).toHaveLength(2)
    expect(out.functions[0]!.funcId).toBe('KERQ-352-01')
    expect(out.functions[0]!.l2Name).toBe('添加收藏')
    expect(out.functions[0]!.coverage['cosmic-req']).toBe('cosmic-req-KERQ-352-01')
    expect(out.functions[0]!.coverage['cosmic-func']).toBeNull()
    expect(out.functions[1]!.coverage['cosmic-req']).toBeNull()
    expect(out.coverage['cosmic-req']).toEqual({ covered: 1, total: 2 })
    expect(out.coverage['cosmic-tech']).toEqual({ covered: 0, total: 2 })
    expect(out.orphaned).toBeUndefined()
  })

  it('flags green stage artifacts whose funcId matches no plan function', async () => {
    const deps = await workspaceWithReq1()
    const { artifactHashOf } = await import('../src/receipt.ts')
    const ghost = { docType: 'req', funcId: 'GHOST-01', language: 'zh-CN' }
    await writeFile(join(deps.ws, 'topic-a', 'output', 'ghost.json'), JSON.stringify(ghost), 'utf8')
    await writeFile(join(deps.ws, 'topic-a', 'output', 'ghost.receipt.json'), JSON.stringify({
      pack: 'cosmic-req', packVersion: '0.2.0', artifactHash: artifactHashOf(ghost), isValid: true,
    }), 'utf8')
    const out = await defineDocChainStatusTool(deps as never).execute({ plan: 'topic-a/output/plan.json' } as never, { signal } as never) as { orphaned?: Array<{ stage: string; file: string }> }
    expect(out.orphaned).toEqual([{ stage: 'cosmic-req', file: 'ghost.json (funcId GHOST-01 matches no plan function)' }])
  })

  it('covers the render hook and skips unreadable stage entries', async () => {
    const deps = await workspaceWithReq1()
    const tool = defineDocChainStatusTool(deps as never)
    const { mkdir, writeFile } = await import('node:fs/promises')
    // A stray artifact without a sidecar receipt is skipped, not fatal.
    await mkdir(join(deps.ws, 'topic-a', 'output'), { recursive: true })
    await writeFile(join(deps.ws, 'topic-a', 'output', 'stray.json'), '{}', 'utf8')
    const value = await tool.execute({ plan: 'topic-a/output/plan.json' } as never, { signal } as never) as unknown
    const rendered = tool.output.render({}, value) as Array<{ type: string; text: string }>
    expect(rendered[0]!.type).toBe('text')
    expect(rendered[0]!.text).toContain('cosmic-req-KERQ-352-01')
    const out = await tool.execute({ plan: 'topic-a/output/plan.json' } as never, { signal } as never) as { functions: Array<{ coverage: Record<string, string | null> }> }
    expect(out.functions[0]!.coverage['cosmic-req']).toBe('cosmic-req-KERQ-352-01')
    // Unreadable JSON plan artifact fails loud.
    await writeFile(join(deps.ws, 'topic-a', 'output', 'broken.json'), 'not json', 'utf8')
    await expect(tool.execute({ plan: 'topic-a/output/broken.json' } as never, { signal } as never)).rejects.toThrow(/is not readable JSON/)
  })

  it('handles an empty candidates list and a missing output root', async () => {
    const deps = await makeDeps(['{}'])
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { artifactHashOf } = await import('../src/receipt.ts')
    await mkdir(join(deps.ws, 'output'), { recursive: true })
    // Shapeless plan upstream: candidates list is empty, the error still fires.
    await writeFile(join(deps.ws, 'output', 'shapeless.json'), '{}', 'utf8')
    await writeFile(join(deps.ws, 'output', 'shapeless.receipt.json'), JSON.stringify({
      pack: 'cosmic-plan', packVersion: '0.7.0', artifactHash: artifactHashOf({}), isValid: true,
      params: { cfpTotal: { value: 1, downFactor: 1, upFactor: 1 }, cfpPerFunc: { value: 1, min: 1, max: 2 }, cfpMin: { value: 1, min: 1, max: 1 }, cfpMax: { value: 2, min: 1, max: 3 } },
    }), 'utf8')
    await expect(defineDocGenerateTool(deps as never).execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n素材'], language: 'zh-CN', upstream: ['output/shapeless.json'], confirm: true,
    } as never, { signal } as never)).rejects.toThrow(/missing required pack params for "cosmic-req": targetIndex/)
    // Chain status with no output directory at all: empty matrix, no crash.
    const ws2 = await mkdtemp(join(tmpdir(), 'docwright-fanout-noout-'))
    await writeFile(join(ws2, 'plan.json'), JSON.stringify({ docType: 'plan', functions: [{ funcId: 'A' }] }), 'utf8')
    await writeFile(join(ws2, 'plan.receipt.json'), JSON.stringify({
      pack: 'cosmic-plan', packVersion: '0.2.0', artifactHash: artifactHashOf({ docType: 'plan', functions: [{ funcId: 'A' }] }), isValid: true,
    }), 'utf8')
    const packs2 = await loadPacks(packsRoot, {})
    const out = await defineDocChainStatusTool({ packs: packs2, config: { workspaceRoot: ws2, provider: 'p', model: 'm' } as never, ctx: {} } as never).execute({ plan: 'plan.json' } as never, { signal } as never) as { coverage: Record<string, { covered: number }> }
    expect(out.coverage['cosmic-req']).toEqual({ covered: 0, total: 1 })
  })

  it('fails loud on a red or missing plan receipt and on a functionless plan', async () => {
    const deps = await makeDeps(['{}'])
    const tool = defineDocChainStatusTool(deps as never)
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { artifactHashOf } = await import('../src/receipt.ts')
    await mkdir(join(deps.ws, 'output'), { recursive: true })
    await writeFile(join(deps.ws, 'output', 'p.json'), JSON.stringify({ docType: 'plan', functions: [{ funcId: 'A' }] }), 'utf8')
    await expect(tool.execute({ plan: 'output/p.json' } as never, { signal } as never)).rejects.toThrow(/no usable sidecar receipt/)
    await writeFile(join(deps.ws, 'output', 'p.receipt.json'), JSON.stringify({
      pack: 'cosmic-plan', packVersion: '0.2.0', artifactHash: artifactHashOf({ docType: 'plan', functions: [{ funcId: 'A' }] }), isValid: false,
    }), 'utf8')
    await expect(tool.execute({ plan: 'output/p.json' } as never, { signal } as never)).rejects.toThrow(/receipt is RED/)
    const empty = { docType: 'plan', functions: [] }
    await writeFile(join(deps.ws, 'output', 'p.json'), JSON.stringify(empty), 'utf8')
    await writeFile(join(deps.ws, 'output', 'p.receipt.json'), JSON.stringify({
      pack: 'cosmic-plan', packVersion: '0.2.0', artifactHash: artifactHashOf(empty), isValid: true,
    }), 'utf8')
    await expect(tool.execute({ plan: 'output/p.json' } as never, { signal } as never)).rejects.toThrow(/declares no functions\[\]/)
  })
})
