import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CodedError } from '../src/coded-error.ts'
import { Config } from '../src/config.ts'
import type { ConnectionLike, WebServerLike } from '../src/http.ts'
import { mountParamsRoutes } from '../src/http.ts'
import { loadPacks } from '../src/pack-loader.ts'
import type { Pack } from '../src/pack.ts'
import { buildConfigCatalog, buildParamsCatalog, buildParamsPayload, paramRoles, type SchemaNode, type UiParamDeclaration } from '../src/params-rpc.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))

/** Manifest-only pack stand-in: the catalog functions read manifest fields only. */
function packOf(manifest: Record<string, unknown>): Pack {
  return { manifest } as never as Pack
}

function chainPacks(): Map<string, Pack> {
  const num = (def: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'number', default: def, description: 'd', ...extra })
  return new Map([
    ['chain-a', packOf({ name: 'chain-a', version: '1', description: 'da', scope: 'topic', consumes: [], params: { shared: num(1), onlyA: { type: 'string', default: 'a', description: 'd' } } })],
    ['chain-b', packOf({ name: 'chain-b', version: '1', description: 'db', scope: 'topic', consumes: ['chain-a'], params: { shared: num(2), ownB: num(3) } })],
    ['chain-c', packOf({ name: 'chain-c', version: '1', description: 'dc', scope: 'topic', consumes: ['chain-b'], params: { shared: num(4), noDefault: { type: 'number', required: true, description: 'd' }, bounded: num(5, { enum: [5, 6, 7], min: 1, max: 10 }) } })],
    ['chain-sync', packOf({ name: 'chain-sync', version: '1', description: 'ds', scope: 'workspace', consumes: ['chain-a', 'chain-b'], paramDriftPolicy: 'revalidate', params: { shared: num(9) } })],
  ])
}

describe('paramRoles', () => {
  it('resolves the transitive origin: every downstream shadow traces to the chain head', () => {
    const roles = paramRoles(chainPacks())
    expect(roles.get('chain-a')!.get('shared')).toEqual({ role: 'source' })
    expect(roles.get('chain-b')!.get('shared')).toEqual({ role: 'shadowed', shadowedBy: 'chain-a' })
    // chain-c's nearest declarer is chain-b, but chain-b is itself shadowed —
    // the origin (chain-a's default) is what reaches c's receipts.
    expect(roles.get('chain-c')!.get('shared')).toEqual({ role: 'shadowed', shadowedBy: 'chain-a' })
  })

  it('skips upstreams that do not declare the param and unknown consumed names', () => {
    const packs = new Map([
      ['up-none', packOf({ name: 'up-none', version: '1', description: 'd', scope: 'topic', consumes: [], params: { other: { type: 'number', default: 1, description: 'd' } } })],
      ['down', packOf({ name: 'down', version: '1', description: 'd', scope: 'topic', consumes: ['up-none', 'ghost-pack'], params: { mine: { type: 'number', default: 2, description: 'd' } } })],
    ])
    const roles = paramRoles(packs)
    expect(roles.get('down')!.get('mine')).toEqual({ role: 'source' })
  })

  it('resolves multi-upstream ambiguity by consumes order and terminates on cycles', () => {
    const roles = paramRoles(chainPacks())
    expect(roles.get('chain-sync')!.get('shared')).toEqual({ role: 'shadowed', shadowedBy: 'chain-a' })
    const cycle = new Map([
      ['x', packOf({ name: 'x', version: '1', description: 'd', scope: 'topic', consumes: ['y'], params: { p: { type: 'number', default: 1, description: 'd' } } })],
      ['y', packOf({ name: 'y', version: '1', description: 'd', scope: 'topic', consumes: ['x'], params: { p: { type: 'number', default: 2, description: 'd' } } })],
    ])
    expect(paramRoles(cycle).get('x')!.get('p')!.role).toBe('shadowed')
  })
})

