import { describe, expect, it } from 'vitest'
import { fetchSuiteInstallPlan, searchMarket } from '../src/market-search.ts'

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

describe('searchMarket: suites', () => {
  const catalogWithSuites = {
    packs: [
      { name: 'cosmic-plan', version: '0.7.1', description: { en: 'plan' }, suites: ['cosmic', 'pro'] },
      { name: 'solo', version: '1', description: { en: 'solo' } },
    ],
    suites: [
      { name: 'cosmic', version: '2', description: { en: 'the COSMIC suite', zh: 'COSMIC 套件' }, category: 'estimation', members: ['cosmic-plan', 'cosmic-req'] },
      { name: 'other', version: '1', description: { en: 'unrelated' }, category: 'other', members: ['x'] },
    ],
  }

  it('returns suite cards hit by the query and the suites each pack belongs to', async () => {
    const result = await searchMarket({ marketUrl: 'https://market.test', fetchImpl: okFetch(catalogWithSuites) }, 'cosmic')
    expect(result.suites).toHaveLength(1)
    expect(result.suites[0]).toMatchObject({ name: 'cosmic', version: '2', description: 'the COSMIC suite', category: 'estimation', members: ['cosmic-plan', 'cosmic-req'] })
    expect(result.suites[0].install).toContain('"suite"')
    expect(result.suites[0].install).toContain('cosmic')
    expect(result.packs.find(p => p.name === 'cosmic-plan')?.suites).toEqual(['cosmic', 'pro'])
    expect(result.packs.find(p => p.name === 'solo')?.suites).toEqual([])
  })

  it('degrades to empty suite results on an old market (404) without failing the search', async () => {
    const result = await searchMarket({ marketUrl: 'https://market.test', fetchImpl: okFetch({ packs: [{ name: 'solo', version: '1', description: { en: 'solo' } }] }) }, 'solo')
    expect(result.suites).toEqual([])
    expect(result.packs[0]!.suites).toEqual([])
  })

  it('drops suite rows without a name or members', async () => {
    const result = await searchMarket({ marketUrl: 'https://market.test', fetchImpl: okFetch({ packs: [], suites: [{ name: '', members: ['a'] }, { name: 'x' }, { name: 'ok', version: '1', members: ['a'] }] }) }, 'ok')
    expect(result.suites).toEqual([expect.objectContaining({ name: 'ok' })])
  })
})

describe('fetchSuiteInstallPlan', () => {
  const market = (suites: unknown, packs: unknown) => async (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/api/index')) return new Response(JSON.stringify({ packs }), { headers: { 'content-type': 'application/json' } })
    if (url.endsWith(`/api/suites/${encodeURIComponent('cosmic')}`)) return new Response(JSON.stringify(suites), { headers: { 'content-type': 'application/json' } })
    throw new Error(`unexpected fetch ${url}`)
  }

  it('merges every member closure, labeling suite members vs consumed upstreams', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = market(
      { name: 'cosmic', version: '2', members: ['top', 'solo'] },
      [
        { name: 'base', version: '1', description: { en: 'base' } },
        { name: 'mid', version: '1', description: { en: 'mid' }, consumes: ['base'] },
        { name: 'top', version: '1', description: { en: 'top' }, consumes: ['mid'] },
        { name: 'solo', version: '1', description: { en: 'solo' } },
      ],
    ) as typeof fetch
    try {
      const plan = await fetchSuiteInstallPlan('https://market.test', 'cosmic')
      expect(plan.suite).toEqual({ name: 'cosmic', version: '2' })
      expect(plan.members.map(m => [m.name, m.requested])).toEqual([['base', false], ['mid', false], ['top', true], ['solo', true]])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('fails loud when the market does not know the suite or is unreachable', async () => {
    await expect(fetchSuiteInstallPlan('http://127.0.0.1:1', 'cosmic')).rejects.toThrow(/suite "cosmic" is not offered by the pack market/)
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input: unknown) => {
      if (String(input).includes('/api/suites/')) return new Response('no suite', { status: 404 })
      throw new Error('unexpected')
    }
    try {
      await expect(fetchSuiteInstallPlan('https://market.test', 'cosmic')).rejects.toThrow(/is not offered by the pack market/)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('fails loud when the suite lists no members', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input: unknown) => {
      if (String(input).includes('/api/suites/')) return new Response(JSON.stringify({ name: 'cosmic', version: '1', members: [] }), { headers: { 'content-type': 'application/json' } })
      throw new Error('unexpected')
    }
    try {
      await expect(fetchSuiteInstallPlan('https://market.test', 'cosmic')).rejects.toThrow(/lists no member packs/)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('searchMarket: suite lane failure degradation', () => {
  it('ignores a throwing /api/suites fetch (suites degrade to [], packs unaffected)', async () => {
    const result = await searchMarket({ marketUrl: 'https://market.test', fetchImpl: async (input: unknown) => {
      if (String(input).endsWith('/api/suites')) throw new Error('ECONNRESET')
      return new Response(JSON.stringify({ packs: [{ name: 'solo', version: '1', description: { en: 'solo' } }] }), { headers: { 'content-type': 'application/json' } })
    } }, 'solo')
    expect(result.suites).toEqual([])
    expect(result.count).toBe(1)
  })

  it('ignores a non-array suites payload and a suites-ignorant index in the plan fetch', async () => {
    const impl = async (input: unknown): Promise<Response> => {
      const url = String(input)
      if (url === 'https://market.test/api/suites') return new Response(JSON.stringify({ packs: 'not-suites' }), { headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ packs: [{ name: 'solo', version: '1', description: { en: 'solo' } }] }), { headers: { 'content-type': 'application/json' } })
    }
    const result = await searchMarket({ marketUrl: 'https://market.test', fetchImpl: impl }, 'solo')
    expect(result.suites).toEqual([])
    // fetchSuiteInstallPlan: suite detail ok but /api/index failing → loud, retry guidance.
    const planImpl = async (input: unknown): Promise<Response> => {
      const url = String(input)
      if (url.includes('/api/suites/')) return new Response(JSON.stringify({ name: 'cosmic', version: '1', members: ['solo'] }), { headers: { 'content-type': 'application/json' } })
      throw new Error('ECONNRESET')
    }
    const realFetch = globalThis.fetch
    globalThis.fetch = planImpl as typeof fetch
    try {
      await expect(fetchSuiteInstallPlan('https://market.test', 'cosmic')).rejects.toThrow(/could not reach the pack market.*retry later/)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
