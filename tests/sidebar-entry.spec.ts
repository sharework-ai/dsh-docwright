import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { buildConfigCatalog } from '../src/params-rpc.ts'
import type { SchemaNode } from '../src/params-rpc.ts'
import { CONFIG_CHANGED_EVENT, SIDEBAR_PANEL_ID, SIDEBAR_PANEL_ORDER, sidebarEntryVisible } from '../src/client/sidebar-entry.ts'

describe('sidebarEntryVisible', () => {
  it('is shown by default: no entry, or an unset value, means shown', () => {
    expect(sidebarEntryVisible([])).toBe(true)
    expect(sidebarEntryVisible([{ key: 'sidebarEntry', value: undefined }])).toBe(true)
    expect(sidebarEntryVisible([{ key: 'marketSearch', value: false }])).toBe(true)
  })

  it('an explicit false in the resolved Config hides the entry', () => {
    expect(sidebarEntryVisible([{ key: 'sidebarEntry', value: false }])).toBe(false)
    expect(sidebarEntryVisible([{ key: 'sidebarEntry', value: true }])).toBe(true)
  })
})

describe('sidebarEntry Config surface', () => {
  it('the Config schema carries the switch with default true, so the settings Config tab renders it', () => {
    const entries = buildConfigCatalog(Config as unknown as SchemaNode, {})
    const entry = entries.find(e => e.key === 'sidebarEntry')
    expect(entry).toBeDefined()
    expect(entry?.type).toBe('boolean')
    expect(entry?.default).toBe(true)
    expect(entry?.origin).toBe('default')
  })

  it('the row rides the sidebar panel list below the host Plugins row', () => {
    expect(SIDEBAR_PANEL_ID).toBe('docwright-market')
    expect(SIDEBAR_PANEL_ORDER).toBeGreaterThan(0)
    expect(typeof CONFIG_CHANGED_EVENT).toBe('string')
  })
})
