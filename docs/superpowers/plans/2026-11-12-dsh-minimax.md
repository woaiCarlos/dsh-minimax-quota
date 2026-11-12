# dsh-minimax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the published `dsh-minimax-quota` bundle into `dsh-minimax`, which keeps the quota display and additionally appends newly released MiniMax models — with their real context window, output cap and thinking levels — to the pi-ai profile's model list, without ever overwriting or removing an entry the user already has.

**Architecture:** The Host half owns every network call, because the API key lives in the Host credential store. It probes MiniMax for each newly seen model id, turns the probe result plus a built-in spec snapshot into a pi-ai model entry, and appends the entries to `providers.minimax-cn.models` through `settings.write('llm-pi-ai', …)`. The Browser half keeps its quota pill and gains a models section that lists the synced ids and shows a notice marker when models were added.

**Tech Stack:** Node.js ≥ 20.18 (ESM, `node:test` + `node:assert/strict`, zero runtime dependencies), DSH Cordis bundles, React browser half, plain YAML/JSON patch files.

**Spec:** `docs/superpowers/specs/2026-11-12-dsh-minimax-design.md`

## Global Constraints

- The bundle declares **no** runtime dependencies. It is installed as a `link:` into a workspace directory, where a declared dependency would not resolve.
- The API key **never** appears in the repository, in the browser payload, or in any log line. Only the credential *reference* `MINIMAX_CN_API_KEY` is stored.
- The browser half's module id **must** equal the package name (`dsh-minimax`). The Loader resolves the client half by package name.
- Every model entry the plugin writes **must** pass pi-ai's `modelProfile` schema: `id` (string), `name` (string), `contextWindow` (positive integer), `maxTokens` (positive integer), `input` (array of `text`/`image` only), `reasoningEfforts` (`false` or a level map whose values are valid wire spellings), `compat` (optional object).
- `compat` must be **omitted entirely** when unused — js-yaml cannot serialize an `undefined` value, and `configEditor.edit` would throw.
- The plugin never removes, reorders or changes the value of an entry that is already in the user's list, and never re-adds a model the user deleted by hand. The entries the user wrote are taken from the **raw profile override**, not from the schema-resolved projection, so a materialised default never changes their wording; the route's schema defaults are materialised into the patch by the write, and the README says so.
- The plugin never writes an API key into the profile patch. The profile patch only ever gains model ids and metadata.
- All model ids, specs and probe results quoted in this plan were measured against the live MiniMax API on 2026-11-12 and are reproduced in `lib/specs.js` and `test/` fixtures.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/credentials.js` | Resolve a credential reference into a secret. The only place a secret is ever read. |
| `lib/quota.js` | MiniMax coding-plan endpoint list, response parsing, and the quota fetch. |
| `lib/specs.js` | Built-in snapshot of MiniMax model specifications (context window, modalities, output limit, reasoning options). Pure data. |
| `lib/probe.js` | Talk to the Anthropic-compatible MiniMax endpoint: list model ids, read the output cap out of a refusal, detect thinking. |
| `lib/model-entry.js` | Turn a probe result plus a spec into one pi-ai model entry. |
| `lib/merge.js` | Decide which entries to append. Pure; never removes. |
| `lib/state.js` | Persist the set of model ids the plugin has added, so a hand-deleted model is not re-added, and the ids MiniMax has retired, so a retired model is probed once and then left alone. |
| `index.js` | Host half: routes, the sync orchestration, the config schema. |
| `client.js` | Browser half: quota pill, details panel, models section, notice marker. |
| `test/*.test.js` | One test file per `lib/` module, plus `test/sync.test.js` for the Host wiring and `test/client.test.js` for the Browser half, run by `node --test`. |

**Splitting `index.js`:** the current file mixes quota parsing with route wiring. The quota parsing moves to `lib/quota.js` and every new responsibility gets its own module, so each is testable without a Host context. `index.js` keeps only what needs a live context.

---

## Task 1: Test harness and the extracted quota module

The bundle has no test runner yet (`npm test` only syntax-checks). This task establishes `node --test` and moves the quota logic into its own module so it can be tested. `node:test` is built into Node ≥ 20, so the bundle still ships with zero dependencies.

**Files:**
- Create: `lib/credentials.js`
- Create: `lib/quota.js`
- Create: `test/quota.test.js`
- Create: `test/credentials.test.js`
- Modify: `index.js` (delete the moved code, import from `lib/`)
- Modify: `package.json` (`scripts.test`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `lib/credentials.js` → `resolveApiKey(ctx, ref): Promise<string | undefined>`
  - `lib/quota.js` → `QUOTA_ENDPOINTS: string[]`, `REQUEST_TIMEOUT_MS: number`, `selectPlanEntry(body): object | undefined`, `toQuotaView(entry): object`, `fetchQuota(ctx, ref, signal, fetchImpl = fetch): Promise<object>`

- [ ] **Step 1: Write the failing test for quota parsing**

Create `test/quota.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPlanEntry, toQuotaView } from '../lib/quota.js'

test('selectPlanEntry prefers the general coding-plan bucket', () => {
  const body = {
    model_remains: [
      { model_name: 'video', current_interval_remaining_percent: 10 },
      { model_name: 'general', current_interval_remaining_percent: 82 },
    ],
  }
  assert.equal(selectPlanEntry(body)?.model_name, 'general')
})

test('selectPlanEntry falls back to the first bucket carrying a percentage', () => {
  const body = { model_remains: [{ model_name: 'other', current_interval_remaining_percent: 55 }] }
  assert.equal(selectPlanEntry(body)?.model_name, 'other')
})

test('selectPlanEntry answers undefined when no bucket carries a plan', () => {
  assert.equal(selectPlanEntry({ model_remains: [] }), undefined)
  assert.equal(selectPlanEntry({}), undefined)
  assert.equal(selectPlanEntry(undefined), undefined)
})

test('toQuotaView reports both windows as remaining percentages', () => {
  const view = toQuotaView({
    current_interval_remaining_percent: 82,
    current_weekly_remaining_percent: 35,
    end_time: 1760000000000,
    weekly_end_time: 1760500000000,
    current_interval_status: 1,
    current_weekly_status: 1,
  })
  assert.equal(view.intervalRemainingPercent, 82)
  assert.equal(view.weeklyRemainingPercent, 35)
  assert.equal(view.intervalResetAt, 1760000000000)
  assert.equal(view.weeklyResetAt, 1760500000000)
})

test('toQuotaView hides a window that carries no limit', () => {
  const view = toQuotaView({
    current_interval_remaining_percent: 100,
    current_weekly_remaining_percent: 100,
    current_interval_status: 3,
    current_weekly_status: 3,
  })
  assert.equal(view.intervalRemainingPercent, null)
  assert.equal(view.weeklyRemainingPercent, null)
})
```

- [ ] **Step 2: Write the failing test for the quota fetch**

Append to `test/quota.test.js`:

```js
import { fetchQuota } from '../lib/quota.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ctxWithKey(key) {
  return {
    get(name) {
      if (name === 'credentials') return { resolve: async () => ({ value: key }) }
      return undefined
    },
  }
}

test('fetchQuota answers the plan remainder', async () => {
  const fetchImpl = async () => jsonResponse({
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: 'general',
      current_interval_remaining_percent: 82,
      current_weekly_remaining_percent: 35,
      end_time: 1760000000000,
      weekly_end_time: 1760500000000,
      current_interval_status: 1,
      current_weekly_status: 1,
    }],
  })
  const view = await fetchQuota(ctxWithKey('sk-test'), 'MINIMAX_CN_API_KEY', undefined, fetchImpl)
  assert.equal(view.ok, true)
  assert.equal(view.intervalRemainingPercent, 82)
  assert.equal(view.weeklyRemainingPercent, 35)
})

test('fetchQuota reports a refused key even though the endpoint answers 200', async () => {
  const fetchImpl = async () => jsonResponse({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } })
  const view = await fetchQuota(ctxWithKey('sk-test'), 'MINIMAX_CN_API_KEY', undefined, fetchImpl)
  assert.equal(view.ok, false)
  assert.equal(view.reason, 'request-failed')
  assert.match(view.message, /invalid api key/)
})

test('fetchQuota reports a missing credential without calling the network', async () => {
  let called = false
  const fetchImpl = async () => { called = true; return jsonResponse({}) }
  const view = await fetchQuota(ctxWithKey(undefined), 'MINIMAX_CN_API_KEY', undefined, fetchImpl)
  assert.equal(view.ok, false)
  assert.equal(view.reason, 'missing-credential')
  assert.equal(called, false)
})

test('fetchQuota reports an account without a coding plan', async () => {
  const fetchImpl = async () => jsonResponse({ base_resp: { status_code: 0 }, model_remains: [] })
  const view = await fetchQuota(ctxWithKey('sk-test'), 'MINIMAX_CN_API_KEY', undefined, fetchImpl)
  assert.equal(view.ok, false)
  assert.equal(view.reason, 'no-plan')
})
```

- [ ] **Step 3: Write the failing test for credential resolution**

Create `test/credentials.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveApiKey } from '../lib/credentials.js'

test('resolveApiKey returns the resolved secret', async () => {
  const ctx = { get: () => ({ resolve: async () => ({ value: 'sk-secret' }) }) }
  assert.equal(await resolveApiKey(ctx, 'MINIMAX_CN_API_KEY'), 'sk-secret')
})

test('resolveApiKey answers undefined when the credential is absent', async () => {
  const ctx = { get: () => ({ resolve: async () => undefined }) }
  assert.equal(await resolveApiKey(ctx, 'MINIMAX_CN_API_KEY'), undefined)
})

test('resolveApiKey answers undefined when the credential service is absent', async () => {
  const ctx = { get: () => undefined }
  assert.equal(await resolveApiKey(ctx, 'MINIMAX_CN_API_KEY'), undefined)
})

test('resolveApiKey answers undefined for an empty secret', async () => {
  const ctx = { get: () => ({ resolve: async () => ({ value: '' }) }) }
  assert.equal(await resolveApiKey(ctx, 'MINIMAX_CN_API_KEY'), undefined)
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test test/`
Expected: FAIL with `Cannot find module '../lib/quota.js'`

- [ ] **Step 5: Write `lib/credentials.js`**

```js
/**
 * Reading the MiniMax secret out of the Host credential store.
 *
 * The credential reference is the only thing that ever appears in
 * configuration. The secret itself stays in the Host and is handed to
 * `fetch` as a header, never returned to the browser and never logged.
 */

/**
 * Read the credential a MiniMax route authenticates with.
 *
 * @param ctx - Host context carrying the credential seam.
 * @param ref - credential reference to resolve.
 * @returns the secret, or undefined when the reference resolves to nothing.
 */
export async function resolveApiKey(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const hit = await credentials.resolve(ref)
  const value = hit?.value
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
```

- [ ] **Step 6: Write `lib/quota.js`**

```js
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
```

- [ ] **Step 7: Point `index.js` at the extracted module**

In `index.js`, delete the `QUOTA_ENDPOINTS`, `REQUEST_TIMEOUT_MS`, `resolveApiKey`, `selectPlanEntry`, `toQuotaView` and `fetchQuota` declarations (lines 9–138 in the current file), and add at the top:

```js
import { fetchQuota } from './lib/quota.js'
```

Keep `ROUTE_PATH` and `DEFAULT_CREDENTIAL_REF` in `index.js` — they are Host wiring.

- [ ] **Step 8: Wire the test script**

In `package.json`, replace the `scripts` block:

```json
  "scripts": {
    "test": "node --test test/ && node --check index.js && node --check client.js"
  },
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 13 tests across `test/quota.test.js` (9) and `test/credentials.test.js` (4), plus the two syntax checks.

- [ ] **Step 10: Commit**

```bash
git add lib/credentials.js lib/quota.js test/quota.test.js test/credentials.test.js index.js package.json
git commit -m "test: extract the quota module and add a node:test harness

The bundle shipped no test runner, so the quota parsing could not be
exercised. node:test is built into Node 20, which keeps the bundle at
zero runtime dependencies."
```

---

## Task 2: The built-in model specification snapshot

`lib/specs.js` holds the two parameters MiniMax's API does not serve (context window, input modalities) plus the reasoning options that state which models expose effort levels. The values come from models.dev's `minimax-cn` provider, cross-checked against the live API on 2026-11-12.

**Files:**
- Create: `lib/specs.js`
- Create: `test/specs.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `lib/specs.js` → `MODEL_SPECS: Record<string, object>`, `FALLBACK_SPEC: object`, `lookupSpec(modelId): object`, `SUPPORTED_MODALITIES: string[]`
  - A spec object is `{ contextWindow: number, outputLimit: number, modalities: string[], reasoningOptions: { type: 'effort' | 'toggle'; values?: string[] } | null }`

- [ ] **Step 1: Write the failing test**

Create `test/specs.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_SPEC, MODEL_SPECS, SUPPORTED_MODALITIES, lookupSpec } from '../lib/specs.js'

test('every known model carries a usable specification', () => {
  for (const [id, spec] of Object.entries(MODEL_SPECS)) {
    assert.ok(Number.isInteger(spec.contextWindow) && spec.contextWindow > 0, `${id} contextWindow`)
    assert.ok(Number.isInteger(spec.outputLimit) && spec.outputLimit > 0, `${id} outputLimit`)
    assert.ok(Array.isArray(spec.modalities) && spec.modalities.length > 0, `${id} modalities`)
  }
})

test('only modalities pi-ai accepts are recorded', () => {
  for (const [id, spec] of Object.entries(MODEL_SPECS)) {
    for (const modality of spec.modalities) {
      assert.ok(SUPPORTED_MODALITIES.includes(modality), `${id} declares ${modality}`)
    }
  }
})

test('only MiniMax-M3.1-Flash is recorded as offering effort levels', () => {
  const effort = Object.entries(MODEL_SPECS)
    .filter(([, spec]) => spec.reasoningOptions?.type === 'effort')
    .map(([id]) => id)
  assert.deepEqual(effort, ['MiniMax-M3.1-Flash'])
})

test('the M3 series carries the one-million-token window', () => {
  assert.equal(lookupSpec('MiniMax-M3').contextWindow, 1000000)
  assert.equal(lookupSpec('MiniMax-M3.1-Flash').contextWindow, 1000000)
  assert.equal(lookupSpec('MiniMax-M2.7').contextWindow, 204800)
})

test('the M3 series accepts images and the M2 series does not', () => {
  assert.deepEqual(lookupSpec('MiniMax-M3').modalities, ['text', 'image'])
  assert.deepEqual(lookupSpec('MiniMax-M2.7').modalities, ['text'])
})

test('an unknown model falls back to a conservative specification', () => {
  const spec = lookupSpec('MiniMax-M9-Ultra')
  assert.equal(spec, FALLBACK_SPEC)
  assert.equal(spec.contextWindow, 1000000)
  assert.deepEqual(spec.modalities, ['text'])
  assert.equal(spec.reasoningOptions, null)
})

test('the recorded output caps are the ones MiniMax reports', () => {
  assert.equal(MODEL_SPECS['MiniMax-M3'].outputLimit, 524288)
  assert.equal(MODEL_SPECS['MiniMax-M3.1-Flash'].outputLimit, 524288)
  assert.equal(MODEL_SPECS['MiniMax-M2.7'].outputLimit, 131072)
  assert.equal(FALLBACK_SPEC.outputLimit, 131072)
})

test('the recorded context windows are the ones MiniMax enforces', () => {
  assert.equal(MODEL_SPECS['MiniMax-M3'].contextWindow, 1000000)
  assert.equal(MODEL_SPECS['MiniMax-M3.1-Flash'].contextWindow, 1000000)
  assert.equal(MODEL_SPECS['MiniMax-M2.7'].contextWindow, 204800)
  assert.equal(MODEL_SPECS['MiniMax-M2.5-highspeed'].contextWindow, 204800)
  assert.equal(FALLBACK_SPEC.contextWindow, 1000000)
})

test('every entry declares a known reasoning shape', () => {
  for (const [id, spec] of Object.entries(MODEL_SPECS)) {
    const options = spec.reasoningOptions
    if (options === null) continue
    assert.ok(['effort', 'toggle'].includes(options.type), `${id} reasoning type`)
    if (options.type === 'effort') {
      assert.ok(Array.isArray(options.values) && options.values.length > 0, `${id} effort values`)
    } else {
      assert.equal(options.values, undefined, `${id} toggle carries no values`)
    }
  }
})

test('the effort levels are the five spellings pi-ai accepts', () => {
  assert.deepEqual(
    MODEL_SPECS['MiniMax-M3.1-Flash'].reasoningOptions.values,
    ['low', 'medium', 'high', 'xhigh', 'max'],
  )
})

test('a name inherited from the prototype chain does not resolve to a prototype', () => {
  assert.equal(lookupSpec('toString'), FALLBACK_SPEC)
  assert.equal(lookupSpec('__proto__'), FALLBACK_SPEC)
  assert.equal(lookupSpec('constructor'), FALLBACK_SPEC)
})

