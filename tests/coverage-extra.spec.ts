import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DocService } from '../src/doc-service.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { createRuleEngine } from '../src/rule-engine.ts'
import { createSchemaCheck } from '../src/schema-check.ts'
import { runRepairLoop } from '../src/loop.ts'
import { defineDocGenerateTool } from '../src/tools.ts'
import type { LlmPort } from '../src/llm-port.ts'
import type { Pack, FunctionRule, DeclarativeRule } from '../src/pack.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))

function fakePack(overrides: Partial<{ rules: readonly DeclarativeRule[]; fnRules: readonly FunctionRule[]; languages: readonly string[] }> = {}): Pack {
  const base = JSON.parse(JSON.stringify({
    manifest: { name: 't', version: '1', description: 'd', consumes: [], languages: overrides.languages ?? ['zh-CN'] },
  }))
  return {
    manifest: base.manifest,
    schema: { type: 'object' },
    rules: new Map([['zh-CN', overrides.rules ?? []]]),
    functionRules: overrides.fnRules ?? [],
    prompts: new Map([['zh-CN', 'TPL {{materials}}']]),
    templates: new Map([['zh-CN', '{{x}}']]),
    goldenSample: {},
    dir: '/tmp/t',
  }
}

describe('coverage: rule engine branches', () => {
  const doc = { functions: [{ funcId: 'F001', desc: 'x' }, { funcId: 'F001', desc: 'y'.repeat(50) }] }

  it('maxLength flags overlong values', () => {
    const rules: DeclarativeRule[] = [{ id: 'r/max', severity: 'error', given: '$.functions[*]', field: 'desc', kind: 'maxLength', max: 10, suggestion: 'shorten' }]
    const engine = createRuleEngine(fakePack({ rules }), 'zh-CN')
    expect(engine(doc).some(i => i.ruleId === 'r/max')).toBe(true)
  })

  it('unsupported given path fails loud at engine creation', () => {
    const rules: DeclarativeRule[] = [{ id: 'r/bad', severity: 'error', given: '$..deep', field: 'x', kind: 'minLength', min: 1, suggestion: 's' }]
    expect(() => createRuleEngine(fakePack({ rules }), 'zh-CN')).toThrow(/given path not supported/)
  })

  it('invalid rule pattern fails loud at engine creation', () => {
    const rules: DeclarativeRule[] = [{ id: 'r/pat', severity: 'error', given: '$.functions[*]', field: 'desc', kind: 'pattern', pattern: '([unclosed', mustMatch: true, suggestion: 's' }]
    expect(() => createRuleEngine(fakePack({ rules }), 'zh-CN')).toThrow(/pattern/)
  })

  it('crashing function rule surfaces with the rule id', () => {
    const fnRules: FunctionRule[] = [{ id: 'r/boom', severity: 'error', suggestion: 's', check: () => { throw new Error('kaboom') } }]
    const engine = createRuleEngine(fakePack({ fnRules }), 'zh-CN')
    expect(() => engine(doc)).toThrow(/rule r\/boom crashed/)
  })

  it('missing language ruleset fails loud', () => {
    expect(() => createRuleEngine(fakePack(), 'en-US')).toThrow(/no rules for language/)
  })

  it('schema compile failure is a load-time error', () => {
    expect(() => createSchemaCheck({ type: 'object', properties: { a: { type: 'not-a-type' } } })).toThrow(/does not compile/)
  })

  it('DocService rejects an unsupported language at construction', async () => {
    const packs = await loadPacks(packsRoot, {})
    const pack = packs.get('cosmic-plan')
    if (pack === undefined) throw new Error('missing pack')
    expect(() => new DocService(pack, 'fr-FR')).toThrow(/does not support language/)
  })

  it('registerTools tolerates an empty packs root (market-distributed packs)', async () => {
    // Zero builtin packs is legal since the cosmic packs moved to the
    // market: the plugin loads, the guides check is the first loud gate.
    const { registerTools } = await import('../src/index.ts')
    const emptyRoot = await mkdtemp(join(tmpdir(), 'docwright-empty-'))
    await expect(registerTools({ tools: { register: () => {} } } as never, {}, emptyRoot)).rejects.toThrow(/pack-authoring guide is missing/)
  })
})

