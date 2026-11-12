import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply, buildStatusPayload, inject, runSync } from '../index.js'
import { STATE_FILENAME } from '../lib/state.js'

/**
 * The defaults the pi-ai schema materialises into a provider route.
 *
 * The real service answers with the schema-resolved map, so a route that
 * the user configured without them carries them anyway.
 */
const ROUTE_DEFAULTS = {
  defaultContextWindow: 1000000,
  defaultMaxTokens: 128000,
  defaultInput: ['text'],
}

/** The default the pi-ai schema materialises into every model entry. */
const MODEL_DEFAULTS = { compat: {} }

/**
 * Resolve one provider route the way the pi-ai schema does.
 *
 * @param route - the route as it was written.
 * @returns the resolved route.
 */
function resolveRoute(route) {
  if (route === null || typeof route !== 'object') return route
  const resolved = { ...route, ...ROUTE_DEFAULTS }
  if (Array.isArray(route.models)) {
    resolved.models = route.models.map((entry) => (
      entry !== null && typeof entry === 'object' ? { ...entry, ...MODEL_DEFAULTS } : entry
    ))
  }
  return resolved
}

/**
 * Resolve a provider map the way the pi-ai schema does.
 *
 * @param providers - the map as it was written.
 * @returns the resolved map.
 */
function resolveProviders(providers) {
  const resolved = {}
  for (const [id, route] of Object.entries(providers ?? {})) resolved[id] = resolveRoute(route)
  return resolved
}

/**
 * A stand-in for the Host settings service.
 *
 * The service holds two layers: the profile override, which a write replaces,
 * and the inherited layer, which holds the provider map when the user
 * configured it there instead of in the profile. The write is handed the
 * current projection, the inherited projection and the schema, and its result
 * replaces the whole `providers` map, so a route that only an inherited layer
 * configures is lost when the written map does not carry it.
 *
 * The effective projection the service answers with is the schema-resolved
 * one: every route and every model entry carries the defaults the pi-ai
 * schema materialises. The fake resolves its map the same way, so a test sees
 * what the service really answers — a materialised default on an entry the
 * user wrote. The override the service answers with is the raw profile row,
 * which carries the entries exactly as the user wrote them.
 *
 * @param options - `{ providers, override }`; `providers` is the inherited
 *   layer's map, and `override` is the raw profile row, which defaults to a
 *   row holding the same map.
 * @returns the settings fake.
 */
function fakeSettings({ providers = {}, override } = {}) {
  const writes = []
  const state = {
    revision: 3,
    inherited: providers,
    override: override ?? { providers },
  }

  /**
   * The provider map the effective projection holds.
   *
   * The loader merges the layers shallowly, so an override that carries a
   * provider map replaces the inherited one.
   *
   * @returns the effective map.
   */
  const effectiveProviders = () => {
    const own = state.override?.providers
    const base = state.inherited ?? {}
    if (own !== null && typeof own === 'object') return { ...base, ...own }
    return base
  }

  return {
    writes,
    describe() {
      return [{
        ns: 'llm-pi-ai',
        // The revision moves when the profile changes, so a write that
        // carries a stale one cannot pass unnoticed.
        revision: state.revision,
        value: { providers: resolveProviders(effectiveProviders()) },
        // The override is the raw profile row: the entries carry the wording
        // the user wrote, with no default materialised into them.
        user: state.override?.providers === undefined
          ? {}
          : { providers: state.override.providers },
      }]
    },
    async write(ns, change, expected, paths) {
      // The Host service reads every entry of `paths` as a list of field
      // segments and joins them with a dot, so a write that hands it a flat
      // list of segments fails there with `path.join is not a function`. The
      // fake refuses the same shape, so the contract cannot drift unnoticed.
      for (const path of paths ?? []) {
        if (!Array.isArray(path)) {
          throw new TypeError('settings.write expects a list of field paths')
        }
      }
      // The service hands the change the current projection, the inherited
      // one and the schema.
      const next = change(
        { providers: resolveProviders(effectiveProviders()) },
        { providers: resolveProviders(state.inherited) },
        { type: 'object' },
      )
      writes.push({ ns, expected, paths, next })
      // The write replaces the volatile map in the override, and the
      // revision moves with it.
      state.override = { ...state.override, providers: next.providers }
      state.revision += 1
    },
  }
}