test('the snapshot is frozen all the way down', () => {
  assert.throws(() => MODEL_SPECS['MiniMax-M3'].modalities.push('video'), TypeError)
  assert.throws(() => { MODEL_SPECS['MiniMax-M3'].contextWindow = 1 }, TypeError)
  assert.throws(() => FALLBACK_SPEC.modalities.push('video'), TypeError)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/specs.test.js`
Expected: FAIL with `Cannot find module '../lib/specs.js'`

- [ ] **Step 3: Write `lib/specs.js`**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/specs.test.js`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/specs.js test/specs.test.js
git commit -m "feat: add the built-in MiniMax model specification snapshot

MiniMax's API serves model ids, the exact output cap and liveness, but
not the context window or the input modalities. The snapshot mirrors
models.dev's minimax-cn provider; its context windows agree with the
boundary where the live API starts refusing oversized requests."
```

---

## Task 3: Probing MiniMax for liveness, output cap and thinking

**Files:**
- Create: `lib/probe.js`
- Create: `test/probe.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `lib/probe.js` →
    - `MESSAGES_URL: string`
    - `MODELS_URL: string`
    - `OVER_LIMIT_MAX_TOKENS: number`
    - `THINKING_PROMPT: string`
    - `PROBE_TIMEOUT_MS: number`
    - `THINKING_SAMPLES: number`
    - `parseMaxTokensLimit(message): number | undefined`
    - `isRetired(message): boolean`
    - `postMessage(body, apiKey, options): Promise<{ status: number, payload: object | undefined, message: string }>`
    - `fetchModelIds(apiKey, options): Promise<string[] | null>`
    - `probeModel(modelId, apiKey, options): Promise<{ status: 'ok' | 'retired' | 'failed', modelId: string, maxTokens?: number, supportsThinking?: boolean, reason?: string }>`
  - `options` is `{ signal?: AbortSignal, fetchImpl?: typeof fetch }`

- [ ] **Step 1: Write the failing test**

Create `test/probe.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OVER_LIMIT_MAX_TOKENS,
  THINKING_SAMPLES,
  fetchModelIds,
  isRetired,
  parseMaxTokensLimit,
  postMessage,
  probeModel,
} from '../lib/probe.js'

function jsonResponse(body, status = 400) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('parseMaxTokensLimit reads the cap out of the refusal', () => {
  const message = 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)'
  assert.equal(parseMaxTokensLimit(message), 196608)
})

test('parseMaxTokensLimit answers undefined for an unrelated refusal', () => {
  assert.equal(parseMaxTokensLimit('invalid params, context window exceeds limit (2013)'), undefined)
  assert.equal(parseMaxTokensLimit(''), undefined)
})

test('isRetired recognizes the retired-model refusal', () => {
  assert.equal(isRetired('The model "MiniMax-M2" is no longer available. (2069)'), true)
  assert.equal(isRetired('invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)'), false)
})

test('fetchModelIds lists every candidate id', async () => {
  const fetchImpl = async () => jsonResponse({
    object: 'list',
    data: [{ id: 'MiniMax-M3.1-Flash' }, { id: 'MiniMax-M2' }],
  }, 200)
  assert.deepEqual(await fetchModelIds('sk-test', { fetchImpl }), ['MiniMax-M3.1-Flash', 'MiniMax-M2'])
})

test('fetchModelIds answers an empty list when the account carries no models', async () => {
  const fetchImpl = async () => jsonResponse({ object: 'list', data: [] }, 200)
  assert.deepEqual(await fetchModelIds('sk-test', { fetchImpl }), [])
})

test('fetchModelIds answers null when the list cannot be read', async () => {
  const refused = await fetchModelIds('sk-test', {
    fetchImpl: async () => jsonResponse({ error: { message: 'invalid api key' } }, 401),
  })
  assert.equal(refused, null)
  const broken = await fetchModelIds('sk-test', {
    fetchImpl: async () => { throw new Error('fetch failed') },
  })
  assert.equal(broken, null)
})

test('probeModel reads the output cap from a refusal without generating', async () => {
  const bodies = []
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)' },
      })
    }
    return jsonResponse({ content: [{ type: 'text', text: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M2.7', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.maxTokens, 196608)
  assert.equal(bodies[0].max_tokens, OVER_LIMIT_MAX_TOKENS)
})

test('probeModel reports a failed probe when the cap cannot be read', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'invalid api key' } }, 401)
  const result = await probeModel('MiniMax-M3', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'failed')
  assert.equal(result.maxTokens, undefined)
})

test('probeModel reports a retired model that says so right away', async () => {
  const fetchImpl = async () => jsonResponse({
    error: { message: 'The model "MiniMax-M2" is no longer available. (2069)' },
  })
  const result = await probeModel('MiniMax-M2', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'retired')
  assert.equal(result.modelId, 'MiniMax-M2')
})

test('probeModel reports a retired model whose cap request still answers', async () => {
  let calls = 0
  const fetchImpl = async (_url, init) => {
    calls += 1
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      // MiniMax validates max_tokens before it checks whether the model still
      // exists, so the cap request answers even for a retired model.
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2] does not support max tokens > 196608 (2013)' },
      })
    }
    return jsonResponse({
      error: { message: 'The model "MiniMax-M2" is no longer available. (2069)' },
    })
  }
  const result = await probeModel('MiniMax-M2', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'retired')
  assert.equal(result.modelId, 'MiniMax-M2')
  assert.equal(calls, 2)
})

test('probeModel detects a model that thinks', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M3.1-Flash] does not support max tokens > 524288 (2013)' },
      })
    }
    return jsonResponse({
      content: [{ type: 'thinking', thinking: '17 times 23 is 391.' }, { type: 'text', text: '391' }],
    }, 200)
  }
  const result = await probeModel('MiniMax-M3.1-Flash', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.maxTokens, 524288)
  assert.equal(result.supportsThinking, true)
})

test('probeModel detects a model that does not think', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)' },
      })
    }
    return jsonResponse({ content: [{ type: 'text', text: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M2.7', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.supportsThinking, false)
})

test('probeModel asks again when one answer came without a thinking block', async () => {
  let attempts = 0
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)' },
      })
    }
    attempts += 1
    // The first answer comes without a thinking block, the second with one.
    if (attempts === 1) return jsonResponse({ content: [{ type: 'text', text: '391' }] }, 200)
    return jsonResponse({ content: [{ type: 'thinking', thinking: '391' }, { type: 'text', text: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M2.7', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.supportsThinking, true)
  assert.equal(attempts, 2)
})

test('probeModel counts a model that never thinks after every sample', async () => {
  let attempts = 0
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)' },
      })
    }
    attempts += 1
    return jsonResponse({ content: [{ type: 'text', text: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M2.7', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.supportsThinking, false)
  assert.equal(attempts, THINKING_SAMPLES)
})

test('probeModel reports a failed probe when the cap fails but the thinking request answers', async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({ error: { message: 'rate limited' } }, 429)
    }
    return jsonResponse({ content: [{ type: 'text', text: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M3', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'failed')
  assert.equal(result.maxTokens, undefined)
})

test('probeModel reports a model that refuses the thinking field as not thinking', async () => {
  const bodies = []
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)' },
      })
    }
    if (body.thinking !== undefined) {
      return jsonResponse({ error: { message: 'invalid params, thinking is not supported by this model' } })
    }
    return jsonResponse({ content: [{ type: 'text', text: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M2.7', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'ok')
  assert.equal(result.maxTokens, 196608)
  assert.equal(result.supportsThinking, false)
  assert.equal(bodies.length, 3)
})

test('probeModel reports a failed probe when the model answers nothing usable', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'internal error' } })
  const result = await probeModel('MiniMax-M3', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'failed')
})

test('every request carries a signal and the key travels only in a header', async () => {
  const seen = []
  const fetchImpl = async (_url, init) => {
    seen.push(init)
    return jsonResponse({ object: 'list', data: [] }, 200)
  }
  await fetchModelIds('sk-secret', { fetchImpl })
  assert.equal(seen.length, 1)
  assert.ok(seen[0].signal instanceof AbortSignal)
  assert.equal(seen[0].headers.authorization, 'Bearer sk-secret')
  assert.equal(String(seen[0].body ?? '').includes('sk-secret'), false)
})

test('the request that carries the key carries a signal and never returns it', async () => {
  const seen = []
  const fetchImpl = async (_url, init) => {
    seen.push(init)
    const body = JSON.parse(init.body)
    if (body.max_tokens === OVER_LIMIT_MAX_TOKENS) {
      return jsonResponse({
        error: { message: 'invalid params, model[MiniMax-M3] does not support max tokens > 524288 (2013)' },
      })
    }
    return jsonResponse({ content: [{ type: 'thinking', thinking: '391' }] }, 200)
  }
  const result = await probeModel('MiniMax-M3', 'sk-secret', { fetchImpl })
  assert.equal(seen.length >= 1, true)
  for (const request of seen) {
    assert.ok(request.signal instanceof AbortSignal)
    assert.equal(request.headers['x-api-key'], 'sk-secret')
  }
  assert.equal(JSON.stringify(result).includes('sk-secret'), false)
})

test('postMessage reports a network failure', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed') }
  const result = await postMessage({ model: 'x' }, 'sk-test', { fetchImpl })
  assert.equal(result.status, 0)
  assert.equal(result.message, 'fetch failed')
  assert.equal(result.payload, undefined)
})

test('postMessage reports an unparsable body', async () => {
  const fetchImpl = async () => new Response('not json', { status: 200 })
  const result = await postMessage({ model: 'x' }, 'sk-test', { fetchImpl })
  assert.equal(result.status, 200)
  assert.equal(result.message, 'HTTP 200')
  assert.equal(result.payload, undefined)
})

test('postMessage reports an empty message when the payload carries no error', async () => {
  const fetchImpl = async () => jsonResponse({ content: [] }, 200)
  const result = await postMessage({ model: 'x' }, 'sk-test', { fetchImpl })
  assert.equal(result.status, 200)
  assert.equal(result.message, '')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/probe.test.js`
Expected: FAIL with `Cannot find module '../lib/probe.js'`

- [ ] **Step 3: Write `lib/probe.js`**

```js
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
 * How many times the thinking request may be asked before the model counts
 * as not thinking.
 *
 * MiniMax decides for itself whether a request is worth thinking about, so
 * one answer without a thinking block is not a verdict. Measured over six
 * requests, MiniMax-M2.7 thought five times and the other live models six
 * times, so a single sample denies thinking to roughly one model in six.
 */
export const THINKING_SAMPLES = 3

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
  for (let attempt = 0; attempt < THINKING_SAMPLES; attempt++) {
    const thinking = await postMessage({
      model: modelId,
      max_tokens: thinkingTokens,
      messages: [{ role: 'user', content: THINKING_PROMPT }],
      thinking: { type: 'enabled', budget_tokens: Math.min(4096, thinkingTokens) },
    }, apiKey, { signal, fetchImpl })
    const thinkingMessage = thinking.message
    // MiniMax validates `max_tokens` before it checks whether the model still
    // exists, so a retired model answers the cap request with a cap and only
    // says it is gone on this request.
    if (isRetired(thinkingMessage)) return { status: 'retired', modelId }
    const blocks = Array.isArray(thinking.payload?.content) ? thinking.payload.content : undefined
    if (blocks !== undefined) {
      if (blocks.some((block) => block?.type === 'thinking')) {
        return { status: 'ok', modelId, maxTokens, supportsThinking: true }
      }
      // The model answered without thinking. MiniMax decides for itself
      // whether a request is worth thinking about, so one such answer is not
      // a verdict — ask again.
      continue
    }
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
      return { status: 'failed', modelId, reason: plain.message || `HTTP ${plain.status}` }
    }
    return { status: 'ok', modelId, maxTokens, supportsThinking: false }
  }
  // Three answers, none of which thought. The model does not think.
  return { status: 'ok', modelId, maxTokens, supportsThinking: false }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/probe.test.js`
Expected: PASS — 22 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/probe.js test/probe.test.js
git commit -m "feat: probe MiniMax for liveness, output cap and thinking

GET /v1/models lists models the account can no longer call, so every
candidate is probed before it may be written. The exact output cap comes
out of the refusal of an over-limit request, which is rejected before
generation and therefore costs nothing.

The thinking probe has to use a prompt that demands reasoning: a prompt
like hi yields a false negative for every model, because there is
nothing to think about. And because MiniMax decides for itself whether a
request is worth thinking about, one answer without a thinking block is
not a verdict — the probe asks again, up to THINKING_SAMPLES times."
```

## Task 4: Turning a probe result into a pi-ai model entry

**Files:**
- Create: `lib/model-entry.js`
- Create: `test/model-entry.test.js`

**Interfaces:**
- Consumes: `lookupSpec(modelId)` from `lib/specs.js`.
- Produces: `buildModelEntry(modelId, probe, spec?): object` — a pi-ai `modelProfile`; `FALLBACK_EFFORT_LEVELS: string[]`

- [ ] **Step 1: Write the failing test**

Create `test/model-entry.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_EFFORT_LEVELS, buildModelEntry } from '../lib/model-entry.js'
import { lookupSpec } from '../lib/specs.js'

test('a thinking model declares the effort levels and adaptive thinking', () => {
  const entry = buildModelEntry('MiniMax-M3.1-Flash', { maxTokens: 524288, supportsThinking: true })
  assert.equal(entry.id, 'MiniMax-M3.1-Flash')
  assert.equal(entry.name, 'MiniMax-M3.1-Flash')
  assert.equal(entry.contextWindow, 1000000)
  assert.equal(entry.maxTokens, 524288)
  assert.deepEqual(entry.input, ['text', 'image'])
  assert.deepEqual(entry.reasoningEfforts, {
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })
  assert.deepEqual(entry.compat, { forceAdaptiveThinking: true })
})

test('a thinking model without adaptive efforts omits the compat block', () => {
  const entry = buildModelEntry('MiniMax-M3', { maxTokens: 524288, supportsThinking: true })
  assert.deepEqual(entry.reasoningEfforts, {
    low: 'low', medium: 'medium', high: 'high',
  })
  assert.equal('compat' in entry, false)
})

test('a model that records its own effort levels uses those', () => {
  const entry = buildModelEntry('MiniMax-M3.1-Flash', { maxTokens: 524288, supportsThinking: true }, {
    contextWindow: 1000000,
    outputLimit: 524288,
    modalities: ['text', 'image'],
    reasoningOptions: { type: 'effort', values: ['low', 'high'] },
  })
  assert.deepEqual(entry.reasoningEfforts, { low: 'low', high: 'high' })
})

test('an entry only carries modalities pi-ai accepts', () => {
  const entry = buildModelEntry('MiniMax-M9-Ultra', { maxTokens: 4096, supportsThinking: false }, {
    contextWindow: 1000000,
    outputLimit: 131072,
    modalities: ['text', 'image', 'video'],
    reasoningOptions: null,
  })
  assert.deepEqual(entry.input, ['text', 'image'])
})

test('a budget-mode model offers only the levels budget mode can tell apart', () => {
  const entry = buildModelEntry('MiniMax-M3', { maxTokens: 524288, supportsThinking: true }, {
    contextWindow: 1000000,
    outputLimit: 524288,
    modalities: ['text', 'image'],
    reasoningOptions: { type: 'toggle' },
  })
  assert.deepEqual(Object.keys(entry.reasoningEfforts), ['low', 'medium', 'high'])
  assert.equal(entry.compat, undefined)
})

test('an adaptive model keeps the levels its snapshot records', () => {
  const entry = buildModelEntry('MiniMax-M3.1-Flash', { maxTokens: 524288, supportsThinking: true }, {
    contextWindow: 1000000,
    outputLimit: 524288,
    modalities: ['text', 'image'],
    reasoningOptions: { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
  })
  assert.deepEqual(Object.keys(entry.reasoningEfforts), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(entry.compat, { forceAdaptiveThinking: true })
})

test('a degenerate measured cap falls back to the snapshot', () => {
  const entry = buildModelEntry('MiniMax-M3', { maxTokens: 0, supportsThinking: false }, {
    contextWindow: 1000000,
    outputLimit: 524288,
    modalities: ['text', 'image'],
    reasoningOptions: { type: 'toggle' },
  })
  assert.equal(entry.maxTokens, 524288)
})

test('the fallback levels are the ones budget mode distinguishes', () => {
  assert.deepEqual(FALLBACK_EFFORT_LEVELS, ['low', 'medium', 'high'])
})

test('a model that does not think turns reasoning off', () => {
  const entry = buildModelEntry('MiniMax-M2.7', { maxTokens: 196608, supportsThinking: false })
  assert.equal(entry.reasoningEfforts, false)
  assert.equal('compat' in entry, false)
})

test('the compat key is absent rather than undefined', () => {
  const entry = buildModelEntry('MiniMax-M2.7', { maxTokens: 196608, supportsThinking: false })
  assert.equal(Object.hasOwn(entry, 'compat'), false)
})

test('the probed cap wins over the snapshot', () => {
  const entry = buildModelEntry('MiniMax-M2.7', { maxTokens: 196608, supportsThinking: true })
  assert.equal(entry.maxTokens, 196608)
})

test('the snapshot cap is used when the probe found none', () => {
  const entry = buildModelEntry('MiniMax-M2.7', { maxTokens: undefined, supportsThinking: true })
  assert.equal(entry.maxTokens, lookupSpec('MiniMax-M2.7').outputLimit)
})

test('an unknown model still yields a valid entry', () => {
  const entry = buildModelEntry('MiniMax-M9-Ultra', { maxTokens: 4096, supportsThinking: false })
  assert.equal(entry.id, 'MiniMax-M9-Ultra')
  assert.equal(entry.contextWindow, 1000000)
  assert.deepEqual(entry.input, ['text'])
  assert.equal(entry.reasoningEfforts, false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/model-entry.test.js`
Expected: FAIL with `Cannot find module '../lib/model-entry.js'`

- [ ] **Step 3: Write `lib/model-entry.js`**

```js
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
```

- [ ] **Step 4: Freeze the modality list this task now depends on**

This task is the first production consumer of `lib/specs.js`, and it filters an entry's
modalities through `SUPPORTED_MODALITIES` — the exported list that decides what an entry
may carry. A mutable export gating a production filter is the same hazard the Task 2
review found in the snapshot itself, so freeze it:

```js
export const SUPPORTED_MODALITIES = Object.freeze(['text', 'image'])
```

Add a case to `test/specs.test.js`:

```js
test('the modality list cannot be mutated', () => {
  assert.throws(() => SUPPORTED_MODALITIES.push('video'), TypeError)
})
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/model-entry.test.js`
Expected: PASS — 14 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/model-entry.js test/model-entry.test.js lib/specs.js test/specs.test.js
git commit -m "feat: build pi-ai model entries from a probe result

The compat block is omitted entirely rather than set to undefined:
js-yaml cannot serialize undefined, and the profile patch write would
throw. Only a model that needs adaptive thinking carries it."
```

---

## Task 5: The append-only merge

This module holds the promise that the plugin never overwrites and never removes. It is pure, so the promise is testable without a Host.

**Files:**
- Create: `lib/merge.js`
- Create: `test/merge.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `planAppend({ currentModels, addedModels, candidateIds, entries }): { models: object[], addedIds: string[], changed: boolean }`

- [ ] **Step 1: Write the failing test**

Create `test/merge.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planAppend } from '../lib/merge.js'

const EXISTING = [
  { id: 'MiniMax-M3', name: 'MiniMax-M3-1M', contextWindow: 1000000, maxTokens: 512000, input: ['text', 'image'] },
  { id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', contextWindow: 1000000, maxTokens: 512000, input: ['text', 'image'] },
]

const NEW_ENTRY = {
  id: 'MiniMax-M3.2',
  name: 'MiniMax-M3.2',
  contextWindow: 1000000,
  maxTokens: 524288,
  input: ['text', 'image'],
  reasoningEfforts: false,
}

const DELETED_ENTRY = {
  id: 'MiniMax-M3.1-Flash',
  name: 'MiniMax-M3.1-Flash',
  contextWindow: 1000000,
  maxTokens: 524288,
  input: ['text', 'image'],
  reasoningEfforts: false,
}

test('a new model is appended after the existing ones', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M3.2'],
    entries: new Map([['MiniMax-M3.2', NEW_ENTRY]]),
  })
  assert.equal(plan.changed, true)
  assert.deepEqual(plan.addedIds, ['MiniMax-M3.2'])
  assert.equal(plan.models.length, 3)
  assert.deepEqual(plan.models.slice(0, 2), EXISTING)
  assert.equal(plan.models[2].id, 'MiniMax-M3.2')
})

test('the existing entries are never modified', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M3.2'],
    entries: new Map([['MiniMax-M3.2', NEW_ENTRY]]),
  })
  assert.equal(plan.models[0], EXISTING[0])
  assert.equal(plan.models[1], EXISTING[1])
  assert.equal(plan.models[0].maxTokens, 512000)
  assert.equal(plan.models[0].name, 'MiniMax-M3-1M')
})

test('nothing changes when there is no new model', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M3', 'MiniMax-M3.1-Flash'],
    entries: new Map(),
  })
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.addedIds, [])
  assert.deepEqual(plan.models, EXISTING)
})

test('a model the user already listed is not added twice and is never replaced', () => {
  const rebuilt = { id: 'MiniMax-M3', name: 'rebuilt', contextWindow: 8, maxTokens: 8 }
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M3'],
    entries: new Map([['MiniMax-M3', rebuilt]]),
  })
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.addedIds, [])
  assert.equal(plan.models.length, 2)
  assert.equal(plan.models[0], EXISTING[0])
  assert.equal(plan.models[0].name, 'MiniMax-M3-1M')
  assert.equal(plan.models[0].contextWindow, 1000000)
  assert.equal(plan.models[0].maxTokens, 512000)
})

test('a model the user deleted by hand is not added back', () => {
  const plan = planAppend({
    // The user deleted it, so it is no longer in the profile. The only thing
    // that can keep it out is the plugin's own record of having added it.
    currentModels: [EXISTING[0]],
    addedModels: ['MiniMax-M3.1-Flash'],
    candidateIds: ['MiniMax-M3.1-Flash'],
    entries: new Map([['MiniMax-M3.1-Flash', DELETED_ENTRY]]),
  })
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.addedIds, [])
  assert.equal(plan.models.length, 1)
  assert.equal(plan.models[0].id, 'MiniMax-M3')
})

test('a candidate without a probe result is skipped', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M2', 'MiniMax-M3.2'],
    entries: new Map([['MiniMax-M3.2', NEW_ENTRY]]),
  })
  assert.deepEqual(plan.addedIds, ['MiniMax-M3.2'])
})

test('a candidate whose probe failed is not added', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M2', 'MiniMax-M3.2'],
    entries: new Map([['MiniMax-M3.2', NEW_ENTRY], ['MiniMax-M2', null]]),
  })
  assert.deepEqual(plan.addedIds, ['MiniMax-M3.2'])
  assert.equal(plan.models.length, 3)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/merge.test.js`
Expected: FAIL with `Cannot find module '../lib/merge.js'`

- [ ] **Step 3: Write `lib/merge.js`**

```js
/**
 * Deciding which model entries to append.
 *
 * The plugin's promise is that it never touches an entry the user already
 * has: it appends and it stops. A model the user removed by hand stays
 * removed, because the ids the plugin added are remembered.
 */

/**
 * Plan the append.
 *
 * @param currentModels - the entries already in the profile.
 * @param addedModels - the ids the plugin has added before.
 * @param candidateIds - the model ids MiniMax reports.
 * @param entries - the built entries, keyed by model id. A candidate whose
 *   entry is missing or null was not built and is not appended.
 * @returns `{ models, addedIds, changed }`.
 */