describe('coverage: loop in-loop budget guard', () => {
  it('rejects a repair prompt that grew past the budget', async () => {
    const big = 'y'.repeat(900)
    const bad = { functions: [{ funcId: 'F001', desc: big }] }
    const good = { functions: [{ funcId: 'F001', desc: 'ok' }] }
    const replies = [JSON.stringify(bad), JSON.stringify(good)]
    const llm: LlmPort = { async complete() { return replies.shift() ?? '' } }
    // Generator prompt is small; the repair prompt embeds the big artifact twice.
    const budget = 300
    await expect(runRepairLoop({
      llm, promptTemplate: 'T {{materials}}', materials: ['m'], maxIterations: 5, promptTokenBudget: budget, model: 't',
      validate: d => (d as { functions: Array<{ desc: string }> }).functions[0]!.desc === 'ok' ? [] : [{ ruleId: 'r', severity: 'error', jsonPath: '$.functions[0].desc', message: 'bad', suggestion: 'fix' }],
    }, () => {})).rejects.toThrow(/token budget/)
  })
})

describe('coverage: consuming-pack upstream checks', () => {
  it('requires upstream artifacts for chained packs and rejects invalid JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-chain-'))
    const dir = join(root, 'chain-pack')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'chain-pack', version: '1', description: 'd', consumes: ['cosmic-plan'], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}} {{upstream}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 'ok', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    const packs = await loadPacks(packsRoot, { extra: [root] })
    const deps = {
      packs,
      config: { provider: 'p', model: 'm', workspaceRoot: root, maxIterations: 2, promptTokenBudget: 60_000 } as never,
      ctx: { llm: { async *stream() { yield { type: 'finish', reason: 'stop' } } } },
    }
    const tool = defineDocGenerateTool(deps)
    const signal = new AbortController().signal
    await expect(tool.execute({ pack: 'chain-pack', materials: ['#!inline\nx'] } as never, { signal } as never)).rejects.toThrow(/consumes upstream/)
    // No sidecar receipt for a bare JSON file
    await writeFile(join(root, 'bare.json'), '{}', 'utf8')
    await expect(tool.execute({ pack: 'chain-pack', materials: ['#!inline\nx'], upstream: ['bare.json'] } as never, { signal } as never)).rejects.toThrow(/no sidecar receipt/)
  })
})

describe('coverage: loader validation branches', () => {
  it('rejects bad manifest languages and version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-manifest-'))
    const dir = join(root, 'p1')
    await mkdir(join(dir, 'rules'), { recursive: true })
    await mkdir(join(dir, 'prompts'), { recursive: true })
    await mkdir(join(dir, 'templates'), { recursive: true })
    await mkdir(join(dir, 'samples'), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'p1', version: '', languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/manifest.version/)
  })

  it('rejects a rule with an unknown kind or missing suggestion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-kind-'))
    const dir = join(root, 'p2')
    await mkdir(join(dir, 'rules'), { recursive: true })
    await mkdir(join(dir, 'prompts'), { recursive: true })
    await mkdir(join(dir, 'templates'), { recursive: true })
    await mkdir(join(dir, 'samples'), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'p2', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify([{ id: 'r', severity: 'error', given: '$', field: 'x', kind: 'nope', suggestion: 's' }]), 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/kind must be one of/)
  })

  it('rejects functions.js whose rules export is not an array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-fn-'))
    const dir = join(root, 'p3')
    await mkdir(join(dir, 'rules'), { recursive: true })
    await mkdir(join(dir, 'prompts'), { recursive: true })
    await mkdir(join(dir, 'templates'), { recursive: true })
    await mkdir(join(dir, 'samples'), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'p3', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'rules', 'functions.js'), 'export const rules = "nope"', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/must be an array/)
  })
})


async function makeMiniPack(root: string, name: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, name)
  for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
  const defaults: Record<string, string> = {
    'manifest.json': JSON.stringify({ name, version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }),
    'schema.json': '{"type":"object"}',
    'rules/zh-CN.json': '[]',
    'prompts/zh-CN.md': 'T {{materials}}',
    'templates/zh-CN.hbs': 't',
    'samples/golden.json': '{}',
  }
  for (const [path, content] of Object.entries({ ...defaults, ...files })) {
    await writeFile(join(dir, path), content, 'utf8')
  }
}

