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
