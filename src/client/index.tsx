/**
 * docwright UI client half: mounts the plugin's three host surfaces, each
 * reached through `slots.inject`, which waits for the slot to exist — a host
 * that never declares one never runs its registration (dsh-market's detection
 * pattern — no version strings):
 *
 * - `settings.section` (+ `settings.section.icon`): a top-level Settings nav
 *   entry rendering the params maintenance views (dsh-market's Settings entry
 *   recipe; the icon id must equal the section id or the shell never draws it).
 * - `plugins.tab`: a tab on the Plugins page's tab row (after 已安装) opening
 *   the pack market (dm.shrwk.com) in place. Order 1 lands after the host's
 *   own Discover tab; dsh-market's tab takes -1 to sit before it.
 * - `plugins.bundle.config`: the configuration card on the bundle's own
 *   Plugins page, keyed by this package's name.
 * - `sidebar.panellist` (+ `main`): the Docwright packs row in the host
 *   sidebar's global panel list, rendered as a full main panel
 *   (dsh-market's sidebar recipe). Shown by default; the plugin Config's
 *   `sidebarEntry` switch (settings page, Config tab) turns the row and
 *   its panel off, live via `docwright:config-changed`.
 *
 * The 0.1.7-era `settings.plugins.tab` seat is intentionally NOT registered:
 * the top-level section supersedes it (one settings home, like dsh-market,
 * which dropped the inner tab too).
 *
 * Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js;
 * externals resolve through the loader's module table. Containment follows
 * dsh-market's lesson: a throw inside the host's client bootstrap takes the
 * whole app down, so each mounting is wrapped separately and a failure costs
 * that one surface for the session, never the shell.
 */
import { createElement as h } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveLocalized } from '../description.ts'
import type { LocalizedText } from '../description.ts'
import { ParamsSection } from './ParamsSection.tsx'
import { MarketTab } from './MarketTab.tsx'
import { CONFIG_CHANGED_EVENT, SIDEBAR_PANEL_ID, SIDEBAR_PANEL_ORDER, sidebarEntryVisible } from './sidebar-entry.ts'
import { fetchParams } from './api.ts'

const NS = 'docwright-params'

/** The bundle's package name — the key `plugins.bundle.config` is contracted to. */
const PACKAGE_NAME = '@sharework-ai/dsh-docwright'

/** Compiled Tailwind CSS — generated-css.ts is emitted by
 * scripts/build-client-css.mjs from src/client/styles.css (run by
 * build:client and typecheck; never hand-edited). */
import { CLIENT_CSS_BUNDLE } from './generated-css.ts'

/** The style-tag identity — one sheet per page, idempotent across remounts. */
const CSS_TAG_ID = 'docwright/client.css'

/** Inject the plugin's stylesheet once (dsh-market's data-plugin-css
 * pattern). Utilities are global class names but carry no host reset — the
 * sheet defines exactly the utilities this bundle uses. */
function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', CSS_TAG_ID)
  tag.textContent = CLIENT_CSS_BUNDLE
  document.head.appendChild(tag)
}

/** The settings.section id; `settings.section.icon` must register the same id. */
const SECTION_ID = 'docwright'

/** The plugins.tab id. */
const MARKET_TAB_ID = 'docwright-market'

/** Primitives this bundle requires that older hosts may lack. */
const REQUIRED_PRIMITIVES = ['Button', 'Input', 'Pill', 'SegmentedTabs', 'Switch'] as const

export function missingPrimitives(mod: Record<string, unknown>): string[] {
  return REQUIRED_PRIMITIVES.filter(name => mod[name] === undefined)
}

interface LocaleService {
  getSnapshot(): { active: string }
  subscribe(callback: () => void): () => void
  /** Present on 0.2.x hosts: resolves LocalizedText along the active
   * language's fallback chain (en as the terminal fallback). */
  resolveText?(text: unknown): string
}

interface SlotsService {
  inject(name: string, register: () => unknown): void
  register(options: Record<string, unknown>, component: (owner: { lang?: string; view?: string; size?: number }) => unknown): unknown
}

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
}

