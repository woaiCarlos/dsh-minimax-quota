# dsh-minimax —— MiniMax 额度显示与模型自动同步 插件设计

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

这份手写配置有三个问题：

1. **模型列表会过期。** MiniMax 发布新模型时，用户必须手动去查 id、手动补条目。
2. **条目不完整。** 用户手写的 `maxTokens: 512000` 与 pi-ai 官方 catalog 的 `524288` 不一致。
3. **思考能力是猜的。** 用户只给 M3.1-Flash 配了思考档位，其他模型配没配、该不该配，靠人工判断。

本设计把以上三件事全部交给插件。

### 目标

| 目标 | 验收标准 |
| --- | --- |
| 额度显示 | 保留现有功能：输入框下方显示 5 小时窗口与周窗口剩余百分比，点击展开详情 |
| 模型自动发现 | MiniMax 发布新模型后，插件自动把它加进「设置 → 模型」 |
| 模型自动下线 | MiniMax 下线模型后，插件自动把它从列表移除 |
| 思考能力准确 | 每个模型的思考档位由**实测**决定，不靠猜 |
| 无变化不动 | 没有模型变化时，不写 profile patch，不产生任何文件变动 |
| 变更可见 | 新增与移除都有提醒 |
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
原因是模型对无需推理的输入本就��产生思考块 —— 这是**假阴性**。

改用能引发推理的提示词（`"What is 17*23? Think it through."`）后，
6 个可用模型**全部**产生 `thinking` 块。

**结论：能力探测的提示词必须能稳定引发思考，否则结果不可信。**

### 2.3 pi-ai 侧机制

| 事实 | 位置 |
| --- | --- |
| `providers` 是 **volatile** 字段，可运行时写入 | `dsh-llm-pi-ai/lib/index.js:1086` |
| `settings.write(ns, change, expected, paths)` 写入 profile patch | `dsh-settings/lib/index.js:501` |
| `settings.describe()` 返回 `{ ns, revision, value, … }` | `dsh-settings/lib/index.js:414` |
| 模型条目必填 `id`，另需 `name`/`contextWindow`/`maxTokens`/`input` | `dsh-llm-pi-ai/lib/index.js:1045` |
| `reasoningEfforts` 可为 `false`（明确不支持思考） | `dsh-llm-pi-ai/lib/index.js:1042` |
| 声明 `models` 会**整体替换** catalog；`modelOverrides` 无法新增 catalog 外的模型 | `dsh-llm-pi-ai/lib/index.js:668` |
| `forceAdaptiveThinking` = 强制用 adaptive 思考格式，与「是否支持思考」无关 | pi-ai `compat-schema` |
| `forceAdaptiveThinking: true` → `thinking:{type:'adaptive'}` + `output_config.effort` | `anthropic-messages.js:945` |
| 否则 → `thinking:{type:'enabled', budget_tokens:N}`，且 `xhigh`/`max` 被压成 `high` | `simple-options.js:66` |
| adaptive 格式在 MiniMax 上实测**可用**，且档位精确传递 | 实测 |
| `configEditor` / `profileContext` 都是插件可达的服务 | `dsh-config-editor/lib/index.js:19` |

### 2.4 内置 catalog 不可信

pi-ai 的 catalog，DSH 内置版本与 npm 最新版（1.5.2）**并不一致**：

| 模型 | DSH 内置 catalog | npm pi-ai 1.5.2 |
| --- | --- | --- |
| MiniMax-M2.7 | ctx 204 800 / max 131 072 | 同左 |
| MiniMax-M2.7-highspeed | ctx 204 800 / max 131 072 | 同左 |
| MiniMax-M3 | ctx 1 000 000 / **max 512 000** | ctx 1 000 000 / **max 524 288** |
| MiniMax-M3.1-Flash | **缺失** | ctx 1 000 000 / max 524 288 |

结论：catalog 只能作为参考，**不能作为插件的数据源**。用户手写的 M3 条目
（`maxTokens: 512000`）恰好等于 DSH 内置 catalog 的值 —— 说明用户当时抄的是内置 catalog，
而不是 npm 上的新值。

---

## 3. 范围

### 做

- 保留额度显示（Host 半侧 + 浏览器半侧）
- 自动发现 MiniMax 模型并写入 `llm-pi-ai` 的 `providers.minimax-cn.models`
- 实测每个模型是否可用、是否支持思考，据此生成模型条目
- 变更提醒（新增 / 移除）
- 手动同步按钮

### 不做

- **不并入** `@local/dsh-pet-minimax-balance`（桌宠气泡）。它走 dsh-pet 特有的扩展点
  `petApi7340.balance.register`，与本插件结构无关，保持独立。
