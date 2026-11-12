import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, buildStatusPayload, runSync } from '../index.js'

/**
 * A stand-in for the Host settings service.
 *
 * The service holds two layers: the profile override, which a write replaces,
 * and the inherited layer, which holds the provider map when the user
 * configured it there instead of in the profile. The write is handed the
 * override's projection and its result is merged over the override with the
 * volatile fields stripped, so the `providers` map a write carries replaces
 * the inherited one outright.
 *
 * @param options - `{ providers, override }`; `override` defaults to the
 *   effective provider map, and `{}` models an override that holds none.
 * @returns the settings fake.
 */
function fakeSettings({ providers = {}, override } = {}) {
  const writes = []
  const current = override ?? { providers }
  return {
    writes,
    describe() {
      return [{
        ns: 'llm-pi-ai',
        revision: 3,
        value: { providers },
      }]
    },
    async write(ns, change, expected, paths) {
      writes.push({ ns, expected, paths, next: change(current) })
    },
  }
}

/**
 * A Host context with the services the plugin uses.
 *
 * @param options - `{ settings, profileDir, webServer }`.
 * @returns the fake context.
 */
function ctxWith({ settings, profileDir = '/tmp/dsh-minimax-test', webServer } = {}) {
  const effects = []
  const logs = []
  return {
    settings,
    effects,
    logs,
    logger: {
      error(...args) {
        logs.push(args)
      },
    },
    get(name) {
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      if (name === 'settings') return settings
      if (name === 'profileContext') return { dir: profileDir }
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(setup) {
      const dispose = setup()
      effects.push(dispose)
      return dispose
    },
  }
}

/**
 * Run every disposer the context collected, once.
 *
 * @param ctx - the fake context.
 */
function disposeAll(ctx) {
  for (const dispose of ctx.effects.splice(0)) dispose()
}

function makeContext(options = {}) {
  const settings = options.settings ?? fakeSettings()
  return ctxWith({ ...options, settings })
}

/**
 * A stand-in for the web server service.
 *
 * @returns the web server fake.
 */
function fakeWebServer() {
  const registered = []
  const removed = []
  return {
    registered,
    removed,
    register(route) {
      registered.push(route)
      return () => removed.push(route.path)
    },
  }
}

/**
 * A request that lets the test close it.
 *
 * @param method - the request method.
 * @returns the fake request.
 */
function fakeRequest(method = 'GET') {
  const listeners = new Map()
  return {
    method,
    once(event, listener) {
      listeners.set(event, listener)
    },
    close() {
      listeners.get('close')?.()
    },
  }
}

function fakeResponse() {
  return {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.status = status },
    end(body) { this.body = body; this.writableEnded = true },
  }
}

const MODEL_IDS = ['MiniMax-M3.1-Flash', 'MiniMax-M2']
const PROBE_FETCH = async (_url, init) => {
  const body = JSON.parse(init.body)
  if (body.max_tokens === 999999999) {
    if (body.model === 'MiniMax-M2') {
      return new Response(JSON.stringify({ error: { message: 'The model "MiniMax-M2" is no longer available. (2069)' } }), { status: 400 })
    }
    return new Response(JSON.stringify({ error: { message: 'invalid params, model[MiniMax-M3.1-Flash] does not support max tokens > 524288 (2013)' } }), { status: 400 })
  }
  return new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: '391' }, { type: 'text', text: '391' }] }), { status: 200 })
}

const fakeFetch = async (url, init) => {
  if (String(url).endsWith('/v1/models')) {
    return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
  }
  return PROBE_FETCH(url, init)
}

test('runSync appends a newly released model and leaves the rest alone', async () => {
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M3', maxTokens: 512000 }] },
      'other-route': { apiKeyEnv: 'OTHER_API_KEY' },
    },
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, ['MiniMax-M3.1-Flash'])
  assert.equal(settings.writes.length, 1)
  const write = settings.writes[0]
  // The write names the namespace, the revision it read and the one volatile
  // path it changed, so a write to the wrong place cannot pass unnoticed.
  assert.equal(write.ns, 'llm-pi-ai')
  assert.equal(write.expected, 3)
  assert.deepEqual(write.paths, ['providers', 'minimax-cn', 'models'])
  const written = write.next.providers['minimax-cn'].models
  assert.equal(written.length, 2)
  assert.equal(written[0].id, 'MiniMax-M3')
  assert.equal(written[0].maxTokens, 512000)
  assert.equal(written[1].id, 'MiniMax-M3.1-Flash')
  assert.equal(written[1].maxTokens, 524288)
  // The rest of the route survives, and so does every other provider.
  assert.equal(write.next.providers['minimax-cn'].apiKeyEnv, 'MINIMAX_CN_API_KEY')
  assert.deepEqual(write.next.providers['other-route'], { apiKeyEnv: 'OTHER_API_KEY' })
})

