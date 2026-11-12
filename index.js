/**
 * Host half of the MiniMax bundle.
 *
 * Two jobs live here. The first is the coding-plan quota the Browser half
 * shows below the composer. The second is keeping the profile's MiniMax
 * model list current: newly released models are probed and appended, and
 * nothing the user already has is ever touched.
 *
 * The API key lives in the Host's credential store, so neither job can run
 * in the browser. The Host answers the Browser half through same-origin
 * routes and never forwards a secret.
 */

import { resolveApiKey } from './lib/credentials.js'
import { fetchQuota } from './lib/quota.js'
import { fetchModelIds, probeModel } from './lib/probe.js'
import { buildModelEntry } from './lib/model-entry.js'
import { planAppend } from './lib/merge.js'
import { readState, writeState } from './lib/state.js'

/** Credential reference the pi-ai profile names for the MiniMax route. */
const DEFAULT_CREDENTIAL_REF = 'MINIMAX_CN_API_KEY'

/** Route the Browser half reads. */
const STATUS_ROUTE = '/plugin/minimax/status'

/** Route the Browser half posts to when the user asks for a sync. */
const SYNC_ROUTE = '/plugin/minimax/sync'

/** How long a day is, in milliseconds. */
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000

/** The pi-ai settings namespace that holds the provider list. */
const SETTINGS_NAMESPACE = 'llm-pi-ai'

/** The provider route inside that namespace. */
const PROVIDER_ROUTE = 'minimax-cn'

/** How long the first sync waits before it tries again. */
const FIRST_SYNC_DELAY_MS = 2000

/** How many times the first sync tries before it gives up. */
const FIRST_SYNC_ATTEMPTS = 5

/**
 * Read the profile's current MiniMax model list.
 *
 * @param settings - the settings service.
 * @returns the descriptor of the pi-ai namespace, or undefined.
 */
function readProviderDescriptor(settings) {
  if (settings === undefined) return undefined
  const descriptor = settings.describe().find((row) => row.ns === SETTINGS_NAMESPACE)
  return descriptor
}

/**
 * The provider routes the effective profile shows.
 *
 * The effective projection is the merged view of every layer, so a route the
 * user configured in an inherited layer is visible here. The profile override
 * on its own is not enough: the settings service strips the volatile fields
 * from the override and merges the written value over it, so the `providers`
 * map a write carries replaces the inherited one outright. A map built from
 * the override alone would drop a route the user configured elsewhere,
 * together with the credential environment that route needs.
 *
 * @param descriptor - the pi-ai namespace descriptor.
 * @returns the provider routes.
 */
function providerRoutes(descriptor) {
  const providers = descriptor?.value?.providers
  return providers !== null && typeof providers === 'object' ? providers : {}
}

/**
 * The model entries the profile currently lists.
 *
 * @param descriptor - the pi-ai namespace descriptor.
 * @returns the listed entries.
 */
function currentModels(descriptor) {
  const models = providerRoutes(descriptor)[PROVIDER_ROUTE]?.models
  return Array.isArray(models) ? models : []
}

/**
 * Report a failure where the operator can read it.
 *
 * The browser only ever receives a fixed reason, so an internal message goes
 * to the Host log instead of into the page. A failure nobody anticipated must
 * not be able to carry an internal detail into the browser.
 *
 * @param ctx - Host context.
 * @param message - what failed.
 * @param error - the failure.
 */
function reportFailure(ctx, message, error) {
  ctx.logger?.error?.('%s: %s', message, error)
}

/** The sync that is running right now, so a second caller waits for it. */
let inFlight = null

/**
 * Run one sync.
 *
 * One sync runs at a time. Two overlapping syncs would race on the profile
 * write and on the state file, and the second would either lose the write
 * or record a state that does not match the profile.
 *
 * @param ctx - Host context.
 * @param options - the sync options.
 * @returns the sync result.
 */
