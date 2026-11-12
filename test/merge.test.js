import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planAppend } from '../lib/merge.js'

const EXISTING = [
  { id: 'MiniMax-M3', name: 'MiniMax-M3-1M', contextWindow: 1000000, maxTokens: 512000, input: ['text', 'image'] },
  { id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', contextWindow: 1000000, maxTokens: 512000, input: ['text', 'image'] },
]

const NEW_ENTRY = {
  id: 'MiniMax-M3.2',
  name: 'MiniMax-M3.2',
  contextWindow: 1000000,
  maxTokens: 524288,
  input: ['text', 'image'],
  reasoningEfforts: false,
}

test('a new model is appended after the existing ones', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M3.2'],
    entries: new Map([['MiniMax-M3.2', NEW_ENTRY]]),
  })
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.addedIds, ['MiniMax-M3.2'])
  assert.equal(plan.models.length, 3)
  assert.deepEqual(plan.models.slice(0, 2), EXISTING)
  assert.equal(plan.models[2].id, 'MiniMax-M3.2')
})

test('the existing entries are never modified', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M3.2'],
    entries: new Map([['MiniMax-M3.2', NEW_ENTRY]]),
  })
  assert.equal(plan.models[0].maxTokens, 512000)
  assert.equal(plan.models[0].name, 'MiniMax-M3-1M')
})

test('nothing changes when there is no new model', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: ['MiniMax-M3.1-Flash'],
    candidateIds: ['MiniMax-M3', 'MiniMax-M3.1-Flash'],
    entries: new Map(),
  })
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.addedIds, [])
  assert.deepEqual(plan.models, EXISTING)
})

test('a model the user already listed is not added twice', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M3'],
    entries: new Map([['MiniMax-M3', { id: 'MiniMax-M3' }]]),
  })
  assert.equal(plan.changed, false)
  assert.equal(plan.models.length, 2)
})

test('a model the user deleted by hand is not added back', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: ['MiniMax-M3.1-Flash'],
    candidateIds: ['MiniMax-M3.1-Flash'],
    entries: new Map([['MiniMax-M3.1-Flash', NEW_ENTRY]]),
  })
  assert.equal(plan.changed, false)
  assert.equal(plan.models.length, 2)
})

test('a candidate without a probe result is skipped', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M2', 'MiniMax-M3.2'],
    entries: new Map([['MiniMax-M3.2', NEW_ENTRY]]),
  })
  assert.deepEqual(plan.addedIds, ['MiniMax-M3.2'])
})
