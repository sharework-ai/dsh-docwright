import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readMaterialEntries } from '../src/materials.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { assembleGeneratorPrompt } from '../src/prompt.ts'
import { defineDocGenerateTool } from '../src/tools.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))
const signal = new AbortController().signal

describe('material origin tagging (docs/designs/material-origin.md)', () => {
  it('marks a file resolved from a runtime/ root as origin=runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-origin-'))
    await mkdir(join(root, 'input'), { recursive: true })
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'runtime', 'mid.txt'), 'intermediate', 'utf8')
    const entries = await readMaterialEntries(['mid.txt'], root, [join(root, 'input'), join(root, 'runtime')])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.origin).toBe('runtime')
  })

  it('same-name file under the user root wins the race and keeps origin=user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-origin-'))
    await mkdir(join(root, 'input'), { recursive: true })
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'input', 'both.txt'), 'user version', 'utf8')
    await writeFile(join(root, 'runtime', 'both.txt'), 'runtime version', 'utf8')
    const entries = await readMaterialEntries(['both.txt'], root, [join(root, 'input'), join(root, 'runtime')])
    expect(entries[0]?.origin).toBe('user')
    expect(entries[0]?.text).toBe('user version')
  })

  it('inline text stays untagged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docwright-origin-'))
    const entries = await readMaterialEntries(['#!inline\n原始需求'], root, [join(root, 'input'), join(root, 'runtime')])
    expect(entries[0]?.origin).toBeUndefined()
  })
})

describe('chain-head gate: head packs refuse runtime materials', () => {
  async function headPackHarness(): Promise<{ wsRoot: string; generate: (materials: string[]) => Promise<unknown> }> {
    const packRoot = await mkdtemp(join(tmpdir(), 'docwright-origin-pack-'))
    const dir = join(packRoot, 'head-pack')
    await mkdir(join(dir, 'rules'), { recursive: true })
    await mkdir(join(dir, 'prompts'), { recursive: true })
    await mkdir(join(dir, 'templates'), { recursive: true })
    await mkdir(join(dir, 'samples'), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'head-pack', version: '1.0.0', description: 'chain head fixture', consumes: [], languages: ['zh-CN'], scope: 'workspace', reuse: false }), 'utf8')
    await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
    await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'p {{materials}} {{upstream}} {{params}}', 'utf8')
    await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
    const packs = await loadPacks(packsRoot, { extra: [packRoot] })
    const wsRoot = await mkdtemp(join(tmpdir(), 'docwright-origin-ws-'))
    await mkdir(join(wsRoot, 'references'), { recursive: true })
    await mkdir(join(wsRoot, 'runtime'), { recursive: true })
    await writeFile(join(wsRoot, 'references', 'user.txt'), 'user material', 'utf8')
    await writeFile(join(wsRoot, 'runtime', 'mid.txt'), 'intermediate material', 'utf8')
    const deps = { packs, config: { provider: 'p', model: 'm', workspaceRoot: wsRoot } as never, ctx: { llm: {} } }
    const llm = {
      stream: async function* () {
        const reply = '{"v":1}'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const generate = (materials: string[]): Promise<unknown> => {
      deps.ctx = { llm }
      return defineDocGenerateTool(deps).execute({ pack: 'head-pack', materials, language: 'zh-CN', artifactName: 'ctx' } as never, { signal } as never) as never
    }
    return { wsRoot, generate }
  }

  it('a runtime/ ref is refused with an actionable message', async () => {
    const { generate } = await headPackHarness()
    await expect(generate(['mid.txt'])).rejects.toThrow(/chain head .* does not accept runtime materials.*mid\.txt/s)
  })

  it('a user-root ref passes unchanged', async () => {
    const { generate } = await headPackHarness()
    await expect(generate(['user.txt'])).resolves.toHaveProperty('receipt')
  })
})

describe('prompt material tags', () => {
  it('plain strings render as bare material blocks', () => {
    const out = assembleGeneratorPrompt({ promptTemplate: 'T{{materials}}', materials: ['m1'] })
    expect(out).toContain('<material>\nm1\n</material>')
  })

  it('tags render origin and path attributes; quotes in paths are escaped', () => {
    const out = assembleGeneratorPrompt({
      promptTemplate: 'T{{materials}}',
      materials: [
        { text: 'user text', path: '/ws/input/a.md', origin: 'user' },
        { text: 'runtime text', path: '/ws/"quoted"/runtime/b.md', origin: 'runtime' },
      ],
    })
    expect(out).toContain('<material origin="user" path="/ws/input/a.md">')
    expect(out).toContain('<material origin="runtime" path="/ws/&quot;quoted&quot;/runtime/b.md">')
    expect(out).not.toContain('path="/ws/"quoted"')
  })
})