/**
 * A Host context with the services the plugin uses.
 *
 * The logger records every level the Host offers, so a test can reach the
 * lines the plugin writes. A logger with only `error` would silently skip
 * every `info` and `warn` line, and no test could see them.
 *
 * @param options - `{ settings, profileDir, webServer }`.
 * @returns the fake context.
 */
function ctxWith({ settings, profileDir = '/tmp/dsh-minimax-test', webServer } = {}) {
  const effects = []
  const effectLabels = []
  const logs = []
  const infos = []
  const warns = []
  return {
    settings,
    effects,
    effectLabels,
    logs,
    infos,
    warns,
    logger: {
      error(...args) {
        logs.push(args)
      },
      info(...args) {
        infos.push(args)
      },
      warn(...args) {
        warns.push(args)
      },
    },
    get(name) {
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      if (name === 'settings') return settings
      if (name === 'profileContext') return { dir: profileDir }
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(setup, label) {
      const dispose = setup()
      effects.push(dispose)
      effectLabels.push(label)
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
  ctx.effectLabels.splice(0)
}

/**
 * Cancel one registered effect, by the label it was registered under.
 *
 * @param ctx - the fake context.
 * @param label - the label the effect carries.
 */
function disposeEffect(ctx, label) {
  const index = ctx.effectLabels.indexOf(label)
  if (index === -1) return
  const dispose = ctx.effects[index]
  ctx.effects.splice(index, 1)
  ctx.effectLabels.splice(index, 1)
  dispose()
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

/** A day, in milliseconds: the delay the daily sweep waits for. */
const DAY_MS = 24 * 60 * 60 * 1000

/** How long the wait for pending work may take, in milliseconds. */
const WAIT_UNTIL_TIMEOUT_MS = 5000

/**
 * How many event-loop turns the wait may take before it gives up anyway.
 *
 * The deadline is the real limit. This is the backstop that keeps a test
 * from spinning forever when the wall clock does not move, which is what a
 * test that mocks `Date` would do.
 */
const WAIT_UNTIL_MAX_ROUNDS = 2000000

/**
 * Watch the timers the plugin arms.
 *
 * The daily sweep cannot be waited out in a test, so the clock is driven
 * instead. The mock timers fire the sweep's timer, and the recorded timers
 * show which delay was armed, how often the loop re-armed itself, and
 * whether the timer holds the event loop open.
 *
 * @returns the recorded timers and a function that restores the original.
 */
function watchTimers() {
  const originalSetTimeout = globalThis.setTimeout
  const timers = []
  globalThis.setTimeout = (handler, ms, ...rest) => {
    const timer = originalSetTimeout(handler, ms, ...rest)
    timers.push({ ms, timer })
    return timer
  }
  return {
    timers,
    restore() {
      globalThis.setTimeout = originalSetTimeout
    },
  }
}

/**
 * The timers armed with the daily delay.
 *
 * @param watcher - the timer watcher.
 * @returns the daily timers.
 */
function dailyTimers(watcher) {
  return watcher.timers.filter((entry) => entry.ms === DAY_MS)
}

/**
 * Let the pending work run for a few turns of the event loop.
 *
 * @param rounds - how many turns to wait.
 */
async function flush(rounds = 30) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Let the pending work run until the condition holds.
 *
 * The wait is on real time, not on a number of event-loop turns: a turn
 * costs microseconds, so a fixed number of turns is a few milliseconds, and
 * a sync that probes every model MiniMax offers takes longer than that on a
 * loaded machine. A wait that gives up after a few milliseconds lets the
 * test tear the plugin down while the sync is still running, and the sync
 * then writes into a directory that is on its way out.
 *
 * The deadline is compared against the wall clock, which keeps running even
 * when a test mocks the timers, and the polling uses `setImmediate`, which
 * such a test leaves alone.
 *
 * @param check - returns true once the work is done.
 */
async function waitUntil(check) {
  const deadline = Date.now() + WAIT_UNTIL_TIMEOUT_MS
  for (let round = 0; round < WAIT_UNTIL_MAX_ROUNDS; round += 1) {
    if (check()) return
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('the pending work did not finish in time')
}

/**
 * Give the pending work the time it may need.
 *
 * The wait is on the wall clock, so it keeps running even when a test mocks
 * the timers. It is used to let work that must *not* happen have every
 * chance to happen, so its absence can be asserted.
 *
 * @param ms - how long to wait.
 */
async function settle(ms) {
  const deadline = Date.now() + ms
  for (let round = 0; round < WAIT_UNTIL_MAX_ROUNDS; round += 1) {
    if (Date.now() >= deadline) return
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * A promise the test settles from the outside.
 *
 * @returns the promise and the function that settles it.
 */
function deferred() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

/**
 * A request that waits until the test releases it or the signal aborts.
 *
 * A real request behaves exactly like this: it ends when the answer
 * arrives, and it fails when the caller calls it off.
 *
 * @param signal - the request's signal.
 * @param gate - the deferred the test releases.
 * @returns a promise that settles when one of the two happens.
 */
function waitForRelease(signal, gate) {
  return new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('the request was aborted')))
    gate.promise.then(resolve, reject)
  })
}

/**
 * A fetch that answers the model list and hangs on the probe.
 *
 * The probe is where the sync spends its time, so a test that disposes the
 * plugin while a probe is in flight can see whether the sync stops.
 *
 * @param options - `{ gate, requests }`; the requests are recorded by name.
 * @returns the fetch implementation.
 */
function hangingProbeFetch({ gate, requests }) {
  return async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      requests.push('models')
      return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
    }
    requests.push('probe')
    await waitForRelease(init?.signal, gate)
    return PROBE_FETCH(url, init)
  }
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
  // path it changed, so a write to the wrong place cannot pass unnoticed. The
  // path is a list of field segments, the shape the Host service reads.
  assert.equal(write.ns, 'llm-pi-ai')
  assert.equal(write.expected, 3)
  assert.deepEqual(write.paths, [['providers', 'minimax-cn', 'models']])
  const written = write.next.providers['minimax-cn'].models
  assert.equal(written.length, 2)
  assert.equal(written[0].id, 'MiniMax-M3')
  assert.equal(written[0].maxTokens, 512000)
  assert.equal(written[1].id, 'MiniMax-M3.1-Flash')
  assert.equal(written[1].maxTokens, 524288)
  // The rest of the route survives, and so does every other provider.
  assert.equal(write.next.providers['minimax-cn'].apiKeyEnv, 'MINIMAX_CN_API_KEY')
  assert.equal(write.next.providers['other-route'].apiKeyEnv, 'OTHER_API_KEY')
})

