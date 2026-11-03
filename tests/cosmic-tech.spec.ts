import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DocService } from '../src/doc-service.ts'
import type { Issue } from '../src/issue.ts'
import type { Pack, RuleContext } from '../src/pack.ts'
import { resolveEffectiveParams } from '../src/params.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { seedContext } from './support.ts'
import { defineDocGenerateTool, defineDocValidateTool } from '../src/tools.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))
const signal = new AbortController().signal

let cache: { tech: Pack; func: Pack; req: Pack; plan: Pack } | undefined
async function packs(): Promise<{ tech: Pack; func: Pack; req: Pack; plan: Pack }> {
  if (cache === undefined) {
    const all = await loadPacks(packsRoot, {})
    cache = { tech: all.get('cosmic-tech')!, func: all.get('cosmic-func')!, req: all.get('cosmic-req')!, plan: all.get('cosmic-plan')! }
  }
  return cache
}

/** The upstream func fixture: cosmic-func's golden, which the tech golden references. */
function funcContext(func: Pack): RuleContext {
  return { upstream: [func.goldenSample] }
}

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

type Movement = { description: string; dataMovementType: string; dataGroup: string; dataProperties: string[]; cfp: number }

type ProcessDraft = { index: number; name: string; description: string; originator: string; receiver: string; origination_event: string; subProcesses: Movement[] }

/** A legal EW process (2 CFPs) that can be appended to grow the CFP total without tripping tech/movement-pattern. */
function extraPersist(n: number): ProcessDraft {
  return {
    index: 100 + n,
    name: `补充登记${n}`,
    description: `补充登记业务条目 ${n}`,
    originator: '注册用户',
    receiver: '收藏服务',
    origination_event: `用户提交补充登记 ${n}`,
    subProcesses: [
      { description: `用户提交条目 ${n} 的登记请求`, dataMovementType: 'E', dataGroup: `登记请求${n}`, dataProperties: ['用户ID', '条目ID'], cfp: 1 },
      { description: `系统将条目 ${n} 写入登记记录`, dataMovementType: 'W', dataGroup: `登记记录${n}`, dataProperties: ['条目ID', '登记时间'], cfp: 1 },
    ],
  }
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
      workspaceRoot: await mkdtemp(join(tmpdir(), 'docwright-tech-chain-')),
      maxIterations: 3,
      promptTokenBudget: 60_000,
    } as never,
    ctx: { llm },
  }
}

/** Generates the plan→req→func chain so a tech doc_generate/validate call has a green upstream on disk. */
async function generateFuncChain(deps: { ctx: { llm: unknown } }, func: Pack, req: Pack, plan: Pack): Promise<void> {
  await seedContext(deps)
  deps.ctx.llm = scriptedLlm([JSON.stringify(plan.goldenSample)])
  await defineDocGenerateTool(deps).execute({ pack: 'cosmic-plan', topic: 'topic-a', materials: ['#!inline\nx'], language: 'zh-CN', upstream: ['context/context.json'], params: { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 } }, confirm: true, artifactName: 'plan' } as never, { signal } as never)
  deps.ctx.llm = scriptedLlm([JSON.stringify(req.goldenSample)])
  await defineDocGenerateTool(deps).execute({ pack: 'cosmic-req', topic: 'topic-a', materials: ['#!inline\n收藏功能需求素材'], language: 'zh-CN', upstream: ['topic-a/output/plan.json'], params: { targetIndex: 1 }, confirm: true,
  } as never, { signal } as never)
  deps.ctx.llm = scriptedLlm([JSON.stringify(func.goldenSample)])
  await defineDocGenerateTool(deps).execute({ pack: 'cosmic-func', topic: 'topic-a', materials: ['#!inline\n收藏功能需求素材'], language: 'zh-CN', upstream: ['topic-a/output/cosmic-req-KERQ-352-01.json'], params: { targetIndex: 1 }, confirm: true,
  } as never, { signal } as never)
}

