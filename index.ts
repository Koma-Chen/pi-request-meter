import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "request-meter";
const MAX_SAMPLES = 100;
const MAX_ANOMALIES = 20;
const MAX_FINGERPRINT_NODES = 20_000;
const MAX_FINGERPRINT_DEPTH = 32;
const MAX_FINGERPRINT_HASH_CHARS = 1_000_000;
const MAX_FINGERPRINT_WORK_CHARS = 2_000_000;
const FINGERPRINT_SAMPLE_CHARS = 1_024;
const BASH_BLOOM_BYTES = 8_192;
const MAX_NEW_BASH_PER_CONTEXT = 100;
const MAX_BASH_FINGERPRINTS_PER_CONTEXT = 100;
const MAX_CONTEXT_MESSAGES_SCANNED = 1_000;
const LARGE_CONTRIBUTOR_TOKENS = 8_000;
const LARGE_CONTRIBUTOR_ALERT_TOKENS = 20_000;
const PROMPT_JUMP_TOKENS = 20_000;
const SINGLE_PROMPT_TOKENS = 80_000;
const SINGLE_PROMPT_CONTEXT_SHARE = 0.4;
const CONTEXT_NEAR_LIMIT_PERCENT = 85;
const OUTPUT_RUNAWAY_TOKENS = 8_000;
const REASONING_RUNAWAY_TOKENS = 8_000;
const REQUEST_STORM_COUNT = 12;
const REQUEST_STORM_PROMPT_TOKENS = 500_000;
const OPERATION_TOTAL_TOKENS = 750_000;
const NESTED_TOTAL_TOKENS = 100_000;
const STREAM_STATUS_INTERVAL_MS = 300;
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
	reasoningReports: number;
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
	requestIndex: number;
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

interface PayloadFingerprint {
	hash: string;
	sampled: boolean;
	comparable: boolean;
}

interface AssistantMetadata {
	provider?: string;
	model?: string;
	responseModel?: string;
	providerThinkingLevel?: string;
	stopReason?: string;
}

interface OperationState {
	startedAt: number;
	endedAt?: number;
	assistantRequests: number;
	providerRequests: number;
	providerResponses: number;
	observedHttpFailures: number;
	consecutiveHttpFailures: number;
	consecutiveAssistantErrors: number;
	highReasoningStreak: number;
	lastPayloadFingerprint?: string;
	lastPayloadSampled: boolean;
	repeatedPayloads: number;
	compactions: number;
	compactionAttempts: number;
	unknownAuxiliaryUsage: number;
	missingCompactionUsage: number;
	missingTreeUsage: number;
	cancelledCompactions: number;
	validUsageReports: number;
	zeroUsageReports: number;
	missingUsageReports: number;
	streamTextBytes: number;
	streamReasoningBytes: number;
	lastStreamStatusAt: number;
	mainUsage: MeterUsage;
	auxiliaryUsage: MeterUsage;
	nestedUsage: MeterUsage;
	estimatedToolTokens: number;
	estimatedUserBashTokens: number;
	largeContributors: number;
	peakPromptTokens: number;
	largestContributor?: ToolPeak;
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
		reasoningReports: 0,
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
	const reasoningReported = typeof value.reasoning === "number" && Number.isFinite(value.reasoning) && value.reasoning >= 0;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cacheWrite1h: nonNegativeNumber(value.cacheWrite1h),
		reasoning: nonNegativeNumber(value.reasoning),
		reasoningReports: reasoningReported ? 1 : 0,
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
	target.reasoningReports += usage.reasoningReports;
	target.totalTokens += usage.totalTokens;
	target.cost += usage.cost;
	target.reports += usage.reports;
}

