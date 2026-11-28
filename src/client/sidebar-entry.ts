/**
 * The Docwright packs row in the host sidebar's global panel list
 * (dsh-market's sidebar-entry recipe, one deployment-level switch simpler):
 * shown by default, hidden when the plugin Config's `sidebarEntry` is false.
 *
 * Two facts decide whether the row exists, and they arrive independently:
 * whether the host declares `sidebar.panellist` at all (detection is the
 * slot — hosts without it never run the registration), and whether the
 * deployment still wants the entry, read from the params payload's config
 * catalog (/api/docwright/params). The Config switch lives on the plugin's
 * settings page, so there is no per-user server answer of our own.
 */

import type { UiConfigEntry } from './api.ts'

/** The `main` key and `sidebar.panellist` id this package registers. */
export const SIDEBAR_PANEL_ID = 'docwright-market'

/**
 * Below the host's Plugins row (order 0) and dsh-market's row (order 1,
 * where the host has that plugin): the pack market sits next to where
 * plugins are managed, so it takes the next seat down.
 */
export const SIDEBAR_PANEL_ORDER = 2

/** The window event the settings page dispatches after a Config patch saves. */
export const CONFIG_CHANGED_EVENT = 'docwright:config-changed'

/**
 * "Does the deployment still want the sidebar row?" Absent or true means
 * shown — the default is on, and only an explicit `false` in the resolved
 * Config (or a saved patch that made it false) hides the entry.
 */
export function sidebarEntryVisible(config: readonly Pick<UiConfigEntry, 'key' | 'value'>[]): boolean {
  const entry = config.find(e => e.key === 'sidebarEntry')
  return entry?.value !== false
}
