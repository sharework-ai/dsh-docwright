/**
 * The Docwright params section: four views over one catalog fetch — per-pack
 * flat view, the suite overview (docs/designs/pack-suites.md), shared-param
 * groups (the aggregation with effective-source resolution), and the plugin
 * Config form. Controls map from the
 * ParamSpec type (number → numeric input, enum → select, boolean → switch,
 * object → JSON-per-value with endpoints read-only); every parameter shows
 * its author's description inline beneath the name, resolved to the active
 * locale by the host's `locale.resolveText` (LocalizedText from the RPC,
 * en-fallback semantics of src/description.ts). Writes go through the
 * plugin's own routes (src/http.ts), never the conversation; their error
 * envelopes render through the locale catalog (locales.ts renderError). Any
 * change in ANY view re-fetches the whole block, so the Packs and Suites
 * tabs can never disagree.
 *
 * Typography follows the host conversation body, not ad-hoc sizes: one
 * family and size for all running text (`--dsw-font-family` +
 * `--dsh-content-font-size`, 24px+delta line height, so the user's font-size
 * preference applies here too); hierarchy comes from weight and the host's
 * label grays (`--dsw-alias-label-secondary`), never from font size. Only
 * identifiers and values (param names, enum members, JSON) sit in the host
 * code face (`--dsh-font-family-code`).
 */
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Pill, SegmentedTabs, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { deleteManagedPack, deleteSuite, fetchPackUpdates, fetchParams, fetchSuiteStatus, saveConfigPatch, savePackParam, updateManagedPack, updateSuite } from './api.ts'
import { DEPENDS_ICON_PATH, icon, SUITE_ICON_PATH } from './icons.ts'
import type { ApiError } from './api.ts'
import type { ParamsPayload, UiConfigEntry, UiPackEntry, UiPackUpdate, UiParamDeclaration, UiSuiteStatus } from './api.ts'
import { en, fill, renderError, translate, zh } from './locales.ts'
import type { Translate } from './locales.ts'
import { resolveLocalized } from '../description.ts'
import type { LocalizedText } from '../description.ts'

const NS = 'docwright-params'

import type { CSSProperties } from 'react'

/** The conversation body's family and size — the one measure for all running
 * text in this section. */
const baseText: CSSProperties = {
  fontFamily: 'var(--dsw-font-family, inherit)',
  fontSize: 'var(--dsh-content-font-size, 14px)',
  lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
}
/** Host code face for identifiers and values only (names, enums, JSON). */
const codeFont = 'var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'
/** The host's first muted gray (real theme token; the old --dsw-alias-text-*
 * names never existed upstream and always fell through to full-strength). */
const secondary = 'var(--dsw-alias-label-secondary, inherit)'
const row: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0',
}
const rowHead: CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', minWidth: 0,
}
const nameStyle: CSSProperties = {
  fontWeight: 600, fontFamily: codeFont,
}
const desc: CSSProperties = {
  color: secondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}
const valueStyle: CSSProperties = {
  fontFamily: codeFont,
}
const muted: CSSProperties = {
  color: secondary,
}
const smallMuted: CSSProperties = { ...muted, fontSize: '0.82rem' }
const group: CSSProperties = {
  border: '0.5px solid var(--dsw-alias-border-l4, transparent)',
  borderRadius: 'var(--dsw-radius-xl, 20px)',
  background: 'var(--dsw-alias-bg-layer-2, transparent)',
  padding: '12px 16px', marginBottom: '12px',
}
const card: CSSProperties = { ...group, overflow: 'hidden' }
/** The pack card's full-width header band: a quiet blue wash that separates
 * "which pack am I looking at" from the parameter rows below it. */
const packHead: CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', minWidth: 0,
  margin: '-12px -16px 10px', padding: '10px 16px',
  background: 'color-mix(in srgb, var(--dsw-static-blue-500, rgb(59, 130, 246)) 7%, transparent)',
}
const sourceLine: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px',
}
const inputStyle: CSSProperties = {
  width: '160px',
}
const actions: CSSProperties = {
  display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px',
}

/** The author's description, inline beneath the parameter name — the primary
 * explanation stays in view instead of hiding behind a hover. Locale
 * resolution: the host's resolveText when available, its semantics locally
 * otherwise (src/description.ts). */
function DescriptionLine(props: { text: LocalizedText | undefined; resolveText: (value: unknown) => string }) {
  return h('div', { className: `${NS}-desc`, style: { ...desc, marginTop: '2px' } }, props.resolveText(props.text ?? ''))
}

/** One failing write/load as text + optional raw detail line. */
function ErrorLine(props: { error: Error; lang: 'zh' | 'en'; muted?: boolean }) {
  const rendered = renderError(props.error as { message: string; code?: string; params?: Readonly<Record<string, string | number>>; detail?: string }, props.lang)
  return h('span', { style: { color: 'var(--dsw-alias-state-error-primary, crimson)', whiteSpace: 'pre-wrap' } },
    rendered.text,
    rendered.detail !== undefined ? h('span', { style: { ...muted, whiteSpace: 'pre-wrap' } }, `\n${rendered.detail}`) : null)
}

