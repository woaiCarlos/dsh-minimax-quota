import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildModelEntry } from '../lib/model-entry.js'
import { lookupSpec } from '../lib/specs.js'

test('a thinking model declares the effort levels and adaptive thinking', () => {
  const entry = buildModelEntry('MiniMax-M3.1-Flash', { maxTokens: 524288, supportsThinking: true })
  assert.equal(entry.id, 'MiniMax-M3.1-Flash')
  assert.equal(entry.name, 'MiniMax-M3.1-Flash')
  assert.equal(entry.contextWindow, 1000000)
  assert.equal(entry.maxTokens, 524288)
  assert.deepEqual(entry.input, ['text', 'image'])
  assert.deepEqual(entry.reasoningEfforts, {
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })
  assert.deepEqual(entry.compat, { forceAdaptiveThinking: true })
})

test('a thinking model without adaptive efforts omits the compat block', () => {
  const entry = buildModelEntry('MiniMax-M3', { maxTokens: 524288, supportsThinking: true })
  assert.deepEqual(entry.reasoningEfforts, {
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })
  assert.equal('compat' in entry, false)
})

test('a model that records its own effort levels uses those', () => {
  const entry = buildModelEntry('MiniMax-M3.1-Flash', { maxTokens: 524288, supportsThinking: true }, {
    contextWindow: 1000000,
    outputLimit: 524288,
    modalities: ['text', 'image'],
    reasoningOptions: { type: 'effort', values: ['low', 'high'] },
  })
  assert.deepEqual(entry.reasoningEfforts, { low: 'low', high: 'high' })
})

test('an entry only carries modalities pi-ai accepts', () => {
  const entry = buildModelEntry('MiniMax-M9-Ultra', { maxTokens: 4096, supportsThinking: false }, {
    contextWindow: 1000000,
    outputLimit: 131072,
    modalities: ['text', 'image', 'video'],
    reasoningOptions: null,
  })
  assert.deepEqual(entry.input, ['text', 'image'])
})

test('a model that does not think turns reasoning off', () => {
  const entry = buildModelEntry('MiniMax-M2.7', { maxTokens: 196608, supportsThinking: false })
  assert.equal(entry.reasoningEfforts, false)
  assert.equal('compat' in entry, false)
})

test('the compat key is absent rather than undefined', () => {
  const entry = buildModelEntry('MiniMax-M2.7', { maxTokens: 196608, supportsThinking: false })
  assert.equal(Object.hasOwn(entry, 'compat'), false)
})

test('the probed cap wins over the snapshot', () => {
  const entry = buildModelEntry('MiniMax-M2.7', { maxTokens: 196608, supportsThinking: true })
  assert.equal(entry.maxTokens, 196608)
})

test('the snapshot cap is used when the probe found none', () => {
  const entry = buildModelEntry('MiniMax-M2.7', { maxTokens: undefined, supportsThinking: true })
  assert.equal(entry.maxTokens, lookupSpec('MiniMax-M2.7').outputLimit)
})

test('an unknown model still yields a valid entry', () => {
  const entry = buildModelEntry('MiniMax-M9-Ultra', { maxTokens: 4096, supportsThinking: false })
  assert.equal(entry.id, 'MiniMax-M9-Ultra')
  assert.equal(entry.contextWindow, 1000000)
  assert.deepEqual(entry.input, ['text'])
  assert.equal(entry.reasoningEfforts, false)
})
