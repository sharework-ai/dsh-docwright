import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineDocChainStatusTool, defineDocGenerateTool } from '../src/tools.ts'
import { loadPackSet } from '../src/pack-loader.ts'

const signal = new AbortController().signal
const TOPIC = 'walk-2026'
const examplesRoot = new URL('../examples/packsdir', import.meta.url).pathname

/** Nested fan-out (fanout.array as a dot path + depth declaration): plan
 * chapters[].processes[] drives walk-rec — candidates carry the enclosing
 * chapter path, targetIndex addresses the flattened order, and chain coverage
 * rows report each entry's chapter path. */
describe('nested fan-out addressing (fanout.array dot path + depth)', () => {
  it('candidates, naming and coverage work over chapters[].processes[]', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'docwright-depth-'))
    try {
      const set = await loadPackSet(examplesRoot, { includeBuiltin: false, roots: [{ dir: examplesRoot, origin: { kind: 'packsDir', root: examplesRoot } }] })
      expect(set.packs.has('walk-plan')).toBe(true)
      expect(set.packs.has('walk-rec')).toBe(true)
      // Loader validated the depth declaration against the path segments.
      expect(set.packs.get('walk-rec')!.manifest.fanout?.depth).toBe(2)

      const planGolden = JSON.stringify(set.packs.get('walk-plan')!.goldenSample)
      const recReply = JSON.stringify({ name: 'p3', title: 'Process three', note: 'Walked process three end to end and observed the expected queue behavior.' })
      const replies = [planGolden, recReply]
      const deps = {
        packs: set.packs,
        config: {
          provider: 'test', model: 'test-model', workspaceRoot: workspace,
          maxIterations: 3, promptTokenBudget: 60_000, confirmPolicy: 'none',
        } as never,
        ctx: {
          llm: {
            stream: async function* () {
              const text = replies.shift()
              if (text === undefined) throw new Error('scripted replies exhausted')
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'text-delta', index: 0, text }
              yield { type: 'block-end', index: 0, block: { type: 'text', text } }
              yield { type: 'finish', reason: 'stop' }
            },
          },
        },
      }
      const gen = defineDocGenerateTool(deps as never)
      const exec = { signal } as never

      // 1. The plan generates green.
      const plan = await gen.execute({ pack: 'walk-plan', topic: TOPIC, materials: ['#!inline\nchapters as in the demo'], language: 'en-US', artifactName: 'plan', confirm: true } as never, exec) as { artifactPath: string; receipt: { isValid: boolean } }
      expect(plan.receipt.isValid).toBe(true)

      // 2. Missing targetIndex: candidates list the flattened order WITH the
      // enclosing chapter path — two levels deep means path hints are mandatory.
      await expect(gen.execute({ pack: 'walk-rec', topic: TOPIC, upstream: [`${TOPIC}/output/plan.json`], language: 'en-US' } as never, exec))
        .rejects.toThrow(/1\. ch1 \u203a p1 \(Process one\); 2\. ch1 \u203a p2 \(Process two\); 3\. ch2 \u203a p3 \(Process three\)/)

      // 3. targetIndex 3 → the THIRD flattened entry (chapter two's process),
      // named after its declared id.
      const rec = await gen.execute({ pack: 'walk-rec', topic: TOPIC, upstream: [`${TOPIC}/output/plan.json`], language: 'en-US', params: { targetIndex: 3 }, confirm: true } as never, exec) as { artifactPath: string; receipt: { isValid: boolean } }
      expect(rec.receipt.isValid).toBe(true)
      expect(rec.artifactPath.endsWith('walk-rec-p3.json')).toBe(true)
      const body = JSON.parse(await readFile(rec.artifactPath, 'utf8')) as { name: string }
      expect(body.name).toBe('p3')

      // 4. Chain coverage: three flattened rows, each with its chapter path,
      // one covered, no orphans.
      const chain = defineDocChainStatusTool(deps as never)
      const status = await chain.execute({ plan: `${TOPIC}/output/plan.json` } as never, exec) as {
        stages: string[]
        functions: Array<{ funcId: string; path?: string }>
        coverage: Record<string, { covered: number; total: number }>
        orphaned?: unknown[]
      }
      expect(status.stages).toContain('walk-rec')
      expect(status.functions.map(r => r.funcId)).toEqual(['p1', 'p2', 'p3'])
      expect(status.functions.map(r => r.path)).toEqual(['ch1', 'ch1', 'ch2'])
      expect(status.coverage['walk-rec']).toEqual({ covered: 1, total: 3 })
      expect(status.orphaned).toBeUndefined()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('load-time validation: depth must equal the array path segments', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'docwright-depth-bad-'))
    try {
      const packsRoot = join(workspace, 'packs')
      const badRoot = join(packsRoot, 'bad-rec')
      await (await import('node:fs/promises')).mkdir(join(badRoot), { recursive: true })
      await (await import('node:fs/promises')).writeFile(join(badRoot, 'manifest.json'), JSON.stringify({
        name: 'bad-rec', version: '0.1.0', description: { en: 'bad' }, consumes: ['walk-plan'], languages: ['en-US'],
        fanout: { array: 'chapters.processes', depth: 3, idField: 'name' },
      }))
      await expect(loadPackSet(packsRoot, { includeBuiltin: false, roots: [{ dir: packsRoot, origin: { kind: 'packsDir', root: packsRoot } }] }))
        .rejects.toThrow(/fanout\.depth \(3\) must equal the number of segments/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
