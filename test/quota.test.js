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
