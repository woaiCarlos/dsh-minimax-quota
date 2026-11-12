import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OVER_LIMIT_MAX_TOKENS,
  fetchModelIds,
  isRetired,
  parseMaxTokensLimit,
  postMessage,
  probeModel,
} from '../lib/probe.js'

function jsonResponse(body, status = 400) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('parseMaxTokensLimit reads the cap out of the refusal', () => {
  const message = 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)'
  assert.equal(parseMaxTokensLimit(message), 196608)
})

test('parseMaxTokensLimit answers undefined for an unrelated refusal', () => {
  assert.equal(parseMaxTokensLimit('invalid params, context window exceeds limit (2013)'), undefined)
  assert.equal(parseMaxTokensLimit(''), undefined)
})

test('isRetired recognizes the retired-model refusal', () => {
  assert.equal(isRetired('The model "MiniMax-M2" is no longer available. (2069)'), true)
  assert.equal(isRetired('invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)'), false)
})

test('fetchModelIds lists every candidate id', async () => {
  const fetchImpl = async () => jsonResponse({
    object: 'list',
    data: [{ id: 'MiniMax-M3.1-Flash' }, { id: 'MiniMax-M2' }],
  }, 200)
  assert.deepEqual(await fetchModelIds('sk-test', { fetchImpl }), ['MiniMax-M3.1-Flash', 'MiniMax-M2'])
})

test('fetchModelIds answers an empty list when the account carries no models', async () => {
  const fetchImpl = async () => jsonResponse({ object: 'list', data: [] }, 200)
  assert.deepEqual(await fetchModelIds('sk-test', { fetchImpl }), [])
})

test('fetchModelIds answers null when the list cannot be read', async () => {
  const refused = await fetchModelIds('sk-test', {
    fetchImpl: async () => jsonResponse({ error: { message: 'invalid api key' } }, 401),
  })
  assert.equal(refused, null)
  const broken = await fetchModelIds('sk-test', {
    fetchImpl: async () => { throw new Error('fetch failed') },
  })
  assert.equal(broken, null)
})

test('probeModel reads the output cap from a refusal without generating', async () => {
  const bodies = []
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)' },
      })
    }
    return jsonResponse({ content: [{ type: 'text', text: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M2.7', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.maxTokens, 196608)
  assert.equal(bodies[0].max_tokens, OVER_LIMIT_MAX_TOKENS)
})

test('probeModel reports a failed probe when the cap cannot be read', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'invalid api key' } }, 401)
  const result = await probeModel('MiniMax-M3', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'failed')
  assert.equal(result.maxTokens, undefined)
})

test('probeModel reports a retired model that says so right away', async () => {
  const fetchImpl = async () => jsonResponse({
    error: { message: 'The model "MiniMax-M2" is no longer available. (2069)' },
  })
  const result = await probeModel('MiniMax-M2', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'retired')
  assert.equal(result.modelId, 'MiniMax-M2')
})

test('probeModel reports a retired model whose cap request still answers', async () => {
  let calls = 0
  const fetchImpl = async (_url, init) => {
    calls += 1
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      // MiniMax validates max_tokens before it checks whether the model still
      // exists, so the cap request answers even for a retired model.
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2] does not support max tokens > 196608 (2013)' },
      })
    }
    return jsonResponse({
      error: { message: 'The model "MiniMax-M2" is no longer available. (2069)' },
    })
  }
  const result = await probeModel('MiniMax-M2', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'retired')
  assert.equal(result.modelId, 'MiniMax-M2')
  assert.equal(calls, 2)
})

test('probeModel detects a model that thinks', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M3.1-Flash] does not support max tokens > 524288 (2013)' },
      })
    }
    return jsonResponse({
      content: [{ type: 'thinking', thinking: '17 times 23 is 391.' }, { type: 'text', text: '391' }],
    }, 200)
  }
  const result = await probeModel('MiniMax-M3.1-Flash', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.maxTokens, 524288)
  assert.equal(result.supportsThinking, true)
})

test('probeModel detects a model that does not think', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)' },
      })
    }
    return jsonResponse({ content: [{ type: 'text', text: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M2.7', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.supportsThinking, false)
})

test('probeModel reports a model that refuses the thinking field as not thinking', async () => {
  const bodies = []
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)' },
      })
    }
    if (body.thinking !== undefined) {
      return jsonResponse({ error: { message: 'invalid params, thinking is not supported by this model' } })
    }
    return jsonResponse({ content: [{ type: 'text', text: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M2.7', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.maxTokens, 196608)
  assert.equal(result.supportsThinking, false)
  assert.equal(bodies.length, 3)
})

test('probeModel reports a failed probe when the model answers nothing usable', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'internal error' } })
  const result = await probeModel('MiniMax-M3', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'failed')
})

test('every request carries a signal and the key travels only in a header', async () => {
  const seen = []
  const fetchImpl = async (_url, init) => {
    seen.push(init)
    return jsonResponse({ object: 'list', data: [] }, 200)
  }
  await fetchModelIds('sk-secret', { fetchImpl })
  assert.equal(seen.length, 1)
  assert.ok(seen[0].signal instanceof AbortSignal)
  assert.equal(seen[0].headers.authorization, 'Bearer sk-secret')
  assert.equal(String(seen[0].body ?? '').includes('sk-secret'), false)
})

test('postMessage reports a network failure', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed') }
  const result = await postMessage({ model: 'x' }, 'sk-test', { fetchImpl })
  assert.equal(result.status, 0)
  assert.equal(result.message, 'fetch failed')
  assert.equal(result.payload, undefined)
})

test('postMessage reports an unparsable body', async () => {
  const fetchImpl = async () => new Response('not json', { status: 200 })
  const result = await postMessage({ model: 'x' }, 'sk-test', { fetchImpl })
  assert.equal(result.status, 200)
  assert.equal(result.message, 'HTTP 200')
  assert.equal(result.payload, undefined)
})

test('postMessage reports an empty message when the payload carries no error', async () => {
  const fetchImpl = async () => jsonResponse({ content: [] }, 200)
  const result = await postMessage({ model: 'x' }, 'sk-test', { fetchImpl })
  assert.equal(result.status, 200)
  assert.equal(result.message, '')
})
