import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkPacks, renderPackCheckReport, type PackCheckEntry } from '../src/pack-check.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))

/** Minimal file set for one loadable pack; tests overlay extras (functions.js, golden.params.json). */
function packFiles(options: { name: string; rules: string; golden: string; schema?: string; manifestExtras?: string }): Record<string, string> {
  const name = options.name
  return {
    'manifest.json': `{
  "name": "${name}",
  "version": "0.1.0",
  "description": "demo pack for pack:check",
  "languages": ["zh-CN"],
  ${options.manifestExtras ?? ''}
  "requiresTopic": false
}`,
    'schema.json': options.schema ?? `{
  "type": "object",
  "required": ["title"],
  "properties": { "title": { "type": "string" } }
}`,
    'rules/zh-CN.json': options.rules,
    'prompts/zh-CN.md': `# ${name}\n\n生成演示文档。\n\n## 输入素材\n\n{{materials}}\n`,
    'templates/zh-CN.hbs': 'Title: {{title}}\n',
    'samples/golden.json': options.golden,
  }
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
}

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'docwright-pack-check-'))
}

const MIN_LENGTH_RULES = JSON.stringify([
  { id: 'demo/title-min-length', severity: 'error', given: '$', field: 'title', kind: 'minLength', min: 10, suggestion: 'make the title at least 10 characters' },
])

const PARAM_RULES = JSON.stringify([
  { id: 'demo/title-pattern', severity: 'error', given: '$', field: 'title', kind: 'pattern', pattern: { param: 'namePattern' }, mustMatch: true, suggestion: 'match the configured name pattern' },
])

const RICH_MANIFEST_EXTRAS = `"params": {
    "threshold": { "type": "number", "default": 5, "min": 1, "max": 10, "confirm": true, "extractable": true, "description": "demo threshold" },
    "namePattern": { "type": "string", "required": true, "description": "pattern the title must match" },
    "softFlag": { "type": "boolean", "default": true, "overridable": true, "confirm": true, "description": "demo flag" }
  },`

const FUNCTIONS_JS = `export const rules = [
  {
    id: 'demo/summary-word',
    severity: 'warning',
    suggestion: 'include the word demo in the summary',
    check(artifact) {
      const text = typeof artifact === 'object' && artifact !== null && typeof artifact.summary === 'string' ? artifact.summary : ''
      return text.includes('demo') ? [] : [{ jsonPath: '$.summary', message: 'summary lacks the word demo' }]
    },
  },
]

export function score(artifact, issues) {
  return Math.max(0, 100 - issues.length * 10)
}
`