/**
 * Human projection of a declared default: value-band objects read as
 * "target 60 (band 30-90)" instead of raw JSON; anything else that is not a
 * plain scalar falls back to JSON.
 */
function displayDefault(d: UiParamDeclaration, t: Translate): string {
  if (typeof d.default !== 'object' || d.default === null) return String(d.default)
  const o = d.default as Record<string, unknown>
  if (typeof o.value === 'number' && typeof o.min === 'number' && typeof o.max === 'number') {
    return fill(t('bandValue'), { value: o.value, min: o.min, max: o.max })
  }
  if (typeof o.value === 'number' && typeof o.downFactor === 'number' && typeof o.upFactor === 'number') {
    return fill(t('factorValue'), { value: o.value, down: o.downFactor, up: o.upFactor })
  }
  return JSON.stringify(d.default)
}

/** Value-semantics flags, rendered as quiet pills. The confirm gate flag is
 * deliberately absent: it says nothing about maintaining the default (and is
 * not editable here), so it only confused readers. */
function FlagPills(props: { d: UiParamDeclaration; t: Translate }) {
  const { d, t } = props
  const flags: string[] = []
  if (d.extractable) flags.push(t('extractable'))
  if (d.overridable) flags.push(t('overridable'))
  return flags.length === 0 ? null : h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } satisfies CSSProperties },
    flags.map(f => h(Pill, { key: f }, f)))
}

/** Constraint summary under the value: declared range and choices. Object
 * bands carry no note — the human projection ("target 60, band 30-90")
 * already says what value and endpoints mean, uniformly for every band. */
function ConstraintLine(props: { d: UiParamDeclaration; t: Translate }) {
  const { d, t } = props
  const bits: string[] = []
  if (d.enumValues !== undefined) bits.push(`${t('choices')}: ${d.enumValues.join(' / ')}`)
  if (d.min !== undefined) bits.push(`${t('min')} ${d.min}`)
  if (d.max !== undefined) bits.push(`${t('max')} ${d.max}`)
  return bits.length === 0 ? null : h('div', { style: muted }, bits.join(' · '))
}

/** Validate one proposed default against the declaration (client-side mirror of the server gate). */
function validateDraft(d: UiParamDeclaration, text: string): string | undefined {
  if (d.type === 'object') {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'invalidJson'
      return undefined
    } catch {
      return 'invalidJson'
    }
  }
  if (d.enumValues !== undefined) return undefined
  if (d.type === 'number') {
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) return 'invalidNumber'
    if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) return 'outOfRange'
    return undefined
  }
  return undefined
}

/**
 * One declaration's value line, editability decided by ROLE (not by view):
 * a source declaration is editable whereever it is shown (the parameter
 * view's governing row and the owning pack's row in the Packs view write
 * the same manifest field); a shadowed declaration renders its value
 * struck-through and muted — it NEVER takes effect on the chain (the
 * receipt base outranks it) — with an explicit note naming the manager.
 */
function ValueRow(props: { d: UiParamDeclaration; t: Translate; lang: 'zh' | 'en'; onSaved?: (() => void) | undefined }) {
  const { d, t } = props
  if (d.role === 'shadowed') {
    return h('div', { style: rowHead },
      h('span', { style: { ...valueStyle, color: secondary, textDecoration: 'line-through' } satisfies CSSProperties }, displayDefault(d, t)),
      h(Pill, {}, fill(t('shadowedByNote'), { pack: d.shadowedBy ?? '' })))
  }
  return h(EditSeat, { d, t, lang: props.lang, onSaved: props.onSaved })
}