export const name = 'docwright-params'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  const mod = primitives as unknown as Record<string, unknown>
  const gaps = missingPrimitives(mod)
  if (gaps.length > 0) {
    console.warn(`[docwright] host ui-primitives missing ${gaps.join(', ')} — params section disabled (newer dsh web required)`)
    return
  }
  try {
    injectStyles()
    mountSection(ctx)
  } catch (error) {
    console.error('[docwright] surfaces failed to mount; the rest of the app is unaffected.', error)
  }
}

/** Register one slot cell, converting whatever disposer the host hands back
 * into a fiber-owned cleanup (absent disposers become no-ops). */
function own(ctx: ClientContext, label: string, register: () => unknown): void {
  const off = register()
  ctx.effect(() => () => {
    if (typeof off === 'function') (off as () => void)()
  }, label)
}

function mountSection(ctx: ClientContext): void {
  let lang: 'zh' | 'en' = ctx.locale.getSnapshot().active === 'zh' ? 'zh' : 'en'
  ctx.locale.subscribe(() => {
    lang = ctx.locale.getSnapshot().active === 'zh' ? 'zh' : 'en'
  })
  const label = () => (lang === 'zh' ? 'Docwright 参数' : 'Docwright params')
  const marketLabel = () => (lang === 'zh' ? 'Docwright 市场' : 'Docwright packs')
  // Locale resolution for author content (pack/param/Config descriptions):
  // the host's resolveText along its fallback chain when the host provides
  // it; the same semantics (requested locale, then en) locally otherwise.
  const resolveText = (value: unknown): string => {
    if (typeof ctx.locale.resolveText === 'function') return ctx.locale.resolveText(value)
    return resolveLocalized(value as LocalizedText | undefined, lang)
  }
  const params = () => h(ParamsSection, { lang, resolveText })

  // Surface 1: the top-level Settings nav entry, rendering the params views
  // (the shells' sections render inside the panel content column; ownerProps
  // carries `close`, which the views never need). Detected by the slot: hosts
  // without it skip this surface entirely.
  try {
    ctx.slots.inject('settings.section', () => {
      own(ctx, 'docwright: settings section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 45,
        label,
        locale: NS,
        inject: () => ({ lang }),
      }, params))
    })
  } catch (error) {
    console.error('[docwright] settings section failed to register.', error)
  }

  // The section's nav glyph. The registration id MUST equal the section's id
  // ("unmatched ids never render"). The slot is the detection: hosts before
  // 0.2.2 never declare it, and the shell keeps its default gear glyph there.
  try {
    ctx.slots.inject('settings.section.icon', () => {
      own(ctx, 'docwright: settings icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: SECTION_ID,
      }, (owner: { size?: number } = {}) => h(DocwrightMark, { size: owner.size ?? 16 })))
    })
  } catch (error) {
    console.error('[docwright] settings icon failed to register.', error)
  }

  // Surface 2: the Plugins page's tab row (after the page's own Installed
  // tab) opening the pack market in place. The owner's `install`/`openPackage`
  // props drive the host's own install dialog; the market site brings its own
  // download flow, so they are deliberately not used.
  try {
    ctx.slots.inject('plugins.tab', () => {
      own(ctx, 'docwright: plugins market tab', () => ctx.slots.register({
        name: 'plugins.tab',
        id: MARKET_TAB_ID,
        order: 1,
        label: marketLabel,
        locale: NS,
        inject: () => ({ lang }),
      }, () => h(MarketTab, { lang })))
    })
  } catch (error) {
    console.error('[docwright] plugins market tab failed to register.', error)
  }

  // Surface 3: the configuration card on the bundle's own Plugins page
  // ("a bundle's configuration belongs in plugins.bundle.config, keyed by
  // the bundle's package name"). `view: 'summary'` is the list row's
  // one-liner slot — the pack description already carries that, so the card
  // renders on the page only.
  try {
    ctx.slots.inject('plugins.bundle.config', () => {
      own(ctx, 'docwright: bundle config card', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
        locale: NS,
        inject: () => ({ lang }),
      }, (owner: { view?: string } = {}) => (owner.view === 'summary' ? null : params())))
    })
  } catch (error) {
    console.error('[docwright] bundle config card failed to register.', error)
  }

  // Surface 4: the sidebar's global panel row (dsh-market's recipe, #846).
  // Two facts decide whether the row exists, and they arrive independently:
  // the host declaring `sidebar.panellist` (this inject is the detection —
  // hosts without it never run this body), and the deployment's Config
  // `sidebarEntry` switch, read from the params payload. Shown is the
  // default: the row registers immediately and the first config read (plus
  // every `docwright:config-changed` event from the settings page) takes it
  // down when the switch is off. A `main` panel with the same key is what
  // makes the row open a page — the only one-click destination the host's
  // public contracts allow.
  try {
    let layout: { panelInfo: { getSnapshot(): { activePanelId?: string | null } }; selectPanel(id: string | null): void } | undefined
    try {
      ;(ctx as unknown as { inject(services: string[], callback: (scoped: { layout: typeof layout }) => void): void })
        .inject(['layout'], (scoped) => { layout = scoped.layout })
    } catch {
      // Hosts without a layout service keep the row; only the unselect-on-hide
      // nicety degrades (see takeDown).
    }
    let offSurfaces: (() => void) | undefined
    let rowUp = false
    let slotSeen = false
    let wanted = true
    const panelLabel = () => (lang === 'zh' ? 'Docwright 市场' : 'Docwright packs')
    const bringUp = (): void => {
      if (rowUp || offSurfaces !== undefined) return
      rowUp = true
      const offPanel = ctx.slots.register({
        name: 'main',
        key: SIDEBAR_PANEL_ID,
        locale: NS,
        inject: () => ({ lang }),
      }, () => h(MarketTab, { lang }))
      const offRow = ctx.slots.register({
        name: 'sidebar.panellist',
        id: SIDEBAR_PANEL_ID,
        order: SIDEBAR_PANEL_ORDER,
        label: panelLabel,
        locale: NS,
      }, (owner: { size?: number } = {}) => h(DocwrightMark, { size: owner.size ?? 16 }))
      offSurfaces = () => {
        // Leave the page before its panel goes: a selection pointing at a
        // key that no longer exists would strand the main column on nothing.
        if (layout?.panelInfo.getSnapshot().activePanelId === SIDEBAR_PANEL_ID) layout.selectPanel(null)
        if (typeof offRow === 'function') (offRow as () => void)()
        if (typeof offPanel === 'function') (offPanel as () => void)()
      }
    }
    const takeDown = (): void => {
      rowUp = false
      offSurfaces?.()
      offSurfaces = undefined
    }
    const apply = (): void => {
      if (!slotSeen) return
      if (wanted) bringUp()
      else takeDown()
    }
    const readConfig = (): void => {
      void fetchParams().then(payload => {
        wanted = sidebarEntryVisible(payload.config)
        apply()
      }).catch(() => {})
    }
    // Detection is the slot: only a host declaring `sidebar.panellist` ever
    // runs the registration. The row is the default, so it comes up with the
    // slot; the config read (and every settings-page save, announced as
    // `docwright:config-changed`) is what can take it down.
    ctx.slots.inject('sidebar.panellist', () => {
      slotSeen = true
      apply()
      readConfig()
    })
    window.addEventListener(CONFIG_CHANGED_EVENT, readConfig)
    ctx.effect(() => () => {
      window.removeEventListener(CONFIG_CHANGED_EVENT, readConfig)
      takeDown()
    }, 'docwright: sidebar panel row')
  } catch (error) {
    console.error('[docwright] sidebar panel row failed to register.', error)
  }
}

/** The section's nav glyph: a document sheet with a check, currentColor. */
export function DocwrightMark(owner: { size?: number }): ReturnType<typeof h> {
  const size = owner.size ?? 16
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
  h('path', { d: 'M3.5 1.5h5.8l3.2 3.2v9.8h-9z' }),
  h('path', { d: 'M9.3 1.5v3.2h3.2' }),
  h('path', { d: 'M5.5 8.2h5' }),
  h('path', { d: 'M5.5 10.6l1.2 1.2 2.3-2.3' }))
}
