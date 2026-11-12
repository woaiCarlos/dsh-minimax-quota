import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStatusPayload, runSync } from '../index.js'

function fakeSettings(models) {
  const writes = []
  const providers = {
    'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models },
    'other-route': { apiKeyEnv: 'OTHER_API_KEY' },
  }
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
      writes.push({ ns, expected, paths, next: change({ providers }) })
    },
  }
}

function ctxWith({ settings, profileDir = '/tmp/dsh-minimax-test' }) {
  return {
    writes: [],
    get(name) {
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      if (name === 'settings') return settings
      if (name === 'profileContext') return { dir: profileDir }
      return undefined
    },
  }
}

function makeContext(options = {}) {
  const settings = options.settings ?? fakeSettings([])
  return { ...ctxWith({ ...options, settings }), settings }
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
  const settings = fakeSettings([{ id: 'MiniMax-M3', maxTokens: 512000 }])
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
  const settings = fakeSettings([])
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
  const settings = fakeSettings([{ id: 'MiniMax-M3.1-Flash', maxTokens: 524288 }])
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
  const settings = fakeSettings([])
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

test('a model the plugin added before is not probed again', async () => {
  const settings = fakeSettings([])
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
  const settings = fakeSettings([])
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
  const settings = fakeSettings([])
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
  const settings = fakeSettings([{ id: 'MiniMax-M3' }, { id: 'MiniMax-M3.1-Flash' }])
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
