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

describe('fetchMarketCard', () => {
  it('answers undefined without throwing on an unreachable market or a missing pack', async () => {
    const { fetchMarketCard } = await import('../src/market-search.ts')
    expect(await fetchMarketCard('http://127.0.0.1:1', 'gw')).toBeUndefined()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ packs: [{ name: 'other' }] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
    try {
      expect(await fetchMarketCard('https://market.test', 'gw')).toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