export function planAppend({ currentModels = [], addedModels = [], candidateIds = [], entries = new Map() }) {
  // A malformed entry without an id names nothing, so it cannot occupy a
  // candidate's place.
  const listed = new Set(currentModels.map((entry) => entry?.id).filter((id) => typeof id === 'string'))
  const added = new Set(addedModels)
  const models = [...currentModels]
  const addedIds = []
  for (const id of candidateIds) {
    if (listed.has(id) || added.has(id)) continue
    const entry = entries.get(id)
    // A candidate without a built entry was never measured, and a null one
    // carries no model; neither may be appended.
    if (!entry) continue
    models.push(entry)
    listed.add(id)
    addedIds.push(id)
  }
  return { models, addedIds, changed: addedIds.length > 0 }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/merge.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/merge.js test/merge.test.js
git commit -m "feat: add the append-only merge

The plugin appends and stops. An entry the user already has is never
modified, and a model the user removed by hand is not added back,
because the ids the plugin added are remembered."
```

---

## Task 6: Remembering which models the plugin added

Without this, a model the user deletes by hand comes back on the next sync. The state lives in one file inside the profile directory, so the plugin's own bookkeeping never touches the user's patch.

**Files:**
- Create: `lib/state.js`
- Create: `test/state.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `lib/state.js` → `STATE_FILENAME: string`, `emptyState(): object`, `readState(dir): Promise<object>`, `writeState(dir, state): Promise<object>`
  - A state object is `{ addedModels: string[], retiredModels: string[], lastSyncAt: number | null }`
  - `addedModels` holds the ids the plugin appended, `retiredModels` the ids MiniMax has retired

- [ ] **Step 1: Write the failing test**

Create `test/state.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_FILENAME, emptyState, readState, writeState } from '../lib/state.js'

async function scratchDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-minimax-state-'))
}

test('readState answers an empty state for an empty file', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), '', 'utf8')
  assert.deepEqual(await readState(dir), emptyState())
})

test('readState answers an empty state for a truncated file', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), '{"addedModels": ["MiniMax-M', 'utf8')
  assert.deepEqual(await readState(dir), emptyState())
})

test('readState fills in the fields an older version did not write', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), JSON.stringify({ addedModels: ['MiniMax-M3'] }), 'utf8')
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['MiniMax-M3'])
  assert.equal(state.lastSyncAt, null)
})

test('a successful write leaves no temporary file behind', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['MiniMax-M3'], lastSyncAt: 1 })
  assert.deepEqual(await readdir(dir), [STATE_FILENAME])
})

test('a failed write rejects and leaves no temporary file behind', async () => {
  const dir = await scratchDir()
  // A directory where the state file goes makes the rename fail.
  await mkdir(join(dir, STATE_FILENAME))
  await assert.rejects(() => writeState(dir, { addedModels: ['MiniMax-M3'], lastSyncAt: 1 }))
  const entries = await readdir(dir)
  assert.deepEqual(entries, [STATE_FILENAME])
})

test('a failed write leaves the previous state intact', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['MiniMax-M3'], lastSyncAt: 1 })
  // A directory that cannot be written to makes the temporary write fail.
  await chmod(dir, 0o500)
  try {
    await assert.rejects(() => writeState(dir, { addedModels: ['MiniMax-M3.2'], lastSyncAt: 2 }))
  } finally {
    await chmod(dir, 0o700)
  }
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['MiniMax-M3'])
  assert.equal(state.lastSyncAt, 1)
})

test('readState answers an empty state when the file is absent', async () => {
  const dir = await scratchDir()
  assert.deepEqual(await readState(dir), emptyState())
})

test('readState ignores a corrupt state file', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), 'not json at all', 'utf8')
  assert.deepEqual(await readState(dir), emptyState())
})

test('writeState stores the added models and the sync time', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['MiniMax-M3.1-Flash'], lastSyncAt: 1760000000000 })
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['MiniMax-M3.1-Flash'])
  assert.equal(state.lastSyncAt, 1760000000000)
})

test('writeState sorts and de-duplicates the added models', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: ['b', 'a', 'b'], lastSyncAt: null })
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['a', 'b'])
})

test('readState drops entries that are not strings', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), JSON.stringify({ addedModels: ['a', 7, null], lastSyncAt: 'x' }), 'utf8')
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['a'])
  assert.equal(state.lastSyncAt, null)
})

test('writeState drops entries that are not strings', async () => {
  const dir = await scratchDir()
  const stored = await writeState(dir, { addedModels: ['a', 7, null, ''], lastSyncAt: 'x' })
  assert.deepEqual(stored.addedModels, ['a'])
  assert.equal(stored.lastSyncAt, null)
  const state = await readState(dir)
  assert.deepEqual(state.addedModels, ['a'])
})

test('two concurrent writes both succeed and never blend their ids', async () => {
  const dir = await scratchDir()
  const first = Array.from({ length: 2000 }, (_, i) => `model-a-${i}`).sort()
  const second = Array.from({ length: 2000 }, (_, i) => `model-b-${i}`).sort()
  for (let round = 0; round < 5; round += 1) {
    // Two writers, one directory: each write owns its own temporary file.
    await Promise.all([
      writeState(dir, { addedModels: first, lastSyncAt: 1 }),
      writeState(dir, { addedModels: second, lastSyncAt: 2 }),
    ])
    const ids = (await readState(dir)).addedModels
    const isFirst = ids.length === first.length && ids.every((id, i) => id === first[i])
    const isSecond = ids.length === second.length && ids.every((id, i) => id === second[i])
    // A blended file would be valid JSON holding ids of both writers, and
    // readState would accept it without complaint.
    assert.ok(isFirst || isSecond, `the state file blended both payloads (${ids.length} ids)`)
    assert.deepEqual(await readdir(dir), [STATE_FILENAME])
  }
})

test('writeState stores the retired models', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: [], retiredModels: ['MiniMax-M2'], lastSyncAt: 1760000000000 })
  const state = await readState(dir)
  assert.deepEqual(state.retiredModels, ['MiniMax-M2'])
  assert.equal(state.lastSyncAt, 1760000000000)
})

test('writeState sorts and de-duplicates the retired models', async () => {
  const dir = await scratchDir()
  await writeState(dir, { addedModels: [], retiredModels: ['b', 'a', 'b'], lastSyncAt: null })
  const state = await readState(dir)
  assert.deepEqual(state.retiredModels, ['a', 'b'])
})

test('readState fills in the retired models an older version did not write', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), JSON.stringify({ addedModels: ['MiniMax-M3'] }), 'utf8')
  const state = await readState(dir)
  assert.deepEqual(state.retiredModels, [])
})

test('readState drops retired entries that are not strings', async () => {
  const dir = await scratchDir()
  await writeFile(join(dir, STATE_FILENAME), JSON.stringify({ retiredModels: ['a', 7, null, ''] }), 'utf8')
  const state = await readState(dir)
  assert.deepEqual(state.retiredModels, ['a'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/state.test.js`
Expected: FAIL with `Cannot find module '../lib/state.js'`

- [ ] **Step 3: Write `lib/state.js`**

```js
/**
 * The plugin's own bookkeeping.
 *
 * The ids the plugin added are remembered so that a model the user removes
 * by hand is not added back on the next sync. The ids MiniMax has retired
 * are remembered too, so that a model it no longer serves is probed once and
 * then left alone: `/v1/models` keeps listing a retired model, so without
 * this memory every sweep would pay two upstream requests for it again. The
 * state lives in one file inside the profile directory, so the plugin's
 * bookkeeping never lands in the user's profile patch.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** Name of the state file inside the profile directory. */
export const STATE_FILENAME = 'dsh-minimax-state.json'

/**
 * The state of a plugin that has never synced.
 *
 * @returns an empty state.
 */
export function emptyState() {
  return { addedModels: [], retiredModels: [], lastSyncAt: null }
}

/**
 * Keep the ids of one list that are usable strings.
 *
 * @param value - the list as it was stored.
 * @returns the usable ids.
 */
function usableIds(value) {
  return Array.isArray(value)
    ? value.filter((id) => typeof id === 'string' && id.length > 0)
    : []
}

/**
 * Read the plugin's state.
 *
 * @param dir - the profile directory.
 * @returns the state; an empty one when the file is missing or unreadable.
 */
export async function readState(dir) {
  try {
    const raw = await readFile(join(dir, STATE_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      addedModels: usableIds(parsed?.addedModels),
      retiredModels: usableIds(parsed?.retiredModels),
      lastSyncAt: Number.isFinite(parsed?.lastSyncAt) ? parsed.lastSyncAt : null,
    }
  } catch {
    return emptyState()
  }
}

/**
 * Write the plugin's state.
 *
 * The write is atomic: the state reaches the file through a temporary file
 * and a rename, so a crash cannot leave a half-written file that reads back
 * as an empty state. The temporary name carries the process id and a random
 * suffix, so two writers never share one temporary file and cannot rename
 * or delete each other's half-written state.
 *
 * @param dir - the profile directory.
 * @param state - the state to store.
 * @returns the stored state.
 * @throws when the state cannot be written; the caller decides what to do.
 */
export async function writeState(dir, state) {
  await mkdir(dir, { recursive: true })
  const payload = {
    addedModels: [...new Set(usableIds(state.addedModels))].sort(),
    retiredModels: [...new Set(usableIds(state.retiredModels))].sort(),
    lastSyncAt: Number.isFinite(state.lastSyncAt) ? state.lastSyncAt : null,
  }
  const target = join(dir, STATE_FILENAME)
  const temp = join(dir, `${STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`)
  // The write goes through a temporary file and a rename, because a file
  // truncated by a crash would read back as an empty state — and an empty
  // state forgets which models the plugin added, so a model the user deleted
  // by hand would come back.
  try {
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temp, target)
  } catch (error) {
    // A failed write must not leave a partial file behind that a later read
    // would mistake for state.
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return payload
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/state.test.js`
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/state.js test/state.test.js
git commit -m "feat: remember the model ids the plugin added

Without this a model the user deletes by hand comes back on the next
sync. The state lives in one file inside the profile directory, so the
bookkeeping never lands in the user's profile patch."
```

---

## Task 7: The Host wiring

Now the modules meet a live context. This task registers the routes, runs the sync, and writes the result into the pi-ai profile.

**Files:**
- Modify: `index.js`
- Create: `test/sync.test.js`

**Interfaces:**
- Consumes:
  - `fetchQuota(ctx, ref, signal, fetchImpl)` from `lib/quota.js`
  - `resolveApiKey(ctx, ref)` from `lib/credentials.js`
  - `fetchModelIds(apiKey, options)`, `probeModel(modelId, apiKey, options)` from `lib/probe.js`
  - `buildModelEntry(modelId, probe, spec?)` from `lib/model-entry.js`
  - `planAppend({...})` from `lib/merge.js`
  - `readState(dir)`, `writeState(dir, state)` from `lib/state.js`
- Produces:
  - `index.js` → `runSync(ctx, options): Promise<object>` — exported for the tests
  - `index.js` → `buildStatusPayload(ctx, options): Promise<object>` — exported for the tests
  - `index.js` → `inject: string[]` — `['webServer', 'credentials', 'settings', 'profileContext']`
  - `index.js` → `Config` — a Standard Schema with a `toJSON`, so the settings service can render the row
  - Routes: `GET /plugin/minimax/status`, `POST /plugin/minimax/sync`

**Two shapes the Host service reads, and the fakes have to honour them:**

- `settings.write(ns, change, expected, paths)` hands the change the **current projection**, the
  **inherited projection** and the schema, and it reads every entry of `paths` as a **list of field
  segments**: `[['providers', 'minimax-cn', 'models']]`. A flat list fails in the service with
  `TypeError: path.join is not a function`, so the fake refuses that shape too.
- `settings.describe()` answers with the **schema-resolved** projection: every route and every model
  entry carries the defaults the pi-ai schema materialises (`compat` on an entry, `defaultContextWindow`
  and friends on a route). The override it answers with is the raw profile row, which carries the
  entries exactly as the user wrote them. A fake that answers with the raw map alone hides the
  difference between the two, and with it the bug the raw-entries rule exists to prevent.

- [ ] **Step 1: Write the failing test for the sync**

Create `test/sync.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, apply, buildStatusPayload, inject, runSync } from '../index.js'
import { STATE_FILENAME } from '../lib/state.js'

/**
 * The defaults the pi-ai schema materialises into a provider route.
 *
 * The real service answers with the schema-resolved map, so a route that
 * the user configured without them carries them anyway.
 */
const ROUTE_DEFAULTS = {
  defaultContextWindow: 1000000,
  defaultMaxTokens: 128000,
  defaultInput: ['text'],
}

/** The default the pi-ai schema materialises into every model entry. */
const MODEL_DEFAULTS = { compat: {} }

/**
 * Resolve one provider route the way the pi-ai schema does.
 *
 * @param route - the route as it was written.
 * @returns the resolved route.
 */
function resolveRoute(route) {
  if (route === null || typeof route !== 'object') return route
  const resolved = { ...route, ...ROUTE_DEFAULTS }
  if (Array.isArray(route.models)) {
    resolved.models = route.models.map((entry) => (
      entry !== null && typeof entry === 'object' ? { ...entry, ...MODEL_DEFAULTS } : entry
    ))
  }
  return resolved
}

/**
 * Resolve a provider map the way the pi-ai schema does.
 *
 * @param providers - the map as it was written.
 * @returns the resolved map.
 */
function resolveProviders(providers) {
  const resolved = {}
  for (const [id, route] of Object.entries(providers ?? {})) resolved[id] = resolveRoute(route)
  return resolved
}

/**
 * A stand-in for the Host settings service.
 *
 * The service holds two layers: the profile override, which a write replaces,
 * and the inherited layer, which holds the provider map when the user
 * configured it there instead of in the profile. The write is handed the
 * current projection, the inherited projection and the schema, and its result
 * replaces the whole `providers` map, so a route that only an inherited layer
 * configures is lost when the written map does not carry it.
 *
 * The effective projection the service answers with is the schema-resolved
 * one: every route and every model entry carries the defaults the pi-ai
 * schema materialises. The fake resolves its map the same way, so a test sees
 * what the service really answers — a materialised default on an entry the
 * user wrote. The override the service answers with is the raw profile row,
 * which carries the entries exactly as the user wrote them.
 *
 * @param options - `{ providers, override }`; `providers` is the inherited
 *   layer's map, and `override` is the raw profile row, which defaults to a
 *   row holding the same map.
 * @returns the settings fake.
 */
function fakeSettings({ providers = {}, override } = {}) {
  const writes = []
  const state = {
    revision: 3,
    inherited: providers,
    override: override ?? { providers },
  }

  /**
   * The provider map the effective projection holds.
   *
   * The loader merges the layers shallowly, so an override that carries a
   * provider map replaces the inherited one.
   *
   * @returns the effective map.
   */
  const effectiveProviders = () => {
    const own = state.override?.providers
    const base = state.inherited ?? {}
    if (own !== null && typeof own === 'object') return { ...base, ...own }
    return base
  }

  return {
    writes,
    describe() {
      return [{
        ns: 'llm-pi-ai',
        // The revision moves when the profile changes, so a write that
        // carries a stale one cannot pass unnoticed.
        revision: state.revision,
        value: { providers: resolveProviders(effectiveProviders()) },
        // The override is the raw profile row: the entries carry the wording
        // the user wrote, with no default materialised into them.
        user: state.override?.providers === undefined
          ? {}
          : { providers: state.override.providers },
      }]
    },
    async write(ns, change, expected, paths) {
      // The Host service reads every entry of `paths` as a list of field
      // segments and joins them with a dot, so a write that hands it a flat
      // list of segments fails there with `path.join is not a function`. The
      // fake refuses the same shape, so the contract cannot drift unnoticed.
      for (const path of paths ?? []) {
        if (!Array.isArray(path)) {
          throw new TypeError('settings.write expects a list of field paths')
        }
      }
      // The service hands the change the current projection, the inherited
      // one and the schema.
      const next = change(
        { providers: resolveProviders(effectiveProviders()) },
        { providers: resolveProviders(state.inherited) },
        { type: 'object' },
      )
      writes.push({ ns, expected, paths, next })
      // The write replaces the volatile map in the override, and the
      // revision moves with it.
      state.override = { ...state.override, providers: next.providers }
      state.revision += 1
    },
  }
}

/**
 * A Host context with the services the plugin uses.
 *
 * The logger records every level the Host offers, so a test can reach the
 * lines the plugin writes. A logger with only `error` would silently skip
 * every `info` and `warn` line, and no test could see them.
 *
 * @param options - `{ settings, profileDir, webServer }`.
 * @returns the fake context.
 */
function ctxWith({ settings, profileDir = '/tmp/dsh-minimax-test', webServer } = {}) {
  const effects = []
  const effectLabels = []
  const logs = []
  const infos = []
  const warns = []
  return {
    settings,
    effects,
    effectLabels,
    logs,
    infos,
    warns,
    logger: {
      error(...args) {
        logs.push(args)
      },
      info(...args) {
        infos.push(args)
      },
      warn(...args) {
        warns.push(args)
      },
    },
    get(name) {
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      if (name === 'settings') return settings
      if (name === 'profileContext') return { dir: profileDir }
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(setup, label) {
      const dispose = setup()
      effects.push(dispose)
      effectLabels.push(label)
      return dispose
    },
  }
}

/**
 * Run every disposer the context collected, once.
 *
 * @param ctx - the fake context.
 */
function disposeAll(ctx) {
  for (const dispose of ctx.effects.splice(0)) dispose()
  ctx.effectLabels.splice(0)
}

/**
 * Cancel one registered effect, by the label it was registered under.
 *
 * @param ctx - the fake context.
 * @param label - the label the effect carries.
 */
function disposeEffect(ctx, label) {
  const index = ctx.effectLabels.indexOf(label)
  if (index === -1) return
  const dispose = ctx.effects[index]
  ctx.effects.splice(index, 1)
  ctx.effectLabels.splice(index, 1)
  dispose()
}

function makeContext(options = {}) {
  const settings = options.settings ?? fakeSettings()
  return ctxWith({ ...options, settings })
}

/**
 * A stand-in for the web server service.
 *
 * @returns the web server fake.
 */
function fakeWebServer() {
  const registered = []
  const removed = []
  return {
    registered,
    removed,
    register(route) {
      registered.push(route)
      return () => removed.push(route.path)
    },
  }
}

/**
 * A request that lets the test close it.
 *
 * @param method - the request method.
 * @returns the fake request.
 */
function fakeRequest(method = 'GET') {
  const listeners = new Map()
  return {
    method,
    once(event, listener) {
      listeners.set(event, listener)
    },
    close() {
      listeners.get('close')?.()
    },
  }
}

function fakeResponse() {
  return {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.status = status },
    end(body) { this.body = body; this.writableEnded = true },
  }
}

const MODEL_IDS = ['MiniMax-M3.1-Flash', 'MiniMax-M2']
const PROBE_FETCH = async (_url, init) => {
  const body = JSON.parse(init.body)
  if (body.max_tokens === 999999999) {
    if (body.model === 'MiniMax-M2') {
      return new Response(JSON.stringify({ error: { message: 'The model "MiniMax-M2" is no longer available. (2069)' } }), { status: 400 })
    }
    return new Response(JSON.stringify({ error: { message: 'invalid params, model[MiniMax-M3.1-Flash] does not support max tokens > 524288 (2013)' } }), { status: 400 })
  }
  return new Response(JSON.stringify({ content: [{ type: 'thinking', thinking: '391' }, { type: 'text', text: '391' }] }), { status: 200 })
}

const fakeFetch = async (url, init) => {
  if (String(url).endsWith('/v1/models')) {
    return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
  }
  return PROBE_FETCH(url, init)
}

/** A day, in milliseconds: the delay the daily sweep waits for. */
const DAY_MS = 24 * 60 * 60 * 1000

/** How long the wait for pending work may take, in milliseconds. */
const WAIT_UNTIL_TIMEOUT_MS = 5000

/**
 * How many event-loop turns the wait may take before it gives up anyway.
 *
 * The deadline is the real limit. This is the backstop that keeps a test
 * from spinning forever when the wall clock does not move, which is what a
 * test that mocks `Date` would do.
 */
const WAIT_UNTIL_MAX_ROUNDS = 2000000

/**
 * Watch the timers the plugin arms.
 *
 * The daily sweep cannot be waited out in a test, so the clock is driven
 * instead. The mock timers fire the sweep's timer, and the recorded timers
 * show which delay was armed, how often the loop re-armed itself, and
 * whether the timer holds the event loop open.
 *
 * @returns the recorded timers and a function that restores the original.
 */
function watchTimers() {
  const originalSetTimeout = globalThis.setTimeout
  const timers = []
  globalThis.setTimeout = (handler, ms, ...rest) => {
    const timer = originalSetTimeout(handler, ms, ...rest)
    timers.push({ ms, timer })
    return timer
  }
  return {
    timers,
    restore() {
      globalThis.setTimeout = originalSetTimeout
    },
  }
}

/**
 * The timers armed with the daily delay.
 *
 * @param watcher - the timer watcher.
 * @returns the daily timers.
 */
function dailyTimers(watcher) {
  return watcher.timers.filter((entry) => entry.ms === DAY_MS)
}

/**
 * Let the pending work run for a few turns of the event loop.
 *
 * @param rounds - how many turns to wait.
 */
async function flush(rounds = 30) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Let the pending work run until the condition holds.
 *
 * The wait is on real time, not on a number of event-loop turns: a turn
 * costs microseconds, so a fixed number of turns is a few milliseconds, and
 * a sync that probes every model MiniMax offers takes longer than that on a
 * loaded machine. A wait that gives up after a few milliseconds lets the
 * test tear the plugin down while the sync is still running, and the sync
 * then writes into a directory that is on its way out.
 *
 * The deadline is compared against the wall clock, which keeps running even
 * when a test mocks the timers, and the polling uses `setImmediate`, which
 * such a test leaves alone.
 *
 * @param check - returns true once the work is done.
 */
async function waitUntil(check) {
  const deadline = Date.now() + WAIT_UNTIL_TIMEOUT_MS
  for (let round = 0; round < WAIT_UNTIL_MAX_ROUNDS; round += 1) {
    if (check()) return
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('the pending work did not finish in time')
}

/**
 * Give the pending work the time it may need.
 *
 * The wait is on the wall clock, so it keeps running even when a test mocks
 * the timers. It is used to let work that must *not* happen have every
 * chance to happen, so its absence can be asserted.
 *
 * @param ms - how long to wait.
 */
async function settle(ms) {
  const deadline = Date.now() + ms
  for (let round = 0; round < WAIT_UNTIL_MAX_ROUNDS; round += 1) {
    if (Date.now() >= deadline) return
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * A promise the test settles from the outside.
 *
 * @returns the promise and the function that settles it.
 */
function deferred() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release }
}

/**
 * A request that waits until the test releases it or the signal aborts.
 *
 * A real request behaves exactly like this: it ends when the answer
 * arrives, and it fails when the caller calls it off.
 *
 * @param signal - the request's signal.
 * @param gate - the deferred the test releases.
 * @returns a promise that settles when one of the two happens.
 */
function waitForRelease(signal, gate) {
  return new Promise((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('the request was aborted')))
    gate.promise.then(resolve, reject)
  })
}

/**
 * A fetch that answers the model list and hangs on the probe.
 *
 * The probe is where the sync spends its time, so a test that disposes the
 * plugin while a probe is in flight can see whether the sync stops.
 *
 * @param options - `{ gate, requests }`; the requests are recorded by name.
 * @returns the fetch implementation.
 */
function hangingProbeFetch({ gate, requests }) {
  return async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      requests.push('models')
      return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
    }
    requests.push('probe')
    await waitForRelease(init?.signal, gate)
    return PROBE_FETCH(url, init)
  }
}

test('runSync appends a newly released model and leaves the rest alone', async () => {
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M3', maxTokens: 512000 }] },
      'other-route': { apiKeyEnv: 'OTHER_API_KEY' },
    },
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, ['MiniMax-M3.1-Flash'])
  assert.equal(settings.writes.length, 1)
  const write = settings.writes[0]
  // The write names the namespace, the revision it read and the one volatile
  // path it changed, so a write to the wrong place cannot pass unnoticed. The
  // path is a list of field segments, the shape the Host service reads.
  assert.equal(write.ns, 'llm-pi-ai')
  assert.equal(write.expected, 3)
  assert.deepEqual(write.paths, [['providers', 'minimax-cn', 'models']])
  const written = write.next.providers['minimax-cn'].models
  assert.equal(written.length, 2)
  assert.equal(written[0].id, 'MiniMax-M3')
  assert.equal(written[0].maxTokens, 512000)
  assert.equal(written[1].id, 'MiniMax-M3.1-Flash')
  assert.equal(written[1].maxTokens, 524288)
  // The rest of the route survives, and so does every other provider.
  assert.equal(write.next.providers['minimax-cn'].apiKeyEnv, 'MINIMAX_CN_API_KEY')
  assert.equal(write.next.providers['other-route'].apiKeyEnv, 'OTHER_API_KEY')
})

test('the written entry keeps the wording the user wrote', async () => {
  // The effective projection is the schema-resolved one, so the entry the
  // user wrote carries a materialised `compat` block there. The override is
  // the raw profile row, so the entry the user wrote is there as it was.
  const userEntry = { id: 'MiniMax-M3', name: 'MiniMax-M3-1M', maxTokens: 512000 }
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [userEntry] },
      'other-route': { apiKeyEnv: 'OTHER_API_KEY' },
    },
    override: {
      providers: {
        'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [userEntry] },
      },
    },
  })
  // The service really answers with a materialised default on the entry.
  const descriptor = settings.describe()[0]
  assert.deepEqual(descriptor.value.providers['minimax-cn'].models[0].compat, {})
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, ['MiniMax-M3.1-Flash'])
  assert.equal(settings.writes.length, 1)
  const written = settings.writes[0].next.providers['minimax-cn'].models
  // The entry the user wrote is written back exactly as it was: no
  // materialised default, no changed value, no new order.
  assert.deepEqual(written[0], userEntry)
  // The new model is appended behind it.
  assert.equal(written[1].id, 'MiniMax-M3.1-Flash')
  // The sibling route from the inherited layer survives the write.
  assert.equal(settings.writes[0].next.providers['other-route'].apiKeyEnv, 'OTHER_API_KEY')
})

