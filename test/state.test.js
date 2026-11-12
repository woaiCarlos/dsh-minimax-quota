import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_FILENAME, emptyState, readState, writeState } from '../lib/state.js'

async function scratchDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-minimax-state-'))
}

test('a successful write leaves no temporary file behind', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['MiniMax-M3'], lastSyncAt: 1 })
  assert.deepEqual(await readdir(dir), [STATE_FILENAME])
})

test('a failed write leaves the previous state intact', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['MiniMax-M3'], lastSyncAt: 1 })
  // A directory where the temporary file goes makes the write fail.
  await mkdir(join(dir, `${STATE_FILENAME}.tmp`))
  await assert.rejects(() => writeState(dir, { addedModels: ['MiniMax-M3.2'], lastSyncAt: 2 }))
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
