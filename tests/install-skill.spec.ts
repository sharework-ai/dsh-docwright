import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INSTALL_SKILL_NAME, readInstallGuide, registerInstallSkill, type SkillRegistrarLike } from '../src/install-skill.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const guidesRoot = join(repoRoot, 'guides')

interface CapturedSkill {
  name: string
  description: string
  whenToUse: string
  source: string
  content: string
  resourceBase: { kind: string; path: string }
}

function capture(): { skills: CapturedSkill[]; registrar: SkillRegistrarLike } {
  const skills: CapturedSkill[] = []
  return {
    skills,
    registrar: {
      register(skill) {
        skills.push(skill as CapturedSkill)
        return {}
      },
    },
  }
}

describe('pack-install skill', () => {
  it('reads the bundled guide', async () => {
    const guide = await readInstallGuide(guidesRoot)
    expect(guide).toContain('doc_market_install')
    expect(guide).toContain('pendingConfirmation')
    expect(guide).toContain('confirm: true')
    expect(guide).toContain('marketUrl')
    expect(guide).toContain('usable in THIS session immediately')
    expect(guide).toMatch(/Step 1 — check what is already installed[\s\S]*doc_packs/)
    // The suite lane (docs/designs/pack-suites.md): search cards route to a
    // suite install; single-pack installs mention their suite; the installed
    // check covers top-up installs of partially installed suites.
    expect(guide).toContain('"suite"')
    expect(guide).toMatch(/Suite branch/)
    expect(guide).toMatch(/top-up install/)
  })

  it('fails loud when the guide file is absent', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'docwright-no-guides-'))
    await expect(readInstallGuide(empty)).rejects.toThrow(/pack-install guide is missing/)
  })

  it('registers a bundled, model-facing skill', async () => {
    const guide = await readInstallGuide(guidesRoot)
    const { skills, registrar } = capture()
    registerInstallSkill({ skills: registrar }, guidesRoot, guide)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: INSTALL_SKILL_NAME, source: 'bundled', resourceBase: { kind: 'directory', path: guidesRoot } })
    expect(skills[0].description).toContain('doc_market_install')
    expect(skills[0].description).toContain('suite')
    expect(skills[0].whenToUse).toContain('install')
    expect(skills[0].whenToUse).toContain('install the X suite')
  })

  it('fails loud when the host skills service is unusable', () => {
    expect(() => registerInstallSkill({}, guidesRoot, 'x')).toThrow(/skills.register is unavailable/)
  })
})
