import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defineDocGenerateTool, defineDocValidateTool } from '../src/tools.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { seedContext } from './support.ts'
import { seedContext } from './support.ts'
import { seedContext } from './support.ts'
import { runRepairLoop, INTERNAL_LLM_ERROR } from '../src/loop.ts'
import { assembleGeneratorPrompt, estimateTokens, extractJson } from '../src/prompt.ts'
import { readMaterials } from '../src/materials.ts'
import { assertSafeArtifactName } from '../src/doc-service.ts'
import type { LlmPort } from '../src/llm-port.ts'
import type { Issue } from '../src/issue.ts'
import { rollupRules } from '../src/rule-engine.ts'
import { artifactHashOf } from '../src/receipt.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))
const signal = new AbortController().signal

async function makeDeps(overrides: Record<string, unknown> = {}) {
  const packs = await loadPacks(packsRoot, {})
  const pack = packs.get('cosmic-plan')!
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'docwright-rf-'))
  return {
    packs,
    config: { provider: 'deepseek', model: 'm1', workspaceRoot, maxIterations: 3, promptTokenBudget: 60_000, ...overrides } as never,
    ctx: {
      llm: {
        async *stream() {
          const text = JSON.stringify(pack.goldenSample)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    },
  }
}

describe('review fix: doc_validate tamper evidence (hashMatches)', () => {
  it('reports hashMatches=false for a rule-invisible tamper after green generation', async () => {
    const deps = await makeDeps()
    const root = (deps.config as { workspaceRoot: string }).workspaceRoot
    const gen = defineDocGenerateTool(deps)
    await seedContext(deps)
    await gen.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], upstream: ['context/context.json'], language: 'zh-CN', params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true, artifactName: 'h1' } as never, { signal } as never)
    const { readFile, writeFile } = await import('node:fs/promises')
    const path = join(root, 'topic-a', 'output', 'h1.json')
    const artifact = JSON.parse(await readFile(path, 'utf8'))
    artifact.injectedField = 'tampered' // schema allows additionalProperties; rules stay green
    await writeFile(path, JSON.stringify(artifact), 'utf8')
    const tool = defineDocValidateTool(deps)
    const out = await tool.execute({ artifactPath: 'topic-a/output/h1.json', pack: 'cosmic-plan', upstream: ['context/context.json'] } as never, { signal } as never) as { receipt: { isValid: boolean }; hashMatches: boolean | null }
    expect(out.receipt.isValid).toBe(true)
    expect(out.hashMatches).toBe(false)
  })

  it('reports hashMatches=null when no sidecar receipt exists (sample copied into the workspace)', async () => {
    const deps = await makeDeps()
    const root = (deps.config as { workspaceRoot: string }).workspaceRoot
    const { copyFile } = await import('node:fs/promises')
    await copyFile(join(packsRoot, 'cosmic-plan', 'samples', 'golden.json'), join(root, 'sample.json'))
    const out = await defineDocValidateTool(deps).execute({ artifactPath: 'sample.json', pack: 'cosmic-plan', params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, } as never, { signal } as never) as { hashMatches: boolean | null }
    expect(out.hashMatches).toBeNull()
  })

  it('hashMatches=true for an untouched generated artifact; language derives from the receipt', async () => {
    const deps = await makeDeps()
    const root = (deps.config as { workspaceRoot: string }).workspaceRoot
    await seedContext(deps)
    await defineDocGenerateTool(deps).execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], upstream: ['context/context.json'], language: 'en-US', params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true, artifactName: 'h2' } as never, { signal } as never)
    const out = await defineDocValidateTool(deps).execute({ artifactPath: 'topic-a/output/h2.json', pack: 'cosmic-plan', upstream: ['context/context.json'] } as never, { signal } as never) as { receipt: { language: string }; hashMatches: boolean | null }
    expect(out.hashMatches).toBe(true)
    expect(out.receipt.language).toBe('en-US')
  })

  it('rejects a language param that contradicts the receipt-recorded language', async () => {
    const deps = await makeDeps()
    const root = (deps.config as { workspaceRoot: string }).workspaceRoot
    await seedContext(deps)
    await defineDocGenerateTool(deps).execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], upstream: ['context/context.json'], language: 'zh-CN', params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true, artifactName: 'h3' } as never, { signal } as never)
    await expect(defineDocValidateTool(deps).execute({ artifactPath: 'topic-a/output/h3.json', pack: 'cosmic-plan', language: 'en-US' } as never, { signal } as never)).rejects.toThrow(/does not match the receipt-recorded/)
  })

  it('rejects artifactPath traversal outside the workspace root', async () => {
    const deps = await makeDeps()
    await expect(defineDocValidateTool(deps).execute({ artifactPath: '../../etc/passwd', pack: 'cosmic-plan' } as never, { signal } as never)).rejects.toThrow(/escapes the workspace root/)
  })
})