test('runSync keeps a route that only an inherited layer configures', async () => {
  // The user's provider map lives in an inherited layer, so the profile
  // override the write is handed holds no providers at all. The settings
  // service replaces the whole map, so a map built from that override alone
  // would drop the route and the credential environment it needs.
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M3', maxTokens: 512000 }] },
      'other-route': { apiKeyEnv: 'OTHER_API_KEY' },
    },
    override: {},
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, ['MiniMax-M3.1-Flash'])
  assert.equal(settings.writes.length, 1)
  const written = settings.writes[0].next.providers
  // The route keeps the credential environment the inherited layer gave it.
  assert.equal(written['minimax-cn'].apiKeyEnv, 'MINIMAX_CN_API_KEY')
  // Its model list is the one the sync planned.
  assert.deepEqual(written['minimax-cn'].models.map((entry) => entry.id), ['MiniMax-M3', 'MiniMax-M3.1-Flash'])
  // The sibling route is not lost either.
  assert.equal(written['other-route'].apiKeyEnv, 'OTHER_API_KEY')
})

test('runSync still succeeds when the state cannot be written', async () => {
  const ctx = makeContext()
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/profile',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => { throw new Error('EACCES') },
  })
  assert.equal(result.ok, true)
  assert.equal(ctx.settings.writes.length, 1)
})

test('runSync never writes a retired model', async () => {
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.deepEqual(result.added, ['MiniMax-M3.1-Flash'])
  assert.equal(settings.writes.length, 1)
  const written = settings.writes[0].next.providers['minimax-cn'].models
  assert.equal(written.some((entry) => entry.id === 'MiniMax-M2'), false)
})

test('runSync writes nothing when there is no new model', async () => {
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M3.1-Flash', maxTokens: 524288 }] },
    },
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, [])
  assert.equal(settings.writes.length, 0)
})

test('runSync reports a missing credential without writing', async () => {
  const settings = fakeSettings()
  const ctx = ctxWith({ settings })
  ctx.get = (name) => {
    if (name === 'settings') return settings
    return undefined
  }
  const result = await runSync(ctx, { credentialRef: 'MINIMAX_CN_API_KEY' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing-credential')
  assert.equal(settings.writes.length, 0)
})

test('runSync reports a model list that could not be read', async () => {
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: async () => { throw new Error('fetch failed') },
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  // A list that could not be read is not an empty account, so nothing is
  // written and the sync says why.
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'model-list-failed')
  assert.equal(settings.writes.length, 0)
})

test('a model the plugin added before is not probed again', async () => {
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings })
  const probed = []
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
      }
      probed.push(JSON.parse(init.body).model)
      return PROBE_FETCH(url, init)
    },
    stateReader: async () => ({ addedModels: ['MiniMax-M3.1-Flash'], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  // The user deleted the model by hand, so it stays deleted and costs
  // nothing to measure.
  assert.deepEqual(result.added, [])
  assert.deepEqual(probed, ['MiniMax-M2'])
  assert.equal(settings.writes.length, 0)
})

test('two overlapping syncs run as one', async () => {
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings })
  const options = {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  }
  const [first, second] = await Promise.all([runSync(ctx, options), runSync(ctx, options)])
  assert.deepEqual(first.added, ['MiniMax-M3.1-Flash'])
  assert.deepEqual(second.added, first.added)
  assert.equal(settings.writes.length, 1)
})

test('a refused profile write fails the sync instead of retrying blindly', async () => {
  const settings = fakeSettings()
  settings.write = async () => {
    throw new Error('settings namespace "llm-pi-ai" changed since it was read (expected revision 3, now 4)')
  }
  const ctx = ctxWith({ settings })
  await assert.rejects(() => runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: fakeFetch,
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  }), /changed since it was read/)
})

test('buildStatusPayload reports the quota and the synced model ids', async () => {
  const settings = fakeSettings({
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M3.1-Flash' }] },
    },
  })
  const ctx = ctxWith({ settings })
  const payload = await buildStatusPayload(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    stateReader: async () => ({ addedModels: ['MiniMax-M3.1-Flash'], lastSyncAt: 1760000000000 }),
    quotaFetcher: async (_ctx, _ref, _signal) => ({ ok: true, intervalRemainingPercent: 82, weeklyRemainingPercent: 35 }),
  })
  assert.equal(payload.quota.ok, true)
  assert.deepEqual(payload.models.synced, ['MiniMax-M3', 'MiniMax-M3.1-Flash'])
  assert.deepEqual(payload.models.added, ['MiniMax-M3.1-Flash'])
  assert.equal(payload.models.syncedAt, 1760000000000)
})

test('apply registers both routes and disposes them again', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  try {
    await apply(ctx, {})
    assert.deepEqual(webServer.registered.map((route) => route.path), [
      '/plugin/minimax/status',
      '/plugin/minimax/sync',
    ])
    disposeAll(ctx)
    assert.deepEqual(webServer.removed, ['/plugin/minimax/status', '/plugin/minimax/sync'])
  } finally {
    disposeAll(ctx)
  }
})

test('the sync route refuses a method that is not POST', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  try {
    await apply(ctx, {})
    const sync = webServer.registered.find((route) => route.path === '/plugin/minimax/sync')
    const res = fakeResponse()
    await sync.handler(fakeRequest('GET'), res)
    assert.equal(res.status, 405)
    assert.equal(JSON.parse(res.body).reason, 'method-not-allowed')
  } finally {
    disposeAll(ctx)
  }
})

test('the status route answers even when the payload cannot be built', async () => {
  const webServer = fakeWebServer()
  const settings = {
    describe() { throw new Error('the settings service exploded') },
    write() {},
  }
  const ctx = ctxWith({ settings, webServer })
  try {
    await apply(ctx, {})
    const status = webServer.registered.find((route) => route.path === '/plugin/minimax/status')
    const res = fakeResponse()
    await status.handler(fakeRequest('GET'), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.quota.ok, false)
    assert.equal(payload.quota.reason, 'request-failed')
    assert.deepEqual(payload.models, { synced: [], added: [], syncedAt: null })
    // The browser learns that the request failed and nothing else.
    assert.equal(payload.quota.message, undefined)
    assert.equal(res.body.includes('exploded'), false)
    // The message went to the Host side instead.
    assert.equal(ctx.logs.length, 1)
    assert.equal(ctx.logs[0].some((arg) => arg instanceof Error && arg.message.includes('exploded')), true)
  } finally {
    disposeAll(ctx)
  }
})

test('the sync route answers a failed sync without carrying the message', async () => {
  const webServer = fakeWebServer()
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  settings.write = async () => {
    throw new Error('settings namespace "llm-pi-ai" changed since it was read')
  }
  const ctx = ctxWith({ settings, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    const sync = webServer.registered.find((route) => route.path === '/plugin/minimax/sync')
    const res = fakeResponse()
    await sync.handler(fakeRequest('POST'), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    assert.equal(payload.reason, 'sync-failed')
    // The browser never sees the internal message.
    assert.equal(payload.message, undefined)
    assert.equal(res.body.includes('changed since it was read'), false)
    // The message went to the Host side instead.
    assert.equal(ctx.logs.length, 1)
    assert.equal(ctx.logs[0].some((arg) => arg instanceof Error && arg.message.includes('changed since it was read')), true)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
  }
})

test('the status route aborts its upstream request when the request closes', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  const originalFetch = globalThis.fetch
  let captured = null
  let release
  let reached
  const gate = new Promise((resolve) => { release = resolve })
  const called = new Promise((resolve) => { reached = resolve })
  globalThis.fetch = async (_url, init) => {
    captured = init
    reached()
    await gate
    return new Response(JSON.stringify({ base_resp: { status_code: 0 } }), { status: 200 })
  }
  try {
    await apply(ctx, {})
    const status = webServer.registered.find((route) => route.path === '/plugin/minimax/status')
    const req = fakeRequest('GET')
    const res = fakeResponse()
    const pending = status.handler(req, res)
    await called
    req.close()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(captured.signal.aborted, true)
    release()
    await pending
    assert.equal(res.status, 200)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
  }
})

test('the sync route aborts its upstream request when the request closes', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  const originalFetch = globalThis.fetch
  let captured = null
  let release
  let reached
  const gate = new Promise((resolve) => { release = resolve })
  const called = new Promise((resolve) => { reached = resolve })
  globalThis.fetch = async (_url, init) => {
    captured = init
    reached()
    await gate
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  try {
    await apply(ctx, {})
    const sync = webServer.registered.find((route) => route.path === '/plugin/minimax/sync')
    const req = fakeRequest('POST')
    const res = fakeResponse()
    const pending = sync.handler(req, res)
    await called
    req.close()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(captured.signal.aborted, true)
    release()
    await pending
    assert.equal(res.status, 200)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
  }
})

test('the first sync is cancelled when the plugin is disposed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  try {
    await apply(ctx, {})
    // The plugin is unloaded before the first attempt comes due, so the
    // pending timer must not run a sync that writes the profile afterwards.
    disposeAll(ctx)
    t.mock.timers.tick(10_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fetches, 0)
    assert.equal(ctx.settings.writes.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    t.mock.timers.reset()
  }
})

test('the daily sweep is registered as an effect of its own', async () => {
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  try {
    await apply(ctx, {})
    // The startup attempt and the daily sweep are two separate effects, so
    // unloading the plugin cancels both of them.
    assert.deepEqual(ctx.effectLabels, [
      'dsh-minimax: routes',
      'dsh-minimax: first sync',
      'dsh-minimax: daily sync',
    ])
  } finally {
    disposeAll(ctx)
  }
})

