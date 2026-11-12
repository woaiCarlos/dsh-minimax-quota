import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveApiKey } from '../lib/credentials.js'

test('resolveApiKey returns the resolved secret', async () => {
  const ctx = { get: () => ({ resolve: async () => ({ value: 'sk-secret' }) }) }
  assert.equal(await resolveApiKey(ctx, 'MINIMAX_CN_API_KEY'), 'sk-secret')
})

test('resolveApiKey answers undefined when the credential is absent', async () => {
  const ctx = { get: () => ({ resolve: async () => undefined }) }
  assert.equal(await resolveApiKey(ctx, 'MINIMAX_CN_API_KEY'), undefined)
})

test('resolveApiKey answers undefined when the credential service is absent', async () => {
  const ctx = { get: () => undefined }
  assert.equal(await resolveApiKey(ctx, 'MINIMAX_CN_API_KEY'), undefined)
})

test('resolveApiKey answers undefined for an empty secret', async () => {
  const ctx = { get: () => ({ resolve: async () => ({ value: '' }) }) }
  assert.equal(await resolveApiKey(ctx, 'MINIMAX_CN_API_KEY'), undefined)
})