/** The staged-edit control for a source declaration. */
function EditSeat(props: { d: UiParamDeclaration; t: Translate; lang: 'zh' | 'en'; onSaved?: (() => void) | undefined }) {
  const { d, t } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | undefined>(undefined)
  const start = () => {
    setDraft(d.type === 'object' ? JSON.stringify(d.default, null, 2) : String(d.default))
    setError(undefined)
    setEditing(true)
  }
  const save = async () => {
    const problem = validateDraft(d, draft)
    if (problem !== undefined) {
      setError(new Error(problem === 'outOfRange' ? fill(t('rangeTemplate'), { min: String(d.min ?? ''), max: String(d.max ?? '') }) : t(problem)))
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const value = d.type === 'object' ? JSON.parse(draft) : d.type === 'number' ? Number(draft) : draft
      await savePackParam(d.pack, d.name, value)
      setEditing(false)
      props.onSaved?.()
    } catch (saveError) {
      setError(saveError as Error)
    } finally {
      setBusy(false)
    }
  }
  const valueLine = h('div', { style: rowHead },
    h('span', { style: valueStyle }, displayDefault(d, t)),
    editing ? null : h(Button, { size: 'sm', variant: 'ghost', onClick: start }, t('edit')))
  if (!editing) return valueLine
  return h('div', null,
    d.enumValues !== undefined
      ? h('select', { value: String(d.default), onChange: (e: { target: { value: string } }) => setDraft(e.target.value), style: inputStyle },
          d.enumValues.map(v => h('option', { key: String(v), value: String(v) }, String(v))))
      : d.type === 'object'
        ? h('textarea', { value: draft, onChange: (e: { target: { value: string } }) => setDraft(e.target.value), rows: 4,
            style: { ...inputStyle, width: '100%', maxWidth: '480px', fontFamily: codeFont } satisfies CSSProperties })
        : h(Input, { value: draft, type: d.type === 'number' ? 'number' : 'text', step: 'any',
            onChange: (e: { target: { value: string } }) => setDraft(e.target.value), style: inputStyle }),
    h('div', { style: actions },
      h(Button, { size: 'sm', disabled: busy, onClick: () => void save() }, busy ? t('saving') : t('save')),
      h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => setEditing(false) }, t('cancel')),
      error !== undefined ? h(ErrorLine, { error, lang: props.lang }) : null))
}

/**
 * One aggregated parameter group = ONE card, top to bottom: name + flags,
 * the author's description in the muted gray, the effective source on its
 * own line (what governs is a fact of its own — not a prefix of the value
 * row), the effective value and its edit seat on the next, then declared
 * constraints. The shadowed declarations collapse into a single sentence —
 * their values never take effect (the receipt base outranks them), so
 * rendering them per-card repeated the same text N times and showed
 * misleading never-applied numbers.
 */
function ParamGroupCard(props: { name: string; declarations: readonly UiParamDeclaration[]; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onSaved: () => void }) {
  const { name, declarations, t } = props
  const governing = declarations.find(d => d.role === 'source') ?? declarations[0]!
  const shadowed = declarations.filter(d => d !== governing)
  return h('div', { style: group },
    h('div', { style: rowHead },
      h('span', { style: nameStyle }, name),
      h(FlagPills, { d: governing, t })),
    h(DescriptionLine, { text: governing.description, resolveText: props.resolveText }),
    h('div', { style: sourceLine },
      h('span', { style: muted }, `${t('sources')}:`),
      h(Pill, {}, governing.pack)),
    h(ValueRow, { d: governing, t, lang: props.lang, onSaved: props.onSaved }),
    h('div', { style: { marginTop: '2px' } },
      h(ConstraintLine, { d: governing, t })),
    shadowed.length > 0
      ? h('div', { style: { ...muted, marginTop: '4px' } satisfies CSSProperties },
          fill(t('shadowedNote'), { packs: shadowed.map(d => d.pack).join(', ') }))
      : null)
}

/** Aggregated parameter view: one card per parameter name. */
function GroupsView(props: { payload: ParamsPayload; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onSaved: () => void }) {
  const { payload, t } = props
  if (payload.groups.length === 0) return h('p', { style: muted }, t('empty'))
  return h('div', null, payload.groups.map(g => h(ParamGroupCard, { key: g.name, name: g.name, declarations: g.declarations, t, lang: props.lang, resolveText: props.resolveText, onSaved: props.onSaved })))
}

/** One declaration row inside a pack's card. Source rows carry the edit seat; shadowed rows strike their never-applied value through. */
function PackDeclRow(props: { d: UiParamDeclaration; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onSaved: () => void }) {
  const { d, t } = props
  return h('div', { className: `${NS}-row`, style: row },
    h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } satisfies CSSProperties },
      h('div', { style: rowHead },
        h('span', { style: nameStyle }, d.name),
        h(FlagPills, { d, t })),
      h(DescriptionLine, { text: d.description, resolveText: props.resolveText }),
      h(ValueRow, { d, t, lang: props.lang, onSaved: props.onSaved }),
      h('div', { style: { marginTop: '2px' } },
        h(ConstraintLine, { d, t }))))
}

/** Which installed suites a pack belongs to, keyed by pack name (derived
 * once per suites fetch; a pure display marker on the pack card). */
function suitesByPack(rows: readonly UiSuiteStatus[]): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>()
  for (const suite of rows) {
    for (const member of suite.members) {
      const list = map.get(member.name)
      if (list === undefined) map.set(member.name, [suite.name])
      else if (!list.includes(suite.name)) list.push(suite.name)
    }
  }
  return map
}

/** Per-pack flat view (pack-author / troubleshooting perspective). Each card
 * opens with a full-width blue-wash header band — pack identity reads as a
 * section of its own. The card is the overview: identity, description, and
 * actions; the pack's parameter declarations stay folded behind a toggle so
 * the installed-pack list reads at a glance. Market standing is CHECK-ON-DEMAND
 * (检查更新) — never fetched on view mount, and the button only turns into
 * 更新 after a check reports a newer version. */
