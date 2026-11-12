/**
 * Turning a probe result into one pi-ai model entry.
 */

import { SUPPORTED_MODALITIES, lookupSpec } from './specs.js'

/**
 * The effort levels offered for a model the snapshot says nothing about.
 *
 * pi-ai maps a level onto a thinking budget when the model is called in
 * budget mode, and onto `output_config.effort` when the model is called in
 * adaptive mode. Either way a level needs a wire spelling, and the ones
 * below are the spellings MiniMax accepts.
 *
 * A model whose snapshot entry records its own levels uses those instead —
 * they are the upstream's statement of what it accepts, and they win.
 */
export const FALLBACK_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

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
    maxTokens: probe.maxTokens ?? spec.outputLimit,
    input: spec.modalities.filter((modality) => SUPPORTED_MODALITIES.includes(modality)),
  }
  if (probe.supportsThinking === true) {
    const levels = spec.reasoningOptions?.values ?? FALLBACK_EFFORT_LEVELS
    entry.reasoningEfforts = Object.fromEntries(levels.map((level) => [level, level]))
    if (spec.reasoningOptions?.type === 'effort') {
      entry.compat = { forceAdaptiveThinking: true }
    }
  } else {
    entry.reasoningEfforts = false
  }
  return entry
}
