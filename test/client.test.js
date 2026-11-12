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
 * Load the browser half the way the Harness loads it.
 *
 * The module registers itself with the page's module loader, so the fake
 * loader captures it and the test calls its factory with a stand-in for the
 * module registry.
 *
 * @returns `{ module, window }`.
 */
async function loadClient() {
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
 * @param options - `{ fetchImpl }`.
 * @returns the mounted pill: a function that renders it, the dictionaries
 *   it registered, and the requests it made.
 */
async function mountPill({ fetchImpl }) {
  const { module } = await loadClient()
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
    // name itself, so the test reads the key.
    t: (key) => key,
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
