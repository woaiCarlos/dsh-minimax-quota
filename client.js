/**
 * Browser half of the MiniMax quota bundle.
 *
 * Registers one entry in `conversation.composer.dock`: when the session's
 * selected model belongs to the MiniMax family, it shows the remaining 5-hour
 * and weekly coding-plan quota, and clicking it opens a details panel.
 *
 * The API key never reaches the browser: the Host answers one same-origin
 * route with the quota view, and this half only reads that route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-minimax-quota',
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
      '.__mmq_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}',
      '.__mmq_badge{display:inline-flex;align-items:center;gap:4px}',
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
      '.__mmq_error{color:var(--dsw-alias-label-error)}',
    ].join('')

    function installStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-minimax-quota/client.css'
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-minimax-quota'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── helpers ───────────────────────────────────────────────────────────
    const QUOTA_ROUTE = '/plugin/minimax-quota'

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

    // ── quota fetching ─────────────────────────────────────────────────────
    /**
     * One in-flight quota read shared by every subscriber of this page, so a
     * remount does not multiply upstream calls.
     */
    let pending = null

    /** How often the reading refreshes while a MiniMax model is selected. */
    const REFRESH_INTERVAL_MS = 60_000

    function readQuota() {
      if (pending !== null) return pending
      pending = fetch(QUOTA_ROUTE, { headers: { accept: 'application/json' } })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return await response.json()
        })
        .catch((error) => ({
          ok: false,
          reason: 'request-failed',
          message: error instanceof Error ? error.message : String(error),
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
     * the moment its window resets.
     */
    function QuotaPanel({ view, t, style, panelRef }) {
      const rows = []
      const interval = view.intervalRemainingPercent
      const weekly = view.weeklyRemainingPercent
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
      if (rows.length === 0) {
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
        h(
          'div',
          { className: '__mmq_hint', style: { marginTop: '10px' } },
          t('panelFetchedAt', { when: formatClock(view.fetchedAt) }),
        ),
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
      const [view, setView] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [position, setPosition] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)

      // Read the quota whenever a MiniMax model is the active selection, and
      // refresh it on a slow cadence so the reading stays current.
      React.useEffect(() => {
        if (!active) {
          setView(null)
          return undefined
        }
        let alive = true
        const refresh = () => {
          readQuota().then((result) => {
            if (alive) setView(result)
          })
        }
        refresh()
        const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [active, current?.provider, current?.model])

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
              { className: '__mmq_badge', key: 'interval' },
              h('span', { className: `__mmq_dot${severityClass(view.intervalRemainingPercent)}` }),
              h('span', null, `${t('intervalLabel')} ${view.intervalRemainingPercent}%`),
            ),
          )
        }
        if (view.weeklyRemainingPercent !== null) {
          parts.push(
            h(
              'span',
              { className: '__mmq_badge', key: 'weekly' },
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

      const showPanel = open && view !== null && view.ok === true

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
          'button',
          {
            type: 'button',
            className: '__mmq_pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': showPanel,
            'aria-label': ariaLabel,
            onClick: () => {
              setOpen((previous) => !previous)
              // Opening is the moment the user wants the freshest reading.
              readQuota().then((result) => {
                setView(result)
              })
            },
          },
          h(QuotaIcon, null),
          h('span', { className: '__mmq_label' }, label),
        ),
        showPanel
          ? ReactDOM.createPortal(
              h(QuotaPanel, {
                view,
                t,
                style: position ?? { position: 'fixed', left: '-9999px', top: '-9999px' },
                panelRef: panelNodeRef,
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
