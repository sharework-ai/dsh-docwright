/**
 * The Docwright params section: three views over one catalog fetch — the
 * installed list (suite cards with their read-only member rows first, then
 * standalone packs — docs/designs/pack-suites.md), shared-param groups (the
 * aggregation with effective-source resolution), and the plugin Config
 * form. Controls map from the
 * ParamSpec type (number → numeric input, enum → select, boolean → switch,
 * object → JSON-per-value with endpoints read-only); every parameter shows
 * its author's description inline beneath the name, resolved to the active
 * locale by the host's `locale.resolveText` (LocalizedText from the RPC,
 * en-fallback semantics of src/description.ts). Writes go through the
 * plugin's own routes (src/http.ts), never the conversation; their error
 * envelopes render through the locale catalog (locales.ts renderError). Any
 * change in ANY view re-fetches the whole block, so the suite cards and the
 * standalone pack list can never disagree.
 *
 * Styling: Tailwind utilities compiled from styles.css (injected once as
 * client/client.css — see index.tsx). Accent colors come from the pack
 * market's palette (@theme there); neutral surfaces, text and borders stay
 * on the host's --dsw-alias-* tokens via arbitrary values, so light/dark
 * follows the shell. Typography follows the host conversation body, not
 * ad-hoc sizes: one family and size for all running text (the .dw-root
 * component class); hierarchy comes from weight and the host's label grays,
 * never from font size. Only identifiers and values (param names, enum
 * members, JSON) sit in the host code face (.dw-code).
 */
import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Pill, SegmentedTabs, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { deleteManagedPack, deleteSuite, fetchPackUpdates, fetchParams, fetchSuiteStatus, saveConfigPatch, savePackParam, setPackDisabled, updateManagedPack, updateSuite } from './api.ts'
import { DEPENDS_ICON_PATH, icon, SUITE_ICON_PATH } from './icons.ts'
import type { ApiError } from './api.ts'
import type { ParamsPayload, UiConfigEntry, UiPackEntry, UiPackUpdate, UiParamDeclaration, UiShadowedCopy, UiSuiteStatus } from './api.ts'
import { en, fill, renderError, translate, zh } from './locales.ts'
import type { Translate } from './locales.ts'
import { resolveLocalized } from '../description.ts'
import type { LocalizedText } from '../description.ts'

const NS = 'docwright-params'

//#region class vocabulary
/** The host's first muted gray (real theme token). */
const muted = 'text-[var(--dsw-alias-label-secondary,inherit)]'
const smallMuted = `${muted} text-[0.82rem]`
/** Host state red (the market's danger is the same #dc2626 family). */
const errorText = 'text-[var(--dsw-alias-state-error-primary,#dc2626)]'
/** Host code face, via the styles.css component class. */
const code = 'dw-code'
/** Host code face + semibold: names and identifiers. */
const name = `${code} font-semibold`
const row = 'flex items-center gap-2 py-1.5'
const rowHead = 'flex flex-wrap items-baseline gap-2 min-w-0'
const desc = `${muted} whitespace-pre-wrap break-words`
/** The shared card shell: hairline border, host radius, second-layer fill. */
const card = 'border-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] rounded-[var(--dsw-radius-xl,20px)] bg-[var(--dsw-alias-bg-layer-2,transparent)] px-4 py-3 mb-3 overflow-hidden'
/** The pack card's full-width header band: a quiet wash in the market's
 * primary blue that separates "which pack am I looking at" from the rows. */
const packHead = `${rowHead} -mx-4 -my-3 mb-2.5 px-4 py-2.5 bg-[color-mix(in_srgb,var(--color-primary)_7%,transparent)]`
const actions = 'flex items-center gap-2 mt-2'
/** Gray rounded chip: the shared container for a dependency or a member
 * pack. Translucent gray reads on both themes and, being a plain background,
 * never intercepts clicks. Missing renders the red variant. */
const chip = 'inline-flex rounded-full px-2 py-px text-[0.82rem] whitespace-nowrap border'
// Interactive chip: the theme's primary blue in a quiet tint — gray read as
// "disabled, not clickable", which is wrong for dependency and member chips
// that open their target in place. Hover deepens the tint (an affordance the
// red/amber variants deliberately keep off — they are states, not links).
const chipOk = `${chip} bg-[rgba(21,93,252,0.08)] border-[rgba(21,93,252,0.35)] text-[var(--color-primary,#155dfc)] hover:bg-[rgba(21,93,252,0.16)]`
const chipMissing = `${chip} bg-[rgba(197,48,48,0.10)] border-[rgba(197,48,48,0.38)] ${errorText}`
/** Suite chips keep the market suite cards' translucent purple. */
const suiteChip = `${chip} gap-1 items-center cursor-pointer bg-[rgba(147,51,234,0.12)] border-[rgba(147,51,234,0.38)]`
/** The external-reference mark: a suite member consumed by packs OUTSIDE its
 * suite (delete-time impact; the consumer list is named in the delete
 * confirm, never on the row). */
