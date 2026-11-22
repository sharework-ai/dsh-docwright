#!/usr/bin/env node
// Build stamp (issue #3): record which git commit produced the runtime bundle,
// so a running session can report its build and a stale dist/ is diagnosable
// without error-text forensics. Writes build-info.json next to both build
// outputs (lib/ and dist/); the runtime reads it relative to its own module URL.
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
let gitSha = 'unknown'
try {
  gitSha = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim()
} catch {
  // not a git checkout (e.g. packed tarball) — stamp with unknown sha
}
const stamp = { gitSha, builtAt: new Date().toISOString() }
for (const dir of ['lib', 'dist']) {
  writeFileSync(join(repoRoot, dir, 'build-info.json'), JSON.stringify(stamp, null, 2) + '\n', 'utf8')
}
console.log(`build stamp: ${stamp.gitSha} at ${stamp.builtAt}`)
