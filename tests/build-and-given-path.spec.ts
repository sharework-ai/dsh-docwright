import { describe, expect, it } from 'vitest'
import { assertGivenPath } from '../src/rule-engine.ts'
import { readBuildStamp } from '../src/build-info.ts'

describe('rule given-path grammar check (issue #2: load-time, fail loud)', () => {
  it('accepts supported shapes: root, single array hop, nested chain ending in [*]', () => {
    expect(() => assertGivenPath('r1', '$')).not.toThrow()
    expect(() => assertGivenPath('r1', '$.field[*]')).not.toThrow()
    expect(() => assertGivenPath('r1', '$.chapters[*].processes[*]')).not.toThrow()
  })

  it('rejects unsupported paths with the stale-build hint in the message', () => {
    for (const given of ['$.field', '$.a.b', '$.field[*].extra', 'field[*]', '$.[*]']) {
      try {
        assertGivenPath('r1', given)
        expect.unreachable(`${given} should have thrown`)
      } catch (error) {
        const message = (error as Error).message
        expect(message).toContain('not supported by this engine build')
        expect(message).toContain('rebuild the plugin')
      }
    }
  })
})

describe('build stamp (issue #3: the loaded artifact reports its own build)', () => {
  it('reads a stamp written next to the compiled module when present', () => {
    // In the built tree (lib/ or dist/) the stamp file exists after a full
    // build; in a raw src/ test run it is absent and the reader must say so
    // instead of throwing.
    const stamp = readBuildStamp()
    if (stamp !== undefined) {
      expect(stamp.gitSha).not.toEqual('unknown')
      expect(Number.isNaN(Date.parse(stamp.builtAt))).toBe(false)
    }
  })
})

describe('pack load rejects rules the engine build cannot execute (issue #2)', () => {
  it('loadOnePack fails loud at load with the stale-build hint, not at evaluation', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { loadPacks } = await import('../src/pack-loader.ts')
    const root = mkdtempSync(join(tmpdir(), 'given-path-load-'))
    try {
      const dir = join(root, 'future-pack')
      mkdirSync(join(dir, 'rules'), { recursive: true })
      mkdirSync(join(dir, 'prompts'), { recursive: true })
      mkdirSync(join(dir, 'templates'), { recursive: true })
      mkdirSync(join(dir, 'samples'), { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
        name: 'future-pack', version: '9.0.0',
        description: { en: 'uses grammar beyond the engine', zh: '未来语法' },
        languages: ['en-US'], consumes: [], params: {},
      }))
      writeFileSync(join(dir, 'schema.json'), JSON.stringify({ type: 'object' }))
      writeFileSync(join(dir, 'rules', 'en-US.json'), JSON.stringify([
        { id: 'future/given', severity: 'error', given: '$.a.b', field: 'title', kind: 'minLength', min: 4, suggestion: 'shorten or lengthen the text' },
      ]))
      writeFileSync(join(dir, 'prompts', 'en-US.md'), 'x {{materials}}')
      writeFileSync(join(dir, 'templates', 'en-US.hbs'), 'x')
      writeFileSync(join(dir, 'samples', 'golden.json'), JSON.stringify({}))
      await expect(loadPacks('/nonexistent-builtin', { includeBuiltin: false, extra: [root] })).rejects.toThrow(/not supported by this engine build/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
