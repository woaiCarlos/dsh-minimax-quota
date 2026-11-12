# dsh-minimax —— MiniMax 额度显示与模型自动补充 插件设计

日期：2026-11-12
状态：待评审
仓库：`woaiCarlos/dsh-minimax-quota`（URL 不变）
包名：`dsh-minimax`（由 `dsh-minimax-quota` 改名）

---

## 1. 背景与目标

用户当前有一个 MiniMax 额度显示插件（`dsh-minimax-quota`），以及一份**手写**的 profile 配置，
用来给 MiniMax 模型打开思考强度：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      minimax-cn:
        apiKeyEnv: MINIMAX_CN_API_KEY
        models:
          - id: MiniMax-M2.7-highspeed
            name: MiniMax-M2.7-highspeed
            contextWindow: 204800
            maxTokens: 131072
            input: [text]
          - id: MiniMax-M3
            name: MiniMax-M3-1M
            contextWindow: 1000000
            maxTokens: 512000
            input: [text, image]
          - id: MiniMax-M3.1-Flash
            name: MiniMax-M3.1-Flash
            input: [text, image]
            contextWindow: 1000000
            maxTokens: 512000
            compat:
              forceAdaptiveThinking: true
            reasoningEfforts:
              low: low
              medium: medium
              high: high
              xhigh: xhigh
              max: max
```

手写配置的问题是：MiniMax 发布新模型时，必须手动查 id、手动补条目；
条目里的数值是照抄 pi-ai 内置 catalog 的，而那份 catalog 与 MiniMax 官方并不一致（见 §2.4）。

本设计把这些交给插件。

### 目标

| 目标 | 验收标准 |
| --- | --- |
| 额度显示 | 保留现有功能：输入框下方显示 5 小时窗口与周窗口剩余百分比，点击展开详情 |
| 新模型自动出现 | MiniMax 发布新模型后，插件自动把它补进「设置 → 模型」 |
| 思考能力准确 | 每个新模型的思考档位按**实测 + 官方规格**决定，不靠猜 |
| **不强制覆盖** | **绝不修改用户已有的模型条目，绝不删除任何条目** |
| 无变化不动 | 没有新模型时，不写 profile patch，不产生任何文件变动 |
| 变更可见 | 新增模型有提醒 |
| 不泄露凭据 | 仓库与运行时都不出现 API Key 明文 |

---

## 2. 现状事实（实测，非推测）

以下全部通过实际调用 MiniMax API 与阅读 pi-ai 源码确认。

### 2.1 模型清单

`GET https://api.minimaxi.com/v1/models`（`Authorization: Bearer <key>`）返回 **9 个**模型，
但其中 **3 个已下线**。判定方式是发一次真实请求：

| 模型 id | 出现在 `/v1/models` | 实际可用 | 实测思考 |
| --- | --- | --- | --- |
| MiniMax-M3.1-Flash | 是 | 是 | 是（38 thinking tokens） |
| MiniMax-M3 | 是 | 是 | 是（41） |
| MiniMax-M2.7-highspeed | 是 | 是 | 是（37） |
| MiniMax-M2.7 | 是 | 是 | 是（30） |
| MiniMax-M2.5 | 是 | 是 | 是（38） |
| MiniMax-M2.5-highspeed | 是 | 是 | 是（35） |
| MiniMax-M2.1 | 是 | **否**（`no longer available (2069)`） | — |
| MiniMax-M2.1-highspeed | 是 | **否**（同上） | — |
| MiniMax-M2 | 是 | **否**（同上） | — |

> `/v1/models` **不能**作为权威清单使用。只读它的实现会把三个死模型写进用户的模型列表。

### 2.2 探测方法学（一个必须记录的教训）

首次探测用 `"hi"` 作为提示词，得到「所有模型都不思考」的错误结论。
原因是模型对无需推理的输入本就不产生思考块 —— 这是**假阴性**。

改用能引发推理的提示词（`"What is 17*23? Think it through."`）后，
6 个可用模型**全部**产生 `thinking` 块。

**结论：能力探测的提示词必须能稳定引发思考，否则结果不可信。**

### 2.3 MiniMax 自己会给的规格（免费）

**`maxTokens`（单次最大输出）直接写在错误消息里**，且因为在生成前就被拒绝，**不计费**：

```
invalid params, model[MiniMax-M2.7] does not support max tokens > 196608 (2013)
invalid params, model[MiniMax-M3]   does not support max tokens > 524288 (2013)
```

探法：发一个 `max_tokens` 远超上限的请求，读回错误消息里的数字。

