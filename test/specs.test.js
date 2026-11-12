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

test('the recorded output caps are the ones MiniMax reports', () => {
  assert.equal(MODEL_SPECS['MiniMax-M3'].outputLimit, 524288)
  assert.equal(MODEL_SPECS['MiniMax-M3.1-Flash'].outputLimit, 524288)
  assert.equal(MODEL_SPECS['MiniMax-M2.7'].outputLimit, 131072)
  assert.equal(FALLBACK_SPEC.outputLimit, 131072)
})

test('the recorded context windows are the ones MiniMax enforces', () => {
  assert.equal(MODEL_SPECS['MiniMax-M3'].contextWindow, 1000000)
  assert.equal(MODEL_SPECS['MiniMax-M3.1-Flash'].contextWindow, 1000000)
  assert.equal(MODEL_SPECS['MiniMax-M2.7'].contextWindow, 204800)
  assert.equal(MODEL_SPECS['MiniMax-M2.5-highspeed'].contextWindow, 204800)
  assert.equal(FALLBACK_SPEC.contextWindow, 1000000)
})

test('every entry declares a known reasoning shape', () => {
  for (const [id, spec] of Object.entries(MODEL_SPECS)) {
    const options = spec.reasoningOptions
    if (options === null) continue
    assert.ok(['effort', 'toggle'].includes(options.type), `${id} reasoning type`)
    if (options.type === 'effort') {
      assert.ok(Array.isArray(options.values) && options.values.length > 0, `${id} effort values`)
    } else {
      assert.equal(options.values, undefined, `${id} toggle carries no values`)
    }
  }
})

test('the effort levels are the five spellings pi-ai accepts', () => {
  assert.deepEqual(
    MODEL_SPECS['MiniMax-M3.1-Flash'].reasoningOptions.values,
    ['low', 'medium', 'high', 'xhigh', 'max'],
  )
})

test('a name inherited from the prototype chain does not resolve to a prototype', () => {
  assert.equal(lookupSpec('toString'), FALLBACK_SPEC)
  assert.equal(lookupSpec('__proto__'), FALLBACK_SPEC)
  assert.equal(lookupSpec('constructor'), FALLBACK_SPEC)
})

test('the snapshot is frozen all the way down', () => {
  assert.throws(() => MODEL_SPECS['MiniMax-M3'].modalities.push('video'), TypeError)
  assert.throws(() => { MODEL_SPECS['MiniMax-M3'].contextWindow = 1 }, TypeError)
  assert.throws(() => FALLBACK_SPEC.modalities.push('video'), TypeError)
})

test('the modality list cannot be mutated', () => {
  assert.throws(() => SUPPORTED_MODALITIES.push('video'), TypeError)
})