describe('review fix: artifactName sanitize', () => {
  it('rejects path-shaped and traversal artifact names', () => {
    for (const bad of ['../evil', 'a/b', '/abs', '.hidden', 'a..b/../c', '']) {
      expect(() => assertSafeArtifactName(bad), bad).toThrow(/plain filesystem basename/)
    }
    expect(() => assertSafeArtifactName('cosmic-plan-1699')).not.toThrow()
    expect(() => assertSafeArtifactName('a.b_c-d')).not.toThrow()
  })

  it('accepts the unicode names the engine derives from topics (same safety class)', () => {
    expect(() => assertSafeArtifactName('resume-李明')).not.toThrow()
    expect(() => assertSafeArtifactName('resume-李明 02')).not.toThrow()
    expect(() => assertSafeArtifactName('李明的简历')).not.toThrow()
    expect(() => assertSafeArtifactName('.李明')).toThrow(/leading dot/)
    expect(() => assertSafeArtifactName('李明/简历')).toThrow(/plain filesystem basename/)
  })
})

describe('review fix: AbortError propagation', () => {
  it('rethrows AbortError from the model call instead of mapping it to exhausted', async () => {
    const ac = new AbortController()
    let call = 0
    const llm: LlmPort = {
      async complete() {
        if (++call === 1) return '{"bad":1}'
        ac.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    }
    const validate = (): readonly Issue[] => [{ ruleId: 'r', severity: 'error', jsonPath: '$', message: 'm', suggestion: 's' }]
    const err = await runRepairLoop({ llm, promptTemplate: 'T', materials: ['m'], maxIterations: 3, promptTokenBudget: 60_000, model: 't', signal: ac.signal, validate }, () => {})
      .then(() => undefined, e => e as Error)
    expect(err?.name).toBe('AbortError')
  })

  it('keeps the previous draft when the model call fails during a repair round', async () => {
    let call = 0
    const partial = { functions: [{ funcId: 'F001', funcDesc: 'short' }] }
    const llm: LlmPort = { async complete() { if (++call === 1) return JSON.stringify(partial); throw new Error('HTTP 500 mid-repair') } }
    const validateGood = (d: unknown): readonly Issue[] =>
      (d as { functions: Array<{ funcDesc?: string }> }).functions?.[0]?.funcDesc === 'ok'
        ? []
        : [{ ruleId: 'r', severity: 'error', jsonPath: '$.functions[0].funcDesc', message: 'bad', suggestion: 'fix' }]
    const result = await runRepairLoop({ llm, promptTemplate: 'T', materials: ['m'], maxIterations: 3, promptTokenBudget: 60_000, model: 't', validate: validateGood }, () => {})
    expect(result.status).toBe('exhausted')
    if (result.status === 'exhausted') {
      expect(result.unresolved[0]!.ruleId).toBe(INTERNAL_LLM_ERROR)
      expect(result.draftArtifact).toEqual(partial)
    }
  })

  it('emits ordered round events with fingerprintsMatchedPrevious on repeated identical failures', async () => {
    const seen: number[] = []
    const bad = { functions: [{ funcId: 'F001', funcDesc: 'short' }] }
    const llm: LlmPort = { async complete() { return JSON.stringify(bad) } }
    const validateGood = (d: unknown): readonly Issue[] => [{ ruleId: 'r', severity: 'error', jsonPath: '$', message: (d as object).toString(), suggestion: 's' }]
    const result = await runRepairLoop({ llm, promptTemplate: 'T', materials: ['m'], maxIterations: 3, promptTokenBudget: 60_000, model: 't', validate: validateGood }, ev => { seen.push(ev.round) })
    expect(seen).toEqual([1, 2, 3])
    if (result.status === 'exhausted') {
      expect(result.events.map(e => e.fingerprintsMatchedPrevious)).toEqual([false, true, true])
      expect(result.reason).toBe('fingerprint-repeat')
    }
  })
})

describe('review fix: prompt assembly', () => {
  it('does not mangle materials containing String.replace replacement patterns', () => {
    const evil = 'cost $& markup $` tail $\' end'
    const out = assembleGeneratorPrompt({ promptTemplate: 'TPL {{materials}} {{upstream}}', materials: [evil], upstream: [evil] })
    expect(out).toContain(evil)
  })

  it('estimateTokens counts CJK chars as ~1 token each', () => {
    expect(estimateTokens('一二三四')).toBeGreaterThanOrEqual(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('extractJson is O(n)-shaped on adversarial brace runs and reports unbalanced input', () => {
    expect(extractJson(`{"a":"${'}'.repeat(5000)}"}`)).toEqual({ a: '}'.repeat(5000) })
    expect(() => extractJson('{')).toThrow(/unbalanced|malformed/)
    expect(() => extractJson('{"a": }')).toThrow()
  })
})

describe('review fix: material containment hardening', () => {
  it('accepts an absolute path inside the workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-abs-'))
    await writeFile(join(root, 'in.txt'), 'inside', 'utf8')
    expect(await readMaterials([join(root, 'in.txt')], root, [root])).toEqual(['inside'])
  })

  it('rejects an absolute path outside the workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-abs-'))
    const outside = await mkdtemp(join(tmpdir(), 'docwright-out-'))
    await writeFile(join(outside, 'secret.txt'), 's', 'utf8')
    await expect(readMaterials([join(outside, 'secret.txt')], root, [root])).rejects.toThrow(/escapes the workspace root/)
  })

  it('rejects a symlink inside the workspace that points outside it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-sym-'))
    const outside = await mkdtemp(join(tmpdir(), 'docwright-out-'))
    await writeFile(join(outside, 'secret.txt'), 's', 'utf8')
    await symlink(join(outside, 'secret.txt'), join(root, 'leak.txt'))
    await expect(readMaterials(['leak.txt'], root, [root])).rejects.toThrow(/symlink/)
  })
})