describe('buildParamsCatalog', () => {
  it('shows only default-carrying params with full metadata and roles', () => {
    const catalog = buildParamsCatalog(chainPacks())
    expect(catalog.packs.map(p => p.name)).toEqual(['chain-a', 'chain-b', 'chain-c', 'chain-sync'])
    const c = catalog.packs.find(p => p.name === 'chain-c')!
    // noDefault (required, no default) is excluded by the inclusion criterion.
    expect(c.params.map(p => p.name)).toEqual(['bounded', 'shared'])
    const bounded = c.params.find(p => p.name === 'bounded')!
    expect(bounded).toMatchObject({ default: 5, enumValues: [5, 6, 7], min: 1, max: 10, role: 'source', required: false, confirm: false, overridable: false, extractable: false })
    expect(c.consumes).toEqual(['chain-b'])
    const sync = catalog.packs.find(p => p.name === 'chain-sync')!
    expect(sync.scope).toBe('workspace')
    expect(sync.paramDriftPolicy).toBe('revalidate')
  })

  it('aggregates same-name declarations with sources and per-pack roles', () => {
    const catalog = buildParamsCatalog(chainPacks())
    const shared = catalog.groups.find(g => g.name === 'shared')!
    expect(shared.sources).toEqual(['chain-a'])
    expect(shared.declarations.map((d: UiParamDeclaration) => [d.pack, d.role, d.shadowedBy])).toEqual([
      ['chain-a', 'source', undefined],
      ['chain-b', 'shadowed', 'chain-a'],
      ['chain-c', 'shadowed', 'chain-a'],
      ['chain-sync', 'shadowed', 'chain-a'],
    ])
    expect(catalog.groups.map(g => g.name)).toEqual(['bounded', 'onlyA', 'ownB', 'shared'])
  })

  it('anchors against the real builtin packs: cfp* governed by the plan head, topicNoPattern by context', async () => {
    const packs = await loadPacks(packsRoot, {})
    const catalog = buildParamsCatalog(packs)
    const cfpPerFunc = catalog.groups.find(g => g.name === 'cfpPerFunc')!
    expect(cfpPerFunc.sources).toEqual(['cosmic-plan'])
    // Downstream packs declare these inheritance-only (no default) — the
    // catalog lists default-carrying declarations, so only the source appears.
    expect(cfpPerFunc.declarations.map(d => d.pack)).toEqual(['cosmic-plan'])
    const pattern = catalog.groups.find(g => g.name === 'topicNoPattern')!
    expect(pattern.sources).toEqual(['cosmic-context'])
    // cfpTotal (required, no default) and topicNo (derived, no default) never appear.
    expect(catalog.groups.map(g => g.name)).not.toContain('cfpTotal')
    expect(catalog.groups.map(g => g.name)).not.toContain('topicNo')
    const plan = catalog.packs.find(p => p.name === 'cosmic-plan')!
    expect(plan.version).toBe('0.7.2')
    // cfpTotal (required, no default) is excluded from the plan's own list too.
    expect(plan.params.map(p => p.name)).not.toContain('cfpTotal')
    expect(plan.params.map(p => p.name)).toContain('cfpPerFunc')
    // Pack provenance rides the payload: the UI shows where an edit will land.
    expect(plan.origin).toEqual({ kind: 'builtin', root: packsRoot })
  })
})

describe('buildConfigCatalog', () => {
  it('derives entries from the real Config schema: descriptions, defaults, origin, union choices, dotted keys', () => {
    const entries = buildConfigCatalog(Config as unknown as SchemaNode, { workspaceRoot: '/w', maxIterations: 2, provider: 'p', model: 'm', confirmPolicy: 'strict' })
    const maxIterations = entries.find(e => e.key === 'maxIterations')!
    expect(maxIterations).toMatchObject({ type: 'number', value: 2, default: 5, origin: 'configured' })
    // Schema descriptions travel as LocalizedText; the en entry is the canonical text.
    expect(maxIterations.description && typeof maxIterations.description === 'object' && maxIterations.description.en).toContain('Repair-loop round cap')
    expect(maxIterations.description && typeof maxIterations.description === 'object' && maxIterations.description.zh).toContain('修复循环的轮数上限')
    const confirmPolicy = entries.find(e => e.key === 'confirmPolicy')!
    expect(confirmPolicy.choices).toEqual(['none', 'standard', 'strict'])
    expect(confirmPolicy).toMatchObject({ value: 'strict', default: 'standard', origin: 'configured' })
    const provider = entries.find(e => e.key === 'provider')!
    expect(provider.value).toBe('p')
    expect(provider.default).toBeUndefined()
    // Set with no schema default: configured (nothing default accounts for it).
    expect(provider.origin).toBe('configured')
    const packsDir = entries.find(e => e.key === 'packsDir')!
    expect(packsDir.value).toBeUndefined()
    const mode = entries.find(e => e.key === 'oscillation.mode')!
    expect(mode.default).toBe('auto')
    expect(mode.origin).toBe('default')
    const header = entries.find(e => e.key === 'oscillation')!
    expect(header.type).toBe('object')
    expect(header.description && typeof header.description === 'object' && header.description.en).toContain('convergence tuning')
    expect(entries.some(e => e.key === 'oscillation.defaultScore.error')).toBe(true)
  })

  it('treats explicitly-set-to-default values as default origin and empty-dict object nodes as leaves', () => {
    const node: SchemaNode = {
      type: 'object',
      meta: {},
      dict: {
        plain: { type: 'string', meta: { description: 'p', default: 'x' } },
        defaulted: { type: 'number', meta: { default: 7 } },
        emptyObj: { type: 'object', meta: { description: 'e' }, dict: {} },
        noDesc: { type: 'boolean', meta: {} },
        odd: { type: 'union', meta: {}, list: [{ type: 'schema', value: undefined }] },
      },
    }
    const entries = buildConfigCatalog(node, { plain: 'x', emptyObj: {}, noDesc: true } as never)
    expect(entries.find(e => e.key === 'plain')!.origin).toBe('default')
    // Unset with a schema default: the default state governs (no value key).
    const defaulted = entries.find(e => e.key === 'defaulted')!
    expect('value' in defaulted).toBe(false)
    expect(defaulted).toMatchObject({ default: 7, origin: 'default' })
    // An explicitly present value (even {}) is configured — nothing default accounts for it.
    expect(entries.find(e => e.key === 'emptyObj')).toMatchObject({ type: 'object', origin: 'configured' })
    const noDesc = entries.find(e => e.key === 'noDesc')!
    expect(noDesc.description).toBeUndefined()
    expect(noDesc).toMatchObject({ value: true, type: 'boolean', origin: 'configured' })
    expect(entries.find(e => e.key === 'odd')!.choices).toBeUndefined()
  })
})

