import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "request-meter";
const MAX_SAMPLES = 100;
const MAX_ANOMALIES = 20;
const MAX_FINGERPRINT_CHARS = 256_000;
const MAX_FINGERPRINT_NODES = 20_000;
const MAX_FINGERPRINT_DEPTH = 32;
const LARGE_TOOL_TOKENS = 8_000;
const PROMPT_JUMP_TOKENS = 20_000;
const OUTPUT_RUNAWAY_TOKENS = 8_000;
const REASONING_RUNAWAY_TOKENS = 8_000;
const REQUEST_STORM_COUNT = 12;
const REQUEST_STORM_PROMPT_TOKENS = 500_000;
const MAX_DETAIL_CHARS = 1_000;
const ALERTS_STATE_KEY = Symbol.for("pi-request-meter.alerts-state");

type Severity = "warning" | "error";

interface MeterUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	reasoning: number;
	totalTokens: number;
	cost: number;
	reports: number;
}

interface UsageSample extends MeterUsage {
	timestamp: number;
	promptTokens: number;
	stopReason?: string;
	modelKey: string;
	thinkingLevel: string;
	boundary: number;
	contextPercent?: number;
}

interface Anomaly {
	code: string;
	title: string;
	detail: string;
	severity: Severity;
	timestamp: number;
}

interface ToolPeak {
	name: string;
	estimatedTokens: number;
	images: number;
}

interface OperationState {
	startedAt: number;
	endedAt?: number;
	assistantRequests: number;
	providerRequests: number;
	providerResponses: number;
	observedHttpFailures: number;
	consecutiveAssistantErrors: number;
	highReasoningStreak: number;
	lastPayloadFingerprint?: string;
	repeatedPayloads: number;
	compactions: number;
	mainUsage: MeterUsage;
	auxiliaryUsage: MeterUsage;
	nestedUsage: MeterUsage;
	estimatedToolTokens: number;
	largestTool?: ToolPeak;
	samples: UsageSample[];
	anomalies: Anomaly[];
	seenAnomalies: Set<string>;
}

interface SharedState {
	alertsEnabled: boolean;
}

/** 判断未知值是否可按普通键值对象安全读取。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 仅接受 JSON 风格普通对象，避免 Map、Set、Date 等实例被误判为空 payload。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** 在同一 Pi 进程的扩展重载和会话切换之间共享提醒开关，不写入磁盘。 */
function getSharedState(): SharedState {
	const target = globalThis as typeof globalThis & { [ALERTS_STATE_KEY]?: SharedState };
	target[ALERTS_STATE_KEY] ??= { alertsEnabled: true };
	return target[ALERTS_STATE_KEY];
}

/** 将供应商可能缺失或异常的数值收敛为非负有限数。 */
function nonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 截断仅用于诊断展示的动态文本，防止超长错误或工具名长期占用内存。 */
function truncateDetail(value: string, maxChars = MAX_DETAIL_CHARS): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

/** 创建可累加的空用量，避免缺失字段在聚合时传播 NaN。 */
function emptyUsage(): MeterUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheWrite1h: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: 0,
		reports: 0,
	};
}

/** 读取 Pi 规范化后的 usage；Token 视为供应商上报值，cost 仅作为模型目录估算。 */
function normalizeUsage(value: unknown): MeterUsage | undefined {
	if (!isRecord(value)) return undefined;
	const hasUsageField = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"].some(
		(key) => typeof value[key] === "number",
	);
	if (!hasUsageField) return undefined;

	const input = nonNegativeNumber(value.input);
	const output = nonNegativeNumber(value.output);
	const cacheRead = nonNegativeNumber(value.cacheRead);
	const cacheWrite = nonNegativeNumber(value.cacheWrite);
	const calculatedTotal = input + output + cacheRead + cacheWrite;
	const reportedTotal = nonNegativeNumber(value.totalTokens);
	const cost = isRecord(value.cost) ? nonNegativeNumber(value.cost.total) : 0;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cacheWrite1h: nonNegativeNumber(value.cacheWrite1h),
		reasoning: nonNegativeNumber(value.reasoning),
		totalTokens: reportedTotal || calculatedTotal,
		cost,
		reports: 1,
	};
}