describe('review fix: pack rule parity and rollup truthfulness', () => {
  it('zh-CN and en-US forbid the same keyword set per field', async () => {
    const packs = await loadPacks(packsRoot, {})
    const pack = packs.get('cosmic-plan')!
    const kw = (lang: string) => {
      const out: Record<string, string[]> = {}
      for (const r of pack.rules.get(lang) ?? []) {
        if (r.kind === 'forbiddenKeywords') out[r.field] = [...r.keywords].sort()
      }
      return out
    }
    expect(kw('zh-CN')).toEqual(kw('en-US'))
  })

  it('rollup reports schema failures under schema/* and keeps internal/* visible', async () => {
    const packs = await loadPacks(packsRoot, {})
    const pack = packs.get('cosmic-plan')!
    const issues: Issue[] = [
      { ruleId: 'schema/required', severity: 'error', jsonPath: '#', message: 'm', suggestion: 's' },
      { ruleId: 'internal/llm-error', severity: 'error', jsonPath: '$', message: 'm', suggestion: 's' },
    ]
    const rollup = rollupRules(pack, 'zh-CN', issues)
    expect(rollup.find(r => r.ruleId === 'schema/*')).toMatchObject({ status: 'fail', count: 1 })
    expect(rollup.find(r => r.ruleId === 'internal/llm-error')).toMatchObject({ status: 'fail', count: 1 })
    expect(rollup.find(r => r.ruleId === 'plan/func-id-unique')).toMatchObject({ status: 'pass', count: 0 })
  })

  it('rejects a declarative rule with a non-enum severity at load time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-sev2-'))
    const dir = join(root, 'p-sev')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'p-sev', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify([{ id: 'r', severity: 'fatal', given: '$', field: 'x', kind: 'minLength', min: 1, suggestion: 's' }]), 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/severity must be one of error\|warning\|info/)
  })
})

