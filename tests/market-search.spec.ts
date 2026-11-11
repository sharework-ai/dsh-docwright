import { describe, expect, it } from 'vitest'
import { searchMarket } from '../src/market-search.ts'

const CATALOG = {
  packs: [
    {
      name: 'cosmic-plan',
      version: '0.7.1',
      description: { en: 'COSMIC function-point estimation plan', zh: 'COSMIC 功能点估算计划' },
      category: 'estimation',
      author: 'peng_long',
      license: 'MIT',
      consumes: ['cosmic-context'],
      languages: ['zh-CN', 'en-US'],
      requires_topic: true,
      artifact_prefix: 'PLAN',
    },
    { name: 42, version: '1' },
  ],
}

const okFetch = (body: unknown) => async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('searchMarket', () => {
  it('projects catalog rows into model cards with a concrete install hint', async () => {
    const result = await searchMarket({ marketUrl: 'https://market.test', packsDir: '/w/.docwright/packs', fetchImpl: okFetch(CATALOG) }, 'cosmic function point')
    expect(result).toMatchObject({ market: 'https://market.test', query: 'cosmic function point', count: 1 })
    expect(result.packs[0]).toMatchObject({
      name: 'cosmic-plan',
      version: '0.7.1',
      description: 'COSMIC function-point estimation plan',
      category: 'estimation',
      consumes: ['cosmic-context'],
      requiresTopic: true,
      artifactPrefix: 'PLAN',
    })
    expect(result.packs[0].install).toContain('doc_market_install')
    expect(result.packs[0].install).toContain('cosmic-plan')
  })

  it('caps hits to the requested limit and falls back to the generic install hint without packsDir', async () => {
    const body = { packs: Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, version: '1' })) }
    const result = await searchMarket({ marketUrl: 'https://market.test', fetchImpl: okFetch(body) }, 'p', 2)
    expect(result.count).toBe(2)
  })

  it('fails loud with the retry guidance when the market is unreachable', async () => {
    await expect(searchMarket({ marketUrl: 'http://127.0.0.1:1', fetchImpl: async () => { throw new Error('ECONNREFUSED') } }, 'x'))
      .rejects.toThrow(/could not search the pack market.*retry later, or point marketUrl/)
  })

  it('fails loud on a non-ok catalog response', async () => {
    await expect(searchMarket({ marketUrl: 'https://market.test', fetchImpl: async () => new Response('no', { status: 500 }) }, 'x'))
      .rejects.toThrow(/could not search the pack market.*HTTP 500/)
  })
})


describe('fetchInstallPlan', () => {
  const indexOk = (packs: unknown) => async (input: unknown) => {
    if (String(input).endsWith('/api/index')) return new Response(JSON.stringify({ packs }), { headers: { 'content-type': 'application/json' } })
    throw new Error('unexpected')
  }

  it('throws naming the market when unreachable, and naming the pack when absent', async () => {
    const { fetchInstallPlan } = await import('../src/market-search.ts')
    await expect(fetchInstallPlan('http://127.0.0.1:1', 'gw')).rejects.toThrow(/could not reach the pack market.*nothing was asked/)
    const realFetch = globalThis.fetch
    globalThis.fetch = indexOk([{ name: 'other', version: '1' }]) as typeof fetch
    try {
      await expect(fetchInstallPlan('https://market.test', 'gw')).rejects.toThrow(/"gw" is not listed on the market/)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('lists the consumes closure with the requested pack flagged', async () => {
    const { fetchInstallPlan } = await import('../src/market-search.ts')
    const realFetch = globalThis.fetch
    globalThis.fetch = indexOk([
      { name: 'base', version: '1', description: { en: 'base' } },
      { name: 'mid', version: '1', description: { en: 'mid' }, consumes: ['base'] },
      { name: 'top', version: '2', description: { en: 'top' }, consumes: ['mid'] },
    ]) as typeof fetch
    try {
      const plan = await fetchInstallPlan('https://market.test', 'top')
      expect(plan.members.map(m => [m.name, m.requested])).toEqual([['base', false], ['mid', false], ['top', true]])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