test('the daily sweep runs one sync when the day elapses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-daily-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  let modelLists = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      modelLists += 1
      return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
    }
    return PROBE_FETCH(url, init)
  }
  try {
    await apply(ctx, {})
    // The startup attempt is called off, so the only sync that can run is
    // the daily sweep.
    disposeEffect(ctx, 'dsh-minimax: first sync')

    // The day has not passed yet, so nothing has run.
    t.mock.timers.tick(DAY_MS - 1)
    await flush()
    assert.equal(modelLists, 0)
    assert.equal(dailyTimers(watcher).length, 1)

    // The day passes, and the sweep runs exactly one sync.
    t.mock.timers.tick(1)
    await waitUntil(() => dailyTimers(watcher).length === 2)
    assert.equal(modelLists, 1)
    assert.equal(settings.writes.length, 1)

    // The next day brings exactly one more sync, and no more than that.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 3)
    assert.equal(modelLists, 2)
    // Nothing new was found, so the second sweep wrote nothing at all.
    assert.equal(settings.writes.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('a second sweep does not probe a model the plugin already added', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-steady-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  let modelLists = 0
  const probed = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      modelLists += 1
      return new Response(JSON.stringify({ data: [{ id: 'MiniMax-M3.1-Flash' }] }), { status: 200 })
    }
    probed.push(JSON.parse(init.body).model)
    return PROBE_FETCH(url, init)
  }
  try {
    await apply(ctx, {})
    disposeEffect(ctx, 'dsh-minimax: first sync')

    // The first sweep measures the model MiniMax offers and adds it.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 2)
    assert.equal(modelLists, 1)
    // The cap request and the thinking request.
    assert.deepEqual(probed, ['MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash'])
    assert.equal(settings.writes.length, 1)
    const written = settings.writes[0].next.providers['minimax-cn'].models
    assert.deepEqual(written.map((entry) => entry.id), ['MiniMax-M3.1-Flash'])
    // The plugin remembers what it added.
    const state = JSON.parse(await readFile(join(profileDir, STATE_FILENAME), 'utf8'))
    assert.deepEqual(state.addedModels, ['MiniMax-M3.1-Flash'])

    // The second sweep costs one model-list request and no probe at all:
    // the model the plugin added is not a candidate any more.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 3)
    assert.equal(modelLists, 2)
    assert.equal(probed.length, 2)
    assert.equal(settings.writes.length, 1)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the daily sweep is cancelled when the plugin is disposed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-cancel-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  let modelLists = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      modelLists += 1
      return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
    }
    return PROBE_FETCH(url, init)
  }
  try {
    await apply(ctx, {})
    // The plugin is unloaded before the sweep comes due, so the pending
    // sweep must not run a sync that writes the profile afterwards.
    disposeAll(ctx)
    t.mock.timers.tick(DAY_MS)
    await flush()
    assert.equal(modelLists, 0)
    assert.equal(settings.writes.length, 0)
    // The cancelled sweep stops: it does not arm another day.
    assert.equal(dailyTimers(watcher).length, 1)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('a disposed plugin stops the sync that is in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-inflight-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  const gate = deferred()
  const requests = []
  globalThis.fetch = hangingProbeFetch({ gate, requests })
  try {
    await apply(ctx, {})
    // The first attempt comes due and the sync starts.
    t.mock.timers.tick(2000)
    await waitUntil(() => requests.includes('probe'))

    // The plugin is unloaded while the probe is in flight.
    disposeAll(ctx)
    // The probe is released anyway: a sync that was not stopped would carry
    // on here, probe the next model, and write into the profile.
    gate.release()
    await settle(300)

    // The sync stopped: the second model was never probed.
    assert.deepEqual(requests, ['models', 'probe'])
    // The profile was not written.
    assert.equal(settings.writes.length, 0)
    // And no bookkeeping landed in the profile directory.
    assert.equal(existsSync(join(profileDir, STATE_FILENAME)), false)
    // An abort is not a failure, so nothing was reported to the operator.
    assert.equal(ctx.logs.length, 0)
    assert.equal(ctx.warns.length, 0)
    assert.equal(ctx.infos.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    gate.release()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the daily sweep stops when the plugin is disposed while it is running', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-sweep-inflight-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  const gate = deferred()
  const requests = []
  globalThis.fetch = hangingProbeFetch({ gate, requests })
  try {
    await apply(ctx, {})
    // The startup attempt is called off, so the only sync that can run is
    // the daily sweep.
    disposeEffect(ctx, 'dsh-minimax: first sync')
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => requests.includes('probe'))

    // The plugin is unloaded while the sweep is in flight.
    disposeAll(ctx)
    // The probe is released anyway: a sweep that was not stopped would carry
    // on here, probe the next model, and write into the profile.
    gate.release()
    await settle(300)

    // The sweep stopped: the second model was never probed.
    assert.deepEqual(requests, ['models', 'probe'])
    // The profile was not written.
    assert.equal(settings.writes.length, 0)
    // And no bookkeeping landed in the profile directory.
    assert.equal(existsSync(join(profileDir, STATE_FILENAME)), false)
    // An abort is not a failure, so nothing was reported to the operator.
    assert.equal(ctx.logs.length, 0)
    assert.equal(ctx.warns.length, 0)
    assert.equal(ctx.infos.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    gate.release()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('a teardown during a sync leaves no file behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-teardown-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  const gate = deferred()
  const requests = []
  globalThis.fetch = hangingProbeFetch({ gate, requests })
  try {
    await apply(ctx, {})
    t.mock.timers.tick(2000)
    await waitUntil(() => requests.includes('probe'))

    // The profile directory goes away while the sync is still running. This
    // is the teardown the CI run hit: the directory was removed while the
    // sync was still going, and the sync then wrote into it.
    await rm(profileDir, { recursive: true, force: true })
    assert.equal(existsSync(profileDir), false)

    // The plugin is unloaded, which stops the sync that was still running.
    disposeAll(ctx)
    gate.release()
    await settle(300)

    // Nothing was written into the directory afterwards: it was not
    // recreated, and no bookkeeping landed in it.
    assert.equal(existsSync(profileDir), false)
    assert.equal(settings.writes.length, 0)
    // The sync stopped rather than carrying on.
    assert.deepEqual(requests, ['models', 'probe'])
  } finally {
    globalThis.fetch = originalFetch
    gate.release()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the pending daily timer does not hold the process open', async () => {
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const ctx = ctxWith({ settings: fakeSettings(), webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
  try {
    await apply(ctx, {})
    const daily = dailyTimers(watcher)
    assert.equal(daily.length, 1)
    // The sweep's timer is unreferenced, so a pending sweep can never keep
    // a process alive on its own.
    assert.equal(daily[0].timer.hasRef(), false)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
  }
})


/**
 * A fetch that answers like MiniMax does for a model it has retired.
 *
 * MiniMax validates `max_tokens` before it checks whether the model still
 * exists, so the cap request answers with a cap and only the next request
 * says the model is gone. A retired model therefore costs two requests.
 */
const RETIRED_FETCH = async (_url, init) => {
  const body = JSON.parse(init.body)
  if (body.max_tokens === 999999999) {
    return new Response(JSON.stringify({ error: { message: 'invalid params, model[MiniMax-M2] does not support max tokens > 131072 (2013)' } }), { status: 400 })
  }
  return new Response(JSON.stringify({ error: { message: 'The model "MiniMax-M2" is no longer available. (2069)' } }), { status: 400 })
}

test('a retired model is probed once and then remembered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-retired-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  let modelLists = 0
  let probes = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/models')) {
      modelLists += 1
      // MiniMax keeps listing the model it has retired.
      return new Response(JSON.stringify({ data: [{ id: 'MiniMax-M2' }] }), { status: 200 })
    }
    probes += 1
    return RETIRED_FETCH(url, init)
  }
  try {
    await apply(ctx, {})
    disposeEffect(ctx, 'dsh-minimax: first sync')

    // The first sweep meets the retired model and probes it.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 2)
    assert.equal(modelLists, 1)
    // The cap request and the request that says the model is gone.
    assert.equal(probes, 2)
    // A retired model is never written into the profile.
    assert.equal(settings.writes.length, 0)
    // The decision is remembered.
    const state = JSON.parse(await readFile(join(profileDir, STATE_FILENAME), 'utf8'))
    assert.deepEqual(state.retiredModels, ['MiniMax-M2'])

    // The next sweep costs one model-list request and no probe at all: the
    // model MiniMax retired is not a candidate any more.
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 3)
    assert.equal(modelLists, 2)
    assert.equal(probes, 2)
    assert.equal(settings.writes.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the daily sweep leaves one line on the Host log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const watcher = watchTimers()
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-daily-log-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    disposeEffect(ctx, 'dsh-minimax: first sync')
    t.mock.timers.tick(DAY_MS)
    await waitUntil(() => dailyTimers(watcher).length === 2)
    // The line says how many models were added, so a day that added three
    // does not read like a day that added none.
    assert.equal(ctx.infos.length, 1)
    assert.equal(ctx.infos[0][1], 'dsh-minimax: the daily sync added')
    assert.equal(ctx.infos[0][2], 1)
  } finally {
    globalThis.fetch = originalFetch
    watcher.restore()
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the startup sync leaves one line on the Host log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-startup-log-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    // The first attempt waits two seconds before it runs.
    t.mock.timers.tick(2000)
    await waitUntil(() => ctx.infos.length > 0)
    assert.equal(ctx.infos[0][1], 'dsh-minimax: the startup sync added')
    // The line says how many models were added.
    assert.equal(ctx.infos[0][2], 1)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the manual sync leaves one line on the Host log', async () => {
  const webServer = fakeWebServer()
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-manual-log-'))
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    const sync = webServer.registered.find((route) => route.path === '/plugin/minimax/sync')
    const res = fakeResponse()
    await sync.handler(fakeRequest('POST'), res)
    assert.equal(ctx.infos.length, 1)
    assert.equal(ctx.infos[0][1], 'dsh-minimax: the manual sync added')
    // The line says how many models were added.
    assert.equal(ctx.infos[0][2], 1)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('a failed startup sync is not swallowed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const webServer = fakeWebServer()
  const settings = fakeSettings({
    providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [] } },
  })
  settings.write = async () => {
    throw new Error('settings namespace "llm-pi-ai" changed since it was read')
  }
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-minimax-startup-fail-'))
  const ctx = ctxWith({ settings, profileDir, webServer })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  try {
    await apply(ctx, {})
    t.mock.timers.tick(2000)
    await waitUntil(() => ctx.logs.length > 0)
    // The failure reaches the Host log instead of disappearing into an
    // empty catch.
    assert.equal(ctx.logs[0].some((arg) => arg instanceof Error && arg.message.includes('changed since it was read')), true)
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(ctx)
    await rm(profileDir, { recursive: true, force: true })
    t.mock.timers.reset()
  }
})

test('the plugin declares the profile context it reads its state from', async () => {
  // Without the service the fallbacks would swap in a no-op state reader and
  // writer, and a model the user deleted by hand would come back.
  assert.deepEqual(inject, ['webServer', 'credentials', 'settings', 'profileContext'])
})

test('the config refuses a credential reference the credentials service cannot resolve', async () => {
  // The credentials service only recognises a reference that is a shell
  // identifier, so anything else resolves to nothing.
  const refused = Config['~standard'].validate({ credentialRef: 'sk-example-key' })
  assert.equal(Array.isArray(refused.issues), true)
  assert.equal(refused.issues.length, 1)
  assert.equal(refused.issues[0].path[0], 'credentialRef')
  const accepted = Config['~standard'].validate({ credentialRef: 'MINIMAX_CN_API_KEY' })
  assert.equal(accepted.value.credentialRef, 'MINIMAX_CN_API_KEY')
})

test('the config schema describes itself for the settings service', async () => {
  // Without a description the settings service finds no form for this row,
  // and the row stays invisible in the Settings UI.
  assert.equal(typeof Config.toJSON, 'function')
  const json = Config.toJSON()
  assert.equal(json.uid, 'dsh-minimax.config')
  assert.equal(json.refs[json.uid].dict.credentialRef, 'dsh-minimax.credentialRef')
  // The field is volatile, so it can be edited without remounting the plugin.
  assert.equal(json.refs['dsh-minimax.credentialRef'].meta.volatile, true)
  // Every reference the description names has to exist, or the service
  // cannot rebuild the schema.
  for (const ref of Object.values(json.refs)) {
    for (const child of Object.values(ref.dict ?? {})) {
      assert.ok(json.refs[child] !== undefined)
    }
    if (ref.inner !== undefined) assert.ok(json.refs[ref.inner] !== undefined)
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/sync.test.js`
Expected: FAIL with `runSync is not a function`

- [ ] **Step 3: Rewrite `index.js`**

Replace `index.js` with:

```js
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
    ctx.logger?.warn?.('%s: %s', `dsh-minimax: ${label} failed`, result?.reason ?? 'unknown')
    return
  }
  const added = Array.isArray(result.added) ? result.added.length : 0
  ctx.logger?.info?.('%s: %d', `dsh-minimax: ${label} added`, added)
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
          const result = await runSync(ctx, { credentialRef, signal: abort.signal })
          // Every sync leaves one line on the Host log, so the operator can
          // see what the plugin did without reading the profile.
          logSync(ctx, 'the manual sync', result)
          send(res, result)
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
        reportFailure(ctx, 'dsh-minimax: the startup sync failed', error)
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
      uid: 'dsh-minimax.credentialRef',
      refs: {
        'dsh-minimax.credentialRef': { type: 'string', meta: { volatile: true } },
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
        if (!CREDENTIAL_REF_PATTERN.test(entry)) {
          // The credentials service only recognises a reference that is a
          // shell identifier. A reference outside that grammar resolves to
          // nothing, so it would read as a missing credential while the key
          // itself sat in plain text in the profile patch.
          issues.push({
            message: `dsh-minimax: credentialRef "${entry}" must be a credential reference name (letters, digits and underscores, not starting with a digit)`,
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
      uid: 'dsh-minimax.config',
      refs: {
        'dsh-minimax.config': {
          type: 'object',
          meta: {},
          dict: { credentialRef: 'dsh-minimax.credentialRef' },
        },
        'dsh-minimax.credentialRef': { type: 'string', meta: { volatile: true } },
      },
    }
  },
}

export { Config }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — the sync suite plus the earlier suites.

- [ ] **Step 5: Commit**

```bash
git add index.js test/sync.test.js
git commit -m "feat: wire the sync into the Host and expose the routes

The sync only appends. The profile may still be loading when the plugin
activates, so the first sync retries until the pi-ai namespace appears.
A failed sync never takes the plugin down."
```

---

## Task 8: The Browser half — models section and notice marker

**Files:**
- Modify: `client.js`
- Modify: `locale/zh.json`
- Modify: `locale/en.json`
- Create: `test/client.test.js`

**Interfaces:**
- Consumes: `GET /plugin/minimax/status` — `{ quota, models: { synced, added, syncedAt } }`.
- Produces: the quota pill gains a notice marker; the details panel gains a models section.

- [ ] **Step 1: Read the parts of `client.js` you are about to change**

Run: `grep -n "QUOTA_ROUTE\|REFRESH_INTERVAL_MS\|function readQuota\|function QuotaPanel\|function MiniMaxQuotaPill\|__mmq_pill\|__mmq_panel\|panelTitle" client.js`

Note the line numbers of the route constant, the quota fetch, the panel component and the pill component.

- [ ] **Step 2: Point the client at the status route**

In `client.js`, find the route constant the client fetches and replace it with:

```js
const STATUS_ROUTE = '/plugin/minimax/status'
```

Replace every fetch of the old route with a fetch of `STATUS_ROUTE`, and replace the response handling so that the quota view is read from the `quota` key of the payload:

```js
    /**
     * The quota view of a status payload.
     *
     * A payload without a quota is malformed, so it reads as the failure the
     * browser already knows how to show.
     *
     * @param payload - the status payload.
     * @returns the quota view.
     */
    function quotaView(payload) {
      return payload?.quota ?? { ok: false, reason: 'request-failed', message: 'Malformed response.' }
    }
```

The panel must render the quota exactly as before — the payload nesting is the only change.

- [ ] **Step 3: Add the models section to the panel**

In `client.js`, add a component right after `QuotaPanel`:

```js
    /**
     * The models section: the ids the profile currently holds, how many of
     * them the plugin added, the moment the list was last written, and the
     * button that asks the Host for a fresh sync.
     *
     * The section never edits the list itself: the plugin appends and never
     * edits, so the models it added are the user's to keep or to remove by
     * hand. The button only asks; the sync itself runs on the Host.
     *
     * The section shows even when no model has been synced yet, so the sync
     * button is reachable in exactly the state where it is most useful.
     *
     * The section is absent when the status route did not answer, so the
     * line that reports a failed manual sync belongs to the panel.
     */
    function ModelsPanel({ models, t, onSync, syncing }) {
      if (models === undefined) return null
      const synced = Array.isArray(models.synced) ? models.synced : []
      const added = Array.isArray(models.added) ? models.added : []
      return h('div', { className: '__mmq_models' },
        h('div', { className: '__mmq_sectionTitle' }, t('modelsTitle')),
        synced.length > 0
          ? h('div', { className: '__mmq_modelList' },
              synced.map((id) => h('span', { className: '__mmq_modelChip', key: id }, id)),
            )
          : null,
        added.length > 0
          ? h('div', { className: '__mmq_modelNotice' }, t('modelsAdded', { count: added.length }))
          : null,
        models.syncedAt ? h('div', { className: '__mmq_meta' }, t('modelsSyncedAt', { when: formatClock(models.syncedAt) })) : null,
        onSync
          ? h('button', {
              className: '__mmq_syncButton',
              type: 'button',
              disabled: syncing === true,
              onClick: onSync,
            }, syncing === true ? t('modelsSyncing') : t('modelsSync'))
          : null,
      )
    }
```

Render it inside `QuotaPanel`, after the weekly section and before the fetched-at line, with the models passed down. `QuotaPanel` receives `view` today; add a `models` prop and pass it from `MiniMaxQuotaPill`, which already owns the fetched payload. The section renders whenever the status route answered — a profile with a MiniMax route but no MiniMax models yet must still be able to ask for a sync, so the chip list is the only part that is guarded.

- [ ] **Step 4: Add the notice marker to the pill**

The payload's `models.added` lists every model the plugin has ever added, so it
never empties. A badge driven by it alone would therefore never clear, and a
marker that lives in the component comes back on every conversation switch:
the pill is mounted in the chat composer, so a switch mounts it again and the
component's own state starts over.

So the badge counts what the user has not been told about yet, and the set of
models the user *has* been told about lives in the browser's own storage, which
survives a remount, a new conversation, a new tab and a restart of the app.

The storage is guarded: it can be missing, it can throw when it is touched —
some private browsing modes throw rather than answer `null` — and the value it
holds can be corrupt. Every access degrades to the empty set instead of
throwing, so the plugin keeps working when the storage does not. A write merges
the new ids into what is already stored, so a model the user was told about
earlier stays remembered.

Add the storage key and the three helpers to `client.js`, beside the other
helpers:

```js
    // ── the models the user has been told about ───────────────────────────
    /** The storage key that holds the ids of the models the user was told about. */
    const SEEN_MODELS_KEY = 'dsh-minimax.seen-models'

    /**
     * The model ids the storage holds.
     *
     * The stored value is a JSON array of model ids. A value that is not
     * such an array — or that is not JSON at all — holds nothing, so it is
     * read as the empty set.
     *
     * @param storage - the browser's local storage.
     * @returns `{ ok, ids }`: `ok` says whether the stored value could be
     *   read at all, `ids` holds the model ids it names.
     */
    function storedSeenModels(storage) {
      let raw
      try {
        raw = storage.getItem(SEEN_MODELS_KEY)
      } catch {
        // A storage that refuses to be read holds nothing that can be
        // trusted, so a write must not replace it.
        return { ok: false, ids: new Set() }
      }
      if (raw === null || raw === undefined) return { ok: true, ids: new Set() }
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return { ok: true, ids: new Set() }
        return { ok: true, ids: new Set(parsed.filter((id) => typeof id === 'string')) }
      } catch {
        // A corrupt value holds nothing, so it is read as the empty set and
        // the next write repairs it.
        return { ok: true, ids: new Set() }
      }
    }

    /**
     * The models the user has already been told about.
     *
     * The set lives in the browser's own storage, so it survives a remount,
     * a new conversation, a new tab and a restart of the app — which is what
     * the badge needs, because the pill is mounted in the chat composer and
     * a conversation switch mounts it again.
     *
     * The storage can be missing, can throw when it is touched and can hold
     * a corrupt value, so every access degrades to the empty set instead of
     * throwing.
     *
     * @returns the set of seen model ids.
     */
    function readSeenModels() {
      try {
        const storage = window.localStorage
        if (storage === null || storage === undefined) return new Set()
        return storedSeenModels(storage).ids
      } catch {
        // Some private browsing modes throw when the storage is touched.
        return new Set()
      }
    }

    /**
     * Remember the models the user has been told about.
     *
     * The write merges: the ids are added to what is already stored, so a
     * model the user was told about earlier stays remembered. A storage that
     * cannot be written to leaves the plugin working, just without the
     * memory.
     *
     * @param ids - the model ids to remember.
     */
    function writeSeenModels(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return
      try {
        const storage = window.localStorage
        if (storage === null || storage === undefined) return
        const stored = storedSeenModels(storage)
        // A value that could not be read is not replaced: the write would
        // drop what is already stored.
        if (!stored.ok) return
        for (const id of ids) {
          if (typeof id === 'string') stored.ids.add(id)
        }
        storage.setItem(SEEN_MODELS_KEY, JSON.stringify([...stored.ids]))
      } catch {
        // A storage that refuses to be written to leaves the plugin working.
      }
    }

```

Replace the component's own `noticeSeen` flag with the set the browser
remembers, and count what is left of it:

```js
      const [seen, setSeen] = React.useState(() => readSeenModels())

```

```js
      // The badge counts the models the plugin added that the user has not
      // been told about yet. The plugin's own list of added models is
      // cumulative, so the count — not the list — is what says whether
      // there is news.
      const addedModels = Array.isArray(payload?.models?.added) ? payload.models.added : []
      const unseen = addedModels.filter((id) => !seen.has(id))

```

Opening the panel is the moment the user is told which models the plugin
added, so they are marked as seen and remembered — also after the user opens a
different conversation:

```js
      // Tell the user about the models the plugin added: they are marked as
      // seen and remembered, so the badge stays away — also after the user
      // opens a different conversation.
      const markSeen = React.useCallback((ids) => {
        const fresh = ids.filter((id) => !seen.has(id))
        if (fresh.length === 0) return
        const next = new Set(seen)
        for (const id of fresh) next.add(id)
        setSeen(next)
        writeSeenModels(fresh)
      }, [seen])

      // Opening the panel is the moment the user is told which models the
      // plugin added. The panel only shows once the status route answered,
      // so the marking waits for the payload; a model that arrives while
      // the panel is open is still news to the user.
      React.useEffect(() => {
        if (!open) {
          toldRef.current = false
          return
        }
        if (toldRef.current) return
        if (payload === null) return
        toldRef.current = true
        markSeen(addedModels)
      }, [open, payload])

```

The badge carries the number, and the locale string that already exists names
it for a screen reader: `modelsAdded` reads "已自动补充 {count} 个新模型" /
"{count} new model(s) added automatically", so no new string is needed. It is
not `aria-hidden` any more, because it now carries a name:

```js
          // The badge is the number of models the user has not been told
          // about, and it carries the locale string as its name, so a screen
          // reader says what the number means.
          unseen.length > 0
            ? h(
                'span',
                {
                  className: '__mmq_badge',
                  'aria-label': t('modelsAdded', { count: unseen.length }),
                },
                unseen.length,
              )
            : null,

```

Add the styles for the models section and the badge to the stylesheet the
client installs, using only theme tokens:

```js
      '.__mmq_models{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.__mmq_sectionTitle{font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:6px}',
      '.__mmq_modelList{display:flex;flex-wrap:wrap;gap:4px}',
      '.__mmq_modelChip{border-radius:var(--dsw-radius-sm);padding:1px 6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.__mmq_modelNotice{margin-top:8px;color:var(--dsw-alias-state-warn-label);font-size:11px}',
      '.__mmq_meta{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.__mmq_badge{position:absolute;top:-6px;right:-8px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color);font-size:10px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none;align-items:center;justify-content:center;display:inline-flex}',
      '.__mmq_pillWrap{position:relative;display:inline-flex}',
```

Every CSS variable has to exist in the installed theme: `--dsw-alias-fill-l2` and
`--dsw-alias-state-warning` do not, so the chip uses `--dsw-alias-bg-layer-2` and the notice uses
`--dsw-alias-state-warn-label`. The badge is a chip that fits a number rather
than a dot, it sits on the corner of the pill, and it takes no pointer events,
so the pill stays clickable underneath it.

Render the badge inside the `__mmq_pillWrap` span that wraps the pill's button,
and render it only while there is something to count. Keep the pill's own
`__mmq_pill` class on the button, so the existing layout is unchanged.

**Opening the panel reads the status once.** The panel can show a reading that
is up to a minute old, because the poll runs on a timer and opening the panel
does not read the status. The read is the one the module already has — it
shares one in-flight read across the page — and it is not cached: the quota has
to reach MiniMax on every read. Closing the panel needs no reading, because it
is about to disappear:

```js
              onClick: () => {
                const opening = !open
                setOpen(opening)
                // Opening is the moment the user wants the freshest reading,
                // so the status route is read once. The read is not cached:
                // the quota has to reach MiniMax every time. Closing the
                // panel needs no reading, because it is about to disappear.
                if (opening) {
                  readStatus().then((result) => {
                    setPayload(result)
                  })
                }
              },
```

- [ ] **Step 5: Add the locale strings**

In `locale/zh.json`, inside the `minimaxQuota` object, add:

```json
"modelsTitle": "已同步的模型",
"modelsAdded": "已自动补充 {count} 个新模型",
"modelsSyncedAt": "模型列表更新于 {when}"
```

In `locale/en.json`, add the same keys in English:

```json
"modelsTitle": "Synced models",
"modelsAdded": "{count} new model(s) added automatically",
"modelsSyncedAt": "Model list updated at {when}"
```

- [ ] **Step 6: Add the manual sync button**

The design calls for a manual sync in the panel, beside the list of synced models, and the Host
already answers `POST /plugin/minimax/sync`. The button asks for a sync and waits for the answer:
the sync probes the candidates MiniMax offers, which can take a while, so the button says that it
is running while it waits. The status route is read again as soon as the POST resolves, so the list
catches up without waiting for the next poll. The Host answers HTTP 200 with `{"ok":false}` when the
sync failed, so the payload — not the status code — is what says whether the sync worked, and a
failure leaves an error line in the panel.

Add the route next to the status route in `client.js`:

```js
const SYNC_ROUTE = '/plugin/minimax/sync'
```

In the dock component, next to the other state, add the syncing flag, the failure line and the request:

```js
  const [syncing, setSyncing] = React.useState(false)
  const [syncError, setSyncError] = React.useState(null)
```

The Host answers HTTP 200 with `{"ok":false}` when a sync fails, so the payload is what says whether
the sync worked, and the status route is refreshed right after the POST resolves:

```js
      // The sync probes the candidates MiniMax offers, which can take a
      // while, so the button asks and waits for the answer. The Host answers
      // HTTP 200 with `{"ok":false}` when the sync failed, so the payload is
      // what says whether the sync worked.
      const syncNow = async () => {
        if (syncing) return
        setSyncing(true)
        setSyncError(null)
        try {
          const response = await fetch(SYNC_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => null)
          if (!response.ok || body?.ok !== true) {
            setSyncError(syncFailureText(body?.reason ?? `HTTP ${response.status}`, t))
          }
        } catch (error) {
          // A failed request leaves the model list as it was, but the user
          // has to see that the sync did not happen.
          setSyncError(syncFailureText(error instanceof Error ? error.message : String(error), t))
        } finally {
          setSyncing(false)
          // The status route is the only thing that reports the model list,
          // so the panel is refreshed right away instead of waiting for the
          // next poll.
          readStatus().then((result) => setPayload(result))
        }
      }
```

The failure line is a locale string, so the panel never shows an internal reason raw:

```js
    /**
     * The line the panel shows when a manual sync did not work.
     *
     * The Host answers with a fixed reason and never with an internal
     * message, so the reason is all the browser can show.
     *
     * @param reason - why the sync failed.
     * @param t - the locale function.
     * @returns the line to show.
     */
    function syncFailureText(reason, t) {
      if (reason === 'missing-credential') return t('missingCredential')
      return t('modelsSyncFailed', { reason })
    }
```

Pass them to the panel. The failure line belongs to the panel and not to the models section: the
section is absent when the status route did not answer, and a failed manual sync has to reach the
user even then.

```js
              h(QuotaPanel, {
                view,
                models,
                t,
                style: position ?? { position: 'fixed', left: '-9999px', top: '-9999px' },
                panelRef: panelNodeRef,
                onSync: syncNow,
                syncing,
                syncError,
              }),
```

The panel draws the line right below the models section:

```js
        h('div', { className: '__mmq_rows' }, rows),
        h(ModelsPanel, { models, t, onSync, syncing }),
        // The sync failure belongs to the panel and not to the models
        // section: the section disappears when the status route did not
        // answer, and a failed manual sync has to reach the user even then.
        syncError ? h('div', { className: '__mmq_error', style: { marginTop: '8px' } }, syncError) : null,
```

And let the models section draw the button, under the synced-at line:

```js
function ModelsPanel({ models, t, onSync, syncing }) {
```

```js
        onSync
          ? h('button', {
              className: '__mmq_syncButton',
              type: 'button',
              disabled: syncing === true,
              onClick: onSync,
            }, syncing === true ? t('modelsSyncing') : t('modelsSync'))
          : null,
```

Add the locale strings to the inline `zh` and `en` dictionaries and to both JSON files:

```json
"modelsSync": "立即同步",
"modelsSyncing": "同步中…",
"modelsSyncFailed": "同步失败：{reason}"
```

```json
"modelsSync": "Sync now",
"modelsSyncing": "Syncing…",
"modelsSyncFailed": "Sync failed: {reason}"
```

And a style for the button, beside the other panel styles. The panel carries `pointer-events:none`, so
the button has to take its events back, and `--dsw-alias-stroke-l2` does not exist in the theme:

```css
'.__mmq_syncButton{margin-top:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:2px 8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;pointer-events:auto}',
'.__mmq_syncButton:disabled{opacity:.6;cursor:default}',
```


- [ ] **Step 7: Fix three things the review found**

**The header comment is now false.** It says the Host answers one same-origin route, and there
are two. Correct it:

```
 * The API key never reaches the browser: the Host answers same-origin
 * routes with the quota view and the model summary, and this half only
 * reads them.
```

**A failed sync is invisible.** `fetch` does not reject on an HTTP error status, and the Host answers
a failed sync with HTTP 200 and `{"ok":false}` — so even a status check passes. The payload's `ok` is
what says whether the sync worked, and the failure has to reach the user; Step 6 reads the payload and
sets the error line the panel shows.

**The panel is locked away exactly when it is most useful.** The panel opened only when the *quota*
succeeded, and the panel is the only place the sync button lives — so a quota that could not be read
locked the models section away with it. The models section does not depend on the quota, so the panel
opens when the **status route answered**:

```js
      // The panel opens on the status route's answer, not on the quota's:
      // the models section and its sync button are independent of the quota,
      // so a quota that could not be read must not lock them away.
      const showPanel = open && payload !== null
```

A quota that could not be read carries no percentages, so the panel says why instead of showing empty
bars:

```js
      // A quota that could not be read carries no percentages at all, so its
      // windows are absent rather than zero.
      const interval = view.ok === true ? view.intervalRemainingPercent : null
      const weekly = view.ok === true ? view.weeklyRemainingPercent : null
```

```js
      if (view.ok !== true) {
        // The quota could not be read, so the panel says why instead of
        // claiming the plan has no limit.
        rows.push(h('div', { className: '__mmq_error' }, view.reason === 'missing-credential'
          ? t('missingCredential')
          : t('requestFailed', { message: view.message ?? '' })))
      } else if (rows.length === 0) {
        rows.push(h('div', { className: '__mmq_hint' }, t('noWeeklyLimit')))
      }
```

**Three theme tokens do not exist.** `--dsw-alias-separator-primary` and `--dsw-alias-label-error`
have no definition in the installed theme, so they fall back to nothing. Use `--dsw-alias-border-l2`
for the separator and `--dsw-alias-state-error-primary` for the error line:

```js
      '.__mmq_sep{color:var(--dsw-alias-border-l2);margin:0 6px}',
      '.__mmq_error{color:var(--dsw-alias-state-error-primary)}',
```

**The sync button cannot be clicked.** The panel carries `pointer-events:none`, so the button has to
take its events back — and it needs a border token that exists:

```js
      '.__mmq_syncButton{...;border:1px solid var(--dsw-alias-border-l2);...;pointer-events:auto}',
```

The credential grep must then look at **added lines only**, because the corrected comment puts the
words "API key" in the diff's context:

```
git diff -U0 -- client.js | grep '^+' | grep -inE "api[-_ ]?key|token|secret|credential|bearer|authorization|x-api-key|password|cookie|MINIMAX_CN_API_KEY"
```

It must come back empty.

- [ ] **Step 8: Test the Browser half**

The Browser half is plain JavaScript that registers a slot, so a test can load it the way the Harness
loads it: read `client.js`, run it with a fake `window` and `document`, and hand its factory a
stand-in for React. The stand-in implements the four hooks the module uses, so the test can render
the pill, click it, and look at what it drew.

Create `test/client.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/**
 * A tiny React stand-in.
 *
 * The browser half hands a component to the slot it registers, so a test
 * needs a renderer to see what the component renders. This one implements
 * the four hooks the module uses, runs the effects after a render, and
 * re-renders when the test asks for it.
 *
 * @returns `{ React, render, unmount }`.
 */
function createReact() {
  const hooks = []
  let cursor = 0

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: { ...props, children: children.length === 1 ? children[0] : children },
      }
    },
    useState(initial) {
      const index = cursor++
      if (hooks.length <= index) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const hook = hooks[index]
      const setValue = (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
      }
      return [hook.value, setValue]
    },
    useRef(initial) {
      const index = cursor++
      if (hooks.length <= index) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback(fn, deps) {
      const index = cursor++
      if (hooks.length <= index) hooks[index] = { deps: undefined, fn }
      const hook = hooks[index]
      const changed = hook.deps === undefined
        || deps === undefined
        || deps.length !== hook.deps.length
        || deps.some((dep, i) => !Object.is(dep, hook.deps[i]))
      if (changed) {
        hook.fn = fn
        hook.deps = deps
      }
      return hook.fn
    },
    useEffect(fn, deps) {
      const index = cursor++
      if (hooks.length <= index) hooks[index] = { deps: undefined, cleanup: undefined }
      const hook = hooks[index]
      const changed = hook.deps === undefined
        || deps === undefined
        || deps.length !== hook.deps.length
        || deps.some((dep, i) => !Object.is(dep, hook.deps[i]))
      hook.deps = deps
      hook.fn = fn
      hook.pending = changed
      if (changed) pending.push(hook)
    },
  }

  const pending = []

  /**
   * Render a tree, running the function components inside it.
   *
   * The module's components are plain functions, so the tree holds them
   * until they are called. None of the nested components uses a hook, so the
   * parent's hook slots stay untouched.
   *
   * @param node - the tree.
   * @returns the rendered tree.
   */
  function renderNode(node) {
    if (Array.isArray(node)) return node.map((child) => renderNode(child))
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (typeof node.type === 'function') return renderNode(node.type(node.props))
    if (node.node !== undefined) return { ...node, node: renderNode(node.node) }
    const children = node.props?.children
    if (children === undefined) return node
    return { ...node, props: { ...node.props, children: renderNode(children) } }
  }

  /**
   * Render the component and run the effects that are due.
   *
   * @param Component - the component to render.
   * @param props - its props.
   * @returns the rendered tree.
   */
  function render(Component, props) {
    cursor = 0
    pending.length = 0
    const tree = renderNode(Component(props))
    for (const hook of pending.splice(0)) {
      if (typeof hook.cleanup === 'function') hook.cleanup()
      const cleanup = hook.fn()
      hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    return tree
  }

  /**
   * Run the cleanups of every effect.
   */
  function unmount() {
    for (const hook of hooks) {
      if (typeof hook.cleanup === 'function') hook.cleanup()
    }
  }

  return { React, render, unmount }
}

/**
 * Every node of a rendered tree, the portals included.
 *
 * @param node - the tree.
 * @returns the nodes.
 */
function nodes(node) {
  if (node === null || node === undefined || node === false) return []
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child))
  if (typeof node !== 'object') return []
  const own = [node]
  if (node.node !== undefined) own.push(...nodes(node.node))
  const children = node.props?.children
  if (children !== undefined) own.push(...nodes(children))
  return own
}

/**
 * The node whose class name carries the given class.
 *
 * @param tree - the rendered tree.
 * @param className - the class to look for.
 * @returns the node, or undefined.
 */
function byClass(tree, className) {
  return nodes(tree).find((node) => {
    const value = node.props?.className
    return typeof value === 'string' && value.split(' ').includes(className)
  })
}

/**
 * The text of a node and of everything below it.
 *
 * @param node - the node.
 * @returns the text.
 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('')
  if (typeof node !== 'object') return ''
  if (node.node !== undefined) return textOf(node.node)
  return textOf(node.props?.children)
}

/**
 * Let the pending work run for a few turns of the event loop.
 *
 * @param rounds - how many turns to wait.
 */
async function flush(rounds = 20) {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * A local storage double.
 *
 * The browser half remembers the models the user has been told about in the
 * browser's own storage, so a test needs one to look at — and one that
 * misbehaves, because a real browser's storage can be missing or can throw.
 *
 * @param options - `{ mode }`: `ok` stores the values, `missing` has no
 *   storage at all, `throw` throws when the storage is touched, and
 *   `failing` has a storage whose every method throws.
 * @returns the storage double.
 */
function createStorage({ mode = 'ok' } = {}) {
  if (mode === 'missing') {
    return {
      mode,
      install() {},
    }
  }
  if (mode === 'throw') {
    return {
      mode,
      install(target) {
        // Some private browsing modes throw when the storage is touched.
        Object.defineProperty(target, 'localStorage', {
          get() {
            throw new Error('the storage is blocked')
          },
          enumerable: true,
          configurable: true,
        })
      },
    }
  }
  if (mode === 'failing') {
    const storage = {
      mode,
      getItem() {
        throw new Error('the storage is blocked')
      },
      setItem() {
        throw new Error('the storage is blocked')
      },
      install(target) {
        target.localStorage = storage
      },
    }
    return storage
  }
  const values = new Map()
  const storage = {
    mode,
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
    install(target) {
      target.localStorage = storage
    },
  }
  return storage
}

/**
 * Load the browser half the way the Harness loads it.
 *
 * The module registers itself with the page's module loader, so the fake
 * loader captures it and the test calls its factory with a stand-in for the
 * module registry.
 *
 * @param options - `{ storage }`: the local storage double to install on
 *   the fake window.
 * @returns `{ module, window }`.
 */
async function loadClient({ storage } = {}) {
  const source = await readFile(CLIENT_PATH, 'utf8')
  let captured = null
  const timers = new Map()
  let nextTimer = 1
  const fakeWindow = {
    __ModuleLoader__: {
      load(module) {
        captured = module
      },
    },
    setInterval(fn, ms) {
      const id = nextTimer++
      timers.set(id, { fn, ms })
      return id
    },
    clearInterval(id) {
      timers.delete(id)
    },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
  }
  if (storage !== undefined) storage.install(fakeWindow)
  const fakeDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
    body: {},
    addEventListener() {},
    removeEventListener() {},
  }
  const evaluate = new Function('window', 'document', source)
  evaluate(fakeWindow, fakeDocument)
  assert.ok(captured !== null, 'the client half did not register itself')
  assert.equal(captured.id, 'dsh-minimax')
  return { module: captured, window: fakeWindow }
}

/**
 * The status route's answer.
 *
 * @param options - `{ ok, models }`.
 * @returns the payload.
 */
function statusPayload({
  ok = true,
  models = { synced: ['MiniMax-M3'], added: [], syncedAt: null },
} = {}) {
  return {
    quota: ok
      ? { ok: true, intervalRemainingPercent: 82, weeklyRemainingPercent: 35, fetchedAt: 1760000000000 }
      : { ok: false, reason: 'missing-credential' },
    models,
  }
}

/**
 * Mount the pill the browser half registers.
 *
 * @param options - `{ fetchImpl, storage }`.
 * @returns the mounted pill: a function that renders it, the dictionaries
 *   it registered, and the requests it made.
 */
async function mountPill({ fetchImpl, storage }) {
  const { module } = await loadClient({ storage })
  const { React, render, unmount } = createReact()
  const ReactDOM = {
    createPortal: (node, container) => ({ node, container }),
  }
  const registered = []
  const dictionaries = []
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (_ns, dict) => dictionaries.push(dict),
    },
    effect: (setup) => {
      const dispose = setup()
      return dispose
    },
    slots: {
      inject: (_name, setup) => {
        setup()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  const client = module.factory((name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return ReactDOM
    throw new Error(`the client half asked for an unknown module: ${name}`)
  })
  client.apply(ctx)
  assert.equal(registered.length, 1)
  const component = registered[0].component
  const props = {
    useProjection: () => ({ next: { provider: 'minimax-cn', model: 'MiniMax-M3' } }),
    // The Harness locale service answers an unregistered key with the key
    // name itself, so the test reads the key. A key that takes parameters
    // carries them along, so a test can see the count.
    t: (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  return {
    dictionaries,
    props,
    render: () => render(component, props),
    unmount,
    // The browser half talks to the routes through the global fetch, so it
    // stays in place until the test is done with the pill.
    dispose() {
      globalThis.fetch = originalFetch
      unmount()
    },
  }
}

/**
 * Run the mounted pill until its tree stops changing.
 *
 * @param pill - the mounted pill.
 * @returns the rendered tree.
 */
async function settle(pill) {
  let tree = pill.render()
  await flush()
  tree = pill.render()
  await flush()
  return pill.render()
}

test('a failed manual sync shows an error line in the panel', async () => {
  const requests = []
  const pill = await mountPill({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET' })
      if (init?.method === 'POST') {
        // The Host answers HTTP 200 with a payload that says the sync failed.
        return new Response(JSON.stringify({ ok: false, reason: 'sync-failed' }), { status: 200 })
      }
      return new Response(JSON.stringify(statusPayload()), { status: 200 })
    },
  })
  try {
    let tree = await settle(pill)
    const pillButton = byClass(tree, '__mmq_pill')
    assert.ok(pillButton !== undefined, 'the pill did not render')
    pillButton.props.onClick()
    await flush()
    tree = pill.render()
    const syncButton = byClass(tree, '__mmq_syncButton')
    assert.ok(syncButton !== undefined, 'the sync button did not render')
    assert.equal(byClass(tree, '__mmq_error'), undefined)
    syncButton.props.onClick()
    await flush()
    tree = pill.render()
    // The failed sync is visible: the panel carries an error line.
    const error = byClass(tree, '__mmq_error')
    assert.ok(error !== undefined, 'the failed sync left no error line')
    assert.equal(textOf(error).includes('modelsSyncFailed'), true)
  } finally {
    pill.dispose()
  }
})

test('a failed manual sync stays visible when the status route also fails', async () => {
  let syncFailed = false
  const pill = await mountPill({
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') {
        syncFailed = true
        // The Host answers HTTP 200 with a payload that says the sync failed.
        return new Response(JSON.stringify({ ok: false, reason: 'sync-failed' }), { status: 200 })
      }
      // The status route fails once the sync failed, so the models section
      // is gone and the panel keeps only the quota's error row.
      if (syncFailed) return new Response('nope', { status: 500 })
      return new Response(JSON.stringify(statusPayload()), { status: 200 })
    },
  })
  try {
    let tree = await settle(pill)
    const pillButton = byClass(tree, '__mmq_pill')
    assert.ok(pillButton !== undefined, 'the pill did not render')
    pillButton.props.onClick()
    await flush()
    tree = pill.render()
    const syncButton = byClass(tree, '__mmq_syncButton')
    assert.ok(syncButton !== undefined, 'the sync button did not render')
    syncButton.props.onClick()
    await flush()
    tree = pill.render()
    // The models section is gone, because the status route did not answer.
    assert.equal(byClass(tree, '__mmq_models'), undefined)
    // The failed sync still has to reach the user.
    const errors = nodes(tree).filter((node) => node.props?.className === '__mmq_error')
    assert.ok(
      errors.some((node) => textOf(node).includes('modelsSyncFailed')),
      'the failed sync left no error line',
    )
  } finally {
    pill.dispose()
  }
})

test('the panel opens when the quota could not be read', async () => {
  const pill = await mountPill({
    fetchImpl: async () => new Response(JSON.stringify(statusPayload({ ok: false })), { status: 200 }),
  })
  try {
    let tree = await settle(pill)
    const pillButton = byClass(tree, '__mmq_pill')
    assert.ok(pillButton !== undefined, 'the pill did not render')
    pillButton.props.onClick()
    await flush()
    tree = pill.render()
    // The models section does not depend on the quota, so the panel and its
    // sync button stay reachable.
    assert.ok(byClass(tree, '__mmq_panel') !== undefined, 'the panel did not open')
    assert.ok(byClass(tree, '__mmq_models') !== undefined, 'the models section did not render')
    assert.ok(byClass(tree, '__mmq_syncButton') !== undefined, 'the sync button did not render')
  } finally {
    pill.dispose()
  }
})

test('a successful manual sync refreshes the model list right away', async () => {
  const requests = []
  let lists = 0
  const pill = await mountPill({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET' })
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, added: ['MiniMax-M3.1-Flash'] }), { status: 200 })
      }
      lists += 1
      return new Response(JSON.stringify(statusPayload({
        models: {
          synced: lists > 1 ? ['MiniMax-M3', 'MiniMax-M3.1-Flash'] : ['MiniMax-M3'],
          added: lists > 1 ? ['MiniMax-M3.1-Flash'] : [],
          syncedAt: null,
        },
      })), { status: 200 })
    },
  })
  try {
    let tree = await settle(pill)
    const pillButton = byClass(tree, '__mmq_pill')
    assert.ok(pillButton !== undefined, 'the pill did not render')
    pillButton.props.onClick()
    await flush()
    tree = pill.render()
    const syncButton = byClass(tree, '__mmq_syncButton')
    assert.ok(syncButton !== undefined, 'the sync button did not render')
    const before = lists
    syncButton.props.onClick()
    await flush()
    tree = pill.render()
    // The list catches up without waiting for the next poll.
    assert.equal(lists, before + 1)
    const chips = nodes(tree).filter((node) => node.props?.className === '__mmq_modelChip')
    assert.deepEqual(chips.map((chip) => textOf(chip)), ['MiniMax-M3', 'MiniMax-M3.1-Flash'])
    // A sync that worked leaves no error line behind.
    assert.equal(byClass(tree, '__mmq_error'), undefined)
  } finally {
    pill.dispose()
  }
})

test('the locale dictionaries and the locale files carry the same keys', async () => {
  const pill = await mountPill({
    fetchImpl: async () => new Response(JSON.stringify(statusPayload()), { status: 200 }),
  })
  try {
    const zh = await readFile(join(dirname(CLIENT_PATH), 'locale', 'zh.json'), 'utf8')
    const en = await readFile(join(dirname(CLIENT_PATH), 'locale', 'en.json'), 'utf8')
    const zhFile = JSON.parse(zh).minimaxQuota
    const enFile = JSON.parse(en).minimaxQuota
    assert.equal(pill.dictionaries.length, 1)
    const [dictionaries] = pill.dictionaries
    // A string that lives in only one of the two places reads as the key
    // name itself in the page, so the two have to agree.
    assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(zhFile).sort())
    assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(enFile).sort())
  } finally {
    pill.dispose()
  }
})

/**
 * A status payload that reports the given added models.
 *
 * @param added - the model ids the plugin added.
 * @returns the payload.
 */
function addedPayload(added) {
  return statusPayload({
    models: {
      synced: ['MiniMax-M3', ...added],
      added,
      syncedAt: null,
    },
  })
}

test('the badge shows how many models the user has not been told about', async () => {
  const storage = createStorage()
  const pill = await mountPill({
    storage,
    fetchImpl: async () => new Response(JSON.stringify(addedPayload(['MiniMax-M2.5', 'MiniMax-M3.1'])), { status: 200 }),
  })
  try {
    const tree = await settle(pill)
    const badge = byClass(tree, '__mmq_badge')
    assert.ok(badge !== undefined, 'the badge did not render')
    // The badge is the number, not a dot.
    assert.equal(textOf(badge), '2')
    // And it is not a mystery: it carries the locale string as its name.
    assert.ok(String(badge.props['aria-label']).includes('modelsAdded'))
    assert.ok(String(badge.props['aria-label']).includes('2'))
    assert.equal(badge.props['aria-hidden'], undefined)
  } finally {
    pill.dispose()
  }
})

test('opening the panel clears the badge and remembers it', async () => {
  const storage = createStorage()
  const pill = await mountPill({
    storage,
    fetchImpl: async () => new Response(JSON.stringify(addedPayload(['MiniMax-M2.5'])), { status: 200 }),
  })
  try {
    let tree = await settle(pill)
    assert.ok(byClass(tree, '__mmq_badge') !== undefined, 'the badge did not render')
    byClass(tree, '__mmq_pill').props.onClick()
    await flush()
    tree = pill.render()
    await flush()
    tree = pill.render()
    assert.equal(byClass(tree, '__mmq_badge'), undefined, 'the badge stayed after the panel opened')
    // The models are remembered, so the next mount does not show them again.
    const stored = JSON.parse(storage.values.get('dsh-minimax.seen-models'))
    assert.deepEqual(stored, ['MiniMax-M2.5'])
  } finally {
    pill.dispose()
  }
})

test('a remount does not bring the badge back', async () => {
  const storage = createStorage()
  const fetchImpl = async () => new Response(JSON.stringify(addedPayload(['MiniMax-M2.5'])), { status: 200 })
  const first = await mountPill({ storage, fetchImpl })
  try {
    let tree = await settle(first)
    byClass(tree, '__mmq_pill').props.onClick()
    await flush()
    tree = first.render()
    await flush()
    tree = first.render()
    assert.equal(byClass(tree, '__mmq_badge'), undefined, 'the badge stayed after the panel opened')
  } finally {
    first.dispose()
  }
  // A fresh component instance — a new conversation, a new tab — reads the
  // same storage, so the badge stays away.
  const second = await mountPill({ storage, fetchImpl })
  try {
    const tree = await settle(second)
    assert.equal(byClass(tree, '__mmq_badge'), undefined, 'the badge came back after a remount')
  } finally {
    second.dispose()
  }
})

test('a model added after the panel was opened brings the badge back', async () => {
  const storage = createStorage()
  let added = ['MiniMax-M2.5']
  const pill = await mountPill({
    storage,
    fetchImpl: async (url, init) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, added: ['MiniMax-M3.1'] }), { status: 200 })
      }
      return new Response(JSON.stringify(addedPayload(added)), { status: 200 })
    },
  })
  try {
    let tree = await settle(pill)
    assert.equal(textOf(byClass(tree, '__mmq_badge')), '1')
    byClass(tree, '__mmq_pill').props.onClick()
    await flush()
    tree = pill.render()
    await flush()
    tree = pill.render()
    assert.equal(byClass(tree, '__mmq_badge'), undefined, 'the badge stayed after the panel opened')
    // The Host adds a model; the panel's sync button asks for a fresh list.
    added = ['MiniMax-M2.5', 'MiniMax-M3.1']
    const syncButton = byClass(tree, '__mmq_syncButton')
    assert.ok(syncButton !== undefined, 'the sync button did not render')
    syncButton.props.onClick()
    await flush()
    tree = pill.render()
    await flush()
    tree = pill.render()
    const badge = byClass(tree, '__mmq_badge')
    assert.ok(badge !== undefined, 'the badge did not come back for the new model')
    // Only the model the user has not been told about counts.
    assert.equal(textOf(badge), '1')
  } finally {
    pill.dispose()
  }
})

test('a storage that is missing or that throws does not break the plugin', async () => {
  for (const mode of ['missing', 'throw', 'failing']) {
    const storage = createStorage({ mode })
    const pill = await mountPill({
      storage,
      fetchImpl: async () => new Response(JSON.stringify(addedPayload(['MiniMax-M2.5'])), { status: 200 }),
    })
    try {
      let tree = await settle(pill)
      // The pill renders…
      assert.ok(byClass(tree, '__mmq_pill') !== undefined, `the pill did not render with the ${mode} storage`)
      // …and the badge is still there, because nothing was remembered.
      const badge = byClass(tree, '__mmq_badge')
      assert.ok(badge !== undefined, `the badge did not render with the ${mode} storage`)
      assert.equal(textOf(badge), '1')
      // Opening the panel must not throw either.
      byClass(tree, '__mmq_pill').props.onClick()
      await flush()
      tree = pill.render()
      await flush()
      tree = pill.render()
      assert.ok(byClass(tree, '__mmq_panel') !== undefined, `the panel did not open with the ${mode} storage`)
    } finally {
      pill.dispose()
    }
  }
})

test('opening the panel reads the status once', async () => {
  const requests = []
  const pill = await mountPill({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET' })
      return new Response(JSON.stringify(statusPayload()), { status: 200 })
    },
  })
  try {
    let tree = await settle(pill)
    const before = requests.length
    // Opening the panel is the moment the user wants the freshest reading.
    byClass(tree, '__mmq_pill').props.onClick()
    await flush()
    tree = pill.render()
    assert.equal(requests.length, before + 1, 'opening the panel did not read the status once')
    // Closing it needs no reading: the panel is about to disappear.
    byClass(tree, '__mmq_pill').props.onClick()
    await flush()
    tree = pill.render()
    assert.equal(requests.length, before + 1, 'closing the panel read the status again')
  } finally {
    pill.dispose()
  }
})
```

The four tests cover the four things a user would notice```

The eleven tests cover the things a user would notice: a failed manual sync leaves an error line
in the panel, that line survives a status route that failed as well, the panel opens even when the
quota could not be read, a successful manual sync refreshes the model list right away instead of
waiting for the next poll, and the locale files and the inline dictionaries agree. The six the
notice marker needs are the rest: the badge counts the models the user has not been told about,
opening the panel clears it and remembers the models, a fresh component instance — a new
conversation — does not bring it back, a model the plugin adds later brings it back with the new
count, a storage that is missing or that throws leaves the plugin working, and opening the panel
reads the status once.

The storage double is part of the test, because the browser half has to survive a storage that
does not work: `missing` has no storage at all, `throw` throws when the storage is touched — some
private browsing modes do — and `failing` has a storage whose every method throws.

- [ ] **Step 9: The browser half as committed**

The plan carries the committed file, byte for byte, so the plan and the code cannot drift apart:

```js
/**
 * Browser half of the MiniMax quota bundle.
 *
 * Registers one entry in `conversation.composer.dock`: when the session's
 * selected model belongs to the MiniMax family, it shows the remaining 5-hour
 * and weekly coding-plan quota, and clicking it opens a details panel.
 *
 * Nothing confidential reaches the browser: the Host answers same-origin
 * routes with the quota view and the model summary, and this half only
 * talks to those routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-minimax',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ReactDOM = require('react-dom')

    // ── locale ────────────────────────────────────────────────────────────
    const NS = 'minimaxQuota'
    const zh = {
      intervalLabel: '5小时',
      weeklyLabel: '周',
      remaining: '剩余 {percent}%',
      intervalReset: '5 小时窗口将于 {when} 重置',
      weeklyReset: '周窗口将于 {when} 重置',
      noWeeklyLimit: '当前套餐没有周额度限制。',
      unavailable: '无法获取 MiniMax 额度',
      missingCredential: '尚未配置 MiniMax 凭据。',
      requestFailed: '无法连接 MiniMax：{message}',
      loading: '正在读取 MiniMax 额度…',
      panelTitle: 'MiniMax 额度',
      panelSubtitle: '编程套餐剩余额度',
      used: '已使用 {percent}%',
      panelIntervalTitle: '5 小时窗口',
      panelWeeklyTitle: '周窗口',
      panelResetIn: '距离重置还有 {duration}',
      panelFetchedAt: '更新于 {when}',
      panelModel: '模型分组：{name}',
      modelsTitle: '已同步的模型',
      modelsAdded: '已自动补充 {count} 个新模型',
      modelsSyncedAt: '模型列表更新于 {when}',
      modelsSync: '立即同步',
      modelsSyncing: '同步中…',
      modelsSyncFailed: '同步失败：{reason}',
      daily: '{days} 天 {hours} 小时',
      hours: '{hours} 小时 {minutes} 分钟',
      minutes: '{minutes} 分钟',
      seconds: '{seconds} 秒',
    }
    const en = {
      intervalLabel: '5h',
      weeklyLabel: 'Week',
      remaining: '{percent}% left',
      intervalReset: '5-hour window resets {when}',
      weeklyReset: 'Weekly window resets {when}',
      noWeeklyLimit: 'This plan has no weekly limit.',
      unavailable: 'MiniMax quota unavailable',
      missingCredential: 'No MiniMax credential is configured.',
      requestFailed: 'Could not reach MiniMax: {message}',
      loading: 'Reading MiniMax quota…',
      panelTitle: 'MiniMax quota',
      panelSubtitle: 'Coding plan remaining',
      used: '{percent}% used',
      panelIntervalTitle: '5-hour window',
      panelWeeklyTitle: 'Weekly window',
      panelResetIn: 'Resets in {duration}',
      panelFetchedAt: 'Updated {when}',
      panelModel: 'Model bucket: {name}',
      modelsTitle: 'Synced models',
      modelsAdded: '{count} new model(s) added automatically',
      modelsSyncedAt: 'Model list updated at {when}',
      modelsSync: 'Sync now',
      modelsSyncing: 'Syncing…',
      modelsSyncFailed: 'Sync failed: {reason}',
      daily: '{days}d {hours}h',
      hours: '{hours}h {minutes}m',
      minutes: '{minutes}m',
      seconds: '{seconds}s',
    }

    // ── styles (theme tokens only) ────────────────────────────────────────
    const CSS = [
      '.__mmq_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.__mmq_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
      '.__mmq_pill:hover,.__mmq_pill:focus-visible,.__mmq_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.__mmq_pill svg{flex:none;width:14px;height:14px}',
      '.__mmq_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.__mmq_sep{color:var(--dsw-alias-border-l2);margin:0 6px}',
      '.__mmq_group{display:inline-flex;align-items:center;gap:4px}',
      '.__mmq_dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary)}',
      '.__mmq_dotLow{background:var(--dsw-alias-state-warn-primary)}',
      '.__mmq_dotCritical{background:var(--dsw-alias-state-error-primary)}',
      '.__mmq_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed;pointer-events:none}',
      '.__mmq_title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
      '.__mmq_titleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      '.__mmq_titleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}',
      '.__mmq_titleLabel svg{flex:none;width:14px;height:14px}',
      '.__mmq_subtitle{color:var(--dsw-alias-label-tertiary);margin:0 0 10px}',
      '.__mmq_rows{display:flex;flex-direction:column;gap:10px}',
      '.__mmq_row{display:flex;flex-direction:column;gap:4px}',
      '.__mmq_rowHead{display:flex;justify-content:space-between;align-items:baseline;gap:12px}',
      '.__mmq_rowName{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.__mmq_rowValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.__mmq_bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.__mmq_barFill{height:100%;border-radius:2px;background:var(--dsw-alias-state-success-primary)}',
      '.__mmq_barFillLow{background:var(--dsw-alias-state-warn-primary)}',
      '.__mmq_barFillCritical{background:var(--dsw-alias-state-error-primary)}',
      '.__mmq_hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.__mmq_error{color:var(--dsw-alias-state-error-primary)}',
      '.__mmq_models{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.__mmq_sectionTitle{font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:6px}',
      '.__mmq_modelList{display:flex;flex-wrap:wrap;gap:4px}',
      '.__mmq_modelChip{border-radius:var(--dsw-radius-sm);padding:1px 6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.__mmq_modelNotice{margin-top:8px;color:var(--dsw-alias-state-warn-label);font-size:11px}',
      '.__mmq_meta{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.__mmq_syncButton{margin-top:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:2px 8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;pointer-events:auto}',
      '.__mmq_syncButton:disabled{opacity:.6;cursor:default}',
      '.__mmq_badge{position:absolute;top:-6px;right:-8px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color);font-size:10px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none;align-items:center;justify-content:center;display:inline-flex}',
      '.__mmq_pillWrap{position:relative;display:inline-flex}',
    ].join('')

    function installStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-minimax/client.css'
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-minimax'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── helpers ───────────────────────────────────────────────────────────
    /** The route that answers the quota view and the model summary. */
    const STATUS_ROUTE = '/plugin/minimax/status'

    /** The route that asks the Host for a model sync. */
    const SYNC_ROUTE = '/plugin/minimax/sync'

    /** Providers whose routes serve the MiniMax model family. */
    function isMiniMaxProvider(provider) {
      if (typeof provider !== 'string') return false
      const id = provider.toLowerCase()
      return id.includes('minimax')
    }

    /** Whether one selected model id belongs to the MiniMax family. */
    function isMiniMaxModel(model) {
      if (typeof model !== 'string') return false
      return model.toLowerCase().includes('minimax')
    }

    /** Whether the current selection should show the quota entry. */
    function selectionIsMiniMax(selection) {
      if (selection == null) return false
      return isMiniMaxProvider(selection.provider) || isMiniMaxModel(selection.model)
    }

    /** Format a millisecond duration as a coarse, human-readable span. */
    function formatDuration(ms, t) {
      if (!Number.isFinite(ms) || ms <= 0) return t('seconds', { seconds: 0 })
      const totalMinutes = Math.floor(ms / 60000)
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      const seconds = Math.floor((ms % 60000) / 1000)
      if (days > 0) return t('daily', { days, hours })
      if (hours > 0) return t('hours', { hours, minutes })
      if (minutes > 0) return t('minutes', { minutes })
      return t('seconds', { seconds })
    }

    /** Format an epoch-millisecond instant as a local clock time. */
    function formatClock(epochMs) {
      if (!Number.isFinite(epochMs)) return '—'
      try {
        return new Date(epochMs).toLocaleTimeString()
      } catch {
        return '—'
      }
    }

    /** The severity class for a remaining percentage, used by the small dot. */
    function severityClass(percent) {
      if (percent === null) return ''
      if (percent <= 15) return ' __mmq_critical'
      if (percent <= 40) return ' __mmq_low'
      return ''
    }

    /** The severity class for the wide bar, whose fill carries its own class. */
    function barSeverityClass(percent) {
      if (percent === null) return ''
      if (percent <= 15) return ' __mmq_barFillCritical'
      if (percent <= 40) return ' __mmq_barFillLow'
      return ''
    }

    // ── the models the user has been told about ───────────────────────────
    /** The storage key that holds the ids of the models the user was told about. */
    const SEEN_MODELS_KEY = 'dsh-minimax.seen-models'

    /**
     * The model ids the storage holds.
     *
     * The stored value is a JSON array of model ids. A value that is not
     * such an array — or that is not JSON at all — holds nothing, so it is
     * read as the empty set.
     *
     * @param storage - the browser's local storage.
     * @returns `{ ok, ids }`: `ok` says whether the stored value could be
     *   read at all, `ids` holds the model ids it names.
     */
    function storedSeenModels(storage) {
      let raw
      try {
        raw = storage.getItem(SEEN_MODELS_KEY)
      } catch {
        // A storage that refuses to be read holds nothing that can be
        // trusted, so a write must not replace it.
        return { ok: false, ids: new Set() }
      }
      if (raw === null || raw === undefined) return { ok: true, ids: new Set() }
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return { ok: true, ids: new Set() }
        return { ok: true, ids: new Set(parsed.filter((id) => typeof id === 'string')) }
      } catch {
        // A corrupt value holds nothing, so it is read as the empty set and
        // the next write repairs it.
        return { ok: true, ids: new Set() }
      }
    }

    /**
     * The models the user has already been told about.
     *
     * The set lives in the browser's own storage, so it survives a remount,
     * a new conversation, a new tab and a restart of the app — which is what
     * the badge needs, because the pill is mounted in the chat composer and
     * a conversation switch mounts it again.
     *
     * The storage can be missing, can throw when it is touched and can hold
     * a corrupt value, so every access degrades to the empty set instead of
     * throwing.
     *
     * @returns the set of seen model ids.
     */
    function readSeenModels() {
      try {
        const storage = window.localStorage
        if (storage === null || storage === undefined) return new Set()
        return storedSeenModels(storage).ids
      } catch {
        // Some private browsing modes throw when the storage is touched.
        return new Set()
      }
    }

    /**
     * Remember the models the user has been told about.
     *
     * The write merges: the ids are added to what is already stored, so a
     * model the user was told about earlier stays remembered. A storage that
     * cannot be written to leaves the plugin working, just without the
     * memory.
     *
     * @param ids - the model ids to remember.
     */
    function writeSeenModels(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return
      try {
        const storage = window.localStorage
        if (storage === null || storage === undefined) return
        const stored = storedSeenModels(storage)
        // A value that could not be read is not replaced: the write would
        // drop what is already stored.
        if (!stored.ok) return
        for (const id of ids) {
          if (typeof id === 'string') stored.ids.add(id)
        }
        storage.setItem(SEEN_MODELS_KEY, JSON.stringify([...stored.ids]))
      } catch {
        // A storage that refuses to be written to leaves the plugin working.
      }
    }

    // ── status fetching ────────────────────────────────────────────────────
    /**
     * One in-flight status read shared by every subscriber of this page, so a
     * remount does not multiply upstream calls.
     */
    let pending = null

    /** How often the reading refreshes while a MiniMax model is selected. */
    const REFRESH_INTERVAL_MS = 60_000

    /**
     * The quota view of a status payload.
     *
     * A payload without a quota is malformed, so it reads as the failure the
     * browser already knows how to show.
     *
     * @param payload - the status payload.
     * @returns the quota view.
     */
    function quotaView(payload) {
      return payload?.quota ?? { ok: false, reason: 'request-failed', message: 'Malformed response.' }
    }

    /**
     * The line the panel shows when a manual sync did not work.
     *
     * The Host answers with a fixed reason and never with an internal
     * message, so the reason is all the browser can show.
     *
     * @param reason - why the sync failed.
     * @param t - the locale function.
     * @returns the line to show.
     */
    function syncFailureText(reason, t) {
      if (reason === 'missing-credential') return t('missingCredential')
      return t('modelsSyncFailed', { reason })
    }

    /**
     * Read the status route: the quota view and the model summary.
     *
     * @returns a promise for `{ quota, models }`.
     */
    function readStatus() {
      if (pending !== null) return pending
      pending = fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          return { quota: quotaView(payload), models: payload?.models }
        })
        .catch((error) => ({
          quota: {
            ok: false,
            reason: 'request-failed',
            message: error instanceof Error ? error.message : String(error),
          },
          models: undefined,
        }))
        .finally(() => {
          pending = null
        })
      return pending
    }

    // ── components ─────────────────────────────────────────────────────────
    /** The gauge mark shown ahead of the quota numbers. */
    function QuotaIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 14,
          height: 14,
          fill: 'none',
          'aria-hidden': true,
        },
        h('circle', {
          cx: 12,
          cy: 12,
          r: 8.5,
          stroke: 'currentColor',
          strokeWidth: 2,
          opacity: 0.35,
        }),
        h('path', {
          d: 'M12 3.5a8.5 8.5 0 0 1 7.36 4.25',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * The anchored panel: one card per quota window, each with a bar and
     * the moment its window resets, the models section, and the line that
     * reports a failed manual sync.
     */
    function QuotaPanel({ view, models, t, style, panelRef, onSync, syncing, syncError }) {
      const rows = []
      // A quota that could not be read carries no percentages at all, so its
      // windows are absent rather than zero.
      const interval = view.ok === true ? view.intervalRemainingPercent : null
      const weekly = view.ok === true ? view.weeklyRemainingPercent : null
      if (interval !== null) {
        rows.push(
          h(
            'div',
            { className: '__mmq_row', key: 'interval' },
            h(
              'div',
              { className: '__mmq_rowHead' },
              h('span', { className: '__mmq_rowName' }, t('panelIntervalTitle')),
              h(
                'span',
                { className: '__mmq_rowValue' },
                t('remaining', { percent: interval }),
              ),
            ),
            h(
              'div',
              { className: '__mmq_bar' },
              h('div', {
                className: `__mmq_barFill${barSeverityClass(interval)}`,
                style: { width: `${Math.max(0, Math.min(100, interval))}%` },
              }),
            ),
            h(
              'div',
              { className: '__mmq_hint' },
              t('panelResetIn', {
                duration: formatDuration(view.intervalResetAt - Date.now(), t),
              }),
            ),
          ),
        )
      }
      if (weekly !== null) {
        rows.push(
          h(
            'div',
            { className: '__mmq_row', key: 'weekly' },
            h(
              'div',
              { className: '__mmq_rowHead' },
              h('span', { className: '__mmq_rowName' }, t('panelWeeklyTitle')),
              h(
                'span',
                { className: '__mmq_rowValue' },
                t('remaining', { percent: weekly }),
              ),
            ),
            h(
              'div',
              { className: '__mmq_bar' },
              h('div', {
                className: `__mmq_barFill${barSeverityClass(weekly)}`,
                style: { width: `${Math.max(0, Math.min(100, weekly))}%` },
              }),
            ),
            h(
              'div',
              { className: '__mmq_hint' },
              t('panelResetIn', {
                duration: formatDuration(view.weeklyResetAt - Date.now(), t),
              }),
            ),
          ),
        )
      }
      if (view.ok !== true) {
        // The quota could not be read, so the panel says why instead of
        // claiming the plan has no limit.
        rows.push(h('div', { className: '__mmq_error' }, view.reason === 'missing-credential'
          ? t('missingCredential')
          : t('requestFailed', { message: view.message ?? '' })))
      } else if (rows.length === 0) {
        rows.push(h('div', { className: '__mmq_hint' }, t('noWeeklyLimit')))
      }
      return h(
        'div',
        {
          ref: panelRef,
          className: '__mmq_panel',
          role: 'dialog',
          'aria-label': t('panelTitle'),
          style,
        },
        h(
          'div',
          { className: '__mmq_title' },
          h(
            'span',
            { className: '__mmq_titleLabel' },
            h(QuotaIcon, null),
            t('panelTitle'),
          ),
        ),
        h('div', { className: '__mmq_titleRule', 'aria-hidden': true }),
        h('p', { className: '__mmq_subtitle' }, t('panelSubtitle')),
        h('div', { className: '__mmq_rows' }, rows),
        h(ModelsPanel, { models, t, onSync, syncing }),
        // The sync failure belongs to the panel and not to the models
        // section: the section disappears when the status route did not
        // answer, and a failed manual sync has to reach the user even then.
        syncError ? h('div', { className: '__mmq_error', style: { marginTop: '8px' } }, syncError) : null,
        h(
          'div',
          { className: '__mmq_hint', style: { marginTop: '10px' } },
          t('panelFetchedAt', { when: formatClock(view.fetchedAt) }),
        ),
      )
    }

    /**
     * The models section: the ids the profile currently holds, how many of
     * them the plugin added, the moment the list was last written, and the
     * button that asks the Host for a fresh sync.
     *
     * The section never edits the list itself: the plugin appends and never
     * edits, so the models it added are the user's to keep or to remove by
     * hand. The button only asks; the sync itself runs on the Host.
     *
     * The section shows even when no model has been synced yet, so the sync
     * button is reachable in exactly the state where it is most useful.
     *
     * The section is absent when the status route did not answer, so the
     * line that reports a failed manual sync belongs to the panel.
     */
    function ModelsPanel({ models, t, onSync, syncing }) {
      if (models === undefined) return null
      const synced = Array.isArray(models.synced) ? models.synced : []
      const added = Array.isArray(models.added) ? models.added : []
      return h('div', { className: '__mmq_models' },
        h('div', { className: '__mmq_sectionTitle' }, t('modelsTitle')),
        synced.length > 0
          ? h('div', { className: '__mmq_modelList' },
              synced.map((id) => h('span', { className: '__mmq_modelChip', key: id }, id)),
            )
          : null,
        added.length > 0
          ? h('div', { className: '__mmq_modelNotice' }, t('modelsAdded', { count: added.length }))
          : null,
        models.syncedAt ? h('div', { className: '__mmq_meta' }, t('modelsSyncedAt', { when: formatClock(models.syncedAt) })) : null,
        onSync
          ? h('button', {
              className: '__mmq_syncButton',
              type: 'button',
              disabled: syncing === true,
              onClick: onSync,
            }, syncing === true ? t('modelsSyncing') : t('modelsSync'))
          : null,
      )
    }

    /**
     * The dock entry: a compact reading with a click-opened panel carrying
     * the detail.
     */
    function MiniMaxQuotaPill(props) {
      const { useProjection, t } = props
      const selection = useProjection('modelSelection')
      const current = selection?.next ?? selection?.lastUsed ?? null
      const active = selectionIsMiniMax(current)
      const [payload, setPayload] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [seen, setSeen] = React.useState(() => readSeenModels())
      const [syncing, setSyncing] = React.useState(false)
      const [syncError, setSyncError] = React.useState(null)
      const [position, setPosition] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      // Whether the models of this panel opening have been told already.
      const toldRef = React.useRef(false)

      // The status route answers both halves: the quota the pill shows and
      // the model summary the panel lists.
      const view = payload?.quota ?? null
      const models = payload?.models

      // The sync probes the candidates MiniMax offers, which can take a
      // while, so the button asks and waits for the answer. The Host answers
      // HTTP 200 with `{"ok":false}` when the sync failed, so the payload is
      // what says whether the sync worked.
      const syncNow = async () => {
        if (syncing) return
        setSyncing(true)
        setSyncError(null)
        try {
          const response = await fetch(SYNC_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
          const body = await response.json().catch(() => null)
          if (!response.ok || body?.ok !== true) {
            setSyncError(syncFailureText(body?.reason ?? `HTTP ${response.status}`, t))
          }
        } catch (error) {
          // A failed request leaves the model list as it was, but the user
          // has to see that the sync did not happen.
          setSyncError(syncFailureText(error instanceof Error ? error.message : String(error), t))
        } finally {
          setSyncing(false)
          // The status route is the only thing that reports the model list,
          // so the panel is refreshed right away instead of waiting for the
          // next poll.
          readStatus().then((result) => setPayload(result))
        }
      }

      // Read the quota whenever a MiniMax model is the active selection, and
      // refresh it on a slow cadence so the reading stays current.
      React.useEffect(() => {
        if (!active) {
          setPayload(null)
          return undefined
        }
        let alive = true
        const refresh = () => {
          readStatus().then((result) => {
            if (alive) setPayload(result)
          })
        }
        refresh()
        const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [active, current?.provider, current?.model])

      // The badge counts the models the plugin added that the user has not
      // been told about yet. The plugin's own list of added models is
      // cumulative, so the count — not the list — is what says whether
      // there is news.
      const addedModels = Array.isArray(payload?.models?.added) ? payload.models.added : []
      const unseen = addedModels.filter((id) => !seen.has(id))

      // Tell the user about the models the plugin added: they are marked as
      // seen and remembered, so the badge stays away — also after the user
      // opens a different conversation.
      const markSeen = React.useCallback((ids) => {
        const fresh = ids.filter((id) => !seen.has(id))
        if (fresh.length === 0) return
        const next = new Set(seen)
        for (const id of fresh) next.add(id)
        setSeen(next)
        writeSeenModels(fresh)
      }, [seen])

      // Opening the panel is the moment the user is told which models the
      // plugin added. The panel only shows once the status route answered,
      // so the marking waits for the payload; a model that arrives while
      // the panel is open is still news to the user.
      React.useEffect(() => {
        if (!open) {
          toldRef.current = false
          return
        }
        if (toldRef.current) return
        if (payload === null) return
        toldRef.current = true
        markSeen(addedModels)
      }, [open, payload])

      // Place the panel above the trigger, inside the viewport. The panel is
      // portaled into the document body, so its node attaches after this
      // effect's first pass; a callback ref places it once the node exists.
      const placePanel = React.useCallback(() => {
        const anchor = rootRef.current
        const panel = panelRef.current
        if (anchor === null || panel === null) return
        const rect = anchor.getBoundingClientRect()
        const size = panel.getBoundingClientRect()
        const margin = 12
        let left = rect.left + rect.width / 2 - size.width / 2
        left = Math.max(margin, Math.min(left, window.innerWidth - size.width - margin))
        let top = rect.top - size.height - 8
        if (top < margin) top = rect.bottom + 8
        setPosition({ position: 'fixed', left: `${left}px`, top: `${top}px` })
      }, [])

      const panelNodeRef = React.useCallback(
        (node) => {
          panelRef.current = node
          if (node !== null) placePanel()
        },
        [placePanel],
      )

      React.useEffect(() => {
        if (!open) return undefined
        placePanel()
        window.addEventListener('resize', placePanel)
        window.addEventListener('scroll', placePanel, true)
        return () => {
          window.removeEventListener('resize', placePanel)
          window.removeEventListener('scroll', placePanel, true)
        }
      }, [open, view, placePanel])

      // Close on Escape or an outside pointer press.
      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointerDown = (event) => {
          const target = event.target
          if (!(target instanceof Node)) return
          if (rootRef.current?.contains(target) === true) return
          if (panelRef.current?.contains(target) === true) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open])

      // A pay-as-you-go account has no plan quota, so the entry stays out of
      // the dock entirely rather than showing an empty reading.
      if (!active) return null
      if (view !== null && view.ok !== true && view.reason === 'no-plan') return null

      let label
      if (view === null) {
        label = t('loading')
      } else if (view.ok !== true) {
        label =
          view.reason === 'missing-credential'
            ? t('missingCredential')
            : t('requestFailed', { message: view.message ?? '' })
      } else {
        const parts = []
        if (view.intervalRemainingPercent !== null) {
          parts.push(
            h(
              'span',
              { className: '__mmq_group', key: 'interval' },
              h('span', { className: `__mmq_dot${severityClass(view.intervalRemainingPercent)}` }),
              h('span', null, `${t('intervalLabel')} ${view.intervalRemainingPercent}%`),
            ),
          )
        }
        if (view.weeklyRemainingPercent !== null) {
          parts.push(
            h(
              'span',
              { className: '__mmq_group', key: 'weekly' },
              h('span', { className: `__mmq_dot${severityClass(view.weeklyRemainingPercent)}` }),
              h('span', null, `${t('weeklyLabel')} ${view.weeklyRemainingPercent}%`),
            ),
          )
        }
        label =
          parts.length === 0
            ? t('noWeeklyLimit')
            : parts.flatMap((part, index) =>
                index === 0
                  ? [part]
                  : [
                      h(
                        'span',
                        { className: '__mmq_sep', key: `sep-${index}`, 'aria-hidden': true },
                        '·',
                      ),
                      part,
                    ],
              )
      }

      // The panel opens on the status route's answer, not on the quota's:
      // the models section and its sync button are independent of the quota,
      // so a quota that could not be read must not lock them away.
      const showPanel = open && payload !== null

      // A screen reader gets the same two numbers the pill shows.
      const ariaLabel =
        view !== null && view.ok === true
          ? [
              view.intervalRemainingPercent !== null
                ? t('remaining', { percent: view.intervalRemainingPercent })
                : null,
              view.weeklyRemainingPercent !== null
                ? t('remaining', { percent: view.weeklyRemainingPercent })
                : null,
            ]
              .filter((part) => part !== null)
              .join(' · ')
          : undefined

      return h(
        'span',
        { ref: rootRef, className: '__mmq_anchor', 'data-composer-stat': 'minimax-quota' },
        h(
          'span',
          { className: '__mmq_pillWrap' },
          h(
            'button',
            {
              type: 'button',
              className: '__mmq_pill',
              'aria-haspopup': 'dialog',
              'aria-expanded': showPanel,
              'aria-label': ariaLabel,
              onClick: () => {
                const opening = !open
                setOpen(opening)
                // Opening is the moment the user wants the freshest reading,
                // so the status route is read once. The read is not cached:
                // the quota has to reach MiniMax every time. Closing the
                // panel needs no reading, because it is about to disappear.
                if (opening) {
                  readStatus().then((result) => {
                    setPayload(result)
                  })
                }
              },
            },
            h(QuotaIcon, null),
            h('span', { className: '__mmq_label' }, label),
          ),
          // The badge is the number of models the user has not been told
          // about, and it carries the locale string as its name, so a screen
          // reader says what the number means.
          unseen.length > 0
            ? h(
                'span',
                {
                  className: '__mmq_badge',
                  'aria-label': t('modelsAdded', { count: unseen.length }),
                },
                unseen.length,
              )
            : null,
        ),
        showPanel
          ? ReactDOM.createPortal(
              h(QuotaPanel, {
                view,
                models,
                t,
                style: position ?? { position: 'fixed', left: '-9999px', top: '-9999px' },
                panelRef: panelNodeRef,
                onSync: syncNow,
                syncing,
                syncError,
              }),
              document.body,
            )
          : null,
      )
    }

    // ── plugin ─────────────────────────────────────────────────────────────
    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'minimax-quota: dictionaries')
      ctx.effect(() => installStyles(), 'minimax-quota: styles')
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'minimax-quota',
            order: 2,
            locale: NS,
          },
          MiniMaxQuotaPill,
        ),
      )
    }

    return { inject, apply }
  },
})
```

- [ ] **Step 10: Run the checks**

Run: `npm test`
Expected: PASS — the suite plus both syntax checks.

- [ ] **Step 11: Verify the locale JSON parses**

Run: `node -e "for (const f of ['locale/zh.json','locale/en.json']) { JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('ok', f) }"`
Expected: `ok locale/zh.json` and `ok locale/en.json`.

- [ ] **Step 12: Commit**

```bash
git add client.js locale/zh.json locale/en.json test/client.test.js
git commit -m "feat: show the synced models and mark new ones in the Browser half

