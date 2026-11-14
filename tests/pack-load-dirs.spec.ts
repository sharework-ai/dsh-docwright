import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync, mkdir } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadPackSet, loadPacks, type PackRootSpec } from '../src/pack-loader.ts'
import { applyDisabled, overlayWorkspaceTier, resolvePacksDir, workspacePackRoots } from '../src/pack-sources.ts'
import type { Pack } from '../src/pack.ts'

let root: string

/** Minimal valid pack fixture: name/version only vary. */
function writePack(packsRoot: string, name: string, version = '0.1.0', consumes: string[] = []): void {
  const dir = join(packsRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    name, version,
    description: { en: `${name} fixture`, zh: `${name} 夹具` },
    languages: ['en-US'],
    consumes,
    params: {},
  }))
  writeFileSync(join(dir, 'schema.json'), JSON.stringify({ type: 'object' }))
  mkdirSync(join(dir, 'rules'), { recursive: true })
  writeFileSync(join(dir, 'rules', 'en-US.json'), '[]')
  mkdirSync(join(dir, 'prompts'), { recursive: true })
  writeFileSync(join(dir, 'prompts', 'en-US.md'), 'x {{materials}}')
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'templates', 'en-US.hbs'), 'x')
  mkdirSync(join(dir, 'samples'), { recursive: true })
  writeFileSync(join(dir, 'samples', 'golden.json'), JSON.stringify({}))
}

