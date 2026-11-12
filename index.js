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

/**
 * The grammar a credential reference must match.
 *
 * The credentials service only recognises a reference that is a POSIX shell
 * identifier, so a reference outside this grammar resolves to nothing: the
 * plugin would answer `missing-credential` while the key itself sits in
 * plain text in the profile patch.
 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The field of the provider map that holds the model list. */
const PROVIDERS_PATH = 'providers'

/** The field of a provider route that holds the model list. */
const MODELS_PATH = 'models'

/** How long the first sync waits before it tries again. */
const FIRST_SYNC_DELAY_MS = 2000

/** How many times the first sync tries before it gives up. */
const FIRST_SYNC_ATTEMPTS = 5

/**
 * The reason a sync reports when it was called off.
 *
 * An abort is not a failure: the plugin was unloaded, so the sync stops
 * where it is, writes nothing, and says nothing. The reason is what tells
 * the caller that it was called off rather than that it went wrong.
 */
const ABORTED_REASON = 'aborted'

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
 * The provider routes the profile override itself carries.
 *
 * The override is the raw profile patch row, so its entries carry exactly
 * the wording the user wrote: no schema default has been materialised into
 * them. The effective projection cannot be used for this, because it is the
 * schema-resolved one — every entry the user wrote carries a materialised
 * `compat` block, and writing those back would change the user's wording.
 *
 * @param descriptor - the pi-ai namespace descriptor.
 * @returns the override's provider routes, or undefined when the descriptor
 *   carries no override.
 */
function overrideRoutes(descriptor) {
  const providers = descriptor?.user?.providers
  return providers !== null && typeof providers === 'object' ? providers : undefined
}

/**
 * The model entries the profile override itself carries.
 *
 * @param descriptor - the pi-ai namespace descriptor.
 * @returns the entries, or undefined when the override carries none.
 */
function overrideModels(descriptor) {
  const routes = overrideRoutes(descriptor)
  if (routes === undefined) return undefined
  const models = routes[PROVIDER_ROUTE]?.models
  return Array.isArray(models) ? models : undefined
}

/**
 * The model entries the profile currently lists.
 *
 * The override's own entries come first, so that the entries the user
 * wrote keep their wording. The effective entries are the fallback, for a
 * route the override does not carry: a route the user configured in an
 * inherited layer is only visible there.
 *
 * @param descriptor - the pi-ai namespace descriptor.
 * @returns the listed entries.
 */
