import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRuleEngine } from '../src/rule-engine.ts'
import { loadPacks } from '../src/pack-loader.ts'
import type { DeclarativeRule, Pack } from '../src/pack.ts'
import { resolveEffectiveParams } from '../src/params.ts'
import { assembleGeneratorPrompt } from '../src/prompt.ts'
import { defineDocGenerateTool, defineDocPacksTool, defineDocValidateTool } from '../src/tools.ts'
import { generateDocument } from '../src/doc-service.ts'
import type { LlmPort } from '../src/llm-port.ts'
import { fileURLToPath } from 'node:url'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))
const signal = new AbortController().signal

function fakePack(over: Record<string, unknown> = {}): never {
  return { manifest: { name: 'p', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }, ...over } as never
}

const limitParam = { type: 'number', default: 3, min: 1, max: 20, description: 'max title length' }
const paramRule: DeclarativeRule = { id: 'p/title-max', severity: 'error', given: '$', field: 'title', kind: 'maxLength', max: { param: 'limit' }, suggestion: 'shorten the title' }

async function writeParamPack(root: string, name: string, over: Record<string, unknown> = {}): Promise<void> {
  const dir = join(root, name)
  for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name, version: '1', description: 'd', consumes: [], languages: ['zh-CN'], params: { limit: limitParam }, ...over }), 'utf8')
  await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
  await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify([paramRule]), 'utf8')
  await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}{{params}}', 'utf8')
  await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
  await writeFile(join(dir, 'samples', 'golden.json'), '{"title":"abcdef"}', 'utf8')
}

describe('resolveEffectiveParams', () => {
  async function paramPack(): Promise<Pack> {
    const root = await mkdtemp(join(tmpdir(), 'docwright-resolve-'))
    await writeParamPack(root, 'param-pack')
    const packs = await loadPacks(root, {})
    const pack = packs.get('param-pack')
    if (pack === undefined) throw new Error('param-pack not loaded')
    return pack
  }

  it('defaults when nothing is overridden', async () => {
    expect(resolveEffectiveParams(await paramPack(), undefined)).toEqual({ limit: 3 })
  })

  it('applies call-time overrides', async () => {
    expect(resolveEffectiveParams(await paramPack(), { limit: 10 })).toEqual({ limit: 10 })
  })

  it('fails loud on unknown names with the available list', async () => {
    const pack = await paramPack()
    expect(() => resolveEffectiveParams(pack, { nope: 1 })).toThrow(/unknown pack param "nope".*available: limit/)
  })

  it('fails loud on type and bound violations', async () => {
    const pack = await paramPack()
    expect(() => resolveEffectiveParams(pack, { limit: '10' })).toThrow(/must be a number/)
    expect(() => resolveEffectiveParams(pack, { limit: 0 })).toThrow(/must be >= 1/)
    expect(() => resolveEffectiveParams(pack, { limit: 99 })).toThrow(/must be <= 20/)
  })

  it('seeds from the receipt-recorded base and rejects violating base values', async () => {
    const pack = await paramPack()
    expect(resolveEffectiveParams(pack, undefined, { limit: 12 })).toEqual({ limit: 12 })
    expect(() => resolveEffectiveParams(pack, undefined, { limit: 'x' })).toThrow(/receipt-recorded.*must be a number/)
  })

  it('a pack without declared params rejects any override', () => {
    expect(() => resolveEffectiveParams(fakePack(), { limit: 3 })).toThrow(/available: none declared/)
  })

  it('fails loud on enum violations and seeded bound violations', () => {
    const pack = fakePack({
      manifest: {
        name: 'p', version: '1', description: 'd', consumes: [], languages: ['zh-CN'],
        params: {
          tone: { type: 'string', default: 'a', description: 'd', enum: ['a', 'b'] },
          n: { type: 'number', default: 5, min: 1, max: 9, description: 'd' },
        },
      },
    })
    expect(() => resolveEffectiveParams(pack, { tone: 'z' })).toThrow(/must be one of \["a", "b"\]/)
    expect(() => resolveEffectiveParams(pack, undefined, { n: 0 })).toThrow(/receipt-recorded.*must be >= 1/)
    expect(() => resolveEffectiveParams(pack, undefined, { n: 50 })).toThrow(/receipt-recorded.*must be <= 9/)
  })
})