- **不修改** DSH 内置的 pi-ai catalog（那是 App 包内的静态文件）。
- **不发布到 npm**。分发渠道是 GitHub 仓库。
- **不跨重启持久化「钉住某个模型」**。撤销只在本次会话内有效（见 §7）。

---

## 4. 架构

```
dsh-minimax
├── index.js    Host 半侧
│   ├── fetchQuota()        GET /v1/coding_plan/remains        （现有）
│   ├── fetchModelIds()     GET /v1/models                     （候选清单）
│   ├── probeModel()        POST /anthropic/v1/messages       （可用性 + 思考能力）
│   ├── MODEL_METADATA      静态表：窗口大小 / 模态             （API 不提供的部分）
│   └── syncModels()        合并 → settings.write('llm-pi-ai')
├── client.js   浏览器半侧
│   ├── 额度药丸 + 点击详情面板                                （现有）
│   └── 面板内「模型」区：已同步列表 + 变更提醒 + 同步按钮
└── 路由
    GET  /plugin/minimax/status    额度 + 模型状态 + 上次同步结果
    POST /plugin/minimax/sync      立刻全量同步一次
    POST /plugin/minimax/undo      撤销上一步删除
```

### 依赖

```js
export const inject = ['credentials', 'settings']
```

`settings` 用于写 pi-ai 的配置；`credentials` 用于取 API Key。两者都是宿主提供的服务，
插件在它们就绪时才激活。

---

## 5. 模型发现与能力探测

### 5.1 三步流水线

```
① GET /v1/models
   → 候选 id 列表（含已下线的，不可信）

② 对每个候选发一次探测请求
   POST https://api.minimaxi.com/anthropic/v1/messages
   { model, max_tokens: 8192, messages: [{role:'user', content:'What is 17*23? Think it through.'}],
     thinking: { type: 'enabled', budget_tokens: 4096 } }
   → 报错「no longer available」  ⇒ 已下线，不写入
   → 成功且返回含 thinking 块      ⇒ 支持思考
   → 成功但无 thinking 块          ⇒ 不支持思考

③ 用静态表补齐 API 不提供的元数据
   contextWindow / maxTokens / input 模态
```

探测使用**预算式** thinking，这是 pi-ai 在不设 `forceAdaptiveThinking` 时的默认路径，
测的就是真实使用路径。

### 5.2 静态元数据表

只存 API 不给、且实测无法推导的信息：

| 模型 | contextWindow | maxTokens | input |
| --- | --- | --- | --- |
| MiniMax-M3.1-Flash | 1 000 000 | 524 288 | text, image |
| MiniMax-M3 | 1 000 000 | 524 288 | text, image |
| MiniMax-M2.7-highspeed | 204 800 | 131 072 | text |
| MiniMax-M2.7 | 204 800 | 131 072 | text |
| MiniMax-M2.5-highspeed | 204 800 | 131 072 | text |
| MiniMax-M2.5 | 204 800 | 131 072 | text |

**表里没有「是否支持思考」这一列** —— 那是实测结论，写死就会像 pi-ai 的 catalog 一样过期。

表里没有的新模型：用保守默认值（`contextWindow` 1 000 000、`maxTokens` 131 072、`input` [text]），
并在面板上标记「未验证」。

### 5.3 生成的模型条目

支持思考的模型：

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

不支持思考的模型：

```yaml
- id: MiniMax-M2.7
  name: MiniMax-M2.7
  contextWindow: 204800
  maxTokens: 131072
  input: [text]
  reasoningEfforts: false
```

### 5.4 为什么给支持思考的模型都设 `forceAdaptiveThinking`

| 格式 | 档位传递 |
| --- | --- |
| 预算式（不设） | `xhigh`/`max` 被 `clampReasoning` 压成 `high`，思考预算上限 16 384 |
| 自适应式（设） | `output_config.effort` 原样传 `max`/`xhigh`，档位精确 |

用户 `max` 档的意图是「思考到底」，压成 `high` 不是本意。自适应格式在 MiniMax 上实测可用，
所以给所有实测支持思考的模型都设上。

### 5.5 探测频率

| 时机 | 探测范围 |
| --- | --- |
| 插件启动 | 只探**当前列表里没有**的候选（新模型自动发现） |
| 每 24 小时 | 全量探测（发现下线） |
| 手动点「同步」 | 全量探测 |

「上次全量探测时间」持久化在插件自己的 profile 行里（`config.lastFullProbeAt`），
经 `ctx.configEditor.edit()` 写入。

成本：全量探测 = 9 次请求，约 600 output tokens。

---

## 6. 同步算法