describe('cosmic-tech pack shape', () => {
  it('declares the chain, the two budget params, and the seven function rules', async () => {
    const { tech } = await packs()
    expect(tech.manifest.consumes).toEqual(['cosmic-func'])
    expect(tech.manifest.languages).toEqual(['zh-CN', 'en-US'])
    expect(Object.keys(tech.manifest.params ?? {}).sort()).toEqual(['cfpMax', 'cfpMin', 'cfpPerFunc', 'cfpPerSubProc', 'cfpTotal', 'movementSequencePattern', 'subprocessDescPattern', 'targetIndex', 'topicNo', 'topicNoPattern'])
    expect(tech.functionRules.map(r => r.id)).toEqual([
      'tech/func-alignment',
      'tech/movement-pattern',
      'tech/movement-duplicate',
      'tech/subprocess-desc-keywords',
      'tech/data-properties-count',
      'tech/cfp-total-vs-budget',
      'tech/cfp-budget-advice',
    ])
  })

  it('prompts carry the materials, upstream, and params slots in both languages', async () => {
    const { tech } = await packs()
    for (const lang of tech.manifest.languages) {
      const prompt = tech.prompts.get(lang) ?? ''
      expect(prompt).toContain('{{materials}}')
      expect(prompt).toContain('{{upstream}}')
      expect(prompt).toContain('{{params}}')
    }
  })
})

describe('cosmic-tech golden sample', () => {
  it('passes all-green in both languages against the upstream func fixture', async () => {
    const { tech, func } = await packs()
    for (const lang of tech.manifest.languages) {
      const issues = validateOf(tech, lang, tech.goldenSample, undefined, funcContext(func))
      expect(issues, `${lang}: ${JSON.stringify(issues)}`).toEqual([])
    }
  })
})