describe('pack loader: params declaration is the allowlist', () => {
  const badSpecs: Array<[string, Record<string, unknown>]> = [
    ['bad type', { type: 'array', default: 'x', description: 'd' }],
    ['missing description', { type: 'string', default: 'x' }],
    ['default type mismatch', { type: 'number', default: 'x', description: 'd' }],
    ['enum not array', { type: 'string', default: 'a', description: 'd', enum: 'a' }],
    ['enum empty', { type: 'string', default: 'a', description: 'd', enum: [] }],
    ['enum wrong member type', { type: 'string', default: 'a', description: 'd', enum: ['a', 1] }],
    ['default not in enum', { type: 'string', default: 'b', description: 'd', enum: ['a'] }],
    ['min not number', { type: 'number', default: 5, description: 'd', min: '1' }],
    ['max not number', { type: 'number', default: 5, description: 'd', max: '9' }],
    ['min greater than max', { type: 'number', default: 5, description: 'd', min: 9, max: 1 }],
    ['default below min', { type: 'number', default: 0, description: 'd', min: 1, max: 9 }],
    ['default above max', { type: 'number', default: 99, description: 'd', min: 1, max: 9 }],
    ['min on string param', { type: 'string', default: 'a', description: 'd', min: 1 }],
  ]

  for (const [label, spec] of badSpecs) {
    it(`fails loud: ${label}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'docwright-param-bad-'))
      const dir = join(root, 'pp')
      await mkdir(join(dir, 'rules'), { recursive: true })
      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'pp', version: '1', description: 'd', languages: ['zh-CN'], params: { limit: spec } }), 'utf8')
      await expect(loadPacks(root, {})).rejects.toThrow(/manifest\.params/)
    })
  }

  it('fails loud when params itself is not an object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-param-shape-'))
    const dir = join(root, 'pp')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'pp', version: '1', description: 'd', languages: ['zh-CN'], params: [1] }), 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/manifest\.params must be an object/)
  })

  it('fails loud on maxRounds that is not a positive integer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-param-rounds-'))
    const dir = join(root, 'pp')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'pp', version: '1', description: 'd', languages: ['zh-CN'], maxRounds: 0 }), 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/manifest\.maxRounds must be a positive integer/)
  })

  it('fails loud when a rule references an undeclared or non-number param', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-param-ref-'))
    const dir = join(root, 'pp')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'pp', version: '1', description: 'd', languages: ['zh-CN'], params: { tone: { type: 'string', default: 'a', description: 'd' } } }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify([{ id: 'r', severity: 'error', given: '$', field: 'title', kind: 'maxLength', max: { param: 'nope' }, suggestion: 's' }]), 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/references undeclared param "nope"/)

    await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify([{ id: 'r', severity: 'error', given: '$', field: 'title', kind: 'maxLength', max: { param: 'tone' }, suggestion: 's' }]), 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/param "tone" of type "string"; bound references require a number/)
  })
})

describe('rule engine: param-referenced bounds', () => {
  function engineWithParamRule() {
    return createRuleEngine(fakePack({ rules: new Map([['zh-CN', [paramRule]]]), functionRules: [] }) as never, 'zh-CN')
  }

  it('resolves { param } bounds per call', () => {
    const engine = engineWithParamRule()
    expect(engine({ title: 'abcdef' }, { limit: 10 })).toEqual([])
    expect(engine({ title: 'abcdef' }, { limit: 3 }).length).toBe(1)
  })

  it('fails loud when a referenced param is missing from effective params (defensive)', () => {
    const engine = engineWithParamRule()
    expect(() => engine({ title: 'abcdef' }, {})).toThrow(/param "limit" did not resolve to a number/)
  })

  it('reports the resolved bound in the issue message', () => {
    const engine = engineWithParamRule()
    const issues = engine({ title: 'abcdef' }, { limit: 4 })
    expect(issues[0]!.message).toBe('length 6 > max 4')
  })
})

describe('prompt: {{params}} slot', () => {
  it('renders effective params and omits the block when none exist', () => {
    const withParams = assembleGeneratorPrompt({ promptTemplate: 'T{{params}}', materials: ['m'], params: { limit: 10, tone: 'formal' } })
    expect(withParams).toContain('<effective-params>')
    expect(withParams).toContain('"limit": 10')
    const without = assembleGeneratorPrompt({ promptTemplate: 'T{{params}}', materials: ['m'] })
    expect(without).toBe('T')
  })

  it('projects object params to their value field (bands stay out of the context)', () => {
    const out = assembleGeneratorPrompt({ promptTemplate: 'T{{params}}', materials: ['m'], params: { cfpPerFunc: { value: 30, min: 15, max: 45 }, cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 }, limit: 10 } })
    expect(out).toContain('"cfpPerFunc"')
    expect(out).toContain('"value": 30')
    expect(out).toContain('"cfpTotal"')
    expect(out).toContain('"value": 70')
    expect(out).not.toContain('"min"')
    expect(out).not.toContain('"max":')
    expect(out).not.toContain('"downFactor"')
    expect(out).toContain('"limit": 10')
  })

  it('does not mangle $-patterns inside rendered params', () => {
    const out = assembleGeneratorPrompt({ promptTemplate: 'T{{params}}', materials: ['m'], params: { note: '$& $`' } })
    expect(out).toContain('"note": "$& $`"')
  })
})

