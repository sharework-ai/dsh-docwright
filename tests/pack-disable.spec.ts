import { describe, expect, it } from 'vitest'
import { setPackDisabled } from '../src/pack-manage.ts'
import type { Pack } from '../src/pack.ts'

function packOf(name: string, consumes: readonly string[] = []): Pack {
  return { manifest: { name, version: '1', consumes } } as unknown as Pack
}

function deps(overrides: Partial<Parameters<typeof setPackDisabled>[0]> = {}): Parameters<typeof setPackDisabled>[0] {
  return {
    packs: new Map([['alpha', packOf('alpha')], ['beta', packOf('beta')]]),
    packsDir: '/tmp/packs',
    marketUrl: '',
    currentDisabled: [],
    editConfig: () => Promise.resolve(),
    ...overrides,
  }
}

describe('setPackDisabled (docs/designs/pack-load-dirs.md 启用与禁用)', () => {
  it('disable writes the name into the array', async () => {
    const written: readonly string[][] = []
    const result = await setPackDisabled({ ...deps({ editConfig: next => { written.push(next); return Promise.resolve() } }) }, 'alpha', true)
    expect(written).toEqual([['alpha']])
    expect(result.disabled).toEqual(['alpha'])
  })

  it('enable removes the name from the array', async () => {
    const written: readonly string[][] = []
    const result = await setPackDisabled(deps({ currentDisabled: ['alpha'], editConfig: next => { written.push(next); return Promise.resolve() } }), 'alpha', false)
    expect(written).toEqual([[]])
    expect(result.disabled).toEqual([])
  })

  it('a suite member routes to the suite: disable refuses unless forced, enable lifts the suite entry', async () => {
    const membership = new Map([['alpha', ['my-suite']]])
    const d = deps({
      marketUrl: 'http://market.local',
      currentDisabled: ['my-suite'],
      // NOTE: the market API shape is suites -> members (not member -> suites).
      fetchImpl: (async () => new Response(JSON.stringify({ suites: [{ name: 'my-suite', members: ['alpha'] }] }), { status: 200 })) as typeof fetch,
    })
    // Disable the member directly: refused with suiteManaged guidance.
    await expect(setPackDisabled(d, 'alpha', true)).rejects.toThrow(/disable the SUITE instead/)
    // Enabling the member lifts the SUITE entry (a suite entry keeps every member disabled).
    const result = await setPackDisabled(d, 'alpha', false)
    expect(result.disabled).toEqual([])
  })

  it('packInUse guard: an enabled consumer blocks disable until force', async () => {
    const written: readonly string[][] = []
    const d = deps({ packs: new Map([['alpha', packOf('alpha')], ['beta', packOf('beta', ['alpha'])]]), editConfig: next => { written.push(next); return Promise.resolve() } })
    await expect(setPackDisabled(d, 'alpha', true)).rejects.toThrow(/consumed by enabled packs \(beta\)/)
    const result = await setPackDisabled(d, 'alpha', true, { force: true })
    expect(result.disabled).toEqual(['alpha'])
    expect(written).toEqual([['alpha']])
  })
})
