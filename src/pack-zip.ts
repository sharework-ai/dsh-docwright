/**
 * Pack/suite ZIP packaging for the settings page (host side).
 *
 * The submit flow on the market accepts ZIPs in exactly the layout the
 * market's download buttons produce, so the settings page offers the same
 * "package" action for every installed pack and known suite:
 * - a pack zips the files of its LOCAL directory (the author's source of
 *   truth for a re-submission);
 * - a suite is fetched from the market and zipped as a root manifest.json
 *   plus one folder per member pack (the member tarballs are pulled from
 *   the market and unpacked here).
 *
 * Implemented with node:zlib + hand-rolled ustar/zip structures — the
 * plugin stays dependency-free. ZIP entries use the STORE method: pack
 * files are plain text/images and the market verifies content by hash, so
 * compression buys nothing here.
 */
import { gunzipSync } from 'node:zlib'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface ZipEntry {
  readonly path: string
  readonly bytes: Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    const index = (c ^ (bytes[i] ?? 0)) & 0xff
    c = (index < CRC_TABLE.length ? CRC_TABLE[index]! : 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** STORE-method ZIP writer (fixed DOS timestamp, UTF-8 names). */
export function makeZipSync(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const chunks: Uint8Array[] = []
  const central: { nameB: Uint8Array; crc: number; size: number; offset: number }[] = []
  let offset = 0
  const view = (size: number): DataView => new DataView(new ArrayBuffer(size))
  for (const e of entries) {
    const nameB = enc.encode(e.path)
    const crc = crc32(e.bytes)
    const lh = view(30)
    lh.setUint32(0, 0x04034b50, true)
    lh.setUint16(4, 20, true)
    lh.setUint16(6, 0x0800, true)
    lh.setUint16(10, dosTime, true)
    lh.setUint16(12, dosDate, true)
    lh.setUint32(14, crc, true)
    lh.setUint32(18, e.bytes.length, true)
    lh.setUint32(22, e.bytes.length, true)
    lh.setUint16(26, nameB.length, true)
    chunks.push(new Uint8Array(lh.buffer), nameB, e.bytes)
    central.push({ nameB, crc, size: e.bytes.length, offset })
    offset += 30 + nameB.length + e.bytes.length
  }
  const centralStart = offset
  for (const c of central) {
    const ch = view(46)
    ch.setUint32(0, 0x02014b50, true)
    ch.setUint16(4, 20, true)
    ch.setUint16(6, 20, true)
    ch.setUint16(8, 0x0800, true)
    ch.setUint16(12, dosTime, true)
    ch.setUint16(14, dosDate, true)
    ch.setUint32(16, c.crc, true)
    ch.setUint32(20, c.size, true)
    ch.setUint32(24, c.size, true)
    ch.setUint16(28, c.nameB.length, true)
    ch.setUint32(42, c.offset, true)
    chunks.push(new Uint8Array(ch.buffer), c.nameB)
    offset += 46 + c.nameB.length
  }
  const eocd = view(22)
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, central.length, true)
  eocd.setUint16(10, central.length, true)
  eocd.setUint32(12, offset - centralStart, true)
  eocd.setUint32(16, centralStart, true)
  chunks.push(new Uint8Array(eocd.buffer))
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/** Minimal ustar walk over an UNCOMPRESSED tar buffer. */
function tarEntries(tar: Buffer): { path: string; bytes: Buffer }[] {
  const entries: { path: string; bytes: Buffer }[] = []
  for (let pos = 0; pos + 512 <= tar.length;) {
    const header = tar.subarray(pos, pos + 512)
    if (header.every(b => b === 0)) break
    let name = ''
    for (let i = 0; i < 100 && (header[i] ?? 0) !== 0; i++) name += String.fromCharCode(header[i]!)
    let prefix = ''
    for (let i = 345; i < 500 && (header[i] ?? 0) !== 0; i++) prefix += String.fromCharCode(header[i]!)
    const sizeField = header.subarray(124, 136).toString('latin1').replace(/[\0 ]/g, '')
    const size = parseInt(sizeField || '0', 8) || 0
    const typeFlag = String.fromCharCode(header[156]! || 48)
    const dataStart = pos + 512
    const clean = (prefix ? `${prefix}/` : '') + name.replace(/^\.\//, '')
    if ((typeFlag === '0' || typeFlag === '\0') && clean && !clean.endsWith('/')) {
      entries.push({ path: clean, bytes: tar.subarray(dataStart, dataStart + size) })
    }
    pos = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

/** Fetch a market tarball and return its file entries (gunzip + ustar). */
export async function packEntriesFromMarket(tarballUrl: string, fetchImpl: typeof fetch): Promise<ZipEntry[]> {
  const response = await fetchImpl(tarballUrl, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`tarball ${tarballUrl}: HTTP ${response.status}`)
  const tar = gunzipSync(Buffer.from(await response.arrayBuffer()))
  return tarEntries(tar).map(e => ({ path: e.path, bytes: new Uint8Array(e.bytes) }))
}

/** Walk a local pack directory into zip entries (relative paths). */
export async function packEntriesFromDir(dir: string): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = []
  async function walk(current: string): Promise<void> {
    for (const dirent of await readdir(current, { withFileTypes: true })) {
      const full = join(current, dirent.name)
      const rel = full.slice(dir.length + 1)
      if (dirent.isDirectory()) await walk(full)
      else entries.push({ path: rel, bytes: new Uint8Array(await readFile(full)) })
    }
  }
  await walk(dir)
  return entries
}

/** Suite ZIP: root manifest.json (the suite's own metadata) plus one folder
 * per member pack, each folder being that member's published files. */
export async function suiteZipBytes(
  marketUrl: string,
  suiteName: string,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const detailResponse = await fetchImpl(`${marketUrl}/api/suites/${encodeURIComponent(suiteName)}`, { signal: AbortSignal.timeout(15_000) })
  if (!detailResponse.ok) throw new Error(`suite ${suiteName}: HTTP ${detailResponse.status}`)
  const detail = (await detailResponse.json()) as { suite?: Record<string, unknown>; members?: { name: string; version: string; missing?: boolean }[] }
  const suite = detail.suite ?? {}
  const entries: ZipEntry[] = [{
    path: 'manifest.json',
    bytes: new TextEncoder().encode(JSON.stringify({
      name: suite.name ?? suiteName,
      org: suite.org ?? null,
      version: suite.version ?? null,
      title: suite.title ?? null,
      description: suite.description ?? null,
      tags: suite.tags ?? [],
      members: (detail.members ?? []).map(m => m.name),
      kind: 'suite',
    }, null, 2)),
  }]
  for (const member of detail.members ?? []) {
    if (member.missing) continue
    const tarball = `${marketUrl}/tarballs/${member.name}-${member.version}.tgz`
    for (const e of await packEntriesFromMarket(tarball, fetchImpl)) entries.push(e)
  }
  return makeZipSync(entries)
}
