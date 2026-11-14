import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineDocChainStatusTool, defineDocGenerateTool } from '../src/tools.ts'
import { loadPackSet } from '../src/pack-loader.ts'

const signal = new AbortController().signal
const TOPIC = 'ideas-2026'
const examplesRoot = new URL('../examples/packsdir', import.meta.url).pathname

/** Deterministic second-scenario fan-out (docs/designs/pack-load-dirs.md generalization):
 * idea-board (workspace scope) lists ideas[]; idea-note declares
 * manifest.fanout {array: 'ideas', idField: 'ideaId', titleField: 'title'} and
 * consumes the board — addressing, engine naming and doc_chain_status coverage
 * must all work over a non-COSMIC vocabulary with zero engine special-casing. */
describe('generalized fan-out addressing (declared manifest.fanout)', () => {
  it('candidates, per-idea naming and chain coverage work over ideas[]/ideaId', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'docwright-fanout-'))
    try {
      const set = await loadPackSet(examplesRoot, { includeBuiltin: false, roots: [{ dir: examplesRoot, origin: { kind: 'packsDir', root: examplesRoot } }] })
      expect(set.packs.has('idea-board')).toBe(true)
      expect(set.packs.has('idea-note')).toBe(true)

      const boardGolden = JSON.stringify(set.packs.get('idea-board')!.goldenSample)
      // Calls in order: board → note for targetIndex 2 (export-pdf). The
      // model must copy the SELECTED idea's identity (the engine names the
      // artifact after it).
      const noteExport = JSON.stringify({ ideaId: 'export-pdf', title: 'Export to PDF', note: 'Use the browser print pipeline behind a small PDF service; first spike the print stylesheet.' })
      const replies = [boardGolden, noteExport]
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

      // 1. The board (upstream, workspace scope) generates green.
      const board = await gen.execute({ pack: 'idea-board', topic: TOPIC, materials: ['#!inline\nideas: dark-mode Dark mode; export-pdf Export to PDF'], language: 'en-US', artifactName: 'board', confirm: true } as never, exec) as { artifactPath: string; receipt: { isValid: boolean } }
      expect(board.receipt.isValid).toBe(true)
      expect(board.artifactPath).toBe(join(workspace, TOPIC, 'output', 'board.json'))

      // 2. idea-note without targetIndex: the gate lists the DECLARED
      // candidates (dark-mode, export-pdf) — the ideas[]/ideaId vocabulary,
      // not functions[].
      // confirmPolicy none: a missing targetIndex fails loud with the
      // DECLARED candidates inline (dark-mode, export-pdf) — the
      // ideas[]/ideaId vocabulary, not functions[].
      await expect(gen.execute({ pack: 'idea-note', topic: TOPIC, upstream: [`${TOPIC}/output/board.json`], language: 'en-US' } as never, exec))
        .rejects.toThrow(/Candidates from the upstream plan: 1\. dark-mode \(Dark mode\); 2\. export-pdf \(Export to PDF\)/)

      // 3. targetIndex 2 → green note, engine-named after the DECLARED id
      // (idea-note-export-pdf.json), artifact body carries ideaId for coverage.
      const note = await gen.execute({ pack: 'idea-note', topic: TOPIC, upstream: [`${TOPIC}/output/board.json`], language: 'en-US', params: { targetIndex: 2 }, confirm: true } as never, exec) as { artifactPath: string; receipt: { isValid: boolean } }
      expect(note.receipt.isValid).toBe(true)
      expect(note.artifactPath.endsWith('idea-note-export-pdf.json')).toBe(true)
      const noteBody = JSON.parse(await readFile(note.artifactPath, 'utf8')) as { ideaId: string }
      expect(noteBody.ideaId).toBe('export-pdf')

      // 4. Chain coverage over the declared array: two rows (ideas), the note
      // stage covered 1/2, no orphans.
      const chain = defineDocChainStatusTool(deps as never)
      const status = await chain.execute({ plan: `${TOPIC}/output/board.json` } as never, exec) as {
        coverage: Record<string, { covered: number; total: number }>
        stages: string[]
        rows?: Array<{ funcId: string }>
        orphaned?: unknown[]
      }
      expect(status.stages).toContain('idea-note')
      expect(status.coverage['idea-note']).toEqual({ covered: 1, total: 2 })
      console.log("STATUS", JSON.stringify(status, null, 1))
      if (status.rows !== undefined) {
        expect(status.rows.map(r => r.funcId)).toEqual(['dark-mode', 'export-pdf'])
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