/** 判断 usage 是否包含可计费的非零 Token，零值失败样本不参与相对比较。 */
function hasMeaningfulUsage(usage: MeterUsage): boolean {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
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
 * 对 provider payload 生成有界内存指纹：前 100 万字符完整哈希，超出后按字符串分段采样。
 * 节点或深度过大时保留已遍历结构的降级指纹，不再让最值得关注的大请求完全失去重复检测。
 */
function fingerprintPayload(payload: unknown): PayloadFingerprint | undefined {
	const hash = createHash("sha256");
	const seen = new WeakSet<object>();
	let hashedChars = 0;
	let workChars = 0;
	let nodes = 0;
	let sampled = false;
	let comparable = true;

	/** 所有哈希文本统一经过全局工作预算，避免大量键或采样片段绕过上限。 */
	function updateText(value: string): boolean {
		if (workChars + value.length > MAX_FINGERPRINT_WORK_CHARS) {
			comparable = false;
			return false;
		}
		hash.update(value);
		workChars += value.length;
		return true;
	}

	/** 二进制内容按字节计入同一工作预算，不复制底层 ArrayBuffer。 */
	function updateBytes(value: Uint8Array): boolean {
		if (workChars + value.byteLength > MAX_FINGERPRINT_WORK_CHARS) {
			comparable = false;
			return false;
		}
		hash.update(value);
		workChars += value.byteLength;
		return true;
	}

	/** 对超出完整哈希预算的字符串记录长度及头、中、尾样本，避免复制整份文本。 */
	function hashString(value: string): void {
		if (!updateText(`s${value.length}:`)) return;
		if (
			hashedChars + value.length <= MAX_FINGERPRINT_HASH_CHARS &&
			workChars + value.length <= MAX_FINGERPRINT_WORK_CHARS
		) {
			updateText(value);
			hashedChars += value.length;
			return;
		}
		sampled = true;
		const size = Math.min(FINGERPRINT_SAMPLE_CHARS, value.length);
		const middle = Math.max(0, Math.floor((value.length - size) / 2));
		updateText(value.slice(0, size));
		updateText(value.slice(middle, middle + size));
		updateText(value.slice(-size));
	}

	/** 为 typed array 记录类型、长度和有界内容样本，避免不同图片被统一视为空实例。 */
	function hashBinary(type: string, value: Uint8Array): void {
		if (!updateText(`binary:${type}:${value.byteLength}:`)) return;
		if (hashedChars + value.byteLength <= MAX_FINGERPRINT_HASH_CHARS && workChars + value.byteLength <= MAX_FINGERPRINT_WORK_CHARS) {
			updateBytes(value);
			hashedChars += value.byteLength;
			return;
		}
		sampled = true;
		const size = Math.min(FINGERPRINT_SAMPLE_CHARS, value.byteLength);
		const middle = Math.max(0, Math.floor((value.byteLength - size) / 2));
		updateBytes(value.subarray(0, size));
		updateBytes(value.subarray(middle, middle + size));
		updateBytes(value.subarray(value.byteLength - size));
	}

	/** 按稳定键顺序流式写入哈希，不构造 payload 的完整 JSON 副本。 */
	function visit(value: unknown, depth: number): void {
		if (depth > MAX_FINGERPRINT_DEPTH || nodes >= MAX_FINGERPRINT_NODES) {
			sampled = true;
			comparable = false;
			updateText(`limit:${depth}:${typeof value};`);
			return;
		}
		nodes++;
		if (value === null) {
			updateText("null;");
			return;
		}
		if (typeof value === "string") {
			hashString(value);
			return;
		}
		if (typeof value === "bigint") {
			comparable = false;
			updateText("bigint;");
			return;
		}
		if (typeof value === "number" || typeof value === "boolean") {
			updateText(`${typeof value}:${String(value)};`);
			return;
		}
		if (typeof value === "undefined") {
			updateText("undefined;");
			return;
		}
		if (typeof value === "function" || typeof value === "symbol") {
			comparable = false;
			updateText(`${typeof value};`);
			return;
		}
		if (typeof value !== "object") return;
		if (seen.has(value)) {
			comparable = false;
			updateText("circular;");
			return;
		}
		seen.add(value);
		if (ArrayBuffer.isView(value)) {
			const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			hashBinary(value.constructor?.name ?? "TypedArray", view);
			return;
		}
		if (value instanceof ArrayBuffer) {
			hashBinary("ArrayBuffer", new Uint8Array(value));
			return;
		}
		if (Array.isArray(value)) {
			updateText(`array:${value.length}[`);
			for (let index = 0; index < value.length; index++) {
				if (nodes >= MAX_FINGERPRINT_NODES) {
					sampled = true;
					comparable = false;
					updateText(`remaining:${value.length - index};`);
					break;
				}
				visit(value[index], depth + 1);
			}
			updateText("]");
			return;
		}
		if (!isPlainRecord(value)) {
			sampled = true;
			comparable = false;
			updateText(`instance:${value.constructor?.name ?? "unknown"};`);
			return;
		}

		const record = value;
		const keys: string[] = [];
		let pendingKeyChars = 0;
		for (const key in record) {
			if (!Object.hasOwn(record, key)) continue;
			if (
				nodes + keys.length >= MAX_FINGERPRINT_NODES ||
				workChars + pendingKeyChars + key.length > MAX_FINGERPRINT_WORK_CHARS
			) {
				sampled = true;
				comparable = false;
				break;
			}
			keys.push(key);
			pendingKeyChars += key.length;
		}
		keys.sort();
		updateText(`object:${keys.length}${comparable ? "" : "+"}{`);
		for (const key of keys) {
			updateText(`key:`);
			hashString(key);
			visit(record[key], depth + 1);
		}
		updateText("}");
	}

	try {
		visit(payload, 0);
		return { hash: hash.digest("hex"), sampled, comparable };
	} catch {
		return undefined;
	}
}

/** 仅哈希 user bash 的固定大小文本样本，避免单条巨大输出放大每轮去重成本。 */
function fingerprintBashExecution(message: Record<string, unknown>): string {
	const hash = createHash("sha256");
	for (const key of ["command", "output"] as const) {
		const value = typeof message[key] === "string" ? message[key] : "";
		hash.update(`${key}:${value.length}:`);
		if (value.length <= FINGERPRINT_SAMPLE_CHARS * 3) {
			hash.update(value);
		} else {
			const middle = Math.floor((value.length - FINGERPRINT_SAMPLE_CHARS) / 2);
			hash.update(value.slice(0, FINGERPRINT_SAMPLE_CHARS));
			hash.update(value.slice(middle, middle + FINGERPRINT_SAMPLE_CHARS));
			hash.update(value.slice(-FINGERPRINT_SAMPLE_CHARS));
		}
	}
	hash.update(
		`:${typeof message.timestamp === "number" ? message.timestamp : ""}:${String(message.exitCode ?? "")}:${String(message.cancelled ?? "")}:${String(message.truncated ?? "")}`,
	);
	return hash.digest("hex");
}

/** 创建一次从首次 agent_start 到 agent_settled 的完整任务窗口。 */
function createOperation(): OperationState {
	return {
		startedAt: Date.now(),
		assistantRequests: 0,
		providerRequests: 0,
		providerResponses: 0,
		observedHttpFailures: 0,
		consecutiveHttpFailures: 0,
		consecutiveAssistantErrors: 0,
		highReasoningStreak: 0,
		lastPayloadSampled: false,
		repeatedPayloads: 0,
		compactions: 0,
		compactionAttempts: 0,
		unknownAuxiliaryUsage: 0,
		missingCompactionUsage: 0,
		missingTreeUsage: 0,
		cancelledCompactions: 0,
		validUsageReports: 0,
		zeroUsageReports: 0,
		missingUsageReports: 0,
		streamTextBytes: 0,
		streamReasoningBytes: 0,
		lastStreamStatusAt: 0,
		mainUsage: emptyUsage(),
		auxiliaryUsage: emptyUsage(),
		nestedUsage: emptyUsage(),
		estimatedToolTokens: 0,
		estimatedUserBashTokens: 0,
		largeContributors: 0,
		peakPromptTokens: 0,
		samples: [],
		anomalies: [],
		seenAnomalies: new Set(),
	};
}

/** 优先读取响应实际模型和 provider thinking，只有供应商未返回时才回退当前会话配置。 */
function comparisonKey(ctx: ExtensionContext, metadata: AssistantMetadata): { modelKey: string; thinkingLevel: string } {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	const provider = metadata.provider ?? model?.provider ?? "unknown";
	const responseModel = metadata.responseModel ?? metadata.model ?? model?.id ?? "unknown";
	return {
		modelKey: `${provider}/${responseModel}`,
		thinkingLevel: metadata.providerThinkingLevel ?? String(ctx.thinkingLevel ?? "unknown"),
	};
}

/** 生成一行精确用量摘要；提示词拆分可直接定位缓存异常。 */
function usageReport(label: string, usage: MeterUsage): string {
	if (usage.reports === 0) return `${label}：无供应商用量数据`;
	const reasoning =
		usage.reasoningReports === 0
			? "未上报"
			: `${formatTokens(usage.reasoning)}${usage.reasoningReports < usage.reports ? `（${usage.reasoningReports}/${usage.reports} 次上报）` : ""}`;
	return `${label}：提示 ${formatTokens(promptTokens(usage))}（输入 ${formatTokens(usage.input)} / 缓存读 ${formatTokens(usage.cacheRead)} / 写 ${formatTokens(usage.cacheWrite)}）· 输出 ${formatTokens(usage.output)} · 推理 ${reasoning} · 总计 ${formatTokens(usage.totalTokens)} · 费用约 ${formatCost(usage.cost)}`;
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
	let idleAuxiliaryUsage = emptyUsage();
	let sessionNestedUsage = emptyUsage();
	let sessionEstimatedToolTokens = 0;
	let sessionEstimatedUserBashTokens = 0;
	let sessionCompactionAttempts = 0;
	let sessionUnknownAuxiliaryUsage = 0;
	let seenBashBloom = new Uint8Array(BASH_BLOOM_BYTES);
	let seenBashMessageObjects = new WeakSet<object>();
	let bashScanCursor = 0;
	let sessionMissingCompactionUsage = 0;
	let sessionMissingTreeUsage = 0;
	let sessionCancelledCompactions = 0;
	let idleUnknownAuxiliaryUsage = 0;
	let pendingTreeSummary = false;
	let pendingTreeOperation: OperationState | undefined;
	let recentAnomalies: Anomaly[] = [];
	let idleAnomalies: Anomaly[] = [];

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
		idleAuxiliaryUsage = emptyUsage();
		sessionNestedUsage = emptyUsage();
		sessionEstimatedToolTokens = 0;
		sessionEstimatedUserBashTokens = 0;
		sessionCompactionAttempts = 0;
		sessionUnknownAuxiliaryUsage = 0;
		seenBashBloom = new Uint8Array(BASH_BLOOM_BYTES);
		seenBashMessageObjects = new WeakSet();
		bashScanCursor = 0;
		sessionMissingCompactionUsage = 0;
		sessionMissingTreeUsage = 0;
		sessionCancelledCompactions = 0;
		idleUnknownAuxiliaryUsage = 0;
		pendingTreeSummary = false;
		pendingTreeOperation = undefined;
		recentAnomalies = [];
		idleAnomalies = [];
	}

	/** 在模型或上下文结构发生合理变化后重置相对比较基线。 */
	function resetComparisonBoundary(): void {
		boundary++;
		previousSample = undefined;
		if (currentOperation) currentOperation.highReasoningStreak = 0;
	}

	/** 将没有成功完成事件的待决树摘要记为未知用量，并归属发起时的任务或空闲阶段。 */
	function settlePendingTreeAsUnknown(): void {
		if (!pendingTreeSummary) return;
		if (pendingTreeOperation) {
			pendingTreeOperation.unknownAuxiliaryUsage++;
			pendingTreeOperation.missingTreeUsage++;
		} else {
			idleUnknownAuxiliaryUsage++;
		}
		sessionUnknownAuxiliaryUsage++;
		sessionMissingTreeUsage++;
		pendingTreeSummary = false;
		pendingTreeOperation = undefined;
	}

	/** 清除已由成功树导航事件结算的待决标记，不增加未知计数。 */
	function clearPendingTree(): void {
		pendingTreeSummary = false;
		pendingTreeOperation = undefined;
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
		if (!operation) {
			idleAnomalies.push(anomaly);
			if (idleAnomalies.length > MAX_ANOMALIES) idleAnomalies = idleAnomalies.slice(-MAX_ANOMALIES);
		}
		recentAnomalies.push(anomaly);
		if (recentAnomalies.length > MAX_ANOMALIES) recentAnomalies = recentAnomalies.slice(-MAX_ANOMALIES);
		if (sharedState.alertsEnabled && ctx.hasUI) ctx.ui.notify(`Token 异常：${title}\n${anomaly.detail}`, severity);
		renderStatus(ctx);
	}

	/** 汇总任务内已上报的主模型、压缩和工具内模型 Token，不包含会重复进入提示词的工具文本估算。 */
	function operationReportedTokens(operation: OperationState): number {
		return operation.mainUsage.totalTokens + operation.auxiliaryUsage.totalTokens + operation.nestedUsage.totalTokens;
	}

	/** 根据当前模型窗口计算贡献项占比；模型未知时只使用绝对阈值。 */
	function contributorShare(ctx: ExtensionContext, estimatedTokens: number): number {
		const model = ctx.model as { contextWindow?: number } | undefined;
		return model?.contextWindow && model.contextWindow > 0 ? estimatedTokens / model.contextWindow : 0;
	}

	/** 在每次新增精确用量后实时检查相互独立的任务预算，避免等到 settled 才发现失控。 */
	function evaluateOperationBudgets(ctx: ExtensionContext): void {
		const operation = currentOperation;
		if (!operation) return;
		if (operation.assistantRequests >= REQUEST_STORM_COUNT) {
			addAnomaly(
				ctx,
				"request-count",
				"单次任务请求轮次偏多",
				`已观察到 ${operation.assistantRequests} 次 assistant 请求`,
				"warning",
			);
		}
		const cumulativePrompt = promptTokens(operation.mainUsage);
		if (cumulativePrompt >= REQUEST_STORM_PROMPT_TOKENS) {
			addAnomaly(
				ctx,
				"cumulative-prompt",
				"任务累计提示 Token 异常偏高",
				`已累计处理 ${formatTokens(cumulativePrompt)} 提示 Token`,
				"warning",
			);
		}
		const reportedTotal = operationReportedTokens(operation);
		if (reportedTotal >= OPERATION_TOTAL_TOKENS) {
			addAnomaly(
				ctx,
				"cumulative-total",
				"任务全口径 Token 异常偏高",
				`主模型、压缩和工具内模型共上报 ${formatTokens(reportedTotal)} Token`,
				"warning",
			);
		}
		if (operation.nestedUsage.totalTokens >= NESTED_TOTAL_TOKENS) {
			addAnomaly(
				ctx,
				"cumulative-nested-usage",
				"工具内模型累计消耗异常偏高",
				`工具内模型已累计上报 ${formatTokens(operation.nestedUsage.totalTokens)} Token`,
				"warning",
			);
		}
	}

	/** 空闲压缩和树摘要不归入上次任务，但单次上报超大时仍需立即告警。 */
	function evaluateIdleAuxiliaryUsage(ctx: ExtensionContext, usage: MeterUsage, source: string): void {
		if (currentOperation || usage.totalTokens < OPERATION_TOTAL_TOKENS) return;
		addAnomaly(
			ctx,
			"idle-auxiliary-total",
			"空闲辅助模型调用异常偏高",
			`${source} 单次上报 ${formatTokens(usage.totalTokens)} Token，未归入上次任务`,
			"warning",
		);
	}

	/** 根据运行态、异常数和会话总量更新独立状态项，不覆盖其他页脚扩展。 */
	function renderStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const activeOperation = currentOperation;
		if (activeOperation) {
			const latest = activeOperation.samples.at(-1);
			const warning = activeOperation.anomalies.length > 0 ? ` ⚠${activeOperation.anomalies.length}` : "";
			const cache = latest && latest.promptTokens > 0 ? ` · 缓存 ${Math.round(cacheReadRate(latest) * 100)}%` : "";
			const recent = latest ? ` · 最近 ${formatTokens(latest.promptTokens)}` : "";
			const liveOutput = Math.ceil((activeOperation.streamTextBytes + activeOperation.streamReasoningBytes) / 4);
			const streaming = liveOutput > 0 ? ` · 输出~${formatTokens(liveOutput)}` : "";
			const lowerBound =
				activeOperation.zeroUsageReports +
					activeOperation.missingUsageReports +
					activeOperation.unknownAuxiliaryUsage +
					(pendingTreeSummary && pendingTreeOperation === activeOperation ? 1 : 0) >
				0
					? " · 下界"
					: "";
			ctx.ui.setStatus(
				STATUS_ID,
				`Token${warning} · 本次 ${formatTokens(operationReportedTokens(activeOperation))} · 请求 ${Math.max(activeOperation.providerRequests, activeOperation.assistantRequests)}${recent}${cache}${streaming}${lowerBound}`,
			);
			return;
		}
		if (idleAnomalies.length > 0 || idleUnknownAuxiliaryUsage > 0 || (pendingTreeSummary && !pendingTreeOperation)) {
			const warning = idleAnomalies.length > 0 ? ` ⚠${idleAnomalies.length}` : "";
			ctx.ui.setStatus(
				STATUS_ID,
				`Token 空闲辅助${warning} · ${formatTokens(idleAuxiliaryUsage.totalTokens)}${idleUnknownAuxiliaryUsage > 0 || pendingTreeSummary ? " · 下界" : ""}`,
			);
			return;
		}
		if (lastOperation) {
			const warning = lastOperation.anomalies.length > 0 ? ` ⚠${lastOperation.anomalies.length}` : " 正常";
			const lowerBound =
				lastOperation.zeroUsageReports +
					lastOperation.missingUsageReports +
					lastOperation.unknownAuxiliaryUsage >
				0
					? " · 下界"
					: "";
			ctx.ui.setStatus(STATUS_ID, `Token${warning} · 上次 ${formatTokens(operationReportedTokens(lastOperation))}${lowerBound}`);
			return;
		}
		const sessionTotal = sessionMainUsage.totalTokens + sessionAuxiliaryUsage.totalTokens + sessionNestedUsage.totalTokens;
		const idleWarning = recentAnomalies.length > 0 ? ` ⚠${recentAnomalies.length}` : " 待命";
		ctx.ui.setStatus(
			STATUS_ID,
			`Token${idleWarning}${sessionTotal > 0 ? ` · 会话 ${formatTokens(sessionTotal)}` : ""}${idleUnknownAuxiliaryUsage > 0 ? " · 下界" : ""}`,
		);
	}

	/** 将一次精确主模型用量转为样本，并运行只依赖数字的保守异常规则。 */
	function recordMainUsage(ctx: ExtensionContext, usage: MeterUsage, metadata: AssistantMetadata): void {
		const operation = ensureOperation();
		addUsage(operation.mainUsage, usage);
		addUsage(sessionMainUsage, usage);
		operation.validUsageReports++;
		const keys = comparisonKey(ctx, metadata);
		const context = ctx.getContextUsage();
		const sample: UsageSample = {
			...usage,
			timestamp: Date.now(),
			promptTokens: promptTokens(usage),
			stopReason: metadata.stopReason,
			modelKey: keys.modelKey,
			thinkingLevel: keys.thinkingLevel,
			boundary,
			contextPercent: typeof context?.percent === "number" ? context.percent : undefined,
			requestIndex: operation.assistantRequests,
		};
		operation.samples.push(sample);
		if (operation.samples.length > MAX_SAMPLES) operation.samples = operation.samples.slice(-MAX_SAMPLES);
		operation.peakPromptTokens = Math.max(operation.peakPromptTokens, sample.promptTokens);

		const contextWindow = context?.contextWindow ?? (ctx.model as { contextWindow?: number } | undefined)?.contextWindow;
		const contextShare = contextWindow && contextWindow > 0 ? sample.promptTokens / contextWindow : 0;
		if (sample.promptTokens >= SINGLE_PROMPT_TOKENS || contextShare >= SINGLE_PROMPT_CONTEXT_SHARE) {
			const critical = contextShare >= 0.7;
			addAnomaly(
				ctx,
				critical ? "single-prompt-critical" : "single-prompt-large",
				critical ? "单次提示已占用大部分上下文" : "单次提示 Token 异常偏高",
				`${formatTokens(sample.promptTokens)} Token${contextWindow ? `，约占 ${Math.round(contextShare * 100)}% 上下文` : ""}`,
				critical ? "error" : "warning",
			);
		}

		const canCompare =
			sample.promptTokens > 0 && metadata.stopReason !== "error" && metadata.stopReason !== "aborted";
		const comparable =
			canCompare &&
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

		if (metadata.stopReason === "length" || sample.output >= OUTPUT_RUNAWAY_TOKENS * 2) {
			addAnomaly(
				ctx,
				"output-runaway",
				metadata.stopReason === "length" ? "输出达到模型长度限制" : "单次输出异常偏大",
				`本次输出 ${formatTokens(sample.output)} Token${metadata.stopReason === "length" ? "，stopReason=length" : ""}`,
				"warning",
			);
		}

		const reasoningHeavy = sample.reasoning >= REASONING_RUNAWAY_TOKENS && sample.output > 0 && sample.reasoning / sample.output >= 0.8;
		if (!canCompare || sample.reasoningReports === 0) operation.highReasoningStreak = 0;
		else if (!comparable) operation.highReasoningStreak = reasoningHeavy ? 1 : 0;
		else operation.highReasoningStreak = reasoningHeavy ? operation.highReasoningStreak + 1 : 0;
		const thinkingExpected = ["high", "xhigh", "max"].includes(sample.thinkingLevel);
		if (
			canCompare &&
			sample.reasoningReports > 0 &&
			!thinkingExpected &&
			(sample.reasoning >= REASONING_RUNAWAY_TOKENS * 2 || operation.highReasoningStreak >= 2)
		) {
			addAnomaly(
				ctx,
				"reasoning-runaway",
				"推理 Token 异常偏高",
				`thinking=${sample.thinkingLevel}，本次推理 ${formatTokens(sample.reasoning)} / 输出 ${formatTokens(sample.output)}`,
				"warning",
			);
		}

		if (canCompare) previousSample = sample;
		evaluateOperationBudgets(ctx);
	}

	/** 记录进入会话的大文本贡献项；8k 仅记账，达到 20k 或窗口 10% 才作为异常提醒。 */
	function recordEstimatedContributor(
		ctx: ExtensionContext,
		name: string,
		estimatedTokens: number,
		images: number,
		anomalyCode: string,
	): void {
		const operation = ensureOperation();
		if (!operation.largestContributor || estimatedTokens > operation.largestContributor.estimatedTokens) {
			operation.largestContributor = { name, estimatedTokens, images };
		}
		if (estimatedTokens >= LARGE_CONTRIBUTOR_TOKENS) operation.largeContributors++;
		const share = contributorShare(ctx, estimatedTokens);
		if (estimatedTokens >= LARGE_CONTRIBUTOR_ALERT_TOKENS || share >= 0.1) {
			addAnomaly(
				ctx,
				anomalyCode,
				"单个上下文贡献项异常偏大",
				`${name} 约 ${formatTokens(estimatedTokens)} Token${share > 0 ? `，约占模型窗口 ${Math.round(share * 100)}%` : ""}${images ? `，另有 ${images} 张图片未估算` : ""}`,
				"warning",
			);
		}
	}

	/** 在 turn_end 后读取较稳定的上下文占比，并把接近窗口上限作为独立高风险异常。 */
	function recordContextRisk(ctx: ExtensionContext): void {
		const context = ctx.getContextUsage();
		const operation = currentOperation;
		if (!operation || typeof context?.percent !== "number") return;
		const latest = operation.samples.at(-1);
		if (latest) latest.contextPercent = context.percent;
		if (context.percent >= CONTEXT_NEAR_LIMIT_PERCENT) {
			addAnomaly(
				ctx,
				"context-near-limit",
				"上下文接近容量上限",
				`当前上下文约占 ${context.percent.toFixed(1)}%`,
				"error",
			);
		}
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
		recordEstimatedContributor(ctx, `工具 ${toolName}`, estimate.tokens, estimate.images, "large-tool-result");

		const nestedUsage = normalizeUsage(message.usage);
		if (nestedUsage) {
			addUsage(operation.nestedUsage, nestedUsage);
			addUsage(sessionNestedUsage, nestedUsage);
		}
		evaluateOperationBudgets(ctx);
		renderStatus(ctx);
	}

	/** 用固定 8KB Bloom filter 近似去重克隆后的 bash 消息，宁可极低概率漏计也不让内存增长。 */
	function hasSeenBashIdentity(hash: string): boolean {
		const bitCount = seenBashBloom.byteLength * 8;
		const positions = [0, 8, 16].map((offset) => Number.parseInt(hash.slice(offset, offset + 8), 16) % bitCount);
		const seen = positions.every((position) => (seenBashBloom[Math.floor(position / 8)] & (1 << (position % 8))) !== 0);
		for (const position of positions) seenBashBloom[Math.floor(position / 8)] |= 1 << (position % 8);
		return seen;
	}

	/** 在下一次 context 事件中延迟发现 user bash 输出，并逐批处理积压、近似去重克隆消息。 */
	function recordUserBashOutputs(ctx: ExtensionContext, messages: unknown[]): void {
		if (messages.length === 0) return;
		const start = bashScanCursor % messages.length;
		let inspected = 0;
		let fingerprinted = 0;
		let added = 0;
		while (
			inspected < messages.length &&
			inspected < MAX_CONTEXT_MESSAGES_SCANNED &&
			fingerprinted < MAX_BASH_FINGERPRINTS_PER_CONTEXT &&
			added < MAX_NEW_BASH_PER_CONTEXT
		) {
			const index = (start + inspected) % messages.length;
			inspected++;
			const message = messages[index];
			if (!isRecord(message) || message.role !== "bashExecution" || message.excludeFromContext === true) continue;
			if (typeof message.timestamp !== "number" || typeof message.output !== "string") continue;
			if (seenBashMessageObjects.has(message)) continue;
			fingerprinted++;
			const identity = fingerprintBashExecution(message);
			if (hasSeenBashIdentity(identity)) {
				seenBashMessageObjects.add(message);
				continue;
			}
			seenBashMessageObjects.add(message);
			added++;

			const estimatedTokens = Math.ceil(Buffer.byteLength(message.output, "utf8") / 4);
			const operation = ensureOperation();
			operation.estimatedUserBashTokens += estimatedTokens;
			sessionEstimatedUserBashTokens += estimatedTokens;
			recordEstimatedContributor(ctx, "user bash", estimatedTokens, 0, "large-user-bash");
		}
		bashScanCursor = (start + Math.max(inspected, 1)) % messages.length;
		if (added > 0) renderStatus(ctx);
	}

	/** 生成不会进入模型上下文的会话报告，明确区分精确值与估算值。 */
	function buildReport(): string {
		const operation = currentOperation ?? lastOperation;
		const lines = ["Pi Request Meter"];
		if (!operation) {
			lines.push("当前会话尚未观察到主模型请求。");
		} else {
			const elapsed = Math.max(0, (operation.endedAt ?? Date.now()) - operation.startedAt);
			const coverage = operation.assistantRequests > 0 ? (operation.validUsageReports / operation.assistantRequests) * 100 : 0;
			lines.push(
				`状态：${operation.anomalies.length > 0 ? `${operation.anomalies.length} 项异常` : currentOperation ? "监测中" : "正常"}`,
				`窗口：${(elapsed / 1000).toFixed(1)} 秒 · assistant ${operation.assistantRequests} 次 · provider hook ${operation.providerRequests} 次 · 可见 HTTP 响应 ${operation.providerResponses} 次`,
				`usage 完整度：${coverage.toFixed(0)}%（有效 ${operation.validUsageReports} / 全零 ${operation.zeroUsageReports} / 缺失 ${operation.missingUsageReports}）${coverage < 100 ? "，总量仅为下界" : ""}`,
				usageReport("本次主模型（供应商上报）", operation.mainUsage),
				`请求峰值：提示 ${formatTokens(operation.peakPromptTokens)} Token`,
			);
			if (operation.providerRequests !== operation.assistantRequests) {
				lines.push(
					`事件差异：provider hook ${operation.providerRequests} / assistant ${operation.assistantRequests}，网络重试或事件缺失可能使统计不完整`,
				);
			}
			if (operation.auxiliaryUsage.reports > 0) lines.push(usageReport("本次压缩/树摘要（供应商上报）", operation.auxiliaryUsage));
			if (operation.nestedUsage.reports > 0) lines.push(usageReport("本次工具内模型（工具上报，单独计）", operation.nestedUsage));
			if (
				operation.compactionAttempts > 0 ||
				operation.unknownAuxiliaryUsage > 0 ||
				(pendingTreeSummary && pendingTreeOperation === operation)
			) {
				lines.push(
					`辅助调用：压缩尝试 ${operation.compactionAttempts} 次 · 成功 ${operation.compactions} 次 · 压缩缺失 ${operation.missingCompactionUsage} · 树摘要缺失 ${operation.missingTreeUsage} · 树摘要待决 ${pendingTreeSummary && pendingTreeOperation === operation ? 1 : 0} · 取消不确定 ${operation.cancelledCompactions}`,
				);
			}
			lines.push(
				`上下文贡献：工具结果约 ${formatTokens(operation.estimatedToolTokens)} · user bash 约 ${formatTokens(operation.estimatedUserBashTokens)} Token（本地估算）· 大贡献项 ${operation.largeContributors} 个`,
			);
			if (operation.largestContributor) {
				lines.push(
					`最大贡献项：${operation.largestContributor.name} 约 ${formatTokens(operation.largestContributor.estimatedTokens)} Token${operation.largestContributor.images ? `，另有 ${operation.largestContributor.images} 张图片未估算` : ""}`,
				);
			}
			if (operation.samples.length > 0) {
				lines.push(
					"最近请求：",
					...operation.samples.slice(-5).map((sample) => {
						const reasoning = sample.reasoningReports > 0 ? formatTokens(sample.reasoning) : "未上报";
						return `- #${sample.requestIndex} ${sample.modelKey} · 提示 ${formatTokens(sample.promptTokens)} · 缓存 ${Math.round(cacheReadRate(sample) * 100)}% · 输出 ${formatTokens(sample.output)} · 推理 ${reasoning} · ${sample.stopReason ?? "unknown"}`;
					}),
				);
			}
			if (operation.anomalies.length > 0) {
				lines.push("本次异常：", ...operation.anomalies.slice(-5).map((item) => `- ${item.title}：${item.detail}`));
			}
		}

		lines.push(usageReport("会话主模型", sessionMainUsage));
		if (sessionAuxiliaryUsage.reports > 0) lines.push(usageReport("会话压缩/树摘要", sessionAuxiliaryUsage));
		if (sessionNestedUsage.reports > 0) lines.push(usageReport("会话工具内模型（单独计）", sessionNestedUsage));
		lines.push(
			`会话贡献估算：工具结果约 ${formatTokens(sessionEstimatedToolTokens)} · user bash 约 ${formatTokens(sessionEstimatedUserBashTokens)} Token`,
			`会话辅助调用：压缩尝试 ${sessionCompactionAttempts} 次 · 压缩缺失 ${sessionMissingCompactionUsage} · 树摘要缺失 ${sessionMissingTreeUsage} · 树摘要待决 ${pendingTreeSummary ? 1 : 0} · 取消不确定 ${sessionCancelledCompactions} · 未知用量合计 ${sessionUnknownAuxiliaryUsage}`,
		);
		const historicalAnomalies = operation
			? recentAnomalies.filter((item) => !operation.anomalies.includes(item))
			: recentAnomalies;
		if (historicalAnomalies.length > 0) {
			lines.push("会话其他历史异常：", ...historicalAnomalies.slice(-5).map((item) => `- ${item.title}：${item.detail}`));
		} else if (!operation?.anomalies.length) {
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
		if (!currentOperation) {
			settlePendingTreeAsUnknown();
			idleAnomalies = [];
			idleUnknownAuxiliaryUsage = 0;
			idleAuxiliaryUsage = emptyUsage();
		}
		ensureOperation();
		renderStatus(ctx);
	});

	// 只对当前处理器可见的 provider payload 做有界哈希和请求计数，绝不修改或保存原文。
	pi.on("before_provider_request", (event, ctx) => {
		if (!currentOperation) return;
		const operation = currentOperation;
		operation.providerRequests++;
		const fingerprint = fingerprintPayload(event.payload);
		if (fingerprint?.comparable && fingerprint.hash === operation.lastPayloadFingerprint) {
			operation.repeatedPayloads++;
			if (operation.repeatedPayloads >= 2) {
				const sampled = fingerprint.sampled || operation.lastPayloadSampled;
				addAnomaly(
					ctx,
					"duplicate-payload",
					sampled ? "连续重复发送疑似相同的大请求" : "连续重复发送相同请求",
					`已连续观察到 ${operation.repeatedPayloads + 1} 次${sampled ? "采样指纹" : "完整指纹"}相同的 provider payload`,
					"warning",
				);
			}
		} else {
			operation.repeatedPayloads = 0;
		}
		operation.lastPayloadFingerprint = fingerprint?.comparable ? fingerprint.hash : undefined;
		operation.lastPayloadSampled = fingerprint?.comparable ? fingerprint.sampled : false;
		renderStatus(ctx);
	});

	// HTTP 事件只作为可见下界；不同 provider 的内部重试不保证都会触发该事件。
	pi.on("after_provider_response", (event, ctx) => {
		if (!currentOperation) return;
		currentOperation.providerResponses++;
		if (event.status === 429 || event.status >= 500) {
			currentOperation.observedHttpFailures++;
			currentOperation.consecutiveHttpFailures++;
			if (currentOperation.consecutiveHttpFailures >= 2) {
				addAnomaly(
					ctx,
					"http-retry-storm",
					"疑似网络重试风暴",
					`已连续观察到 ${currentOperation.consecutiveHttpFailures} 个 429/5xx 响应；实际网络重试可能更多`,
					"warning",
				);
			}
		} else {
			currentOperation.consecutiveHttpFailures = 0;
		}
	});

	// assistant 流开始时清空本次本地估算，避免与上一轮或最终供应商 usage 重复显示。
	pi.on("message_start", (event) => {
		const message = event.message as { role?: string };
		if (message.role !== "assistant") return;
		const operation = ensureOperation();
		operation.streamTextBytes = 0;
		operation.streamReasoningBytes = 0;
		operation.lastStreamStatusAt = 0;
	});

	// 只累加流式 delta，并限制状态栏刷新频率；partial 和 end 块包含累计内容，不能再次计数。
	pi.on("message_update", (event, ctx) => {
		const update = event.assistantMessageEvent as { type?: string; delta?: string };
		if ((update.type !== "text_delta" && update.type !== "thinking_delta") || typeof update.delta !== "string") return;
		const operation = ensureOperation();
		const bytes = Buffer.byteLength(update.delta, "utf8");
		if (update.type === "thinking_delta") operation.streamReasoningBytes += bytes;
		else operation.streamTextBytes += bytes;
		const now = Date.now();
		if (now - operation.lastStreamStatusAt >= STREAM_STATUS_INTERVAL_MS) {
			operation.lastStreamStatusAt = now;
			renderStatus(ctx);
		}
	});

	// user bash 没有执行后事件，只在它真正进入下一次模型 context 时延迟统计并去重。
	pi.on("context", (event, ctx) => {
		recordUserBashOutputs(ctx, event.messages);
	});

	// 最终 assistant 消息携带本次供应商用量，是主模型精确记账的唯一来源。
	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: string;
			usage?: unknown;
			stopReason?: string;
			provider?: string;
			model?: string;
			responseModel?: string;
			providerThinkingLevel?: string;
		};
		if (message.role !== "assistant") return;
		const operation = ensureOperation();
		operation.assistantRequests++;
		operation.streamTextBytes = 0;
		operation.streamReasoningBytes = 0;
		const usage = normalizeUsage(message.usage);
		if (!usage) {
			operation.missingUsageReports++;
			operation.highReasoningStreak = 0;
			addAnomaly(
				ctx,
				"usage-incomplete",
				"供应商用量上报不完整",
				`第 ${operation.assistantRequests} 次 assistant 请求缺少 usage；当前总量只是下界`,
				"warning",
			);
		} else if (!hasMeaningfulUsage(usage)) {
			operation.zeroUsageReports++;
			operation.highReasoningStreak = 0;
			addAnomaly(
				ctx,
				"usage-incomplete",
				"供应商用量上报不完整",
				`第 ${operation.assistantRequests} 次 assistant 请求 usage 全零；当前总量只是下界`,
				"warning",
			);
		} else {
			recordMainUsage(ctx, usage, message);
		}

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
		evaluateOperationBudgets(ctx);
		renderStatus(ctx);
	});

	// turn_end 位于工具消息定稿和持久化之后，按最终会话版本统计本轮全部工具结果。
	pi.on("turn_end", (event, ctx) => {
		for (const message of event.toolResults) recordToolResult(ctx, message);
		recordContextRisk(ctx);
	});

	// 压缩前立即切断比较基线，避免压缩后的正常下降或重写触发误报。
	pi.on("session_before_compact", async () => {
		sessionCompactionAttempts++;
		if (currentOperation) currentOperation.compactionAttempts++;
		resetComparisonBoundary();
	});

	// 压缩调用不经过 provider hooks，必须从 compactionEntry.usage 单独补记。
	pi.on("session_compact", (event, ctx) => {
		const operation = currentOperation;
		if (operation) operation.compactions++;
		const compactEvent = event as { compactionEntry?: { usage?: unknown } };
		const usage = normalizeUsage(compactEvent.compactionEntry?.usage);
		if (usage && hasMeaningfulUsage(usage)) {
			if (operation) addUsage(operation.auxiliaryUsage, usage);
			else addUsage(idleAuxiliaryUsage, usage);
			addUsage(sessionAuxiliaryUsage, usage);
			evaluateIdleAuxiliaryUsage(ctx, usage, "上下文压缩");
		} else {
			if (operation) {
				operation.unknownAuxiliaryUsage++;
				operation.missingCompactionUsage++;
			} else {
				idleUnknownAuxiliaryUsage++;
			}
			sessionUnknownAuxiliaryUsage++;
			sessionMissingCompactionUsage++;
		}
		if (operation && operation.compactions >= 2) {
			addAnomaly(ctx, "repeated-compaction", "单次任务重复压缩", `本次任务已执行 ${operation.compactions} 次压缩`, "warning");
		}
		evaluateOperationBudgets(ctx);
		renderStatus(ctx);
	});

	// 压缩失败可能已经产生未上报消耗，因此明确标记为未知而不是记零。
	pi.on("session_compact_failed", (event, ctx) => {
		if (currentOperation) {
			currentOperation.unknownAuxiliaryUsage++;
			if (event.aborted) currentOperation.cancelledCompactions++;
			else currentOperation.missingCompactionUsage++;
		} else {
			idleUnknownAuxiliaryUsage++;
		}
		sessionUnknownAuxiliaryUsage++;
		if (event.aborted) sessionCancelledCompactions++;
		else sessionMissingCompactionUsage++;
		if (event.aborted) {
			renderStatus(ctx);
			return;
		}
		const outcome = event.errorMessage ? `错误=${event.errorMessage}` : "错误未知";
		addAnomaly(
			ctx,
			"compaction-failed",
			"上下文压缩失败",
			`触发=${event.reason}，${outcome}${event.willRetry ? "，Pi 将重试；失败调用的 Token 可能无法统计" : ""}`,
			"warning",
		);
	});

	// 只有用户要求摘要且确有待摘要条目时才登记；无完成事件的待决调用随后按未知处理。
	pi.on("session_before_tree", (event, ctx) => {
		settlePendingTreeAsUnknown();
		if (event.preparation.userWantsSummary && event.preparation.entriesToSummarize.length > 0) {
			pendingTreeSummary = true;
			pendingTreeOperation = currentOperation;
		}
		renderStatus(ctx);
	});

	// 树导航摘要同样是额外模型调用，若事件提供 usage 则单独计入辅助用量。
	pi.on("session_tree", (event, ctx) => {
		const treeEvent = event as { summaryEntry?: { usage?: unknown } };
		const wasPending = pendingTreeSummary;
		const owner = pendingTreeOperation ?? currentOperation;
		const usage = normalizeUsage(treeEvent.summaryEntry?.usage);
		if (usage && hasMeaningfulUsage(usage)) {
			if (owner) addUsage(owner.auxiliaryUsage, usage);
			else addUsage(idleAuxiliaryUsage, usage);
			addUsage(sessionAuxiliaryUsage, usage);
			evaluateIdleAuxiliaryUsage(ctx, usage, "树导航摘要");
			clearPendingTree();
		} else if (wasPending) {
			settlePendingTreeAsUnknown();
		} else if (treeEvent.summaryEntry) {
			if (owner) {
				owner.unknownAuxiliaryUsage++;
				owner.missingTreeUsage++;
			} else {
				idleUnknownAuxiliaryUsage++;
			}
			sessionUnknownAuxiliaryUsage++;
			sessionMissingTreeUsage++;
		}
		resetComparisonBoundary();
		evaluateOperationBudgets(ctx);
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
		evaluateOperationBudgets(ctx);
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
