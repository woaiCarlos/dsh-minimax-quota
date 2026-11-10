/**
 * Host half of the MiniMax quota bundle.
 *
 * The API key lives in the Host's credential store, so quota can only be read
 * here. The Host fetches the coding-plan remainder on demand and answers the
 * browser through one same-origin route that the Client half polls.
 */

/** Credential reference the pi-ai profile names for the MiniMax route. */
const DEFAULT_CREDENTIAL_REF = 'MINIMAX_CN_API_KEY'

/** Coding-plan remainder endpoints, tried in order until one answers. */
const QUOTA_ENDPOINTS = [
  'https://api.minimaxi.com/v1/coding_plan/remains',
  'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  'https://api.minimaxi.com/v1/token_plan/remains',
]

/** Route the Client half reads. */
const ROUTE_PATH = '/plugin/minimax-quota'

/** How long one upstream request may take. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Read the credential the MiniMax route authenticates with.
 *
 * @param ctx - Host context carrying the credential seam.
 * @param ref - credential reference to resolve.
 * @returns the secret, or undefined when the reference resolves to nothing.
 */
async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const hit = await credentials.resolve(ref)
  const value = hit?.value
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Pick the coding-plan bucket out of one response body.
 *
 * The body carries one entry per model family; `general` is the coding plan
 * itself, and the video bucket does not carry a plan quota.
 *
 * @param body - parsed upstream response.
 * @returns the coding-plan entry, or undefined when none answers.
 */
function selectPlanEntry(body) {
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
function toQuotaView(entry) {
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
 * The endpoint answers HTTP 200 even when the key is refused, so the body
 * carries the real outcome and is the only trustworthy signal.
 *
 * @param ctx - Host context carrying the credential seam.
 * @param ref - credential reference to resolve.
 * @param signal - cancellation signal.
 * @returns the quota view, or a failure view carrying the reason.
 */
async function fetchQuota(ctx, ref, signal) {
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
      response = await fetch(endpoint, { method: 'GET', headers, signal: composed })
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

/**
 * Host entry: expose the quota route and answer it from the credential store.
 *
 * @param ctx - Host context.
 * @param config - plugin configuration.
 */
export async function apply(ctx, config) {
  const credentialRef = config.credentialRef ?? DEFAULT_CREDENTIAL_REF
  // The `webServer` service arrives with the web app bundle, which may load
  // after this one; the declared injection defers activation until it exists,
  // so the route is never silently skipped.
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    throw new Error('minimax-quota: the webServer service is unavailable, so the quota route cannot be registered')
  }
  const dispose = webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    async handler(req, res) {
      const abort = new AbortController()
      req.once('close', () => {
        if (!res.writableEnded) abort.abort()
      })
      const view = await fetchQuota(ctx, credentialRef, abort.signal)
      const body = JSON.stringify(view)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  })
  ctx.effect(() => dispose, 'minimax-quota: quota route')
}

/**
 * Services this plugin waits for before it activates.
 */
export const inject = ['webServer']

/**
 * A Standard Schema for the plugin's configuration.
 *
 * The Loader validates a row's config through the schema's `~standard`
 * entry, so this bundle carries its own tiny implementation rather than a
 * schema dependency: the bundle is installed as a link into a workspace
 * directory, where a declared dependency would not resolve.
 */
const Config = {
  '~standard': {
    version: 1,
    vendor: '@local/dsh-minimax-quota',
    validate(value) {
      const raw = value === undefined || value === null ? {} : value
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'minimax-quota: config must be an object' }] }
      }
      const issues = []
      const config = {}
      for (const [key, entry] of Object.entries(raw)) {
        if (key !== 'credentialRef') {
          issues.push({ message: `minimax-quota: unknown config field "${key}"`, path: [key] })
          continue
        }
        if (typeof entry !== 'string' || entry.length === 0) {
          issues.push({ message: 'minimax-quota: credentialRef must be a non-empty string', path: [key] })
          continue
        }
        config.credentialRef = entry
      }
      if (issues.length > 0) return { issues }
      if (config.credentialRef === undefined) config.credentialRef = DEFAULT_CREDENTIAL_REF
      return { value: config }
    },
  },
}

export { Config }