function PacksView(props: { payload: ParamsPayload; suites: ReadonlyMap<string, readonly string[]>; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onSaved: () => void }) {
  const { payload, t } = props
  // Market standing, fetched ONLY when a card's 检查更新 is clicked — and
  // scoped to THAT card: one click answers exactly one pack (the server
  // still reads the market once). rows holds each checked card's latest row.
  const [lane, setLane] = useState<{ state: 'idle' | 'checking' | 'ready' | 'unreachable'; rows: readonly UiPackUpdate[] }>({ state: 'idle', rows: [] })
  const [laneDone, setLaneDone] = useState<string | undefined>(undefined)
  const checkOne = useCallback((name: string) => {
    setLane(prev => ({ state: 'checking', rows: prev.rows }))
    fetchPackUpdates(name).then(rows => setLane(prev => ({ state: 'ready', rows: [...prev.rows.filter(r => r.name !== name), ...rows] })))
      .catch(() => setLane(prev => ({ state: 'unreachable', rows: prev.rows })))
  }, [])
  const byName = useMemo(() => new Map(lane.rows.map(u => [u.name, u])), [lane.rows])
  const installedNames = useMemo(() => new Set(payload.packs.map(p => p.name)), [payload.packs])
  return h('div', null,
    lane.state === 'unreachable' ? h('p', { style: muted }, t('updateCheckFailed')) : null,
    laneDone !== undefined ? h('p', { style: muted }, laneDone) : null,
    payload.packs.map((p: UiPackEntry) => h(PackCard, { key: p.name, pack: p, status: byName.get(p.name), checked: byName.has(p.name), laneState: lane.state, checkOne, t, lang: props.lang,
      resolveText: props.resolveText, onSaved: props.onSaved, installed: installedNames, suites: props.suites.get(p.name) ?? [],
      consumers: payload.packs.filter(other => other.name !== p.name && other.consumes.includes(p.name)).map(other => other.name),
      onDone: text => { setLaneDone(text); props.onSaved(); checkOne(p.name) } })))
}

/** One pack card: identity + description + action row on top; the parameter
 * declarations fold behind the 参数 toggle. */
