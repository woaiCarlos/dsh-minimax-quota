/**
 * Host half of the MiniMax quota bundle.
 *
 * The API key lives in the Host's credential store, so quota can only be read
 * here. The Host fetches the coding-plan remainder on demand and answers the
 * browser through one same-origin route that the Client half polls.
 */

import { fetchQuota } from './lib/quota.js'

/** Credential reference the pi-ai profile names for the MiniMax route. */
const DEFAULT_CREDENTIAL_REF = 'MINIMAX_CN_API_KEY'

/** Route the Client half reads. */
const ROUTE_PATH = '/plugin/minimax-quota'

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
