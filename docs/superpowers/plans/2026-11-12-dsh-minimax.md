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
- The plugin never modifies, overwrites or removes an entry that is already in the user's list, and never re-adds a model the user deleted by hand.
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
| `lib/state.js` | Persist the set of model ids the plugin has added, so a hand-deleted model is not re-added. |
| `index.js` | Host half: routes, the sync orchestration, the config schema. |
| `client.js` | Browser half: quota pill, details panel, models section, notice marker. |
| `test/*.test.js` | One test file per `lib/` module, run by `node --test`. |

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
Expected: PASS — 12 tests across `test/quota.test.js` and `test/credentials.test.js`, plus the two syntax checks.

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
  - A spec object is `{ contextWindow: number, outputLimit: number, modalities: string[], reasoningOptions: { type: 'effort' | 'toggle' } | null }`

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/specs.test.js`
Expected: PASS — 6 tests.

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

This is the module that turns the user's suspicion — "some models support thinking, some do not" — into a measurement. Three facts drive its shape:

- `GET /v1/models` lists retired models, so the list is a candidate set, not an answer.
- The exact output cap is in the refusal message of an over-limit request, and that request is rejected before generation, so it costs nothing.
- Whether a model thinks can only be told by a request that makes it think. A prompt like `"hi"` produces a **false negative** for every model, because there is nothing to think about; the prompt has to demand reasoning.

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
    - `parseMaxTokensLimit(message): number | undefined`
    - `isRetired(message): boolean`
    - `postMessage(body, apiKey, options): Promise<{ status: number, payload: object | undefined, message: string }>`
    - `fetchModelIds(apiKey, options): Promise<string[]>`
    - `probeModel(modelId, apiKey, options): Promise<{ status: 'ok' | 'retired' | 'failed', modelId: string, maxTokens?: number, supportsThinking?: boolean, reason?: string }>`
  - `options` is `{ signal?: AbortSignal, fetchImpl?: typeof fetch }`

- [ ] **Step 1: Write the failing test for the refusal parsers**

Create `test/probe.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OVER_LIMIT_MAX_TOKENS,
  fetchModelIds,
  isRetired,
  parseMaxTokensLimit,
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
```

- [ ] **Step 2: Write the failing test for the model list**

Append to `test/probe.test.js`:

```js
test('fetchModelIds lists every candidate id', async () => {
  const fetchImpl = async () => jsonResponse({
    object: 'list',
    data: [{ id: 'MiniMax-M3.1-Flash' }, { id: 'MiniMax-M2' }],
  }, 200)
  assert.deepEqual(await fetchModelIds('sk-test', { fetchImpl }), ['MiniMax-M3.1-Flash', 'MiniMax-M2'])
})

test('fetchModelIds answers an empty list when the endpoint carries no models', async () => {
  const fetchImpl = async () => jsonResponse({ object: 'list', data: [] }, 200)
  assert.deepEqual(await fetchModelIds('sk-test', { fetchImpl }), [])
})
```

- [ ] **Step 3: Write the failing test for the probe**

Append to `test/probe.test.js`:

```js
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

