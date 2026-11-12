/**
 * The plugin's own bookkeeping.
 *
 * The ids the plugin added are remembered so that a model the user removes
 * by hand is not added back on the next sync. The state lives in one file
 * inside the profile directory, so the plugin's bookkeeping never lands in
 * the user's profile patch.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
 * @param dir - the profile directory.
 * @param state - the state to store.
 * @returns the stored state.
 */
export async function writeState(dir, state) {
  await mkdir(dir, { recursive: true })
  const payload = {
    addedModels: [...new Set(state.addedModels ?? [])].sort(),
    lastSyncAt: Number.isFinite(state.lastSyncAt) ? state.lastSyncAt : null,
  }
  await writeFile(join(dir, STATE_FILENAME), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}