test('the written entry keeps the wording the user wrote', async () => {
  // The effective projection is the schema-resolved one, so the entry the
  // user wrote carries a materialised `compat` block there. The override is
  // the raw profile row, so the entry the user wrote is there as it was.
  const userEntry = { id: 'MiniMax-M3', name: 'MiniMax-M3-1M', maxTokens: 512000 }
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [userEntry] },
      'other-route': { apiKeyEnv: 'OTHER_API_KEY' },
    },
    override: {
      providers: {
        'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [userEntry] },
      },
    },
  })
  // The service really answers with a materialised default on the entry.
  const descriptor = settings.describe()[0]
  assert.deepEqual(descriptor.value.providers['minimax-cn'].models[0].compat, {})
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
  const written = settings.writes[0].next.providers['minimax-cn'].models
  // The entry the user wrote is written back exactly as it was: no
  // materialised default, no changed value, no new order.
  assert.deepEqual(written[0], userEntry)
  // The new model is appended behind it.
  assert.equal(written[1].id, 'MiniMax-M3.1-Flash')
  // The sibling route from the inherited layer survives the write.
  assert.equal(settings.writes[0].next.providers['other-route'].apiKeyEnv, 'OTHER_API_KEY')
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
  assert.equal(written['other-route'].apiKeyEnv, 'OTHER_API_KEY')
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

