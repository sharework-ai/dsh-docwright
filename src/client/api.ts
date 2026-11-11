/**
 * docwright params UI — host RPC client. Same-origin fetches against the
 * plugin's exact routes (src/http.ts); the host gate (login + Host/Origin
 * fence) applies to every call, so no extra auth handling lives here.
 *
 * Error envelope: `{ error, code?, params?, detail? }` (src/coded-error.ts).
 * The raw English sentence stays on `message`; `code`+`params` key the
 * locale catalog in locales.ts so the UI renders the same problem+cause+fix
 * in the user's language; unknown codes degrade to the raw message.
 */
import type { LocalizedText } from '../description.ts'

export class ApiError extends Error {
  readonly code?: string
  readonly params?: Readonly<Record<string, string | number>>
  readonly detail?: string

  constructor(message: string, coded: { code?: string; params?: Readonly<Record<string, string | number>>; detail?: string } = {}) {
    super(message)
    this.name = 'ApiError'
    if (coded.code !== undefined) this.code = coded.code
    if (coded.params !== undefined) this.params = coded.params
    if (coded.detail !== undefined) this.detail = coded.detail
  }
}

export interface UiParamDeclaration {
  pack: string
  name: string
  type: string
  description: LocalizedText
  default: unknown
  required: boolean
  confirm: boolean
  overridable: boolean
  extractable: boolean
  enumValues?: readonly (number | string | boolean)[]
  min?: number
  max?: number
  role: 'source' | 'shadowed'
  shadowedBy?: string
}

export interface UiPackEntry {
  name: string
  version: string
  description: LocalizedText
  scope: 'workspace' | 'topic'
  consumes: readonly string[]
  paramDriftPolicy?: string
  origin: { kind: 'builtin' | 'packsDir'; root: string }
  params: readonly UiParamDeclaration[]
}

export interface UiParamGroup {
  name: string
  sources: readonly string[]
  declarations: readonly UiParamDeclaration[]
}

export interface UiConfigEntry {
  key: string
  type: string
  description?: LocalizedText
  value?: unknown
  default?: unknown
  origin: 'default' | 'configured'
  choices?: readonly (number | string | boolean)[]
}

export interface ParamsPayload {
  packs: readonly UiPackEntry[]
  groups: readonly UiParamGroup[]
  config: readonly UiConfigEntry[]
}

async function parse<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(`docwright: the server answered HTTP ${response.status} with a non-JSON body; is the docwright plugin loaded?`)
  }
  if (!response.ok) {
    const envelope = body as { error?: unknown; code?: unknown; params?: unknown; detail?: unknown }
    const message = typeof envelope.error === 'string' && envelope.error.length > 0 ? envelope.error : `docwright request failed with HTTP ${response.status}`
    const coded: { code?: string; params?: Readonly<Record<string, string | number>>; detail?: string } = {}
    if (typeof envelope.code === 'string') coded.code = envelope.code
    if (typeof envelope.params === 'object' && envelope.params !== null) coded.params = envelope.params as Readonly<Record<string, string | number>>
    if (typeof envelope.detail === 'string') coded.detail = envelope.detail
    throw new ApiError(message, coded)
  }
  return body as T
}

/** Fetch the params catalog (packs, aggregation groups, config provenance). */
export async function fetchParams(): Promise<ParamsPayload> {
  return parse<ParamsPayload>(await fetch('/api/docwright/params', { headers: { accept: 'application/json' } }))
}

/** Merge a Config patch through the host settings service (server-proxied). */
export async function saveConfigPatch(patch: Record<string, unknown>): Promise<void> {
  await parse(await fetch('/api/docwright/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch }),
  }))
}

/** Set one pack param default in its manifest (server re-validates at load strength). */
export async function savePackParam(pack: string, param: string, value: unknown): Promise<void> {
  await parse(await fetch('/api/docwright/pack-param', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pack, param, value }),
  }))
}

/** One packsDir pack's standing against the pack market. */
export interface UiPackUpdate {
  name: string
  localVersion: string
  /** False when the market has no pack under this name. */
  onMarket: boolean
  marketVersion?: string
  updateAvailable: boolean
}

/** Version standing of the managed packs; `pack` scopes the check to one
 * card (the check is per-card in the UI). One server-side market fetch. */
export async function fetchPackUpdates(pack?: string): Promise<readonly UiPackUpdate[]> {
  const suffix = pack !== undefined ? `?pack=${encodeURIComponent(pack)}` : ''
  const body = await parse<{ updates: readonly UiPackUpdate[] }>(await fetch(`/api/docwright/pack-updates${suffix}`, { headers: { accept: 'application/json' } }))
  return body.updates
}

/** Update one managed pack from the market (verified download, atomic swap). */
export async function updateManagedPack(pack: string): Promise<string> {
  const body = await parse<{ ok: true; version: string }>(await fetch('/api/docwright/pack-update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pack }),
  }))
  return body.version
}

/** Delete one managed pack (its packsDir directory; restores a same-name builtin override if any). */
export async function deleteManagedPack(pack: string): Promise<void> {
  await parse(await fetch('/api/docwright/pack-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pack }),
  }))
}
