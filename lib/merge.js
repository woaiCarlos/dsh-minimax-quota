/**
 * Deciding which model entries to append.
 *
 * The plugin's promise is that it never touches an entry the user already
 * has: it appends and it stops. A model the user removed by hand stays
 * removed, because the ids the plugin added are remembered.
 */

/**
 * Plan the append.
 *
 * @param currentModels - the entries already in the profile.
 * @param addedModels - the ids the plugin has added before.
 * @param candidateIds - the model ids MiniMax reports.
 * @param entries - the built entries, keyed by model id. A candidate whose
 *   entry is missing or null was not built and is not appended.
 * @returns `{ models, addedIds, changed }`.
 */
export function planAppend({ currentModels = [], addedModels = [], candidateIds = [], entries = new Map() }) {
  // A malformed entry without an id names nothing, so it cannot occupy a
  // candidate's place.
  const listed = new Set(currentModels.map((entry) => entry?.id).filter((id) => typeof id === 'string'))
  const added = new Set(addedModels)
  const models = [...currentModels]
  const addedIds = []
  for (const id of candidateIds) {
    if (listed.has(id) || added.has(id)) continue
    const entry = entries.get(id)
    // A candidate without a built entry was never measured, and a null one
    // carries no model; neither may be appended.
    if (!entry) continue
    models.push(entry)
    listed.add(id)
    addedIds.push(id)
  }
  return { models, addedIds, changed: addedIds.length > 0 }
}