function PackCard(props: {
  pack: UiPackEntry
  status: UiPackUpdate | undefined
  /** True once this card's own check has run (its standing may render). */
  checked: boolean
  laneState: 'idle' | 'checking' | 'ready' | 'unreachable'
  checkOne: (name: string) => void
  t: Translate
  lang: 'zh' | 'en'
  resolveText: (value: unknown) => string
  onSaved: () => void
  /** Installed pack names — a dependency outside this set renders red. */
  installed: ReadonlySet<string>
  /** Suite names this pack belongs to (display-only marker). */
  suites: readonly string[]
  consumers: readonly string[]
  onDone: (doneText: string) => void
}) {
  const { pack, t } = props
  const [paramsOpen, setParamsOpen] = useState(false)
  return h('div', { style: card },
    h('div', { style: packHead },
      h('span', { style: nameStyle }, pack.name),
      h(Pill, {}, `v${pack.version}`),
      h(Pill, {}, pack.scope === 'workspace' ? t('scopeWorkspace') : t('scopeTopic')),
      pack.origin.kind === 'builtin' ? h(Pill, {}, t('originBuiltin')) : null,
      pack.paramDriftPolicy !== undefined ? h(Pill, {}, `${t('driftPolicy')}: ${pack.paramDriftPolicy}`) : null),
    h('div', { style: { ...desc, marginBottom: '4px' } satisfies CSSProperties }, props.resolveText(pack.description)),
    pack.consumes.length > 0 || props.suites.length > 0
      ? h('div', { style: { ...muted, marginTop: '4px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } satisfies CSSProperties },
        pack.consumes.length > 0
          ? h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } satisfies CSSProperties },
            h('span', { title: t('consumed'), style: { display: 'inline-flex', alignItems: 'center' } satisfies CSSProperties },
              icon(DEPENDS_ICON_PATH)),
            pack.consumes.map((dep, index) => h('span', {
              key: dep,
              style: props.installed.has(dep) ? undefined : { color: 'var(--dsw-alias-state-error-primary, crimson)', whiteSpace: 'pre-wrap' } satisfies CSSProperties,
            }, `${index > 0 ? ', ' : ''}${dep}${props.installed.has(dep) ? '' : t('missingDep')}`)))
          : null,
        pack.consumes.length > 0 && props.suites.length > 0
          ? h('span', { style: { opacity: 0.6 } satisfies CSSProperties }, '·')
          : null,
        props.suites.map(suite => h('span', {
          key: suite,
          title: t('suiteManagedTip'),
          style: {
            display: 'inline-flex',
            gap: '4px',
            alignItems: 'center',
            // Translucent purple reads correctly on both light and dark
            // themes (same pairing as the market's suite cards) and, being a
            // plain background, never intercepts clicks.
            background: 'rgba(147, 51, 234, 0.12)',
            border: '1px solid rgba(147, 51, 234, 0.38)',
            borderRadius: '999px',
            padding: '1px 8px',
            fontSize: '0.82rem',
            whiteSpace: 'nowrap',
          } satisfies CSSProperties,
        },
          h('span', { style: { display: 'inline-flex', alignItems: 'center' } satisfies CSSProperties },
            icon(SUITE_ICON_PATH, 12)),
          suite)))
      : null,
    h('div', { style: { marginTop: '4px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } satisfies CSSProperties },
      h(Button, { size: 'sm', variant: 'ghost', onClick: () => setParamsOpen(v => !v) },
        `${paramsOpen ? '▾' : '▸'} ${t('paramsToggle')}`),
      // Suite members are managed through their suite (the Suites tab owns
      // install/update/delete): no per-pack lane buttons for them.
      pack.origin.kind === 'packsDir' && props.suites.length === 0
        ? h(PackLaneActions, { pack, status: props.status, checked: props.checked, laneState: props.laneState, check: props.checkOne, t, lang: props.lang,
          consumers: props.consumers, onDone: props.onDone })
        : null),
    paramsOpen
      ? h('div', { style: { marginTop: '6px', borderTop: '0.5px solid var(--dsw-alias-border-l4, transparent)', paddingTop: '6px' } satisfies CSSProperties },
        pack.params.length === 0
          ? h('p', { style: muted }, t('empty'))
          : pack.params.map(d => h(PackDeclRow, { key: d.name, d, t, lang: props.lang, resolveText: props.resolveText, onSaved: props.onSaved })))
      : null)
}

/** One managed pack's lane actions: check-on-demand market standing plus
 * two-step update/delete. 检查更新 is always visible and re-checkable; only a
 * check that reports a newer version turns it into the two-step 更新. Both
 * actions overwrite or remove a packsDir directory, so a click is always the
 * second one — arming resets on completion and on any refresh; the update
 * confirm names the overwrite explicitly, the delete confirm names installed
 * consumers. A server failure renders through the locale catalog
 * (what/why/what-to-do) under the buttons. */
function PackLaneActions(props: {
  pack: UiPackEntry
  status: UiPackUpdate | undefined
  /** True once THIS card's check ran — other cards' checks stay invisible here. */
  checked: boolean
  laneState: 'idle' | 'checking' | 'ready' | 'unreachable'
  check: (name: string) => void
  t: Translate
  lang: 'zh' | 'en'
  /** Installed packs consuming this one — deleting it breaks their chains. */
  consumers: readonly string[]
  onDone: (doneText: string) => void
}) {
  const { t } = props
  const [armed, setArmed] = useState<'update' | 'delete' | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | undefined>(undefined)
  const run = (kind: 'update' | 'delete') => {
    setBusy(true)
    setError(undefined)
    const call = kind === 'update' ? updateManagedPack(props.pack.name) : deleteManagedPack(props.pack.name, props.consumers.length > 0)
    void call.then(
      version => props.onDone(kind === 'update' ? fill(t('updatedDone'), { version: typeof version === 'string' ? version : '' }) : t('deletedDone')),
      cause => setError(cause instanceof Error ? cause : new Error(String(cause))),
    ).finally(() => {
      setBusy(false)
      setArmed(undefined)
    })
  }
  // The standing renders for THIS card only, and only once its own check ran.
  const standing = props.checked && props.laneState === 'ready'
    ? (props.status === undefined || !props.status.onMarket
      ? t('notOnMarket')
      : props.status.updateAvailable ? fill(t('updateTo'), { version: props.status.marketVersion ?? '' }) : t('upToDate'))
    : null
  // The check button's faces: 检查更新 until a check reports a newer version,
  // then the two-step 更新; 检查中… while the round trip runs.
  const updateAvailable = props.checked && props.laneState === 'ready' && props.status !== undefined && props.status.onMarket && props.status.updateAvailable
  const checkLabel = props.checked && props.laneState === 'checking' ? t('checking')
    : updateAvailable ? (armed === 'update' ? t('confirmUpdate') : t('updateBtn'))
    : t('checkForUpdates')
  const rendered = rendered_error(error, props.lang)
  return h('span', { style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } satisfies CSSProperties },
    standing !== null ? h('span', { style: { ...muted, fontSize: '0.82rem' } satisfies CSSProperties }, standing) : null,
    h(Button, { size: 'sm', variant: 'ghost', disabled: busy || (props.checked && props.laneState === 'checking'),
      onClick: () => (updateAvailable ? (armed === 'update' ? run('update') : setArmed('update')) : props.check(props.pack.name)) },
      checkLabel),
    h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => (armed === 'delete' ? run('delete') : setArmed('delete')) },
      armed === 'delete' ? (props.consumers.length > 0 ? fill(t('confirmDeleteBreaks'), { packs: props.consumers.join(', ') }) : t('confirmDelete')) : t('deleteBtn')),
    busy ? h('span', { style: muted }, t('saving')) : null,
    rendered !== undefined ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary, crimson)', whiteSpace: 'pre-wrap' } satisfies CSSProperties },
      rendered.text,
      rendered.detail !== undefined ? h('span', { style: { ...muted, whiteSpace: 'pre-wrap' } }, `\n${rendered.detail}`) : null) : null)
}