describe('doc_generate: maxRounds chain and params override (end to end)', () => {
  async function makeDeps(configOver: Record<string, unknown> = {}) {
    const ws = await mkdtemp(join(tmpdir(), 'docwright-params-ws-'))
    const root = join(ws, 'packs')
    await mkdir(root, { recursive: true })
    await writeParamPack(root, 'param-pack')
    const packs = await loadPacks(root, {})
    const calls: string[] = []
    const reply = JSON.stringify({ title: 'abcdef' })
    const llm = {
      stream: async function* (options: { messages: Array<{ content: Array<{ text: string }> }> }) {
        calls.push(options.messages[0]!.content.map(c => c.text).join(''))
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    return {
      packs,
      ws,
      calls,
      config: { provider: 'p', model: 'm', workspaceRoot: ws, ...configOver } as never,
      ctx: { llm },
    }
  }

  it('goes green with an override and red without it; receipt records as-run params', async () => {
    const deps = await makeDeps()
    const tool = defineDocGenerateTool(deps)
    const out = await tool.execute({ pack: 'param-pack', materials: ['#!inline\nm'], artifactName: 'green1', params: { limit: 10 }, confirm: true } as never, { signal } as never) as { receipt: { isValid: boolean; params?: Record<string, unknown> } }
    expect(out.receipt.isValid).toBe(true)
    expect(out.receipt.params).toEqual({ limit: 10 })
    // The generator prompt carried the effective params to the model
    expect(deps.calls[0]).toContain('<effective-params>')
    expect(deps.calls[0]).toContain('"limit": 10')
  })

  it('exhausts early under the call maxRounds and keeps a red receipt', async () => {
    const deps = await makeDeps()
    const tool = defineDocGenerateTool(deps)
    await expect(tool.execute({ pack: 'param-pack', materials: ['#!inline\nm'], artifactName: 'red1', maxRounds: 1 } as never, { signal } as never)).rejects.toThrow(/exhausted after 1 iterations/)
    const receipt = JSON.parse(await readFile(join(deps.ws, 'output', 'red1.receipt.json'), 'utf8')) as { iterations: number; terminationReason?: string }
    expect(receipt.iterations).toBe(1)
  })

  it('clamps call maxRounds to the config ceiling', async () => {
    const deps = await makeDeps({ maxRoundsCeiling: 2 })
    const tool = defineDocGenerateTool(deps)
    await expect(tool.execute({ pack: 'param-pack', materials: ['#!inline\nm'], artifactName: 'red2', maxRounds: 8 } as never, { signal } as never)).rejects.toThrow(/exhausted after 2 iterations/)
  })

  it('uses the pack manifest maxRounds when the call passes none', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'docwright-params-packrounds-'))
    const root = join(ws, 'packs')
    await mkdir(root, { recursive: true })
    await writeParamPack(root, 'param-pack', { maxRounds: 1 })
    const packs = await loadPacks(root, {})
    const llm: LlmPort = { async complete() { return JSON.stringify({ title: 'abcdef' }) } }
    await expect(generateDocument({
      pack: packs.get('param-pack')!,
      language: 'zh-CN',
      materials: ['#!inline\nm'],
      materialsRoots: [join(ws, 'references')],
      artifactName: 'packrounds',
      workspaceRoot: ws,
      outputRoot: join(ws, 'output'),
      config: { provider: 'p', model: 'm' } as never,
      llm,
      onRound: () => {},
    } as never)).rejects.toThrow(/exhausted after 1 iterations/)
  })

  it('fails loud on non-object params and invalid maxRounds', async () => {
    const deps = await makeDeps()
    const tool = defineDocGenerateTool(deps)
    // Non-object params now fail at the input schema layer (type: 'object'),
    // before the tool body's normalizeParams defense line is reached.
    await expect(tool.execute({ pack: 'param-pack', materials: ['#!inline\nm'], params: [1] } as never, { signal } as never)).rejects.toThrow(/invalid arguments[\s\S]*params/)
    await expect(tool.execute({ pack: 'param-pack', materials: ['#!inline\nm'], params: '{"budget": 1}' } as never, { signal } as never)).rejects.toThrow(/invalid arguments[\s\S]*params/)
    await expect(tool.execute({ pack: 'param-pack', materials: ['#!inline\nm'], maxRounds: 1.5 } as never, { signal } as never)).rejects.toThrow(/maxRounds must be a positive integer/)
  })
})