beforeEach(() => {
  root = join(tmpdir(), `pack-load-dirs-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const fixtureRoots = (dirs: readonly string[]): readonly PackRootSpec[] =>
  dirs.map(dir => ({ dir, origin: { kind: 'packsDir' as const, root: dir } }))

describe('P1 — symlink following', () => {
  it('loads a pack through a symlinked directory (source of truth stays in an authoring repo)', async () => {
    writePack(join(root, 'authoring', 'packs'), 'linked-pack')
    const packsRoot = join(root, 'install')
    mkdirSync(packsRoot, { recursive: true })
    symlinkSync(join(root, 'authoring', 'packs', 'linked-pack'), join(packsRoot, 'linked-pack'), 'dir')
    const packs = await loadPacks(packsRoot, {})
    expect(packs.has('linked-pack')).toBe(true)
    // The loaded dir is the REAL path: edits persist to the authoring checkout, not the link.
    expect(packs.get('linked-pack')!.dir.startsWith(resolve(join(root, 'authoring')))).toBe(true)
  })

  it('dedupes two links that resolve to the same target (loads once, no clash)', async () => {
    writePack(join(root, 'authoring', 'packs'), 'linked-pack')
    const packsRoot = join(root, 'install')
    mkdirSync(packsRoot, { recursive: true })
    symlinkSync(join(root, 'authoring', 'packs', 'linked-pack'), join(packsRoot, 'linked-pack'), 'dir')
    symlinkSync(join(root, 'authoring', 'packs', 'linked-pack'), join(packsRoot, 'alias'), 'dir')
    const packs = await loadPacks(packsRoot, {})
    expect([...packs.keys()].filter(n => n === 'linked-pack')).toHaveLength(1)
  })

  it('skips dangling symlinks quietly', async () => {
    const packsRoot = join(root, 'install')
    mkdirSync(packsRoot, { recursive: true })
    symlinkSync(join(root, 'nowhere'), join(packsRoot, 'dangling-pack'), 'dir')
    writePack(packsRoot, 'real-pack')
    const packs = await loadPacks(packsRoot, {})
    expect([...packs.keys()]).toEqual(['real-pack'])
  })
})

describe('P2 — tier order and defaults', () => {
  it('later roots shadow same-name packs and the loser lands in the shadow records', async () => {
    writePack(join(root, 'install'), 'dup-pack', '1.0.0')
    writePack(join(root, 'extra'), 'dup-pack', '2.0.0')
    const { packs, shadowed } = await loadPackSet(root, { includeBuiltin: false, roots: fixtureRoots([join(root, 'install'), join(root, 'extra')]) })
    expect(packs.get('dup-pack')!.manifest.version).toBe('2.0.0')
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]!.version).toBe('1.0.0')
    expect(shadowed[0]!.activeVersion).toBe('2.0.0')
  })

  it('shadowPolicy "error" fails loud on cross-root same-name packs', async () => {
    writePack(join(root, 'install'), 'dup-pack', '1.0.0')
    writePack(join(root, 'extra'), 'dup-pack', '2.0.0')
    await expect(loadPackSet(root, { includeBuiltin: false, roots: fixtureRoots([join(root, 'install'), join(root, 'extra')]), shadowPolicy: 'error' }))
      .rejects.toThrow(/declared twice across load roots/)
  })

  it('resolves the install dir default to $DSH_HOME/docwright/packs and honors an override', () => {
    const prev = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = join(root, 'dsh-home')
      expect(resolvePacksDir(undefined)).toBe(join(root, 'dsh-home', 'docwright', 'packs'))
      expect(resolvePacksDir('/custom/packs')).toBe('/custom/packs')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })

  it('workspace tier: inner-first roots, upward search walks ancestors, no upward = one tier', () => {
    const ws = join(root, 'repo', 'sub', 'work')
    mkdirSync(ws, { recursive: true })
    const withoutUp = workspacePackRoots(ws, false)
    expect(withoutUp).toHaveLength(1)
    expect(withoutUp[0]!.dir).toBe(join(ws, '.docwright', 'packs'))
    expect(withoutUp[0]!.origin.depth).toBe(0)
    const withUp = workspacePackRoots(ws, true)
    expect(withUp[0]!.dir).toBe(join(ws, '.docwright', 'packs'))
    expect(withUp.map(r => r.origin.depth)).toEqual([0, 1, 2, 3, ...Array.from({ length: withUp.length - 4 }, (_, i) => i + 4)])
    // The walk terminates at the filesystem root, never loops.
    expect(withUp.length).toBeLessThan(64)
  })

  it('overlays the workspace tier over the base map: workspace wins and the base copy is shadowed', async () => {
    writePack(join(root, 'base'), 'same-pack', '1.0.0')
    writePack(join(root, 'ws', '.docwright', 'packs'), 'same-pack', '9.9.9')
    const base = await loadPacks(join(root, 'base'), {})
    const { packs, shadowed } = await overlayWorkspaceTier(base, join(root, 'ws'), false, 'allow')
    expect(packs.get('same-pack')!.manifest.version).toBe('9.9.9')
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]!.origin.kind).toBe('builtin') // base map loaded via loadPacks(builtinRoot=base) stamps builtin origin
    expect(shadowed[0]!.activeOrigin.kind).toBe('workspace')
  })
})

describe('启用与禁用 — disabledPacks', () => {
  it('drops disabled packs and expands suite names through the member resolver', () => {
    writePack(join(root, 'p'), 'alpha')
    writePack(join(root, 'p'), 'beta', '0.1.0', ['alpha'])
    const packs = new Map(Object.entries({
      alpha: { manifest: { name: 'alpha', consumes: [] } } as unknown as Pack,
      beta: { manifest: { name: 'beta', consumes: [] } } as unknown as Pack,
      gamma: { manifest: { name: 'gamma', consumes: [] } } as unknown as Pack,
    }))
    const suites = new Map([['my-suite', ['alpha', 'gamma']]])
    const out = applyDisabled(packs, ['my-suite'], name => suites.get(name))
    expect([...out.keys()]).toEqual(['beta'])
  })

  it('fails loud when an enabled pack consumes a disabled pack', () => {
    const packs = new Map<string, Pack>(Object.entries({
      alpha: { manifest: { name: 'alpha', consumes: [] } } as unknown as Pack,
      beta: { manifest: { name: 'beta', consumes: ['alpha'] } } as unknown as Pack,
    }))
    expect(() => applyDisabled(packs, ['alpha'], () => undefined)).toThrow(/consumes "alpha", which is disabled/)
  })

  it('tolerates empty and stale disabled entries', () => {
    const packs = new Map<string, Pack>([['alpha', { manifest: { name: 'alpha', consumes: [] } } as unknown as Pack]])
    expect([...applyDisabled(packs, [], () => undefined).keys()]).toEqual(['alpha'])
    expect([...applyDisabled(packs, ['ghost-pack'], () => undefined).keys()]).toEqual(['alpha'])
  })
})
