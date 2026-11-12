/**
 * Turning a probe result into one pi-ai model entry.
 */

import { SUPPORTED_MODALITIES, lookupSpec } from './specs.js'

/**
 * The effort levels offered for a model that is called in budget mode.
 *
 * pi-ai maps a level onto a thinking token budget when the model is called
 * in budget mode, and onto `output_config.effort` when the model is called
 * in adaptive mode. In budget mode pi-ai clamps `xhigh` and `max` down to
 * `high`, so offering those two would put two identical choices in the
 * picker. The levels below are the ones budget mode can tell apart.
 *
 * A model called in adaptive mode uses the levels its snapshot entry
 * records instead — they are the upstream's statement of what it accepts,
 * and in adaptive mode they pass through unchanged.
 */
export const FALLBACK_EFFORT_LEVELS = ['low', 'medium', 'high']

/**
 * Build the pi-ai entry for one model.
 *
 * The `compat` block is only added when the model actually needs adaptive
 * thinking. It is never added with an undefined value, because js-yaml
 * cannot serialize one and the patch write would throw.
 *
 * @param modelId - the model id.
 * @param probe - `{ maxTokens, supportsThinking }` from the probe.
 * @param spec - the specification; looked up when omitted.
 * @returns the model entry.
 */
export function buildModelEntry(modelId, probe, spec = lookupSpec(modelId)) {
  const entry = {
    id: modelId,
    name: modelId,
    contextWindow: spec.contextWindow,
    maxTokens: spec.outputLimit,
    input: spec.modalities.filter((modality) => SUPPORTED_MODALITIES.includes(modality)),
  }
  // pi-ai refuses a model whose maxTokens is not a positive integer, and a
  // catalogue that fails takes its whole provider out of every picker, so a
  // degenerate measurement falls back to the snapshot's cap.
  const measured = probe.maxTokens
  if (Number.isInteger(measured) && measured > 0) entry.maxTokens = measured
  if (probe.supportsThinking === true) {
    // The levels an entry may offer are the ones its wire format can tell
    // apart. In adaptive mode pi-ai sends the level as `output_config.effort`
    // and the snapshot's own list passes through unchanged. In budget mode
    // pi-ai clamps `xhigh` and `max` to `high`, so offering them would put
    // two identical choices in the picker.
    const adaptive = spec.reasoningOptions?.type === 'effort'
    const declared = adaptive ? spec.reasoningOptions?.values ?? [] : []
    const levels = declared.length > 0 ? declared : FALLBACK_EFFORT_LEVELS
    entry.reasoningEfforts = Object.fromEntries(levels.map((level) => [level, level]))
    if (adaptive) {
      entry.compat = { forceAdaptiveThinking: true }
    }
  } else {
    entry.reasoningEfforts = false
  }
  return entry
}