test('runSync keeps a route that only an inherited layer configures', async () => {
  // The user's provider map lives in an inherited layer, so the profile
  // override the write is handed holds no providers at all. The settings
  // service replaces the whole map, so a map built from that override alone
  // would drop the route and the credential environment it needs.
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M3', maxTokens: 512000 }] },
      'other-route': { apiKeyEnv: 'OTHER_API_KEY' },
    },
    override: {},
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, ['MiniMax-M3.1-Flash'])
  assert.equal(settings.writes.length, 1)
  const written = settings.writes[0].next.providers
  // The route keeps the credential environment the inherited layer gave it.
  assert.equal(written['minimax-cn'].apiKeyEnv, 'MINIMAX_CN_API_KEY')
  // Its model list is the one the sync planned.
  assert.deepEqual(written['minimax-cn'].models.map((entry) => entry.id), ['MiniMax-M3', 'MiniMax-M3.1-Flash'])
  // The sibling route is not lost either.
  assert.deepEqual(written['other-route'], { apiKeyEnv: 'OTHER_API_KEY' })
})

test('runSync still succeeds when the state cannot be written', async () => {
  const ctx = makeContext()
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/profile',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => { throw new Error('EACCES') },
  })
  assert.equal(result.ok, true)
  assert.equal(ctx.settings.writes.length, 1)
})

test('runSync never writes a retired model', async () => {
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.deepEqual(result.added, ['MiniMax-M3.1-Flash'])
  assert.equal(settings.writes.length, 1)
  const written = settings.writes[0].next.providers['minimax-cn'].models
  assert.equal(written.some((entry) => entry.id === 'MiniMax-M2'), false)
})

test('runSync writes nothing when there is no new model', async () => {
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M3.1-Flash', maxTokens: 524288 }] },
    },
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, [])
  assert.equal(settings.writes.length, 0)
})

test('runSync reports a missing credential without writing', async () => {
  const settings = fakeSettings()
  const ctx = ctxWith({ settings })
  ctx.get = (name) => {
    if (name === 'settings') return settings
    return undefined
  }
  const result = await runSync(ctx, { credentialRef: 'MINIMAX_CN_API_KEY' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing-credential')
  assert.equal(settings.writes.length, 0)
})

test('runSync reports a model list that could not be read', async () => {
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: async () => { throw new Error('fetch failed') },
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  // A list that could not be read is not an empty account, so nothing is
  // written and the sync says why.
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'model-list-failed')
  assert.equal(settings.writes.length, 0)
})

test('a model the plugin added before is not probed again', async () => {
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings })
  const probed = []
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
      }
      probed.push(JSON.parse(init.body).model)
      return PROBE_FETCH(url, init)
    },
    stateReader: async () => ({ addedModels: ['MiniMax-M3.1-Flash'], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  // The user deleted the model by hand, so it stays deleted and costs
  // nothing to measure.
  assert.deepEqual(result.added, [])
  assert.deepEqual(probed, ['MiniMax-M2'])
  assert.equal(settings.writes.length, 0)
})

test('two overlapping syncs run as one', async () => {
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings })
  const options = {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  }
  const [first, second] = await Promise.all([runSync(ctx, options), runSync(ctx, options)])
  assert.deepEqual(first.added, ['MiniMax-M3.1-Flash'])
  assert.deepEqual(second.added, first.added)
  assert.equal(settings.writes.length, 1)
})

test('a refused profile write fails the sync instead of retrying blindly', async () => {
  const settings = fakeSettings()
  settings.write = async () => {
    throw new Error('settings namespace "llm-pi-ai" changed since it was read (expected revision 3, now 4)')
  }
  const ctx = ctxWith({ settings })
  await assert.rejects(() => runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  }), /changed since it was read/)
})

test('buildStatusPayload reports the quota and the synced model ids', async () => {
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M3.1-Flash' }] },
    },
  })
  const ctx = ctxWith({ settings })
  const payload = await buildStatusPayload(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    stateReader: async () => ({ addedModels: ['MiniMax-M3.1-Flash'], lastSyncAt: 1760000000000 }),
    quotaFetcher: async (_ctx, _ref, _signal) => ({ ok: true, intervalRemainingPercent: 82, weeklyRemainingPercent: 35 }),
  })
  assert.equal(payload.quota.ok, true)
  assert.deepEqual(payload.models.synced, ['MiniMax-M3', 'MiniMax-M3.1-Flash'])
  assert.deepEqual(payload.models.added, ['MiniMax-M3.1-Flash'])
  assert.equal(payload.models.syncedAt, 1760000000000)
})