**`contextWindow` 无法这样拿到** —— 超限只给一句没有数字的
`invalid params, context window exceeds limit (2013)`。
二分探测不可行：输入按 token 真实计费（10 000 字符 → 1 255 token，
400 000 字符 → 50 074 token），在 204 800 附近二分一轮就是几十万 token。

**`input` 模态不构成 API 层限制** —— 给四个模型都发一张 1×1 PNG，全部接受，
包括 pi-ai 标成纯文本的 M2.7。pi-ai catalog 里的 `input: [text]` 是**客户端策略**，
不是 MiniMax 的约束。

### 2.4 二手规格源互相矛盾

| 源 | M2.7 上下文 | M2.7 最大输出 | M3 上下文 | M3 最大输出 | 收录 M3.1-Flash |
| --- | --- | --- | --- | --- | --- |
| **MiniMax API（权威）** | 边界 15 万✓ / 50 万✗ | **196 608** | 边界 62 万✓ / 250 万✗ | **524 288** | — |
| models.dev `minimax-cn` | 204 800 | 131 072 | 1 000 000 | 524 288 | 是 |
| OpenRouter | 196 608 | 176 947 | 1 048 576 | 512 000 | 是 |
| pi-ai 内置 catalog | 204 800 | 131 072 | 1 000 000 | 512 000 | **否** |
| pi-ai npm 1.5.2 | 204 800 | 131 072 | 1 000 000 | 524 288 | 是 |
| 用户手写 | 204 800 | 131 072 | 1 000 000 | 512 000 | 是 |

结论：

- **上下文窗口**用 models.dev（与 API 实测边界吻合），二手源之间只差 2%–5%。
- **最大输出**必须用 MiniMax API 探测 —— 二手源在 M2.7 上差了 50%（131 072 vs 196 608）。
- **pi-ai 内置 catalog 不能作为数据源**：缺 M3.1-Flash，且 M3 的 `maxTokens` 偏小。

### 2.5 官方规格库：models.dev

`https://models.dev/api.json` 是公开的机器可读规格库，含 `minimax-cn` 与
`minimax-cn-coding-plan` 两个 provider（**与用户的路由对应**）。
每个模型条目提供：

```json
"MiniMax-M3.1-Flash": {
  "limit": { "context": 1000000, "output": 524288 },
  "modalities": { "input": ["text", "image", "video"], "output": ["text"] },
  "reasoning": true,
  "reasoning_options": [{ "type": "effort", "values": ["low","medium","high","xhigh","max"] }],
  "cost": { "input": 0.1494, "output": 0.5976, "cache_read": 0.0149 },
  "release_date": "2026-10-19"
}
```

**`reasoning_options` 直接回答了「哪些模型支持思考强度」**：

| 模型 | reasoning | reasoning_options | 含义 |
| --- | --- | --- | --- |
| MiniMax-M3.1-Flash | ✅ | `[{type:'effort', values:[low,medium,high,xhigh,max]}]` | **支持思考强度档位** |
| MiniMax-M3 | ✅ | `[{type:'toggle'}]` | 只能开 / 关 |
| MiniMax-M2 / M2.1 / M2.5 / M2.7 / *-highspeed | ✅ | `[]` | 思考，但无档位 |

用户手写配置只给 M3.1-Flash 配了 `reasoningEfforts` 档位 —— **与 models.dev 完全一致**。

运行时的限制：models.dev **没有 per-provider 端点**
（`/api/minimax-cn.json` 返回 HTML 404 页；`?provider=` 参数不生效），
整个库 235 个 provider、6 MB（gzip 614 KB）。

### 2.6 pi-ai 侧机制

| 事实 | 位置 |
| --- | --- |
| `providers` 是 **volatile** 字段，可运行时写入 | `dsh-llm-pi-ai/lib/index.js:1086` |
| `settings.write(ns, change, expected, paths)` 写入 profile patch | `dsh-settings/lib/index.js:501` |
| `settings.describe()` 返回 `{ ns, revision, value, … }` | `dsh-settings/lib/index.js:414` |
| 模型条目必填 `id`，另需 `name`/`contextWindow`/`maxTokens`/`input` | `dsh-llm-pi-ai/lib/index.js:1045` |
| `reasoningEfforts` 可为 `false`（不提供档位） | `dsh-llm-pi-ai/lib/index.js:1042` |
| 声明 `models` 会**整体替换** catalog；`modelOverrides` 无法新增 catalog 外的模型 | `dsh-llm-pi-ai/lib/index.js:668` |
| `forceAdaptiveThinking` = 强制用 adaptive 思考格式，与「是否支持思考」无关 | pi-ai `compat-schema` |
| `forceAdaptiveThinking: true` → `thinking:{type:'adaptive'}` + `output_config.effort` | `anthropic-messages.js:945` |
| 否则 → `thinking:{type:'enabled', budget_tokens:N}`，且 `xhigh`/`max` 被压成 `high` | `simple-options.js:66` |
| adaptive 格式在 MiniMax 上实测**可用**，且档位精确传递 | 实测 |
| `configEditor` / `profileContext` 都是插件可达的服务 | `dsh-config-editor/lib/index.js:19` |