describe('review fix: empty-string config fallback', () => {
  it('an empty-string defaultLanguage falls back to the pack first language', async () => {
    const deps = await makeDeps({ defaultLanguage: '' })
    const root = (deps.config as { workspaceRoot: string }).workspaceRoot
    const { copyFile } = await import('node:fs/promises')
    await copyFile(join(packsRoot, 'cosmic-plan', 'samples', 'golden.json'), join(root, 'sample.json'))
    const out = await defineDocValidateTool(deps).execute({ artifactPath: 'sample.json', pack: 'cosmic-plan', params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, } as never, { signal } as never) as { receipt: { language: string } }
    expect(out.receipt.language).toBe('zh-CN')
  })
})

describe('review fix: remaining load-time branches', () => {
  it('rejects a non-string material reference', async () => {
    await expect(readMaterials([42 as never], '/tmp', ['/tmp'])).rejects.toThrow(/must be a string/)
  })

  it('rejects a rule whose pattern does not compile at load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-pat-'))
    const dir = join(root, 'p-pat')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'p-pat', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify([{ id: 'r', severity: 'error', given: '$', field: 'x', kind: 'pattern', pattern: '([unclosed', mustMatch: true, suggestion: 's' }]), 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/pattern does not compile/)
  })

  it('rejects a functions.js that fails to import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-brokenfn-'))
    const dir = join(root, 'p-broken')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'p-broken', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'rules', 'functions.js'), 'this is not valid javascript !!!', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/failed to import/)
  })

  it('rejects a prompt missing the {{materials}} slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-slot-'))
    const dir = join(root, 'p-slot')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'p-slot', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'no slot here', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/{{materials}}/)
  })
})

describe('review fix: minLength/maxLength/forbiddenKeywords payload validation', () => {
  it.each([
    ['minLength', { id: 'r', severity: 'error', given: '$', field: 'x', kind: 'minLength', suggestion: 's' }, /finite numeric min/],
    ['maxLength', { id: 'r', severity: 'error', given: '$', field: 'x', kind: 'maxLength', suggestion: 's' }, /finite numeric max/],
    ['forbiddenKeywords', { id: 'r', severity: 'error', given: '$', field: 'x', kind: 'forbiddenKeywords', suggestion: 's' }, /non-empty array/],
  ])('rejects a %s rule with a missing payload', async (_kind, rule, pattern) => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-payload-'))
    const dir = join(root, 'p-payload')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'p-payload', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify([rule]), 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(pattern)
  })
})