The pill carries a badge when the plugin appended a model, and the
details panel lists the models the profile currently holds."
```

---

## Task 9: Rename the bundle to `dsh-minimax`

The package name changes so the bundle can carry both jobs. The GitHub repository URL does not change, so the community catalog pull request stays valid.

**Files:**
- Modify: `package.json`
- Modify: `client.js`
- Modify: `cordis.patch.yml`
- Modify: `dsh-plugin.json`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a bundle whose package name, client module id and patch row id all read `dsh-minimax` / `minimax`.

- [ ] **Step 1: Rename the package**

In `package.json`, change `"name": "dsh-minimax-quota"` to `"name": "dsh-minimax"`, and update the description to cover both jobs:

```json
  "description": "Shows the remaining MiniMax coding-plan quota below the DeepSeek Harness chat composer, and keeps the profile's MiniMax model list current by appending newly released models.",
```

Bump the version to `1.1.0`.

The `files` array must ship every runtime import — `lib/`, the locale files, the icon, the patch — and
every file the READMEs link relatively, and nothing else. npm always leaves `package-lock.json` out of
a tarball, and the plan and the design document are not runtime files. The relative links are the two
images and the catalog entry, so the array names those three paths one by one rather than the
directories they live in — `docs/` also holds the plan and the design document:

```json
  "files": [
    "LICENSE",
    "README.en.md",
    "README.md",
    "catalog/awesome-dsh-plugin.yml",
    "client.js",
    "cordis.patch.yml",
    "dsh-plugin.json",
    "docs/market-entry.png",
    "docs/screenshot-panel.png",
    "icon.svg",
    "index.js",
    "lib",
    "locale/*.json"
  ],