describe('pack:check (authoring verification ladder, layers 1-2)', () => {
  it('reports every built-in pack green with a health sheet', async () => {
    const report = await checkPacks(packsRoot)
    expect(report.green).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.packs).toHaveLength(6)
    for (const entry of report.packs) {
      for (const language of entry.languages) expect(language.errors).toBe(0)
    }
    const plan = report.packs.find(entry => entry.pack === 'cosmic-plan') as PackCheckEntry
    expect(plan.version).toBe('0.7.1')
    expect(plan.scope).toBe('topic')
    expect(plan.consumes).toEqual(['cosmic-context'])
    expect(plan.declarativeRules).toBeGreaterThan(0)
    expect(plan.functionRules).toBeGreaterThan(0)
    expect(plan.customScore).toBe(false)
    const cfpTotal = plan.params.find(param => param.name === 'cfpTotal')
    expect(cfpTotal).toMatchObject({ type: 'object', required: true, hasDefault: false, confirm: true, extractable: true })
    const rendered = renderPackCheckReport(report)
    expect(rendered).toContain('cosmic-plan@0.7.1')
    expect(rendered).toContain('score=builtin-default')
    expect(rendered).toMatch(/pack:check: PASS — 6 pack\(s\) green/)
  })

  it('fails loud on an empty root (a typoed directory must not pass vacuously)', async () => {
    await expect(checkPacks(await makeRoot())).rejects.toThrow(/no packs found under/)
  })

  it('fails loud through the loader gate on a non-compilable regex', async () => {
    const root = await makeRoot()
    try {
      await writeTree(join(root, 'demo-bad'), packFiles({
        name: 'demo-bad',
        rules: JSON.stringify([
          { id: 'demo/broken', severity: 'error', given: '$', field: 'title', kind: 'pattern', pattern: '([bad', mustMatch: true, suggestion: 'x' },
        ]),
        golden: JSON.stringify({ title: 'a long enough title' }),
      }))
      await expect(checkPacks(root)).rejects.toThrow(/does not compile/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('separates golden failures from greens and renders the sheet', async () => {
    const root = await makeRoot()
    try {
      await writeTree(join(root, 'demo-a'), packFiles({ name: 'demo-a', rules: MIN_LENGTH_RULES, golden: JSON.stringify({ title: 'a long enough title' }) }))
      await writeTree(join(root, 'demo-b'), packFiles({ name: 'demo-b', rules: MIN_LENGTH_RULES, golden: JSON.stringify({ title: 'short' }) }))
      await writeTree(join(root, 'demo-c'), {
        ...packFiles({
          name: 'demo-c',
          rules: PARAM_RULES,
          golden: JSON.stringify({ title: 'demo-acceptable-title', summary: 'demo summary words' }),
          schema: `{
  "type": "object",
  "required": ["title"],
  "properties": { "title": { "type": "string" }, "summary": { "type": "string" } }
}`,
          manifestExtras: RICH_MANIFEST_EXTRAS,
        }),
        'rules/functions.js': FUNCTIONS_JS,
        'samples/golden.params.json': JSON.stringify({ namePattern: '^demo-' }),
      })
      const report = await checkPacks(root, { extraRoots: [packsRoot] })
      expect(report.green).toBe(false)
      expect(report.failures).toHaveLength(1)
      expect(report.failures[0]).toContain('demo-b/zh-CN: [demo/title-min-length]')
      expect(report.failures[0]!).toContain('length 5 < min 10')
      expect(report.failures[0]!).toContain('fix: make the title at least 10 characters')
      const c = report.packs.find(entry => entry.pack === 'demo-c')
      expect(c).toMatchObject({ customScore: true, declarativeRules: 1, functionRules: 1 })
      expect(c?.languages[0]).toMatchObject({ errors: 0 })
      const rendered = renderPackCheckReport(report)
      expect(rendered).toContain('score=custom')
      expect(rendered).toContain('param threshold: number (confirm,extractable)')
      expect(rendered).toContain('param namePattern: string (required) (no default)')
      expect(rendered).toContain('param softFlag: boolean (confirm,overridable)')
      expect(rendered).toContain('demo-b@0.1.0')
      expect(rendered).toContain('golden RED — 1 error(s), 0 warning(s), 0 info(s)')
      expect(rendered).toContain('demo-a@0.1.0')
      expect(rendered).toContain('golden GREEN')
      expect(rendered).toContain('FAIL demo-b/zh-CN: [demo/title-min-length]')
      expect(rendered).toContain('pack:check: FAIL — 1 failure(s)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports consumed upstreams absent from the checked roots with an actionable fix', async () => {
    const root = await makeRoot()
    try {
      await writeTree(join(root, 'demo-chain'), packFiles({
        name: 'demo-chain',
        rules: MIN_LENGTH_RULES,
        golden: JSON.stringify({ title: 'a long enough title' }),
        manifestExtras: '"consumes": ["demo-missing"],',
      }))
      const report = await checkPacks(root)
      expect(report.green).toBe(false)
      expect(report.failures[0]).toContain('consumed upstream pack(s) absent from the checked roots: demo-missing')
      expect(report.failures[0]).toContain('--with <root>')
      expect(report.packs[0]!.languages).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails loud when golden.params.json is not readable', async () => {
    const root = await makeRoot()
    try {
      await writeTree(join(root, 'demo-c'), packFiles({ name: 'demo-c', rules: MIN_LENGTH_RULES, golden: JSON.stringify({ title: 'a long enough title' }) }))
      await mkdir(join(root, 'demo-c', 'samples', 'golden.params.json'))
      await expect(checkPacks(root)).rejects.toThrow(/golden\.params\.json is not readable/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('golden.params.json supplies required-no-default params; its absence crashes loudly; broken shapes fail loud', async () => {
    const root = await makeRoot()
    try {
      const files = {
        ...packFiles({
          name: 'demo-c',
          rules: PARAM_RULES,
          golden: JSON.stringify({ title: 'demo-acceptable-title', summary: 'demo summary words' }),
          manifestExtras: RICH_MANIFEST_EXTRAS,
        }),
        'samples/golden.params.json': JSON.stringify({ namePattern: '^demo-' }),
      }
      await writeTree(join(root, 'demo-c'), files)

      // Without the params file the pattern reference cannot resolve: a loud crash, not a silent pass.
      await rm(join(root, 'demo-c', 'samples', 'golden.params.json'))
      const absent = await checkPacks(root)
      expect(absent.green).toBe(false)
      expect(absent.failures[0]).toContain('golden validation crashed')
      expect(absent.failures[0]).toContain('missing required pack param "namePattern"')

      // Broken JSON and non-object shapes fail loud with a fix hint.
      const paramsPath = join(root, 'demo-c', 'samples', 'golden.params.json')
      await writeFile(paramsPath, '{broken', 'utf8')
      await expect(checkPacks(root)).rejects.toThrow(/golden\.params\.json is not valid JSON/)
      await writeFile(paramsPath, '["namePattern"]', 'utf8')
      await expect(checkPacks(root)).rejects.toThrow(/golden\.params\.json must be a JSON object/)

      // Restored: the golden run resolves the required param and is green.
      await writeFile(paramsPath, JSON.stringify({ namePattern: '^demo-' }), 'utf8')
      const report = await checkPacks(root)
      expect(report.green).toBe(true)
      expect(report.packs[0]!.languages[0]).toMatchObject({ errors: 0, warnings: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