describe('doc_validate: replays by receipt-recorded params', () => {
  it('green under receipt params; what-if override can go red', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'docwright-params-val-'))
    const root = join(ws, 'packs')
    await mkdir(root, { recursive: true })
    await writeParamPack(root, 'param-pack')
    const packs = await loadPacks(root, {})
    const llm: LlmPort = { async complete() { return JSON.stringify({ title: 'abcdef' }) } }
    await generateDocument({
      pack: packs.get('param-pack')!,
      language: 'zh-CN',
      materials: ['#!inline\nm'],
      materialsRoots: [join(ws, 'references')],
      artifactName: 'asrun',
      workspaceRoot: ws,
      outputRoot: join(ws, 'output'),
      config: { provider: 'p', model: 'm' } as never,
      llm,
      onRound: () => {},
      params: { limit: 10 },
    } as never)
    const deps = { packs, config: { provider: 'p', model: 'm', workspaceRoot: ws } as never, ctx: { llm } }
    const tool = defineDocValidateTool(deps)
    const replay = await tool.execute({ artifactPath: 'output/asrun.json', pack: 'param-pack' } as never, { signal } as never) as { receipt: { isValid: boolean; params?: Record<string, unknown> } }
    expect(replay.receipt.isValid).toBe(true)
    expect(replay.receipt.params).toEqual({ limit: 10 })
    const whatIf = await tool.execute({ artifactPath: 'output/asrun.json', pack: 'param-pack', params: { limit: 3 } } as never, { signal } as never) as { receipt: { isValid: boolean } }
    expect(whatIf.receipt.isValid).toBe(false)
  })
})

describe('doc_packs: exposes declared params', () => {
  it('lists param name/type/description per pack', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'docwright-params-list-'))
    const root = join(ws, 'packs')
    await mkdir(root, { recursive: true })
    await writeParamPack(root, 'param-pack')
    const packs = await loadPacks(root, {})
    const tool = defineDocPacksTool({ packs, config: { provider: 'p', model: 'm' } as never, ctx: {} })
    const listed = await tool.execute({} as never, { signal } as never) as { packs: Array<{ name: string; params: Array<{ name: string; type: string; description: string }> }> }
    const pack = listed.packs.find(p => p.name === 'param-pack')!
    expect(pack.params).toEqual([{ name: 'limit', type: 'number', description: 'max title length', default: 3, required: false, confirm: false, overridable: false, extractable: false }])
  })
})