```
读当前 providers['minimax-cn'].models
  ↓
探测全部候选 → 得到 { 可用模型 → 是否思考 }
  ↓ 构造目标列表（按 id 排序）
  ├─ 探测通过的模型：按 §5.3 生成条目
  ├─ 探测报「已下线」：从列表移除
  └─ 当前列表里有、但不在候选里的（用户手加的）：保留，不动
  ↓
与当前列表逐字段比较
  ├─ 完全相同 → 不写，不动任何文件
  └─ 有差异   → settings.write('llm-pi-ai', …, revision, ['providers','minimax-cn','models'])
  ↓
记录变更（新增 id 列表、移除 id 列表），供提醒使用
```

### 6.1 三道删除护栏

自动删除是危险动作，因此：

| 情况 | 行为 |
| --- | --- |
| 探测请求整体失败 | **整次同步中止**，一个都不删，只记日志 |
| 候选清单为空 | 同上，中止 |
| 本次可用模型数比上次少一半以上 | **只增不删**，提醒里写明「API 返回异常偏少，已跳过删除」 |
| 被删的是当前默认模型 | 照删，提醒里**红字标注**「默认模型已被移除，请重新选择」 |

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

1. **药丸上的提醒标记** —— 有未读变更时，药丸带一个小圆点，不点开也能看见。
2. **详情面板的「模型变更」区** —— 列出新增了哪些、移除了哪些、什么时间。
3. **移除那一行带「撤销」按钮** —— 一键恢复上一次的完整列表。
4. **Host 日志** —— 同步记一行。

### 撤销的语义

撤销恢复**上一次完整列表**，并把被移除的 id 记入本次会话的「保留集」，
使后续同步不再删除它们。

**保留集不跨重启持久化。** 插件每次启动都会同步，所以跨重启保留某个模型需要另一个机制
（见 §3「不做」）。这是已知限制，README 中会写明。

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
        # models 由 dsh-minimax 插件自动维护
```

### 8.2 凭据安全

- 仓库里**只有引用名** `MINIMAX_CN_API_KEY`，没有密钥
- 密钥经 `ctx.credentials.resolve()` 在 Host 侧按请求解析
- 浏览器只拿到百分比、时间戳、模型 id 列表 —— 没有任何密钥材料

### 8.3 一个已知的取舍

「全自动」意味着**用户手改模型条目会被插件覆盖**。内置表里的模型，下次启动就恢复成表里的值。
表里没有的模型（标着「未验证」）只补缺失字段，不动用户已有的值。

---

## 9. 测试策略

| 层 | 手段 |
| --- | --- |
| 额度解析 | 固定 fixture 喂给解析函数，断言百分比与重置时间 |
| 模型条目生成 | 给定「探测结果 + 静态表」，断言生成的 YAML 结构 |
| 同步合并 | 给定「当前列表 + 探测结果」，断言新增/移除/保留的判定 |
| 删除护栏 | 给定「探测失败」「列表为空」「数量骤降」，断言不发生删除 |
| 端到端 | 隔离 DSH profile，从 GitHub 安装，冷启动，断言药丸渲染与模型列表写入 |
| 真实 API | 手动验证脚本，对真实 API 跑一次全量探测并打印对照表 |

---

## 10. 兼容性

- **社区目录 PR #14276** 引用的是**仓库 URL**，不是包名 → 改包名不影响它。
  但条目里的 `name` 字段是 `owner/repo` 形式，同样不受包名影响。**无需改动。**
- **市场索引** 里的条目 source 是 git，指向仓库 commit，与包名无关。
- **`@local/dsh-pet-minimax-balance`** 保持独立安装，不受影响。

---

## 11. 实施顺序

1. Host 半侧：探测 + 元数据表 + 条目生成（纯函数，先单测）
2. Host 半侧：同步 + 护栏 + 写 pi-ai 配置
3. 路由：`status` / `sync` / `undo`
4. 浏览器半侧：药丸上的提醒标记 + 面板的「模型」区
5. 迁移：改包名为 `dsh-minimax`、更新 patch 行 id、更新 README
6. 端到端验证：隔离 profile + GitHub 安装 + 冷启动
7. 提交 + 推送，更新市场索引的 commit

---

## 12. 未决问题

- **保留集跨重启持久化**：需要时再做（可考虑用 `configEditor.edit` 写插件自己的行）。
- **探测提示词**：实现时确认一句中文提示词能否稳定引发思考；若不稳定，用固定英文提示词。
- **`maxTokens` 取值**：静态表用 npm pi-ai 1.5.2 的值（M3 系 524 288、M2.7 系 131 072）。
  DSH 内置 catalog 对 M3 写的是 512 000，用户手写的也是 512 000 —— 同步后 M3 的
  `maxTokens` 会从 512 000 变成 524 288（+2.4%）。这是有意的：取较新的官方值。
  若用户不同意，改静态表即可。
