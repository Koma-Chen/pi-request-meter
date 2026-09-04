# Pi Request Meter

[中文](#中文) | [English](#english)

## 中文

零额外模型调用地统计 Pi 请求用量，并重点提示可能导致 Token 异常消耗的行为。

### 特点

- 读取 assistant 消息中由供应商上报的 input、output、cache read/write、reasoning 和费用估算
- 区分有效、全零和缺失 usage，并显示统计覆盖率；reasoning 未上报时不会伪装成 0
- 单独统计上下文压缩、树摘要及工具内模型上报的额外用量，避免和主模型重复相加
- 检测提示词突增、缓存命中崩塌、重复请求、重试风暴、大工具结果、输出截断、推理异常和重复压缩
- 流式输出期间以本地估算实时刷新状态栏，最终仍以供应商 usage 为准
- 在 user bash 输出真正进入下一次上下文时延迟统计，并与工具结果分开显示
- 状态栏只显示紧凑结果，详细信息通过 `/request-meter` 按需查看
- 不注册模型 Tool、不调用模型、不注入 system prompt 或会话消息，不增加模型输入 Token
- 不保存提示词、响应或工具原文；重复请求检测只在内存中保留 SHA-256 哈希
- 使用独立 `setStatus` 状态项，可与 `pi-ccswitch-balance` 等页脚扩展共存

### 安装

```bash
pi install npm:pi-request-meter
```

或从 GitHub 安装：

```bash
pi install git:github.com/Koma-Chen/pi-request-meter
```

安装后重启 Pi，或执行 `/reload`。

要求 Pi `>= 0.85.0`；当前实现已在 Pi `0.85.0` 验证。

### 使用

```text
/request-meter
/request-meter alerts off
/request-meter alerts on
/request-meter reset
```

- `/request-meter`：显示最近一次任务的精确用量、工具结果估算、异常和可观测边界
- `alerts off/on`：仅关闭或开启弹窗提醒，检测和状态栏仍然工作；设置只在当前进程生效
- `reset`：清空当前会话统计，不修改 Pi 会话内容

状态栏示例：

```text
Token ⚠2 · 本次 640k · 请求 8 · 最近 82k · 缓存 6% · 输出~2.1k
Token 正常 · 上次 61k
Token ⚠3 · 上次 820k · 下界
```

### 异常规则

规则采用较保守的固定阈值，同一任务的同类异常只提醒一次：

| 异常 | 默认条件 |
| --- | --- |
| 单次提示绝对过大 | 达到 80k Token，或占模型上下文窗口 40%；占 70% 时按高风险提醒 |
| 提示词突然增长 | 相邻可比请求至少增加 20k，且达到前一次的 1.5 倍 |
| 缓存命中率骤降 | 两次提示均至少 20k，命中率从至少 50% 降至不高于 10%，且未缓存提示增加至少 10k |
| 连续重复请求 | 连续 3 次完整或降级采样的 provider payload 指纹相同 |
| 网络重试风暴 | 连续观察到至少 2 个 HTTP 429/5xx；成功响应会清零连续计数 |
| 连续模型失败 | 连续 3 个 assistant 以 `error` 结束 |
| usage 不完整 | assistant usage 缺失或全零；请求仍计数，但不参与相对比较 |
| 大上下文贡献项 | 8k 仅记为主要贡献；达到 20k 或模型窗口 10% 才告警 |
| 工具内模型异常 | 单次任务中工具内模型累计达到 100k Token |
| 输出异常 | `stopReason=length`，或单次输出达到 16k Token |
| 推理异常 | 非 high/xhigh/max 下单次达到 16k，或连续两次达到 8k 且占输出 80% 以上 |
| 上下文接近上限 | Pi 估算当前上下文达到模型窗口的 85% |
| 请求轮次偏多 | 单次任务达到 12 次 assistant 请求，独立触发 |
| 累计提示异常 | 单次任务累计提示达到 500k Token，独立触发 |
| 全口径累计异常 | 单次任务的主模型、压缩和工具内模型上报总计达到 750k；空闲压缩/树摘要单次达到 750k 也独立告警 |
| 压缩异常 | 单次任务重复压缩，或压缩失败 |

相对比较优先使用 assistant 实际返回的 provider、response model 和 provider thinking。失败、取消、全零 usage，以及模型、thinking、压缩和树导航变化都不会污染下一次比较基线。

### 数据准确性

**供应商上报值：** assistant、压缩和树摘要事件中的 Token 数。`output` 已包含 reasoning，报告只把 reasoning 当作其中的细分，不重复相加。报告会显示有效、全零、缺失 usage 数量；reasoning 字段缺失时显示“未上报”。

**本地估算值：** 工具结果、user bash 和流式输出按 UTF-8 字节数除以 4 估算，仅用于定位趋势和大贡献项；图片 Token 不估算。

**费用估算：** Pi 根据本地模型目录价格计算，不等同于订阅、代理加价或供应商最终账单。

### 已知边界

- 不同供应商对错误和中断请求可能返回零或不返回 usage，此时统计只是下界
- 网络层内部重试不保证触发每次 `after_provider_response`，因此 HTTP 重试数也是下界
- 压缩内部失败重试不暴露逐次 usage；成功只记录最终上报值，失败记为未知消耗
- 压缩取消或中止可能已经产生消耗，不作为失败弹窗，但会计入“取消不确定”并让状态栏标记“下界”
- 树摘要失败或中止没有完成事件；插件会在请求摘要前登记待决状态，完成前按“下界”显示，若到下一个操作边界仍未完成则记为未知消耗
- 内置工具可能在事件触发前已经截断原始输出，插件只统计最终写入会话的部分；其他 context 扩展仍可能在请求前改写它
- user bash 没有执行后事件，只能在输出进入下一次模型 context 时延迟发现
- user bash 每次 context 最多扫描 1,000 条消息、计算 100 条固定大小指纹，并用旋转游标逐批处理积压；固定 8KB Bloom filter 让内存有界且树导航不重算，极端长会话存在极低概率漏计
- 技能展开、附件和超长粘贴会反映在下一次总提示量中，但无法跨供应商精确拆分来源
- 其他扩展直接调用 `modelRegistry.complete()` 的请求可能不经过 Agent 事件，例如标题摘要请求
- 超大字符串和 typed array 使用长度及头、中、尾采样生成降级指纹；结构超过节点/深度/总工作预算时不参与重复比较，避免高碰撞误报
- 后续扩展仍可修改 payload，因此重复检测只代表本插件当时看到的内容
- 压缩失败可能已经消耗 Token，但没有 usage 时只能标记为“未知”，不会伪造零消耗
- v0.1 不持久化历史、不远程上报、不自动压缩、不切换模型，也不阻断请求

## English

Track Pi request usage without additional model calls, with an emphasis on behavior that may cause abnormal token consumption.

### Features

- Reads provider-reported input, output, cache read/write, reasoning, and estimated cost from assistant messages
- Distinguishes valid, all-zero, and missing usage and reports coverage; unavailable reasoning is not presented as zero
- Tracks compaction, tree-summary, and tool-reported nested model usage separately to avoid double counting
- Detects prompt growth, cache collapse, duplicate requests, retry storms, large tool results, truncated output, reasoning spikes, and repeated compaction
- Updates the status during streaming with a local estimate while keeping provider usage as the final source of truth
- Accounts for user-bash output once it actually enters the next model context and reports it separately from tool results
- Keeps the status line compact and exposes details on demand through `/request-meter`
- Registers no model tool, calls no model, and injects no system prompt or session message, so it adds no model input tokens
- Stores no prompt, response, or tool-result text; duplicate detection keeps only in-memory SHA-256 hashes
- Uses its own `setStatus` entry and coexists with footer extensions such as `pi-ccswitch-balance`

### Installation

```bash
pi install npm:pi-request-meter
```

Or install from GitHub:

```bash
pi install git:github.com/Koma-Chen/pi-request-meter
```

Restart Pi after installation, or run `/reload`.

Requires Pi `>= 0.85.0`; the current implementation is verified against Pi `0.85.0`.

### Usage

```text
/request-meter
/request-meter alerts off
/request-meter alerts on
/request-meter reset
```

- `/request-meter` shows the latest operation's reported usage, tool-result estimates, anomalies, and observability limits
- `alerts off/on` disables or enables pop-up warnings only; detection and status continue, and the setting lasts for the current process
- `reset` clears current-session metrics without changing the Pi session

Status examples:

```text
Token ⚠2 · 本次 640k · 请求 8 · 最近 82k · 缓存 6% · 输出~2.1k
Token 正常 · 上次 61k
Token ⚠3 · 上次 820k · 下界
```

### Anomaly rules

The defaults are intentionally conservative, and each anomaly type alerts at most once per operation:

| Anomaly | Default condition |
| --- | --- |
| Absolute prompt size | Reaches 80k tokens or 40% of the model context window; 70% is reported as high risk |
| Prompt jump | At least 20k more than the previous comparable request and at least 1.5× its size |
| Cache collapse | Both prompts are at least 20k; cache read falls from at least 50% to at most 10%, with at least 10k more uncached prompt tokens |
| Duplicate requests | Three consecutive complete or sampled provider-payload fingerprints match |
| HTTP retry storm | At least two consecutive visible HTTP 429/5xx responses; a success resets the streak |
| Model failure streak | Three consecutive assistant messages end with `error` |
| Incomplete usage | Assistant usage is missing or all zero; the request is counted but excluded from relative baselines |
| Large context contributor | 8k is recorded as a major contributor; an alert requires 20k or 10% of the model window |
| Large nested usage | Tool-reported nested models reach 100k cumulative tokens in one operation |
| Output anomaly | `stopReason=length`, or one response reaches 16k output tokens |
| Reasoning anomaly | Outside high/xhigh/max, one response reaches 16k reasoning tokens, or two consecutive responses reach 8k and 80% of output |
| Context near limit | Pi estimates at least 85% of the model context window is occupied |
| High request count | Reaches 12 assistant requests in one operation, independently |
| Cumulative prompt | Reaches 500k cumulative prompt tokens in one operation, independently |
| Cumulative reported total | Main model, compaction, and nested model usage reaches 750k in one operation; an idle compaction/tree summary also alerts independently at 750k |
| Compaction anomaly | Repeated compaction in one operation, or a failed compaction |

Relative comparisons prefer the provider, response model, and provider thinking level reported by each assistant message. Failed, aborted, and all-zero usage samples do not become baselines; model, thinking, compaction, and tree-navigation changes also reset the baseline.

### Accuracy

**Provider-reported:** token counts from assistant, compaction, and tree-summary events. Output already includes reasoning; reasoning is displayed only as a breakdown and is not added twice. Reports show valid, all-zero, and missing usage counts, and display unavailable reasoning as “not reported.”

**Locally estimated:** tool results, user bash, and streaming output use UTF-8 byte length divided by four and are used only for trends and large-contributor detection. Image tokens are not estimated.

**Estimated cost:** calculated by Pi from local model catalog pricing and may differ from subscriptions, gateway markups, or final provider billing.

### Known limits

- Providers may report zero or omit usage for failed and aborted requests, making totals a lower bound
- Transport-level retries do not always emit every `after_provider_response`, so visible HTTP retries are also a lower bound
- Internal compaction retries do not expose usage per failed attempt; success records only the final reported usage, while failure is marked unknown
- Cancelled or aborted compaction may already have consumed tokens; it does not raise a failure pop-up, but is counted as uncertain and marks the status as a lower bound
- Failed or aborted tree summaries have no completion event; the extension marks them pending before summarization, shows a lower bound while unresolved, and records unknown usage if they remain unresolved at the next operation boundary
- Built-in tools may truncate raw output before the event; the extension measures the final session message, which a later context extension may still rewrite before a request
- User bash has no post-execution event and is discovered only when its output enters the next model context
- Each context scans at most 1,000 messages and fingerprints at most 100 user-bash entries with a rotating cursor; a fixed 8KB Bloom filter bounds memory and prevents tree-navigation recounts, with a small false-positive risk in extremely long sessions
- Expanded skills, attachments, and large pasted input affect the next total prompt size but cannot be attributed precisely across providers
- Direct `modelRegistry.complete()` calls made by other extensions may bypass Agent events, including title-summary requests
- Huge strings and typed arrays use length plus head/middle/tail samples; structures exceeding node, depth, or total-work limits are excluded from duplicate comparison to avoid collision-based false positives
- Later extensions may still modify the payload, so duplicate detection describes only what this extension observed
- Failed compaction may consume tokens without reporting usage; the extension marks this as unknown instead of inventing zero usage
- v0.1 does not persist history, upload telemetry, compact automatically, switch models, or block requests

## Development

```bash
npm run check
npm pack --dry-run
```

## License

[MIT](LICENSE)
