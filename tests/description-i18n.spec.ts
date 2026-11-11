import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { asLocalizedText, assertLocalizedText, resolveLocalized } from '../src/description.ts'
import { loadPacks } from '../src/pack-loader.ts'
import { buildConfigCatalog, buildParamsCatalog } from '../src/params-rpc.ts'
import type { SchemaNode } from '../src/params-rpc.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))

describe('assertLocalizedText', () => {
  it('accepts plain strings and locale maps carrying an en fallback', () => {
    expect(() => assertLocalizedText('plain', 'where')).not.toThrow()
    expect(() => assertLocalizedText({ zh: '中文', en: 'English' }, 'where')).not.toThrow()
    expect(() => assertLocalizedText({ en: 'only en' }, 'where')).not.toThrow()
  })

  it('rejects empties, maps without en, bad locale keys, and non-string values', () => {
    expect(() => assertLocalizedText('', 'w')).toThrow(/non-empty string/)
    expect(() => assertLocalizedText({}, 'w')).toThrow(/at least one locale entry/)
    expect(() => assertLocalizedText({ zh: '只有中文' }, 'w')).toThrow(/"en" entry/)
    expect(() => assertLocalizedText({ 'zh-CN': 'x', en: 'y' }, 'w')).toThrow(/lowercase language id/)
    expect(() => assertLocalizedText({ en: 'ok', zh: 7 }, 'w')).toThrow(/must be a non-empty string/)
    expect(() => assertLocalizedText(42, 'w')).toThrow(/locale map/)
  })

  it('narrowes the validated value for the compiler', () => {
    const raw: unknown = { zh: '中', en: 'E' }
    assertLocalizedText(raw, 'w')
    expect(raw.en).toBe('E')
  })
})

describe('resolveLocalized', () => {
  it('prefers the requested locale and falls back to en', () => {
    const text = { zh: '中文', en: 'English' }
    expect(resolveLocalized(text, 'zh')).toBe('中文')
    expect(resolveLocalized(text, 'en')).toBe('English')
    expect(resolveLocalized({ en: 'English' }, 'zh')).toBe('English')
    expect(resolveLocalized('plain', 'zh')).toBe('plain')
    expect(resolveLocalized(undefined, 'zh')).toBe('')
  })
})

describe('asLocalizedText', () => {
  it('degrades invalid third-party text to undefined instead of throwing', () => {
    expect(asLocalizedText('ok')).toBe('ok')
    expect(asLocalizedText({ zh: 'x', en: 'y' })).toEqual({ zh: 'x', en: 'y' })
    expect(asLocalizedText({ zh: 3 })).toBeUndefined()
  })
})

describe('builtin packs ship bilingual descriptions', () => {
  it('loads every builtin pack (every description passes the localized gate)', async () => {
    const packs = await loadPacks(packsRoot, {})
    expect(packs.size).toBeGreaterThanOrEqual(6)
    for (const pack of packs.values()) {
      expect(typeof (pack.manifest.description as { en?: unknown }).en).toBe('string')
      for (const spec of Object.values(pack.manifest.params ?? {})) {
        expect(typeof (spec.description as { en?: unknown }).en).toBe('string')
      }
    }
  })

  it('keeps zh and en distinct so the UI and the model face read different languages', async () => {
    const packs = await loadPacks(packsRoot, {})
    const plan = packs.get('cosmic-plan')!
    expect(resolveLocalized(plan.manifest.description, 'zh')).toContain('功能点估算')
    expect(resolveLocalized(plan.manifest.description, 'en')).toContain('function-point estimation plan')
  })

  it('passes descriptions through the catalog verbatim (the browser resolves the locale)', async () => {
    const packs = await loadPacks(packsRoot, {})
    const catalog = buildParamsCatalog(packs)
    const plan = catalog.packs.find(p => p.name === 'cosmic-plan')!
    expect(plan.description).toBeTypeOf('object')
    const cfp = plan.params.find(p => p.name === 'cfpPerFunc')!
    expect(cfp.description).toBeTypeOf('object')
  })
})

describe('Config schema descriptions travel as LocalizedText', () => {
  it('carries the bilingual dict from schemastery meta to the UI entry', async () => {
    const { Config } = await import('../src/config.ts')
    const entries = buildConfigCatalog(Config as unknown as SchemaNode, {})
    const confirmPolicy = entries.find(e => e.key === 'confirmPolicy')!
    expect(confirmPolicy.description && typeof confirmPolicy.description === 'object' && confirmPolicy.description.zh).toContain('确认策略')
    expect(resolveLocalized(confirmPolicy.description, 'en')).toContain('Confirmation policy')
  })
})