---

## 3. 范围

### 做

- 保留额度显示（Host 半侧 + 浏览器半侧）
- 自动发现 MiniMax 新模型并**追加**到 `llm-pi-ai` 的 `providers.minimax-cn.models`
- 新模型的思考档位按 models.dev 的 `reasoning_options` + 实测决定
- 新增模型时提醒
- 手动同步按钮

### 不做

- **不修改、不覆盖、不删除**用户已有的模型条目
- **不自动删除**已下线的模型（`/v1/models` 混着 3 个已下线模型，但删不删由用户决定）
- **不并入** `@local/dsh-pet-minimax-balance`（桌宠气泡）。它走 dsh-pet 特有的扩展点
  `petApi7340.balance.register`，与本插件结构无关，保持独立。
- **不修改** DSH 内置的 pi-ai catalog（那是 App 包内的静态文件）。
- **不发布到 npm**。分发渠道是 GitHub 仓库。

---

## 4. 架构

```
dsh-minimax
├── index.js    Host 半侧
│   ├── fetchQuota()        GET /v1/coding_plan/remains        （现有）
│   ├── fetchModelIds()     GET /v1/models                     （候选 id）
│   ├── probeMaxTokens()    POST /anthropic/v1/messages       （超限 → 免费读上限）
│   ├── probeThinking()     POST /anthropic/v1/messages       （是否思考）
│   ├── MODEL_SPECS         内置快照：contextWindow / 模态 / reasoning_options
│   └── syncModels()        仅追加 → settings.write('llm-pi-ai')
├── client.js   浏览器半侧
│   ├── 额度药丸 + 点击详情面板                                （现有）
│   └── 面板内「模型」区：已同步列表 + 新增提醒 + 同步按钮
└── 路由
    GET  /plugin/minimax/status    额度 + 模型状态 + 上次同步结果
    POST /plugin/minimax/sync      立刻同步一次
```

### 依赖

```js
export const inject = ['credentials', 'settings']
```

`settings` 用于写 pi-ai 的配置；`credentials` 用于取 API Key。两者都是宿主提供的服务，
插件在它们就绪时才激活。

---

## 5. 参数来源

每个模型条目的字段来自三个地方，**没有一个字段靠猜**：

| 字段 | 来源 | 成本 |
| --- | --- | --- |
| `id` | MiniMax `/v1/models` | 免费 |
| `name` | 同上 | 免费 |
| `maxTokens` | **探测**：发一个 `max_tokens` 超限的请求，读错误消息里的数字 | **免费**（生成前拒绝） |
| `contextWindow` | 内置的 models.dev 快照 | 免费 |
| `input` 模态 | 内置的 models.dev 快照 | 免费 |
| `reasoningEfforts` | models.dev 的 `reasoning_options` 决定**档位形态**；实测决定**是否思考** | 约 40 token/模型 |
| `compat.forceAdaptiveThinking` | 仅当该模型支持 effort 档位时设 `true` | — |
| 是否写入列表 | **探测**：已下线（`no longer available`）的不写 | 一条短消息 |

### 5.1 为什么给支持档位的模型设 `forceAdaptiveThinking`

| 格式 | 档位传递 |
| --- | --- |
| 预算式（不设） | `xhigh`/`max` 被 `clampReasoning` 压成 `high`，思考预算上限 16 384 |
| 自适应式（设） | `output_config.effort` 原样传 `max`/`xhigh`，档位精确 |

用户 `max` 档的意图是「思考到底」，压成 `high` 不是本意。自适应格式在 MiniMax 上实测可用
（thinking 109 字），所以给支持 effort 档位的模型设上。

只有 M3.1-Flash 这类模型需要；M3 与 M2.x 系列只有 toggle 或无档位，不设。

### 5.2 探测流程（只对「待补充的新模型」执行）

