/**
 * The MiniMax coding-plan remainder.
 *
 * The endpoint answers HTTP 200 even when the key is refused, so the body
 * carries the real outcome and is the only trustworthy signal.
 */

import { resolveApiKey } from './credentials.js'

/** Coding-plan remainder endpoints, tried in order until one answers. */
export const QUOTA_ENDPOINTS = [
  'https://api.minimaxi.com/v1/coding_plan/remains',
  'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  'https://api.minimaxi.com/v1/token_plan/remains',
]

/** How long one upstream request may take. */
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * Pick the coding-plan bucket out of one response body.
 *
 * The body carries one entry per model family; `general` is the coding plan
 * itself, and the video bucket does not carry a plan quota.
 *
 * @param body - parsed upstream response.
 * @returns the coding-plan entry, or undefined when none answers.
 */
export function selectPlanEntry(body) {
  const entries = Array.isArray(body?.model_remains) ? body.model_remains : []
  const general = entries.find((entry) => entry?.model_name === 'general')
  if (general !== undefined) return general
  return entries.find((entry) => typeof entry?.current_interval_remaining_percent === 'number')
}

/**
 * Normalize one upstream entry into the view the Client renders.
 *
 * @param entry - the coding-plan bucket.
 * @returns the client-facing view.
 */
export function toQuotaView(entry) {
  const intervalRemaining = entry.current_interval_remaining_percent
  const weeklyRemaining = entry.current_weekly_remaining_percent
  // Status 3 means the plan carries no limit for that window, so the tier is
  // hidden rather than reported as a full 100%.
  const intervalUnlimited = entry.current_interval_status === 3
  const weeklyUnlimited = entry.current_weekly_status === 3
  return {
    intervalRemainingPercent: intervalUnlimited ? null : Number(intervalRemaining),
    weeklyRemainingPercent: weeklyUnlimited ? null : Number(weeklyRemaining),
    intervalResetAt: Number.isFinite(entry.end_time) ? entry.end_time : null,
    weeklyResetAt: Number.isFinite(entry.weekly_end_time) ? entry.weekly_end_time : null,
    intervalStatus: entry.current_interval_status ?? null,
    weeklyStatus: entry.current_weekly_status ?? null,
    fetchedAt: Date.now(),
  }
}

/**
 * Fetch the coding-plan remainder from MiniMax.
 *
 * @param ctx - Host context carrying the credential seam.
 * @param ref - credential reference to resolve.
 * @param signal - cancellation signal.
 * @param fetchImpl - fetch implementation, injected by the tests.
 * @returns the quota view, or a failure view carrying the reason.
 */
export async function fetchQuota(ctx, ref, signal, fetchImpl = fetch) {
  const apiKey = await resolveApiKey(ctx, ref)
  if (apiKey === undefined) {
    return { ok: false, reason: 'missing-credential', message: `No credential resolved for ${ref}.` }
  }
  const headers = {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    'content-type': 'application/json',
  }
  let lastError = 'unknown error'
  for (const endpoint of QUOTA_ENDPOINTS) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const composed = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
    let response
    try {
      response = await fetchImpl(endpoint, { method: 'GET', headers, signal: composed })
    } catch (error) {
      if (signal?.aborted === true) return { ok: false, reason: 'aborted', message: 'Request cancelled.' }
      lastError = error instanceof Error ? error.message : String(error)
      continue
    }
    let body
    try {
      body = await response.json()
    } catch {
      lastError = `HTTP ${response.status}`
      continue
    }
    const status = body?.base_resp?.status_code
    if (status !== 0) {
      lastError = body?.base_resp?.status_msg ?? `HTTP ${response.status}`
      continue
    }
    const entry = selectPlanEntry(body)
    if (entry === undefined) {
      // A pay-as-you-go key answers successfully but carries no coding-plan
      // bucket, so the account has no plan quota to show at all.
      return {
        ok: false,
        reason: 'no-plan',
        message: 'This MiniMax account has no coding-plan quota.',
      }
    }
    return { ok: true, ...toQuotaView(entry) }
  }
  return { ok: false, reason: 'request-failed', message: lastError }
}
