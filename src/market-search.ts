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
  const installHint = 'doc_market_install { "pack": "<name>" } — installs this pack AND its consumed upstreams (the confirmation table lists them); the user confirms, then everything is usable in this session immediately'
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


/** The install plan for one pack: its consumes closure from the market index
 * (the doc_market_install confirmation table's substance). Throws when the
 * market is unreachable or the requested pack is absent — the gate wants to
 * surface those before anything is asked. */
export async function fetchInstallPlan(marketUrl: string, requested: string): Promise<{ members: Array<{ name: string; version: string; description: string; requested: boolean }> }> {
  let rows: MarketPackRow[]
  try {
    const response = await fetch(`${marketUrl}/api/index`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as { packs?: unknown }
    rows = Array.isArray(body.packs) ? body.packs as MarketPackRow[] : []
  } catch (error) {
    throw new Error(`could not reach the pack market at ${marketUrl} (${(error as Error).message}); nothing was asked — retry later`)
  }
  const byName = new Map(rows.map(r => [String(r.name), r]))
  if (!byName.has(requested)) {
    throw new Error(`pack "${requested}" is not listed on the market at ${marketUrl}; nothing to install — publish it first or install it into the packsDir directly`)
  }
  const members: Array<{ name: string; version: string; description: string; requested: boolean }> = []
  const seen = new Set<string>()
  const visit = (name: string, isRequested: boolean): void => {
    if (seen.has(name)) return
    seen.add(name)
    const row = byName.get(name)
    if (row === undefined) return // the strict closure check lives in installPack; the table degrades gracefully
    const consumes = Array.isArray(row.consumes) ? row.consumes.filter((c): c is string => typeof c === 'string') : []
    for (const up of consumes) visit(up, false)
    members.push({ name, version: typeof row.version === 'string' ? row.version : '', description: resolveLocalized(row.description as LocalizedText | undefined, 'en'), requested: isRequested })
  }
  visit(requested, true)
  return { members }
}