describe('buildParamsPayload', () => {
  it('combines the pack views with the config provenance', async () => {
    const packs = await loadPacks(packsRoot, {})
    const payload = buildParamsPayload(packs, Config, { workspaceRoot: '/w', confirmPolicy: 'none' } as never)
    expect(payload.groups.length).toBeGreaterThan(3)
    expect(payload.config.find(e => e.key === 'confirmPolicy')).toMatchObject({ value: 'none', origin: 'configured' })
  })
})

describe('mountParamsRoutes', () => {
  function fakeServer() {
    const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }> = []
    const disposers: Array<() => void> = []
    const webServer: WebServerLike = {
      register: route => {
        routes.push(route as never)
        const dispose = () => disposers.splice(disposers.indexOf(dispose), 1)
        disposers.push(dispose)
        return dispose
      },
    }
    return { webServer, routes, disposers }
  }
  const fakeRes = () => {
    const res = { statusCode: 0, headers: {} as Record<string, string>, body: '' }
    const typed = res as unknown as { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }
    typed.writeHead = (status, headers) => {
      res.statusCode = status
      res.headers = headers
    }
    typed.end = body => {
      res.body = body
    }
    return { res, typed }
  }

  it('registers the exact params route and answers the lazily built payload', async () => {
    const { webServer, routes, disposers } = fakeServer()
    let builds = 0
    const dispose = mountParamsRoutes(webServer, { payload: () => ({ n: ++builds }) })
    expect(routes).toHaveLength(1)
    expect(routes[0]!.path).toBe('/api/docwright/params')
    const { res, typed } = fakeRes()
    await routes[0]!.handler({}, typed as never)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ n: 1 })
    await routes[0]!.handler({}, typed as never)
    expect(JSON.parse(res.body)).toEqual({ n: 2 })
    expect(disposers).toHaveLength(1)
    dispose()
    expect(disposers).toHaveLength(0)
  })

  it('applies the host request gate when the connection service exposes one', async () => {
    const { webServer, routes } = fakeServer()
    const connection: ConnectionLike = { requestRejection: () => 401 }
    mountParamsRoutes(webServer, { payload: () => ({}), connection: () => connection })
    const { res, typed } = fakeRes()
    await routes[0]!.handler({}, typed as never)
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toContain('host gate')
    // A per-request accessor returning undefined (service not up yet) lets the read through.
    const { webServer: ws2, routes: r2 } = fakeServer()
    mountParamsRoutes(ws2, { payload: () => ({ ok: true }), connection: () => undefined })
    const res2 = fakeRes()
    await r2[0]!.handler({}, res2.typed as never)
    expect(res2.res.statusCode).toBe(200)
    expect(JSON.parse(res2.res.body)).toEqual({ ok: true })
  })
})