/** 将一次用量原地累加到有界会话或任务聚合中。 */
function addUsage(target: MeterUsage, usage: MeterUsage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.cacheWrite1h += usage.cacheWrite1h;
	target.reasoning += usage.reasoning;
	target.totalTokens += usage.totalTokens;
	target.cost += usage.cost;
	target.reports += usage.reports;
}

/** 计算一次请求的全部提示 Token，缓存读写与普通输入互斥计入。 */
function promptTokens(usage: MeterUsage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** 计算缓存读取占提示词的比例；没有提示词时返回零。 */
function cacheReadRate(usage: MeterUsage): number {
	const prompt = promptTokens(usage);
	return prompt > 0 ? usage.cacheRead / prompt : 0;
}

/** 将 Token 数压缩为适合状态栏和报告的可读格式。 */
function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	return Math.round(value).toString();
}

/** 将估算费用格式化为美元；极小费用保留足够精度。 */
function formatCost(value: number): string {
	if (value <= 0) return "$0";
	return `$${value.toFixed(value < 0.01 ? 4 : 3)}`;
}

/** 从模型可见的工具结果块估算文本 Token，并单独记录无法估算的图片数量。 */
function estimateToolContent(content: unknown): { tokens: number; images: number } {
	let bytes = 0;
	let images = 0;
	const blocks = Array.isArray(content) ? content : [content];
	for (const block of blocks) {
		if (typeof block === "string") {
			bytes += Buffer.byteLength(block, "utf8");
			continue;
		}
		if (!isRecord(block)) continue;
		if (typeof block.text === "string") bytes += Buffer.byteLength(block.text, "utf8");
		if (block.type === "image") images++;
	}
	return { tokens: Math.ceil(bytes / 4), images };
}

/**
 * 对最终 provider payload 做有上限的一次性摘要，只保留哈希以识别连续重复请求。
 * 超过字符、节点或深度上限时放弃本次比较，避免监控本身复制超大上下文。
 */
function fingerprintPayload(payload: unknown): string | undefined {
	const hash = createHash("sha256");
	const seen = new WeakSet<object>();
	let chars = 0;
	let nodes = 0;
	let complete = true;

	/** 按稳定键顺序流式写入哈希，不构造 payload 的 JSON 副本。 */
	function visit(value: unknown, depth: number): void {
		if (!complete) return;
		nodes++;
		if (nodes > MAX_FINGERPRINT_NODES || depth > MAX_FINGERPRINT_DEPTH) {
			complete = false;
			return;
		}
		if (value === null) {
			hash.update("null;");
			return;
		}
		if (typeof value === "string") {
			chars += value.length;
			if (chars > MAX_FINGERPRINT_CHARS) {
				complete = false;
				return;
			}
			hash.update(`s${value.length}:`);
			hash.update(value);
			return;
		}
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
			hash.update(`${typeof value}:${String(value)};`);
			return;
		}
		if (typeof value === "undefined") {
			hash.update("undefined;");
			return;
		}
		if (typeof value !== "object") {
			hash.update(`${typeof value};`);
			return;
		}
		if (seen.has(value)) {
			hash.update("circular;");
			return;
		}
		seen.add(value);
		if (Array.isArray(value)) {
			hash.update(`array:${value.length}[`);
			for (const item of value) visit(item, depth + 1);
			hash.update("]");
			return;
		}
		if (!isPlainRecord(value)) {
			complete = false;
			return;
		}
		const record = value;
		let keyCount = 0;
		for (const key in record) {
			if (!Object.hasOwn(record, key)) continue;
			keyCount++;
			if (nodes + keyCount > MAX_FINGERPRINT_NODES) {
				complete = false;
				return;
			}
		}
		const keys = Object.keys(record);
		keys.sort();
		hash.update(`object:${keys.length}{`);
		for (const key of keys) {
			chars += key.length;
			if (chars > MAX_FINGERPRINT_CHARS) {
				complete = false;
				return;
			}
			hash.update(`k${key.length}:${key}`);
			visit(record[key], depth + 1);
		}
		hash.update("}");
	}

	try {
		visit(payload, 0);
		return complete ? hash.digest("hex") : undefined;
	} catch {
		return undefined;
	}
}

