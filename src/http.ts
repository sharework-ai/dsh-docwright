import type { IncomingMessage, ServerResponse } from 'node:http'
import { CodedError, errorEnvelope } from './coded-error.ts'

/**
 * HTTP surface for the params maintenance UI (docs/designs/param-management-ui.md).
 * Mounted as EXACT routes on the host's webServer — and exact registrations
 * win over the host's own /api prefix fence (dsh-market #729 finding), so
 * this layer re-applies the host gate itself: `connection.requestRejection`
 * (the Host/Origin fence plus the browser login — the same verdict the
 * host's own API answers with), read per request because the connection
 * service only exists after the host's async init (mounting happens
 * earlier). Mutating routes additionally enforce same-origin (a forged
 * cross-site POST cannot carry the Host-gated origin) and read a size-capped
 * JSON body.
 */

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The slice of the host connection service the routes consume. */
export interface ConnectionLike {
  requestRejection?: ((request: IncomingMessage) => number | undefined) | undefined
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Reject a cross-site write: the Origin header, when present, must match the Host. */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  try {
    const originHost = new URL(origin).host
    return originHost === host
  } catch {
    return false
  }
}

const MAX_BODY_BYTES = 64 * 1024

/** Read and parse a JSON body, refusing oversized or malformed payloads. */
async function readJsonBody(request: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: CodedError }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      return { ok: false, status: 413, error: new CodedError('bodyTooLarge', `request body exceeds ${MAX_BODY_BYTES} bytes`, { params: { max: MAX_BODY_BYTES } }) }
    }
    chunks.push(chunk as Buffer)
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch (error) {
    return { ok: false, status: 400, error: new CodedError('invalidJsonBody', `request body is not valid JSON: ${(error as Error).message}`, { detail: (error as Error).message }) }
  }
}

/** Run the host gate with the service as `this`; a throwing gate fails closed at 403. */
function hostRejection(connection: ConnectionLike | undefined, request: IncomingMessage): number | undefined {
  if (connection === undefined) return undefined
  const gate = connection.requestRejection
  if (gate === undefined) return undefined
  try {
    return gate.call(connection, request)
  } catch {
    return 403
  }
}

export interface WriteChannels {
  /** Merge a Config patch through the host settings service (S3 Config channel). */
  readonly updateConfig: (patch: Record<string, unknown>) => Promise<void>
  /** Set one pack param default in its manifest, re-validating at load strength, and hot-swap the pack map. */
  readonly setPackParamDefault: (pack: string, param: string, value: unknown) => Promise<void>
  /** Pack-lane management (src/pack-manage.ts): market version standing, update, delete. Optional — hosts mount it only when a packsDir is configured. */
  readonly packLane?: {
    readonly checkUpdates: (pack?: string | undefined) => Promise<unknown>
    readonly updatePack: (pack: string) => Promise<{ version: string }>
    readonly deletePack: (pack: string, opts?: { force?: boolean }) => Promise<void>
    /** Suite lane (docs/designs/pack-suites.md): market suite list projected onto the local packsDir. */
    readonly suiteStatus?: () => Promise<unknown>
    readonly updateSuite?: (suite: string) => Promise<unknown>
    readonly deleteSuite?: (suite: string) => Promise<unknown>
  } | undefined
}

/**
 * Mount the params routes. Returns the disposer.
 * - `GET  /api/docwright/params` — the read catalog (S1).
 * - `POST /api/docwright/config` — `{ patch }` merged into the plugin's live Config via the host settings service.
 * - `POST /api/docwright/pack-param` — `{ pack, param, value }` sets one manifest default.
 * - `GET  /api/docwright/pack-updates` — per packsDir pack standing vs the market (read; mounted with the pack lane).
 * - `POST /api/docwright/pack-update` — `{ pack }` updates one packsDir pack from the market (verified, atomic).
 * - `POST /api/docwright/pack-delete` — `{ pack }` deletes one packsDir pack directory.
 * - `GET  /api/docwright/suites` — market suites projected onto the local packsDir (read; mounted with the pack lane).
 * - `POST /api/docwright/suite-update` — `{ suite }` updates the suite's outdated members from the market.
 * - `POST /api/docwright/suite-delete` — `{ suite }` deletes the suite's installed members (all of them).
 */