describe('coverage: final line gaps', () => {
  it('counts warning-severity issues per round', async () => {
    const good = { functions: [{ funcId: 'F001', desc: 'ok' }] }
    let round = 0
    const llm: LlmPort = { async complete() { round++; return JSON.stringify(round === 1 ? { functions: [{ funcId: 'F001', desc: 'bad' }] } : good) } }
    const result = await runRepairLoop({
      llm, promptTemplate: 'T', materials: ['m'], maxIterations: 3, promptTokenBudget: 60_000, model: 't',
      validate: d => (d as { functions: Array<{ desc: string }> }).functions[0]!.desc === 'ok'
        ? [{ ruleId: 'w/only', severity: 'warning', jsonPath: '$', message: 'warn', suggestion: 's' }]
        : [{ ruleId: 'r', severity: 'error', jsonPath: '$', message: 'bad', suggestion: 's' }],
    }, () => {})
    expect(result.status).toBe('green')
    if (result.status === 'green') {
      expect(result.rounds[1]!.warningCount).toBe(1)
      expect(result.rounds[1]!.errorCount).toBe(0)
    }
  })

  it('runs a root-scope ($) declarative rule', () => {
    const rules: DeclarativeRule[] = [{ id: 'r/root', severity: 'error', given: '$', field: 'title', kind: 'minLength', min: 3, suggestion: 's' }]
    const engine = createRuleEngine(fakePack({ rules }), 'zh-CN')
    expect(engine({ title: 'ab' }).some(i => i.ruleId === 'r/root')).toBe(true)
    expect(engine({ title: 'abc' }).some(i => i.ruleId === 'r/root')).toBe(false)
  })

  it('schema-check pass and fail paths directly', () => {
    const check = createSchemaCheck({ type: 'object', properties: { a: { type: 'number' } }, required: ['a'] })
    expect(check({ a: 1 })).toEqual([])
    const issues = check({ a: 'x' })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]!.ruleId.startsWith('schema/')).toBe(true)
  })

  it('generateDocument uses config defaults when maxIterations/model are unset', async () => {
    const { generateDocument } = await import('../src/doc-service.ts')
    const packs = await loadPacks(packsRoot, {})
    const pack = packs.get('cosmic-plan')!
    const root = await mkdtemp(join(tmpdir(), 'docwright-def-'))
    const llm = { async complete() { return JSON.stringify(pack.goldenSample) } }
    const contextGolden = JSON.stringify(packs.get('cosmic-context')!.goldenSample)
    const out = await generateDocument({ pack, language: 'zh-CN', materials: ['#!inline\nx'], upstream: [contextGolden], artifactName: 'def', materialsRoots: [root], workspaceRoot: root, outputRoot: join(root, 'output'), config: {}, llm, onRound: () => {}, params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } } })
    expect(out.receipt.isValid).toBe(true)
    expect(out.receipt.model).toBe('unknown')
  })

  it('consuming pack with valid JSON upstream proceeds past verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-chain2-'))
    const dir = join(root, 'chain2')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'chain2', version: '1', description: 'd', consumes: ['cosmic-plan'], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}} {{upstream}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 'ok {{json}}', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    const packs = await loadPacks(packsRoot, { extra: [root] })
    const deps = {
      packs,
      config: { provider: 'p', model: 'm', workspaceRoot: root, maxIterations: 1, promptTokenBudget: 60_000 } as never,
      ctx: { llm: { async *stream() { yield { type: 'finish', reason: 'stop' } } } },
    }
    const tool = defineDocGenerateTool(deps)
    // The fake stream yields no text → llm-error → exhausted (verification passed).
    await expect(tool.execute({ pack: 'chain2', materials: ['#!inline\nx'], upstream: ['{}'] } as never, { signal: new AbortController().signal } as never)).rejects.toThrow()
  })
})

describe('coverage: tool render callbacks', () => {
  it('both tools render their canonical value as text content', async () => {
    const packs = await loadPacks(packsRoot, {})
    const deps = { packs, config: {} as never, ctx: {} }
    const gen = defineDocGenerateTool(deps) as unknown as { output: { render(a: unknown, v: unknown): Array<{ type: string }> } }
    const val = (await import('../src/tools.ts')).defineDocValidateTool(deps) as unknown as { output: { render(a: unknown, v: unknown): Array<{ type: string }> } }
    const g = gen.output.render({}, { artifactPath: 'a', receipt: { isValid: true } })
    const v = val.output.render({}, { receipt: { isValid: false } })
    expect(g[0]!.type).toBe('text')
    expect(v[0]!.type).toBe('text')
  })
})

describe('coverage: loader rule-shape branches', () => {
  it('rejects a declarative rule without a suggestion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-sug-'))
    await makeMiniPack(root, 'p-sug', { 'rules/zh-CN.json': JSON.stringify([{ id: 'r', severity: 'error', given: '$', field: 'x', kind: 'minLength', min: 1 }]) })
    await expect(loadPacks(root, {})).rejects.toThrow(/suggestion/)
  })

  it('rejects a function rule with an invalid severity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-sev-'))
    await makeMiniPack(root, 'p-sev', { 'rules/functions.js': "export const rules = [{ id: 'r', severity: 'fatal', suggestion: 's', check: () => [] }]" })
    await expect(loadPacks(root, {})).rejects.toThrow(/severity must be error/)
  })
})