/** 创建一次从首次 agent_start 到 agent_settled 的完整任务窗口。 */
function createOperation(): OperationState {
	return {
		startedAt: Date.now(),
		assistantRequests: 0,
		providerRequests: 0,
		providerResponses: 0,
		observedHttpFailures: 0,
		consecutiveAssistantErrors: 0,
		highReasoningStreak: 0,
		repeatedPayloads: 0,
		compactions: 0,
		mainUsage: emptyUsage(),
		auxiliaryUsage: emptyUsage(),
		nestedUsage: emptyUsage(),
		estimatedToolTokens: 0,
		samples: [],
		anomalies: [],
		seenAnomalies: new Set(),
	};
}

/** 读取模型和 thinking 组合，防止跨配置比较制造上下文或推理误报。 */
function comparisonKey(ctx: ExtensionContext): { modelKey: string; thinkingLevel: string } {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	return {
		modelKey: model ? `${model.provider ?? "unknown"}/${model.id ?? "unknown"}` : "unknown",
		thinkingLevel: String(ctx.thinkingLevel ?? "unknown"),
	};
}

/** 生成一行精确用量摘要；提示词拆分可直接定位缓存异常。 */
function usageReport(label: string, usage: MeterUsage): string {
	if (usage.reports === 0) return `${label}：无供应商用量数据`;
	return `${label}：提示 ${formatTokens(promptTokens(usage))}（输入 ${formatTokens(usage.input)} / 缓存读 ${formatTokens(usage.cacheRead)} / 写 ${formatTokens(usage.cacheWrite)}）· 输出 ${formatTokens(usage.output)} · 推理 ${formatTokens(usage.reasoning)} · 总计 ${formatTokens(usage.totalTokens)} · 费用约 ${formatCost(usage.cost)}`;
}

