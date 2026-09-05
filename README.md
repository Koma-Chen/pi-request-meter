# Pi Request Meter

[中文](#中文) | [English](#english)

## 中文

零额外模型调用地统计 Pi 请求用量，在每次任务完成后显示输入、输出、缓存及非缓存用量小结；过程中不自动告警。

### 特点

- 读取 assistant 消息中由供应商上报的 input、output、cache read/write、reasoning 和费用估算
- 区分有效、全零和缺失 usage，并显示统计覆盖率；reasoning 未上报时不会伪装成 0
- 单独统计上下文压缩、树摘要及工具内模型上报的额外用量，支持官方 subagent 的 single、parallel、chain 结果，避免重复相加
- 检测提示词突增、缓存命中崩塌、重复请求、重试风暴、大工具结果、输出截断、推理异常和重复压缩
- 流式输出期间估算文本、推理和工具调用参数；异常只在内部记录，最终以供应商 usage 校准，过程中不弹窗
- 在 user bash 输出真正进入下一次上下文时延迟统计，并与工具结果分开显示
- 一次任务结束后显示本轮用量小结；状态栏只显示计量进度和覆盖范围，详细信息通过 `/request-meter` 按需查看
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
/request-meter json
/request-meter alerts off
/request-meter alerts on
/request-meter reset
```

- `/request-meter`：显示最近一次任务的精确用量、工具结果估算、异常和可观测边界
- `/request-meter json`：输出 `schemaVersion: 1` 的数字快照，用于核对任务与观察窗口的主模型、辅助模型、子模型、覆盖率及异常；不缩写 Token 数，不包含请求或工具原文，费用估算使用独立字段标识
- `alerts off/on`：仅关闭或开启轮末小结中的检测记录附注；用量小结始终显示，过程中均不自动通知，设置只在当前进程生效
- `reset`：开始新的观察窗口，不修改 Pi 会话内容，也不重建此前的用量账本

本文及 JSON 中的 `session` 均指**本次观察窗口**，不是会话文件自创建以来的历史总量。启动、重载、创建或恢复会话、分叉以及手动 `reset` 会开启新窗口；普通继续对话沿用现有窗口。`session.observationWindow` 给出 `startedAtMs`、宿主触发原因 `reason`、固定为 `false` 的 `historyRebuilt` 和 `scope: "since-observation-start"`。文本报告同步显示起点、原因和未重建历史的边界；加载或恢复已有会话时不会把旧模型用量补进当前窗口。

### 每轮用量小结

一轮指从你发出指令到 Pi 完成最终回答，中间工具调用、自动重试和续跑一并累计；到 `agent_settled` 只显示一次。以下数字为示例：

```text
本轮用量（已上报）
输入总量：53,000
  缓存读取：40,000｜读取命中率 75.5%
  缓存写入：5,000｜写入占比 9.4%
  普通输入：8,000｜普通输入占比 15.1%
输出：3,000
非缓存用量：11,000（普通输入 8,000 + 输出 3,000）
总用量：56,000
主模型响应 5 次 · 耗时 42.0 秒
```

三个输入比例均以输入总量为分母，输出不参与；没有输入时显示“不适用”。“读取命中率”仅对应缓存读取，写入是创建缓存，因此单独标为“写入占比”。非缓存用量为普通输入加输出；普通输入、输出和缓存读写单价不同，该数字不是账单金额。推理分项只有上报时才附在输出后，已经包含在输出里，不重复累加。

有已结算的子代理或压缩/摘要时，会补充已计入总量的分项。供应商未上报或还有后台调用待结算时，明确显示“统计下界”；后续结算继续更新 `/request-meter`，不会再插入第二条轮末小结。完全没有有效用量时显示未知，不把它写成 0 Token。主模型响应数按 assistant 计数，不代表底层全部 HTTP 重试。

小结只显示在本地 UI，不写入 session messages、system prompt 或模型请求，也不新增模型调用。交互终端中使用输入框上方的独立区域，其他扩展的状态通知不会覆盖它；开始下一轮、重置统计或切换会话时清除。该区域只保留最近一轮，不属于可回滚查看的聊天正文，恢复会话后不会自动重建；终端高度不足时可能显示不全，可用 `/request-meter` 查看。RPC 模式仍发送对应 UI 通知，由客户端决定呈现；print/json 模式不额外写入文本，避免破坏输出协议。

状态栏示例：

```text
Token · 本次已上报 640k · 请求 8 · 最近 82k · 缓存 6% · 当前输出估算~2.1k
Token · 上次已上报 61k
Token · 上次已上报 820k · 上次下界 · 窗口下界
```

### 异常规则

规则采用较保守的固定阈值，同一任务的同类异常只保留一条记录；过程中不自动通知：

| 异常 | 默认条件 |
| --- | --- |
| 单次提示绝对过大 | 达到 80k Token，或占模型上下文窗口 40%；占 70% 时记为高风险 |
| 提示词突然增长 | 相邻可比请求至少增加 20k，且达到前一次的 1.5 倍 |
| 缓存命中率骤降 | 同一任务内间隔不超过 5 分钟的两次可比请求，提示均至少 20k，命中率从至少 50% 降至不高于 10%，且未缓存提示增加至少 10k |
| 连续重复请求 | 连续 3 次完整或降级采样的 provider payload 指纹相同 |
| 网络重试风暴 | 连续观察到至少 2 个 HTTP 429/5xx；成功响应会清零连续计数 |
| 连续模型失败 | 连续 3 个 assistant 以 `error` 结束 |
| usage 不完整 | assistant usage 缺失或全零；请求仍计数，但不参与相对比较。已识别的子代理缺少有效用量时也标记未知消耗 |
| 大上下文贡献项 | 8k 仅记为主要贡献；达到 20k 或模型窗口 10% 才记录异常 |
| 工具内模型异常 | 单次任务中工具内模型累计达到 100k Token |
| 输出异常 | `stopReason=length`，或单次输出达到 16k Token；流式估算达到 16k 时先记录估算异常，最终上报后校准 |
| 推理异常 | 非 high/xhigh/max 下单次达到 16k，或连续两次达到 8k 且占输出 80% 以上 |
| 上下文接近上限 | Pi 估算当前上下文达到模型窗口的 85% |
| 请求轮次偏多 | 单次任务达到 30 次 assistant 请求时记录以供轮末检查任务进展；12 次仅展示计数，不判定异常 |
| 累计提示异常 | 单次任务累计提示达到 500k Token，独立触发 |
| 全口径累计异常 | 单次任务的主模型、压缩和工具内模型上报总计达到 750k；空闲压缩/树摘要单次达到 750k 也独立记录 |
| 压缩异常 | 单次任务重复压缩，或压缩失败 |

相对比较优先使用 assistant 实际返回的 provider、response model 和 provider thinking。失败、取消、全零 usage，以及模型、thinking、压缩和树导航变化都不会污染下一次比较基线。

缓存比较另外限制在同一任务的 5 分钟窗口内，新任务首次请求或超时后重建缓存基线；提示词增长仍保留独立比较逻辑。轮次偏多是进展提醒，不能单凭次数认定异常循环。

### 数据准确性

**供应商上报值：** assistant、压缩和树摘要事件中的 Token 数。`output` 已包含 reasoning，报告只把 reasoning 当作其中的细分，不重复相加。报告会显示有效、全零、缺失 usage 数量；reasoning 字段缺失时显示“未上报”。

**工具内模型：** 除下述原生子代理适配外，优先使用工具结果顶层有效的标准 `usage`；没有有效顶层用量时，读取官方 `subagent` 的 `details.results[].usage`。按输入、输出、缓存读写累计，`contextTokens` 仅代表最后一次请求，不作为累计总量；两种来源不会重复相加。子代理结果缺失用量时，已知部分照常累计，未知部分明确标记。

单次工具结果最多读取 1,000 个子代理结果，超出部分记为未知，避免异常结果集合阻塞监测。

**原生子代理包：** 支持 `@tintinweb/pi-subagents` 的 `Agent`、前台 resume、后台执行及结果查询；此前真实模型验证使用的是基于 0.19.0 的本地增强版本。公开 registry 可用时，通过顶层子代理的生命周期事件与累计用量差分计账，无需开启 `reportUsage`；开启后也不会把工具用量池与累计用量再次相加。重复事件、重复查询不重复计量，同一 ID 续跑只统计新增部分。未启用原生观察器时，使用工具自身上报的 `usage`；已识别的原生工具若也缺少有效上报，则标记下界。

**增强能力边界：** 下述引用解析、递归压缩覆盖和工具池快照／代际接口来自本地增强版本，官方 npm `@tintinweb/pi-subagents@0.19.0` 尚未提供这些接口。官方版本使用可用的基础观察能力，缺少增强接口时按下述规则记录覆盖缺口，不代表拥有同等统计完整度。

支持 `registry.resolveReference()` 的版本会先把 handle／别名解析为规范 ID；查询结果的 `details.agentId` 也可补齐 ID。未解析引用只计入 `session.nativeObserver.unresolvedQueries` 等诊断，不当作模型消耗缺失。首次查询已完成代理只建立当前累计基线，不补历史运行账；首次观察仍在运行的代理时，只结算基线之后的增量，并保留原有任务归属，无法确认发起任务的增量只归观察窗口。

查询首次接管运行时，会只读订阅后续 assistant 的响应类型与 usage，不保存正文。查询恰好发生在最后一次响应已计入累计、状态尚未转为完成的收尾阶段时，后续没有新响应且成功完成的零增量不会误标未知；新的缺失或全零 usage、失败及中止仍保留缺口。无法订阅的旧接口计入 `queryResponseCoverageGaps`，仅表示后续响应覆盖证据不足，不虚增未知模型调用。终态、重置、关闭、记录淘汰或切回真实启动时释放监听；`activeQueryResponseSubscriptions` 可核对当前监听数。

原生子代理在终态结算精确用量，运行期间显示待决下界；后台消耗归属发起任务，跨任务完成仍会更新观察窗口累计。支持 `registry.compactionCoverageVersion: 1` 的版本分别提供自身 `compactionCount` 和后代 `descendantCompactionCount`；两者按单调累计差分去重，没有精确压缩 usage 时标为未知，不换算或增加 Token。独立的 `subagents:coverage_updated` 事件继续补齐父任务完成后迟到的后代压缩，只更新已有观察记录的覆盖计数，不创建新运行或改写终态。JSON 的 `descendantCompactionsWithoutUsage` 记录已识别的后代压缩次数，`descendantCoverageGaps` 记录观察运行中缺少递归压缩能力的情况。旧插件缺少版本或有效后代计数时，不能当作“后代压缩为零且已覆盖”，相关运行会保留下界。workflow 的模型调用不在上述公开观察范围内，不能承诺精确统计。

启用原生工具用量上报时，观察窗口只读保存 `registry.getUsagePoolSnapshot()` 返回的待排余额与 drain 代际，结合工具结果的 `details.usagePoolGeneration` 剔除窗口开始前的用量。重复重置会替换基线，已清空的池或不同 registry 实例不会把旧余额抵扣到新调用。`excludedPreWindowPoolUsage` 记录剔除量；缺少快照或代际时归入 `unscopedPoolUsage` 并标记 `poolWindowCoverageGaps`，不伪造未知模型调用。工具池始终只用于核对覆盖，不重复加入观察器已经结算的 Token；可归属本窗口的差额未获覆盖时，仅提示统计下界。

**统计完整度：** 任务与观察窗口分别记录缺失、全零和未知消耗。后续任务正常不会消除观察窗口累计的“下界”标记；未完成的树摘要持续标记待决，并按发起时的任务或空闲阶段归属结算。`lowerBound=false` 只表示当前可见事件中未发现用量缺口，不保证覆盖供应商的全部账单消耗。

**本地 Pi 核心补丁：** 配合基于 `0.85.0` 的本地补丁，树导航事件带有 `navigationId`，并通过 `session_tree_end` 统一报告成功、取消或错误。插件按 ID 关联并发导航，仅在终态结算一次；跨任务完成仍归属发起方。最多跟踪 64 个并行导航，容量不足时明确标记下界。`/request-meter json` 的 `session.treeObserver` 提供开始、结算、待决和容量跳过计数。

核心会持续跟踪全部活动树导航，只有全部结束后才判为空闲；取消和退出流程会向所有活动导航发出取消信号，避免其中一个摘要结束后提前放行下一任务。

同一补丁还保留 `openai-responses` 的 `response.failed` 终态已上报用量，继续沿用原错误传播；失败或中止的计费用量不会被当作保留上下文触发阈值压缩。补丁不修改提示词、模型参数、工具定义或成功响应内容。只安装此插件不会修改 Pi 核心；未打补丁的 Pi 继续使用旧事件兜底。

**本地估算值：** 工具结果、user bash 和流式输出按 UTF-8 字节数除以 4 估算，用于定位趋势、大贡献项和流式异常记录；图片 Token 不估算。流式输出包含文本、可见推理及工具调用参数，始终与已上报累计分开，不能提前反映供应商未公开的推理用量。

**费用估算：** Pi 根据本地模型目录价格计算，不等同于订阅、代理加价或供应商最终账单。

### 已知边界

- 不同供应商对错误和中断请求可能返回零或不返回 usage，此时统计只是下界
- 网络层内部重试不保证触发每次 `after_provider_response`，因此 HTTP 重试数也是下界
- 压缩内部失败重试不暴露逐次 usage；成功只记录最终上报值，失败记为未知消耗
- 压缩取消或中止可能已经产生消耗，会计入“取消不确定”并让状态栏标记“下界”
- 未打核心补丁的 Pi：树摘要失败或中止没有完成事件；插件会在请求摘要前登记待决状态，跨任务持续按“下界”显示，下次树导航开始时仍未完成则记为未知消耗。事件没有唯一请求 ID，重叠摘要无法保证逐次关联
- 已打核心补丁的 Pi：终态事件解决并发关联与待决清理，但树摘要内部仍可能丢弃错误、中止、输出截断或意外工具调用的 usage。已发现但无法恢复的消耗继续标记下界；内部摘要重试等未公开事件的调用可能不可见，成功时只计入最终响应，不能保证发现前序消耗。`openai-codex-responses` 有独立错误处理路径，不在本次 failed usage 补丁范围内
- 内置工具可能在事件触发前已经截断原始输出，插件只统计最终写入会话的部分；其他 context 扩展仍可能在请求前改写它
- user bash 没有执行后事件，只能在输出进入下一次模型 context 时延迟发现
- user bash 每次 context 最多扫描 1,000 条消息、计算 100 条固定大小指纹，并用旋转游标逐批处理积压；固定 8KB Bloom filter 让内存有界且树导航不重算，极端长会话存在极低概率漏计
- 技能展开、附件和超长粘贴会反映在下一次总提示量中，但无法跨供应商精确拆分来源
- 其他扩展直接调用 `modelRegistry.complete()` 的请求可能不经过 Agent 事件，例如标题摘要请求
- 原生子代理观察器最多保留 256 个 agent 和 128 个待关联工具调用；真实运行缺少计量接口、容量不足或累计用量回退时，不能保证完整计量。单纯查询的未解析引用不等于发生了模型调用，也不会补记未知历史账。原生 workflow 通过工具发起时会标记未知，但其他扩展或 CLI 发起且没有可见事件的调用仍可能无法发现
- 超大字符串和 typed array 使用长度及头、中、尾采样生成降级指纹；结构超过节点/深度/总工作预算时不参与重复比较，并重置连续比较基线；报告显示检测覆盖不足、跳过原因及次数，不用弱摘要冒充可靠重复检测
- 后续扩展仍可修改 payload，因此重复检测只代表本插件当时看到的内容
- 压缩失败可能已经消耗 Token，但没有 usage 时只能标记为“未知”，不会伪造零消耗
- v0.1 不持久化历史、不远程上报、不自动压缩、不切换模型，也不阻断请求

## English

Track Pi request usage without additional model calls, with an emphasis on behavior that may cause abnormal token consumption.

### Features

- Reads provider-reported input, output, cache read/write, reasoning, and estimated cost from assistant messages
- Distinguishes valid, all-zero, and missing usage and reports coverage; unavailable reasoning is not presented as zero
- Tracks compaction, tree-summary, and tool-reported nested model usage separately, including official subagent single, parallel, and chain results, without double counting
- Detects prompt growth, cache collapse, duplicate requests, retry storms, large tool results, truncated output, reasoning spikes, and repeated compaction
- Estimates streamed text, thinking, and tool-call arguments, records provisional anomalies, and reconciles them with final provider usage without notifications during execution
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
/request-meter json
/request-meter alerts off
/request-meter alerts on
/request-meter reset
```

- `/request-meter` shows the latest operation's reported usage, tool-result estimates, anomalies, and observability limits
- `/request-meter json` exports an exact numeric snapshot with `schemaVersion: 1` for operation/observation-window model usage, coverage, and anomalies; token counts are not abbreviated, request text and tool-result text are excluded, and cost estimates are labeled separately
- `alerts off/on` controls anomaly notes in the completed-operation summary; usage summaries remain enabled, no notifications are sent during execution, and the setting lasts for the current process
- `reset` starts a new observation window without changing the Pi session or reconstructing earlier usage

Status examples:

```text
Token · 本次已上报 640k · 请求 8 · 最近 82k · 缓存 6% · 当前输出估算~2.1k
Token · 上次已上报 61k
Token · 上次已上报 820k · 上次下界 · 窗口下界
```

### Anomaly rules

The defaults are intentionally conservative; each anomaly type is recorded once per operation without automatic notifications during execution:

| Anomaly | Default condition |
| --- | --- |
| Absolute prompt size | Reaches 80k tokens or 40% of the model context window; 70% is reported as high risk |
| Prompt jump | At least 20k more than the previous comparable request and at least 1.5× its size |
| Cache collapse | Comparable requests in the same operation are at most five minutes apart; both prompts are at least 20k, cache read falls from at least 50% to at most 10%, and uncached prompt tokens increase by at least 10k |
| Duplicate requests | Three consecutive complete or sampled provider-payload fingerprints match |
| HTTP retry storm | At least two consecutive visible HTTP 429/5xx responses; a success resets the streak |
| Model failure streak | Three consecutive assistant messages end with `error` |
| Incomplete usage | Assistant usage is missing or all zero; the request is counted but excluded from relative baselines. Missing valid usage from a recognized subagent is also marked unknown |
| Large context contributor | 8k is recorded as a major contributor; it is recorded as an anomaly at 20k or 10% of the model window |
| Large nested usage | Tool-reported nested models reach 100k cumulative tokens in one operation |
| Output anomaly | `stopReason=length`, or one response reaches 16k output tokens; a streaming estimate of 16k creates a provisional record that is reconciled with final usage |
| Reasoning anomaly | Outside high/xhigh/max, one response reaches 16k reasoning tokens, or two consecutive responses reach 8k and 80% of output |
| Context near limit | Pi estimates at least 85% of the model context window is occupied |
| High request count | At 30 assistant requests, suggests checking task progress; 12 requests only updates the count and is not an anomaly |
| Cumulative prompt | Reaches 500k cumulative prompt tokens in one operation, independently |
| Cumulative reported total | Main model, compaction, and nested model usage reaches 750k in one operation; an idle compaction/tree summary is also recorded independently at 750k |
| Compaction anomaly | Repeated compaction in one operation, or a failed compaction |

Relative comparisons prefer the provider, response model, and provider thinking level reported by each assistant message. Failed, aborted, and all-zero usage samples do not become baselines; model, thinking, compaction, and tree-navigation changes also reset the baseline.

Cache comparisons also require the same operation and a five-minute interval. The first request of a new operation or a longer gap establishes a fresh cache baseline; prompt growth retains its independent comparison. Request count alone does not establish an abnormal loop.

### Accuracy

**Provider-reported:** token counts from assistant, compaction, and tree-summary events. Output already includes reasoning; reasoning is displayed only as a breakdown and is not added twice. Reports show valid, all-zero, and missing usage counts, and display unavailable reasoning as “not reported.”

**Nested models:** outside the native integration described above, valid standard top-level tool `usage` takes precedence; otherwise, official subagent `details.results[].usage` is read. Input, output, and cache reads/writes are accumulated; `contextTokens` describes only the last request and is not a cumulative total. The two sources are never added twice. Known usage is retained when another subagent result has unknown usage.

At most 1,000 subagent results are inspected per tool result; additional results are marked unknown to keep monitoring work bounded.

**Coverage:** operation and observation-window counters separately track missing, all-zero, and unknown usage. A later complete operation does not remove the observation-window total's lower-bound marker. Unfinished tree summaries remain pending and are attributed to their initiating operation or idle phase.

**Locally estimated:** tool results, user bash, and streaming output use UTF-8 byte length divided by four for trends, large-contributor detection, and provisional streaming anomaly records. Image tokens are not estimated. Streaming output includes text, visible thinking, and tool-call arguments, remains separate from reported totals, and cannot reveal reasoning usage the provider has not exposed.

**Estimated cost:** calculated by Pi from local model catalog pricing and may differ from subscriptions, gateway markups, or final provider billing.

### Known limits

- Providers may report zero or omit usage for failed and aborted requests, making totals a lower bound
- Transport-level retries do not always emit every `after_provider_response`, so visible HTTP retries are also a lower bound
- Internal compaction retries do not expose usage per failed attempt; success records only the final reported usage, while failure is marked unknown
- Cancelled or aborted compaction may already have consumed tokens; it does not raise a failure pop-up, but is counted as uncertain and marks the status as a lower bound
- On unpatched Pi, failed or aborted tree summaries have no completion event; they remain pending and mark a lower bound across operations, becoming unknown if still unresolved when the next tree navigation starts. Events have no unique request ID, so overlapping summaries cannot always be matched individually
- Built-in tools may truncate raw output before the event; the extension measures the final session message, which a later context extension may still rewrite before a request
- User bash has no post-execution event and is discovered only when its output enters the next model context
- Each context scans at most 1,000 messages and fingerprints at most 100 user-bash entries with a rotating cursor; a fixed 8KB Bloom filter bounds memory and prevents tree-navigation recounts, with a small false-positive risk in extremely long sessions
- Expanded skills, attachments, and large pasted input affect the next total prompt size but cannot be attributed precisely across providers
- Direct `modelRegistry.complete()` calls made by other extensions may bypass Agent events, including title-summary requests
- Huge strings and typed arrays use length plus head/middle/tail samples; structures exceeding node, depth, or total-work limits are excluded and reset the duplicate streak. Reports show incomplete detection coverage with skip reasons and counts; weak summaries are not treated as reliable duplicate matches
- Later extensions may still modify the payload, so duplicate detection describes only what this extension observed
- Failed compaction may consume tokens without reporting usage; the extension marks this as unknown instead of inventing zero usage
- The extension does not persist usage history, upload telemetry, compact automatically, switch models, or block requests

## Development

```bash
npm run check
npm pack --dry-run
```

## License

[MIT](LICENSE)
