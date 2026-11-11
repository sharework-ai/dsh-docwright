import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillsHostContext } from './authoring-skill.ts'

/**
 * Pack-INSTALL skill: the model face for the market install lane. The
 * authoring skill covers creating packs; this one covers getting them —
 * users say "帮我安装 cosmic-context 技能 / install the resume pack", which
 * without a skill reads as a filesystem-skill request. The body ships as a
 * bundled guide (guides/pack-install.md), read eagerly at apply time so a
 * broken package fails loud instead of silently losing the capability.
 */

export const INSTALL_SKILL_NAME = 'docwright-pack-install'

/**
 * Model-facing catalog line (host truncates past 500 chars after
 * whitespace normalization). Claims the install phrasings explicitly —
 * "安装/install a pack | 场景包 | 技能" — and names the confirmation gate so
 * the model never self-confirms.
 */
export const INSTALL_SKILL_DESCRIPTION =
  'Install docwright scenario packs (pack) from the pack market. When the user asks to install, add, fetch, or get a pack — '
  + '"帮我安装 cosmic-context", "install the resume pack", "从市场装个 pack" — call doc_market_search to find it by intent, '
  + 'then doc_market_install: the first call returns a pendingConfirmation table to present to the user, and only their '
  + 'approval (confirm: true) executes. The market follows the deployment\'s marketUrl; the pack (and its dependencies) is '
  + 'usable in this session immediately after install.'

export const INSTALL_SKILL_WHEN_TO_USE =
  'Use when the user asks to install, add, or fetch a docwright scenario pack (by name or by the document type they need) '
  + 'from the pack market, or asks which packs the market offers.'

/** Read the bundled install guide; fail loud with a fix hint when absent. */
export async function readInstallGuide(guidesRoot: string): Promise<string> {
  const path = join(guidesRoot, 'pack-install.md')
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`docwright: the pack-install guide is missing at ${path} (${(error as Error).message}); fix: reinstall the package so guides/ ships next to packs/`)
  }
}

/** Register the install skill on the host's skills registry (same optional
 * `ctx.inject(['skills'], ...)` pattern as the authoring skill). */
export function registerInstallSkill(skillsCtx: SkillsHostContext, guidesRoot: string, guide: string): void {
  const skills = skillsCtx.skills
  if (skills === undefined || typeof skills.register !== 'function') {
    throw new Error('docwright: the skills service resolved but ctx.skills.register is unavailable; fix: this dsh build does not match the expected dsh-skill surface')
  }
  skills.register({
    name: INSTALL_SKILL_NAME,
    description: INSTALL_SKILL_DESCRIPTION,
    whenToUse: INSTALL_SKILL_WHEN_TO_USE,
    source: 'bundled',
    content: guide,
    resourceBase: { kind: 'directory', path: guidesRoot },
  })
}
