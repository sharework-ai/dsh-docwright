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
import { createElement as h, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { fetchParams } from './api.ts'
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

export function MarketTab(props: { lang: 'zh' | 'en' }): ReactNode {
  const t = translate(props.lang === 'zh' ? zh : en)
  const [url, setUrl] = useState(MARKET_URL)
  useEffect(() => {
    void fetchParams().then(payload => {
      const configured = normalizeMarketUrl(payload.config.find(e => e.key === 'marketUrl')?.value)
      if (configured !== undefined) setUrl(configured)
    }).catch(() => {})
  }, [])
  return h('div', { style: rootStyle },
    h('div', { style: barStyle },
      h('span', { style: titleStyle }, t('marketTitle')),
      // The effective market is deployment state — showing the resolved URL
      // answers "which market am I looking at" without guessing.
      h('span', { style: { ...linkStyle, textDecoration: 'none' } satisfies CSSProperties }, url.replace(/\/$/, '')),
      h('a', { href: url, target: '_blank', rel: 'noreferrer', style: linkStyle }, t('openExternal'))),
    h('iframe', { key: url, src: url, title: t('marketTitle'), style: frameStyle }))
}
