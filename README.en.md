# dsh-minimax-quota

Shows the remaining **MiniMax Coding Plan quota** below the DeepSeek Harness chat composer: how much is left in the rolling 5-hour window and in the weekly window. Click the pill for the details.

![Pill and details panel](docs/screenshot-panel.png)

- Appears only when the session has a **MiniMax-family model** selected (provider or model name contains `minimax`).
- The pill reads `5h 95% · Week 37%`, each number with a status dot: green (>40%), amber (≤40%), red (≤15%).
- Clicking opens a panel: remaining percentage per window, a progress bar, time until each window resets, and when the reading was fetched.
- Follows the host light/dark theme; all visible text goes through the Harness locale service (Chinese and English included).

## Install

Straight from GitHub — no npm publish required:

```bash
dsh plugin --profile <your profile> add github:woaiCarlos/dsh-minimax-quota
```

Or clone and install from the local directory:

```bash
git clone https://github.com/woaiCarlos/dsh-minimax-quota.git
dsh plugin --profile <your profile> add file:./dsh-minimax-quota
```

The plugin then appears under **Plugins → Installed** as “MiniMax Quota”. Flip it on and it works; a Harness restart keeps it.

> You still need a MiniMax route in your profile. Add a MiniMax provider with your API key under **Settings → Models** first — the plugin reads the quota of that route.

## Showing up in a plugin market

The plugin is already listed in the local plugin market's **Discover** tab (its index entry pins a GitHub source to an exact commit, so one click installs it).

![Plugin market entry](docs/market-entry.png)

To appear in the **community market** (the awesome-dsh-plugin catalog the third-party market discovers from), open a PR against
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) that adds a single file:

```yaml
# data/plugins/woaiCarlos__dsh-minimax-quota.yml
url: https://github.com/woaiCarlos/dsh-minimax-quota
name: woaiCarlos/dsh-minimax-quota
category: usage
description:
  en: 'Shows the remaining MiniMax coding-plan quota (5-hour window and weekly window) below the chat composer, with the detail on click.'
icon: https://raw.githubusercontent.com/woaiCarlos/dsh-minimax-quota/main/assets/icon-180.png
```

A ready-made copy lives in [`catalog/awesome-dsh-plugin.yml`](catalog/awesome-dsh-plugin.yml). The repository already carries the `dsh-plugin` topic.

That catalog's CI checks that the repository is **at least one day old**. This repository was created at 2026-11-10 09:04 UTC, so the PR can go in from 2026-11-11 09:04 UTC onward.

## Does my API key leak?

**No.** Specifically:

1. **The repository contains no secret.** The only thing in the source is the *credential reference* `MINIMAX_CN_API_KEY` — the name of the key to look up, not the key itself. The whole directory was secret-scanned before publishing; there is not a single real `sk-…` value in it.

2. **The key stays in the Host process.** The Host half reads it with `ctx.credentials.resolve('MINIMAX_CN_API_KEY')` and uses the value only to build the `Authorization: Bearer …` header for the MiniMax request. It never appears in the JSON the route returns.

3. **The browser never receives it.** The browser only calls the same-origin route `/plugin/minimax-quota`, which returns percentages and reset timestamps:

   ```json
   {
     "ok": true,
     "intervalRemainingPercent": 95,
     "weeklyRemainingPercent": 37,
     "intervalResetAt": 1794316261854,
     "weeklyResetAt": 1794407213154,
     "intervalStatus": 1,
     "weeklyStatus": 1,
     "fetchedAt": 1794300583689
   }
   ```

### Will it pick up my key automatically after install?

**Yes, as long as your MiniMax key is configured the standard way** — because Harness addresses its credential store by environment-variable name:

| How you configured the key | Does the plugin find it? |
| --- | --- |
| Typed into **Settings → Models** for MiniMax | ✅ yes, **no extra step** |
| `export MINIMAX_CN_API_KEY=sk-…` before launching | ✅ yes |
| Written in the project `.env` or `~/.dsh/.env` | ✅ yes |
| Stored under some other environment variable name | ❌ configure it explicitly, see below |

The reason is that the Harness **Models page** derives the reference name from the provider route id when you type a key for it:

```
minimax-cn  →  MINIMAX_CN_API_KEY
```

which is exactly the name this plugin looks up. So **if MiniMax is already configured in your Models settings, the plugin works the moment you install it** — it never guesses at other key names.

Lookup order (the credential store's fixed precedence; the first place with a value wins):

```
1. the stored credential file   ~/.dsh/.credentials.yaml   ← what the Models page writes
2. the launching environment    MINIMAX_CN_API_KEY=… dsh
3. the project .env             <cwd>/.env
4. the home .env                $DSH_HOME/.env
```

### Using a different reference name

If your key lives under another environment variable name, change the plugin config in `cordis.patch.yml`:

```yaml
- id: minimax-quota
  name: 'dsh-minimax-quota'
  config:
    credentialRef: MY_MINIMAX_KEY
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `credentialRef` | `MINIMAX_CN_API_KEY` | The credential reference to read. An environment variable name or a reference in the credential store. |

## How it works

```
index.js    Host half: resolve credential → call MiniMax → serve the quota on the same-origin route /plugin/minimax-quota
client.js   Browser half: register a pill below the composer, click opens the details panel
locale/     Chinese and English strings
```

### Where the data comes from

MiniMax does not document this endpoint; it was recovered from their console's front-end bundle (undocumented, so it may change):

```
GET https://api.minimaxi.com/v1/coding_plan/remains
Authorization: Bearer <your key>
```

Key fields:

| Field | Meaning |
| --- | --- |
| `model_remains[].current_interval_remaining_percent` | 5-hour window remaining percentage (already the *remaining* value — do not subtract from 100) |
| `model_remains[].current_weekly_remaining_percent` | Weekly window remaining percentage |
| `model_remains[].end_time` / `weekly_end_time` | Reset times of the two windows (epoch milliseconds) |
| `model_remains[].current_weekly_status` | 1 = normal, 2 = weekly quota exhausted, **3 = no weekly limit on this plan** (the weekly tier is hidden then) |
| `base_resp.status_code` | 0 = success. **This endpoint answers HTTP 200 even when auth fails**, so this body field is the only reliable signal |

The code tries three equivalent paths in turn (`coding_plan/remains`, `api/openplatform/coding_plan/remains`, `token_plan/remains`) as a fallback, since the routing is strict and may change.

### Implementation notes

- **The Host half declares `inject: ['webServer']`.** This is required: the `webServer` service comes from the web app bundle and may load *after* this plugin. Without the declaration the plugin runs too early, silently skips registering the route, and the UI shows “cannot connect”.
- **The reading refreshes every 60 seconds**, and again when you hover or click the pill.
- **The pill only appears for MiniMax models.** An account with no plan quota (pay-as-you-go) hides the entry entirely rather than showing an empty reading.
- This is a display-only plugin: it writes no session events, changes no model routing, and takes no part in the prompt.

## Known limitations

- MiniMax **China** only (`api.minimaxi.com`). The international host `api.minimax.io` is a separate account system and the key does not cross over.
- The endpoint is undocumented; if MiniMax moves it, update `QUOTA_ENDPOINTS` in `index.js`.
- Pay-as-you-go (BYOK) accounts have no plan quota, so the plugin hides itself.

## License

MIT