/** renderError under its real name (a local alias keeps the call sites short). */
function rendered_error(error: Error | undefined, lang: 'zh' | 'en'): { text: string; detail?: string } | undefined {
  if (error === undefined) return undefined
  const coded = error as { code?: string; params?: Readonly<Record<string, string | number>>; detail?: string }
  return renderError({
    message: error.message,
    ...(coded.code !== undefined ? { code: coded.code } : {}),
    ...(coded.params !== undefined ? { params: coded.params } : {}),
    ...(coded.detail !== undefined ? { detail: coded.detail } : {}),
  }, lang)
}

/** Suites-tab lane state: the suite status rows, or the unreachable note. */
type SuitesLane = { state: 'ok' | 'unreachable'; rows: readonly UiSuiteStatus[] }

/** Suites view (docs/designs/pack-suites.md): one card per market suite,
 * each member row showing local vs market version. An empty list (the market
 * has no suites or does not support them) and an unreachable market each
 * render one explanatory line — never an error wall. Every action goes
 * through the section-level refresh, so the Packs tab re-renders in sync. */
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }
const thStyle: CSSProperties = { textAlign: 'left', padding: '6px 10px', color: secondary, fontWeight: 600, borderBottom: '1px solid var(--dsw-alias-border-l3, #ddd)' }
const tdStyle: CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l4, #eee)', verticalAlign: 'top' }

/** Suites tab: ONE table (same font as the rest of the page — no monospace
 * member rows). Columns: suite, members (local → market), status, actions.
 * The delete confirm is a single expanded line per suite: what goes, what
 * stays (only when something is kept, with the force switch next to it). */
function SuitesView(props: { lane: SuitesLane | undefined; payload: ParamsPayload; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onSaved: () => void }) {
  const { lane, t } = props
  if (lane === undefined) return null
  if (lane.state === 'unreachable') return h('p', { style: muted }, t('suitesUnreachable'))
  if (lane.rows.length === 0) return h('p', { style: muted }, t('suitesEmpty'))
  return h('table', { style: tableStyle },
    h('thead', null, h('tr', null,
      h('th', { style: thStyle }, t('colSuite')),
      h('th', { style: thStyle }, t('colMembers')),
      h('th', { style: thStyle }, t('actions')))),
    h('tbody', null, lane.rows.map(s => h(SuiteRows, { key: s.name, suite: s, packs: props.payload.packs, t, lang: props.lang, onSaved: props.onSaved }))))
}

function memberText(m: { name: string; localVersion?: string; marketVersion?: string; missing: boolean; updateAvailable: boolean }): ReturnType<typeof h> {
  if (m.localVersion === undefined) {
    return h('span', { key: m.name, style: { color: 'var(--dsw-alias-state-error-primary, crimson)', display: 'block' } },
      m.name, ' — ', h('span', null, m.marketVersion === undefined ? 'missing' : m.marketVersion))
  }
  const arrow = m.updateAvailable && m.marketVersion !== undefined
    ? h('span', { style: muted }, ' → ', m.marketVersion)
    : null
  return h('div', { key: m.name }, m.name, '@', m.localVersion, arrow)
}

