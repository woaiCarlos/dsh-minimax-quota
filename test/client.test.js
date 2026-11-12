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