```

- [ ] **Step 2: Rename the client module id and the Host's message prefix**

In `client.js`, change the module id:

```js
  id: 'dsh-minimax',
```

This must equal the package name exactly, or the Loader cannot find the browser half.

In `index.js`, the Host still labels itself `dsh-minimax-quota` in its error messages
and in the schema vendor, while the package is named `dsh-minimax` from now on.
Bring the two into step:

```bash
sed -i '' "s/dsh-minimax-quota:/dsh-minimax:/g; s/vendor: 'dsh-minimax-quota',/vendor: 'dsh-minimax',/g" index.js
```

After the sed, `index.js` must contain no `dsh-minimax-quota` string. Verify with:

```bash
grep -n "dsh-minimax" index.js
```

Expected: every occurrence reads `dsh-minimax`, none reads `dsh-minimax-quota`.

- [ ] **Step 3: Rename the lockfile entry**

The lockfile carries the package name in two places. Change both, so `npm ci` and
`pnpm install` keep working:

```bash
node -e "
  const fs = require('fs');
  const file = 'package-lock.json';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.name = 'dsh-minimax';
  if (data.packages && data.packages['']) data.packages[''].name = 'dsh-minimax';
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
"
```

- [ ] **Step 4: Rename the patch row**

In `cordis.patch.yml`:

```yaml
- insert:
    - id: minimax
      name: 'dsh-minimax'
      config:
        credentialRef: MINIMAX_CN_API_KEY