```
对每个候选 id：
  ① POST /anthropic/v1/messages  { model, max_tokens: 999999999, messages: [{role:'user',content:'hi'}] }
     ├─ 错误含 "does not support max tokens > N" → 记下 N（= maxTokens），免费
     ├─ 错误含 "no longer available"             → 该模型已下线，跳过
     └─ 无错误（说明 max_tokens 小于上限）      → 记 999999999 为上限，继续下一步
  ② POST /anthropic/v1/messages  { model, max_tokens: 8192,
                                    messages:[{role:'user',content:'What is 17*23? Think it through.'}],
                                    thinking:{type:'enabled', budget_tokens:4096} }
     ├─ 返回含 thinking 块 → 支持思考
     └─ 不含                → 不支持思考
```

② 用**预算式** thinking，这是 pi-ai 在不设 `forceAdaptiveThinking` 时的默认路径，
测的就是真实使用路径。

### 5.3 内置规格快照

插件内置 models.dev 的 `minimax-cn` provider 快照（约 2 KB），覆盖 9 个已知模型：

| 模型 | contextWindow | 模态 | reasoning_options |
| --- | --- | --- | --- |
| MiniMax-M3.1-Flash | 1 000 000 | text, image, video | effort（5 档） |
| MiniMax-M3 | 1 000 000 | text, image, video | toggle |
| MiniMax-M2.7 | 204 800 | text | 无 |
| MiniMax-M2.7-highspeed | 204 800 | text | 无 |
| MiniMax-M2.5 | 204 800 | text | 无 |
| MiniMax-M2.5-highspeed | 204 800 | text | 无 |
| MiniMax-M2.1 / M2.1-highspeed / M2 | 204 800 | text | 无 |

快照里的模型 `input` 模态按 models.dev 原样保留（`video` 也保留 —— API 层不拦）。

**快照里没有的新模型**：用保守默认值（`contextWindow` 1 000 000、`maxTokens` 用探测值、
`input` [text]、`reasoningEfforts: false`），并在面板上标记「未验证」。

**运行时不拉 models.dev** —— 整个库 6 MB，没有 per-provider 端点，
为了一次同步下载 235 个 provider 的规格不值。快照随插件更新。

### 5.4 生成的模型条目

支持 effort 档位的模型：

```yaml
- id: MiniMax-M3.1-Flash
  name: MiniMax-M3.1-Flash
  contextWindow: 1000000
  maxTokens: 524288
  input: [text, image]
  reasoningEfforts:
    low: low
    medium: medium
    high: high
    xhigh: xhigh
    max: max
  compat:
    forceAdaptiveThinking: true
```

只支持 toggle 或无档位的模型：

```yaml
- id: MiniMax-M2.7
  name: MiniMax-M2.7
  contextWindow: 204800
  maxTokens: 196608
  input: [text]
  reasoningEfforts: false
```

---

## 6. 同步算法（只增不删不覆盖）

核心原则：**用户已有的条目，插件一个字都不动。**

```
读当前 providers['minimax-cn'].models  →  已有列表
读插件自己的 config.addedModels        →  插件已添加过的 id 集合
读 GET /v1/models                      →  候选 id
  ↓
待补充 = 候选 id 中：
   ├─ 不在「已有列表」里            （完全没出现过）
   └─ 不在「插件已添加过」集合里     （用户手动删过 → 不再自动加回）
  ↓
对每个「待补充」id 探测（§5.2）
  ├─ 已下线          → 跳过，不写入
  ├─ 探测失败        → 跳过，不写入，记日志
  └─ 探测成功        → 生成条目
  ↓
把新条目**追加**到已有列表末尾
  ↓
与「已有列表 + 新条目」逐字段比较
  ├─ 完全相同 → 不写，不动任何文件
  └─ 有差异   → settings.write('llm-pi-ai', …, revision, ['providers','minimax-cn','models'])
                并把新 id 记入 config.addedModels（经 configEditor.edit 写入）
```

### 6.1 「只增不删」带来的两个推论

**已下线的模型留在列表里。** `/v1/models` 里混着 3 个已下线模型，插件不删它们
（用户明确要求不强制删除）。插件**不会**把它们加进来（新条目必须探测通过），
但如果用户已经手写了这些 id，插件也不动。

**用户删掉的模型不会被加回来。** 因为插件在 `config.addedModels` 里记住了自己加过哪些 id，
用户手动删除后，插件认为那是用户的决定，不再自动补回。

### 6.2 并发保护

`settings.write` 的第三个参数是 `describe()` 返回的 `revision`，不匹配会抛
`SettingsConflictError`。写入失败（配置被其他来源覆盖）时：