test('apply registers both routes and disposes them again', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  try {
    await apply(ctx, {})
    assert.deepEqual(webServer.registered.map((route) => route.path), [
      '/plugin/minimax/status',
      '/plugin/minimax/sync',
    ])
    disposeAll(ctx)
    assert.deepEqual(webServer.removed, ['/plugin/minimax/status', '/plugin/minimax/sync'])
  } finally {
    disposeAll(ctx)
  }
})

test('the sync route refuses a method that is not POST', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  try {
    await apply(ctx, {})
    const sync = webServer.registered.find((route) => route.path === '/plugin/minimax/sync')
    const res = fakeResponse()
    await sync.handler(fakeRequest('GET'), res)
    assert.equal(res.status, 405)
    assert.equal(JSON.parse(res.body).reason, 'method-not-allowed')
  } finally {
    disposeAll(ctx)
  }
})

test('the status route answers even when the payload cannot be built', async () => {
  const webServer = fakeWebServer()
  const settings = {
    describe() { throw new Error('the settings service exploded') },
    write() {},
  }
  const ctx = ctxWith({ settings, webServer })
  try {
    await apply(ctx, {})
    const status = webServer.registered.find((route) => route.path === '/plugin/minimax/status')
    const res = fakeResponse()
    await status.handler(fakeRequest('GET'), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.quota.ok, false)
    assert.equal(payload.quota.reason, 'request-failed')
    assert.deepEqual(payload.models, { synced: [], added: [], syncedAt: null })
    // The browser learns that the request failed and nothing else.
    assert.equal(payload.quota.message, undefined)
    assert.equal(res.body.includes('exploded'), false)
    // The message went to the Host side instead.
    assert.equal(ctx.logs.length, 1)
    assert.equal(ctx.logs[0].some((arg) => arg instanceof Error && arg.message.includes('exploded')), true)
  } finally {
    disposeAll(ctx)
  }
})

test('the sync route answers a failed sync without carrying the message', async () => {
  const webServer = fakeWebServer()
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  settings.write = async () => {
    throw new Error('settings namespace "llm-pi-ai" changed since it was read')
  }
  const ctx = ctxWith({ settings, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    const sync = webServer.registered.find((route) => route.path === '/plugin/minimax/sync')
    const res = fakeResponse()
    await sync.handler(fakeRequest('POST'), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    assert.equal(payload.reason, 'sync-failed')
    // The browser never sees the internal message.
    assert.equal(payload.message, undefined)
    assert.equal(res.body.includes('changed since it was read'), false)
    // The message went to the Host side instead.
    assert.equal(ctx.logs.length, 1)
    assert.equal(ctx.logs[0].some((arg) => arg instanceof Error && arg.message.includes('changed since it was read')), true)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
  }
})

test('the status route aborts its upstream request when the request closes', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  const originalFetch = globalThis.fetch
  let captured = null
  let release
  let reached
  const gate = new Promise((resolve) => { release = resolve })
  const called = new Promise((resolve) => { reached = resolve })
  globalThis.fetch = async (_url, init) => {
    captured = init
    reached()
    await gate
    return new Response(JSON.stringify({ base_resp: { status_code: 0 } }), { status: 200 })
  }
  try {
    await apply(ctx, {})
    const status = webServer.registered.find((route) => route.path === '/plugin/minimax/status')
    const req = fakeRequest('GET')
    const res = fakeResponse()
    const pending = status.handler(req, res)
    await called
    req.close()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(captured.signal.aborted, true)
    release()
    await pending
    assert.equal(res.status, 200)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
  }
})

test('the sync route aborts its upstream request when the request closes', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  const originalFetch = globalThis.fetch
  let captured = null
  let release
  let reached
  const gate = new Promise((resolve) => { release = resolve })
  const called = new Promise((resolve) => { reached = resolve })
  globalThis.fetch = async (_url, init) => {
    captured = init
    reached()
    await gate
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  try {
    await apply(ctx, {})
    const sync = webServer.registered.find((route) => route.path === '/plugin/minimax/sync')
    const req = fakeRequest('POST')
    const res = fakeResponse()
    const pending = sync.handler(req, res)
    await called
    req.close()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(captured.signal.aborted, true)
    release()
    await pending
    assert.equal(res.status, 200)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
  }
})

test('the first sync is cancelled when the plugin is disposed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  try {
    await apply(ctx, {})
    // The plugin is unloaded before the first attempt comes due, so the
    // pending timer must not run a sync that writes the profile afterwards.
    disposeAll(ctx)
    t.mock.timers.tick(10_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fetches, 0)
    assert.equal(ctx.settings.writes.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    t.mock.timers.reset()
  }
})
