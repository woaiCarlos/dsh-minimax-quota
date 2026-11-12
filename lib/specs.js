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
export const SUPPORTED_MODALITIES = Object.freeze(['text', 'image'])

/**
 * Freeze an object and everything inside it.
 *
 * A shallow freeze would leave the nested arrays mutable, and a mutated
 * modality list is exactly what pi-ai rejects.
 *
 * @param value - the value to freeze.
 * @returns the frozen value.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/** One known model, keyed by the id MiniMax reports. */
export const MODEL_SPECS = deepFreeze({
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
export const FALLBACK_SPEC = deepFreeze({
  contextWindow: 1000000,
  outputLimit: 131072,
  modalities: ['text'],
  reasoningOptions: null,
})

/**
 * Look up the specification of one model id.
 *
 * The lookup is an own-property check, not a plain read: a plain read finds
 * `toString` and `__proto__` on the prototype chain, and the model ids come
 * from an upstream API that this plugin does not control.
 *
 * @param modelId - the id MiniMax reports.
 * @returns the known specification, or the conservative fallback.
 */
export function lookupSpec(modelId) {
  return Object.hasOwn(MODEL_SPECS, modelId) ? MODEL_SPECS[modelId] : FALLBACK_SPEC
}
