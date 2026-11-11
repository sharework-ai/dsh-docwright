import { describe, expect, it } from 'vitest'
import { createLlmPort, withSingleRetry } from '../src/llm-port.ts'

describe('llm port', () => {
  it('throws when ctx.llm is missing', () => {
    expect(() => createLlmPort({} as never, { provider: 'p', model: 'm' })).toThrow(/ctx\.llm is not available/)
  })

  it('assembles text blocks from a fake stream', async () => {
    const port = createLlmPort({
      llm: {
        async *stream() {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: '{"ok":' }
          yield { type: 'text-delta', index: 0, text: 'true}' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"ok":true}' } }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    } as never, { provider: 'p', model: 'm' })
    expect(await port.complete({ system: 's', user: 'u' })).toBe('{"ok":true}')
  })

  it('throws when the stream yields no text', async () => {
    const port = createLlmPort({
      llm: {
        async *stream() {
          yield { type: 'finish', reason: 'stop' }
        },
      },
    } as never, { provider: 'p', model: 'm' })
    await expect(port.complete({ system: 's', user: 'u' })).rejects.toThrow(/no text blocks/)
  })

  it('withSingleRetry retries once then succeeds', async () => {
    let n = 0
    const value = await withSingleRetry(async () => {
      n++
      if (n === 1) throw new Error('transient')
      return 'ok'
    })
    expect(value).toBe('ok')
    expect(n).toBe(2)
  })

  it('withSingleRetry propagates AbortError untouched', async () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    await expect(withSingleRetry(async () => { throw err })).rejects.toBe(err)
  })
})

describe('plugin apply', () => {
  it('registers the six tools against a minimal fake context (market search on by default)', async () => {
    const { name, inject, apply } = await import('../src/index.ts')
    expect(name).toBe('docwright')
    expect(inject).toContain('tools')
    const registered: string[] = []
    const ctx = { tools: { register: (t: { name: string }) => { registered.push(t.name) } }, inject: () => {} }
    await apply(ctx as never, { provider: 'p', model: 'm' })
    expect(registered).toEqual(['doc_packs', 'doc_generate', 'doc_extract_params', 'doc_validate', 'doc_chain_status', 'doc_market_search', 'doc_market_install'])
  })

  it('marketSearch: false drops doc_market_search from the roster', async () => {
    const { apply } = await import('../src/index.ts')
    const registered: string[] = []
    const ctx = { tools: { register: (t: { name: string }) => { registered.push(t.name) } }, inject: () => {} }
    await apply(ctx as never, { marketSearch: false, provider: 'p', model: 'm' })
    expect(registered).toEqual(['doc_packs', 'doc_generate', 'doc_extract_params', 'doc_validate', 'doc_chain_status'])
  })

  it('fails loud when defaultLanguage is missing from a pack', async () => {
    const { apply } = await import('../src/index.ts')
    const ctx = { tools: { register: () => {} }, inject: () => {} }
    await expect(apply(ctx as never, { defaultLanguage: 'fr-FR' })).rejects.toThrow(/defaultLanguage "fr-FR" missing/)
  })

  it('tolerates a missing packsDir override; builtin packs still register', async () => {
    const { apply } = await import('../src/index.ts')
    const registered: string[] = []
    const ctx = { tools: { register: (t: { name: string }) => { registered.push(t.name) } }, inject: () => {} }
    await apply(ctx as never, { packsDir: '/nonexistent-docwright-packs', provider: 'p', model: 'm' })
    expect(registered).toEqual(['doc_packs', 'doc_generate', 'doc_extract_params', 'doc_validate', 'doc_chain_status', 'doc_market_search', 'doc_market_install'])
  })
})
