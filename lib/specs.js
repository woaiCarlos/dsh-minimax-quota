/**
 * Built-in snapshot of MiniMax model specifications.
 *
 * MiniMax's own API serves the model id list, the exact output cap and
 * whether a model still answers, but it does not serve the context window
 * or the input modalities. Those two come from this snapshot, which mirrors
 * models.dev's `minimax-cn` provider and was cross-checked against the live
 * API on 2026-11-12: the recorded context windows agree with the boundary
 * where MiniMax starts refusing oversized requests.
 *
 * `reasoningOptions` states how a model exposes thinking. `effort` means the
 * model accepts discrete effort levels, `toggle` means it only takes thinking
 * on or off, and `null` means the model thinks without offering levels.
 */

/** Modalities pi-ai accepts in a model entry. */
export const SUPPORTED_MODALITIES = ['text', 'image']

/** One known model, keyed by the id MiniMax reports. */
export const MODEL_SPECS = Object.freeze({
  'MiniMax-M3.1-Flash': {
    contextWindow: 1000000,
    outputLimit: 524288,
    modalities: ['text', 'image'],
    reasoningOptions: { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
  },
  'MiniMax-M3': {
    contextWindow: 1000000,
    outputLimit: 524288,
    modalities: ['text', 'image'],
    reasoningOptions: { type: 'toggle' },
  },
  'MiniMax-M2.7': {
    contextWindow: 204800,
    outputLimit: 131072,
    modalities: ['text'],
    reasoningOptions: null,
  },
  'MiniMax-M2.7-highspeed': {
    contextWindow: 204800,
    outputLimit: 131072,
    modalities: ['text'],
    reasoningOptions: null,
  },
  'MiniMax-M2.5': {
    contextWindow: 204800,
    outputLimit: 131072,
    modalities: ['text'],
    reasoningOptions: null,
  },
  'MiniMax-M2.5-highspeed': {
    contextWindow: 204800,
    outputLimit: 131072,
    modalities: ['text'],
    reasoningOptions: null,
  },
  'MiniMax-M2.1': {
    contextWindow: 204800,
    outputLimit: 131072,
    modalities: ['text'],
    reasoningOptions: null,
  },
  'MiniMax-M2.1-highspeed': {
    contextWindow: 204800,
    outputLimit: 131072,
    modalities: ['text'],
    reasoningOptions: null,
  },
  'MiniMax-M2': {
    contextWindow: 204800,
    outputLimit: 131072,
    modalities: ['text'],
    reasoningOptions: null,
  },
})

/** Specification used for a model this snapshot has never seen. */
export const FALLBACK_SPEC = Object.freeze({
  contextWindow: 1000000,
  outputLimit: 131072,
  modalities: ['text'],
  reasoningOptions: null,
})

/**
 * Look up the specification of one model id.
 *
 * @param modelId - the id MiniMax reports.
 * @returns the known specification, or the conservative fallback.
 */
export function lookupSpec(modelId) {
  return MODEL_SPECS[modelId] ?? FALLBACK_SPEC
}
