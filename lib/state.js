/**
 * The plugin's own bookkeeping.
 *
 * The ids the plugin added are remembered so that a model the user removes
 * by hand is not added back on the next sync. The state lives in one file
 * inside the profile directory, so the plugin's bookkeeping never lands in
 * the user's profile patch.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Name of the state file inside the profile directory. */
export const STATE_FILENAME = 'dsh-minimax-state.json'

/**
 * The state of a plugin that has never synced.
 *
 * @returns an empty state.
 */
export function emptyState() {
  return { addedModels: [], lastSyncAt: null }
}

/**
 * Read the plugin's state.
 *
 * @param dir - the profile directory.
 * @returns the state; an empty one when the file is missing or unreadable.
 */
export async function readState(dir) {
  try {
    const raw = await readFile(join(dir, STATE_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    const addedModels = Array.isArray(parsed?.addedModels)
      ? parsed.addedModels.filter((id) => typeof id === 'string' && id.length > 0)
      : []
    return {
      addedModels,
      lastSyncAt: Number.isFinite(parsed?.lastSyncAt) ? parsed.lastSyncAt : null,
    }
  } catch {
    return emptyState()
  }
}

/**
 * Write the plugin's state.
 *
 * The write is atomic: the state reaches the file through a temporary file
 * and a rename, so a crash cannot leave a half-written file that reads back
 * as an empty state. The temporary name carries the process id and a random
 * suffix, so two writers never share one temporary file and cannot rename
 * or delete each other's half-written state.
 *
 * @param dir - the profile directory.
 * @param state - the state to store.
 * @returns the stored state.
 * @throws when the state cannot be written; the caller decides what to do.
 */
export async function writeState(dir, state) {
  await mkdir(dir, { recursive: true })
  const payload = {
    addedModels: [...new Set((state.addedModels ?? []).filter((id) => typeof id === 'string' && id.length > 0))].sort(),
    lastSyncAt: Number.isFinite(state.lastSyncAt) ? state.lastSyncAt : null,
  }
  const target = join(dir, STATE_FILENAME)
  const temp = join(dir, `${STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`)
  // The write goes through a temporary file and a rename, because a file
  // truncated by a crash would read back as an empty state — and an empty
  // state forgets which models the plugin added, so a model the user deleted
  // by hand would come back.
  try {
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temp, target)
  } catch (error) {
    // A failed write must not leave a partial file behind that a later read
    // would mistake for state.
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return payload
}
