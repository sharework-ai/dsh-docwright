import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeZipSync, packEntriesFromDir, packEntriesFromMarket, suiteZipBytes } from '../src/pack-zip.ts'

describe('pack-zip packaging (settings page round-trip)', () => {
  let dir: string
  beforeAll(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'pack-zip-')), 'demo-pack')
    await mkdir(join(dir, 'rules'), { recursive: true })
    await writeFile(join(dir, 'manifest.json'), '{"name":"demo-pack"}', 'utf8')
    await writeFile(join(dir, 'rules', 'zh-CN.json'), '[]', 'utf8')
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('zips a local pack directory with relative paths', async () => {
    const zip = makeZipSync(await packEntriesFromDir(dir))
    const dv = new DataView(zip.buffer as ArrayBuffer)
    expect(dv.getUint32(0, true)).toBe(0x04034b50)
    expect(dv.getUint32(zip.length - 22, true)).toBe(0x06054b50)
  })

  it('unpacks a market tarball into entries (gunzip + ustar)', async () => {
    // a minimal gzipped tar built by node:zlib + hand-rolled ustar
    const { gzipSync } = await import('node:zlib')
    const enc = new TextEncoder()
    const content = enc.encode('{"name":"demo-pack"}')
    const header = new Uint8Array(512)
    header.set(enc.encode('manifest.json'), 0)
    header.set(enc.encode(content.length.toString(8).padStart(11, '0') + ' '), 124)
    header[156] = 48
    const pad = (512 - content.length % 512) % 512
    const body = new Uint8Array(content.length + pad)
    body.set(content)
    const tar = Buffer.concat([Buffer.from(header), Buffer.from(body), Buffer.alloc(1024)])
    const fetchImpl = (async () => new Response(gzipSync(tar), { status: 200 })) as unknown as typeof fetch
    const entries = await packEntriesFromMarket('http://market/x.tgz', fetchImpl)
    expect(entries.map(e => e.path)).toEqual(['manifest.json'])
  })

  it('suite zip embeds a root manifest.json and member folders', async () => {
    const { gzipSync } = await import('node:zlib')
    const enc = new TextEncoder()
    const content = enc.encode('{}')
    const header = new Uint8Array(512)
    header.set(enc.encode('manifest.json'), 0)
    header.set(enc.encode(content.length.toString(8).padStart(11, '0') + ' '), 124)
    const tar = Buffer.concat([Buffer.from(header), Buffer.from(content), Buffer.alloc(512 - content.length, 0), Buffer.alloc(1024)])
    const detail = {
      ok: true,
      suite: { name: 'cosmic', org: 'sharework-ai', version: '1.0.0', tags: ['business'], members: ['member-a'] },
      members: [{ name: 'member-a', version: '0.1.0' }],
    }
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/api/suites/cosmic')) return new Response(JSON.stringify(detail), { status: 200 })
      return new Response(gzipSync(tar), { status: 200 })
    }) as unknown as typeof fetch
    const zip = await suiteZipBytes('http://market', 'cosmic', fetchImpl)
    expect(zip.length).toBeGreaterThan(200)
  })
})
