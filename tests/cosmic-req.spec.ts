import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DocService, parseUpstreamArtifacts } from '../src/doc-service.ts'
import type { Issue } from '../src/issue.ts'
import type { Pack, RuleContext } from '../src/pack.ts'
import { resolveEffectiveParams } from '../src/params.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { seedContext } from './support.ts'
import { defineDocGenerateTool, defineDocValidateTool } from '../src/tools.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))
const signal = new AbortController().signal

let cache: { req: Pack; plan: Pack } | undefined
async function packs(): Promise<{ req: Pack; plan: Pack }> {
  if (cache === undefined) {
    const all = await loadPacks(packsRoot, {})
    cache = { req: all.get('cosmic-req')!, plan: all.get('cosmic-plan')! }
  }
  return cache
}

/** The upstream plan fixture: cosmic-plan's golden, which the req golden references (index 1 / USR-FAV / 35 CFP). */
function planContext(plan: Pack): RuleContext {
  return { upstream: [plan.goldenSample] }
}

/** Validate with the effective defaults (param rules fail loud without them). */
function validateOf(pack: Pack, lang: string, artifact: unknown, params?: Readonly<Record<string, unknown>>, context?: RuleContext): readonly Issue[] {
  return new DocService(pack, lang).validate(artifact, { targetIndex: 1, ...resolveEffectiveParams(pack, { ...params, targetIndex: params?.targetIndex ?? 1 }) }, context)
}

function issueRuleIds(issues: readonly Issue[]): Set<string> {
  return new Set(issues.map(i => i.ruleId))
}

/** Deep clone helper for mutations. */
function mutate(artifact: unknown, change: (draft: Record<string, unknown>) => void): Record<string, unknown> {
  const draft = structuredClone(artifact) as Record<string, unknown>
  change(draft)
  return draft
}