function SuiteRows(props: { suite: UiSuiteStatus; packs: readonly UiPackEntry[]; t: Translate; lang: 'zh' | 'en'; onSaved: () => void }) {
  const { suite, t } = props
  const [armedDelete, setArmedDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [done, setDone] = useState<string | undefined>(undefined)
  const installed = suite.members.filter(m => m.localVersion !== undefined)
  const runUpdate = () => {
    setBusy(true); setError(undefined)
    void updateSuite(suite.name).then(result => {
      setDone(fill(t('suiteUpdateDone'), { packs: result.updated.map(u => `${u.name}@${u.version}`).join(', ') || t('upToDate') }))
      props.onSaved()
    }, cause => setError(cause instanceof Error ? cause : new Error(String(cause)))).finally(() => setBusy(false))
  }
  const runDelete = () => {
    setBusy(true); setError(undefined)
    void deleteSuite(suite.name).then(result => {
      setDone(fill(t('suiteDeletedDone'), { packs: result.deleted.join(', ') }))
      setArmedDelete(false)
      props.onSaved()
    }, cause => setError(cause instanceof Error ? cause : new Error(String(cause)))).finally(() => setBusy(false))
  }
  const rendered = rendered_error(error, props.lang)
  const actionsCell = h('td', { style: tdStyle },
    h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
      h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: runUpdate }, t('suiteUpdateBtn')),
      h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => setArmedDelete(v => !v) },
        armedDelete ? t('cancel') : t('deleteBtn')),
      busy ? h('span', { style: smallMuted }, t('saving')) : null,
      done !== undefined && !busy ? h('span', { style: smallMuted }, done) : null))
  const confirmRow = !armedDelete ? null : h('tr', null,
    h('td', { colSpan: 4, style: { ...tdStyle, background: 'var(--dsw-alias-bg-subtle, rgba(127,127,127,0.06))' } },
      h('div', null, fill(t('suiteDeleteSummary'), { packs: installed.map(m => m.name).join('、') || '—' })),
      h('div', { style: { ...actions, marginTop: '6px' } },
        h(Button, { size: 'sm', disabled: busy || installed.length === 0, onClick: runDelete }, t('suiteDeleteConfirm')),
        rendered !== undefined ? h(ErrorLine, { error: error as Error, lang: props.lang }) : null)))
  return h(Fragment, null,
    h('tr', null,
      h('td', { style: tdStyle },
        h('div', { style: { fontWeight: 600 } }, suite.name, ' ', h('span', { style: muted }, `v${suite.version}`)),
        suite.incomplete ? h('div', { style: muted }, t('suiteFillHint')) : null),
      h('td', { style: tdStyle }, suite.members.map(memberText)),
      actionsCell),
    confirmRow)
}

function ConfigView(props: { payload: ParamsPayload; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onSaved: () => void }) {
  const { payload, t } = props
  const entries = payload.config
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [switches, setSwitches] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [done, setDone] = useState(false)
  const toplevel = entries.filter(e => !e.key.includes('.') && e.type !== 'object')
  const advanced = entries.filter(e => e.key.startsWith('oscillation.') && e.type !== 'object')
  const draftOf = (e: UiConfigEntry): string => drafts[e.key] ?? (e.value === undefined ? '' : String(e.value))
  const dirty = entries.some(e => {
    if (e.type === 'boolean') return switches[e.key] !== undefined && switches[e.key] !== e.value
    if (e.type === 'object' || e.key.includes('.')) return false
    const draft = drafts[e.key]
    return draft !== undefined && draft !== (e.value === undefined ? '' : String(e.value))
  })
  const renderRow = (e: UiConfigEntry) => {
    const invalid = (() => {
      if (e.type === 'number' && drafts[e.key] !== undefined) {
        const n = Number(drafts[e.key])
        return drafts[e.key] !== '' && !Number.isFinite(n)
      }
      return false
    })()
    const control = e.type === 'boolean'
      ? h(Switch, {
          checked: switches[e.key] ?? e.value === true,
          onChange: (next: boolean) => setSwitches(prev => ({ ...prev, [e.key]: next })),
          label: e.key,
        })
      : e.choices !== undefined
        ? h('select', { value: draftOf(e) || String(e.value ?? ''), onChange: (ev: { target: { value: string } }) => setDrafts(prev => ({ ...prev, [e.key]: ev.target.value })), style: inputStyle },
            e.choices.map(c => h('option', { key: String(c), value: String(c) }, String(c))))
        : h(Input, { value: draftOf(e), type: e.type === 'number' ? 'number' : 'text', step: 'any', 'aria-invalid': invalid,
            onChange: (ev: { target: { value: string } }) => setDrafts(prev => ({ ...prev, [e.key]: ev.target.value })), style: inputStyle })
    return h('div', { key: e.key, className: `${NS}-row`, style: row },
      h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 } satisfies CSSProperties },
        h('div', { style: rowHead },
          h('span', { style: nameStyle }, e.key),
          h(Pill, {}, e.origin === 'configured' ? t('configured') : e.value === undefined ? t('unset') : t('inherited'))),
        e.description !== undefined ? h(DescriptionLine, { text: e.description, resolveText: props.resolveText }) : null,
        control,
        e.origin === 'default' && e.default !== undefined && String(e.default) !== String(e.value ?? '')
          ? h('div', { style: muted }, `${t('inherited')}: ${String(e.default)}`)
          : null,
        ))
  }
  const saveAll = async () => {
    const patch: Record<string, unknown> = {}
    for (const e of entries) {
      if (e.type === 'object' || e.key.includes('.')) continue
      if (e.type === 'boolean') {
        const next = switches[e.key]
        if (next !== undefined && next !== e.value) patch[e.key] = next
        continue
      }
      const draft = drafts[e.key]
      if (draft === undefined || draft === (e.value === undefined ? '' : String(e.value))) continue
      patch[e.key] = e.type === 'number' ? Number(draft) : draft === '' ? undefined : draft
    }
    if (Object.keys(patch).length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      await saveConfigPatch(patch)
      setDone(true)
      setDrafts({})
      setSwitches({})
      props.onSaved()
    } catch (saveError) {
      setError(saveError as Error)
    } finally {
      setBusy(false)
    }
  }
  const [showAdvanced, setShowAdvanced] = useState(false)
  return h('div', null,
    h('p', { style: muted }, t('configHint')),
    toplevel.map(e => renderRow(e)),
    advanced.length > 0
      ? h('div', { style: { marginTop: '8px' } },
          h(Button, { size: 'sm', variant: 'ghost', onClick: () => setShowAdvanced(v => !v) }, `${showAdvanced ? '▾' : '▸'} ${t('advanced')}`),
          showAdvanced ? advanced.map(e => renderRow(e)) : null)
      : null,
    h('div', { style: actions },
      h(Button, { size: 'sm', disabled: !dirty || busy, onClick: () => void saveAll() }, busy ? t('saving') : t('saveConfig')),
      done && !dirty ? h('span', { style: muted }, t('saved')) : null,
      error !== undefined ? h(ErrorLine, { error, lang: props.lang }) : null))
}