/** 注册只观察事件、状态栏和用户命令；该扩展不暴露模型工具，也不改写任何上下文。 */
export default function requestMeterExtension(pi: ExtensionAPI): void {
	let currentOperation: OperationState | undefined;
	let lastOperation: OperationState | undefined;
	let previousSample: UsageSample | undefined;
	let boundary = 0;
	const sharedState = getSharedState();
	let sessionMainUsage = emptyUsage();
	let sessionAuxiliaryUsage = emptyUsage();
	let sessionNestedUsage = emptyUsage();
	let sessionEstimatedToolTokens = 0;
	let recentAnomalies: Anomaly[] = [];

	/** 保证运行中的观察事件都归属同一任务窗口。 */
	function ensureOperation(): OperationState {
		currentOperation ??= createOperation();
		return currentOperation;
	}

	/** 清空当前会话统计，但保留本进程内用户选择的告警开关。 */
	function resetSessionState(): void {
		currentOperation = undefined;
		lastOperation = undefined;
		previousSample = undefined;
		boundary = 0;
		sessionMainUsage = emptyUsage();
		sessionAuxiliaryUsage = emptyUsage();
		sessionNestedUsage = emptyUsage();
		sessionEstimatedToolTokens = 0;
		recentAnomalies = [];
	}

	/** 在模型或上下文结构发生合理变化后重置相对比较基线。 */
	function resetComparisonBoundary(): void {
		boundary++;
		previousSample = undefined;
		if (currentOperation) currentOperation.highReasoningStreak = 0;
	}

	/** 添加去重后的异常并只通过本地 UI 告警，不写入会话消息。 */
	function addAnomaly(ctx: ExtensionContext, code: string, title: string, detail: string, severity: Severity): void {
		const operation = currentOperation;
		if (operation?.seenAnomalies.has(code)) return;
		if (operation && operation.anomalies.length >= MAX_ANOMALIES) return;
		if (!operation && recentAnomalies.some((item) => item.code === code && Date.now() - item.timestamp < 60_000)) return;

		const anomaly = { code, title, detail: truncateDetail(detail), severity, timestamp: Date.now() };
		operation?.seenAnomalies.add(code);
		operation?.anomalies.push(anomaly);
		recentAnomalies.push(anomaly);
		if (recentAnomalies.length > MAX_ANOMALIES) recentAnomalies = recentAnomalies.slice(-MAX_ANOMALIES);
		if (sharedState.alertsEnabled && ctx.hasUI) ctx.ui.notify(`Token 异常：${title}\n${anomaly.detail}`, severity);
		renderStatus(ctx);
	}

	/** 根据运行态、异常数和会话总量更新独立状态项，不覆盖其他页脚扩展。 */
	function renderStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const activeOperation = currentOperation;
		const operation = activeOperation ?? lastOperation;
		const anomalyCount = activeOperation ? activeOperation.anomalies.length : recentAnomalies.length;
		if (anomalyCount > 0) {
			const total = activeOperation
				? activeOperation.mainUsage.totalTokens + activeOperation.auxiliaryUsage.totalTokens + activeOperation.nestedUsage.totalTokens
				: sessionMainUsage.totalTokens + sessionAuxiliaryUsage.totalTokens + sessionNestedUsage.totalTokens;
			ctx.ui.setStatus(STATUS_ID, `Token ⚠ ${anomalyCount} 项 · ${formatTokens(total)}`);
			return;
		}
		if (currentOperation) {
			const latest = currentOperation.samples.at(-1);
			const cache = latest && latest.promptTokens > 0 ? ` · 缓存 ${Math.round(cacheReadRate(latest) * 100)}%` : "";
			ctx.ui.setStatus(
				STATUS_ID,
				`Token 请求 ${currentOperation.assistantRequests} · 提示 ${formatTokens(currentOperation.mainUsage.input + currentOperation.mainUsage.cacheRead + currentOperation.mainUsage.cacheWrite)}${cache}`,
			);
			return;
		}
		const total = sessionMainUsage.totalTokens + sessionAuxiliaryUsage.totalTokens + sessionNestedUsage.totalTokens;
		ctx.ui.setStatus(STATUS_ID, total > 0 ? `Token 正常 · 会话 ${formatTokens(total)}` : "Token 待命");
	}

	/** 将一次精确主模型用量转为样本，并运行只依赖数字的保守异常规则。 */
	function recordMainUsage(ctx: ExtensionContext, usage: MeterUsage, stopReason?: string): void {
		const operation = ensureOperation();
		addUsage(operation.mainUsage, usage);
		addUsage(sessionMainUsage, usage);
		const keys = comparisonKey(ctx);
		const context = ctx.getContextUsage();
		const sample: UsageSample = {
			...usage,
			timestamp: Date.now(),
			promptTokens: promptTokens(usage),
			stopReason,
			modelKey: keys.modelKey,
			thinkingLevel: keys.thinkingLevel,
			boundary,
			contextPercent: typeof context?.percent === "number" ? context.percent : undefined,
		};
		operation.samples.push(sample);
		if (operation.samples.length > MAX_SAMPLES) operation.samples = operation.samples.slice(-MAX_SAMPLES);

		const comparable =
			previousSample &&
			previousSample.boundary === sample.boundary &&
			previousSample.modelKey === sample.modelKey &&
			previousSample.thinkingLevel === sample.thinkingLevel
				? previousSample
				: undefined;
		if (
			comparable &&
			sample.promptTokens - comparable.promptTokens >= PROMPT_JUMP_TOKENS &&
			sample.promptTokens >= comparable.promptTokens * 1.5
		) {
			addAnomaly(
				ctx,
				"prompt-jump",
				"提示词突然增长",
				`${formatTokens(comparable.promptTokens)} → ${formatTokens(sample.promptTokens)}，增加 ${formatTokens(sample.promptTokens - comparable.promptTokens)}`,
				"warning",
			);
		}

		if (comparable) {
			const previousCacheRate = cacheReadRate(comparable);
			const currentCacheRate = cacheReadRate(sample);
			const previousUncached = comparable.input + comparable.cacheWrite;
			const currentUncached = sample.input + sample.cacheWrite;
			if (
				comparable.promptTokens >= 20_000 &&
				sample.promptTokens >= 20_000 &&
				previousCacheRate >= 0.5 &&
				currentCacheRate <= 0.1 &&
				currentUncached - previousUncached >= 10_000
			) {
				addAnomaly(
					ctx,
					"cache-collapse",
					"缓存命中率骤降",
					`${Math.round(previousCacheRate * 100)}% → ${Math.round(currentCacheRate * 100)}%，未缓存提示增加 ${formatTokens(currentUncached - previousUncached)}`,
					"warning",
				);
			}
		}

		if (stopReason === "length" || sample.output >= OUTPUT_RUNAWAY_TOKENS * 2) {
			addAnomaly(
				ctx,
				"output-runaway",
				stopReason === "length" ? "输出达到模型长度限制" : "单次输出异常偏大",
				`本次输出 ${formatTokens(sample.output)} Token${stopReason === "length" ? "，stopReason=length" : ""}`,
				"warning",
			);
		}

		const reasoningHeavy = sample.reasoning >= REASONING_RUNAWAY_TOKENS && sample.output > 0 && sample.reasoning / sample.output >= 0.8;
		operation.highReasoningStreak = reasoningHeavy ? operation.highReasoningStreak + 1 : 0;
		const thinkingExpected = ["high", "xhigh", "max"].includes(sample.thinkingLevel);
		if (!thinkingExpected && (sample.reasoning >= REASONING_RUNAWAY_TOKENS * 2 || operation.highReasoningStreak >= 2)) {
			addAnomaly(
				ctx,
				"reasoning-runaway",
				"推理 Token 异常偏高",
				`thinking=${sample.thinkingLevel}，本次推理 ${formatTokens(sample.reasoning)} / 输出 ${formatTokens(sample.output)}`,
				"warning",
			);
		}

		if (sample.contextPercent !== undefined && sample.contextPercent >= 85) {
			addAnomaly(
				ctx,
				"context-near-limit",
				"上下文接近容量上限",
				`当前上下文约占 ${sample.contextPercent.toFixed(1)}%`,
				"warning",
			);
		}

		previousSample = sample;
	}

	/** 统计已经定稿并真正写入会话的工具结果，避免后续扩展替换内容导致误差。 */
	function recordToolResult(
		ctx: ExtensionContext,
		message: { toolName?: string; content?: unknown; usage?: unknown },
	): void {
		const operation = ensureOperation();
		const toolName = truncateDetail(message.toolName ?? "unknown-tool", 100);
		const estimate = estimateToolContent(message.content);
		operation.estimatedToolTokens += estimate.tokens;
		sessionEstimatedToolTokens += estimate.tokens;
		if (!operation.largestTool || estimate.tokens > operation.largestTool.estimatedTokens) {
			operation.largestTool = { name: toolName, estimatedTokens: estimate.tokens, images: estimate.images };
		}
		if (estimate.tokens >= LARGE_TOOL_TOKENS) {
			addAnomaly(
				ctx,
				"large-tool-result",
				"工具结果异常偏大",
				`${toolName} 返回约 ${formatTokens(estimate.tokens)} Token${estimate.images ? `，另有 ${estimate.images} 张图片未估算` : ""}`,
				"warning",
			);
		}

		const nestedUsage = normalizeUsage(message.usage);
		if (nestedUsage) {
			addUsage(operation.nestedUsage, nestedUsage);
			addUsage(sessionNestedUsage, nestedUsage);
			if (nestedUsage.totalTokens >= 100_000) {
				addAnomaly(
					ctx,
					"large-nested-usage",
					"工具内模型消耗异常偏高",
					`${toolName} 上报 ${formatTokens(nestedUsage.totalTokens)} Token；该值与主模型分开统计`,
					"warning",
				);
			}
		}
		renderStatus(ctx);
	}

	/** 生成不会进入模型上下文的会话报告，明确区分精确值与估算值。 */
	function buildReport(): string {
		const operation = currentOperation ?? lastOperation;
		const lines = ["Pi Request Meter"];
		if (!operation) {
			lines.push("当前会话尚未观察到主模型请求。");
		} else {
			const elapsed = Math.max(0, (operation.endedAt ?? Date.now()) - operation.startedAt);
			lines.push(
				`状态：${operation.anomalies.length > 0 ? `${operation.anomalies.length} 项异常` : currentOperation ? "监测中" : "正常"}`,
				`窗口：${(elapsed / 1000).toFixed(1)} 秒 · assistant ${operation.assistantRequests} 次 · provider hook ${operation.providerRequests} 次 · 可见 HTTP 响应 ${operation.providerResponses} 次`,
				usageReport("本次主模型（供应商上报）", operation.mainUsage),
			);
			if (operation.auxiliaryUsage.reports > 0) lines.push(usageReport("本次压缩/树摘要（供应商上报）", operation.auxiliaryUsage));
			if (operation.nestedUsage.reports > 0) lines.push(usageReport("本次工具内模型（工具上报，单独计）", operation.nestedUsage));
			lines.push(`本次工具结果：约 ${formatTokens(operation.estimatedToolTokens)} Token（本地估算）`);
			if (operation.largestTool) {
				lines.push(
					`最大工具结果：${operation.largestTool.name} 约 ${formatTokens(operation.largestTool.estimatedTokens)} Token${operation.largestTool.images ? `，另有 ${operation.largestTool.images} 张图片未估算` : ""}`,
				);
			}
		}

		lines.push(usageReport("会话主模型", sessionMainUsage));
		if (sessionAuxiliaryUsage.reports > 0) lines.push(usageReport("会话压缩/树摘要", sessionAuxiliaryUsage));
		if (sessionNestedUsage.reports > 0) lines.push(usageReport("会话工具内模型（单独计）", sessionNestedUsage));
		lines.push(`会话工具结果：约 ${formatTokens(sessionEstimatedToolTokens)} Token（本地估算）`);
		if (recentAnomalies.length > 0) {
			lines.push("最近异常：", ...recentAnomalies.slice(-5).map((item) => `- ${item.title}：${item.detail}`));
		} else {
			lines.push("异常：未发现达到保守阈值的行为");
		}
		lines.push(
			"边界：网络层失败可能不可见；其他扩展直接调用模型可能不经过 Agent 事件。",
			`提醒：${sharedState.alertsEnabled ? "开启" : "关闭"}`,
		);
		return lines.join("\n");
	}

	// 新会话拥有独立统计，避免旧会话基线污染缓存和上下文增幅判断。
	pi.on("session_start", async (_event, ctx) => {
		resetSessionState();
		renderStatus(ctx);
	});

	// 多次 agent_start（重试、续跑）继续归入同一个 agent_settled 窗口。
	pi.on("agent_start", async (_event, ctx) => {
		ensureOperation();
		renderStatus(ctx);
	});

	// 只对当前处理器可见的 provider payload 做有界哈希和请求计数，绝不修改或保存原文。
	pi.on("before_provider_request", (event, ctx) => {
		if (!currentOperation) return;
		const operation = currentOperation;
		operation.providerRequests++;
		const fingerprint = fingerprintPayload(event.payload);
		if (fingerprint && fingerprint === operation.lastPayloadFingerprint) {
			operation.repeatedPayloads++;
			if (operation.repeatedPayloads >= 2) {
				addAnomaly(
					ctx,
					"duplicate-payload",
					"连续重复发送相同请求",
					`已连续观察到 ${operation.repeatedPayloads + 1} 次完全相同的 provider payload`,
					"warning",
				);
			}
		} else {
			operation.repeatedPayloads = 0;
		}
		operation.lastPayloadFingerprint = fingerprint;
		renderStatus(ctx);
	});

	// HTTP 事件只作为可见下界；不同 provider 的内部重试不保证都会触发该事件。
	pi.on("after_provider_response", (event, ctx) => {
		if (!currentOperation) return;
		currentOperation.providerResponses++;
		if (event.status === 429 || event.status >= 500) {
			currentOperation.observedHttpFailures++;
			if (currentOperation.observedHttpFailures >= 2) {
				addAnomaly(
					ctx,
					"http-retry-storm",
					"疑似网络重试风暴",
					`已观察到 ${currentOperation.observedHttpFailures} 个 429/5xx 响应；实际网络重试可能更多`,
					"warning",
				);
			}
		}
	});

	// 最终 assistant 消息携带本次供应商用量，是主模型精确记账的唯一来源。
	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: string;
			usage?: unknown;
			stopReason?: string;
		};
		if (message.role !== "assistant") return;
		const operation = ensureOperation();
		operation.assistantRequests++;
		const usage = normalizeUsage(message.usage);
		if (usage) recordMainUsage(ctx, usage, message.stopReason);

		if (message.stopReason === "error") {
			operation.consecutiveAssistantErrors++;
			if (operation.consecutiveAssistantErrors >= 3) {
				addAnomaly(
					ctx,
					"assistant-retry-storm",
					"连续模型请求失败",
					`已连续出现 ${operation.consecutiveAssistantErrors} 个 error assistant，失败请求的 Token 可能未完整上报`,
					"error",
				);
			}
		} else {
			operation.consecutiveAssistantErrors = 0;
		}
		renderStatus(ctx);
	});

	// turn_end 位于工具消息定稿和持久化之后，按最终会话版本统计本轮全部工具结果。
	pi.on("turn_end", (event, ctx) => {
		for (const message of event.toolResults) recordToolResult(ctx, message);
	});

	// 压缩前立即切断比较基线，避免压缩后的正常下降或重写触发误报。
	pi.on("session_before_compact", async () => {
		resetComparisonBoundary();
	});

	// 压缩调用不经过 provider hooks，必须从 compactionEntry.usage 单独补记。
	pi.on("session_compact", (event, ctx) => {
		const operation = currentOperation;
		if (operation) operation.compactions++;
		const compactEvent = event as { compactionEntry?: { usage?: unknown } };
		const usage = normalizeUsage(compactEvent.compactionEntry?.usage);
		if (usage) {
			if (operation) addUsage(operation.auxiliaryUsage, usage);
			addUsage(sessionAuxiliaryUsage, usage);
		}
		if (operation && operation.compactions >= 2) {
			addAnomaly(ctx, "repeated-compaction", "单次任务重复压缩", `本次任务已执行 ${operation.compactions} 次压缩`, "warning");
		}
		renderStatus(ctx);
	});

	// 压缩失败可能已经产生未上报消耗，因此明确标记为未知而不是记零。
	pi.on("session_compact_failed", (event, ctx) => {
		if (event.aborted) return;
		const outcome = event.errorMessage ? `错误=${event.errorMessage}` : "错误未知";
		addAnomaly(
			ctx,
			"compaction-failed",
			"上下文压缩失败",
			`触发=${event.reason}，${outcome}${event.willRetry ? "，Pi 将重试；失败调用的 Token 可能无法统计" : ""}`,
			"warning",
		);
	});

	// 树导航摘要同样是额外模型调用，若事件提供 usage 则单独计入辅助用量。
	pi.on("session_tree", (event, ctx) => {
		const treeEvent = event as { summaryEntry?: { usage?: unknown } };
		const usage = normalizeUsage(treeEvent.summaryEntry?.usage);
		if (usage) {
			if (currentOperation) addUsage(currentOperation.auxiliaryUsage, usage);
			addUsage(sessionAuxiliaryUsage, usage);
		}
		resetComparisonBoundary();
		renderStatus(ctx);
	});

	// 模型变化会改变 tokenizer、上下文窗口和缓存语义，不能沿用旧样本比较。
	pi.on("model_select", async () => {
		resetComparisonBoundary();
	});

	// thinking 变化会合理改变 reasoning 用量，切换后重新建立推理基线。
	pi.on("thinking_level_select", async () => {
		resetComparisonBoundary();
	});

	// 仅在重试、压缩和队列任务全部结束后判断累计请求风暴并封存窗口。
	pi.on("agent_settled", async (_event, ctx) => {
		const operation = currentOperation;
		if (!operation) return;
		if (
			operation.assistantRequests >= REQUEST_STORM_COUNT &&
			promptTokens(operation.mainUsage) >= REQUEST_STORM_PROMPT_TOKENS
		) {
			addAnomaly(
				ctx,
				"request-storm",
				"单次任务累计请求异常偏多",
				`${operation.assistantRequests} 次 assistant 请求累计处理 ${formatTokens(promptTokens(operation.mainUsage))} 提示 Token`,
				"warning",
			);
		}
		operation.endedAt = Date.now();
		lastOperation = operation;
		currentOperation = undefined;
		renderStatus(ctx);
	});

	// shutdown 清除自己的状态项，不影响余额等其他扩展。
	pi.on("session_shutdown", async (_event, ctx) => {
		currentOperation = undefined;
		ctx.ui.setStatus(STATUS_ID, undefined);
	});

	pi.registerCommand("request-meter", {
		description: "查看 Token 用量、异常归因和监测边界；支持 reset、alerts on/off",
		// 命令仅操作本地状态和 UI，不向模型发送消息。
		handler: async (args, ctx) => {
			const normalized = args.trim().toLowerCase();
			if (normalized === "reset") {
				resetSessionState();
				renderStatus(ctx);
				ctx.ui.notify("Request Meter 当前会话统计已重置", "info");
				return;
			}
			if (normalized === "alerts on" || normalized === "alerts off") {
				sharedState.alertsEnabled = normalized.endsWith("on");
				ctx.ui.notify(`Request Meter 异常提醒已${sharedState.alertsEnabled ? "开启" : "关闭"}`, "info");
				return;
			}
			if (normalized) {
				ctx.ui.notify("用法：/request-meter [reset | alerts on | alerts off]", "warning");
				return;
			}
			ctx.ui.notify(buildReport(), recentAnomalies.some((item) => item.severity === "error") ? "error" : "info");
		},
	});
}
