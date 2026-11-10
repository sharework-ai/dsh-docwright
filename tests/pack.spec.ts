import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadPacks } from '../src/pack-loader.ts'
import { DocService } from '../src/doc-service.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))

async function loadCosmic() {
  const packs = await loadPacks(packsRoot, {})
  const pack = packs.get('cosmic-plan')
  if (pack === undefined) throw new Error('cosmic-plan not loaded')
  return pack
}

describe('pack loader', () => {
  it('loads the builtin cosmic-plan pack with both languages', async () => {
    const pack = await loadCosmic()
    expect(pack.manifest.version).toBe('0.7.1')
    expect(pack.manifest.consumes).toEqual(['cosmic-context'])
    for (const lang of ['zh-CN', 'en-US']) {
      expect(pack.prompts.get(lang)).toContain('{{materials}}')
      expect(pack.templates.get(lang)).toBeTruthy()
      expect((pack.rules.get(lang) ?? []).length).toBeGreaterThan(0)
    }
    expect(pack.functionRules.length).toBe(9)
  })

  it('golden sample passes all-green in both languages', async () => {
    const pack = await loadCosmic()
    const all = await loadPacks(packsRoot, {})
    const context = { upstream: [all.get('cosmic-context')!.goldenSample] }
    for (const lang of pack.manifest.languages) {
      const service = new DocService(pack, lang)
      const errors = service.validate(pack.goldenSample, { cfpTotal: { value: 70, downFactor: 0.9, upFactor: 1.2 }, moduleLevels: 2 }, context).filter(i => i.severity === 'error')
      expect(errors, `${lang}: ${JSON.stringify(errors)}`).toEqual([])
    }
  })

  it('fails loud on a broken manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-bad-root-'))
    const dir = join(root, 'bad-pack')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), '{"name": ""}', 'utf8')
    await expect(loadPacks(packsRoot, { extra: [root] })).rejects.toThrow(/manifest.name/)
  })

  it('fails loud when manifest.description is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-desc-root-'))
    const dir = join(root, 'no-desc')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'no-desc', version: '1', languages: ['zh-CN'] }), 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/manifest\.description/)
  })

  it('fails loud when a topic-scope pack declares topicNoPattern without topicNo (derivation pair)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-derivation-pair-'))
    const dir = join(root, 'pattern-only')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
    const manifest = (params: Record<string, unknown>, scope?: string) => JSON.stringify({
      name: 'pattern-only', version: '1', description: { en: 'd', zh: '说明' },
      languages: ['zh-CN'], ...(scope === undefined ? {} : { scope }), params,
    })
    await writeFile(join(dir, 'manifest.json'), manifest({ topicNoPattern: { type: 'string', required: true, default: '^([^\\s]+)', description: { en: 'd', zh: '说明' } } }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), '# p\n\n{{materials}}\n', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 'x', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, {})).rejects.toThrow(/declares topicNoPattern on a topic-scope pack but not topicNo/)
    // Workspace-scope packs only record the convention for downstream — pattern alone is fine there.
    await writeFile(join(dir, 'manifest.json'), manifest({ topicNoPattern: { type: 'string', required: true, default: '^([^\\s]+)', description: { en: 'd', zh: '说明' } } }, 'workspace'), 'utf8')
    await expect(loadPacks(root, {})).resolves.toBeDefined()
  })

  it('fails loud when a rules file is not an array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-root-'))
    const dir = join(root, 'broken-pack')
    await mkdir(join(dir, 'rules'), { recursive: true })
    await mkdir(join(dir, 'prompts'), { recursive: true })
    await mkdir(join(dir, 'templates'), { recursive: true })
    await mkdir(join(dir, 'samples'), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'broken', version: '1', description: 'd', languages: ['zh-CN'], consumes: [] }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '{"not":"array"}', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'p', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    await expect(loadPacks(root, { builtin: [] })).rejects.toThrow(/must be an array/)
  })

  it('extra dirs override same-name builtin packs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-override-'))
    const dir = join(root, 'cosmic-plan')
    const src = join(packsRoot, 'cosmic-plan')
    const { cp } = await import('node:fs/promises')
    await cp(src, dir, { recursive: true })
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'manifest.json'), 'utf8'))
    manifest.version = '9.9.9'
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8')
    const packs = await loadPacks(packsRoot, { extra: [root] })
    expect(packs.get('cosmic-plan')?.manifest.version).toBe('9.9.9')
  })

  it('records load origin per pack (builtin root vs packsDir root)', async () => {
    const builtin = await loadPacks(packsRoot, {})
    const plan = builtin.get('cosmic-plan')!
    expect(plan.origin).toEqual({ kind: 'builtin', root: packsRoot })
    expect(plan.dir).toBe(join(packsRoot, 'cosmic-plan'))

    const root = await mkdtemp(join(tmpdir(), 'docwright-origin-'))
    const { cp } = await import('node:fs/promises')
    await cp(join(packsRoot, 'cosmic-context'), join(root, 'cosmic-context'), { recursive: true })
    const merged = await loadPacks(packsRoot, { extra: [root] })
    const custom = merged.get('cosmic-context')!
    // The winner is the packsDir copy — its origin must say so, so the params
    // UI can show where an edit will land and the write channel can be audited.
    expect(custom.origin).toEqual({ kind: 'packsDir', root })
    expect(custom.dir).toBe(join(root, 'cosmic-context'))
    // Non-overridden builtin packs keep the builtin origin in the same map.
    expect(merged.get('cosmic-plan')!.origin).toEqual({ kind: 'builtin', root: packsRoot })
  })

  it('fails loud when two packs within one root declare the same name', async () => {
    const { cp } = await import('node:fs/promises')
    const root = await mkdtemp(join(tmpdir(), 'docwright-dup-root-'))
    for (const sub of ['first', 'second']) {
      await cp(join(packsRoot, 'cosmic-plan'), join(root, `${sub}-cosmic-plan`), { recursive: true })
    }
    await expect(loadPacks(packsRoot, { extra: [root] })).rejects.toThrow(/duplicate pack name "cosmic-plan"/)
  })
})