test('the daily sweep is registered as an effect of its own', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  try {
    await apply(ctx, {})
    // The startup attempt and the daily sweep are two separate effects, so
    // unloading the plugin cancels both of them.
    assert.deepEqual(ctx.effectLabels, [
      'dsh-minimax: routes',
      'dsh-minimax: first sync',
      'dsh-minimax: daily sync',
    ])
  } finally {
    disposeAll(ctx)
  }
})

test('the daily sweep runs one sync when the day elapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-daily-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  let modelLists = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      modelLists += 1
      return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
    }
    return PROBE_FETCH(url, init)
  }
  try {
    await apply(ctx, {})
    // The startup attempt is called off, so the only sync that can run is
    // the daily sweep.
    disposeEffect(ctx, 'dsh-minimax: first sync')

    // The day has not passed yet, so nothing has run.
    t.mock.timers.tick(DAY_MS - 1)
    await flush()
    assert.equal(modelLists, 0)
    assert.equal(dailyTimers(watcher).length, 1)

    // The day passes, and the sweep runs exactly one sync.
    t.mock.timers.tick(1)
    await waitUntil(() => dailyTimers(watcher).length === 2)
    assert.equal(modelLists, 1)
    assert.equal(settings.writes.length, 1)

    // The next day brings exactly one more sync, and no more than that.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 3)
    assert.equal(modelLists, 2)
    // Nothing new was found, so the second sweep wrote nothing at all.
    assert.equal(settings.writes.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('a second sweep does not probe a model the plugin already added', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-steady-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  let modelLists = 0
  const probed = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      modelLists += 1
      return new Response(JSON.stringify({ data: [{ id: 'MiniMax-M3.1-Flash' }] }), { status: 200 })
    }
    probed.push(JSON.parse(init.body).model)
    return PROBE_FETCH(url, init)
  }
  try {
    await apply(ctx, {})
    disposeEffect(ctx, 'dsh-minimax: first sync')

    // The first sweep measures the model MiniMax offers and adds it.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 2)
    assert.equal(modelLists, 1)
    // The cap request and the thinking request.
    assert.deepEqual(probed, ['MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash'])
    assert.equal(settings.writes.length, 1)
    const written = settings.writes[0].next.providers['minimax-cn'].models
    assert.deepEqual(written.map((entry) => entry.id), ['MiniMax-M3.1-Flash'])
    // The plugin remembers what it added.
    const state = JSON.parse(await readFile(join(profileDir, STATE_FILENAME), 'utf8'))
    assert.deepEqual(state.addedModels, ['MiniMax-M3.1-Flash'])

    // The second sweep costs one model-list request and no probe at all:
    // the model the plugin added is not a candidate any more.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 3)
    assert.equal(modelLists, 2)
    assert.equal(probed.length, 2)
    assert.equal(settings.writes.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the daily sweep is cancelled when the plugin is disposed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-cancel-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  let modelLists = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      modelLists += 1
      return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
    }
    return PROBE_FETCH(url, init)
  }
  try {
    await apply(ctx, {})
    // The plugin is unloaded before the sweep comes due, so the pending
    // sweep must not run a sync that writes the profile afterwards.
    disposeAll(ctx)
    t.mock.timers.tick(DAY_MS)
    await flush()
    assert.equal(modelLists, 0)
    assert.equal(settings.writes.length, 0)
    // The cancelled sweep stops: it does not arm another day.
    assert.equal(dailyTimers(watcher).length, 1)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('a disposed plugin stops the sync that is in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-inflight-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  const gate = deferred()
  const requests = []
  globalThis.fetch = hangingProbeFetch({ gate, requests })
  try {
    await apply(ctx, {})
    // The first attempt comes due and the sync starts.
    t.mock.timers.tick(2000)
    await waitUntil(() => requests.includes('probe'))

    // The plugin is unloaded while the probe is in flight.
    disposeAll(ctx)
    // The probe is released anyway: a sync that was not stopped would carry
    // on here, probe the next model, and write into the profile.
    gate.release()
    await settle(300)

    // The sync stopped: the second model was never probed.
    assert.deepEqual(requests, ['models', 'probe'])
    // The profile was not written.
    assert.equal(settings.writes.length, 0)
    // And no bookkeeping landed in the profile directory.
    assert.equal(existsSync(join(profileDir, STATE_FILENAME)), false)
    // An abort is not a failure, so nothing was reported to the operator.
    assert.equal(ctx.logs.length, 0)
    assert.equal(ctx.warns.length, 0)
    assert.equal(ctx.infos.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    gate.release()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the daily sweep stops when the plugin is disposed while it is running', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-sweep-inflight-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  const gate = deferred()
  const requests = []
  globalThis.fetch = hangingProbeFetch({ gate, requests })
  try {
    await apply(ctx, {})
    // The startup attempt is called off, so the only sync that can run is
    // the daily sweep.
    disposeEffect(ctx, 'dsh-minimax: first sync')
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => requests.includes('probe'))

    // The plugin is unloaded while the sweep is in flight.
    disposeAll(ctx)
    // The probe is released anyway: a sweep that was not stopped would carry
    // on here, probe the next model, and write into the profile.
    gate.release()
    await settle(300)

    // The sweep stopped: the second model was never probed.
    assert.deepEqual(requests, ['models', 'probe'])
    // The profile was not written.
    assert.equal(settings.writes.length, 0)
    // And no bookkeeping landed in the profile directory.
    assert.equal(existsSync(join(profileDir, STATE_FILENAME)), false)
    // An abort is not a failure, so nothing was reported to the operator.
    assert.equal(ctx.logs.length, 0)
    assert.equal(ctx.warns.length, 0)
    assert.equal(ctx.infos.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    gate.release()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('a teardown during a sync leaves no file behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-teardown-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  const gate = deferred()
  const requests = []
  globalThis.fetch = hangingProbeFetch({ gate, requests })
  try {
    await apply(ctx, {})
    t.mock.timers.tick(2000)
    await waitUntil(() => requests.includes('probe'))

    // The profile directory goes away while the sync is still running. This
    // is the teardown the CI run hit: the directory was removed while the
    // sync was still going, and the sync then wrote into it.
    await rm(profileDir, { recursive: true, force: true })
    assert.equal(existsSync(profileDir), false)

    // The plugin is unloaded, which stops the sync that was still running.
    disposeAll(ctx)
    gate.release()
    await settle(300)

    // Nothing was written into the directory afterwards: it was not
    // recreated, and no bookkeeping landed in it.
    assert.equal(existsSync(profileDir), false)
    assert.equal(settings.writes.length, 0)
    // The sync stopped rather than carrying on.
    assert.deepEqual(requests, ['models', 'probe'])
  } finally {
    globalThis.fetch = originalFetch
    gate.release()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the pending daily timer does not hold the process open', async () => {
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  try {
    await apply(ctx, {})
    const daily = dailyTimers(watcher)
    assert.equal(daily.length, 1)
    // The sweep's timer is unreferenced, so a pending sweep can never keep
    // a process alive on its own.
    assert.equal(daily[0].timer.hasRef(), false)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
  }
})


/**
 * A fetch that answers like MiniMax does for a model it has retired.
 *
 * MiniMax validates `max_tokens` before it checks whether the model still
 * exists, so the cap request answers with a cap and only the next request
 * says the model is gone. A retired model therefore costs two requests.
 */
const RETIRED_FETCH = async (_url, init) => {
  const body = JSON.parse(init.body)
  if (body.max_tokens === 999999999) {
    return new Response(JSON.stringify({ error: { message: 'invalid params, model[MiniMax-M2] does not support max tokens > 131072 (2013)' } }), { status: 400 })
  }
  return new Response(JSON.stringify({ error: { message: 'The model "MiniMax-M2" is no longer available. (2069)' } }), { status: 400 })
}

test('a retired model is probed once and then remembered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-retired-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  let modelLists = 0
  let probes = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      modelLists += 1
      // MiniMax keeps listing the model it has retired.
      return new Response(JSON.stringify({ data: [{ id: 'MiniMax-M2' }] }), { status: 200 })
    }
    probes += 1
    return RETIRED_FETCH(url, init)
  }
  try {
    await apply(ctx, {})
    disposeEffect(ctx, 'dsh-minimax: first sync')

    // The first sweep meets the retired model and probes it.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 2)
    assert.equal(modelLists, 1)
    // The cap request and the request that says the model is gone.
    assert.equal(probes, 2)
    // A retired model is never written into the profile.
    assert.equal(settings.writes.length, 0)
    // The decision is remembered.
    const state = JSON.parse(await readFile(join(profileDir, STATE_FILENAME), 'utf8'))
    assert.deepEqual(state.retiredModels, ['MiniMax-M2'])

    // The next sweep costs one model-list request and no probe at all: the
    // model MiniMax retired is not a candidate any more.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 3)
    assert.equal(modelLists, 2)
    assert.equal(probes, 2)
    assert.equal(settings.writes.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the daily sweep leaves one line on the Host log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-daily-log-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    disposeEffect(ctx, 'dsh-minimax: first sync')
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 2)
    // The line says how many models were added, so a day that added three
    // does not read like a day that added none.
    assert.equal(ctx.infos.length, 1)
    assert.equal(ctx.infos[0][1], 'dsh-minimax: the daily sync added')
    assert.equal(ctx.infos[0][2], 1)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the startup sync leaves one line on the Host log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-startup-log-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    // The first attempt waits two seconds before it runs.
    t.mock.timers.tick(2000)
    await waitUntil(() => ctx.infos.length > 0)
    assert.equal(ctx.infos[0][1], 'dsh-minimax: the startup sync added')
    // The line says how many models were added.
    assert.equal(ctx.infos[0][2], 1)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the manual sync leaves one line on the Host log', async () => {
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-manual-log-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    const sync = webServer.registered.find((route) => route.path === '/plugin/minimax/sync')
    const res = fakeResponse()
    await sync.handler(fakeRequest('POST'), res)
    assert.equal(ctx.infos.length, 1)
    assert.equal(ctx.infos[0][1], 'dsh-minimax: the manual sync added')
    // The line says how many models were added.
    assert.equal(ctx.infos[0][2], 1)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('a failed startup sync is not swallowed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  settings.write = async () => {
    throw new Error('settings namespace "llm-pi-ai" changed since it was read')
  }
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-startup-fail-'))
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    t.mock.timers.tick(2000)
    await waitUntil(() => ctx.logs.length > 0)
    // The failure reaches the Host log instead of disappearing into an
    // empty catch.
    assert.equal(ctx.logs[0].some((arg) => arg instanceof Error && arg.message.includes('changed since it was read')), true)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the plugin declares the profile context it reads its state from', async () => {
  // Without the service the fallbacks would swap in a no-op state reader and
  // writer, and a model the user deleted by hand would come back.
  assert.deepEqual(inject, ['webServer', 'credentials', 'settings', 'profileContext'])
})

test('the config refuses a credential reference the credentials service cannot resolve', async () => {
  // The credentials service only recognises a reference that is a shell
  // identifier, so anything else resolves to nothing.
  const refused = Config['~standard'].validate({ credentialRef: 'sk-example-key' })
  assert.equal(Array.isArray(refused.issues), true)
  assert.equal(refused.issues.length, 1)
  assert.equal(refused.issues[0].path[0], 'credentialRef')
  const accepted = Config['~standard'].validate({ credentialRef: 'MINIMAX_CN_API_KEY' })
  assert.equal(accepted.value.credentialRef, 'MINIMAX_CN_API_KEY')
})

test('the config schema describes itself for the settings service', async () => {
  // Without a description the settings service finds no form for this row,
  // and the row stays invisible in the Settings UI.
  assert.equal(typeof Config.toJSON, 'function')
  const json = Config.toJSON()
  assert.equal(json.uid, 'dsh-minimax.config')
  assert.equal(json.refs[json.uid].dict.credentialRef, 'dsh-minimax.credentialRef')
  // The field is volatile, so it can be edited without remounting the plugin.
  assert.equal(json.refs['dsh-minimax.credentialRef'].meta.volatile, true)
  // Every reference the description names has to exist, or the service
  // cannot rebuild the schema.
  for (const ref of Object.values(json.refs)) {
    for (const child of Object.values(ref.dict ?? {})) {
      assert.ok(json.refs[child] !== undefined)
    }
    if (ref.inner !== undefined) assert.ok(json.refs[ref.inner] !== undefined)
  }
})
