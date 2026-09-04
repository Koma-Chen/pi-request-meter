# Pi Request Meter

[中文](#中文) | [English](#english)

## 中文

零额外模型调用地统计 Pi 请求用量，并重点提示可能导致 Token 异常消耗的行为。

### 特点

- 读取 assistant 消息中由供应商上报的 input、output、cache read/write、reasoning 和费用估算
- 单独统计上下文压缩、树摘要及工具内模型上报的额外用量，避免和主模型重复相加
- 检测提示词突增、缓存命中崩塌、重复请求、重试风暴、大工具结果、输出截断、推理异常和重复压缩
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
Token 请求 3 · 提示 42.1k · 缓存 71%
Token 正常 · 会话 183k
Token ⚠ 2 项 · 640k
```

### 异常规则

规则采用较保守的固定阈值，同一任务的同类异常只提醒一次：

| 异常 | 默认条件 |
| --- | --- |
| 提示词突然增长 | 相邻可比请求至少增加 20k，且达到前一次的 1.5 倍 |
| 缓存命中率骤降 | 两次提示均至少 20k，命中率从至少 50% 降至不高于 10%，且未缓存提示增加至少 10k |
| 连续重复请求 | 连续 3 次完整 provider payload 的哈希完全相同 |
| 网络重试风暴 | 观察到至少 2 个 HTTP 429/5xx；实际网络重试可能更多 |
| 连续模型失败 | 连续 3 个 assistant 以 `error` 结束 |
| 工具结果异常偏大 | 单个工具返回约 8k Token 以上的模型可见文本 |
| 工具内模型异常 | 单个工具上报 100k Token 以上的嵌套模型用量 |
| 输出异常 | `stopReason=length`，或单次输出达到 16k Token |
| 推理异常 | 非 high/xhigh/max 下单次达到 16k，或连续两次达到 8k 且占输出 80% 以上 |
| 上下文接近上限 | Pi 估算当前上下文达到模型窗口的 85% |
| 请求数量异常 | 单次任务至少 12 次 assistant 请求，且累计提示达到 500k Token |
| 压缩异常 | 单次任务重复压缩，或压缩失败 |

模型、thinking、压缩和树导航变化后会重置相对比较基线，避免把合理变化误报为异常。

### 数据准确性

**供应商上报值：** assistant、压缩和树摘要事件中的 Token 数。`output` 已包含 reasoning，报告只把 reasoning 当作其中的细分，不重复相加。

**本地估算值：** 工具结果文本按 UTF-8 字节数除以 4 估算，仅用于定位大结果；图片 Token 不估算。

**费用估算：** Pi 根据本地模型目录价格计算，不等同于订阅、代理加价或供应商最终账单。

### 已知边界

- 不同供应商对错误和中断请求可能返回零或不返回 usage，此时统计只是下界
- 网络层内部重试不保证触发每次 `after_provider_response`，因此 HTTP 重试数也是下界
- 内置工具可能在事件触发前已经截断原始输出，插件只统计最终写入会话的部分；其他 context 扩展仍可能在请求前改写它
- 其他扩展直接调用 `modelRegistry.complete()` 的请求可能不经过 Agent 事件，例如标题摘要请求
- `before_provider_request` 之后加载的扩展仍可修改 payload，因此重复检测只代表本插件当时看到的内容
- 压缩失败可能已经消耗 Token，但没有 usage 时只能标记为“未知”，不会伪造零消耗
- v0.1 不持久化历史、不远程上报、不自动压缩、不切换模型，也不阻断请求

## English

Track Pi request usage without additional model calls, with an emphasis on behavior that may cause abnormal token consumption.

### Features

- Reads provider-reported input, output, cache read/write, reasoning, and estimated cost from assistant messages
- Tracks compaction, tree-summary, and tool-reported nested model usage separately to avoid double counting
- Detects prompt growth, cache collapse, duplicate requests, retry storms, large tool results, truncated output, reasoning spikes, and repeated compaction
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
Token 请求 3 · 提示 42.1k · 缓存 71%
Token 正常 · 会话 183k
Token ⚠ 2 项 · 640k
```

### Anomaly rules

The defaults are intentionally conservative, and each anomaly type alerts at most once per operation:

| Anomaly | Default condition |
| --- | --- |
| Prompt jump | At least 20k more than the previous comparable request and at least 1.5× its size |
| Cache collapse | Both prompts are at least 20k; cache read falls from at least 50% to at most 10%, with at least 10k more uncached prompt tokens |
| Duplicate requests | Three consecutive complete provider payloads have the same hash |
| HTTP retry storm | At least two visible HTTP 429/5xx responses; physical retries may be undercounted |
| Model failure streak | Three consecutive assistant messages end with `error` |
| Large tool result | One tool returns at least about 8k tokens of model-visible text |
| Large nested usage | One tool reports at least 100k tokens from a nested model |
| Output anomaly | `stopReason=length`, or one response reaches 16k output tokens |
| Reasoning anomaly | Outside high/xhigh/max, one response reaches 16k reasoning tokens, or two consecutive responses reach 8k and 80% of output |
| Context near limit | Pi estimates at least 85% of the model context window is occupied |
| Request storm | At least 12 assistant requests and 500k cumulative prompt tokens in one operation |
| Compaction anomaly | Repeated compaction in one operation, or a failed compaction |

Model, thinking-level, compaction, and tree-navigation changes reset the comparison baseline to reduce false positives.

### Accuracy

**Provider-reported:** token counts from assistant, compaction, and tree-summary events. Output already includes reasoning; reasoning is displayed only as a breakdown and is not added twice.

**Locally estimated:** tool-result text is estimated from UTF-8 byte length divided by four and is used only to locate large results. Image tokens are not estimated.

**Estimated cost:** calculated by Pi from local model catalog pricing and may differ from subscriptions, gateway markups, or final provider billing.

### Known limits

- Providers may report zero or omit usage for failed and aborted requests, making totals a lower bound
- Transport-level retries do not always emit every `after_provider_response`, so visible HTTP retries are also a lower bound
- Built-in tools may truncate raw output before the event; the extension measures the final session message, which a later context extension may still rewrite before a request
- Direct `modelRegistry.complete()` calls made by other extensions may bypass Agent events, including title-summary requests
- Extensions loaded after this one may still modify the payload, so duplicate detection describes only what this extension observed
- Failed compaction may consume tokens without reporting usage; the extension marks this as unknown instead of inventing zero usage
- v0.1 does not persist history, upload telemetry, compact automatically, switch models, or block requests

## Development

```bash
npm run check
npm pack --dry-run
```

## License

[MIT](LICENSE)
