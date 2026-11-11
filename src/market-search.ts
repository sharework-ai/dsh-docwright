import { resolveLocalized } from './description.ts'
import type { LocalizedText } from './description.ts'

/**
 * Pack-market keyword search (the discovery layer behind doc_market_search).
 * Division of labor: the MODEL decomposes the user's need into query terms
 * (it reads the intent; "split by function point, check data-movement types,
 * control CFP" becomes e.g. "cosmic function point CFP"); the MARKET does
 * traditional keyword matching (ILIKE over name, category, and both
 * description languages — no vectors at catalog scale). The tool fails loud
 * with problem+cause+fix when the market is unreachable: the model relays
 * that, it never guesses catalog contents.
 */

interface MarketPackRow {
  name?: unknown
  version?: unknown
  description?: unknown
  category?: unknown
  author?: unknown
  org?: unknown
  license?: unknown
  consumes?: unknown
  languages?: unknown
  requires_topic?: unknown
  artifact_prefix?: unknown
}

/** One catalog hit, projected for the model (en face, like doc_packs). */
export type MarketPackCard = {
  name: string
  version: string
  description: string
  category: string
  author: string
  license: string
  languages: string[]
  consumes: string[]
  requiresTopic: boolean
  artifactPrefix?: string
  install: string
}

export type MarketSearchResult = {
  market: string
  query: string
  count: number
  packs: MarketPackCard[]
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Search the market catalog. `query` is free text (whitespace-separated
 * terms; the caller — the model — composes them). `packsDir` (when known)
 * makes the install hint concrete.
 */
export async function searchMarket(deps: {
  readonly marketUrl: string
  readonly packsDir?: string | undefined
  readonly fetchImpl?: typeof fetch
}, query: string, limit?: number): Promise<MarketSearchResult> {
  const capped = limit === undefined || !Number.isFinite(limit) || limit <= 0 ? 20 : Math.min(Math.floor(limit), 50)
  const url = `${deps.marketUrl}/api/packs?q=${encodeURIComponent(query)}`
  let rows: MarketPackRow[]
  try {
    const response = await (deps.fetchImpl ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as { packs?: unknown }
    rows = Array.isArray(body.packs) ? body.packs as MarketPackRow[] : []
  } catch (error) {
    throw new Error(`could not search the pack market at ${deps.marketUrl} (${(error as Error).message}); the catalog was not read — retry later, or point marketUrl at a reachable market`)
  }
  // The install lane is the doc_market_install tool: the user confirms, the
  // verified download lands in the packsDir, and the pack map hot-reloads —
  // usable in the same session.
  const installHint = 'doc_market_install { "pack": "<name>" } — the user confirms, then the pack is usable in this session immediately'
  const cards: MarketPackCard[] = rows.slice(0, capped).map(row => ({
    name: asString(row.name),
    version: asString(row.version),
    description: resolveLocalized(row.description as LocalizedText | undefined, 'en'),
    category: asString(row.category),
    author: asString(row.author),
    license: asString(row.license),
    languages: asStringArray(row.languages),
    consumes: asStringArray(row.consumes),
    requiresTopic: row.requires_topic === true,
    ...(typeof row.artifact_prefix === 'string' && row.artifact_prefix.length > 0 ? { artifactPrefix: row.artifact_prefix } : {}),
    install: installHint.replace('<name>', asString(row.name)),
  })).filter(c => c.name.length > 0)
  return { market: deps.marketUrl, query, count: cards.length, packs: cards }
}

/** One pack's catalog card straight from the market index (the confirmation
 * table's substance), or undefined when the market does not list it. */
export async function fetchMarketCard(marketUrl: string, name: string): Promise<{ version: string; description: string; consumes: string[] } | undefined> {
  let rows: MarketPackRow[]
  try {
    const response = await fetch(`${marketUrl}/api/packs?q=${encodeURIComponent(name)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as { packs?: unknown }
    rows = Array.isArray(body.packs) ? body.packs as MarketPackRow[] : []
  } catch {
    return undefined
  }
  const row = rows.find(r => r.name === name)
  if (row === undefined) return undefined
  return {
    version: asString(row.version),
    description: resolveLocalized(row.description as LocalizedText | undefined, 'en'),
    consumes: asStringArray(row.consumes),
  }
}
