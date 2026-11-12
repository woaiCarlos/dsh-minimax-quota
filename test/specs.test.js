import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_SPEC, MODEL_SPECS, SUPPORTED_MODALITIES, lookupSpec } from '../lib/specs.js'

test('every known model carries a usable specification', () => {
  for (const [id, spec] of Object.entries(MODEL_SPECS)) {
    assert.ok(Number.isInteger(spec.contextWindow) && spec.contextWindow > 0, `${id} contextWindow`)
    assert.ok(Number.isInteger(spec.outputLimit) && spec.outputLimit > 0, `${id} outputLimit`)
    assert.ok(Array.isArray(spec.modalities) && spec.modalities.length > 0, `${id} modalities`)
  }
})

test('only modalities pi-ai accepts are recorded', () => {
  for (const [id, spec] of Object.entries(MODEL_SPECS)) {
    for (const modality of spec.modalities) {
      assert.ok(SUPPORTED_MODALITIES.includes(modality), `${id} declares ${modality}`)
    }
  }
})

test('only MiniMax-M3.1-Flash is recorded as offering effort levels', () => {
  const effort = Object.entries(MODEL_SPECS)
    .filter(([, spec]) => spec.reasoningOptions?.type === 'effort')
    .map(([id]) => id)
  assert.deepEqual(effort, ['MiniMax-M3.1-Flash'])
})

test('the M3 series carries the one-million-token window', () => {
  assert.equal(lookupSpec('MiniMax-M3').contextWindow, 1000000)
  assert.equal(lookupSpec('MiniMax-M3.1-Flash').contextWindow, 1000000)
  assert.equal(lookupSpec('MiniMax-M2.7').contextWindow, 204800)
})

test('the M3 series accepts images and the M2 series does not', () => {
  assert.deepEqual(lookupSpec('MiniMax-M3').modalities, ['text', 'image'])
  assert.deepEqual(lookupSpec('MiniMax-M2.7').modalities, ['text'])
})

test('an unknown model falls back to a conservative specification', () => {
  const spec = lookupSpec('MiniMax-M9-Ultra')
  assert.equal(spec, FALLBACK_SPEC)
  assert.equal(spec.contextWindow, 1000000)
  assert.deepEqual(spec.modalities, ['text'])
  assert.equal(spec.reasoningOptions, null)
})
