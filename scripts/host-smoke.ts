/**
 * Host smoke: pre-release check that the packed plugin loads in a REAL dsh host.
 *
 * Flow: pack the plugin tarball → sandbox a throwaway DSH_HOME with a fresh
 * headless profile → `dsh plugin add` the tarball → write the minimal boot
 * patch (model routing rows, per docs/testing/e2e-real-llm.md) → boot the
 * profile in-process via the dsh launcher's `runProfile` → assert the three
 * docwright tools registered → dispose. No API key, no model call.
 *
 * Prerequisites: the sibling dsh checkout is installed and `build:lib:host`-built
 * (see README Development). The sandbox is deleted on success; pass `--keep` to
 * inspect it (path printed either way).
 *
 * Usage: node --import tsx/esm scripts/host-smoke.ts [--keep]
 * Env:   DOCWRIGHT_DSH_REPO — dsh checkout path (default ../deepseek-harness)
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROFILE = 'docwright-smoke'
const EXPECTED_TOOLS = ['doc_generate', 'doc_validate', 'doc_packs', 'doc_chain_status']
const AUTHORING_SKILL = 'docwright-pack-authoring'
const INSTALL_SKILL = 'docwright-pack-install'

/** Minimal structural view of the booted host surface the smoke needs. */
interface SmokeHost {
  tools: { schemas(): readonly { name: string }[] }
  fiber: { dispose(): Promise<void> }
  skills?: { list(): Promise<Array<{ name: string; invocation?: { modelInvocable?: boolean } }>> }
}

function fail(message: string): never {
  console.error(`host-smoke: FAIL: ${message}`)
  process.exit(1)
}

const repoRoot = resolve(import.meta.dirname, '..')
const dshRepo = resolve(repoRoot, process.env['DOCWRIGHT_DSH_REPO'] ?? '../deepseek-harness')
const keep = process.argv.includes('--keep')

// The dsh checkout runs its own sources through tsx with tsconfig.base.json
// `paths` mapping @deepseek-ai/* onto vendored TS sources (its committed lib/
// outputs can lag the source). Under a foreign cwd those mappings are absent
// and stale lib builds surface (e.g. cordis FiberState). Respawn once with
// TSX_TSCONFIG_PATH pointed at the dsh checkout so resolution matches
// `pnpm dsh` exactly.
if (process.env['DOCWRIGHT_SMOKE_RESPAWNED'] !== '1') {
  const { status } = spawnSync(process.execPath, ['--import', 'tsx/esm', import.meta.filename, ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DOCWRIGHT_SMOKE_RESPAWNED: '1',
      TSX_TSCONFIG_PATH: join(dshRepo, 'tsconfig.base.json'),
    },
    stdio: 'inherit',
  })
  process.exit(status ?? 1)
}

const root = mkdtempSync(join(tmpdir(), 'docwright-host-smoke-'))
const home = join(root, 'home')
console.log(`host-smoke: sandbox ${root}`)

// 1. Pack the plugin tarball from the working tree.
execFileSync('corepack', ['pnpm', 'pack', '--pack-destination', root], { cwd: repoRoot, stdio: 'pipe' })
const tarball = readdirSync(root).find(file => file.endsWith('.tgz'))
if (tarball === undefined) fail(`pnpm pack produced no tarball under ${root}`)
console.log(`host-smoke: packed ${tarball}`)

// 2. Install into a fresh profile in the sandbox home. `plugin add`
//    initializes a base-backed profile and appends the plugin — exactly the
//    composition the smoke needs (registry boot; no one-shot runner, no model
//    call). Note `--profile` goes AFTER the `plugin` subcommand (before it,
//    the invocation routes to profile boot).
const env = {
  ...process.env,
  DSH_HOME: home,
  DOCWRIGHT_SMOKE_DUMMY_KEY: 'smoke-dummy-key',
}
const profileDir = join(home, 'profiles', PROFILE)
try {
  execFileSync('corepack', ['pnpm', '--pm-on-fail=ignore', '--dir', dshRepo, 'dsh',
    'plugin', '--profile', PROFILE, 'add', join(root, tarball!)], { env, stdio: 'pipe' })
} catch (error) {
  fail(`dsh plugin add failed: ${(error as Error).message}`)
}
console.log(`host-smoke: installed into profile ${PROFILE}`)

// 3. Boot patch: model routing only (registration needs no LLM; the rows mirror
//    the proven e2e shape so the base bundle's default-model row routes too).
writeFileSync(join(home, 'profiles', PROFILE, 'cordis.patch.yml'), `
- id: llm-pi-ai
  config:
    providers:
      zai-coding-cn:
        apiKeyEnv: DOCWRIGHT_SMOKE_DUMMY_KEY
- id: agent-default-model
  config:
    provider: zai-coding-cn
    model: glm-4.7
`)

// 4. Boot the profile in-process via the launcher's own entry points. The
//    boot path resolves DSH_HOME from THIS process's environment.
process.env['DSH_HOME'] = home
const { runProfile } = await import(pathToFileURL(join(dshRepo, 'apps/cli/src/profile-boot.ts')).href)
const { loadLayeredEnv } = await import(pathToFileURL(join(dshRepo, 'packages/boot/app-boot/src/index.ts')).href)

let host: SmokeHost
let dispose: () => Promise<void>
try {
  const booted = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: PROFILE,
    patchFiles: [],
    args: [],
  })
  host = booted.ctx as unknown as SmokeHost
  dispose = () => booted.shutdown.shutdown(0)
} catch (error) {
  fail(`profile boot failed: ${(error as Error).message}`)
}

// 5. Assert the docwright tools registered in the live host, then the
//    pack-authoring skill (docs/designs/pack-authoring.md), then dispose.
const registered = new Set(host.tools.schemas().map(schema => schema.name))
const missing = EXPECTED_TOOLS.filter(name => !registered.has(name))
if (missing.length > 0) {
  await dispose().catch(error => console.error(`host-smoke: dispose warning: ${(error as Error).message}`))
  fail(`tools missing after boot: ${missing.join(', ')} (registered: ${[...registered].sort().join(', ')})`)
}
console.log(`host-smoke: tools registered — ${EXPECTED_TOOLS.join(', ')}`)
if (host.skills?.list === undefined) {
  await dispose().catch(error => console.error(`host-smoke: dispose warning: ${(error as Error).message}`))
  fail('the booted host exposes no skills service; the pack-authoring skill cannot be verified')
}
const skills = await host.skills.list()
for (const name of [AUTHORING_SKILL, INSTALL_SKILL]) {
  const skill = skills.find(entry => entry.name === name)
  if (skill === undefined) {
    await dispose().catch(error => console.error(`host-smoke: dispose warning: ${(error as Error).message}`))
    fail(`skill ${name} missing after boot (skills: ${skills.map(entry => entry.name).sort().join(', ')})`)
  }
  if (skill.invocation?.modelInvocable !== true) {
    await dispose().catch(error => console.error(`host-smoke: dispose warning: ${(error as Error).message}`))
    fail(`skill ${name} is not model-invocable`)
  }
}
await dispose().catch(error => console.error(`host-smoke: dispose warning: ${(error as Error).message}`))
console.log(`host-smoke: PASS — ${EXPECTED_TOOLS.join(", ")} + skills ${AUTHORING_SKILL} and ${INSTALL_SKILL} registered in a live ${PROFILE} host`)

if (!keep) rmSync(root, { recursive: true, force: true })