/** The section: one fetch cycle, four views (docs/designs/pack-suites.md). */
export function ParamsSection(props: { lang: string; resolveText: (value: unknown) => string }) {
  const lang = props.lang === 'zh' ? 'zh' : 'en'
  const t = useMemo<Translate>(() => translate(lang === 'zh' ? zh : en), [lang])
  const [payload, setPayload] = useState<ParamsPayload | undefined>(undefined)
  const [suites, setSuites] = useState<SuitesLane | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [view, setView] = useState<'packs' | 'suites' | 'groups' | 'config'>('packs')
  const refresh = useCallback(() => {
    fetchParams().then(p => {
      setPayload(p)
      setError(undefined)
    }).catch((e: Error) => setError(e))
    // The suite status rides the same refresh: any change in any view re-runs
    // BOTH fetches, so the Packs and Suites tabs always read the same state.
    // A suite-status failure is NOT a section failure — the Suites tab shows
    // one note while the other three views keep working.
    fetchSuiteStatus().then(rows => setSuites({ state: 'ok', rows }))
      .catch(() => setSuites(prev => ({ state: 'unreachable', rows: prev?.rows ?? [] })))
  }, [])
  useEffect(() => { refresh() }, [refresh])
  const suiteMarkers = useMemo(() => suitesByPack(suites?.rows ?? []), [suites])
  if (error !== undefined) {
    return h('div', { style: baseText },
      h('p', { style: { color: 'var(--dsw-alias-state-error-primary, crimson)', whiteSpace: 'pre-wrap' } },
        renderError(error as ApiError, lang).text),
      h('p', { style: muted }, error.message),
      h(Button, { size: 'sm', onClick: refresh }, t('retry')))
  }
  if (payload === undefined) return h('p', { style: { ...baseText, ...muted } }, t('loading'))
  // Packs first: the installed-pack overview is the landing view; suites,
  // params groups and the plugin form follow (docs/designs/pack-suites.md).
  const tabs = [
    { value: 'packs', label: t('viewPacks'), id: `${NS}-packs`, panelId: `${NS}-packs-panel` },
    { value: 'suites', label: t('viewSuites'), id: `${NS}-suites`, panelId: `${NS}-suites-panel` },
    { value: 'groups', label: t('viewGroups'), id: `${NS}-groups`, panelId: `${NS}-groups-panel` },
    { value: 'config', label: t('viewConfig'), id: `${NS}-config`, panelId: `${NS}-config-panel` },
  ] as const
  return h('div', { className: `${NS}-section`, style: baseText },
    h('h3', { style: { margin: '0 0 4px', ...baseText, fontWeight: 600 } }, t('title')),
    h('p', { style: { ...muted, margin: '0 0 8px' } }, t('intro')),
    h('div', { style: { margin: '8px 0 12px' } },
      h(SegmentedTabs, { items: [...tabs], value: view, onChange: v => setView(v as 'groups' | 'packs' | 'suites' | 'config'), label: t('title') })),
    view === 'groups' ? h(GroupsView, { payload, t, lang, resolveText: props.resolveText, onSaved: refresh }) : null,
    view === 'packs' ? h(PacksView, { payload, suites: suiteMarkers, t, lang, resolveText: props.resolveText, onSaved: refresh }) : null,
    view === 'suites' ? h(SuitesView, { lane: suites, payload, t, lang, resolveText: props.resolveText, onSaved: refresh }) : null,
    view === 'config' ? h(ConfigView, { payload, t, lang, resolveText: props.resolveText, onSaved: refresh }) : null)
}