export async function runSync(ctx, options = {}) {
  if (inFlight !== null) return inFlight
  inFlight = runSyncOnce(ctx, options)
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/**
 * Do the work of one sync.
 *
 * Every candidate model is probed and the ones that answer are appended.
 * The plugin only ever appends: an entry the user already has is left
 * exactly as it is, and a model the user removed by hand is not added
 * back, because the ids this plugin added are remembered.
 *
 * @param ctx - Host context.
 * @param options - `{ credentialRef, profileDir, fetchImpl, stateReader, stateWriter, now }`.
 * @returns the sync outcome.
 */
async function runSyncOnce(ctx, options = {}) {
  const credentialRef = options.credentialRef ?? DEFAULT_CREDENTIAL_REF
  const settings = ctx.get('settings')
  if (settings === undefined) return { ok: false, reason: 'missing-settings' }
  const descriptor = readProviderDescriptor(settings)
  if (descriptor === undefined) return { ok: false, reason: 'missing-namespace' }
  const apiKey = await resolveApiKey(ctx, credentialRef)
  if (apiKey === undefined) return { ok: false, reason: 'missing-credential' }

  const profileDir = options.profileDir ?? ctx.get('profileContext')?.dir
  const readStateFn = options.stateReader ?? (profileDir === undefined
    ? async () => ({ addedModels: [], lastSyncAt: null })
    : (dir) => readState(dir))
  const writeStateFn = options.stateWriter ?? (profileDir === undefined
    ? async () => {}
    : (dir, state) => writeState(dir, state))

  const state = await readStateFn(profileDir)
  const listed = currentModels(descriptor)
  const ids = await fetchModelIds(apiKey, { signal: options.signal, fetchImpl: options.fetchImpl })
  if (ids === null) {
    // The list could not be read. That is not an empty account, and it must
    // not be mistaken for one.
    return { ok: false, reason: 'model-list-failed' }
  }
  const candidateIds = ids
    .filter((id) => !listed.some((entry) => entry?.id === id) && !state.addedModels.includes(id))

  const entries = new Map()
  for (const id of candidateIds) {
    const probe = await probeModel(id, apiKey, { signal: options.signal, fetchImpl: options.fetchImpl })
    if (probe.status !== 'ok') continue
    entries.set(id, buildModelEntry(id, probe))
  }

  const plan = planAppend({
    currentModels: listed,
    addedModels: state.addedModels,
    candidateIds,
    entries,
  })
  if (!plan.changed) {
    return { ok: true, added: [], models: listed }
  }

  // The written map is the effective one, because the settings service
  // replaces the whole `providers` map: a route the user configured in an
  // inherited layer is only visible in the effective projection, and a map
  // built from the profile override alone would drop that route and the
  // credential environment it needs.
  const routes = providerRoutes(descriptor)
  await settings.write(SETTINGS_NAMESPACE, (current) => ({
    ...current,
    providers: {
      ...routes,
      [PROVIDER_ROUTE]: {
        ...routes[PROVIDER_ROUTE],
        models: plan.models,
      },
    },
  }), descriptor.revision, ['providers', PROVIDER_ROUTE, 'models'])

  const now = options.now ?? Date.now
  try {
    await writeStateFn(profileDir, {
      addedModels: [...state.addedModels, ...plan.addedIds],
      lastSyncAt: now(),
    })
  } catch {
    // The models are already in the profile, so a failed bookkeeping write
    // must not fail the sync. The next sync writes the state again.
  }
  return { ok: true, added: plan.addedIds, models: plan.models }
}

/**
 * Assemble what the Browser half reads.
 *
 * @param ctx - Host context.
 * @param options - `{ credentialRef, stateReader, quotaFetcher }`.
 * @returns the status payload.
 */
export async function buildStatusPayload(ctx, options = {}) {
  const credentialRef = options.credentialRef ?? DEFAULT_CREDENTIAL_REF
  const settings = ctx.get('settings')
  const descriptor = readProviderDescriptor(settings)
  const profileDir = options.profileDir ?? ctx.get('profileContext')?.dir
  const readStateFn = options.stateReader ?? (profileDir === undefined
    ? async () => ({ addedModels: [], lastSyncAt: null })
    : (dir) => readState(dir))
  const quotaFetcher = options.quotaFetcher ?? ((c, ref, signal) => fetchQuota(c, ref, signal))
  const state = await readStateFn(profileDir)
  const quota = await quotaFetcher(ctx, credentialRef, options.signal)
  const models = currentModels(descriptor)
  const synced = models.map((entry) => entry?.id).filter((id) => typeof id === 'string')
  return {
    quota,
    models: {
      synced,
      added: state.addedModels,
      syncedAt: state.lastSyncAt,
    },
  }
}

/**
 * Host entry: expose the routes and keep the model list current.
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
    throw new Error('dsh-minimax: the webServer service is unavailable, so the routes cannot be registered')
  }

  const send = (res, payload, status = 200) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      async handler(req, res) {
        const abort = new AbortController()
        req.once('close', () => {
          if (!res.writableEnded) abort.abort()
        })
        try {
          send(res, await buildStatusPayload(ctx, { credentialRef, signal: abort.signal }))
        } catch (error) {
          // The route answers every sixty seconds; an unwritten response would
          // leave the browser's request pending forever and stop its polling.
          // The browser only learns that the request failed: the message
          // belongs on the Host side, where the operator can read it.
          reportFailure(ctx, 'dsh-minimax: the status route failed', error)
          send(res, {
            quota: { ok: false, reason: 'request-failed' },
            models: { synced: [], added: [], syncedAt: null },
          })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: SYNC_ROUTE,
      async handler(req, res) {
        if (req.method !== 'POST') {
          send(res, { ok: false, reason: 'method-not-allowed' }, 405)
          return
        }
        const abort = new AbortController()
        req.once('close', () => {
          if (!res.writableEnded) abort.abort()
        })
        try {
          send(res, await runSync(ctx, { credentialRef, signal: abort.signal }))
        } catch (error) {
          // The browser only ever receives a fixed reason, so a failure nobody
          // anticipated cannot carry an internal message into the page.
          reportFailure(ctx, 'dsh-minimax: the sync route failed', error)
          send(res, { ok: false, reason: 'sync-failed' })
        }
      },
    }),
  ]
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'dsh-minimax: routes')

  // The profile may still be loading, so the first sync waits for the pi-ai
  // namespace to appear before it gives up. The pending attempt is called off
  // with the plugin, so a plugin that is unloaded inside that window never
  // writes the profile afterwards.
  const cancelFirstSync = scheduleSync(ctx, credentialRef)
  ctx.effect(() => cancelFirstSync, 'dsh-minimax: first sync')

  // The plugin also probes once a day, so a model MiniMax releases while the
  // plugin is running still arrives without the user restarting anything.
  const cancelDailySync = scheduleDailySync(ctx, credentialRef)
  ctx.effect(() => cancelDailySync, 'dsh-minimax: daily sync')
}

/**
 * Run the first sync once the profile has settled.
 *
 * The wait is a timer, so the plugin has to be able to call it off: a
 * plugin that is unloaded while the attempt is pending must not write the
 * profile afterwards.
 *
 * @param ctx - Host context.
 * @param credentialRef - credential reference to resolve.
 * @returns a function that cancels the pending attempt.
 */
function scheduleSync(ctx, credentialRef) {
  let timer = null
  let wake = null
  let cancelled = false

  const wait = (ms) => new Promise((resolve) => {
    wake = resolve
    timer = setTimeout(() => {
      timer = null
      wake = null
      resolve()
    }, ms)
  })

  const cancel = () => {
    cancelled = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (wake !== null) {
      const resolve = wake
      wake = null
      resolve()
    }
  }

  const attempt = async () => {
    for (let round = 0; round < FIRST_SYNC_ATTEMPTS; round += 1) {
      await wait(FIRST_SYNC_DELAY_MS)
      if (cancelled) return
      try {
        const result = await runSync(ctx, { credentialRef })
        if (result.ok || result.reason === 'missing-credential') return
      } catch {
        // A failed sync must never take the plugin down; the next attempt
        // tries again.
      }
    }
  }

  void attempt()
  return cancel
}

/**
 * Probe once a day.
 *
 * The plugin probes the models MiniMax offers at startup, and then once a
 * day, so a model MiniMax releases while the plugin is running still
 * arrives without the user restarting anything. Only models that are
 * neither listed by the user nor added by the plugin are probed, so a quiet
 * day costs one model-list request and nothing else.
 *
 * @param ctx - Host context.
 * @param credentialRef - credential reference to resolve.
 * @returns a function that cancels the pending sweep.
 */
function scheduleDailySync(ctx, credentialRef) {
  let timer = null
  let wake = null
  let cancelled = false

  const wait = (ms) => new Promise((resolve) => {
    wake = resolve
    timer = setTimeout(() => {
      timer = null
      wake = null
      resolve()
    }, ms)
    timer.unref?.()
  })

  const cancel = () => {
    cancelled = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (wake !== null) {
      const resolve = wake
      wake = null
      resolve()
    }
  }

  const sweep = async () => {
    while (!cancelled) {
      await wait(SYNC_INTERVAL_MS)
      if (cancelled) return
      try {
        const result = await runSync(ctx, { credentialRef })
        ctx.logger?.info?.('%s: %s', 'dsh-minimax: the daily sync found', result.ok ? 'no new model' : result.reason)
      } catch (error) {
        reportFailure(ctx, 'the daily sync failed', error)
      }
    }
  }

  void sweep()
  return cancel
}

/**
 * Services this plugin waits for before it activates.
 */
export const inject = ['webServer', 'credentials', 'settings']

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
    vendor: 'dsh-minimax',
    validate(value) {
      const raw = value === undefined || value === null ? {} : value
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'dsh-minimax: config must be an object' }] }
      }
      const issues = []
      const config = {}
      for (const [key, entry] of Object.entries(raw)) {
        if (key !== 'credentialRef') {
          issues.push({ message: `dsh-minimax: unknown config field "${key}"`, path: [key] })
          continue
        }
        if (typeof entry !== 'string' || entry.length === 0) {
          issues.push({ message: 'dsh-minimax: credentialRef must be a non-empty string', path: [key] })
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
