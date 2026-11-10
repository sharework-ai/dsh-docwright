import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRuleEngine } from '../src/rule-engine.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { resolveEffectiveParams } from '../src/params.ts'
import type { Issue } from '../src/issue.ts'
import type { Pack } from '../src/pack.ts'

const packsRoot = new URL('../packs', import.meta.url).pathname

/** Declared defaults as effective params (pattern params ship enabled). */
function defaultParams(pack: Pack): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(pack.manifest.params ?? {})
      .filter(([, spec]) => spec.default !== undefined)
      .map(([name, spec]) => [name, spec.default]),
  )
}

function clone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function ruleIds(issues: readonly Issue[]): Set<string> {
  return new Set(issues.map(i => i.ruleId))
}

describe('pattern rules driven by string params (cosmic-func)', () => {
  it('documents the fixture: golden passes under the shipped defaults', async () => {
    const packs = await loadPacks(packsRoot, {})
    const func = packs.get('cosmic-func')!
    const issues = createRuleEngine(func, 'zh-CN')(clone(func.goldenSample), defaultParams(func))
    expect(ruleIds(issues)).not.toContain('func/process-name-forbidden')
    expect(ruleIds(issues)).not.toContain('func/originator-forbidden')
  })

  it('a design word in a process name trips the default pattern (error)', async () => {
    const packs = await loadPacks(packsRoot, {})
    const func = packs.get('cosmic-func')!
    const draft = clone(func.goldenSample)
    ;(draft.processes as Array<{ name: string }>)[0]!.name = '商品设计'
    const issues = createRuleEngine(func, 'zh-CN')(draft, defaultParams(func))
    expect(ruleIds(issues)).toContain('func/process-name-forbidden')
    expect(issues.find(i => i.ruleId === 'func/process-name-forbidden')?.severity).toBe('error')
  })

  it('empty string disables the check; a lenient pattern stops flagging; a stricter one flags valid-by-default names', async () => {
    const packs = await loadPacks(packsRoot, {})
    const func = packs.get('cosmic-func')!
    const draft = clone(func.goldenSample)
    ;(draft.processes as Array<{ name: string }>)[0]!.name = '商品设计'
    const disabled = createRuleEngine(func, 'zh-CN')(draft, { ...defaultParams(func), processNameForbiddenPattern: '' })
    expect(ruleIds(disabled)).not.toContain('func/process-name-forbidden')
    const lenient = createRuleEngine(func, 'zh-CN')(draft, { ...defaultParams(func), processNameForbiddenPattern: '^.+$' })
    expect(ruleIds(lenient)).not.toContain('func/process-name-forbidden')
    const strict = createRuleEngine(func, 'zh-CN')(clone(func.goldenSample), { ...defaultParams(func), processNameForbiddenPattern: '^[0-9]+$' })
    expect(ruleIds(strict)).toContain('func/process-name-forbidden')
  })

  it('an invalid regex fails loud, never silently passes', async () => {
    const packs = await loadPacks(packsRoot, {})
    const func = packs.get('cosmic-func')!
    expect(() => createRuleEngine(func, 'zh-CN')(clone(func.goldenSample), { ...defaultParams(func), processNameForbiddenPattern: '([bad' }))
      .toThrow(/processNameForbiddenPattern.*not a valid regex/)
  })

  it('a missing string param fails loud (effective params are always complete)', async () => {
    const packs = await loadPacks(packsRoot, {})
    const func = packs.get('cosmic-func')!
    expect(() => createRuleEngine(func, 'zh-CN')(clone(func.goldenSample), {}))
      .toThrow(/processNameForbiddenPattern.*did not resolve to a string/)
  })
})

describe('pattern rules driven by string params (cosmic-tech function rules)', () => {
  /** Movement shapes the default ^(ERX|EW|EX)$ rejects. */
  const ewrx = {
    language: 'zh-CN',
    processes: [{
      name: '查询收藏',
      subProcesses: [
        { dataMovementType: 'E', description: '用户发起查询', dataGroup: '查询条件', dataProperties: ['a', 'b'], cfp: 1 },
        { dataMovementType: 'W', description: '系统记录查询', dataGroup: '查询记录', dataProperties: ['a', 'b'], cfp: 1 },
        { dataMovementType: 'R', description: '系统读取收藏', dataGroup: '收藏记录', dataProperties: ['a', 'b'], cfp: 1 },
        { dataMovementType: 'X', description: '系统返回收藏', dataGroup: '收藏列表', dataProperties: ['a', 'b'], cfp: 1 },
      ],
    }],
  }

  it('the default ^(ERX|EW|EX)$ rejects EWRX; an empty param disables; a custom pattern decides', async () => {
    const packs = await loadPacks(packsRoot, {})
    const tech = packs.get('cosmic-tech')!
    const engine = createRuleEngine(tech, 'zh-CN')
    expect(ruleIds(engine(clone(ewrx), defaultParams(tech)))).toContain('tech/movement-pattern')
    expect(ruleIds(engine(clone(ewrx), { ...defaultParams(tech), movementSequencePattern: '' }))).not.toContain('tech/movement-pattern')
    expect(ruleIds(engine(clone(ewrx), { ...defaultParams(tech), movementSequencePattern: '^E[RW]*X$' }))).not.toContain('tech/movement-pattern')
  })

  it('subprocessDescPattern replaces the word list; empty disables', async () => {
    const packs = await loadPacks(packsRoot, {})
    const tech = packs.get('cosmic-tech')!
    const draft = clone(ewrx)
    ;((draft.processes as Array<{ subProcesses: Array<{ description: string }> }>)[0]!.subProcesses)[0]!.description = '系统计算结果并缓存'
    const engine = createRuleEngine(tech, 'zh-CN')
    expect(ruleIds(engine(clone(draft), defaultParams(tech)))).toContain('tech/subprocess-desc-keywords')
    expect(ruleIds(engine(clone(draft), { ...defaultParams(tech), subprocessDescPattern: '' }))).not.toContain('tech/subprocess-desc-keywords')
    expect(ruleIds(engine(clone(draft), { ...defaultParams(tech), subprocessDescPattern: '^(?:(?!缓存).)*$' }))).toContain('tech/subprocess-desc-keywords')
    expect(ruleIds(engine(clone(draft), { ...defaultParams(tech), subprocessDescPattern: '^.*$' }))).not.toContain('tech/subprocess-desc-keywords')
  })
})

