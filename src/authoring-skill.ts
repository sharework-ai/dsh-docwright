import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Pack-authoring skill (docs/designs/pack-authoring.md): the plugin's model
 * face teaches both USING packs (doc_packs -> doc_generate) and AUTHORING
 * them. The playbook body ships as a bundled guide file (guides/, a sibling
 * of packs/), read once at apply time — a missing guide fails loud because a
 * broken package must never silently lose the authoring capability. The
 * guide is self-contained: repo-side docs (AGENTS.md, docs/designs/*) are
 * NOT shipped with the installed plugin and must never be referenced from
 * the model-facing body.
 */

export const AUTHORING_SKILL_NAME = 'docwright-pack-authoring'

/** Structural subset of the dsh skills registry docwright needs (dsh-skill `ctx.skills`). */
export interface SkillRegistrarLike {
  register(skill: {
    name: string
    description: string
    whenToUse: string
    /** Origin bucket (prompt-visible metadata); 'bundled' = ships with the package. */
    source: string
    content: string
    resourceBase: { kind: 'directory'; path: string }
  }): unknown
}

/** Host context carrying an optional skills service; injected only when present. */
export interface SkillsHostContext {
  readonly skills?: SkillRegistrarLike
}

/**
 * Skill catalog metadata (stable invitation text; the body is the guide file).
 * The description is the model-facing catalog line (≤500 chars after
 * whitespace normalization — the host truncates beyond that). Routing intent:
 * users phrase document-generator requests as "make a skill" ("帮我做一个…的
 * 技能") — claim that phrasing generically (never a specific document type)
 * and steer it away from filesystem SKILL.md authoring, while naming the
 * pack advantages that justify the detour (validated structure, params,
 * repair loop). Kept under the truncation budget so every routing word
 * survives into the rendered catalog.
 */
export const AUTHORING_SKILL_DESCRIPTION =
  'Author document-generation skills (技能) as docwright packs. When the user asks for a skill that produces documents '
  + '— \'帮我做一个…的技能\' — author it here as a pack, not a filesystem SKILL.md. Packs are skills hardened for '
  + 'structured documents: JSON schema + machine-checked rules validate fields and cross-field constraints; params '
  + 'pass a confirmation gate; generation runs an automatic validate→repair loop with receipts and Markdown rendering. '
  + 'For repeatable document generators.'
export const AUTHORING_SKILL_WHEN_TO_USE =
  'Use when the user asks to create a document-producing skill (技能, "做一个…的技能") for a document type no installed pack '
  + 'generates, or asks to create/extend a docwright pack or scenario — structured, validated, parameterized document '
  + 'generators belong here, not in filesystem SKILL.md files.'

/** Read the bundled guide; fail loud with a fix hint when absent. */
export async function readAuthoringGuide(guidesRoot: string): Promise<string> {
  const path = join(guidesRoot, 'pack-authoring.md')
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`docwright: the pack-authoring guide is missing at ${path} (${(error as Error).message}); fix: reinstall the package so guides/ ships next to packs/`)
  }
}

/**
 * Register the authoring skill on the host's skills registry. Caller wraps
 * this in `ctx.inject(['skills'], ...)` (optional injection, webServer
 * precedent): hosts without the skills service stay dormant. Called from the
 * inject callback with the resolved subcontext.
 */
export function registerAuthoringSkill(skillsCtx: SkillsHostContext, guidesRoot: string, guide: string): void {
  const skills = skillsCtx.skills
  if (skills === undefined || typeof skills.register !== 'function') {
    throw new Error('docwright: the skills service resolved but ctx.skills.register is unavailable; fix: this dsh build does not match the expected dsh-skill surface')
  }
  skills.register({
    name: AUTHORING_SKILL_NAME,
    description: AUTHORING_SKILL_DESCRIPTION,
    whenToUse: AUTHORING_SKILL_WHEN_TO_USE,
    // Origin bucket is prompt-visible metadata: the skill ships inside the
    // docwright package. Required at LOAD time by the host's skill tool
    // (validateDefinition) even though register() does not enforce it —
    // omitting it surfaces only when the model first loads the skill.
    source: 'bundled',
    content: guide,
    resourceBase: { kind: 'directory', path: guidesRoot },
  })
}