const chipExternal = `${chip} cursor-pointer bg-[rgba(212,140,34,0.12)] border-[rgba(212,140,34,0.55)]`
//#endregion

/** Anchor ids of the pack and suite cards (jump targets for the chips). The
 * pack anchor carries the ORIGIN ROOT: two same-code packs from different
 * roots (cross-root shadowing) must never collide on one id — the code alone
 * is not the full identity (org/name on the market, root/name locally). */
const packAnchorId = (origin: { root: string }, name: string): string => `docwright-pack-${name}-${origin.root}`
const suiteAnchorId = (name: string): string => `docwright-suite-${name}`

/** The author's description, inline beneath the parameter name — the primary
 * explanation stays in view instead of hiding behind a hover. Locale
 * resolution: the host's resolveText when available, its semantics locally
 * otherwise (src/description.ts). */
function DescriptionLine(props: { text: LocalizedText | undefined; resolveText: (value: unknown) => string }) {
  return h('div', { className: `${NS}-desc ${desc} mt-0.5` }, props.resolveText(props.text ?? ''))
}

/** One failing write/load as text + optional raw detail line. */
function ErrorLine(props: { error: Error; lang: 'zh' | 'en'; muted?: boolean }) {
  const rendered = renderError(props.error as { message: string; code?: string; params?: Readonly<Record<string, string | number>>; detail?: string }, props.lang)
  return h('span', { className: `${errorText} whitespace-pre-wrap` },
    rendered.text,
    rendered.detail !== undefined ? h('span', { className: `${muted} whitespace-pre-wrap` }, `\n${rendered.detail}`) : null)
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
  return flags.length === 0 ? null : h('div', { className: 'flex gap-1 flex-wrap' },
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
  return bits.length === 0 ? null : h('div', { className: muted }, bits.join(' · '))
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
function ValueRow(props: { d: UiParamDeclaration; t: Translate; lang: 'zh' | 'en'; onSaved?: (() => void) | undefined; origin?: { kind: string; root: string } | undefined }) {
  const { d, t } = props
  if (d.role === 'shadowed') {
    return h('div', { className: rowHead },
      h('span', { className: `${code} ${muted} line-through` }, displayDefault(d, t)),
      h(Pill, {}, fill(t('shadowedByNote'), { pack: d.shadowedBy ?? '' })))
  }
  return h(EditSeat, { d, t, lang: props.lang, onSaved: props.onSaved, origin: props.origin })
}

/** The staged-edit control for a source declaration. `origin` (when known)
 * echoes the card's rendered pack origin so the server can refuse a write
 * whose target moved underneath the card (seen-vs-written guard). */
function EditSeat(props: { d: UiParamDeclaration; t: Translate; lang: 'zh' | 'en'; onSaved?: (() => void) | undefined; origin?: { kind: string; root: string } | undefined }) {
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
      await savePackParam(d.pack, d.name, value, props.origin)
      setEditing(false)
      props.onSaved?.()
    } catch (saveError) {
      setError(saveError as Error)
    } finally {
      setBusy(false)
    }
  }
  const valueLine = h('div', { className: rowHead },
    h('span', { className: code }, displayDefault(d, t)),
    editing ? null : h(Button, { size: 'sm', variant: 'ghost', onClick: start }, t('edit')))
  if (!editing) return valueLine
  return h('div', null,
    d.enumValues !== undefined
      ? h('select', { value: String(d.default), onChange: (e: { target: { value: string } }) => setDraft(e.target.value), className: 'w-40' },
          d.enumValues.map(v => h('option', { key: String(v), value: String(v) }, String(v))))
      : d.type === 'object'
        ? h('textarea', { value: draft, onChange: (e: { target: { value: string } }) => setDraft(e.target.value), rows: 4,
            className: `w-full max-w-[480px] ${code}` })
        : h(Input, { value: draft, type: d.type === 'number' ? 'number' : 'text', step: 'any',
            onChange: (e: { target: { value: string } }) => setDraft(e.target.value), style: { width: '160px' } }),
    h('div', { className: actions },
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
function ParamGroupCard(props: { name: string; declarations: readonly UiParamDeclaration[]; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onSaved: () => void; rootOf: (pack: string) => UiPackEntry | undefined; onJump: (view: 'packs' | 'suites', anchor: string) => void }) {
  const { name, declarations, t } = props
  const governing = declarations.find(d => d.role === 'source') ?? declarations[0]!
  const shadowed = declarations.filter(d => d !== governing)
  const originOf = (pack: string) => props.rootOf(pack)?.origin
  return h('div', { className: card },
    h('div', { className: rowHead },
      h('span', { className: name }, name),
      h(FlagPills, { d: governing, t })),
    h(DescriptionLine, { text: governing.description, resolveText: props.resolveText }),
    h('div', { className: 'flex items-center gap-2 mt-1' },
      h('span', { className: muted }, `${t('sources')}:`),
      declarations.filter(d => d.role === 'source').map(d => {
        const origin = originOf(d.pack)
        return h('span', {
          key: d.pack,
          title: origin === undefined ? d.pack : `${d.pack} · ${origin.kind} ${origin.root}`,
          onClick: origin !== undefined ? () => props.onJump('packs', packAnchorId(origin, d.pack)) : undefined,
          className: origin !== undefined ? `${chipOk} cursor-pointer` : chipOk,
        }, d.pack)
      })),
    h(ValueRow, { d: governing, t, lang: props.lang, onSaved: props.onSaved, origin: originOf(governing.pack) }),
    h('div', { className: 'mt-0.5' },
      h(ConstraintLine, { d: governing, t })),
    shadowed.length > 0
      ? h('div', { className: `${muted} mt-1` },
          fill(t('shadowedNote'), { packs: shadowed.map(d => d.pack).join(', ') }))
      : null)
}

/** Aggregated parameter view: one card per parameter name. */
function GroupsView(props: { payload: ParamsPayload; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onSaved: () => void; onJump: (view: 'packs' | 'suites', anchor: string) => void }) {
  const { payload, t } = props
  const rootOf = useCallback((pack: string) => payload.packs.find(p => p.name === pack), [payload.packs])
  if (payload.groups.length === 0) return h('p', { className: muted }, t('empty'))
  return h('div', null, payload.groups.map(g => h(ParamGroupCard, { key: g.name, name: g.name, declarations: g.declarations, t, lang: props.lang, resolveText: props.resolveText, onSaved: props.onSaved, rootOf, onJump: props.onJump })))
}

/** One declaration row inside a pack's card. Source rows carry the edit seat; shadowed rows strike their never-applied value through. */
function PackDeclRow(props: { d: UiParamDeclaration; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onSaved: () => void; origin?: { kind: string; root: string } | undefined }) {
  const { d, t } = props
  return h('div', { className: `${NS}-row ${row}` },
    h('div', { className: 'flex flex-col flex-1 min-w-0' },
      h('div', { className: rowHead },
        h('span', { className: name }, d.name),
        h(FlagPills, { d, t })),
      h(DescriptionLine, { text: d.description, resolveText: props.resolveText }),
      h(ValueRow, { d, t, lang: props.lang, onSaved: props.onSaved, origin: props.origin }),
      h('div', { className: 'mt-0.5' },
        h(ConstraintLine, { d, t }))))
}

/** Which installed suites a pack belongs to, keyed by pack name (derived
 * once per suites fetch; a pure display marker on the pack card). */
/** Trigger a same-origin ZIP download (the packaging route answers the raw
 * bytes; an <a download> anchor would work too, but a Button keeps the card
 * actions uniform). */
function downloadZipFile(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

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

/** Per-suite external consumers: for each member, the installed packs that
 * consume it and are NOT suite members themselves (the delete-time impact
 * list; a member with entries renders the external-reference mark). */
function externalConsumersOf(suite: UiSuiteStatus, packs: readonly UiPackEntry[]): ReadonlyMap<string, readonly string[]> {
  const members = new Set(suite.members.map(m => m.name))
  const map = new Map<string, string[]>()
  for (const member of suite.members) {
    const consumers = packs
      .filter(p => p.name !== member.name && !members.has(p.name) && p.consumes.includes(member.name))
      .map(p => p.name)
    if (consumers.length > 0) map.set(member.name, consumers)
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
function PacksView(props: { payload: ParamsPayload; suites: ReadonlyMap<string, readonly string[]>; suitesLane: SuitesLane | undefined; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onJump: (view: 'packs' | 'suites', anchor: string) => void; onSaved: () => void }) {
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
  const disabledNames = useMemo(() => new Set(payload.disabledPacks ?? []), [payload.disabledPacks])
  /** Active-card lookup by code (dependency chips and the groups view jump
   * through it; the anchor carries the origin root so same-code copies never
   * collide). */
  const rootOf = useCallback((pack: string) => payload.packs.find(p => p.name === pack), [payload.packs])
  /** Same-name copies that lost the cross-root clash, grouped by code. */
  const shadowedByName = useMemo(() => {
    const map = new Map<string, UiShadowedCopy[]>()
    for (const copy of payload.shadowedPacks ?? []) {
      const list = map.get(copy.name)
      if (list === undefined) map.set(copy.name, [copy])
      else list.push(copy)
    }
    return map
  }, [payload.shadowedPacks])
  /** A suite member's FULL pack card, rendered nested inside its suite card
   * (params stay editable there; lane actions stay hidden — the suite owns
   * install/update/delete). */
  const renderMemberCard = (name: string) => {
    const pack = payload.packs.find(p => p.name === name)
    if (pack === undefined) return null
    return h(PackCard, { key: `${pack.name}-${pack.origin.root}`, pack, status: byName.get(pack.name), checked: byName.has(pack.name), laneState: lane.state, checkOne, t, lang: props.lang, flat: true,
      resolveText: props.resolveText, onJump: props.onJump, onSaved: props.onSaved, installed: installedNames, suites: props.suites.get(pack.name) ?? [],
      consumers: payload.packs.filter(other => other.name !== pack.name && other.consumes.includes(pack.name)).map(other => other.name),
      disabled: disabledNames.has(pack.name),
      shadowed: shadowedByName.get(pack.name) ?? [],
      rootOf,
      onDone: text => { setLaneDone(text); props.onSaved(); checkOne(pack.name) } })
  }
  // One list, two nestings (docs/designs/pack-suites.md): installed suites
  // with their member rows first — a member NEVER also renders standalone —
  // then the packs outside any suite. An unreachable market keeps the
  // standalone list fully working; the suite note is one muted line.
  const standalone = payload.packs.filter(p => (props.suites.get(p.name) ?? []).length === 0)
  const suiteRows = props.suitesLane?.state === 'ok' ? props.suitesLane.rows : []
  return h('div', null,
    lane.state === 'unreachable' ? h('p', { className: muted }, t('updateCheckFailed')) : null,
    laneDone !== undefined ? h('p', { className: muted }, laneDone) : null,
    suiteRows.length > 0
      ? [h('h4', { key: 'suites-head', className: `${muted} m-0 mb-2 font-semibold` }, t('suitesSection')),
        ...suiteRows.map(s => h(SuiteCard, { key: `${s.org ?? ''}-${s.name}`, suite: s, packs: payload.packs, t, lang: props.lang, resolveText: props.resolveText, onJump: props.onJump, onSaved: props.onSaved, renderMember: renderMemberCard }))]
      : props.suitesLane !== undefined
        ? h('p', { key: 'suites-empty', className: muted }, props.suitesLane.state === 'unreachable' ? t('suitesUnreachable') : t('suitesEmpty'))
        : null,
    standalone.length > 0 && suiteRows.length > 0
      ? h('h4', { key: 'packs-head', className: `${muted} mt-3 mb-2 font-semibold` }, t('packsSection'))
      : null,
    standalone.map((p: UiPackEntry) => h(PackCard, { key: `${p.name}-${p.origin.root}`, pack: p, status: byName.get(p.name), checked: byName.has(p.name), laneState: lane.state, checkOne, t, lang: props.lang,
      resolveText: props.resolveText, onJump: props.onJump, onSaved: props.onSaved, installed: installedNames, suites: props.suites.get(p.name) ?? [],
      consumers: payload.packs.filter(other => other.name !== p.name && other.consumes.includes(p.name)).map(other => other.name),
      disabled: disabledNames.has(p.name),
      shadowed: shadowedByName.get(p.name) ?? [],
      rootOf,
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
  /** Switch tabs and scroll to a card anchor (suite/dependency chips). */
  onJump: (view: 'packs' | 'suites', anchor: string) => void
  consumers: readonly string[]
  /** True when the config's disabledPacks array lists this pack (docs/designs/pack-load-dirs.md). */
  disabled: boolean
  /** Same-name copies this card's copy shadows (cross-root clash losers). */
  shadowed: readonly UiShadowedCopy[]
  /** Active-card lookup by code (dependency chips jump through it). */
  rootOf: (pack: string) => UiPackEntry | undefined
  /** Nested-inside-a-suite rendering: no rounded card chrome — the suite
   * card already draws the top divider, so the member reads as a section of
   * its parent instead of a box-in-a-box. */
  flat?: boolean
  onDone: (doneText: string) => void
}) {
  const { pack, t } = props
  const [paramsOpen, setParamsOpen] = useState(false)
  const [shadowedOpen, setShadowedOpen] = useState(false)
  // Qualified identity: org/name@version when a check has reported the
  // market's org, root-local name@version otherwise.
  const qualified = props.status?.org !== undefined ? `${props.status.org}/${pack.name}@v${pack.version}` : `${pack.name}@v${pack.version}`
  return h('div', { id: packAnchorId(pack.origin, pack.name), className: props.flat === true ? 'mt-0.5' : card },
    h('div', { className: props.flat === true ? rowHead : packHead },
      h('span', { className: name, title: qualified }, pack.name),
      pack.author !== undefined ? h(Pill, { title: qualified }, pack.author) : null,
      h(Pill, {}, `v${pack.version}`),
      h(Pill, {}, pack.scope === 'workspace' ? t('scopeWorkspace') : t('scopeTopic')),
      pack.origin.kind === 'builtin' ? h(Pill, {}, t('originBuiltin')) : null,
      pack.paramDriftPolicy !== undefined ? h(Pill, {}, `${t('driftPolicy')}: ${pack.paramDriftPolicy}`) : null,
      props.disabled ? h(Pill, {}, t('disabledPill')) : null),
    h('div', { className: `${desc} mb-1` }, props.resolveText(pack.description)),
    pack.consumes.length > 0 || props.suites.length > 0
      ? h('div', { className: `${muted} mt-1 flex gap-1.5 flex-wrap items-center` },
        pack.consumes.length > 0
          ? h('span', { className: 'inline-flex gap-1.5 items-center flex-wrap' },
            h('span', { title: t('consumed'), className: 'inline-flex items-center' },
              icon(DEPENDS_ICON_PATH)),
            pack.consumes.map(dep => {
              const depPack = props.rootOf(dep)
              const installed = depPack !== undefined
              const origin = depPack?.origin
              return h('span', {
                key: dep,
                title: installed ? (origin !== undefined ? `${dep} · ${origin.kind} ${origin.root}` : dep) : `${dep}${t('missingDep')}`,
                // An installed dependency jumps to its pack card; a missing
                // one cannot go anywhere, it just reads red.
                onClick: installed && origin !== undefined ? () => props.onJump('packs', packAnchorId(origin, dep)) : undefined,
                className: installed ? `${chipOk} cursor-pointer` : chipMissing,
              }, dep)
            }))
          : null,
        pack.consumes.length > 0 && props.suites.length > 0
          ? h('span', { className: 'opacity-60' }, '·')
          : null,
        props.suites.map(suite => h('span', {
          key: suite,
          title: t('suiteManagedTip'),
          onClick: () => props.onJump('packs', suiteAnchorId(suite)),
          className: suiteChip,
        },
          h('span', { className: 'inline-flex items-center' },
            icon(SUITE_ICON_PATH, 12)),
          suite)))
      : null,
    h('div', { className: 'mt-1 flex gap-2 items-center flex-wrap' },
      h(Button, { size: 'sm', variant: 'ghost', onClick: () => setParamsOpen(v => !v) },
        `${paramsOpen ? '▾' : '▸'} ${t('paramsToggle')}`),
      // Suite members are managed through their suite (the Suites tab owns
      // install/update/delete): no per-pack lane buttons for them.
      pack.origin.kind === 'packsDir' && props.suites.length === 0
        ? h(PackLaneActions, { pack, status: props.status, checked: props.checked, laneState: props.laneState, check: props.checkOne, t, lang: props.lang,
          consumers: props.consumers, disabled: props.disabled, onDone: props.onDone })
        : null),
    paramsOpen
      ? h('div', { className: 'mt-1.5 border-t-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] pt-1.5' },
        pack.params.length === 0
          ? h('p', { className: muted }, t('empty'))
          : pack.params.map(d => h(PackDeclRow, { key: d.name, d, t, lang: props.lang, resolveText: props.resolveText, onSaved: props.onSaved, origin: pack.origin })))
      : null,
    props.shadowed.length > 0
      ? h('div', { className: 'mt-1.5 border-t-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] pt-1.5' },
        h('div', { className: rowHead },
          h(Pill, { title: t('shadowedCopiesTitle') }, fill(t('shadowedCopiesPill'), { count: props.shadowed.length })),
          h(Button, { size: 'sm', variant: 'ghost', onClick: () => setShadowedOpen(v => !v) },
            `${shadowedOpen ? '▾' : '▸'} ${t('shadowedCopiesTitle')}`)),
        shadowedOpen
          ? props.shadowed.map((copy, i) => h('div', { key: `${copy.dir}-${i}`, className: `${smallMuted} mt-0.5`, title: copy.dir },
            `${copy.origin.kind} · ${copy.origin.root} · v${copy.version}`))
          : null)
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
  /** True when the config's disabledPacks array lists this pack (docs/designs/pack-load-dirs.md). */
  disabled: boolean
  onDone: (doneText: string) => void
}) {
  const { t } = props
  const [armed, setArmed] = useState<'update' | 'delete' | 'disable' | 'enable' | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | undefined>(undefined)
  const run = (kind: 'update' | 'delete' | 'disable' | 'enable', updateForce = false) => {
    setBusy(true)
    setError(undefined)
    const call = kind === 'update' ? updateManagedPack(props.pack.name, updateForce)
      : kind === 'delete' ? deleteManagedPack(props.pack.name, props.consumers.length > 0)
      : setPackDisabled(props.pack.name, kind === 'disable', props.consumers.length > 0 && kind === 'disable')
    const doneText = kind === 'update' ? undefined : kind === 'disable' ? t('disableDone') : kind === 'enable' ? t('enableDone') : t('deletedDone')
    void call.then(
      result => props.onDone(kind === 'update' ? fill(t('updatedDone'), { version: typeof result === 'string' ? result : '' }) : doneText ?? ''),
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
  // A compatBreak refusal arms the force path: the NEXT confirm click sends
  // force: true (label flips to 仍要更新), answering the server's named
  // consumers warning. The flag lives in the error — a fresh result resets it.
  const compatBlocked = (error as { code?: string } | undefined)?.code === 'compatBreak'
  const checkLabel = props.checked && props.laneState === 'checking' ? t('checking')
    : updateAvailable ? (armed === 'update' ? (compatBlocked ? t('confirmForceUpdate') : t('confirmUpdate')) : t('updateBtn'))
    : t('checkForUpdates')
  const rendered = rendered_error(error, props.lang)
  return h('span', { className: 'inline-flex gap-2 items-center' },
    standing !== null ? h('span', { className: smallMuted }, standing) : null,
    h(Button, { size: 'sm', variant: 'ghost', disabled: busy || (props.checked && props.laneState === 'checking'),
      onClick: () => (updateAvailable ? (armed === 'update' ? run('update', compatBlocked) : setArmed('update')) : props.check(props.pack.name)) },
      checkLabel),
    h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => (armed === 'delete' ? run('delete') : setArmed('delete')) },
      armed === 'delete' ? (props.consumers.length > 0 ? fill(t('confirmDeleteBreaks'), { packs: props.consumers.join(', ') }) : t('confirmDelete')) : t('deleteBtn')),
    h(Button, { size: 'sm', variant: 'ghost', title: t('zipBtn'), onClick: () => downloadZipFile(`/api/docwright/pack-zip?pack=${encodeURIComponent(props.pack.name)}`, `${props.pack.name}.zip`) }, t('zipBtn')),
    h(Button, { size: 'sm', variant: 'ghost', disabled: busy,
      onClick: () => {
        const kind = props.disabled ? 'enable' : 'disable'
        armed === kind ? run(kind) : setArmed(kind)
      } },
      props.disabled
        ? (armed === 'enable' ? t('confirmEnable') : t('enableBtn'))
        : (armed === 'disable' ? (props.consumers.length > 0 ? fill(t('confirmDisableBreaks'), { packs: props.consumers.join(', ') }) : t('confirmDisable')) : t('disableBtn'))),
    busy ? h('span', { className: muted }, t('saving')) : null,
    rendered !== undefined ? h('span', { className: `${errorText} whitespace-pre-wrap` },
      rendered.text,
      rendered.detail !== undefined ? h('span', { className: `${muted} whitespace-pre-wrap` }, `\n${rendered.detail}`) : null) : null)
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

/** Suites lane state: the suite status rows, or the unreachable note. */
type SuitesLane = { state: 'ok' | 'unreachable'; rows: readonly UiSuiteStatus[] }

/** One suite card INSIDE the packs view (docs/designs/pack-suites.md): the
 * suite is a grouping of the one installed list, not a separate tab. Member
 * rows are read-only — install/update/delete go through the suite buttons;
 * a member chip click expands the member's full pack card in place (its
 * parameter declarations stay editable there, its lane actions stay hidden).
 * Members with consumers OUTSIDE the suite carry the external-reference
 * mark; deleting such a suite needs the force box (the confirm area names
 * the affected consumers). A compatBreak refusal on 更新套件 arms one force
 * re-run that answers the server's aggregated warning. */
function SuiteCard(props: { suite: UiSuiteStatus; packs: readonly UiPackEntry[]; t: Translate; lang: 'zh' | 'en'; resolveText: (value: unknown) => string; onJump: (view: 'packs' | 'suites', anchor: string) => void; onSaved: () => void; renderMember: (name: string) => ReturnType<typeof h> | null }) {
  const { suite, t, resolveText } = props
  const [armedDelete, setArmedDelete] = useState(false)
  const [forceDelete, setForceDelete] = useState(false)
  const [openMember, setOpenMember] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [done, setDone] = useState<string | undefined>(undefined)
  const installed = suite.members.filter(m => m.localVersion !== undefined)
  const external = useMemo(() => externalConsumersOf(suite, props.packs), [suite, props.packs])
  const needsForce = external.size > 0
  const compatBlocked = (error as { code?: string } | undefined)?.code === 'compatBreak'
  const runUpdate = (force: boolean) => {
    setBusy(true); setError(undefined)
    void updateSuite(suite.name, force).then(result => {
      setDone(fill(t('suiteUpdateDone'), { packs: result.updated.map(u => `${u.name}@${u.version}`).join(', ') || t('upToDate') }))
      props.onSaved()
    }, cause => setError(cause instanceof Error ? cause : new Error(String(cause)))).finally(() => setBusy(false))
  }
  const runDelete = () => {
    setBusy(true); setError(undefined)
    void deleteSuite(suite.name, forceDelete).then(result => {
      setDone(fill(t('suiteDeletedDone'), { packs: result.deleted.join(', ') }))
      setArmedDelete(false)
      props.onSaved()
    }, cause => setError(cause instanceof Error ? cause : new Error(String(cause)))).finally(() => setBusy(false))
  }
  const rendered = rendered_error(error, props.lang)
  const installedNames = new Set(props.packs.map(p => p.name))
  return h('div', { id: suiteAnchorId(suite.name), className: card },
    h('div', { className: `${rowHead} mb-0.5`, title: suite.org !== undefined && suite.org !== '' ? `${suite.org}/${suite.name}@v${suite.version}` : `${suite.name}@v${suite.version}` },
      suite.org !== undefined && suite.org !== '' ? h('span', { className: `${muted} font-normal` }, `${suite.org}/`) : null,
      suite.name, ' ', h('span', { className: muted }, `v${suite.version}`),
      suite.incomplete ? h('span', { className: smallMuted }, t('suiteFillHint')) : null),
    h('div', { className: `${desc} mb-1` }, resolveText(suite.description)),
    h('div', null,
      h('div', { className: `${muted} mt-1 flex gap-1.5 flex-wrap items-center` },
        h('span', { title: t('colMembers'), className: 'inline-flex items-center' },
          icon(SUITE_ICON_PATH)),
        suite.members.map(m => {
          const referenced = external.has(m.name)
          const isOpen = openMember === m.name
          return h('span', {
            key: m.name,
            title: referenced ? `${m.name}: ${t('suiteExternalRef')}` : m.name,
            // An installed member expands its full pack card in place; a
            // missing one reads red and cannot go anywhere.
            onClick: installedNames.has(m.name) ? () => setOpenMember(isOpen ? undefined : m.name) : undefined,
            className: installedNames.has(m.name) === false ? chipMissing : referenced ? chipExternal : `${chipOk} cursor-pointer${isOpen ? ' font-semibold' : ''}`,
          }, m.localVersion === undefined ? m.name : `${m.name}@${m.localVersion}${referenced ? ' ↗' : ''}`)
        })),
      h('div', { className: actions },
        h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => runUpdate(compatBlocked) },
          compatBlocked ? t('confirmForceUpdate') : t('suiteUpdateBtn')),
        h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => { setArmedDelete(v => !v); setForceDelete(false) } },
          armedDelete ? t('cancel') : t('deleteBtn')),
        h(Button, { size: 'sm', variant: 'ghost', title: t('zipBtn'), onClick: () => downloadZipFile(`/api/docwright/suite-zip?suite=${encodeURIComponent(suite.name)}`, `${suite.name}.zip`) }, t('zipBtn')),
        busy ? h('span', { className: smallMuted }, t('saving')) : null,
        done !== undefined && !busy ? h('span', { className: smallMuted }, done) : null,
        rendered !== undefined ? h(ErrorLine, { error: error as Error, lang: props.lang }) : null),
      armedDelete
        ? h('div', { className: `${smallMuted} mt-1.5 border-t-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] pt-1.5` },
          fill(t('suiteDeleteSummary'), { packs: installed.map(m => m.name).join('、') || '—' }),
          needsForce
            ? h('div', { className: 'mt-1' },
                fill(t('suiteExternalMembers'), { list: [...external.entries()].map(([m, cs]) => `${m} ← ${cs.join(', ')}`).join('；') }),
                h('label', { className: 'mt-1 flex items-center gap-1.5 cursor-pointer' },
                  h('input', { type: 'checkbox', checked: forceDelete, onChange: (e: { target: { checked: boolean } }) => setForceDelete(e.target.checked) }),
                  t('suiteForce')))
            : null,
          h('div', { className: 'mt-1.5' },
            h(Button, { size: 'sm', disabled: busy || installed.length === 0 || (needsForce && !forceDelete), onClick: runDelete }, t('suiteDeleteConfirm'))))
        : null,
      openMember !== undefined
        ? h('div', { className: 'mt-1.5 border-t-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] pt-1.5' },
            props.renderMember(openMember) ?? h('p', { className: muted }, openMember))
        : null))
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
        ? h('select', { value: draftOf(e) || String(e.value ?? ''), onChange: (ev: { target: { value: string } }) => setDrafts(prev => ({ ...prev, [e.key]: ev.target.value })), className: 'w-40' },
            e.choices.map(c => h('option', { key: String(c), value: String(c) }, String(c))))
        : h(Input, { value: draftOf(e), type: e.type === 'number' ? 'number' : 'text', step: 'any', 'aria-invalid': invalid,
            onChange: (ev: { target: { value: string } }) => setDrafts(prev => ({ ...prev, [e.key]: ev.target.value })), style: { width: '160px' } })
    return h('div', { key: e.key, className: `${NS}-row ${row}` },
      h('div', { className: 'flex flex-col flex-1 min-w-0' },
        h('div', { className: rowHead },
          h('span', { className: name }, e.key),
          h(Pill, {}, e.origin === 'configured' ? t('configured') : e.value === undefined ? t('unset') : t('inherited'))),
        e.description !== undefined ? h(DescriptionLine, { text: e.description, resolveText: props.resolveText }) : null,
        control,
        e.origin === 'default' && e.default !== undefined && String(e.default) !== String(e.value ?? '')
          ? h('div', { className: muted }, `${t('inherited')}: ${String(e.default)}`)
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
    h('p', { className: muted }, t('configHint')),
    toplevel.map(e => renderRow(e)),
    advanced.length > 0
      ? h('div', { className: 'mt-2' },
          h(Button, { size: 'sm', variant: 'ghost', onClick: () => setShowAdvanced(v => !v) }, `${showAdvanced ? '▾' : '▸'} ${t('advanced')}`),
          showAdvanced ? advanced.map(e => renderRow(e)) : null)
      : null,
    h('div', { className: actions },
      h(Button, { size: 'sm', disabled: !dirty || busy, onClick: () => void saveAll() }, busy ? t('saving') : t('saveConfig')),
      done && !dirty ? h('span', { className: muted }, t('saved')) : null,
      error !== undefined ? h(ErrorLine, { error, lang: props.lang }) : null))
}

/** The section: one fetch cycle, three views (docs/designs/pack-suites.md). */
export function ParamsSection(props: { lang: string; resolveText: (value: unknown) => string }) {
  const lang = props.lang === 'zh' ? 'zh' : 'en'
  const t = useMemo<Translate>(() => translate(lang === 'zh' ? zh : en), [lang])
  const [payload, setPayload] = useState<ParamsPayload | undefined>(undefined)
  const [suites, setSuites] = useState<SuitesLane | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [view, setView] = useState<'packs' | 'groups' | 'config'>('packs')

  /** Chip jumps: the suites live inside the packs view now, so a legacy
   * 'suites' target lands there too; then scroll the anchored card into view
   * once it has rendered (one frame is enough for React). */
  const jumpTo = useCallback((rawTarget: 'packs' | 'suites', anchor: string) => {
    setView(rawTarget === 'suites' ? 'packs' : rawTarget)
    window.setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
  }, [])
  const refresh = useCallback(() => {
    fetchParams().then(p => {
      setPayload(p)
      setError(undefined)
    }).catch((e: Error) => setError(e))
    // The suite status rides the same refresh: any change in any view re-runs
    // BOTH fetches, so the suite cards and the standalone list always read
    // the same state. A suite-status failure is NOT a section failure — the
    // suites section shows one note while the other views keep working.
    fetchSuiteStatus().then(rows => setSuites({ state: 'ok', rows }))
      .catch(() => setSuites(prev => ({ state: 'unreachable', rows: prev?.rows ?? [] })))
  }, [])
  useEffect(() => { refresh() }, [refresh])
  const suiteMarkers = useMemo(() => suitesByPack(suites?.rows ?? []), [suites])
  if (error !== undefined) {
    return h('div', { className: 'dw-root' },
      h('p', { className: `${errorText} whitespace-pre-wrap` },
        renderError(error as ApiError, lang).text),
      h('p', { className: muted }, error.message),
      h(Button, { size: 'sm', onClick: refresh }, t('retry')))
  }
  if (payload === undefined) return h('p', { className: `dw-root ${muted}` }, t('loading'))
  // Packs first: the installed list (suites nested, then standalone packs)
  // is the landing view; params groups and the plugin form follow
  // (docs/designs/pack-suites.md).
  const tabs = [
    { value: 'packs', label: t('viewPacks'), id: `${NS}-packs`, panelId: `${NS}-packs-panel` },
    { value: 'groups', label: t('viewGroups'), id: `${NS}-groups`, panelId: `${NS}-groups-panel` },
    { value: 'config', label: t('viewConfig'), id: `${NS}-config`, panelId: `${NS}-config-panel` },
  ] as const
  return h('div', { className: `${NS}-section dw-root` },
    h('h3', { className: 'm-0 mb-1 font-semibold' }, t('title')),
    h('p', { className: `${muted} m-0 mb-2` }, t('intro')),
    h('div', { className: 'mt-2 mb-3' },
      h(SegmentedTabs, { items: [...tabs], value: view, onChange: v => setView(v as 'groups' | 'packs' | 'config'), label: t('title') })),
    view === 'groups' ? h(GroupsView, { payload, t, lang, resolveText: props.resolveText, onSaved: refresh, onJump: jumpTo }) : null,
    view === 'packs' ? h(PacksView, { payload, suites: suiteMarkers, suitesLane: suites, t, lang, resolveText: props.resolveText, onJump: jumpTo, onSaved: refresh }) : null,
    view === 'config' ? h(ConfigView, { payload, t, lang, resolveText: props.resolveText, onSaved: refresh }) : null)
}