/** Minimal loadable pack directory with the given rules and params. */
async function packFixture(root: string, name: string, rules: readonly unknown[], params: Record<string, unknown>): Promise<string> {
  const dir = join(root, name)
  for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    name, version: '1', description: 'd', consumes: [], languages: ['zh-CN'], params,
  }), 'utf8')
  await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
  await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify(rules), 'utf8')
  await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
  await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
  await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
  return dir
}

const stringParam = (extra: Record<string, unknown> = {}) => ({ type: 'string', default: '^(ERX|EW|EX)$', description: 'd', ...extra })

describe('load-time validation of pattern-referenced params', () => {
  it('rejects undeclared, non-string, overridable, and never-present references; bad default regex fails at load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-regex-'))
    try {
      await packFixture(root, 'p1', [{ id: 'r', severity: 'error', given: '$', field: 'a', kind: 'pattern', pattern: { param: 'nope' }, mustMatch: true, suggestion: 's' }], {})
      await expect(loadPacks(root, {})).rejects.toThrow(/references undeclared param "nope"/)

      await rm(join(root, 'p1'), { recursive: true, force: true })
      await packFixture(root, 'p1', [{ id: 'r', severity: 'error', given: '$', field: 'a', kind: 'pattern', pattern: { param: 'p' }, mustMatch: true, suggestion: 's' }], { p: { type: 'number', default: 3, description: { en: 'd', zh: '说明' } } })
      await expect(loadPacks(root, {})).rejects.toThrow(/pattern references require a string-typed param/)

      await rm(join(root, 'p1'), { recursive: true, force: true })
      await packFixture(root, 'p1', [{ id: 'r', severity: 'error', given: '$', field: 'a', kind: 'pattern', pattern: { param: 'p' }, mustMatch: true, suggestion: 's' }], { p: stringParam({ overridable: true, confirm: true }) })
      await expect(loadPacks(root, {})).rejects.toThrow(/must not be overridable/)

      await rm(join(root, 'p1'), { recursive: true, force: true })
      await packFixture(root, 'p1', [{ id: 'r', severity: 'error', given: '$', field: 'a', kind: 'pattern', pattern: { param: 'p' }, mustMatch: true, suggestion: 's' }], { p: { type: 'string', description: { en: 'd', zh: '说明' } } })
      await expect(loadPacks(root, {})).rejects.toThrow(/param that is always present/)

      await rm(join(root, 'p1'), { recursive: true, force: true })
      await packFixture(root, 'p1', [{ id: 'r', severity: 'error', given: '$', field: 'a', kind: 'pattern', pattern: { param: 'p' }, mustMatch: true, suggestion: 's' }], { p: stringParam({ default: '([bad' }) })
      await expect(loadPacks(root, {})).rejects.toThrow(/default does not compile/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an empty default is legal (check ships disabled)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-regex-'))
    try {
      await packFixture(root, 'p1', [{ id: 'r', severity: 'error', given: '$', field: 'a', kind: 'pattern', pattern: { param: 'p' }, mustMatch: true, suggestion: 's' }], { p: stringParam({ default: '' }) })
      await expect(loadPacks(root, {})).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a topicNoPattern param with a non-compilable default fails at load (engine-facing regex, unicode flag)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-regex-'))
    try {
      await packFixture(root, 'p1', [], { topicNoPattern: { type: 'string', required: true, default: '(', description: { en: 'd', zh: '说明' } } })
      await expect(loadPacks(root, {})).rejects.toThrow(/topicNoPattern\.default does not compile as a regex/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('real builtin packs: regex params resolve through the standard param path', () => {
  it('resolveEffectiveParams yields the pattern defaults; UI-shaped overrides flow into the engine', async () => {
    const packs = await loadPacks(packsRoot, {})
    const func = packs.get('cosmic-func')!
    const effective = resolveEffectiveParams(func, { targetIndex: 1 })
    expect(effective.processNameForbiddenPattern).toBe('^(?:(?!进行|执行|异常处理|设计|校验|conduct|execute).)*$')
    const draft = clone(func.goldenSample)
    ;(draft.processes as Array<{ name: string }>)[0]!.name = '订单管理'
    const issues = createRuleEngine(func, 'zh-CN')(draft, effective)
    expect(ruleIds(issues)).toContain('func/process-name-suffix')
  })
})