- 放弃本次写入
- 记录日志
- 下次同步重试

### 6.3 写入失败绝不影响插件本体

探测与写入全程 try/catch。同步失败时插件照常工作（额度显示不受影响），
只是模型列表没更新。

---

## 7. 提醒机制

DSH 没有给插件用的 toast 服务（`toast` 相关命中全是 CSS 变量），因此提醒落在插件自己的界面上：

1. **药丸上的提醒标记** —— 有新增模型时，药丸带一个小圆点，不点开也能看见。
2. **详情面板的「模型」区** —— 列出已同步的模型、新增了哪些、什么时间。
3. **Host 日志** —— 同步记一行。

因为插件只新增不删除，所以没有「撤销删除」这一说。
用户不想要某个新增模型，手动删掉即可，插件不会加回（§6.1）。

---

## 8. 配置与数据流

### 8.1 用户 profile 的最终形态

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      minimax-cn:
        apiKeyEnv: MINIMAX_CN_API_KEY
        models:
          # 用户手写的三条保持原样，插件一个字都不动
          - id: MiniMax-M2.7-highspeed
            ...
          - id: MiniMax-M3
            ...
          - id: MiniMax-M3.1-Flash
            ...
          # 插件追加的新模型出现在这里
```

### 8.2 插件自己的状态

插件用自己那一行存状态（`config.addedModels`），经 `ctx.configEditor.edit()` 写入 profile patch：

```yaml
- id: minimax
  name: "dsh-minimax"
  config:
    credentialRef: MINIMAX_CN_API_KEY
    addedModels:
      - MiniMax-M3.1-Flash
```

### 8.3 凭据安全

- 仓库里**只有引用名** `MINIMAX_CN_API_KEY`，没有密钥
- 密钥经 `ctx.credentials.resolve()` 在 Host 侧按请求解析
- 浏览器只拿到百分比、时间戳、模型 id 列表 —— 没有任何密钥材料

---

## 9. 测试策略

| 层 | 手段 |
| --- | --- |
| 额度解析 | 固定 fixture 喂给解析函数，断言百分比与重置时间 |
| 错误消息解析 | 断言能从 `does not support max tokens > N` 里取出 N |
| 模型条目生成 | 给定「探测结果 + 规格快照」，断言生成的 YAML 结构 |
| 同步合并 | 给定「已有列表 + 已添加集合 + 候选」，断言只追加、不修改、不删除 |
| 删除护栏 | 断言已下线模型与探测失败的模型都不写入 |
| 端到端 | 隔离 DSH profile，从 GitHub 安装，冷启动，断言药丸渲染与新模型被追加 |
| 真实 API | 手动验证脚本，对真实 API 跑一次全量探测并打印对照表 |

---

## 10. 兼容性

- **社区目录 PR #14276** 引用的是**仓库 URL**，不是包名 → 改包名不影响它。
  条目里的 `name` 字段是 `owner/repo` 形式，同样不受包名影响。**无需改动。**
- **市场索引** 里的条目 source 是 git，指向仓库 commit，与包名无关。
- **`@local/dsh-pet-minimax-balance`** 保持独立安装，不受影响。

---

## 11. 实施顺序

1. Host 半侧：探测（maxTokens / 可用性 / 思考）+ 规格快照 + 条目生成（纯函数，先单测）
2. Host 半侧：同步（只追加）+ 并发保护 + 写 pi-ai 配置
3. 路由：`status` / `sync`
4. 浏览器半侧：药丸上的提醒标记 + 面板的「模型」区
5. 迁移：改包名为 `dsh-minimax`、更新 patch 行 id、更新 README
6. 端到端验证：隔离 profile + GitHub 安装 + 冷启动
7. 提交 + 推送，更新市场索引的 commit

---

## 12. 未决问题

- **规格快照的更新方式**：内置快照随插件版本更新。若将来想自动刷新，
  可选 OpenRouter 的 `/api/v1/models`（845 KB，比 models.dev 的 6 MB 小），但它的
  MiniMax 条目更少、且没有 `reasoning_options`。当前决定不自动刷新。
- **`input` 模态要不要含 `video`**：models.dev 标了 video，但 pi-ai 的 `MODALITIES`
  是否接受 video 需要在实现时确认；不接受则只保留 text / image。
- **`maxTokens` 用 API 的硬上限还是 models.dev 的值**：本设计用 API 的硬上限
  （M2.7 会是 196 608 而非 131 072）。若实际使用中遇到问题，改回快照值即可。