test('probeModel reports a retired model instead of failing', async () => {
  const fetchImpl = async () => jsonResponse({
    error: { message: 'The model "MiniMax-M2" is no longer available. (2069)' },
  })
  const result = await probeModel('MiniMax-M2', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'retired')
  assert.equal(result.modelId, 'MiniMax-M2')
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

test('probeModel reports a failed probe when the model answers nothing usable', async () => {
  const fetchImpl = async () => jsonResponse({ error: { message: 'internal error' } })
  const result = await probeModel('MiniMax-M3', 'sk-test', { fetchImpl })
  assert.equal(result.status, 'failed')
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test test/probe.test.js`
Expected: FAIL with `Cannot find module '../lib/probe.js'`

- [ ] **Step 5: Write `lib/probe.js`**

```js
/**
 * Talking to MiniMax about the models its account can use.
 *
 * Three facts shape this module.
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
 * @returns the candidate model ids.
 */
export async function fetchModelIds(apiKey, { signal, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const composed = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
  try {
    const response = await fetchImpl(MODELS_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: composed,
    })
    const body = await response.json()
    const data = Array.isArray(body?.data) ? body.data : []
    return data.map((entry) => entry?.id).filter((id) => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
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

  const thinking = await postMessage({
    model: modelId,
    max_tokens: 8192,
    messages: [{ role: 'user', content: THINKING_PROMPT }],
    thinking: { type: 'enabled', budget_tokens: 4096 },
  }, apiKey, { signal, fetchImpl })
  const blocks = Array.isArray(thinking.payload?.content) ? thinking.payload.content : undefined
  if (blocks === undefined) {
    return { status: 'failed', modelId, reason: thinking.message || `HTTP ${thinking.status}` }
  }
  return {
    status: 'ok',
    modelId,
    maxTokens,
    supportsThinking: blocks.some((block) => block?.type === 'thinking'),
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/probe.test.js`
Expected: PASS — 9 tests.

- [ ] **Step 7: Commit**

```bash
git add lib/probe.js test/probe.test.js
git commit -m "feat: probe MiniMax for liveness, output cap and thinking

GET /v1/models lists models the account can no longer call, so every
candidate is probed before it may be written. The exact output cap comes
out of the refusal of an over-limit request, which is rejected before
generation and therefore costs nothing.

The thinking probe has to use a prompt that demands reasoning: a prompt
like \"hi\" yields a false negative for every model, because there is
nothing to think about."
```

---

## Task 4: Turning a probe result into a pi-ai model entry

**Files:**
- Create: `lib/model-entry.js`
- Create: `test/model-entry.test.js`

**Interfaces:**
- Consumes: `lookupSpec(modelId)` from `lib/specs.js`.
- Produces: `buildModelEntry(modelId, probe, spec?): object` — a pi-ai `modelProfile`.

- [ ] **Step 1: Write the failing test**

Create `test/model-entry.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildModelEntry } from '../lib/model-entry.js'
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
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })
  assert.equal('compat' in entry, false)
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

import { lookupSpec } from './specs.js'

/**
 * The effort levels the plugin offers.
 *
 * pi-ai maps a level onto a thinking budget when the model is called in
 * budget mode, and onto `output_config.effort` when the model is called in
 * adaptive mode. Either way a level needs a wire spelling, and the ones
 * below are the spellings MiniMax accepts.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

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
    input: [...spec.modalities],
  }
  if (probe.supportsThinking === true) {
    entry.reasoningEfforts = Object.fromEntries(EFFORT_LEVELS.map((level) => [level, level]))
    if (spec.reasoningOptions?.type === 'effort') {
      entry.compat = { forceAdaptiveThinking: true }
    }
  } else {
    entry.reasoningEfforts = false
  }
  return entry
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/model-entry.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/model-entry.js test/model-entry.test.js
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
  assert.equal(plan.models[0].maxTokens, 512000)
  assert.equal(plan.models[0].name, 'MiniMax-M3-1M')
})

test('nothing changes when there is no new model', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: ['MiniMax-M3.1-Flash'],
    candidateIds: ['MiniMax-M3', 'MiniMax-M3.1-Flash'],
    entries: new Map(),
  })
  assert.equal(plan.changed, false)
  assert.deepEqual(plan.addedIds, [])
  assert.deepEqual(plan.models, EXISTING)
})

test('a model the user already listed is not added twice', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: [],
    candidateIds: ['MiniMax-M3'],
    entries: new Map([['MiniMax-M3', { id: 'MiniMax-M3' }]]),
  })
  assert.equal(plan.changed, false)
  assert.equal(plan.models.length, 2)
})

test('a model the user deleted by hand is not added back', () => {
  const plan = planAppend({
    currentModels: EXISTING,
    addedModels: ['MiniMax-M3.1-Flash'],
    candidateIds: ['MiniMax-M3.1-Flash'],
    entries: new Map([['MiniMax-M3.1-Flash', NEW_ENTRY]]),
  })
  assert.equal(plan.changed, false)
  assert.equal(plan.models.length, 2)
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
 * @param entries - the built entries, keyed by model id.
 * @returns `{ models, addedIds, changed }`.
 */
export function planAppend({ currentModels = [], addedModels = [], candidateIds = [], entries = new Map() }) {
  const listed = new Set(currentModels.map((entry) => entry?.id))
  const added = new Set(addedModels)
  const models = [...currentModels]
  const addedIds = []
  for (const id of candidateIds) {
    if (listed.has(id) || added.has(id)) continue
    const entry = entries.get(id)
    if (entry === undefined) continue
    models.push(entry)
    listed.add(id)
    addedIds.push(id)
  }
  return { models, addedIds, changed: addedIds.length > 0 }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/merge.test.js`
Expected: PASS — 6 tests.

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
  - A state object is `{ addedModels: string[], lastSyncAt: number | null }`

- [ ] **Step 1: Write the failing test**

Create `test/state.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_FILENAME, emptyState, readState, writeState } from '../lib/state.js'

async function scratchDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-minimax-state-'))
}

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
 * by hand is not added back on the next sync. The state lives in one file
 * inside the profile directory, so the plugin's bookkeeping never lands in
 * the user's profile patch.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Name of the state file inside the profile directory. */
export const STATE_FILENAME = 'dsh-minimax-state.json'

/**
 * The state of a plugin that has never synced.
 *
 * @returns an empty state.
 */
export function emptyState() {
  return { addedModels: [], lastSyncAt: null }
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
    const addedModels = Array.isArray(parsed?.addedModels)
      ? parsed.addedModels.filter((id) => typeof id === 'string' && id.length > 0)
      : []
    return {
      addedModels,
      lastSyncAt: Number.isFinite(parsed?.lastSyncAt) ? parsed.lastSyncAt : null,
    }
  } catch {
    return emptyState()
  }
}

/**
 * Write the plugin's state.
 *
 * @param dir - the profile directory.
 * @param state - the state to store.
 * @returns the stored state.
 */
export async function writeState(dir, state) {
  await mkdir(dir, { recursive: true })
  const payload = {
    addedModels: [...new Set(state.addedModels ?? [])].sort(),
    lastSyncAt: Number.isFinite(state.lastSyncAt) ? state.lastSyncAt : null,
  }
  await writeFile(join(dir, STATE_FILENAME), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/state.test.js`
Expected: PASS — 5 tests.

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
  - Routes: `GET /plugin/minimax/status`, `POST /plugin/minimax/sync`

- [ ] **Step 1: Write the failing test for the sync**

Create `test/sync.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStatusPayload, runSync } from '../index.js'

function fakeSettings(models) {
  const writes = []
  return {
    writes,
    describe() {
      return [{
        ns: 'llm-pi-ai',
        revision: 3,
        value: { providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models } } },
      }]
    },
    async write(ns, change, expected, paths) {
      writes.push({ ns, expected, paths, next: change({ providers: { 'minimax-cn': { models } } }) })
    },
  }
}

function ctxWith({ models = [], settings, state = { addedModels: [], lastSyncAt: null }, profileDir = '/tmp/dsh-minimax-test' }) {
  return {
    writes: [],
    get(name) {
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      if (name === 'settings') return settings
      if (name === 'profileContext') return { dir: profileDir }
      return undefined
    },
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

test('runSync appends a newly released model and leaves the rest alone', async () => {
  const settings = fakeSettings([{ id: 'MiniMax-M3', maxTokens: 512000 }])
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
      }
      return PROBE_FETCH(url, init)
    },
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, ['MiniMax-M3.1-Flash'])
  assert.equal(settings.writes.length, 1)
  const written = settings.writes[0].next.providers['minimax-cn'].models
  assert.equal(written.length, 2)
  assert.equal(written[0].id, 'MiniMax-M3')
  assert.equal(written[0].maxTokens, 512000)
  assert.equal(written[1].id, 'MiniMax-M3.1-Flash')
  assert.equal(written[1].maxTokens, 524288)
})

test('runSync never writes a retired model', async () => {
  const settings = fakeSettings([])
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
      }
      return PROBE_FETCH(url, init)
    },
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.deepEqual(result.added, ['MiniMax-M3.1-Flash'])
  assert.equal(settings.writes.length, 1)
  const written = settings.writes[0].next.providers['minimax-cn'].models
  assert.equal(written.some((entry) => entry.id === 'MiniMax-M2'), false)
})

