import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AUTHORING_SKILL_NAME, readAuthoringGuide, registerAuthoringSkill, type SkillRegistrarLike } from '../src/authoring-skill.ts'
import { registerTools } from '../src/index.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { defineDocPacksTool } from '../src/tools.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packsRoot = join(repoRoot, 'packs')
const guidesRoot = join(repoRoot, 'guides')

interface CapturedSkill {
  name: string
  description: string
  whenToUse: string
  source: string
  content: string
  resourceBase: { kind: string; path: string }
}

function captureRegistrar(captured: CapturedSkill[]): SkillRegistrarLike {
  return {
    register(skill: unknown) {
      captured.push(skill as CapturedSkill)
      return () => {}
    },
  }
}

describe('pack-authoring skill (docs/designs/pack-authoring.md)', () => {
  it('ships a self-contained bundled guide', async () => {
    const guide = await readAuthoringGuide(guidesRoot)
    expect(guide).toContain('# Authoring docwright packs')
    expect(guide).toContain('pack:check')
    expect(guide).toContain('{{materials}}')
    // Self-containment: the installed plugin has no repo-side docs to lean on.
    expect(guide).not.toMatch(/docs\/designs|AGENTS\.md/)
  })

  it('fails loud when the guide file is missing', async () => {
    await expect(readAuthoringGuide(join(await mkdtemp(join(tmpdir(), 'docwright-no-guides-')), 'absent'))).rejects.toThrow(/guide is missing/)
  })

  it('registers name, description, when-to-use, body, and resource base', async () => {
    const captured: CapturedSkill[] = []
    const guide = await readAuthoringGuide(guidesRoot)
    registerAuthoringSkill({ skills: captureRegistrar(captured) }, guidesRoot, guide)
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      name: AUTHORING_SKILL_NAME,
      whenToUse: expect.stringContaining('no installed pack'),
      // The host's skill tool validates `source` at LOAD time (validateDefinition)
      // even though register() skips it — a missing source only exploded when the
      // model first loaded the skill (real-session finding, 2026-10-30).
      source: 'bundled',
      resourceBase: { kind: 'directory', path: guidesRoot },
    })
    // Catalog routing: the description claims the "make a skill" phrasing
    // generically (English only; no specific document type) and stays under
    // the host's 500-char catalog truncation so every routing word survives.
    expect(captured[0]!.description).toContain('Author document-generation skills as docwright packs')
    expect(captured[0]!.description).toContain('not a filesystem SKILL.md')
    expect(captured[0]!.description).not.toContain('resume')
    expect(captured[0]!.description).not.toMatch(/[一-鿿]/)
    expect(captured[0]!.description.replace(/\s+/g, ' ').length).toBeLessThanOrEqual(500)
    expect(captured[0]!.content).toBe(guide)
  })

  it('fails loud on a malformed skills surface', async () => {
    const guide = await readAuthoringGuide(guidesRoot)
    expect(() => registerAuthoringSkill({}, guidesRoot, guide)).toThrow(/ctx\.skills\.register is unavailable/)
    expect(() => registerAuthoringSkill({ skills: {} as never }, guidesRoot, guide)).toThrow(/ctx\.skills\.register is unavailable/)
  })

  it('invites the authoring skill from the doc_packs description', async () => {
    const deps = {
      packs: await loadPacks(packsRoot, {}),
      config: { provider: 'p', model: 'm' },
      ctx: {},
    }
    const tool = defineDocPacksTool(deps as never)
    expect(tool.description).toContain('docwright-pack-authoring')
  })

  it('apply wires the skill through the optional skills inject', async () => {
    const captured: CapturedSkill[] = []
    const ctx = {
      tools: { register: () => {} },
      inject: (services: readonly string[], callback: (skillsCtx: unknown) => void) => {
        // registerTools also injects the optional webServer (params UI) — only the skills inject resolves a registrar here.
        if (services.includes('skills')) callback({ skills: captureRegistrar(captured) })
      },
    }
    await registerTools(ctx as never, { provider: 'p', model: 'm' } as never, packsRoot, guidesRoot)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.name).toBe(AUTHORING_SKILL_NAME)
  })

  it('apply fails loud when the guides root does not carry the guide', async () => {
    const ctx = { tools: { register: () => {} }, inject: () => {} }
    const absent = join(await mkdtemp(join(tmpdir(), 'docwright-no-guides-')), 'absent')
    await expect(registerTools(ctx as never, { provider: 'p', model: 'm' } as never, packsRoot, absent)).rejects.toThrow(/guide is missing/)
  })
})