describe('review fix: green-receipt upstream verification + receipt anchoring', () => {
  async function makeChainDeps() {
    const packs = await loadPacks(packsRoot, {})
    const pack = packs.get('cosmic-plan')!
    const root = await mkdtemp(join(tmpdir(), 'docwright-chain3-'))
    // Build a consuming pack
    const dir = join(root, 'packs', 'chain3')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'chain3', version: '1', description: 'd', consumes: ['cosmic-plan'], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}} {{upstream}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 'ok {{json}}', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    const all = await loadPacks(packsRoot, { extra: [join(root, 'packs')] })
    const golden = all.get('cosmic-plan')!.goldenSample
    const deps = {
      packs: all,
      config: { provider: 'p', model: 'm', workspaceRoot: root, maxIterations: 1, promptTokenBudget: 60_000 } as never,
      ctx: {
        llm: {
          async *stream() {
            const text = JSON.stringify(golden)
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'block-end', index: 0, block: { type: 'text', text } }
            yield { type: 'finish', reason: 'stop' }
          },
        },
      },
    }
    return { deps, root, pack }
  }

  it('accepts a green upstream and anchors its hash in the receipt', async () => {
    const { deps, root } = await makeChainDeps()
    // Green upstream: generate via cosmic-plan
    const gen = defineDocGenerateTool(deps)
    await seedContext(deps)
    await gen.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], upstream: ['context/context.json'], language: 'zh-CN', params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true, artifactName: 'up1' } as never, { signal } as never)
    const out = await gen.execute({ pack: 'chain3', materials: ['#!inline\nx'], upstream: ['topic-a/output/up1.json'], artifactName: 'down1' } as never, { signal } as never) as { receipt: { upstreamHashes: Array<{ pack: string }> } }
    expect(out.receipt.upstreamHashes).toHaveLength(1)
    expect(out.receipt.upstreamHashes[0]!.pack).toBe('cosmic-plan')
    void root
  })

  it('rejects a tampered (hash-mismatch) upstream', async () => {
    const { deps, root } = await makeChainDeps()
    const gen = defineDocGenerateTool(deps)
    await seedContext(deps)
    await gen.execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], upstream: ['context/context.json'], language: 'zh-CN', params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true, artifactName: 'up2' } as never, { signal } as never)
    const { readFile, writeFile } = await import('node:fs/promises')
    const p2 = join(root, 'topic-a', 'output', 'up2.json')
    const art = JSON.parse(await readFile(p2, 'utf8'))
    art.functions[0].funcDesc += ' tampered'
    await writeFile(p2, JSON.stringify(art), 'utf8')
    await expect(gen.execute({ pack: 'chain3', materials: ['#!inline\nx'], upstream: ['topic-a/output/up2.json'], artifactName: 'down2' } as never, { signal } as never)).rejects.toThrow(/modified after generation/)
  })

  it('rejects an upstream whose artifact is not valid JSON', async () => {
    const { deps, root } = await makeChainDeps()
    const gen = defineDocGenerateTool(deps)
    await writeFile(join(root, 'bad.json'), 'not json', 'utf8')
    await writeFile(join(root, 'bad.receipt.json'), JSON.stringify({ pack: 'cosmic-plan', packVersion: '0.1.0', artifactHash: 'x', isValid: true }), 'utf8')
    await expect(gen.execute({ pack: 'chain3', materials: ['#!inline\nx'], upstream: ['bad.json'], artifactName: 'd5' } as never, { signal } as never)).rejects.toThrow(/not valid JSON/)
    void root
  })

  it('rejects a red-receipt upstream and a wrong-type upstream', async () => {
    const { deps, root } = await makeChainDeps()
    const gen = defineDocGenerateTool(deps)
    // Hand-craft a red sidecar next to a bare artifact
    await writeFile(join(root, 'red.json'), JSON.stringify({ functions: [] }), 'utf8')
    await writeFile(join(root, 'red.receipt.json'), JSON.stringify({ pack: 'cosmic-plan', packVersion: '0.1.0', artifactHash: 'x', isValid: false }), 'utf8')
    await expect(gen.execute({ pack: 'chain3', materials: ['#!inline\nx'], upstream: ['red.json'], artifactName: 'd3' } as never, { signal } as never)).rejects.toThrow(/RED receipt/)
    // Green but wrong pack type
    const wrongArtifact = { ok: true }
    await writeFile(join(root, 'wrong.json'), JSON.stringify(wrongArtifact), 'utf8')
    await writeFile(join(root, 'wrong.receipt.json'), JSON.stringify({ pack: 'some-other-pack', packVersion: '1', artifactHash: artifactHashOf(wrongArtifact), isValid: true }), 'utf8')
    await expect(gen.execute({ pack: 'chain3', materials: ['#!inline\nx'], upstream: ['wrong.json'], artifactName: 'd4' } as never, { signal } as never)).rejects.toThrow(/consumes/)
    void root
  })
})