test('runSync writes nothing when there is no new model', async () => {
  const settings = fakeSettings([{ id: 'MiniMax-M3.1-Flash', maxTokens: 524288 }])
  const ctx = ctxWith({ settings })
  const result = await runSync(ctx, {
    credentialRef: 'MINIMAX_CN_API_KEY',
    profileDir: '/tmp/dsh-minimax-test',
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: MODEL_IDS.map((id) => ({ id })) }), { status: 200 })
      }
      return PROBE_FETCH(url, init)
    },
    stateReader: async () => ({ addedModels: [], lastSyncAt: null }),
    stateWriter: async () => {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.added, [])
  assert.equal(settings.writes.length, 0)
})

test('runSync reports a missing credential without writing', async () => {
  const settings = fakeSettings([])
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

test('buildStatusPayload reports the quota and the synced model ids', async () => {
  const settings = fakeSettings([{ id: 'MiniMax-M3' }, { id: 'MiniMax-M3.1-Flash' }])
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

/** The pi-ai settings namespace that holds the provider list. */
const SETTINGS_NAMESPACE = 'llm-pi-ai'

/** The provider route inside that namespace. */
const PROVIDER_ROUTE = 'minimax-cn'

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
 * The model entries the profile currently lists.
 *
 * @param descriptor - the pi-ai namespace descriptor.
 * @returns the listed entries.
 */
function currentModels(descriptor) {
  const models = descriptor?.value?.providers?.[PROVIDER_ROUTE]?.models
  return Array.isArray(models) ? models : []
}

/**
 * Probe every candidate model and append the ones that answer.
 *
 * The plugin only ever appends. An entry the user already has is left
 * exactly as it is, and a model the user removed by hand is not added
 * back, because the ids this plugin added are remembered.
 *
 * @param ctx - Host context.
 * @param options - `{ credentialRef, profileDir, fetchImpl, stateReader, stateWriter, now }`.
 * @returns the sync outcome.
 */
export async function runSync(ctx, options = {}) {
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
  const candidateIds = (await fetchModelIds(apiKey, { signal: options.signal, fetchImpl: options.fetchImpl }))
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

  await settings.write(SETTINGS_NAMESPACE, (current) => ({
    ...current,
    providers: {
      ...current.providers,
      [PROVIDER_ROUTE]: {
        ...current.providers?.[PROVIDER_ROUTE],
        models: plan.models,
      },
    },
  }), descriptor.revision, ['providers', PROVIDER_ROUTE, 'models'])

  const now = options.now ?? Date.now
  await writeStateFn(profileDir, {
    addedModels: [...state.addedModels, ...plan.addedIds],
    lastSyncAt: now(),
  })
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
    throw new Error('dsh-minimax-quota: the webServer service is unavailable, so the routes cannot be registered')
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
        send(res, await buildStatusPayload(ctx, { credentialRef, signal: abort.signal }))
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
          send(res, { ok: false, reason: 'sync-failed', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  ]
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'dsh-minimax-quota: routes')

  // The profile may still be loading, so the first sync waits for the pi-ai
  // namespace to appear before it gives up.
  void scheduleSync(ctx, credentialRef)
}

/**
 * Run the first sync once the profile has settled.
 *
 * @param ctx - Host context.
 * @param credentialRef - credential reference to resolve.
 */
async function scheduleSync(ctx, credentialRef) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      const result = await runSync(ctx, { credentialRef })
      if (result.ok || result.reason === 'missing-credential') return
    } catch {
      // A failed sync must never take the plugin down; the next attempt
      // tries again.
    }
  }
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
    vendor: 'dsh-minimax-quota',
    validate(value) {
      const raw = value === undefined || value === null ? {} : value
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'dsh-minimax-quota: config must be an object' }] }
      }
      const issues = []
      const config = {}
      for (const [key, entry] of Object.entries(raw)) {
        if (key !== 'credentialRef') {
          issues.push({ message: `dsh-minimax-quota: unknown config field "${key}"`, path: [key] })
          continue
        }
        if (typeof entry !== 'string' || entry.length === 0) {
          issues.push({ message: 'dsh-minimax-quota: credentialRef must be a non-empty string', path: [key] })
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — the five sync tests plus the earlier suites.

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
const payload = await response.json()
return payload?.quota ?? { ok: false, reason: 'request-failed', message: 'Malformed response.' }
```

The panel must render the quota exactly as before — the payload nesting is the only change.

- [ ] **Step 3: Add the models section to the panel**

In `client.js`, add a component right after `QuotaPanel`:

```js
function ModelsPanel({ models, t }) {
  if (models === undefined) return null
  const synced = Array.isArray(models.synced) ? models.synced : []
  const added = Array.isArray(models.added) ? models.added : []
  if (synced.length === 0) return null
  return h('div', { className: '__mmq_models' },
    h('div', { className: '__mmq_sectionTitle' }, t('modelsTitle')),
    h('div', { className: '__mmq_modelList' },
      synced.map((id) => h('span', { className: '__mmq_modelChip', key: id }, id)),
    ),
    added.length > 0
      ? h('div', { className: '__mmq_modelNotice' }, t('modelsAdded', { count: added.length }))
      : null,
    models.syncedAt ? h('div', { className: '__mmq_meta' }, t('modelsSyncedAt', { when: formatClock(models.syncedAt) })) : null,
  )
}
```

Render it inside `QuotaPanel`, after the weekly section and before the fetched-at line, with the models passed down. `QuotaPanel` receives `view` today; add a `models` prop and pass it from `MiniMaxQuotaPill`, which already owns the fetched payload.

- [ ] **Step 4: Add the notice marker to the pill**

The payload's `models.added` lists every model the plugin has ever added, so it
never empties. A badge driven by it alone would therefore never clear. The badge
marks "there are models you did not add by hand" and disappears once the user
has opened the panel in this page load; the panel itself always lists the whole
set, so nothing is lost.

Add a piece of component state next to `open` in `MiniMaxQuotaPill`:

```js
const [noticeSeen, setNoticeSeen] = React.useState(false)
```

Compute the notice from the fetched payload:

```js
const hasNotice = !noticeSeen && (payload?.models?.added?.length ?? 0) > 0
```

Mark it seen when the panel opens:

```js
React.useEffect(() => {
  if (open) setNoticeSeen(true)
}, [open])
```

Add the styles for the models section and the marker to the stylesheet the client installs, using only theme tokens:

```js
'.__mmq_models{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}',
'.__mmq_sectionTitle{font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:6px}',
'.__mmq_modelList{display:flex;flex-wrap:wrap;gap:4px}',
'.__mmq_modelChip{border-radius:var(--dsw-radius-sm);padding:1px 6px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
'.__mmq_modelNotice{margin-top:8px;color:var(--dsw-alias-state-warning);font-size:11px}',
'.__mmq_meta{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
'.__mmq_badge{position:absolute;top:-2px;right:-2px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}',
'.__mmq_pillWrap{position:relative;display:inline-flex}',
```

Render the badge inside a wrapper around the pill's existing content, and render it
only while `hasNotice` is true:

```js
h('span', { className: '__mmq_pillWrap' },
  existingPillButton,
  hasNotice ? h('span', { className: '__mmq_badge', 'aria-hidden': true }) : null,
)
```

Keep the pill's own `__mmq_pill` class on the button, so the existing layout is
unchanged.

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

- [ ] **Step 6: Run the checks**

Run: `npm test`
Expected: PASS — the suite plus both syntax checks.

- [ ] **Step 7: Verify the locale JSON parses**

Run: `node -e "for (const f of ['locale/zh.json','locale/en.json']) { JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('ok', f) }"`
Expected: `ok locale/zh.json` and `ok locale/en.json`.

- [ ] **Step 8: Commit**

```bash
git add client.js locale/zh.json locale/en.json
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

- [ ] **Step 7: Update the READMEs**

In `README.md` and `README.en.md`, replace every mention of `dsh-minimax-quota` as the **package** name with `dsh-minimax`. Keep the repository URL (`woaiCarlos/dsh-minimax-quota`) unchanged everywhere, because that is what the catalog entry points at.

Add a section describing the new behaviour, in the language of the file:

> ### 模型自动补充 / Automatic model sync
>
> 插件会探测 MiniMax 新发布的模型，把它们追加到 pi-ai 配置的 `providers.minimax-cn.models` 里。
> 每个新模型都会实测：是否还能调用、单次最大输出是多少、是否支持思考。
> **你已有的条目不会被修改或删除** —— 插件只追加。手动删掉的模型也不会被加回来。

and the English counterpart.

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

Expected: the three live models report their cap (`does not support max tokens > …`), and `MiniMax-M2` reports `no longer available`.

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
  const entry = (data.plugins ?? data).find ? (data.plugins ?? data).find(p => p.name === 'dsh-minimax-quota') : undefined;
  if (!entry) throw new Error('market entry not found');
  entry.version = '1.1.0';
  entry.versions[0].commit = process.argv[1];
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
git commit -m "chore(market): point dsh-minimax-quota at the renamed bundle"
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
| §6.2 并发保护 | Task 7 (`descriptor.revision`) |
| §6.3 失败不影响本体 | Task 7 (`scheduleSync` catch) |
| §7 提醒机制 | Task 8 |
| §8 配置与数据流 | Task 7, Task 6 |
| §9 测试策略 | Tasks 1–7 |
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
- `readState(dir)` / `writeState(dir, state)` return `{ addedModels, lastSyncAt }` — Task 6 defines it; Task 7 uses `state.addedModels` and `state.lastSyncAt`. Consistent.
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
