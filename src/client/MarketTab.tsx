/**
 * The Plugins-page pack-market tab: the pack market embedded in place. The
 * site is anonymous-readable (catalog and tarball downloads); account
 * features keep their own Supabase session inside the frame — partitioned
 * storage, so the frame signs in separately from the standalone site. An
 * always-visible header offers the standalone escape hatch, which also
 * covers deployments where the frame is refused.
 *
 * The market URL is deployment state, not a bundle constant: the tab
 * resolves it once per mount from the plugin's own params payload
 * (Config.marketUrl, served by src/http.ts), falling back to the published
 * default. That keeps the published default PRODUCTION (npm users get the
 * production market with zero configuration) while a dev instance points
 * marketUrl at its own market — the one environment knob, no build-time
 * flavors. No CSS modules — styles are inline host theme tokens (same
 * discipline as ParamsSection).
 */
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { fetchParams, installMarketPack, installMarketSuite, ApiError } from './api.ts'
import type { UiInstallOutcome } from './api.ts'
import { translate, zh, en } from './locales.ts'

/** The published default (production market). */
export const MARKET_URL = 'https://dm.shrwk.com/'

const fontFamily = 'var(--dsw-font-family, inherit)'
const secondary = 'var(--dsw-alias-label-secondary, inherit)'

const rootStyle: CSSProperties = {
  fontFamily,
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  minHeight: '480px',
  height: 'calc(100vh - 150px)',
}

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '10px',
  flex: 'none',
}

const titleStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: '14px',
}

const linkStyle: CSSProperties = {
  color: secondary,
  fontSize: '12px',
  textDecoration: 'none',
}

const frameStyle: CSSProperties = {
  flex: '1 1 auto',
  width: '100%',
  border: '0.5px solid var(--dsw-alias-border-l4, transparent)',
  borderRadius: 'var(--dsw-radius-xl, 20px)',
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
}

function normalizeMarketUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^https:\/\//.test(value)) return undefined
  return value.endsWith('/') ? value : `${value}/`
}

//#region install bridge
/**
 * One-click install bridge: the embedded market site (a cross-origin page)
 * asks the tab to install, and the tab — which IS same-origin with the
 * plugin's HTTP routes — performs the POST and reports back. Protocol:
 * - site → tab:   `{ source: 'docwright-market', type: 'install-request', id, kind: 'pack'|'suite', name }`
 * - tab → site:   `{ source: 'docwright-market', type: 'install-accepted', id }` (spinner face)
 *                 `{ source: 'docwright-market', type: 'install-result', id, ok, installed?, message? }`
 *
 * Trust model: a request is honored only when `event.origin` equals the
 * configured market origin AND `event.source` is the frame we embedded;
 * replies go back with the market origin as `targetOrigin`, so no other
 * window can read them. The market page is anonymous-readable, so a forged
 * request can at worst install a public pack into the local packsDir behind
 * the host's login + same-origin fence — the same power the params page's
 * own update buttons already have.
 */
interface InstallRequest {
  id?: unknown
  kind?: unknown
  name?: unknown
}

function isMarketMessage(event: MessageEvent, marketOrigin: string, frame: HTMLIFrameElement | null): event is MessageEvent & { data: InstallRequest & { type: string } } {
  if (event.origin !== marketOrigin) return false
  if (frame === null || event.source !== frame.contentWindow) return false
  const data = event.data as { source?: unknown; type?: unknown } | null
  return typeof data === 'object' && data !== null && data.source === 'docwright-market'
}
//#endregion

export function MarketTab(props: { lang: 'zh' | 'en' }): ReactNode {
  const t = translate(props.lang === 'zh' ? zh : en)
  const [url, setUrl] = useState(MARKET_URL)
  const [bridgeStatus, setBridgeStatus] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  useEffect(() => {
    void fetchParams().then(payload => {
      const configured = normalizeMarketUrl(payload.config.find(e => e.key === 'marketUrl')?.value)
      if (configured !== undefined) setUrl(configured)
    }).catch(() => {})
  }, [])
  const marketOrigin = (() => {
    try { return new URL(url).origin } catch { return '' }
  })()
  useEffect(() => {
    if (marketOrigin === '') return
    const onMessage = (event: MessageEvent): void => {
      if (!isMarketMessage(event, marketOrigin, frameRef.current)) return
      const { type, id, kind, name } = event.data
      if (type !== 'install-request') return
      const reply = (message: Record<string, unknown>): void => {
        event.source?.postMessage({ source: 'docwright-market', id, ...message }, { targetOrigin: event.origin })
      }
      if (typeof id !== 'string' || id.length === 0 || (kind !== 'pack' && kind !== 'suite') || typeof name !== 'string' || name.length === 0) {
        reply({ type: 'install-result', ok: false, message: 'malformed install request (need string id, kind "pack"|"suite", non-empty name)' })
        return
      }
      reply({ type: 'install-accepted' })
      setBridgeStatus(t('bridgeInstalling'))
      const install = kind === 'pack' ? installMarketPack(name) : installMarketSuite(name)
      void install.then(
        (installed: readonly UiInstallOutcome[]) => {
          setBridgeStatus(null)
          reply({ type: 'install-result', ok: true, installed })
        },
        (error: unknown) => {
          setBridgeStatus(null)
          reply({ type: 'install-result', ok: false, message: error instanceof ApiError ? error.message : String((error as Error)?.message ?? error) })
        },
      )
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [marketOrigin, t])
  return h('div', { style: rootStyle },
    h('div', { style: barStyle },
      h('span', { style: titleStyle }, t('marketTitle')),
      // The effective market is deployment state — showing the resolved URL
      // answers "which market am I looking at" without guessing.
      h('span', { style: { ...linkStyle, textDecoration: 'none' } satisfies CSSProperties }, url.replace(/\/$/, '')),
      bridgeStatus !== null && h(Fragment, null,
        h('span', { style: { ...linkStyle, color: 'var(--dsw-static-blue-500, rgb(59 130 246))' } satisfies CSSProperties }, bridgeStatus)),
      h('a', { href: url, target: '_blank', rel: 'noreferrer', style: linkStyle }, t('openExternal'))),
    h('iframe', { key: url, src: url, title: t('marketTitle'), style: frameStyle, ref: frameRef }))
}