export function mountParamsRoutes(
  webServer: WebServerLike,
  deps: {
    /** Lazy payload builder (packs/config can change via HMR without a remount). */
    payload: () => unknown
    /** Lazy host-connection accessor; absent on hosts without the service (loopback scripts/tests). */
    connection?: (() => ConnectionLike | undefined) | undefined
    /** Write channels; absent mounts the read route only (headless hosts without a webServer never get here; tests may exercise read-only). */
    writes?: WriteChannels | undefined
  },
): () => void {
  const disposeRead = webServer.register({
    kind: 'exact',
    path: '/api/docwright/params',
    handler: (request, response) => {
      const rejected = hostRejection(deps.connection?.(), request)
      if (rejected !== undefined) {
        sendJson(response, rejected, errorEnvelope(new CodedError('gateRejected', `request rejected by the host gate (status ${rejected})`, { params: { status: rejected } })))
        return
      }
      sendJson(response, 200, deps.payload())
    },
  })
  if (deps.writes === undefined) return disposeRead

  const post = (path: string, handler: (body: unknown, request: IncomingMessage) => Promise<{ status: number; payload: unknown }>): (() => void) =>
    webServer.register({
      kind: 'exact',
      path,
      handler: async (request, response) => {
        const rejected = hostRejection(deps.connection?.(), request)
        if (rejected !== undefined) {
          sendJson(response, rejected, errorEnvelope(new CodedError('gateRejected', `request rejected by the host gate (status ${rejected})`, { params: { status: rejected } })))
          return
        }
        // Same-origin for every mutating request (the read route needs none —
        // no side effects to forge).
        if (request.method !== 'POST' || !sameOrigin(request)) {
          sendJson(response, 403, errorEnvelope(new CodedError('crossSiteWrite', 'cross-site write refused: Origin does not match the deployment host')))
          return
        }
        const body = await readJsonBody(request)
        if (!body.ok) {
          sendJson(response, body.status, errorEnvelope(body.error))
          return
        }
        try {
          const result = await handler(body.body, request)
          sendJson(response, result.status, result.payload)
        } catch (error) {
          // Error contract: `{ error, code, params?, detail? }` — the English
          // sentence stays the log face; `code`+`params` key the browser's
          // locale catalog (what happened / why / what to do, in the user's
          // language); unknown codes degrade to the raw message.
          sendJson(response, 422, errorEnvelope(error))
        }
      },
    })

  const disposeConfig = post('/api/docwright/config', async body => {
    const patch = (body as { patch?: unknown }).patch
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new CodedError('invalidPatchBody', 'body must be {"patch": {...}} with an object of Config keys; nothing was written')
    }
    await deps.writes!.updateConfig(patch as Record<string, unknown>)
    return { status: 200, payload: { ok: true } }
  })
  const disposeParam = post('/api/docwright/pack-param', async body => {
    const { pack, param, value } = body as { pack?: unknown; param?: unknown; value?: unknown }
    if (typeof pack !== 'string' || pack.length === 0 || typeof param !== 'string' || param.length === 0) {
      throw new CodedError('invalidParamBody', 'body must be {"pack", "param", "value"} with non-empty pack and param names; nothing was written')
    }
    if (value === undefined) {
      throw new CodedError('valueRequired', 'body.value is required (the new default; pass null to state that explicitly is not supported — defaults are edited, not removed, from the UI)')
    }
    await deps.writes!.setPackParamDefault(pack, param, value)
    return { status: 200, payload: { ok: true } }
  })
  // The pack lane mounts only when a packsDir is configured (a deployment
  // without one has nothing to manage; the UI hides its actions too).
  let disposeUpdates: (() => void) | undefined
  let disposePackUpdate: (() => void) | undefined
  let disposePackDelete: (() => void) | undefined
  let disposeSuiteStatus: (() => void) | undefined
  let disposeSuiteUpdate: (() => void) | undefined
  let disposeSuiteDelete: (() => void) | undefined
  if (deps.writes!.packLane !== undefined) {
    const lane = deps.writes!.packLane
    const packName = (body: unknown): string => {
      const { pack } = body as { pack?: unknown }
      if (typeof pack !== 'string' || pack.length === 0) {
        throw new CodedError('invalidParamBody', 'body must be {"pack": "<name>"} with a non-empty pack name; nothing was written')
      }
      return pack
    }
    const suiteName = (body: unknown): string => {
      const { suite } = body as { suite?: unknown }
      if (typeof suite !== 'string' || suite.length === 0) {
        throw new CodedError('invalidParamBody', 'body must be {"suite": "<name>"} with a non-empty suite name; nothing was written')
      }
      return suite
    }
    disposeUpdates = webServer.register({
      kind: 'exact',
      path: '/api/docwright/pack-updates',
      handler: (request, response) => {
        const rejected = hostRejection(deps.connection?.(), request)
        if (rejected !== undefined) {
          sendJson(response, rejected, errorEnvelope(new CodedError('gateRejected', `request rejected by the host gate (status ${rejected})`, { params: { status: rejected } })))
          return
        }
        // Optional ?pack=name scopes the standing to one card — the check is
        // per-card in the UI (each click answers exactly the clicked card).
        const url = new URL(request.url ?? '', 'http://local')
        const only = url.searchParams.get('pack') ?? undefined
        void lane.checkUpdates(only).then(
          updates => sendJson(response, 200, { updates }),
          error => sendJson(response, error instanceof CodedError && error.code === 'marketUnreachable' ? 200 : 422, errorEnvelope(error)),
        )
      },
    })
    // The market being down is NOT a server error: the check answers 200 with
    // a coded envelope the UI renders inline, so a poll never spins error UI.
    disposePackUpdate = post('/api/docwright/pack-update', async body => {
      const pack = packName(body)
      const { version } = await lane.updatePack(pack)
      return { status: 200, payload: { ok: true, version } }
    })
    disposePackDelete = post('/api/docwright/pack-delete', async body => {
      const pack = packName(body)
      const { force } = body as { force?: unknown }
      await lane.deletePack(pack, { force: force === true })
      return { status: 200, payload: { ok: true } }
    })
    // The suite lane (docs/designs/pack-suites.md): a status read for the
    // Suites settings tab plus per-suite update/delete. suiteStatus answers
    // like pack-updates — a market that is DOWN is a coded 200 envelope, not
    // error UI; a market that does not KNOW suites answers an empty list.
    disposeSuiteStatus = webServer.register({
      kind: 'exact',
      path: '/api/docwright/suites',
      handler: (request, response) => {
        const rejected = hostRejection(deps.connection?.(), request)
        if (rejected !== undefined) {
          sendJson(response, rejected, errorEnvelope(new CodedError('gateRejected', `request rejected by the host gate (status ${rejected})`, { params: { status: rejected } })))
          return
        }
        if (lane.suiteStatus === undefined) {
          sendJson(response, 200, { suites: [] })
          return
        }
        void lane.suiteStatus().then(
          suites => sendJson(response, 200, { suites }),
          error => sendJson(response, error instanceof CodedError && error.code === 'marketUnreachable' ? 200 : 422, errorEnvelope(error)),
        )
      },
    })
    disposeSuiteUpdate = post('/api/docwright/suite-update', async body => {
      if (lane.updateSuite === undefined) throw new CodedError('suiteLaneMissing', 'the suite lane is not wired on this deployment; nothing was written')
      const suite = suiteName(body)
      const result = await lane.updateSuite(suite)
      return { status: 200, payload: { ok: true, ...result as Record<string, unknown> } }
    })
    disposeSuiteDelete = post('/api/docwright/suite-delete', async body => {
      if (lane.deleteSuite === undefined) throw new CodedError('suiteLaneMissing', 'the suite lane is not wired on this deployment; nothing was written')
      const suite = suiteName(body)
      const { force } = body as { force?: unknown }
      const result = await lane.deleteSuite(suite)
      return { status: 200, payload: { ok: true, ...result as Record<string, unknown> } }
    })
  }
  return () => {
    disposeSuiteDelete?.()
    disposeSuiteUpdate?.()
    disposeSuiteStatus?.()
    disposePackDelete?.()
    disposePackUpdate?.()
    disposeUpdates?.()
    disposeParam()
    disposeConfig()
    disposeRead()
  }
}