describe('cosmic-tech mutation tests (guardrail-is-real)', () => {
  it('schema violation: missing subProcesses is caught', async () => {
    const { tech, func } = await packs()
    const draft = mutate(tech.goldenSample, d => { delete (d.processes as Array<Record<string, unknown>>)[0]!.subProcesses })
    const ids = [...issueRuleIds(validateOf(tech, 'zh-CN', draft, undefined, funcContext(func)))]
    expect(ids.some(id => id.startsWith('schema/'))).toBe(true)
  })

  it('func-id-format: a malformed funcId is caught', async () => {
    const { tech, func } = await packs()
    const draft = mutate(tech.goldenSample, d => { d.funcId = 'bad id!' })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', draft, undefined, funcContext(func)))).toContain('tech/func-id-format')
  })

  it('func-alignment: anchor mismatches, missing process coverage, and missing upstream are all caught', async () => {
    const { tech, func } = await packs()
    const wrongIndex = mutate(tech.goldenSample, d => { d.index = 2 })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', wrongIndex, undefined, funcContext(func)))).toContain('tech/func-alignment')
    const wrongId = mutate(tech.goldenSample, d => { d.funcId = 'KERQ-352-02' })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', wrongId, undefined, funcContext(func)))).toContain('tech/func-alignment')
    const wrongCfps = mutate(tech.goldenSample, d => { d.desiredCfps = 40 })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', wrongCfps, undefined, funcContext(func)))).toContain('tech/func-alignment')
    // Display-context fields: a wrong copy (or a dropped level the upstream declares) is caught.
    const wrongReqNo = mutate(tech.goldenSample, d => { d.reqNo = 'OTHER-002' })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', wrongReqNo, undefined, funcContext(func)))).toContain('tech/func-alignment')
    const missingL1 = mutate(tech.goldenSample, d => { delete d.l1Name })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', missingL1, undefined, funcContext(func)))).toContain('tech/func-alignment')
    // A renamed tech process leaves an upstream func process uncovered.
    const renamed = mutate(tech.goldenSample, d => { (d.processes as Array<{ name: string }>)[0]!.name = '收藏条目' })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', renamed, undefined, funcContext(func)))).toContain('tech/func-alignment')
    // No upstream in the context (e.g. doc_validate without the upstream argument): loud, not silent.
    expect(issueRuleIds(validateOf(tech, 'zh-CN', tech.goldenSample))).toContain('tech/func-alignment')
    // Upstream that is not a func artifact: same loud failure.
    const notFunc: RuleContext = { upstream: [{ docType: 'tech' }] }
    expect(issueRuleIds(validateOf(tech, 'zh-CN', tech.goldenSample, undefined, notFunc))).toContain('tech/func-alignment')
  })

  it('movement-pattern: sequences outside ERX/EW/EX are rejected', async () => {
    const { tech, func } = await packs()
    const ctx = funcContext(func)
    // EWRX: appending R and X to the golden EW process leaves the pattern set.
    const ewrx = mutate(tech.goldenSample, d => {
      const movements = (d.processes as Array<{ subProcesses: Movement[] }>)[0]!.subProcesses
      movements.push({ description: '系统读取补充数据', dataMovementType: 'R', dataGroup: '补充数据组', dataProperties: ['字段甲', '字段乙'], cfp: 1 }, { description: '系统返回补充数据', dataMovementType: 'X', dataGroup: '补充结果', dataProperties: ['字段丙', '字段丁'], cfp: 1 })
    })
    const ewrxIssues = validateOf(tech, 'zh-CN', ewrx, undefined, ctx)
    expect(issueRuleIds(ewrxIssues)).toContain('tech/movement-pattern')
    expect(ewrxIssues.find(i => i.ruleId === 'tech/movement-pattern')?.severity).toBe('error')
    // ERRX: a second read inside the golden ERX process is not ERX any more.
    const errx = mutate(tech.goldenSample, d => {
      const movements = (d.processes as Array<{ subProcesses: Movement[] }>)[2]!.subProcesses
      movements.splice(2, 0, { description: '系统再次读取补充数据', dataMovementType: 'R', dataGroup: '补充数据组', dataProperties: ['字段甲', '字段乙'], cfp: 1 })
    })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', errx, undefined, ctx))).toContain('tech/movement-pattern')
    // Single movement: E alone matches nothing.
    const single = mutate(tech.goldenSample, d => {
      (d.processes as Array<{ subProcesses: Movement[] }>)[0]!.subProcesses = (d.processes as Array<{ subProcesses: Movement[] }>)[0]!.subProcesses.slice(0, 1)
    })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', single, undefined, ctx))).toContain('tech/movement-pattern')
    // Not opened by E and not closed by W/X: both pattern violations.
    const openWrong = mutate(tech.goldenSample, d => {
      (d.processes as Array<{ subProcesses: Movement[] }>)[2]!.subProcesses[0]!.dataMovementType = 'R'
    })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', openWrong, undefined, ctx))).toContain('tech/movement-pattern')
    const unclosed = mutate(tech.goldenSample, d => {
      const movements = (d.processes as Array<{ subProcesses: Movement[] }>)[2]!.subProcesses
      movements.pop()
    })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', unclosed, undefined, ctx))).toContain('tech/movement-pattern')
  })

  it('movement-pattern: all three legal patterns pass — ERX, EW, and EX', async () => {
    const { tech, func } = await packs()
    const ctx = funcContext(func)
    // The golden carries ERX and EW processes; turning one ERX into EX must stay green.
    const ex = mutate(tech.goldenSample, d => {
      const movements = (d.processes as Array<{ subProcesses: Movement[] }>)[2]!.subProcesses
      movements[1]!.dataMovementType = 'X'
      movements.pop()
      movements[1]!.description = '系统向用户返回收藏列表与总数'
    })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', ex, undefined, ctx))).not.toContain('tech/movement-pattern')
    // Sequences seen in the golden itself.
    const seqs = (tech.goldenSample as { processes: Array<{ subProcesses: Array<{ dataMovementType: string }> }> }).processes
      .map(p => p.subProcesses.map(m => m.dataMovementType).join(''))
    expect(seqs.filter(s => s === 'ERX')).toHaveLength(7)
    expect(seqs.filter(s => s === 'EW')).toHaveLength(7)
  })

  it('movement-duplicate: an identical repeated movement is flagged as warning', async () => {
    const { tech, func } = await packs()
    // Golden process 3 is E,R,X; cloning the R movement's identity onto the
    // final X yields E,R,R with two identical R|收藏记录 movements.
    const draft = mutate(tech.goldenSample, d => {
      const movements = (d.processes as Array<{ subProcesses: Movement[] }>)[2]!.subProcesses
      movements[2]!.dataMovementType = 'R'
      movements[2]!.dataGroup = movements[1]!.dataGroup
      movements[2]!.dataProperties = [...movements[1]!.dataProperties]
    })
    const issues = validateOf(tech, 'zh-CN', draft, undefined, funcContext(func))
    expect(issueRuleIds(issues)).toContain('tech/movement-duplicate')
    expect(issues.find(i => i.ruleId === 'tech/movement-duplicate')?.severity).toBe('warning')
  })

  it('subprocess-desc-keywords: a technical word in a description is flagged as warning', async () => {
    const { tech, func } = await packs()
    const draft = mutate(tech.goldenSample, d => {
      (d.processes as Array<{ subProcesses: Movement[] }>)[0]!.subProcesses[0]!.description = '系统解析用户提交的收藏请求'
    })
    const issues = validateOf(tech, 'zh-CN', draft, undefined, funcContext(func))
    expect(issueRuleIds(issues)).toContain('tech/subprocess-desc-keywords')
    expect(issues.find(i => i.ruleId === 'tech/subprocess-desc-keywords')?.severity).toBe('warning')
  })

  it('data-properties-count: a single data property is flagged as warning', async () => {
    const { tech, func } = await packs()
    const draft = mutate(tech.goldenSample, d => {
      (d.processes as Array<{ subProcesses: Movement[] }>)[0]!.subProcesses[0]!.dataProperties = ['用户ID']
    })
    const issues = validateOf(tech, 'zh-CN', draft, undefined, funcContext(func))
    expect(issueRuleIds(issues)).toContain('tech/data-properties-count')
    expect(issues.find(i => i.ruleId === 'tech/data-properties-count')?.severity).toBe('warning')
  })

  it('cfp-total-vs-budget: totals outside the ratio band are errors and the params shift the band', async () => {
    const { tech, func } = await packs()
    const ctx = funcContext(func)
    // Golden total is 35; cfpTotal.upFactor 0.9 collapses the ceiling to 31.5 → error.
    expect(issueRuleIds(validateOf(tech, 'zh-CN', tech.goldenSample, { cfpTotal: { value: 35, downFactor: 0.9, upFactor: 0.9 } }, ctx))).toContain('tech/cfp-total-vs-budget')
    // Below the floor: the first three processes total 2+2+3 = 7 CFPs < 31.5.
    const skinny = mutate(tech.goldenSample, d => { d.processes = (d.processes as unknown[]).slice(0, 3) })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', skinny, undefined, ctx))).toContain('tech/cfp-total-vs-budget')
    // Above the ceiling: four extra EW processes push 35 to 43 CFPs > 42.
    const fat = mutate(tech.goldenSample, d => {
      d.processes = [...(d.processes as unknown[]), extraPersist(1), extraPersist(2), extraPersist(3), extraPersist(4)]
    })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', fat, undefined, ctx))).toContain('tech/cfp-total-vs-budget')
    // The floor is pinned at the plan estimate: one CFP short errors even when
    // the caller loosens downFactor — tech never totals below the plan.
    const oneShort = mutate(tech.goldenSample, d => {
      const procs = d.processes as Array<{ subProcesses: unknown[] }>
      procs[0]!.subProcesses = procs[0]!.subProcesses.slice(0, 1)
    })
    expect(issueRuleIds(validateOf(tech, 'zh-CN', oneShort, { cfpTotal: { value: 35, downFactor: 0.8, upFactor: 1.2 } }, ctx))).toContain('tech/cfp-total-vs-budget')
    // Equal to the estimate passes (the golden: 35 = 35) regardless of downFactor.
    expect(issueRuleIds(validateOf(tech, 'zh-CN', tech.goldenSample, { cfpTotal: { value: 35, downFactor: 0.8, upFactor: 1.2 } }, ctx))).not.toContain('tech/cfp-total-vs-budget')
  })

  it('cfp-budget-advice: totals inside the band but off the budget are warnings', async () => {
    const { tech, func } = await packs()
    const ctx = funcContext(func)
    // 45 CFPs: inside [0.9, 1.5]×35 but above the 1.2 warning threshold (42).
    const over = mutate(tech.goldenSample, d => {
      d.processes = [...(d.processes as unknown[]), extraPersist(1), extraPersist(2), extraPersist(3), extraPersist(4), extraPersist(5)]
    })
    const issues = validateOf(tech, 'zh-CN', over, { cfpTotal: { value: 35, downFactor: 0.9, upFactor: 1.5 } }, ctx)
    expect(issueRuleIds(issues)).toContain('tech/cfp-budget-advice')
    expect(issues.find(i => i.ruleId === 'tech/cfp-budget-advice')?.severity).toBe('warning')
    expect(issueRuleIds(issues)).not.toContain('tech/cfp-total-vs-budget')
    // The golden (35) equals the budget exactly: no advice.
    expect(issueRuleIds(validateOf(tech, 'zh-CN', tech.goldenSample, undefined, ctx))).not.toContain('tech/cfp-budget-advice')
  })

  it('every ERROR issue carries a suggestion across all mutations', async () => {
    const { tech, func } = await packs()
    const ctx = funcContext(func)
    const drafts = [
      mutate(tech.goldenSample, d => { delete (d.processes as Array<Record<string, unknown>>)[0]!.subProcesses }),
      mutate(tech.goldenSample, d => { d.funcId = 'bad id!' }),
      mutate(tech.goldenSample, d => { d.funcId = 'KERQ-352-02' }),
      mutate(tech.goldenSample, d => { (d.processes as Array<{ name: string }>)[0]!.name = '收藏条目' }),
      mutate(tech.goldenSample, d => {
        const procs = d.processes as Array<{ subProcesses: Movement[] }>
        procs[0]!.subProcesses = procs[0]!.subProcesses.slice(0, 1)
      }),
      mutate(tech.goldenSample, d => {
        const movements = (d.processes as Array<{ subProcesses: Movement[] }>)[2]!.subProcesses
        movements.splice(2, 0, { description: '系统再次读取补充数据', dataMovementType: 'R', dataGroup: '补充数据组', dataProperties: ['字段甲', '字段乙'], cfp: 1 })
      }),
    ]
    const all = drafts.flatMap(draft => [...validateOf(tech, 'zh-CN', draft, undefined, ctx), ...validateOf(tech, 'en-US', draft, undefined, ctx)])
    const errors = all.filter(i => i.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    for (const issue of errors) expect(issue.suggestion.length, `${issue.ruleId}: ${issue.message}`).toBeGreaterThan(0)
  })
})

describe('cosmic-tech chained generation (deterministic LLM)', () => {
  it('generates a green artifact in the full plan→req→func→tech chain and records the upstream anchor', async () => {
    const { tech, func, req, plan } = await packs()
    const deps = await makeDeps(undefined)
    await generateFuncChain(deps, func, req, plan)
    deps.ctx.llm = scriptedLlm([JSON.stringify(tech.goldenSample)])
    const out = await defineDocGenerateTool(deps).execute({ pack: 'cosmic-tech', topic: 'topic-a', materials: ['#!inline\n收藏功能需求素材'], language: 'zh-CN', upstream: ['topic-a/output/cosmic-func-KERQ-352-01.json'], params: { targetIndex: 1 }, confirm: true,
    } as never, { signal } as never) as { receipt: { isValid: boolean; upstreamHashes: Array<{ pack: string; artifactHash: string }>; params?: Record<string, unknown> } }
    expect(out.receipt.isValid).toBe(true)
    expect(out.receipt.upstreamHashes).toHaveLength(1)
    expect(out.receipt.upstreamHashes[0]!.pack).toBe('cosmic-func')
    // As-run params (defaults) are recorded for replay. The band's concrete
    // value is user-maintainable (params UI) - assert the shape, not a number.
    expect(out.receipt.params).toMatchObject({
      cfpPerFunc: expect.objectContaining({ value: expect.any(Number), min: expect.any(Number), max: expect.any(Number) }),
      cfpPerSubProc: 2.5,
    })
  })

  it('repairs a cross-artifact violation in a later round (func-alignment feeds the loop)', async () => {
    const { tech, func, req, plan } = await packs()
    const deps = await makeDeps(undefined)
    await generateFuncChain(deps, func, req, plan)
    const wrong = mutate(tech.goldenSample, d => { d.desiredCfps = 40 })
    deps.ctx.llm = scriptedLlm([JSON.stringify(wrong), JSON.stringify(tech.goldenSample)])
    const out = await defineDocGenerateTool(deps).execute({ pack: 'cosmic-tech', topic: 'topic-a', materials: ['#!inline\n收藏功能需求素材'], language: 'zh-CN', upstream: ['topic-a/output/cosmic-func-KERQ-352-01.json'], params: { targetIndex: 1 }, confirm: true,
    } as never, { signal } as never) as { receipt: { isValid: boolean; iterations: number; rounds: Array<{ errorCount: number }> } }
    expect(out.receipt.isValid).toBe(true)
    expect(out.receipt.iterations).toBe(2)
    expect(out.receipt.rounds[0]!.errorCount).toBeGreaterThan(0)
    expect(out.receipt.rounds[1]!.errorCount).toBe(0)
  })

  it('doc_validate replays with upstream; without upstream the chained rule fails loud', async () => {
    const { tech, func, req, plan } = await packs()
    const deps = await makeDeps(undefined)
    await generateFuncChain(deps, func, req, plan)
    deps.ctx.llm = scriptedLlm([JSON.stringify(tech.goldenSample)])
    await defineDocGenerateTool(deps).execute({ pack: 'cosmic-tech', topic: 'topic-a', materials: ['#!inline\n收藏功能需求素材'], language: 'zh-CN', upstream: ['topic-a/output/cosmic-func-KERQ-352-01.json'], params: { targetIndex: 1 }, confirm: true,
    } as never, { signal } as never)

    const withUpstream = await defineDocValidateTool(deps).execute({
      artifactPath: 'topic-a/output/cosmic-tech-KERQ-352-01.json', pack: 'cosmic-tech', upstream: ['topic-a/output/cosmic-func-KERQ-352-01.json'],
    } as never, { signal } as never) as { receipt: { isValid: boolean }; hashMatches: boolean }
    expect(withUpstream.receipt.isValid).toBe(true)
    expect(withUpstream.hashMatches).toBe(true)

    const without = await defineDocValidateTool(deps).execute({
      artifactPath: 'topic-a/output/cosmic-tech-KERQ-352-01.json', pack: 'cosmic-tech',
    } as never, { signal } as never) as { receipt: { isValid: boolean; rules: Array<{ id: string; status: string }> } }
    expect(without.receipt.isValid).toBe(false)
    expect(without.receipt.rules.find(r => r.ruleId === 'tech/func-alignment')?.status).toBe('fail')
  })
})
