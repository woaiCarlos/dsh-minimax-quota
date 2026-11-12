/**
 * Talking to MiniMax about the models its account can use.
 *
 * Four facts shape this module.
 *
 * `GET /v1/models` lists models the account can no longer call, so the list
 * is a candidate set and every candidate still has to be probed.
 *
 * The exact output cap is written into the refusal of an over-limit
 * request, and that request is rejected before generation, so reading the
 * cap costs nothing.
 *
 * Whether a model thinks can only be told by a request that makes it think.
 * A prompt like "hi" yields a false negative for every model, because there
 * is nothing to think about; the prompt has to demand reasoning.
 *
 * MiniMax validates `max_tokens` before it checks whether the model still
 * exists, so a retired model answers the cap request with a cap and only
 * says it is gone on the next request.
 */

/** Anthropic-compatible messages endpoint. */
export const MESSAGES_URL = 'https://api.minimaxi.com/anthropic/v1/messages'

/** OpenAI-compatible model list endpoint. */
export const MODELS_URL = 'https://api.minimaxi.com/v1/models'

/** A max_tokens value no MiniMax model accepts, used to elicit the cap. */
export const OVER_LIMIT_MAX_TOKENS = 999_999_999

/** A prompt that reliably makes a reasoning model produce a thinking block. */
export const THINKING_PROMPT = 'What is 17*23? Think it through.'

/** How long one probe request may take. */
export const PROBE_TIMEOUT_MS = 20_000

/**
 * Read the output cap out of a refusal message.
 *
 * @param message - the error message the endpoint answered with.
 * @returns the cap, or undefined when the message carries none.
 */
export function parseMaxTokensLimit(message) {
  const match = /does not support max tokens > (\d+)/.exec(message)
  return match === null ? undefined : Number(match[1])
}

/**
 * Recognize the refusal that marks a retired model.
 *
 * @param message - the error message the endpoint answered with.
 * @returns true when the model is no longer available.
 */
export function isRetired(message) {
  return /no longer available/i.test(message)
}

/**
 * Send one request to the Anthropic-compatible endpoint.
 *
 * @param body - the request body.
 * @param apiKey - the MiniMax secret.
 * @param options - `{ signal, fetchImpl }`.
 * @returns the status, the parsed payload when there is one, and the message.
 */
export async function postMessage(body, apiKey, { signal, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const composed = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
  let response
  try {
    response = await fetchImpl(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: composed,
    })
  } catch (error) {
    return { status: 0, payload: undefined, message: error instanceof Error ? error.message : String(error) }
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    return { status: response.status, payload: undefined, message: `HTTP ${response.status}` }
  }
  return {
    status: response.status,
    payload,
    message: typeof payload?.error?.message === 'string' ? payload.error.message : '',
  }
}

/**
 * List the model ids MiniMax reports for this account.
 *
 * The list carries retired models as well, so every id still has to be
 * probed before it may be written into the profile.
 *
 * @param apiKey - the MiniMax secret.
 * @param options - `{ signal, fetchImpl }`.
 * @returns the candidate model ids, or null when the list could not be read.
 */
export async function fetchModelIds(apiKey, { signal, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const composed = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
  let response
  try {
    response = await fetchImpl(MODELS_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: composed,
    })
  } catch {
    // A failed read is not an empty account, and the caller has to be able to
    // tell the two apart.
    return null
  }
  let body
  try {
    body = await response.json()
  } catch {
    return null
  }
  if (!Array.isArray(body?.data)) return null
  const data = body.data
  return data.map((entry) => entry?.id).filter((id) => typeof id === 'string' && id.length > 0)
}

/**
 * Probe one model for liveness, output cap and thinking.
 *
 * @param modelId - the model to probe.
 * @param apiKey - the MiniMax secret.
 * @param options - `{ signal, fetchImpl }`.
 * @returns the probe outcome.
 */
export async function probeModel(modelId, apiKey, { signal, fetchImpl = fetch } = {}) {
  const cap = await postMessage({
    model: modelId,
    max_tokens: OVER_LIMIT_MAX_TOKENS,
    messages: [{ role: 'user', content: 'hi' }],
  }, apiKey, { signal, fetchImpl })
  const capMessage = cap.message
  if (isRetired(capMessage)) return { status: 'retired', modelId }
  const maxTokens = parseMaxTokensLimit(capMessage)
  if (maxTokens === undefined) {
    // The cap request did not answer with a cap, so the measurement failed.
    // Reporting this as ok would record the model as healthy with an unknown
    // cap, which is the opposite of what was measured.
    return { status: 'failed', modelId, reason: capMessage || `HTTP ${cap.status}` }
  }

  const thinkingTokens = Math.min(8192, maxTokens)
  const thinking = await postMessage({
    model: modelId,
    max_tokens: thinkingTokens,
    messages: [{ role: 'user', content: THINKING_PROMPT }],
    thinking: { type: 'enabled', budget_tokens: 4096 },
  }, apiKey, { signal, fetchImpl })
  const thinkingMessage = thinking.message
  // MiniMax validates `max_tokens` before it checks whether the model still
  // exists, so a retired model answers the cap request with a cap and only
  // says it is gone on this request.
  if (isRetired(thinkingMessage)) return { status: 'retired', modelId }
  const blocks = Array.isArray(thinking.payload?.content) ? thinking.payload.content : undefined
  if (blocks === undefined) {
    if (!/thinking/i.test(thinkingMessage)) {
      return { status: 'failed', modelId, reason: thinkingMessage || `HTTP ${thinking.status}` }
    }
    // The endpoint refused the `thinking` field, which means this model does
    // not think. Ask again without it: an answer then is a measurement rather
    // than a failure.
    const plain = await postMessage({
      model: modelId,
      max_tokens: thinkingTokens,
      messages: [{ role: 'user', content: THINKING_PROMPT }],
    }, apiKey, { signal, fetchImpl })
    const plainBlocks = Array.isArray(plain.payload?.content) ? plain.payload.content : undefined
    if (plainBlocks === undefined) {
      return { status: 'failed', modelId, reason: thinkingMessage || `HTTP ${thinking.status}` }
    }
    return { status: 'ok', modelId, maxTokens, supportsThinking: false }
  }
  return {
    status: 'ok',
    modelId,
    maxTokens,
    supportsThinking: blocks.some((block) => block?.type === 'thinking'),
  }
}
