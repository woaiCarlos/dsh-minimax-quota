import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_FILENAME, emptyState, readState, writeState } from '../lib/state.js'

async function scratchDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-minimax-state-'))
}

test('readState answers an empty state for an empty file', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), '', 'utf8')
  assert.deepEqual(await readState(dir), emptyState())
})

test('readState answers an empty state for a truncated file', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), '{"addedModels": ["MiniMax-M', 'utf8')
  assert.deepEqual(await readState(dir), emptyState())
})

test('readState fills in the fields an older version did not write', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), JSON.stringify({ addedModels: ['MiniMax-M3'] }), 'utf8')
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['MiniMax-M3'])
  assert.equal(state.lastSyncAt, null)
})

test('a successful write leaves no temporary file behind', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['MiniMax-M3'], lastSyncAt: 1 })
  assert.deepEqual(await readdir(dir), [STATE_FILENAME])
})

test('a failed write rejects and leaves no temporary file behind', async () => {
  const dir = await scratchDir()
  // A directory where the state file goes makes the rename fail.
  await mkdir(join(dir, STATE_FILENAME))
  await assert.rejects(() => writeState(dir, { addedModels: ['MiniMax-M3'], lastSyncAt: 1 }))
  const entries = await readdir(dir)
  assert.deepEqual(entries, [STATE_FILENAME])
})

test('a failed write leaves the previous state intact', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['MiniMax-M3'], lastSyncAt: 1 })
  // A directory that cannot be written to makes the temporary write fail.
  await chmod(dir, 0o500)
  try {
    await assert.rejects(() => writeState(dir, { addedModels: ['MiniMax-M3.2'], lastSyncAt: 2 }))
  } finally {
    await chmod(dir, 0o700)
  }
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['MiniMax-M3'])
  assert.equal(state.lastSyncAt, 1)
})

test('readState answers an empty state when the file is absent', async () => {
  const dir = await scratchDir()
  assert.deepEqual(await readState(dir), emptyState())
})

test('readState ignores a corrupt state file', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), 'not json at all', 'utf8')
  assert.deepEqual(await readState(dir), emptyState())
})

test('writeState stores the added models and the sync time', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['MiniMax-M3.1-Flash'], lastSyncAt: 1760000000000 })
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['MiniMax-M3.1-Flash'])
  assert.equal(state.lastSyncAt, 1760000000000)
})

test('writeState sorts and de-duplicates the added models', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['b', 'a', 'b'], lastSyncAt: null })
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['a', 'b'])
})

test('readState drops entries that are not strings', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), JSON.stringify({ addedModels: ['a', 7, null], lastSyncAt: 'x' }), 'utf8')
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['a'])
  assert.equal(state.lastSyncAt, null)
})

test('writeState drops entries that are not strings', async () => {
  const dir = await scratchDir()
  const stored = await writeState(dir, { addedModels: ['a', 7, null, ''], lastSyncAt: 'x' })
  assert.deepEqual(stored.addedModels, ['a'])
  assert.equal(stored.lastSyncAt, null)
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['a'])
})

test('two concurrent writes both succeed and never blend their ids', async () => {
  const dir = await scratchDir()
  const first = Array.from({ length: 2000 }, (_, i) => `model-a-${i}`).sort()
  const second = Array.from({ length: 2000 }, (_, i) => `model-b-${i}`).sort()
  for (let round = 0; round < 5; round += 1) {
    // Two writers, one directory: each write owns its own temporary file.
    await Promise.all([
      writeState(dir, { addedModels: first, lastSyncAt: 1 }),
      writeState(dir, { addedModels: second, lastSyncAt: 2 }),
    ])
    const ids = (await readState(dir)).addedModels
    const isFirst = ids.length === first.length && ids.every((id, i) => id === first[i])
    const isSecond = ids.length === second.length && ids.every((id, i) => id === second[i])
    // A blended file would be valid JSON holding ids of both writers, and
    // readState would accept it without complaint.
    assert.ok(isFirst || isSecond, `the state file blended both payloads (${ids.length} ids)`)
    assert.deepEqual(await readdir(dir), [STATE_FILENAME])
  }
})

test('writeState stores the retired models', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: [], retiredModels: ['MiniMax-M2'], lastSyncAt: 1760000000000 })
  const state = await readState(dir)
  assert.deepEqual(state.retiredModels, ['MiniMax-M2'])
  assert.equal(state.lastSyncAt, 1760000000000)
})

test('writeState sorts and de-duplicates the retired models', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: [], retiredModels: ['b', 'a', 'b'], lastSyncAt: null })
  const state = await readState(dir)
  assert.deepEqual(state.retiredModels, ['a', 'b'])
})

test('readState fills in the retired models an older version did not write', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), JSON.stringify({ addedModels: ['MiniMax-M3'] }), 'utf8')
  const state = await readState(dir)
  assert.deepEqual(state.retiredModels, [])
})

test('readState drops retired entries that are not strings', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), JSON.stringify({ retiredModels: ['a', 7, null, ''] }), 'utf8')
  const state = await readState(dir)
  assert.deepEqual(state.retiredModels, ['a'])
})