describe('registerTools wiring', () => {
  it('mounts the params routes on a host that provides a webServer and serves the real payload', async () => {
    const { registerTools } = await import('../src/index.ts')
    const registered: string[] = []
    const handlers: Array<(req: unknown, res: unknown) => Promise<void> | void> = []
    const hostCtx = {
      effect(fn: () => () => void) { fn() },
      webServer: { register: (r: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) => { handlers.push(r.handler); return () => {} } },
    }
    const ctx = {
      tools: { register: (t: { name: string }) => { registered.push(t.name) } },
      inject(deps: string[], cb: (hostCtx: unknown) => void) { if (deps.includes('webServer')) cb(hostCtx) },
      get(name: string) {
        return name === 'configEditor'
          ? { entries: () => [], edit: () => Promise.resolve() }
          : undefined
      },
    }
    const fakeResMaker = () => {
      const res = { statusCode: 0, body: '', writeHead(s: number) { res.statusCode = s }, end(b: string) { res.body = b } }
      return res
    }
    // A host WITHOUT a settings service: the config write names the cause and
    // the fix (422), never a TypeError from an undefined service.
    const bareCtx = {
      tools: { register: () => {} },
      inject(deps: string[], cb: (hostCtx: unknown) => void) { if (deps.includes('webServer')) cb(hostCtx) },
      get() { return undefined },
    }
    void bareCtx
    await registerTools(bareCtx as never, { workspaceRoot: '/w' } as never, packsRoot)
    const resNoSettings = fakeResMaker()
    await handlers[1]!({ method: 'POST', headers: { origin: 'https://h', host: 'h' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"patch":{}}') } }, resNoSettings)
    expect(resNoSettings.statusCode).toBe(422)
    expect(JSON.parse(resNoSettings.body).error).toContain('config editor is not available')
    const first = handlers.length
    await registerTools(ctx as never, { workspaceRoot: '/w' } as never, packsRoot)
    expect(registered).toHaveLength(7)
    expect(registered).toContain('doc_market_search')
    expect(registered).toContain('doc_market_install')
    // Three routes since S3: the read catalog plus the two write channels (×2 mounts now).
    expect(handlers.length - first).toBe(3)
    const [read, configRoute, paramRoute] = handlers.slice(first)
    const res = fakeResMaker()
    await read!({}, res)
    const configPost = { method: 'POST', headers: { origin: 'https://h', host: 'h' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"patch":{"maxIterations":4}}') } }
    const resConfig = fakeResMaker()
    await configRoute!(configPost, resConfig)
    // The fake editor lists no docwright entry: the proxy surfaces the locator error.
    expect(resConfig.statusCode).toBe(422)
    expect(JSON.parse(resConfig.body).error).toContain('no profile entry for docwright')
    // The pack-param closure is wired through to the write channel (unknown pack → loud 422).
    const paramPost = { method: 'POST', headers: { origin: 'https://h', host: 'h' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"pack":"ghost","param":"x","value":1}') } }
    const resParam = fakeResMaker()
    await paramRoute!(paramPost, resParam)
    expect(resParam.statusCode).toBe(422)
    expect(JSON.parse(resParam.body).error).toContain('unknown pack "ghost"')
    const payload = JSON.parse(res.body) as { packs: { name: string }[]; config: { key: string }[] }
    expect(res.statusCode).toBe(200)
    expect(payload.packs.map(p => p.name)).toContain('cosmic-plan')
    expect(payload.config.find(e => e.key === 'confirmPolicy')).toBeDefined()
  })
})

describe('POST write routes', () => {
  function fakeServer() {
    const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }> = []
    const webServer: WebServerLike = { register: route => { routes.push(route as never); return () => {} } }
    return { webServer, routes }
  }
  const fakeRes = () => {
    const res = { statusCode: 0, headers: {} as Record<string, string>, body: '' }
    const typed = res as unknown as { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }
    typed.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers }
    typed.end = body => { res.body = body }
    return { res, typed }
  }
  const req = (method: string, origin?: string, host?: string, body?: string) => ({
    method,
    headers: { ...(origin === undefined ? {} : { origin }), ...(host === undefined ? {} : { host }), ...(body === undefined ? {} : { 'content-length': String(body.length) }) },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
  })

  it('mounts all three routes when writes are provided', () => {
    const { webServer, routes } = fakeServer()
    mountParamsRoutes(webServer, { payload: () => ({}), writes: { updateConfig: () => Promise.resolve(), setPackParamDefault: () => Promise.resolve() } })
    expect(routes.map(r => r.path)).toEqual(['/api/docwright/params', '/api/docwright/config', '/api/docwright/pack-param'])
  })

  it('forwards valid bodies to the config channel and reports failures as 422 with the message', async () => {
    const { webServer, routes } = fakeServer()
    const got: unknown[] = []
    mountParamsRoutes(webServer, {
      payload: () => ({}),
      writes: { updateConfig: patch => { got.push(patch); return Promise.resolve() }, setPackParamDefault: () => Promise.resolve() },
    })
    const config = routes.find(r => r.path === '/api/docwright/config')!
    const ok = fakeRes()
    await config.handler(req('POST', 'https://h', 'h', JSON.stringify({ patch: { maxIterations: 3 } })), ok.typed as never)
    expect(ok.res.statusCode).toBe(200)
    expect(got).toEqual([{ maxIterations: 3 }])
    const bad = fakeRes()
    await config.handler(req('POST', 'https://h', 'h', JSON.stringify({ patch: 'nope' })), bad.typed as never)
    expect(bad.res.statusCode).toBe(422)
    expect(JSON.parse(bad.res.body).error).toContain('patch')
  })

  it('enforces the gate, method, origin, and body limits before the handler', async () => {
    const { webServer, routes } = fakeServer()
    let called = 0
    mountParamsRoutes(webServer, {
      payload: () => ({}),
      connection: () => ({ requestRejection: () => 403 }),
      writes: { updateConfig: () => { called += 1; return Promise.resolve() }, setPackParamDefault: () => Promise.resolve() },
    })
    const config = routes.find(r => r.path === '/api/docwright/config')!
    const gated = fakeRes()
    await config.handler(req('POST', 'https://h', 'h', '{"patch":{}}'), gated.typed as never)
    expect(gated.res.statusCode).toBe(403)
    expect(JSON.parse(gated.res.body).code).toBe('gateRejected')
    expect(JSON.parse(gated.res.body).params).toEqual({ status: 403 })
    expect(called).toBe(0)
    const { webServer: ws2, routes: r2 } = fakeServer()
    mountParamsRoutes(ws2, { payload: () => ({}), writes: { updateConfig: () => { called += 1; return Promise.resolve() }, setPackParamDefault: () => Promise.resolve() } })
    const c2 = r2.find(r => r.path === '/api/docwright/config')!
    const wrongMethod = fakeRes()
    await c2.handler(req('GET', 'https://h', 'h'), wrongMethod.typed as never)
    expect(wrongMethod.res.statusCode).toBe(403)
    const crossSite = fakeRes()
    await c2.handler(req('POST', 'https://evil', 'h', '{"patch":{}}'), crossSite.typed as never)
    expect(crossSite.res.statusCode).toBe(403)
    expect(JSON.parse(crossSite.res.body).code).toBe('crossSiteWrite')
    const badJson = fakeRes()
    await c2.handler(req('POST', 'https://h', 'h', '{oops'), badJson.typed as never)
    expect(badJson.res.statusCode).toBe(400)
    expect(JSON.parse(badJson.res.body).code).toBe('invalidJsonBody')
    const oversized = fakeRes()
    await c2.handler(req('POST', 'https://h', 'h', 'x'.repeat(70 * 1024)), oversized.typed as never)
    expect(oversized.res.statusCode).toBe(413)
    expect(JSON.parse(oversized.res.body).code).toBe('bodyTooLarge')
    const malformedOrigin = fakeRes()
    await c2.handler(req('POST', 'http://[', 'h', '{"patch":{}}'), malformedOrigin.typed as never)
    expect(malformedOrigin.res.statusCode).toBe(403)
    expect(called).toBe(0)
  })

  it('carries the write channel\'s coded errors through the 422 envelope', async () => {
    const { webServer, routes } = fakeServer()
    mountParamsRoutes(webServer, {
      payload: () => ({}),
      writes: {
        updateConfig: () => Promise.resolve(),
        setPackParamDefault: () => Promise.reject(new CodedError('unknownPack', 'unknown pack "ghost" (available: wp); nothing was written', { params: { pack: 'ghost', available: 'wp' } })),
      },
    })
    const param = routes.find(r => r.path === '/api/docwright/pack-param')!
    const res = fakeRes()
    await param.handler(req('POST', 'https://h', 'h', JSON.stringify({ pack: 'ghost', param: 'limit', value: 3 })), res.typed as never)
    expect(res.res.statusCode).toBe(422)
    const envelope = JSON.parse(res.res.body) as { error: string; code: string; params: Record<string, string> }
    expect(envelope.code).toBe('unknownPack')
    expect(envelope.params).toEqual({ pack: 'ghost', available: 'wp' })
  })

  it('fails closed at 403 when the host gate itself throws', async () => {
    const { webServer, routes } = fakeServer()
    mountParamsRoutes(webServer, {
      payload: () => ({ ok: 1 }),
      connection: () => ({ requestRejection: () => { throw new Error('gate bug') } }),
    })
    const read = routes.find(r => r.path === '/api/docwright/params')!
    const res = fakeRes()
    await read.handler({}, res.typed as never)
    expect(res.res.statusCode).toBe(403)
  })

  it('refuses a value-less pack-param body and disposes all three routes together', async () => {
    const { webServer, routes } = fakeServer()
    mountParamsRoutes(webServer, {
      payload: () => ({}),
      writes: { updateConfig: () => Promise.resolve(), setPackParamDefault: () => Promise.resolve() },
    })
    const param = routes.find(r => r.path === '/api/docwright/pack-param')!
    const missing = fakeRes()
    await param.handler(req('POST', 'https://h', 'h', JSON.stringify({ pack: 'wp', param: 'limit' })), missing.typed as never)
    expect(missing.res.statusCode).toBe(422)
    expect(JSON.parse(missing.res.body).error).toContain('body.value is required')
    const dispose = mountParamsRoutes(webServer, { payload: () => ({}), writes: { updateConfig: () => Promise.resolve(), setPackParamDefault: () => Promise.resolve() } })
    expect(webServer.register).toBeDefined()
    dispose()
  })

  it('routes pack-param bodies to the write channel with both names', async () => {
    const { webServer, routes } = fakeServer()
    const got: Array<[string, string, unknown]> = []
    mountParamsRoutes(webServer, {
      payload: () => ({}),
      writes: { updateConfig: () => Promise.resolve(), setPackParamDefault: (p, n, v) => { got.push([p, n, v]); return Promise.resolve() } },
    })
    const param = routes.find(r => r.path === '/api/docwright/pack-param')!
    const ok = fakeRes()
    await param.handler(req('POST', 'https://h', 'h', JSON.stringify({ pack: 'wp', param: 'limit', value: 7 })), ok.typed as never)
    expect(ok.res.statusCode).toBe(200)
    expect(got).toEqual([['wp', 'limit', 7]])
    const missing = fakeRes()
    await param.handler(req('POST', 'https://h', 'h', JSON.stringify({ pack: 'wp' })), missing.typed as never)
    expect(missing.res.statusCode).toBe(422)
  })
  it('routes suite bodies to the suite lane: status read, update, delete', async () => {
    const { webServer, routes } = fakeServer()
    const calls: string[] = []
    mountParamsRoutes(webServer, {
      payload: () => ({}),
      writes: {
        updateConfig: () => Promise.resolve(),
        setPackParamDefault: () => Promise.resolve(),
        packLane: {
          checkUpdates: () => Promise.resolve([]),
          updatePack: () => Promise.resolve({ version: '1' }),
          deletePack: () => Promise.resolve(),
          suiteStatus: () => { calls.push('status'); return Promise.resolve([{ name: 'cosmic', members: [] }]) },
          updateSuite: suite => { calls.push(`update:${suite}`); return Promise.resolve({ updated: [{ name: 'cosmic-plan', version: '2' }], unchanged: [], missing: [] }) },
          deleteSuite: suite => { calls.push(`delete:${suite}`); return Promise.resolve({ deleted: ['cosmic-plan'] }) },
        },
      },
    })
    expect(routes.map(r => r.path)).toContain('/api/docwright/suites')
    const status = routes.find(r => r.path === '/api/docwright/suites')!
    const resStatus = fakeRes()
    await status.handler(req('GET'), resStatus.typed as never)
    expect(resStatus.res.statusCode).toBe(200)
    expect(JSON.parse(resStatus.res.body).suites).toEqual([{ name: 'cosmic', members: [] }])
    const update = routes.find(r => r.path === '/api/docwright/suite-update')!
    const resUpdate = fakeRes()
    await update.handler(req('POST', 'https://h', 'h', JSON.stringify({ suite: 'cosmic' })), resUpdate.typed as never)
    expect(resUpdate.res.statusCode).toBe(200)
    expect(JSON.parse(resUpdate.res.body)).toMatchObject({ ok: true, updated: [{ name: 'cosmic-plan', version: '2' }] })
    const del = routes.find(r => r.path === '/api/docwright/suite-delete')!
    const resDelete = fakeRes()
    await del.handler(req('POST', 'https://h', 'h', JSON.stringify({ suite: 'cosmic' })), resDelete.typed as never)
    expect(resDelete.res.statusCode).toBe(200)
    expect(JSON.parse(resDelete.res.body)).toMatchObject({ ok: true, deleted: ['cosmic-plan'] })
    expect(calls).toEqual(['status', 'update:cosmic', 'delete:cosmic'])
    // A coded lane failure keeps the 422 envelope contract.
    mountParamsRoutes(webServer, {
      payload: () => ({}),
      writes: {
        updateConfig: () => Promise.resolve(),
        setPackParamDefault: () => Promise.resolve(),
        packLane: {
          checkUpdates: () => Promise.resolve([]),
          updatePack: () => Promise.resolve({ version: '1' }),
          deletePack: () => Promise.resolve(),
          updateSuite: () => Promise.reject(new CodedError('absentFromMarket', 'suite "x" is not offered', { params: { pack: 'x' } })),
        },
      },
    })
    const failing = routes.filter(r => r.path === '/api/docwright/suite-update').at(-1)!
    const resFail = fakeRes()
    await failing.handler(req('POST', 'https://h', 'h', JSON.stringify({ suite: 'x' })), resFail.typed as never)
    expect(resFail.res.statusCode).toBe(422)
    expect(JSON.parse(resFail.res.body).code).toBe('absentFromMarket')
  })
})

describe('registerTools wiring: the pack lane', () => {
  it('mounts update/delete/updates routes when packsDir is configured and wires them to the lane', async () => {
    const { registerTools } = await import('../src/index.ts')
    const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'docwright-lane-'))
    const packDir = join(dir, 'gw')
    for (const sub of ['rules', 'prompts', 'templates', 'samples']) await mkdir(join(packDir, sub), { recursive: true })
    await writeFile(join(packDir, 'manifest.json'), JSON.stringify({ name: 'gw', version: '1', description: 'd', consumes: [], languages: ['zh-CN'] }), 'utf8')
    await writeFile(join(packDir, 'rules', 'zh-CN.json'), JSON.stringify([{ id: 'gw/r', severity: 'error', given: '$', field: 'name', kind: 'minLength', min: 1, suggestion: 's' }]), 'utf8')
    await writeFile(join(packDir, 'schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(packDir, 'prompts', 'zh-CN.md'), 'T {{materials}}', 'utf8')
    await writeFile(join(packDir, 'templates', 'zh-CN.hbs'), 't', 'utf8')
    await writeFile(join(packDir, 'samples', 'golden.json'), '{}', 'utf8')
    const handlers: Array<(req: unknown, res: unknown) => Promise<void> | void> = []
    const hostCtx = {
      effect(fn: () => () => void) { fn() },
      webServer: { register: (r: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) => { handlers.push(r.handler); return () => {} } },
    }
    const ctx = {
      tools: { register: () => {} },
      inject(deps: string[], cb: (hostCtx: unknown) => void) { if (deps.includes('webServer')) cb(hostCtx) },
      get() { return { entries: () => [], edit: () => Promise.resolve() } },
    }
    const laneConfig: Record<string, unknown> = { workspaceRoot: '/w', packsDir: dir, marketUrl: 'http://127.0.0.1:1' }
    await registerTools(ctx as never, laneConfig as never, packsRoot)
    const paths = ['pack-updates', 'pack-update', 'pack-delete', 'suites', 'suite-update', 'suite-delete']
    const byPath = (suffix: string) => handlers[handlers.length - 6 + paths.findIndex(p => suffix.endsWith(p))]!
    const fakeRes = () => { const res = { statusCode: 0, body: '', writeHead(s: number) { res.statusCode = s }, end(b: string) { res.body = b } }; return res }
    const req = (method: string, body?: unknown) => ({ method, headers: { origin: 'https://h', host: 'h' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } })

    // A dead market answers the READ with 200 + coded envelope (never error UI).
    // The handler is fire-and-forget (void promise), so yield a tick.
    const resUpdates = fakeRes()
    await byPath('pack-updates')(req('GET'), resUpdates)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(resUpdates.statusCode).toBe(200)
    expect(JSON.parse(resUpdates.body).code).toBe('marketUnreachable')

    // Update through a working fake market: the route answers 200 with the
    // installed version (the success face of the lane).
    const { createServer } = await import('node:http')
    const { execFile } = await import('node:child_process')
    const { readFile } = await import('node:fs/promises')
    const { promisify } = await import('node:util')
    const execAsync = promisify(execFile)
    const archive = join(dir, 'gw.tgz')
    await execAsync('tar', ['-czf', archive, '-C', packDir, '.'])
    const bytes = await readFile(archive)
    const { createHash } = await import('node:crypto')
    const { dirHash } = await import('../src/pack-manage.ts')
    const indexBody = { packs: [{ name: 'gw', version: '1', tarball: '/tarballs/gw-2.tgz', tarballSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, contentHash: await dirHash(packDir) }] }
    const market = createServer((request, response) => {
      if (String(request.url).endsWith('/api/index')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(indexBody))
        return
      }
      response.writeHead(200, { 'content-type': 'application/gzip' })
      response.end(bytes)
    })
    await new Promise<void>(resolve => market.listen(0, '127.0.0.1', resolve))
    const port = (market.address() as { port: number }).port
    laneConfig.marketUrl = `http://127.0.0.1:${port}`
    const resUpdate = fakeRes()
    await byPath('pack-update')(req('POST', { pack: 'gw' }), resUpdate)
    expect(resUpdate.statusCode).toBe(200)
    expect(JSON.parse(resUpdate.body)).toMatchObject({ ok: true, version: '1' })

    // The suite lane rides the same wiring: this fake market answers /api/suites
    // with garbage (a market older than suites would 404 → []), so the read
    // degrades to the coded 200 envelope — never error UI.
    const resSuites = fakeRes()
    await byPath('suites')(req('GET'), resSuites)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(resSuites.statusCode).toBe(200)
    expect(JSON.parse(resSuites.body).code).toBe('marketUnreachable')
    const resSuiteUpdate = fakeRes()
    await byPath('suite-update')(req('POST', { suite: 'gw' }), resSuiteUpdate)
    expect(resSuiteUpdate.statusCode).toBe(422)
    expect(JSON.parse(resSuiteUpdate.body).code).toBe('marketUnreachable')
    const resSuiteDelete = fakeRes()
    await byPath('suite-delete')(req('POST', { suite: 'gw' }), resSuiteDelete)
    expect(resSuiteDelete.statusCode).toBe(422)
    market.close()

    // Delete needs no market: the directory goes, the reload succeeds.
    const resDelete = fakeRes()
    await byPath('pack-delete')(req('POST', { pack: 'gw' }), resDelete)
    expect(resDelete.statusCode).toBe(200)
    expect(JSON.parse(resDelete.body)).toEqual({ ok: true })

    await rm(dir, { recursive: true, force: true })
  })
})

describe('registerTools wiring: lane gates and bad bodies', () => {
  it('answers gateRejected on the lane routes and invalidParamBody on a missing pack name', async () => {
    const { registerTools } = await import('../src/index.ts')
    const handlers: Array<(req: unknown, res: unknown) => Promise<void> | void> = []
    const connection = { requestRejection: () => 401 }
    const hostCtx = {
      effect(fn: () => () => void) { fn() },
      webServer: { register: (r: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) => { handlers.push(r.handler); return () => {} } },
    }
    const ctx = {
      tools: { register: () => {} },
      inject(deps: string[], cb: (hostCtx: unknown) => void) { if (deps.includes('webServer')) cb(hostCtx) },
      get(name: string) {
        if (name === 'connection') return connection
        return { entries: () => [], edit: () => Promise.resolve() }
      },
    }
    await registerTools(ctx as never, { workspaceRoot: '/w', packsDir: '/tmp/docwright-lane-gate' } as never, packsRoot)
    const fakeRes = () => { const res = { statusCode: 0, body: '', writeHead(s: number) { res.statusCode = s }, end(b: string) { res.body = b } }; return res }
    const req = (method: string, body?: unknown) => ({ method, headers: { origin: 'https://h', host: 'h' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) } })
    const lane = handlers.slice(handlers.length - 6)
    const [updates, update, del] = lane

    // Host gate on the read (updates, suite status) and on the delete writes.
    const resUpdates = fakeRes()
    await updates!(req('GET'), resUpdates)
    expect(resUpdates.statusCode).toBe(401)
    expect(JSON.parse(resUpdates.body).code).toBe('gateRejected')
    const resDelete = fakeRes()
    await del!(req('POST', { pack: 'x' }), resDelete)
    expect(resDelete.statusCode).toBe(401)
    const resSuiteStatus = fakeRes()
    await lane[3]!(req('GET'), resSuiteStatus)
    expect(resSuiteStatus.statusCode).toBe(401)
    const resSuiteDelete = fakeRes()
    await lane[5]!(req('POST', { suite: 'x' }), resSuiteDelete)
    expect(resSuiteDelete.statusCode).toBe(401)

    // A missing pack name in the write body names the shape (422) — on a
    // NON-gated mount, since the gate outranks body validation. The suite
    // writes demand a non-empty suite name the same way.
    const plainHandlers: Array<(req: unknown, res: unknown) => Promise<void> | void> = []
    const plainCtx = {
      tools: { register: () => {} },
      inject(deps: string[], cb: (hostCtx: unknown) => void) { if (deps.includes('webServer')) cb({ effect(fn: () => () => void) { fn() }, webServer: { register: (r: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) => { plainHandlers.push(r.handler); return () => {} } } }) },
      get() { return { entries: () => [], edit: () => Promise.resolve() } },
    }
    await registerTools(plainCtx as never, { workspaceRoot: '/w', packsDir: '/tmp/docwright-lane-gate' } as never, packsRoot)
    const resUpdate = fakeRes()
    await plainHandlers[plainHandlers.length - 5]!(req('POST', {}), resUpdate)
    expect(resUpdate.statusCode).toBe(422)
    expect(JSON.parse(resUpdate.body).code).toBe('invalidParamBody')
    const resSuiteUpdate = fakeRes()
    await plainHandlers[plainHandlers.length - 2]!(req('POST', {}), resSuiteUpdate)
    expect(resSuiteUpdate.statusCode).toBe(422)
    expect(JSON.parse(resSuiteUpdate.body).code).toBe('invalidParamBody')
    // A packLane without the suite functions: the status read answers an
    // empty list rather than an error (deployment-level graceful degrade).
    const { mountParamsRoutes } = await import('../src/http.ts')
    const bareHandlers: Array<(req: unknown, res: unknown) => Promise<void> | void> = []
    mountParamsRoutes({ register: (r: { handler: (req: unknown, res: unknown) => Promise<void> | void }) => { bareHandlers.push(r.handler); return () => {} } } as never, {
      payload: () => ({}),
      writes: { updateConfig: async () => {}, setPackParamDefault: async () => {}, packLane: { checkUpdates: async () => [], updatePack: async () => ({ version: '1' }), deletePack: async () => {} } },
    })
    const resEmpty = fakeRes()
    await bareHandlers[bareHandlers.length - 3]!(req('GET'), resEmpty)
    expect(resEmpty.statusCode).toBe(200)
    expect(JSON.parse(resEmpty.body)).toEqual({ suites: [] })
  })
})