function currentModels(descriptor) {
  const raw = overrideModels(descriptor)
  if (raw !== undefined) return raw
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

/**
 * Report one sync on the Host log.
 *
 * The design asks for one line per sync, and the line has to say how many
 * models were added: a sync that added nothing and a sync that added three
 * read the same otherwise.
 *
 * @param ctx - Host context.
 * @param label - what ran, e.g. 'the startup sync'.
 * @param result - the sync result.
 */
function logSync(ctx, label, result) {
  if (result?.reason === ABORTED_REASON) {
    // An abort is not a failure. The plugin was unloaded, so the sync stops
    // quietly and the operator is not told about a problem that is not one.
    return
  }
  if (result?.ok !== true) {
    ctx.logger?.warn?.('%s: %s', `@woaicarlos/dsh-minimax: ${label} failed`, result?.reason ?? 'unknown')
    return
  }
  const added = Array.isArray(result.added) ? result.added.length : 0
  ctx.logger?.info?.('%s: %d', `@woaicarlos/dsh-minimax: ${label} added`, added)
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
 * A signal is what calls the sync off. Every upstream request carries it,
 * so an abort stops the requests that are in flight, and the sync returns
 * without writing anything: a plugin that was unloaded must not write the
 * profile or its own bookkeeping afterwards.
 *
 * @param ctx - Host context.
 * @param options - `{ credentialRef, profileDir, fetchImpl, stateReader, stateWriter, now, signal }`.
 * @returns the sync outcome.
 */
async function runSyncOnce(ctx, options = {}) {
  const signal = options.signal
  /**
   * Whether the caller called this sync off.
   *
   * @returns true when the sync was called off.
   */
  const calledOff = () => signal?.aborted === true
  if (calledOff()) return { ok: false, reason: ABORTED_REASON }
  const credentialRef = options.credentialRef ?? DEFAULT_CREDENTIAL_REF
  const settings = ctx.get('settings')
  if (settings === undefined) return { ok: false, reason: 'missing-settings' }
  const descriptor = readProviderDescriptor(settings)
  if (descriptor === undefined) return { ok: false, reason: 'missing-namespace' }
  const apiKey = await resolveApiKey(ctx, credentialRef)
  if (apiKey === undefined) return { ok: false, reason: 'missing-credential' }
  if (calledOff()) return { ok: false, reason: ABORTED_REASON }

  const profileDir = options.profileDir ?? ctx.get('profileContext')?.dir
  const readStateFn = options.stateReader ?? (profileDir === undefined
    ? async () => ({ addedModels: [], lastSyncAt: null })
    : (dir) => readState(dir))
  const writeStateFn = options.stateWriter ?? (profileDir === undefined
    ? async () => {}
    : (dir, state) => writeState(dir, state))

  const state = await readStateFn(profileDir)
  const addedModels = Array.isArray(state.addedModels) ? state.addedModels : []
  const retiredModels = Array.isArray(state.retiredModels) ? state.retiredModels : []
  const listed = currentModels(descriptor)
  const ids = await fetchModelIds(apiKey, { signal, fetchImpl: options.fetchImpl })
  if (calledOff()) return { ok: false, reason: ABORTED_REASON }
  if (ids === null) {
    // The list could not be read. That is not an empty account, and it must
    // not be mistaken for one.
    return { ok: false, reason: 'model-list-failed' }
  }
  const candidateIds = ids
    .filter((id) => !listed.some((entry) => entry?.id === id)
      && !addedModels.includes(id)
      // A model MiniMax has retired stays retired, and it is remembered:
      // `/v1/models` keeps listing it, so probing it again every sweep would
      // cost two upstream requests for an answer that never changes.
      && !retiredModels.includes(id))

  const entries = new Map()
  const retiredIds = []
  for (const id of candidateIds) {
    const probe = await probeModel(id, apiKey, { signal, fetchImpl: options.fetchImpl })
    // The sync was called off while the model was being probed, so the
    // remaining models are not probed and nothing is written.
    if (calledOff()) return { ok: false, reason: ABORTED_REASON }
    if (probe.status === 'retired') {
      retiredIds.push(id)
      continue
    }
    if (probe.status !== 'ok') continue
    entries.set(id, buildModelEntry(id, probe))
  }

  const plan = planAppend({
    currentModels: listed,
    addedModels,
    candidateIds,
    entries,
  })
  if (!plan.changed && retiredIds.length === 0) {
    return { ok: true, added: [], models: plan.models }
  }

  if (plan.changed) {
    // The write happens only while the sync is still wanted: a plugin that
    // was unloaded must not change the profile of the user.
    if (calledOff()) return { ok: false, reason: ABORTED_REASON }
    // The written map is the effective one, because the settings service
    // replaces the whole `providers` map: a route the user configured in an
    // inherited layer is only visible in the effective projection, and a map
    // built from the profile override alone would drop that route and the
    // credential environment it needs. The route's model list is the planned
    // one, which the user's own entries start from.
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
    }), descriptor.revision, [[PROVIDERS_PATH, PROVIDER_ROUTE, MODELS_PATH]])
  }

  const now = options.now ?? Date.now
  // The bookkeeping write is the last thing the sync does, and it happens
  // only while the sync is still wanted: a state file written after the
  // plugin was unloaded would land in a directory that is on its way out.
  if (calledOff()) return { ok: false, reason: ABORTED_REASON }
  try {
    await writeStateFn(profileDir, {
      addedModels: [...addedModels, ...plan.addedIds],
      retiredModels: [...retiredModels, ...retiredIds],
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
    throw new Error('@woaicarlos/dsh-minimax: the webServer service is unavailable, so the routes cannot be registered')
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
          reportFailure(ctx, '@woaicarlos/dsh-minimax: the status route failed', error)
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
          const result = await runSync(ctx, { credentialRef, signal: abort.signal })
          // Every sync leaves one line on the Host log, so the operator can
          // see what the plugin did without reading the profile.
          logSync(ctx, 'the manual sync', result)
          send(res, result)
        } catch (error) {
          // The browser only ever receives a fixed reason, so a failure nobody
          // anticipated cannot carry an internal message into the page.
          reportFailure(ctx, '@woaicarlos/dsh-minimax: the sync route failed', error)
          send(res, { ok: false, reason: 'sync-failed' })
        }
      },
    }),
  ]
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, '@woaicarlos/dsh-minimax: routes')

  // The profile may still be loading, so the first sync waits for the pi-ai
  // namespace to appear before it gives up. The pending attempt is called off
  // with the plugin, so a plugin that is unloaded inside that window never
  // writes the profile afterwards.
  const cancelFirstSync = scheduleSync(ctx, credentialRef)
  ctx.effect(() => cancelFirstSync, '@woaicarlos/dsh-minimax: first sync')

  // The plugin also probes once a day, so a model MiniMax releases while the
  // plugin is running still arrives without the user restarting anything.
  const cancelDailySync = scheduleDailySync(ctx, credentialRef)
  ctx.effect(() => cancelDailySync, '@woaicarlos/dsh-minimax: daily sync')
}