/** Scripted LLM port that replies with the given texts in order (stays on the last one). */
function scriptedLlm(replies: string[]) {
  let n = 0
  return {
    stream: async function* () {
      const reply = replies[Math.min(n, replies.length - 1)]
      n++
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

async function makeDeps(llm: unknown) {
  const all = await loadPacks(packsRoot, {})
  return {
    packs: all,
    config: {
      provider: 'p',
      model: 'test-model',
      workspaceRoot: await mkdtemp(join(tmpdir(), 'docwright-req-chain-')),
      maxIterations: 3,
      promptTokenBudget: 60_000,
    } as never,
    ctx: { llm },
  }
}

describe('parseUpstreamArtifacts (rule context upstream)', () => {
  it('parses JSON texts, skips unparseable ones, and returns undefined for no input', () => {
    expect(parseUpstreamArtifacts(['{"docType":"plan"}', 'free-form text not json {'])).toEqual([{ docType: 'plan' }])
    expect(parseUpstreamArtifacts(['also not json'])).toEqual([])
    expect(parseUpstreamArtifacts(undefined)).toBeUndefined()
  })
})

describe('cosmic-req pack shape', () => {  it('declares the chain and the three pack params', async () => {
    const { req } = await packs()
    expect(req.manifest.consumes).toEqual(['cosmic-plan'])
    expect(req.manifest.languages).toEqual(['zh-CN', 'en-US'])
    expect(Object.keys(req.manifest.params ?? {}).sort()).toEqual(['cfpMax', 'cfpMin', 'cfpPerFunc', 'cfpPerSubProc', 'cfpTotal', 'cfpsPerRule', 'funcDescMaxLength', 'functionalUserRoles', 'targetIndex', 'topicNo', 'topicNoPattern'])
    expect(req.functionRules.map(r => r.id)).toEqual(['req/functional-user-roles', 'req/business-rule-count', 'req/plan-alignment'])
  })

  it('prompts carry the materials, upstream, and params slots in both languages', async () => {
    const { req } = await packs()
    for (const lang of req.manifest.languages) {
      const prompt = req.prompts.get(lang) ?? ''
      expect(prompt).toContain('{{materials}}')
      expect(prompt).toContain('{{upstream}}')
      expect(prompt).toContain('{{params}}')
    }
  })
})

describe('cosmic-req golden sample', () => {
  it('passes all-green in both languages against the upstream plan fixture', async () => {
    const { req, plan } = await packs()
    for (const lang of req.manifest.languages) {
      const issues = validateOf(req, lang, req.goldenSample, undefined, planContext(plan))
      const errors = issues.filter(i => i.severity === 'error')
      expect(errors, `${lang}: ${JSON.stringify(errors)}`).toEqual([])
    }
  })
})

describe('cosmic-req mutation tests (guardrail-is-real)', () => {
  it('schema violation: missing functionalUsers is caught', async () => {
    const { req, plan } = await packs()
    const draft = mutate(req.goldenSample, d => { delete d.functionalUsers })
    const ids = [...issueRuleIds(validateOf(req, 'zh-CN', draft, undefined, planContext(plan)))]
    expect(ids.some(id => id.startsWith('schema/'))).toBe(true)
  })

  it('func-desc-min-length: a too-short description is caught', async () => {
    const { req, plan } = await packs()
    const draft = mutate(req.goldenSample, d => { d.funcDesc = '太短' })
    expect(issueRuleIds(validateOf(req, 'zh-CN', draft, undefined, planContext(plan)))).toContain('req/func-desc-min-length')
  })

  it('func-desc-max-length: the bound follows the funcDescMaxLength param', async () => {
    const { req, plan } = await packs()
    const draft = mutate(req.goldenSample, d => { d.funcDesc = '长'.repeat(600) })
    const overDefault = validateOf(req, 'zh-CN', draft, undefined, planContext(plan))
    expect(issueRuleIds(overDefault)).toContain('req/func-desc-max-length')
    // Same artifact passes with a raised param bound — the param is live.
    const raised = validateOf(req, 'zh-CN', draft, { funcDescMaxLength: 1000 }, planContext(plan))
    expect(issueRuleIds(raised)).not.toContain('req/func-desc-max-length')
  })

  it('func-id-format: a malformed funcId is caught', async () => {
    const { req, plan } = await packs()
    const draft = mutate(req.goldenSample, d => { d.funcId = 'bad id!' })
    expect(issueRuleIds(validateOf(req, 'zh-CN', draft, undefined, planContext(plan)))).toContain('req/func-id-format')
  })

  it('functional-user-role-format: a malformed role is caught', async () => {
    const { req, plan } = await packs()
    const draft = mutate(req.goldenSample, d => { (d.functionalUsers as Array<{ role: string }>)[0]!.role = 'Customer' })
    expect(issueRuleIds(validateOf(req, 'zh-CN', draft, undefined, planContext(plan)))).toContain('req/functional-user-role-format')
  })

  it('functional-user-roles: a role outside the deployment allowlist is caught, param overrides live', async () => {
    const { req, plan } = await packs()
    const draft = mutate(req.goldenSample, d => { (d.functionalUsers as Array<{ role: string }>)[0]!.role = 'wizard' })
    expect(issueRuleIds(validateOf(req, 'zh-CN', draft, undefined, planContext(plan)))).toContain('req/functional-user-roles')
    // Widening the allowlist via params lets the same artifact pass.
    const widened = validateOf(req, 'zh-CN', draft, { functionalUserRoles: 'wizard,operator' }, planContext(plan))
    expect(issueRuleIds(widened)).not.toContain('req/functional-user-roles')
  })

  it('business-rule-count: too few and too many are caught, cfpsPerRule param shifts the bounds', async () => {
    const { req, plan } = await packs()
    const tooFew = mutate(req.goldenSample, d => { d.businessRules = (d.businessRules as unknown[]).slice(0, 1) })
    expect(issueRuleIds(validateOf(req, 'zh-CN', tooFew, undefined, planContext(plan)))).toContain('req/business-rule-count')
    const tooMany = mutate(req.goldenSample, d => {
      d.businessRules = [...(d.businessRules as unknown[]), ...d.businessRules as unknown[]]
    })
    expect(issueRuleIds(validateOf(req, 'zh-CN', tooMany, undefined, planContext(plan)))).toContain('req/business-rule-count')
    // desiredCfps 35: cfpsPerRule 10 → min ceil(3.5)=4 rules, so the golden 3 rules become too few.
    const shifted = validateOf(req, 'zh-CN', req.goldenSample, { cfpsPerRule: 10 }, planContext(plan))
    expect(issueRuleIds(shifted)).toContain('req/business-rule-count')
  })

  it('business-rule-desc-min-length: a too-short rule description is caught', async () => {
    const { req, plan } = await packs()
    const draft = mutate(req.goldenSample, d => { (d.businessRules as Array<{ description: string }>)[0]!.description = '短' })
    expect(issueRuleIds(validateOf(req, 'zh-CN', draft, undefined, planContext(plan)))).toContain('req/business-rule-desc-min-length')
  })

  it('plan-alignment: funcId mismatch, index out of range, cfps mismatch, and missing upstream are all caught', async () => {
    const { req, plan } = await packs()
    const wrongId = mutate(req.goldenSample, d => { d.funcId = 'KERQ-352-02' })
    expect(issueRuleIds(validateOf(req, 'zh-CN', wrongId, undefined, planContext(plan)))).toContain('req/plan-alignment')
    const outOfRange = mutate(req.goldenSample, d => { d.index = 5 })
    expect(issueRuleIds(validateOf(req, 'zh-CN', outOfRange, undefined, planContext(plan)))).toContain('req/plan-alignment')
    const wrongCfps = mutate(req.goldenSample, d => { d.desiredCfps = 40 })
    expect(issueRuleIds(validateOf(req, 'zh-CN', wrongCfps, undefined, planContext(plan)))).toContain('req/plan-alignment')
    // Display-context fields: a wrong copy (or a dropped optional level the plan declares) is caught.
    const wrongReqNo = mutate(req.goldenSample, d => { d.reqNo = 'OTHER-002' })
    expect(issueRuleIds(validateOf(req, 'zh-CN', wrongReqNo, undefined, planContext(plan)))).toContain('req/plan-alignment')
    const wrongTitle = mutate(req.goldenSample, d => { d.reqTitle = '别的需求' })
    expect(issueRuleIds(validateOf(req, 'zh-CN', wrongTitle, undefined, planContext(plan)))).toContain('req/plan-alignment')
    const missingL2 = mutate(req.goldenSample, d => { delete d.l2Name })
    expect(issueRuleIds(validateOf(req, 'zh-CN', missingL2, undefined, planContext(plan)))).toContain('req/plan-alignment')
    // No upstream in the context (e.g. doc_validate without the upstream argument): loud, not silent.
    expect(issueRuleIds(validateOf(req, 'zh-CN', req.goldenSample))).toContain('req/plan-alignment')
    // Upstream that is not a plan artifact: same loud failure.
    const notPlan: RuleContext = { upstream: [{ docType: 'req' }] }
    expect(issueRuleIds(validateOf(req, 'zh-CN', req.goldenSample, undefined, notPlan))).toContain('req/plan-alignment')
  })

  it('functionalUsers[].kind: values outside the four kinds are schema-rejected; prompts guide story actors', async () => {
    const { req, plan } = await packs()
    const badKind = mutate(req.goldenSample, d => { (d.functionalUsers as Array<{ kind: string }>)[0]!.kind = 'robot' })
    expect(issueRuleIds(validateOf(req, 'zh-CN', badKind, undefined, planContext(plan))).has('schema/enum')).toBe(true)
    // The golden's person kind stays green.
    expect(issueRuleIds(validateOf(req, 'zh-CN', req.goldenSample, undefined, planContext(plan))).has('schema/enum')).toBe(false)
    // The prompt invites roles/third-party systems and top-level modules as story actors.
    for (const lang of req.manifest.languages) {
      const prompt = req.prompts.get(lang) ?? ''
      expect(prompt).toMatch(/第三方系统|third-party system/i)
      expect(prompt).toMatch(/顶层模块|top-level module/i)
    }
  })

  it('every ERROR issue carries a suggestion across all mutations', async () => {
    const { req, plan } = await packs()
    const ctx = planContext(plan)
    const drafts = [
      mutate(req.goldenSample, d => { delete d.functionalUsers }),
      mutate(req.goldenSample, d => { d.funcDesc = '太短' }),
      mutate(req.goldenSample, d => { d.funcId = 'bad id!' }),
      mutate(req.goldenSample, d => { (d.functionalUsers as Array<{ role: string }>)[0]!.role = 'wizard' }),
      mutate(req.goldenSample, d => { d.businessRules = (d.businessRules as unknown[]).slice(0, 1) }),
      mutate(req.goldenSample, d => { d.funcId = 'KERQ-352-02' }),
    ]
    const all = drafts.flatMap(draft => [...validateOf(req, 'zh-CN', draft, undefined, ctx), ...validateOf(req, 'en-US', draft, undefined, ctx)])
    const errors = all.filter(i => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    for (const issue of errors) expect(issue.suggestion.length, `${issue.ruleId}: ${issue.message}`).toBeGreaterThan(0)
  })
})

describe('cosmic-req chained generation (deterministic LLM)', () => {
  it('generates a green chained artifact and records the upstream anchor', async () => {
    const { req, plan } = await packs()
    const deps = await makeDeps(scriptedLlm([JSON.stringify(plan.goldenSample)]))
    await seedContext(deps)
    await defineDocGenerateTool(deps).execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true, artifactName: 'plan' } as never, { signal } as never)
    deps.ctx.llm = scriptedLlm([JSON.stringify(req.goldenSample)])
    const out = await defineDocGenerateTool(deps).execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n收藏功能需求素材'], language: 'zh-CN', upstream: ['topic-a/output/plan.json'], params: { targetIndex: 1 }, confirm: true,
    } as never, { signal } as never) as { receipt: { isValid: boolean; upstreamHashes: Array<{ pack: string; artifactHash: string }>; params?: Record<string, unknown> } }
    expect(out.receipt.isValid).toBe(true)
    expect(out.receipt.upstreamHashes).toHaveLength(1)
    expect(out.receipt.upstreamHashes[0]!.pack).toBe('cosmic-plan')
    // As-run params (defaults) are recorded for replay.
    expect(out.receipt.params).toMatchObject({ cfpsPerRule: 30, funcDescMaxLength: 500 })
  })

  it('repairs a cross-artifact violation in a later round (plan-alignment feeds the loop)', async () => {
    const { req, plan } = await packs()
    const deps = await makeDeps(scriptedLlm([JSON.stringify(plan.goldenSample)]))
    await seedContext(deps)
    await defineDocGenerateTool(deps).execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true, artifactName: 'plan' } as never, { signal } as never)
    const wrong = mutate(req.goldenSample, d => { d.funcId = 'KERQ-352-02' })
    deps.ctx.llm = scriptedLlm([JSON.stringify(wrong), JSON.stringify(req.goldenSample)])
    const out = await defineDocGenerateTool(deps).execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n收藏功能需求素材'], language: 'zh-CN', upstream: ['topic-a/output/plan.json'], params: { targetIndex: 1 }, confirm: true,
    } as never, { signal } as never) as { receipt: { isValid: boolean; iterations: number; rounds: Array<{ errorCount: number; promptHash?: string }> } }
    expect(out.receipt.isValid).toBe(true)
    expect(out.receipt.iterations).toBe(2)
    expect(out.receipt.rounds[0]!.errorCount).toBeGreaterThan(0)
    expect(out.receipt.rounds[1]!.errorCount).toBe(0)
  })

  it('doc_validate replays with upstream; without upstream the chained rule fails loud', async () => {
    const { req, plan } = await packs()
    const deps = await makeDeps(scriptedLlm([JSON.stringify(plan.goldenSample)]))
    await seedContext(deps)
    await defineDocGenerateTool(deps).execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true, artifactName: 'plan' } as never, { signal } as never)
    deps.ctx.llm = scriptedLlm([JSON.stringify(req.goldenSample)])
    await defineDocGenerateTool(deps).execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n收藏功能需求素材'], language: 'zh-CN', upstream: ['topic-a/output/plan.json'], params: { targetIndex: 1 }, confirm: true,
    } as never, { signal } as never)

    const withUpstream = await defineDocValidateTool(deps).execute({
      artifactPath: 'topic-a/output/cosmic-req-KERQ-352-01.json', pack: 'cosmic-req', upstream: ['topic-a/output/plan.json'],
    } as never, { signal } as never) as { receipt: { isValid: boolean }; hashMatches: boolean }
    expect(withUpstream.receipt.isValid).toBe(true)
    expect(withUpstream.hashMatches).toBe(true)

    const without = await defineDocValidateTool(deps).execute({
      artifactPath: 'topic-a/output/cosmic-req-KERQ-352-01.json', pack: 'cosmic-req',
    } as never, { signal } as never) as { receipt: { isValid: boolean; rules: Array<{ id: string; status: string }> } }
    expect(without.receipt.isValid).toBe(false)
    expect(without.receipt.rules.find(r => r.ruleId === 'req/plan-alignment')?.status).toBe('fail')
  })

  it('doc_validate upstream checks fail loud on an unreadable path and on a missing sidecar receipt', async () => {
    const deps = await makeDeps(scriptedLlm([JSON.stringify((await packs()).plan.goldenSample)]))
    await expect(defineDocValidateTool(deps).execute({
      artifactPath: 'topic-a/output/req.json', pack: 'cosmic-req', upstream: ['output/missing.json'],
    } as never, { signal } as never)).rejects.toThrow(/not readable/)
    // An artifact present but without its sidecar receipt: the six upstream checks refuse it.
    const root = (deps.config as { workspaceRoot: string }).workspaceRoot
    await mkdir(join(root, 'output'), { recursive: true })
    await writeFile(join(root, 'output', 'bare.json'), JSON.stringify((await packs()).plan.goldenSample), 'utf8')
    await expect(defineDocValidateTool(deps).execute({
      artifactPath: 'topic-a/output/req.json', pack: 'cosmic-req', upstream: ['output/bare.json'],
    } as never, { signal } as never)).rejects.toThrow(/receipt/)
  })
})
