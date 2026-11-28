import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findOwnEntry, setPackParamDefault, updateConfigViaEditor } from '../src/params-writes.ts'
import type { ConfigEditorLike, ConfigEntryLike } from '../src/params-writes.ts'
import { loadPacks } from '../src/pack-loader.ts'

const B70 = { value: 70, downFactor: 0.9, upFactor: 1.2 }

/** A minimal pack with one editable (defaulted) param and one required param. */
async function packFixture(root: string, defaults: Record<string, unknown> = { limit: 3 }): Promise<void> {
  const dir = join(root, 'wp')
  for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(dir, sub), { recursive: true })
  const params: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(defaults)) {
    params[name] = { type: 'number', default: value, min: 1, max: 20, description: 'd' }
  }
  params.shares = { type: 'object', required: true, confirm: true, description: 'no default here' }
  params.namePattern = { type: 'string', default: '^.+$', description: 'name shape regex' }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    name: 'wp', version: '1', description: 'd', consumes: [], languages: ['zh-CN'], params,
  }), 'utf8')
  await writeFile(join(dir, 'rules', 'zh-CN.json'), JSON.stringify([
    { id: 'wp/name-shape', severity: 'error', given: '$', field: 'name', kind: 'pattern', pattern: { param: 'namePattern' }, mustMatch: true, suggestion: 's' },
  ]), 'utf8')
  await writeFile(join(dir, 'schema.json'), '{"type":"object"}', 'utf8')
  await writeFile(join(dir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
  await writeFile(join(dir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
  await writeFile(join(dir, 'samples', 'golden.json'), '{}', 'utf8')
}

async function writeDeps() {
  const root = await mkdtemp(join(tmpdir(), 'docwright-writes-'))
  await packFixture(root)
  const packs = new Map(await loadPacks(root, {}))
  return {
    root,
    packs,
    deps: { packs, builtinRoot: root, loadPacks: (r: string, d: { extra?: readonly string[] | undefined }) => loadPacks(r, d) },
  }
}

describe('findOwnEntry', () => {
  it('locates docwright by exact package name and suffix', () => {
    const a: ConfigEntryLike = { options: { id: 'docwright', name: '@sharework-ai/dsh-docwright' } }
    expect(findOwnEntry([a])).toBe(a)
    const b: ConfigEntryLike = { options: { id: 'dw', name: 'x/dsh-docwright' } }
    expect(findOwnEntry([b])).toBe(b)
  })

  it('fails loud when no entry serves docwright', () => {
    expect(() => findOwnEntry([{ options: { name: 'other' } }])).toThrow(/no profile entry for docwright/)
    expect(() => findOwnEntry([])).toThrow(/no profile entry for docwright/)
    expect(() => findOwnEntry([{}])).toThrow(/no profile entry for docwright/)
  })
})

describe('updateConfigViaEditor', () => {
  it('locates the entry and merges the patch over the current config', async () => {
    const entry: ConfigEntryLike = { options: { id: 'docwright', name: '@sharework-ai/dsh-docwright', config: { maxIterations: 5 } } }
    const calls: Array<{ patch: object }> = []
    const editor: ConfigEditorLike = {
      entries: () => [entry],
      edit: (e, change) => {
        expect(e).toBe(entry)
        calls.push({ patch: change(e.options?.config ?? {}, {}) })
        return Promise.resolve()
      },
    }
    await updateConfigViaEditor(editor, { confirmPolicy: 'strict' })
    expect(calls).toEqual([{ patch: { maxIterations: 5, confirmPolicy: 'strict' } }])
  })
})

describe('setPackParamDefault', () => {
  it('writes the manifest, reloads, and hot-swaps the same map instance', async () => {
    const { root, packs, deps } = await writeDeps()
    await setPackParamDefault(deps, 'wp', 'limit', 9)
    // The SAME map instance now serves the new default (tools see it without a restart).
    expect(packs.get('wp')!.manifest.params!.limit!.default).toBe(9)
    const onDisk = JSON.parse(await readFile(join(root, 'wp', 'manifest.json'), 'utf8')) as { params: { limit: { default: number } } }
    expect(onDisk.params.limit.default).toBe(9)
    // The write is pretty-printed with a trailing newline (human-editable).
    const raw = await readFile(join(root, 'wp', 'manifest.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('writes a workspace-tier pack (loaded via workspacePackRoots) in its own directory', async () => {
    // The apply-time map includes the workspace tier when a workspace root is
    // configured (index.ts canonicalRoots); pack.dir is the real workspace
    // directory, so the param write lands there — not in the packsDir.
    const { workspacePackRoots } = await import('../src/pack-sources.ts')
    const builtinRoot = await mkdtemp(join(tmpdir(), 'docwright-writes-builtin-'))
    const wsRoot = await mkdtemp(join(tmpdir(), 'docwright-writes-ws-'))
    await packFixture(join(wsRoot, '.docwright', 'packs'))
    const roots = workspacePackRoots(wsRoot, false).map(r => ({ dir: r.dir, origin: { kind: 'workspace' as const, root: r.dir } }))
    const packs = new Map(await loadPacks(builtinRoot, { includeBuiltin: false, roots }))
    const deps = { packs, builtinRoot, loadPacks: (r: string, d: { extra?: readonly string[] | undefined }) => loadPacks(r, d) }
    await setPackParamDefault(deps, 'wp', 'limit', 13)
    const onDisk = JSON.parse(await readFile(join(wsRoot, '.docwright', 'packs', 'wp', 'manifest.json'), 'utf8')) as { params: { limit: { default: number } } }
    expect(onDisk.params.limit.default).toBe(13)
  })

  it('persists a packsDir pack edit to the packsDir manifest, never the builtin root', async () => {
    // The write lands in pack.dir — the root the pack was LOADED from — so a
    // packsDir pack (e.g. <workspace>/.docwright/packs/) is edited in place.
    const builtinRoot = await mkdtemp(join(tmpdir(), 'docwright-writes-builtin-'))
    const extraRoot = await mkdtemp(join(tmpdir(), 'docwright-writes-extra-'))
    await packFixture(extraRoot)
    const packs = new Map(await loadPacks(builtinRoot, { extra: [extraRoot] }))
    const deps = { packs, builtinRoot, extraPacksDir: extraRoot, loadPacks: (r: string, d: { extra?: readonly string[] | undefined }) => loadPacks(r, d) }
    await setPackParamDefault(deps, 'wp', 'limit', 11)
    const onDisk = JSON.parse(await readFile(join(extraRoot, 'wp', 'manifest.json'), 'utf8')) as { params: { limit: { default: number } } }
    expect(onDisk.params.limit.default).toBe(11)
    expect(packs.get('wp')!.origin).toEqual({ kind: 'packsDir', root: extraRoot })
    await rm(builtinRoot, { recursive: true, force: true })
    await rm(extraRoot, { recursive: true, force: true })
  })

  it('refuses to write when the manifest is corrupt or the param vanished, and reports reload failures', async () => {
    const { root, packs, deps } = await writeDeps()
    await writeFile(join(root, 'wp', 'manifest.json'), '{corrupt', 'utf8')
    await expect(setPackParamDefault(deps, 'wp', 'limit', 4)).rejects.toThrow(/not valid JSON/)
    // Manifest present but params.<name> gone (file edited under us).
    await writeFile(join(root, 'wp', 'manifest.json'), JSON.stringify({
      name: 'wp', version: '1', description: 'd', consumes: [], languages: ['zh-CN'],
      params: { other: { type: 'number', default: 1, description: 'd' } },
    }), 'utf8')
    await expect(setPackParamDefault(deps, 'wp', 'limit', 4)).rejects.toThrow(/no longer declares params\.limit/)
    // A reload failure (broken ruleset elsewhere in the root) is loud even though the manifest itself was fine.
    await packFixture(root)
    await mkdir(join(root, 'broken-pack'), { recursive: true })
    await writeFile(join(root, 'broken-pack', 'manifest.json'), '{"name": "broken"}', 'utf8')
    const good = JSON.parse(await readFile(join(root, 'wp', 'manifest.json'), 'utf8')) as never
    void good
    await writeFile(join(root, 'wp', 'manifest.json'), JSON.stringify({
      name: 'wp', version: '1', description: 'd', consumes: [], languages: ['zh-CN'],
      params: { limit: { type: 'number', default: 3, min: 1, max: 20, description: 'd' }, shares: { type: 'object', required: true, confirm: true, description: 'no default here' } },
    }), 'utf8')
    await expect(setPackParamDefault(deps, 'wp', 'limit', 5)).rejects.toThrow(/reloading packs failed/)
    expect(packs.get('wp')!.manifest.params!.limit!.default).toBe(3)
    await rm(join(root, 'broken-pack'), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })

  it('guards pattern-referenced params: garbage regex refused pre-disk, empty (disabled) allowed', async () => {
    const { root, deps } = await writeDeps()
    const manifestPath = join(root, 'wp', 'manifest.json')
    const before = await readFile(manifestPath, 'utf8')
    await expect(setPackParamDefault(deps, 'wp', 'namePattern', '([bad')).rejects.toThrow(/not a valid regex/)
    // A non-string value cannot be a regex source either.
    await expect(setPackParamDefault(deps, 'wp', 'namePattern', 7)).rejects.toThrow(/must be a string/)
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
    await setPackParamDefault(deps, 'wp', 'namePattern', '')
    const onDisk = JSON.parse(await readFile(manifestPath, 'utf8')) as { params: { namePattern: { default: string } } }
    expect(onDisk.params.namePattern.default).toBe('')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses unknown packs, non-defaulted params, and load-invalid values without writing', async () => {
    const { root, deps } = await writeDeps()
    const before = await readFile(join(root, 'wp', 'manifest.json'), 'utf8')
    await expect(setPackParamDefault(deps, 'ghost', 'limit', 4)).rejects.toThrow(/unknown pack "ghost"/)
    // shares has no default: editing it is a structural change, not maintenance.
    await expect(setPackParamDefault(deps, 'wp', 'shares', B70)).rejects.toThrow(/does not declare a default/)
    // Out-of-range default: the load-time gate rejects the manifest before disk.
    await expect(setPackParamDefault(deps, 'wp', 'limit', 99)).rejects.toThrow(/default must be <= max/)
    expect(await readFile(join(root, 'wp', 'manifest.json'), 'utf8')).toBe(before)
    await rm(root, { recursive: true, force: true })
  })
})

describe('setPackParamDefault: seen-vs-written origin guard', () => {
  it('refuses the write when the echoed origin does not match the pack\'s active root', async () => {
    const { root, deps } = await writeDeps()
    const before = await readFile(join(root, 'wp', 'manifest.json'), 'utf8')
    const pack = deps.packs.get('wp')!
    await expect(setPackParamDefault(deps, 'wp', 'limit', 9, { kind: 'packsDir', root: '/somewhere/else' }))
      .rejects.toThrow(/now resolves from .*nothing was written/)
    // Nothing landed on disk, and the in-memory default is unchanged.
    expect(await readFile(join(root, 'wp', 'manifest.json'), 'utf8')).toBe(before)
    expect(deps.packs.get('wp')!.manifest.params!.limit!.default).toBe(pack.manifest.params!.limit!.default)
    // Echoing the ACTUAL origin passes and writes.
    await setPackParamDefault(deps, 'wp', 'limit', 9, { kind: pack.origin.kind, root: pack.origin.root })
    expect(deps.packs.get('wp')!.manifest.params!.limit!.default).toBe(9)
    await rm(root, { recursive: true, force: true })
  })
})