/**
 * Run the first sync once the profile has settled.
 *
 * The wait is a timer, so the plugin has to be able to call it off: a
 * plugin that is unloaded while the attempt is pending must not write the
 * profile afterwards. The attempt owns a signal as well, so a plugin that
 * is unloaded while the sync is running stops it: the upstream requests
 * are called off and nothing is written into the profile afterwards.
 *
 * @param ctx - Host context.
 * @param credentialRef - credential reference to resolve.
 * @returns a function that cancels the pending attempt.
 */
function scheduleSync(ctx, credentialRef) {
  let timer = null
  let wake = null
  let cancelled = false
  const controller = new AbortController()

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
    // A sync that is already running stops here: the signal reaches the
    // upstream requests and the sync writes nothing afterwards.
    controller.abort()
  }

  const attempt = async () => {
    for (let round = 0; round < FIRST_SYNC_ATTEMPTS; round += 1) {
      await wait(FIRST_SYNC_DELAY_MS)
      if (cancelled) return
      try {
        const result = await runSync(ctx, { credentialRef, signal: controller.signal })
        // An abort is not a failure and is not tried again: the plugin is
        // gone, so the attempt stops here and says nothing.
        if (controller.signal.aborted || result?.reason === ABORTED_REASON) return
        logSync(ctx, 'the startup sync', result)
        if (result.ok || result.reason === 'missing-credential') return
      } catch (error) {
        if (controller.signal.aborted) return
        // A failed sync must never take the plugin down; the next attempt
        // tries again. The failure is not swallowed: it goes to the log.
        reportFailure(ctx, '@woaicarlos/dsh-minimax: the startup sync failed', error)
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
 * neither listed by the user nor added by the plugin nor retired by MiniMax
 * are probed, so a quiet day costs one model-list request and nothing else.
 * A model MiniMax retired is probed once and then remembered, so it does not
 * cost two requests every day for an answer that never changes.
 *
 * The sweep owns a signal, so a plugin that is unloaded while the sweep is
 * running stops it: the upstream requests are called off and nothing is
 * written into the profile afterwards.
 *
 * @param ctx - Host context.
 * @param credentialRef - credential reference to resolve.
 * @returns a function that cancels the pending sweep.
 */
function scheduleDailySync(ctx, credentialRef) {
  let timer = null
  let wake = null
  let cancelled = false
  const controller = new AbortController()

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
    // A sweep that is already running stops here: the signal reaches the
    // upstream requests and the sweep writes nothing afterwards.
    controller.abort()
  }

  const sweep = async () => {
    while (!cancelled) {
      await wait(SYNC_INTERVAL_MS)
      if (cancelled) return
      try {
        const result = await runSync(ctx, { credentialRef, signal: controller.signal })
        // An abort is not a failure: the plugin is gone, so the sweep stops
        // here and says nothing.
        if (controller.signal.aborted || result?.reason === ABORTED_REASON) return
        logSync(ctx, 'the daily sync', result)
      } catch (error) {
        if (controller.signal.aborted) return
        reportFailure(ctx, 'the daily sync failed', error)
      }
    }
  }

  void sweep()
  return cancel
}

/**
 * Services this plugin waits for before it activates.
 *
 * `profileContext` is declared because the plugin's bookkeeping lives in the
 * profile directory: without the service the fallbacks would swap in a
 * no-op state reader and writer, the plugin would have no memory of what it
 * added, and a model the user deleted by hand would silently come back.
 */
export const inject = ['webServer', 'credentials', 'settings', 'profileContext']

/**
 * The schema of the credential reference field.
 *
 * The field is volatile, so the settings service can edit it without
 * remounting the plugin. The shape mirrors what a schema library would
 * produce, because the settings service rebuilds the schema from `toJSON`.
 */
const CredentialRefSchema = {
  type: 'string',
  meta: { volatile: true },
  toJSON() {
    return {
      uid: '@woaicarlos/dsh-minimax.credentialRef',
      refs: {
        '@woaicarlos/dsh-minimax.credentialRef': { type: 'string', meta: { volatile: true } },
      },
    }
  },
}

/**
 * A Standard Schema for the plugin's configuration.
 *
 * The Loader validates a row's config through the schema's `~standard`
 * entry, so this bundle carries its own tiny implementation rather than a
 * schema dependency: the bundle is installed as a link into a workspace
 * directory, where a declared dependency would not resolve.
 *
 * The schema also carries the shape the settings service reads — `type`,
 * `meta`, `dict` and `toJSON` — because without them the settings service
 * finds no form for this row, and the row stays invisible in the Settings
 * UI, where `credentialRef` is edited.
 */
const Config = {
  '~standard': {
    version: 1,
    vendor: '@woaicarlos/dsh-minimax',
    validate(value) {
      const raw = value === undefined || value === null ? {} : value
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: '@woaicarlos/dsh-minimax: config must be an object' }] }
      }
      const issues = []
      const config = {}
      for (const [key, entry] of Object.entries(raw)) {
        if (key !== 'credentialRef') {
          issues.push({ message: `@woaicarlos/dsh-minimax: unknown config field "${key}"`, path: [key] })
          continue
        }
        if (typeof entry !== 'string' || entry.length === 0) {
          issues.push({ message: '@woaicarlos/dsh-minimax: credentialRef must be a non-empty string', path: [key] })
          continue
        }
        if (!CREDENTIAL_REF_PATTERN.test(entry)) {
          // The credentials service only recognises a reference that is a
          // shell identifier. A reference outside that grammar resolves to
          // nothing, so it would read as a missing credential while the key
          // itself sat in plain text in the profile patch.
          issues.push({
            message: `@woaicarlos/dsh-minimax: credentialRef "${entry}" must be a credential reference name (letters, digits and underscores, not starting with a digit)`,
            path: [key],
          })
          continue
        }
        config.credentialRef = entry
      }
      if (issues.length > 0) return { issues }
      if (config.credentialRef === undefined) config.credentialRef = DEFAULT_CREDENTIAL_REF
      return { value: config }
    },
  },
  type: 'object',
  meta: {},
  dict: { credentialRef: CredentialRefSchema },
  toJSON() {
    return {
      uid: '@woaicarlos/dsh-minimax.config',
      refs: {
        '@woaicarlos/dsh-minimax.config': {
          type: 'object',
          meta: {},
          dict: { credentialRef: '@woaicarlos/dsh-minimax.credentialRef' },
        },
        '@woaicarlos/dsh-minimax.credentialRef': { type: 'string', meta: { volatile: true } },
      },
    }
  },
}

export { Config }
