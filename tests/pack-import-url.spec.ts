import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const loaderPath = fileURLToPath(new URL('../src/pack-loader.ts', import.meta.url))

/**
 * Regression for the Windows activation failure: `import('<drive>\\...')` is
 * parsed with `C:` as a URL protocol, so pack `rules/functions.js` must be
 * imported through `pathToFileURL`. A path holding `#` or `%` breaks raw-path
 * imports on every platform (`#...` becomes a URL fragment, `%41` decodes to
 * `A`), which lets the case run on Linux too.
 *
 * The load runs in a child `node --import tsx/esm` process because vitest
 * intercepts dynamic imports and does not reproduce Node's URL semantics —
 * under vitest the raw path and the file URL both resolve, so only a real
 * ESM loader can discriminate the regression.
 */
async function writePackUnderUrlSensitiveRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'docwright-url-import-'))
  const root = join(base, 'dir#frag pct%41')
  await mkdir(root, { recursive: true })
  const dir = join(root, 'p4')
  for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'p4', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
  await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
  await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
  await writeFile(join(dir, 'rules', 'functions.js'), "export const rules = [{ id: 'r1', suggestion: 's', check: () => [] }]", 'utf8')
  await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
  await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
  await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
  return root
}

// No top-level await: tmpdir has no package.json, so tsx treats this file as CJS.
const probeSource = `
import { loadPacks } from ${JSON.stringify(loaderPath)}
async function main() {
  const packs = await loadPacks(process.argv[2], {})
  const pack = packs.get('p4')
  if (pack === undefined) throw new Error('p4 not loaded')
  console.log('LOADED', pack.functionRules.map(r => r.id).join(','))
}
void main()
`

describe('pack loader: functions.js import survives URL-sensitive paths', () => {
  it('loads a pack whose dir path holds spaces, #, and % (Windows drive-letter class)', async () => {
    const root = await writePackUnderUrlSensitiveRoot()
    const probePath = join(root, 'probe.ts')
    await writeFile(probePath, probeSource, 'utf8')
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx/esm', probePath, root], { cwd: repoRoot, timeout: 30_000 })
    expect(stdout).toContain('LOADED r1')
  })
})