```

- [ ] **Step 5: Update the plugin manifest**

In `dsh-plugin.json`, change the `id` and the `name` to read `dsh-minimax`, and update the `description` to mention the model sync. Keep the `version` in step with `package.json`.

- [ ] **Step 6: Update the CI checks**

In `.github/workflows/ci.yml`, the patch check asserts the old name. Replace it:

```yaml
      - name: Validate the bundle patch
        run: |
          node -e "
            const fs = require('fs');
            const text = fs.readFileSync('cordis.patch.yml', 'utf8');
            if (!/^\s*-\s*insert:/m.test(text)) throw new Error('patch has no insert list');
            if (!/name:\s*'dsh-minimax'/.test(text)) throw new Error('patch does not insert this package');
            console.log('ok cordis.patch.yml');
          "
```

The workflow also has to run the test suite. It currently only syntax-checks the two
halves, so a regression inside `lib/` would ship green. Replace the syntax-check step
with the test script — the script already runs both syntax checks:

```yaml
      - name: Run the test suite
        run: npm test
```

After the change the workflow must contain no step named "Check JavaScript syntax".
Verify with:

```bash
grep -n "npm test\|Check JavaScript syntax" .github/workflows/ci.yml
```

Expected: one line naming `npm test`, no line naming `Check JavaScript syntax`.

The credential guard must not skip the READMEs: a key pasted into a README is a committed secret like
any other, so the exclusion goes:

```yaml
      - name: Guard against committed secrets
        run: |
          # No real API key may ever enter the repository, and the READMEs
          # are part of it: a key pasted into a README is a committed secret
          # like any other.
          if git grep -nE "sk-[A-Za-z0-9_-]{16,}" -- .; then
            echo "::error::a credential-like value is committed to this repository"
            exit 1
          fi
          echo "ok no credentials found"
```

- [ ] **Step 7: Update the READMEs**

In `README.md` and `README.en.md`, replace every mention of `dsh-minimax-quota` as the **package** name with `dsh-minimax`. Keep the repository URL (`woaiCarlos/dsh-minimax-quota`) unchanged everywhere, because that is what the catalog entry points at.

Add a section describing the new behaviour, in the language of the file:

> ### 模型自动补充 / Automatic model sync
>
> 插件会探测 MiniMax 新发布的模型，把它们追加到 pi-ai 配置的 `providers.minimax-cn.models` 里。
> 每个新模型都会实测：是否还能调用、单次最大输出是多少、是否支持思考。
> **你已有的条目不会被删除、不会被重排、也不会被改值** —— 插件只追加。手动删掉的模型也不会被加回来。
>
> 写回时有一处需要说明：pi-ai schema 解析出来的**路由级默认值**（`defaultContextWindow`、`defaultMaxTokens` 等）
> 会随这次写入一并落到 profile patch 的那条路由上；你写的**模型条目本身**按原样写回，一个字都不改。

and the English counterpart:

> **The entries you already have are never removed, never reordered and never changed in value** — the plugin only appends. A model you deleted by hand is not added back either.
>
> One thing to know about the write: the **route-level defaults the pi-ai schema resolves** (`defaultContextWindow`, `defaultMaxTokens` and the like) land in that route in the profile patch along with the new list. **The model entries you wrote are written back exactly as they are.**

The READMEs must also name what the code does: the **daily sweep**, the **manual sync button**, the
**state file** `dsh-minimax-state.json` and the **declared services** of the Host half
(`inject: ['webServer', 'credentials', 'settings', 'profileContext']` — not `['webServer']`). The state
file is the record of what the plugin added, so losing it re-enables the re-adding of a model the user
deleted by hand, and the README has to say so.

- [ ] **Step 8: Run the checks**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add package.json client.js cordis.patch.yml dsh-plugin.json README.md README.en.md .github/workflows/ci.yml package-lock.json
git commit -m "refactor: rename the bundle to dsh-minimax

The bundle now carries the quota display and the model sync, so the
package name no longer says quota only. The repository URL is unchanged,
which keeps the community catalog entry and its pull request valid."
```

---

## Task 10: End-to-end verification

The unit tests cover the logic. This task proves the plugin works inside a real Harness instance, against the real MiniMax API, with a real profile.

**Files:**
- No repository changes unless the run finds a defect.

**Interfaces:**
- Consumes: the finished bundle.
- Produces: a verified install.

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS, with every suite reported.

- [ ] **Step 2: Start an isolated Harness instance**

```bash
export DSH_HOME=/tmp/dsh-minimax-e2e
rm -rf "$DSH_HOME"
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" > /tmp/dsh-minimax-e2e.log 2>&1 &
echo $! > /tmp/dsh-minimax-e2e.pid
```

Wait for the instance to announce its URL, then read it:

```bash
sleep 12
grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9._-]+' /tmp/dsh-minimax-e2e.log | head -1
```

If the log carries no URL, read the port from the log with `grep -oE '127\.0\.0\.1:[0-9]+' /tmp/dsh-minimax-e2e.log | head -1` and continue with that port.

- [ ] **Step 3: Install the plugin into the isolated instance**

The plugin is installed into a *profile* directory, which is its own npm project
(it carries a `package.json`). Find the profile directory and install there:

```bash
PROFILE_DIR=$(find "$DSH_HOME/profiles" -maxdepth 1 -mindepth 1 -type d | head -1)
echo "profile dir: $PROFILE_DIR"
cd "$PROFILE_DIR"
pnpm add "github:woaiCarlos/dsh-minimax-quota"
```

Then check that the bundle patch reached the profile:

```bash
grep -n "dsh-minimax" "$PROFILE_DIR/cordis.patch.yml"
```

Expected: one line naming `dsh-minimax`.

If the profile directory has no `package.json` yet, wait for the instance to finish
its first boot and re-run the step — the profile is created during boot.

- [ ] **Step 4: Verify the status route answers**

```bash
PORT=$(grep -oE '127\.0\.0\.1:[0-9]+' /tmp/dsh-minimax-e2e.log | head -1 | cut -d: -f2)
TOKEN=$(grep -oE 'token=[A-Za-z0-9._-]+' /tmp/dsh-minimax-e2e.log | head -1 | cut -d= -f2)
curl -s -c /tmp/dsh-minimax-e2e.cookies "http://127.0.0.1:${PORT}/?token=${TOKEN}" -o /dev/null
curl -s -b /tmp/dsh-minimax-e2e.cookies "http://127.0.0.1:${PORT}/plugin/minimax/status"
```

Expected: a JSON object with a `quota` key and a `models` key.

- [ ] **Step 5: Verify the profile received the models**

```bash
grep -n -A 30 "minimax-cn" "$PROFILE_DIR/cordis.patch.yml"
```

Expected: the `models:` list under `providers.minimax-cn` carries entries with `contextWindow`, `maxTokens`, `input` and `reasoningEfforts`.

The bundle itself is registered in the profile's `package.json`, not in the patch — check it too:

```bash
grep -n "dsh-minimax" "$PROFILE_DIR/package.json"
```

- [ ] **Step 6: Verify the sync route answers**

```bash
curl -s -b /tmp/dsh-minimax-e2e.cookies -X POST "http://127.0.0.1:${PORT}/plugin/minimax/sync"
```

Expected: `{"ok":true,"added":[],"models":[...]}` — `added` is empty because the first sync already added everything.

- [ ] **Step 7: Check the pill in the browser**

Open `http://127.0.0.1:${PORT}/?token=${TOKEN}` in a browser. Select a MiniMax model. Expected: the pill below the composer shows `5小时 …% · 周 …%`. Click it. Expected: the panel shows the quota bars and a models section listing the synced model ids.

- [ ] **Step 8: Stop the isolated instance**

```bash
kill "$(cat /tmp/dsh-minimax-e2e.pid)" 2>/dev/null || true
rm -rf "$DSH_HOME"
```

- [ ] **Step 9: Run the real-API probe script**

Confirm the live measurements still hold:

```bash
KEY=$(grep -oE "sk-[A-Za-z0-9_-]+" ~/.dsh/.credentials.yaml | head -1)
for M in MiniMax-M3.1-Flash MiniMax-M3 MiniMax-M2.7 MiniMax-M2; do
  printf "%-22s " "$M"
  curl -s -m 30 "https://api.minimaxi.com/anthropic/v1/messages" \
    -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
    -d "{\"model\":\"$M\",\"max_tokens\":999999999,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error',{}).get('message','no refusal')[:90])"
done
```

Expected: every model reports its cap (`does not support max tokens > …`) — including `MiniMax-M2`, which answers the cap request first and only says `no longer available` on a *second* request. Ask it twice to see both answers.

- [ ] **Step 10: Push the branch**

```bash
git push origin main
```

- [ ] **Step 11: Update the market index to the new commit**

In `/Users/carlos/Documents/deepseek-harness/default-workspace/plugin-market/git-plugins.json`, set the `dsh-minimax-quota` entry's `commit` to the new HEAD sha:

```bash
cd "/Users/carlos/Documents/deepseek-harness/default-workspace/plugin-market"
sha=$(git -C "/Users/carlos/Downloads/DSH-杂项/dsh-minimax-quota" rev-parse HEAD)
node -e "
  const fs = require('fs');
  const file = 'git-plugins.json';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The index is a map keyed by package name, and the entry carries a
  // flat commit field — not a list of versions.
  const OLD = 'dsh-minimax-quota';
  const NAME = 'dsh-minimax';
  const entry = data[OLD];
  if (!entry) throw new Error('market entry not found');
  entry.version = '1.1.0';
  entry.commit = process.argv[1];
  entry.publishTimestamp = Math.floor(Date.now() / 1000);
  entry.description = {
    en: 'Shows the remaining MiniMax coding-plan quota below the DeepSeek Harness chat composer, and keeps the profile\'s MiniMax model list current by appending newly released models.',
    zh: '在对话输入框下方显示 MiniMax 编程套餐剩余额度，并把新发布的模型追加到配置的模型列表里。',
  };
  delete data[OLD];
  data[NAME] = entry;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
" "$sha"
node generate-index.mjs
```

Then verify the generated index against DSH's own validator:

```bash
node -e "
  const { parseMarketIndex } = require('@deepseek-ai/dsh-plugin-market-index');
  const index = parseMarketIndex(JSON.parse(require('fs').readFileSync('index.json','utf8')), 'http://127.0.0.1:8765/index.json');
  console.log('ok, plugins:', index.plugins.length);
"
```

Expected: `ok, plugins: 15` (or whatever the current count is).

- [ ] **Step 12: Commit the market index update**

```bash
cd "/Users/carlos/Documents/deepseek-harness/default-workspace/plugin-market"
git add git-plugins.json index.json
git commit -m "chore(market): point dsh-minimax at the renamed bundle"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| §1 额度显示保留 | Task 1 (extraction), Task 7 (route), Task 8 (pill) |
| §1 新模型自动出现 | Task 5, Task 7 |
| §1 思考能力准确 | Task 2 (snapshot), Task 3 (probe), Task 4 (entry) |
| §1 不强制覆盖 | Task 5 (merge), Task 6 (state), Task 7 (sync) |
| §1 无变化不动 | Task 5 (`changed` flag), Task 7 (early return) |
| §1 变更可见 | Task 8 (badge, models section) |
| §1 不泄露凭据 | Task 1 (`lib/credentials.js`), Task 7 (secret only in headers) |
| §2.3 maxTokens 来自 API | Task 3 |
| §2.5 models.dev 快照 | Task 2 |
| §3 不做：改/删已有条目 | Task 5, Task 6 |
| §3 不做：不并桌宠 | no task (unchanged) |
| §4 架构与路由 | Task 7 |
| §5 参数来源表 | Tasks 2, 3, 4 |
| §5.4 forceAdaptiveThinking | Task 4 |
| §5.5 探测流程 | Task 3 |
| §6 同步算法 | Tasks 5, 6, 7 |
| §7.3 Host 日志记一行 | Task 7 (`logSync` for the startup, daily and manual syncs) |
| §6.2 并发保护 | Task 7 (`descriptor.revision`) |
| §6.3 失败不影响本体 | Task 7 (`scheduleSync` catch) |
| §7 提醒机制 | Task 8 |
| §8 配置与数据流 | Task 7, Task 6 |
| §9 测试策略 | Tasks 1–7, Task 8 (the Browser half) |
| §10 兼容性 | Task 9 (URL unchanged) |
| §11 实施顺序 | Task order matches |
| §12 未决问题 | Task 2 (`video` filtered by `SUPPORTED_MODALITIES`), Task 4 (probed cap wins) |

**Placeholder scan:** no `TBD`, `TODO`, or "similar to Task N". Every step carries literal code.

**Type consistency**

- `resolveApiKey(ctx, ref)` — Task 1 defines it, Tasks 3 and 7 use it. Consistent.
- `fetchQuota(ctx, ref, signal, fetchImpl = fetch)` — Task 1 defines it; Task 7 calls `fetchQuota(c, ref)` and Task 8 reads `payload.quota`. Consistent.
- `probeModel(modelId, apiKey, options)` returns `{ status, modelId, maxTokens?, supportsThinking?, reason? }` — Task 3 defines it; Task 4 reads `probe.maxTokens` and `probe.supportsThinking`; Task 7 checks `probe.status !== 'ok'`. Consistent.
- `buildModelEntry(modelId, probe, spec?)` — Task 4 defines it; Task 7 calls `buildModelEntry(id, probe)` with two arguments. Consistent.
- `planAppend({ currentModels, addedModels, candidateIds, entries })` returns `{ models, addedIds, changed }` — Task 5 defines it; Task 7 reads all three. Consistent.
- `readState(dir)` / `writeState(dir, state)` return `{ addedModels, retiredModels, lastSyncAt }` — Task 6 defines it; Task 7 uses `state.addedModels`, `state.retiredModels` and `state.lastSyncAt`. Consistent.
- `runSync(ctx, options)` returns `{ ok, added, models }` or `{ ok: false, reason }` — Task 7 defines it; its own test asserts `result.added` and `result.reason`. Consistent.
- `buildStatusPayload(ctx, options)` returns `{ quota, models: { synced, added, syncedAt } }` — Task 7 defines it; Task 8's client reads `payload.quota` and `payload.models.synced` / `payload.models.added`. Consistent.
- `lookupSpec(modelId)` returns `{ contextWindow, outputLimit, modalities, reasoningOptions }` — Task 2 defines it; Task 4 reads all four. Consistent.

**One deviation from the spec, recorded deliberately:** the spec originally placed the "ids the plugin added" in the plugin's own profile row via `configEditor.edit`. The plan stores them in `<profileDir>/dsh-minimax-state.json` instead, because editing the plugin's own row triggers a Loader reconcile that reloads the plugin, and the write would then re-enter `apply()`. The file keeps the plugin's bookkeeping out of the user's patch entirely, which is the property the spec wanted. The spec's §4, §6 and §8.2 have been updated to match.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-11-12-dsh-minimax.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
