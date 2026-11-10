/**
 * The Plugins-page pack-market tab: the market site (dm.shrwk.com) embedded
 * in place. The site is anonymous-readable (catalog and tarball downloads);
 * account features keep their own Supabase session inside the frame —
 * partitioned storage, so the frame signs in separately from the standalone
 * site. An always-visible header offers the standalone escape hatch, which
 * also covers deployments where the frame is refused.
 *
 * No CSS modules — styles are inline host theme tokens (same discipline as
 * ParamsSection). The URL is a product constant of this bundle, mirroring
 * dsh-market's own server URL handling.
 */
import { createElement as h } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { translate, zh, en } from './locales.ts'

/** The pack market this tab presents. */
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

export function MarketTab(props: { lang: 'zh' | 'en' }): ReactNode {
  const t = translate(props.lang === 'zh' ? zh : en)
  return h('div', { style: rootStyle },
    h('div', { style: barStyle },
      h('span', { style: titleStyle }, t('marketTitle')),
      h('a', { href: MARKET_URL, target: '_blank', rel: 'noreferrer', style: linkStyle }, t('openExternal'))),
    h('iframe', { src: MARKET_URL, title: t('marketTitle'), style: frameStyle }))
}
