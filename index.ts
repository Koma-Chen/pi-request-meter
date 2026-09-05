import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const STATUS_ID = "request-meter";
const SUMMARY_WIDGET_ID = "request-meter-summary";
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
const REQUEST_STORM_COUNT = 30;
const CACHE_COMPARISON_MAX_AGE_MS = 5 * 60 * 1_000;
const MAX_SUBAGENT_RESULTS = 1_000;
const REQUEST_STORM_PROMPT_TOKENS = 500_000;
const OPERATION_TOTAL_TOKENS = 750_000;
const NESTED_TOTAL_TOKENS = 100_000;
const STREAM_STATUS_INTERVAL_MS = 300;
const MAX_DETAIL_CHARS = 1_000;
const ALERTS_STATE_KEY = Symbol.for("pi-request-meter.alerts-state");
const NATIVE_SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");
const MAX_NATIVE_AGENTS = 256;
const MAX_NATIVE_TOOL_CALLS = 128;
const MAX_PENDING_TREE_SUMMARIES = 64;
const NATIVE_SUBAGENT_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

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
	modelEvidence: ModelEvidence;
}

interface RequestModelEvidence {
	observedAtMs: number;
	requested: { source: "before_provider_request" | "unobserved"; model: string | null; thinkingLevel: string | null };
	clientResolved: { provider: string | null; model: string | null; thinkingLevel: string | null };
}

interface ModelEvidence extends RequestModelEvidence {
	responseRecord: { api: string | null; model: string | null; providerThinkingLevel: string | null };
	providerConfirmed: { model: string | null; thinkingLevel: null; modelSource: string | null };
}

interface Anomaly {
	code: string;
	title: string;
	detail: string;
	severity: Severity;
	timestamp: number;
	estimatedRequest?: number;
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
	skipReason?: FingerprintSkipReason;
}

type FingerprintSkipReason = "nodes" | "depth" | "work" | "unsupported" | "error";
type FingerprintSkipCounts = Record<FingerprintSkipReason, number>;

interface AssistantMetadata {
	api?: string;
	provider?: string;
	model?: string;
	responseModel?: string;
	responseId?: string;
	providerThinkingLevel?: string;
	stopReason?: string;
}

interface OperationState {
	startedAt: number;
	endedAt?: number;
	pendingRequestModel?: RequestModelEvidence;
	lastModelEvidence?: ModelEvidence;
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
	unknownNestedUsage: number;
	missingNestedUsage: number;
	zeroNestedUsage: number;
	fingerprintSkips: FingerprintSkipCounts;
	previousCacheSample?: UsageSample;
	nativeWorkflowCapacityGap: boolean;
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

interface NativeAgentObservation {
	usage: MeterUsage;
	owner?: OperationState;
	pending: boolean;
	gapReported: boolean;
	compactions: number;
	descendantCompactions?: number;
	descendantCoverageGapReported: boolean;
	queryOnlyRun: boolean;
	queryAssistantResponses: number;
	unsubscribeQueryResponses?: () => void;
}

interface NativeToolObservation {
	owner?: OperationState;
	id?: string;
	newAgent: boolean;
	runRequested: boolean;
	gapReported: boolean;
	evictionGeneration: number;
}

interface NativeRecordSnapshot {
	status: string;
	startedAt?: number;
	usage?: MeterUsage;
	compactions: number;
	descendantCompactions?: number;
}

interface NativeRegistry {
	getRecord(id: string): unknown;
	resolveReference?(reference: string): string | undefined;
	compactionCoverageVersion?: number;
	getUsagePoolSnapshot?(): unknown;
}

interface NativePoolBaseline {
	registry: NativeRegistry;
	generation?: number;
	usage?: MeterUsage;
}

type ObservationStartReason = "extension-load" | "startup" | "reload" | "new" | "resume" | "fork" | "session-start" | "manual-reset";

/** 创建原生观察器的固定数字诊断项，计数之外不保留事件或模型内容。 */
function emptyNativeObserverStats() {
	return { starts: 0, settlements: 0, ignoredPoolReports: 0, unknownReports: 0,
		compactionsWithoutUsage: 0, capacitySkips: 0, evictions: 0, readFailures: 0, unmatchedTools: 0,
		unmeteredWorkflowRuns: 0, workflowCapacityExceeded: 0, unresolvedQueries: 0, queryBaselines: 0,
		descendantCompactionsWithoutUsage: 0, descendantCoverageGaps: 0,
		queryResponseCoverageGaps: 0, activeQueryResponseSubscriptions: 0, poolWindowCoverageGaps: 0 };
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

/** 在同一 Pi 进程的扩展重载和会话切换之间共享轮末检测摘要开关，不写入磁盘。 */
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

/** 将官方 subagent 的累计字段转为标准用量；contextTokens 仅代表最后一轮，不能参与累计。 */
function normalizeSubagentUsage(value: unknown): MeterUsage | undefined {
	if (!isRecord(value)) return undefined;
	return normalizeUsage({
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		cost: { total: value.cost },
	});
}

/** 创建固定原因集合的覆盖计数，避免异常 payload 生成无界诊断键。 */
function emptyFingerprintSkips(): FingerprintSkipCounts {
	return { nodes: 0, depth: 0, work: 0, unsupported: 0, error: 0 };
}

/** 用固定中文原因汇总未参与重复检测的请求，零计数不显示。 */
function fingerprintSkipReport(counts: FingerprintSkipCounts): string {
	const labels: Record<FingerprintSkipReason, string> = {
		nodes: "节点预算", depth: "深度预算", work: "工作量预算", unsupported: "不支持的结构", error: "读取失败",
	};
	return (Object.keys(labels) as FingerprintSkipReason[])
		.filter((reason) => counts[reason] > 0)
		.map((reason) => `${labels[reason]} ${counts[reason]} 次`)
		.join(" / ");
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

/** 轮末用量使用完整整数，避免状态栏的 k/m 缩写掩盖缓存与普通输入的对应关系。 */
function formatExactTokens(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

/** 缓存和普通输入均以全部输入为分母；没有输入时不伪造命中率。 */
function formatInputShare(value: number, inputTotal: number): string {
	return inputTotal > 0 ? `${((value / inputTotal) * 100).toFixed(1)}%` : "不适用";
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
 * 节点、深度或工作量超预算时停止比较并记录原因，绝不使用不完整结构判定重复。
 */
function fingerprintPayload(payload: unknown): PayloadFingerprint {
	const hash = createHash("sha256");
	const seen = new WeakSet<object>();
	let hashedChars = 0;
	let workChars = 0;
	let nodes = 0;
	let sampled = false;
	let comparable = true;
	let skipReason: FingerprintSkipReason | undefined;

	/** 保留首个导致指纹不可比较的原因，后续遍历立即停止。 */
	function skip(reason: FingerprintSkipReason): void {
		comparable = false;
		skipReason ??= reason;
	}

	/** 所有哈希文本统一经过全局工作预算，避免大量键或采样片段绕过上限。 */
	function updateText(value: string): boolean {
		if (!comparable) return false;
		if (workChars + value.length > MAX_FINGERPRINT_WORK_CHARS) {
			skip("work");
			return false;
		}
		hash.update(value);
		workChars += value.length;
		return true;
	}

	/** 二进制内容按字节计入同一工作预算，不复制底层 ArrayBuffer。 */
	function updateBytes(value: Uint8Array): boolean {
		if (!comparable) return false;
		if (workChars + value.byteLength > MAX_FINGERPRINT_WORK_CHARS) {
			skip("work");
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
		if (!comparable) return;
		if (depth > MAX_FINGERPRINT_DEPTH || nodes >= MAX_FINGERPRINT_NODES) {
			sampled = true;
			skip(depth > MAX_FINGERPRINT_DEPTH ? "depth" : "nodes");
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
			skip("unsupported");
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
			skip("unsupported");
			return;
		}
		if (typeof value !== "object") return;
		if (seen.has(value)) {
			skip("unsupported");
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
				if (!comparable) break;
				if (nodes >= MAX_FINGERPRINT_NODES) {
					sampled = true;
					skip("nodes");
					break;
				}
				visit(value[index], depth + 1);
			}
			updateText("]");
			return;
		}
		if (!isPlainRecord(value)) {
			sampled = true;
			skip("unsupported");
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
				skip(nodes + keys.length >= MAX_FINGERPRINT_NODES ? "nodes" : "work");
				break;
			}
			keys.push(key);
			pendingKeyChars += key.length;
		}
		keys.sort();
		updateText(`object:${keys.length}${comparable ? "" : "+"}{`);
		for (const key of keys) {
			if (!comparable) break;
			updateText(`key:`);
			hashString(key);
			visit(record[key], depth + 1);
		}
		updateText("}");
	}

	try {
		visit(payload, 0);
		return { hash: comparable ? hash.digest("hex") : "", sampled, comparable, skipReason };
	} catch {
		return { hash: "", sampled, comparable: false, skipReason: "error" };
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
		unknownNestedUsage: 0,
		missingNestedUsage: 0,
		zeroNestedUsage: 0,
		fingerprintSkips: emptyFingerprintSkips(),
		nativeWorkflowCapacityGap: false,
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

/** 只取自有数据字段，不执行未知 payload 的 getter；异常结构保持未知，不能干扰请求发送。 */
function evidenceField(value: unknown, key: string): unknown {
	if (!isRecord(value)) return undefined;
	try {
		return Object.getOwnPropertyDescriptor(value, key)?.value;
	} catch {
		return undefined;
	}
}

/** 保留有界模型或档位标识，不截断成另一个有效名称，也不保存控制字符。 */
function evidenceText(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
		? value : null;
}

/** 保存处理器此刻可见的请求标量和客户端选择；后续扩展仍可能改写 payload，不能视作供应商确认。 */
function requestModelEvidence(ctx: ExtensionContext, payload?: unknown): RequestModelEvidence {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	const reasoning = evidenceField(payload, "reasoning");
	const outputConfig = evidenceField(payload, "output_config");
	return {
		observedAtMs: Date.now(),
		requested: {
			source: payload === undefined ? "unobserved" : "before_provider_request",
			model: evidenceText(evidenceField(payload, "model")),
			thinkingLevel: evidenceText(evidenceField(reasoning, "effort")) ??
				evidenceText(evidenceField(payload, "reasoning_effort")) ?? evidenceText(evidenceField(outputConfig, "effort")),
		},
		clientResolved: {
			provider: evidenceText(model?.provider), model: evidenceText(model?.id), thinkingLevel: evidenceText(ctx.thinkingLevel),
		},
	};
}

/** 分离客户端记录与供应商证据；SDK 可自行填写 model 和 providerThinkingLevel，缺失确认时保持 null。 */
function responseModelEvidence(ctx: ExtensionContext, metadata: AssistantMetadata, request?: RequestModelEvidence): ModelEvidence {
	const api = evidenceText(metadata.api);
	// 已核对 SDK：completions 仅把服务端不同名模型存入 responseModel；Anthropic 收到 message_start 后覆盖 model。
	const explicitModel = api === "openai-completions" ? evidenceText(metadata.responseModel) : null;
	const anthropicModel = api === "anthropic-messages" && evidenceText(metadata.responseId) ? evidenceText(metadata.model) : null;
	return {
		...(request ?? requestModelEvidence(ctx)),
		responseRecord: { api, model: evidenceText(metadata.model), providerThinkingLevel: evidenceText(metadata.providerThinkingLevel) },
		providerConfirmed: {
			model: explicitModel ?? anthropicModel,
			// providerThinkingLevel 在 Anthropic SDK 来自 options.effort，不能仅凭这个字段证明服务端采用了该档位。
			thinkingLevel: null,
			modelSource: explicitModel ? "responseModel" : anthropicModel ? "anthropic.message_start.model" : null,
		},
	};
}

/** 仅为缓存和 Token 异常选择可比较的内部键；回退值不能作为供应商实际模型或推理档位展示。 */
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
	let observationStartedAt = Date.now();
	let observationStartReason: ObservationStartReason = "extension-load";
	let currentOperation: OperationState | undefined;
	let lastOperation: OperationState | undefined;
	let previousSample: UsageSample | undefined;
	let boundary = 0;
	const sharedState = getSharedState();
	let sessionMainUsage = emptyUsage();
	let sessionAuxiliaryUsage = emptyUsage();
	let idleAuxiliaryUsage = emptyUsage();
	let sessionNestedUsage = emptyUsage();
	let sessionValidUsageReports = 0;
	let sessionZeroUsageReports = 0;
	let sessionMissingUsageReports = 0;
	let sessionProviderRequests = 0;
	let sessionProviderResponses = 0;
	let sessionObservedHttpFailures = 0;
	let sessionCompactions = 0;
	let sessionAnomalyCount = 0;
	let sessionUnknownNestedUsage = 0;
	let sessionMissingNestedUsage = 0;
	let sessionZeroNestedUsage = 0;
	let sessionFingerprintSkips = emptyFingerprintSkips();
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
	let pendingTreeOldLeafId: string | null | undefined;
	// 也跟踪普通导航，避免其他扩展主动提供摘要时丢失其用量；只有预期摘要计入待决下界。
	const identifiedTreeSummaries = new Map<string, { owner: OperationState | undefined; expectsUsage: boolean }>();
	let identifiedTreeStarts = 0;
	let identifiedTreeSettlements = 0;
	let identifiedTreeCapacitySkips = 0;
	let recentAnomalies: Anomaly[] = [];
	let idleAnomalies: Anomaly[] = [];
	let nativeContext: ExtensionContext | undefined;
	let nativeEnabled = false;
	let nativeCompactionCoverageVersion: number | undefined;
	let nativeObservedSince = 0;
	let nativeStats = emptyNativeObserverStats();
	let nativePoolUsage = emptyUsage();
	let nativeExcludedPreWindowPoolUsage = emptyUsage();
	let nativeUnscopedPoolUsage = emptyUsage();
	let nativePoolBaseline: NativePoolBaseline | undefined;
	let nativeObservedUsage = emptyUsage();
	const nativeWorkflowIds = new Set<string>();
	const nativeAgents = new Map<string, NativeAgentObservation>();
	const nativeToolCalls = new Map<string, NativeToolObservation>();
	let nativeUnsubscribers: Array<() => void> = [];

	/** 读取原生包公开的定向查询接口；不枚举记录，也不改变包的上报开关。 */
	function nativeRegistry(): NativeRegistry | undefined {
		const value = (globalThis as Record<symbol, unknown>)[NATIVE_SUBAGENT_MANAGER_KEY];
		if (value !== undefined) nativeEnabled = true;
		nativeCompactionCoverageVersion = isRecord(value) && typeof value.compactionCoverageVersion === "number"
			? value.compactionCoverageVersion : undefined;
		return isRecord(value) && typeof value.getRecord === "function"
			? value as unknown as NativeRegistry : undefined;
	}

	/** 使用工具相同的只读引用解析；旧插件保留原值待查询结果补齐，不把别名解析失败视为模型消耗。 */
	function resolveNativeReference(reference: string): string | undefined {
		try {
			const registry = nativeRegistry();
			const id = typeof registry?.resolveReference === "function" ? registry.resolveReference(reference) : reference;
			return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
		} catch {
			nativeStats.readFailures++;
			return undefined;
		}
	}

	/** 在观察窗口或 registry 实例变化时只读保存待排池基线；重复 reset 替换快照，不累计历史抵扣。 */
	function captureNativePoolBaseline(registry: NativeRegistry): void {
		const baseline: NativePoolBaseline = { registry };
		try {
			const snapshot = registry.getUsagePoolSnapshot?.();
			if (isRecord(snapshot) && typeof snapshot.generation === "number" && Number.isSafeInteger(snapshot.generation) && snapshot.generation >= 0) {
				baseline.generation = snapshot.generation;
				baseline.usage = normalizeUsage(snapshot.usage);
			}
		} catch { nativeStats.readFailures++; }
		nativePoolBaseline = baseline;
	}

	/** 按具体 drain 代际剔除窗口之前的池余额；不猜首次上报，也不把旧实例余额抵到新实例。 */
	function recordNativePoolUsage(registry: NativeRegistry | undefined, usage: MeterUsage, details: unknown): void {
		const generation = isRecord(details) ? details.usagePoolGeneration : undefined;
		const baseline = nativePoolBaseline;
		if (!registry || baseline?.registry !== registry || baseline.generation === undefined || !baseline.usage ||
			typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
			addUsage(nativeUnscopedPoolUsage, usage);
			if (hasMeaningfulUsage(usage)) nativeStats.poolWindowCoverageGaps = 1;
			return;
		}
		// 已在窗口开始前 drain 的迟到结果全部属于旧窗口；下一代仅扣当时仍待排的部分。
		if (generation <= baseline.generation) { addUsage(nativeExcludedPreWindowPoolUsage, usage); return; }
		if (generation !== baseline.generation + 1) { addUsage(nativePoolUsage, usage); return; }
		const remaining = { ...usage };
		const excluded = emptyUsage();
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "cost"] as const) {
			excluded[key] = Math.min(usage[key], baseline.usage[key]);
			remaining[key] = Math.max(0, usage[key] - excluded[key]);
		}
		excluded.totalTokens = excluded.input + excluded.output + excluded.cacheRead + excluded.cacheWrite;
		remaining.totalTokens = remaining.input + remaining.output + remaining.cacheRead + remaining.cacheWrite;
		if (hasMeaningfulUsage(excluded)) { excluded.reports = 1; addUsage(nativeExcludedPreWindowPoolUsage, excluded); }
		if (hasMeaningfulUsage(remaining)) addUsage(nativePoolUsage, remaining);
	}

	/** 将无法闭环的原生调用记为用量缺口；后台缺口始终归属发起任务。 */
	function noteNativeGap(owner: OperationState | undefined, count = 1): void {
		nativeStats.unknownReports += count;
		recordUnknownNestedUsage(owner, "missing", count);
	}

	/** 仅提取指定顶层记录的数值用量和状态，不保存 record 中的提示词、结果或异常文本。 */
	function readNativeRecord(id: string): NativeRecordSnapshot | undefined {
		if (id.length > 256) { nativeStats.capacitySkips++; return undefined; }
		try {
			const registry = nativeRegistry();
			const record = registry?.getRecord(id);
			if (!isRecord(record)) return undefined;
			const raw = record.lifetimeUsage;
			const usage = isRecord(raw) ? normalizeUsage({
				input: raw.input, output: raw.output, cacheRead: raw.cacheRead ?? 0,
				cacheWrite: raw.cacheWrite, cost: { total: raw.cost ?? 0 },
			}) : undefined;
			return { status: typeof record.status === "string" ? record.status : "unknown",
				startedAt: typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : undefined,
				usage, compactions: nonNegativeNumber(record.compactionCount),
				descendantCompactions: registry?.compactionCoverageVersion === 1 &&
					typeof record.descendantCompactionCount === "number" && Number.isSafeInteger(record.descendantCompactionCount) && record.descendantCompactionCount >= 0
					? record.descendantCompactionCount : undefined };
		} catch {
			nativeStats.readFailures++;
			return undefined;
		}
	}

	/** 判断已证实的运行状态；queued 同样可能在主任务结束后继续执行。 */
	function nativeIsPending(status: string): boolean {
		return status === "queued" || status === "running";
	}

	/** 维护有界累计基线；只淘汰已结算记录，重新遇到旧 ID 时由调用前快照建立新基线。 */
	function createNativeObservation(id: string, owner: OperationState | undefined, usage: MeterUsage, compactions: number, descendantCompactions?: number, reportCapacityGap = true): NativeAgentObservation | undefined {
		if (id.length > 256 || nativeAgents.size >= MAX_NATIVE_AGENTS) {
			const settled = [...nativeAgents].find(([, item]) => !item.pending);
			if (id.length <= 256 && settled) {
				stopNativeQueryResponses(settled[1]);
				nativeAgents.delete(settled[0]);
				nativeStats.evictions++;
			}
			else {
				nativeStats.capacitySkips++;
				if (reportCapacityGap) noteNativeGap(owner);
				return undefined;
			}
		}
		const observation = { usage, owner, pending: false, gapReported: false, compactions, descendantCompactions,
			descendantCoverageGapReported: false, queryOnlyRun: false, queryAssistantResponses: 0 };
		nativeAgents.set(id, observation);
		return observation;
	}

	/** 为运行保存来源和发起窗口；真实启动会退出只读查询模式，重复观察不会抢走后台运行归属。 */
	function beginNativeRun(observation: NativeAgentObservation, owner: OperationState | undefined, queryOnlyRun = false): void {
		if (!queryOnlyRun && observation.queryOnlyRun) {
			observation.queryOnlyRun = false;
			stopNativeQueryResponses(observation);
		}
		if (observation.pending) return;
		stopNativeQueryResponses(observation);
		observation.owner = owner;
		observation.pending = true;
		observation.queryOnlyRun = queryOnlyRun;
		observation.queryAssistantResponses = 0;
		observation.gapReported = false;
		observation.descendantCoverageGapReported = false;
		nativeStats.starts++;
		if (observation.descendantCompactions === undefined) noteNativeDescendantCoverageGap(observation);
	}

	/** 解除本扩展添加的查询响应监听；先清除句柄，使迟到回调也不能继续记账。 */
	function stopNativeQueryResponses(observation: NativeAgentObservation): void {
		const unsubscribe = observation.unsubscribeQueryResponses;
		if (!unsubscribe) return;
		observation.unsubscribeQueryResponses = undefined;
		nativeStats.activeQueryResponseSubscriptions--;
		try { unsubscribe(); } catch { nativeStats.readFailures++; }
	}

	/** 仅为查询接管的运行观察后续 assistant 用量，不保存正文；无法订阅只标响应覆盖不足，不虚增模型调用。 */
	function subscribeNativeQueryResponses(id: string, observation: NativeAgentObservation): void {
		try {
			const record = nativeRegistry()?.getRecord(id);
			const session = isRecord(record) ? record.session : undefined;
			if (isRecord(session) && typeof session.subscribe === "function") {
				const unsubscribe: unknown = session.subscribe((event: unknown) => {
					if (!observation.pending || !observation.queryOnlyRun || !observation.unsubscribeQueryResponses) return;
					if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return;
					observation.queryAssistantResponses++;
					try {
						const usage = normalizeUsage(event.message.usage);
						if (!usage || !hasMeaningfulUsage(usage)) noteNativeRunGap(observation);
					} catch {
						nativeStats.readFailures++;
						noteNativeRunGap(observation);
					}
				});
				if (typeof unsubscribe === "function") {
					observation.unsubscribeQueryResponses = unsubscribe as () => void;
					nativeStats.activeQueryResponseSubscriptions++;
					return;
				}
			}
		} catch { nativeStats.readFailures++; }
		nativeStats.queryResponseCoverageGaps++;
	}

	/** 只为正在观察的运行标记一次递归压缩能力缺口；查询旧终态不能制造新的未知调用。 */
	function noteNativeDescendantCoverageGap(observation: NativeAgentObservation): void {
		if (!observation.pending || observation.descendantCoverageGapReported) return;
		observation.descendantCoverageGapReported = true;
		nativeStats.descendantCoverageGaps++;
		noteNativeRunGap(observation);
	}

	/** 每次运行的同一覆盖缺口只计一次，避免状态查询重复制造未知调用。 */
	function noteNativeRunGap(observation: NativeAgentObservation): void {
		if (observation.gapReported) return;
		observation.gapReported = true;
		noteNativeGap(observation.owner);
	}

	/** 自身与后代压缩分别按累计高水位差分；无精确 usage 只标未知，不换算或重复累计 Token。 */
	function observeNativeCompactions(observation: NativeAgentObservation, count: number, descendantCount?: number): void {
		if (count > observation.compactions) {
			const missing = count - observation.compactions;
			observation.compactions = count;
			nativeStats.compactionsWithoutUsage += missing;
			noteNativeGap(observation.owner, missing);
		}
		if (descendantCount === undefined) {
			noteNativeDescendantCoverageGap(observation);
			return;
		}
		if (observation.descendantCompactions === undefined) {
			// 运行中才获得能力时无法区分历史压缩，先保留覆盖缺口，再从当前累计建立基线。
			noteNativeDescendantCoverageGap(observation);
			observation.descendantCompactions = descendantCount;
			return;
		}
		if (descendantCount < observation.descendantCompactions) noteNativeDescendantCoverageGap(observation);
		if (descendantCount <= observation.descendantCompactions) return;
		const missing = descendantCount - observation.descendantCompactions;
		observation.descendantCompactions = descendantCount;
		nativeStats.compactionsWithoutUsage += missing;
		nativeStats.descendantCompactionsWithoutUsage += missing;
		noteNativeGap(observation.owner, missing);
	}

	/** 终态累计做非负差分；只记顶层含后代汇总，重复事件、查询和前台恢复都不会重复加账。 */
	function settleNativeRecord(id: string, record: NativeRecordSnapshot, ctx: ExtensionContext): void {
		const observation = nativeAgents.get(id);
		if (!observation) return;
		observeNativeCompactions(observation, record.compactions, record.descendantCompactions);
		if (nativeIsPending(record.status)) return;
		const wasPending = observation.pending;
		observation.pending = false;
		stopNativeQueryResponses(observation);
		if (wasPending) nativeStats.settlements++;
		// 累计中已有成功请求，仍不能证明失败请求的用量已上报；保留已知消耗并标记本轮覆盖缺口。
		if (wasPending && ["error", "aborted", "stopped", "failed", "unknown"].includes(record.status)) {
			noteNativeRunGap(observation);
		}
		const usage = record.usage;
		if (!usage) {
			noteNativeRunGap(observation);
			renderStatus(ctx);
			return;
		}
		const delta = emptyUsage();
		const highWater = { ...usage };
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
			if (usage[key] < observation.usage[key]) noteNativeRunGap(observation);
			delta[key] = Math.max(0, usage[key] - observation.usage[key]);
			// 异常回退后仍保留已记账高水位，下一次记录恢复不能再次计入同一批消耗。
			highWater[key] = Math.max(usage[key], observation.usage[key]);
		}
		delta.totalTokens = delta.input + delta.output + delta.cacheRead + delta.cacheWrite;
		highWater.totalTokens = highWater.input + highWater.output + highWater.cacheRead + highWater.cacheWrite;
		observation.usage = highWater;
		if (delta.totalTokens > 0 || delta.cost > 0) {
			delta.reports = 1;
			addUsage(nativeObservedUsage, delta);
			if (observation.owner) addUsage(observation.owner.nestedUsage, delta);
			addUsage(sessionNestedUsage, delta);
			if (observation.owner) evaluateOperationBudgets(ctx, observation.owner);
		} else if (wasPending && (!observation.queryOnlyRun || observation.queryAssistantResponses > 0)) {
			// 真实启动或观察到新响应却无增量仍是缺口；纯查询可能只赶上最后一次响应之后的正常收尾。
			noteNativeRunGap(observation);
		}
		renderStatus(ctx);
	}

	/** 统计尚未结算的原生后台调用，使任务结束后及后续任务仍能看到会话下界。 */
	function nativePendingCount(owner?: OperationState): number {
		let count = 0;
		for (const observation of nativeAgents.values()) {
			if (observation.pending && (!owner || observation.owner === owner)) count++;
		}
		return count;
	}

	/** 池可能包含 workflow 等不可见来源；只计算尚未被原生累计覆盖的正差，不把它再次加入账本。 */
	function nativePoolDifference() {
		const input = Math.max(0, nativePoolUsage.input - nativeObservedUsage.input);
		const output = Math.max(0, nativePoolUsage.output - nativeObservedUsage.output);
		const cacheRead = Math.max(0, nativePoolUsage.cacheRead - nativeObservedUsage.cacheRead);
		const cacheWrite = Math.max(0, nativePoolUsage.cacheWrite - nativeObservedUsage.cacheWrite);
		const costDelta = nativePoolUsage.cost - nativeObservedUsage.cost;
		// 聚合顺序可能产生浮点尾差；reasoning 已包含在 output 中，不再单独求差或相加。
		const cost = costDelta > 1e-9 ? costDelta : 0;
		return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost };
	}

	/** 无法把池残差可靠分配给发起任务，因此只给会话标记动态下界，迟到结算追平后自动解除。 */
	function nativePoolHasGap(): boolean {
		const difference = nativePoolDifference();
		return difference.totalTokens > 0 || difference.cost > 0;
	}

	/** 成功启动的 workflow 没有公开精确用量，按有界 taskId 去重标记未知，不解析展示总量。 */
	function recordWorkflowCoverage(message: { toolName?: string; usage?: unknown; details?: unknown }, owner: OperationState): boolean {
		if (message.toolName !== "SubagentWorkflow" || !isRecord(message.details) ||
			typeof message.details.taskId !== "string" || message.details.taskId.length === 0) return false;
		const reported = normalizeUsage(message.usage);
		if (reported && hasMeaningfulUsage(reported)) return false;
		const id = message.details.taskId;
		if (nativeWorkflowIds.has(id)) return true;
		if (id.length > 256 || nativeWorkflowIds.size >= MAX_NATIVE_AGENTS) {
			nativeStats.capacitySkips++;
			owner.nativeWorkflowCapacityGap = true;
			// 容量满后不淘汰旧 ID 再假装首次出现；会话只保留一次永久覆盖缺口。
			if (nativeStats.workflowCapacityExceeded === 0) {
				nativeStats.workflowCapacityExceeded = 1;
				noteNativeGap(undefined);
			}
			return true;
		}
		nativeWorkflowIds.add(id);
		nativeStats.unmeteredWorkflowRuns++;
		noteNativeGap(owner);
		return true;
	}

	/** 只解绑本扩展的监听并清空本会话观察状态，不触碰原生包管理器或其他扩展。 */
	function stopNativeObservation(): void {
		for (const unsubscribe of nativeUnsubscribers) unsubscribe();
		nativeUnsubscribers = [];
		for (const observation of nativeAgents.values()) stopNativeQueryResponses(observation);
		nativeAgents.clear();
		nativeToolCalls.clear();
		nativeStats = emptyNativeObserverStats();
		nativePoolUsage = emptyUsage();
		nativeExcludedPreWindowPoolUsage = emptyUsage();
		nativeUnscopedPoolUsage = emptyUsage();
		nativePoolBaseline = undefined;
		nativeObservedUsage = emptyUsage();
		nativeWorkflowIds.clear();
		nativeEnabled = false;
		nativeCompactionCoverageVersion = undefined;
		nativeObservedSince = 0;
		nativeContext = undefined;
	}

	/** 订阅公开顶层生命周期；前台 resume 的无事件路径由工具前后快照补齐。 */
	function startNativeObservation(ctx: ExtensionContext): void {
		nativeContext = ctx;
		const registry = nativeRegistry();
		if (registry && nativePoolBaseline?.registry !== registry) captureNativePoolBaseline(registry);
		if (nativeUnsubscribers.length > 0) return;
		nativeObservedSince = Date.now();
		// 每个通道只保存固定数量的回调，reset 后重新绑定，shutdown 后不再结算旧会话。
		for (const kind of ["started", "completed", "failed", "compacted"] as const) {
			nativeUnsubscribers.push(pi.events.on(`subagents:${kind}`, (event) => {
				if (!nativeContext || !isRecord(event) || typeof event.id !== "string") return;
				const record = readNativeRecord(event.id);
				if (!nativeEnabled) return;
				let observation = nativeAgents.get(event.id);
				// reset/切换会话后，旧运行的迟到事件不能重新记到新会话；显式查询接管的记录仍可继续观察。
				if (!observation && record?.startedAt !== undefined && record.startedAt < nativeObservedSince) return;
				if (kind === "started") {
					if (!record?.usage) { noteNativeGap(currentOperation); return; }
					observation ??= createNativeObservation(event.id, currentOperation, record.usage, record.compactions, record.descendantCompactions);
					if (observation) {
						beginNativeRun(observation, currentOperation);
						observeNativeCompactions(observation, record.compactions, record.descendantCompactions);
					}
				} else if (kind === "compacted") {
					if (observation) observeNativeCompactions(observation, nonNegativeNumber(event.compactionCount), record?.descendantCompactions);
					else noteNativeGap(currentOperation);
				} else {
					const finalRecord: NativeRecordSnapshot = record ?? { status: typeof event.status === "string" ? event.status : kind,
						usage: normalizeUsage(event.usage), compactions: observation?.compactions ?? 0 };
					if (observation) settleNativeRecord(event.id, finalRecord, nativeContext);
					else {
						// 缺少 started/调用前态时不能把未知历史累计当作本次增量。
						noteNativeGap(currentOperation);
						if (finalRecord.usage) createNativeObservation(event.id, currentOperation, finalRecord.usage, finalRecord.compactions, finalRecord.descendantCompactions);
					}
				}
				renderStatus(nativeContext);
			}));
		}
		// 后代压缩可能晚于父运行终态；覆盖更新只推进已观察代理的高水位，不能伪造新运行或模型用量。
		nativeUnsubscribers.push(pi.events.on("subagents:coverage_updated", (event) => {
			if (!nativeContext || !isRecord(event) || typeof event.id !== "string" || event.compactionCoverageVersion !== 1) return;
			const observation = nativeAgents.get(event.id);
			if (!observation) return;
			if (typeof event.compactionCount !== "number" || !Number.isSafeInteger(event.compactionCount) || event.compactionCount < 0 ||
				typeof event.descendantCompactionCount !== "number" || !Number.isSafeInteger(event.descendantCompactionCount) || event.descendantCompactionCount < 0) return;
			const record = readNativeRecord(event.id);
			observeNativeCompactions(observation, Math.max(record?.compactions ?? 0, event.compactionCount),
				Math.max(record?.descendantCompactions ?? 0, event.descendantCompactionCount));
			renderStatus(nativeContext);
		}));
	}

	/** 只读查询第一次遇到某个代理时从当前累计起观察；不把历史运行或查询本身计为当前任务消耗。 */
	function observeNativeQuery(id: string, record: NativeRecordSnapshot, ctx: ExtensionContext): void {
		let observation = nativeAgents.get(id);
		if (!record.usage) {
			if (observation) settleNativeRecord(id, record, ctx);
			return;
		}
		if (!observation) {
			observation = createNativeObservation(id, undefined, record.usage, record.compactions, record.descendantCompactions, false);
			if (!observation) return;
			nativeStats.queryBaselines++;
		}
		if (nativeIsPending(record.status)) {
			if (!observation.pending) {
				beginNativeRun(observation, undefined, true);
				subscribeNativeQueryResponses(id, observation);
			}
		} else settleNativeRecord(id, record, ctx);
	}

	/** 捕获规范 ID 与调用前累计；查询引用未解析只保留诊断，实际运行缺口由生命周期和结果结算。 */
	function captureNativeToolStart(ctx: ExtensionContext, toolCallId: string, toolName: string, args: unknown): void {
		if (!NATIVE_SUBAGENT_TOOLS.has(toolName)) return;
		startNativeObservation(ctx);
		if (!nativeEnabled) return;
		if (toolCallId.length > 256 || nativeToolCalls.size >= MAX_NATIVE_TOOL_CALLS) {
			nativeStats.capacitySkips++;
			if (toolName === "Agent") noteNativeGap(currentOperation);
			return;
		}
		const params = isRecord(args) ? args : {};
		const reference = toolName === "Agent" ? params.resume : params.agent_id;
		const runRequested = toolName === "Agent";
		const id = typeof reference === "string" && reference.length <= 256
			? runRequested ? reference : resolveNativeReference(reference) : undefined;
		const call: NativeToolObservation = { owner: currentOperation, id, runRequested,
			newAgent: toolName === "Agent" && reference === undefined, gapReported: false,
			evictionGeneration: nativeStats.evictions };
		nativeToolCalls.set(toolCallId, call);
		if (typeof reference === "string" && reference.length > 256) {
			nativeStats.capacitySkips++;
			if (runRequested) { noteNativeGap(call.owner); call.gapReported = true; }
			return;
		}
		if (!call.id) {
			if (!runRequested) nativeStats.unresolvedQueries++;
			return;
		}
		const record = readNativeRecord(call.id);
		if (!record?.usage) {
			if (!runRequested) nativeStats.unresolvedQueries++;
			return;
		}
		if (!runRequested) { observeNativeQuery(call.id, record, ctx); return; }
		let observation = nativeAgents.get(call.id);
		if (!observation) {
			observation = createNativeObservation(call.id, call.owner, record.usage, record.compactions, record.descendantCompactions);
			if (observation && nativeIsPending(record.status)) {
				beginNativeRun(observation, call.owner);
				noteNativeRunGap(observation);
			}
		}
		if (!observation) return;
		// 先结算可能迟到的上一轮，再把 resume 新增消耗交给当前窗口。
		if (!nativeIsPending(record.status)) settleNativeRecord(call.id, record, ctx);
		if (toolName === "Agent" || nativeIsPending(record.status)) beginNativeRun(observation, call.owner);
	}

	/** 原生工具以累计观察源计账；工具池仅作覆盖差额诊断，避免把重叠用量再次相加。 */
	function recordNativeToolResult(ctx: ExtensionContext, message: { toolName?: string; toolCallId?: string; usage?: unknown; details?: unknown }): boolean {
		if (!NATIVE_SUBAGENT_TOOLS.has(message.toolName ?? "")) return false;
		const registry = nativeRegistry();
		if (!nativeEnabled) return false;
		const poolUsage = normalizeUsage(message.usage);
		if (poolUsage) {
			nativeStats.ignoredPoolReports++;
			recordNativePoolUsage(registry, poolUsage, message.details);
		}
		const call = message.toolCallId ? nativeToolCalls.get(message.toolCallId) : undefined;
		if (message.toolCallId) nativeToolCalls.delete(message.toolCallId);
		const resultId = isRecord(message.details) && typeof message.details.agentId === "string" ? message.details.agentId : undefined;
		const id = resultId ?? call?.id;
		const owner = call ? call.owner : currentOperation;
		const record = id ? readNativeRecord(id) : undefined;
		if (!id || !record) {
			nativeStats.unmatchedTools++;
			// 引用未解析不直接证明执行过模型；查询、已观察运行和新代理结果缺失分别处理。
			const observed = id ? nativeAgents.get(id) : undefined;
			if (observed?.pending && !call?.gapReported) noteNativeRunGap(observed);
			else if (message.toolName === "Agent" && (!call || call.newAgent) && !call?.gapReported) {
				// 发起新代理却没有可核对结果仍是原有覆盖缺口；只读查询和未解析的续接引用不能套用它。
				noteNativeGap(owner);
			}
			return true;
		}
		if (message.toolName !== "Agent") { observeNativeQuery(id, record, ctx); return true; }
		let observation = nativeAgents.get(id);
		if (!observation) {
			// 调用期间发生过淘汰时，无法证明该 ID 从未计账；晚到结果只能建立当前基线，不能再次从零相加。
			const canStartFromZero = call?.newAgent && call.evictionGeneration === nativeStats.evictions;
			observation = createNativeObservation(id, owner, canStartFromZero ? emptyUsage() : record.usage ?? emptyUsage(),
				canStartFromZero ? 0 : record.compactions,
				canStartFromZero && record.descendantCompactions !== undefined ? 0 : record.descendantCompactions);
			if (!observation) return true;
			beginNativeRun(observation, owner);
			if (!canStartFromZero && !call?.gapReported) noteNativeRunGap(observation);
		} else if (nativeIsPending(record.status)) {
			beginNativeRun(observation, owner);
		}
		settleNativeRecord(id, record, ctx);
		return true;
	}

	/** 保证运行中的观察事件都归属同一任务窗口。 */
	function ensureOperation(): OperationState {
		currentOperation ??= createOperation();
		return currentOperation;
	}

	/** 开始新的观察窗口，不重建历史账本；普通对话轮次不调用这里，告警开关仍在进程内保留。 */
	function resetSessionState(reason: ObservationStartReason): void {
		stopNativeObservation();
		observationStartedAt = Date.now();
		observationStartReason = reason;
		currentOperation = undefined;
		lastOperation = undefined;
		previousSample = undefined;
		boundary = 0;
		sessionMainUsage = emptyUsage();
		sessionAuxiliaryUsage = emptyUsage();
		idleAuxiliaryUsage = emptyUsage();
		sessionNestedUsage = emptyUsage();
		sessionValidUsageReports = 0;
		sessionZeroUsageReports = 0;
		sessionMissingUsageReports = 0;
		sessionProviderRequests = 0;
		sessionProviderResponses = 0;
		sessionObservedHttpFailures = 0;
		sessionCompactions = 0;
		sessionAnomalyCount = 0;
		sessionUnknownNestedUsage = 0;
		sessionMissingNestedUsage = 0;
		sessionZeroNestedUsage = 0;
		sessionFingerprintSkips = emptyFingerprintSkips();
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
		pendingTreeOldLeafId = undefined;
		identifiedTreeSummaries.clear();
		identifiedTreeStarts = 0;
		identifiedTreeSettlements = 0;
		identifiedTreeCapacitySkips = 0;
		recentAnomalies = [];
		idleAnomalies = [];
	}

	/** 在模型或上下文结构发生合理变化后重置相对比较基线。 */
	function resetComparisonBoundary(): void {
		boundary++;
		previousSample = undefined;
		if (currentOperation) {
			currentOperation.highReasoningStreak = 0;
			currentOperation.previousCacheSample = undefined;
		}
	}

	/** 把未获有效用量的树摘要记为未知，始终归属发起任务或空闲阶段。 */
	function recordUnknownTreeUsage(owner: OperationState | undefined): void {
		if (owner) {
			owner.unknownAuxiliaryUsage++;
			owner.missingTreeUsage++;
		} else {
			idleUnknownAuxiliaryUsage++;
		}
		sessionUnknownAuxiliaryUsage++;
		sessionMissingTreeUsage++;
	}

	/** 旧版 Pi 没有终止事件；下次导航时将仍未结束的旧关联记为未知。 */
	function settlePendingTreeAsUnknown(): void {
		if (!pendingTreeSummary) return;
		recordUnknownTreeUsage(pendingTreeOperation);
		clearPendingTree();
	}

	/** 仅接受有界的导航 ID；旧 Pi 事件没有 ID 时继续使用旧叶节点关联。 */
	function treeNavigationId(event: unknown): string | undefined {
		if (!isRecord(event) || typeof event.navigationId !== "string") return undefined;
		return event.navigationId.length > 0 && event.navigationId.length <= 128 ? event.navigationId : undefined;
	}

	/** 合并新旧事件的待决数量；默认取会话，idle 只取空闲阶段，任务对象只取对应归属。 */
	function pendingTreeCount(scope?: OperationState | "idle"): number {
		// undefined 表示统计全会话，idle 单独区分没有任务归属的摘要。
		const matches = (owner: OperationState | undefined) => scope === undefined || (scope === "idle" ? owner === undefined : owner === scope);
		let count = pendingTreeSummary && matches(pendingTreeOperation) ? 1 : 0;
		for (const item of identifiedTreeSummaries.values()) if (item.expectsUsage && matches(item.owner)) count++;
		return count;
	}

	/** 将已上报树摘要用量记入原任务和会话；没有有效上报时只标记未知，不伪造零消耗。 */
	function recordTreeSummaryUsage(ctx: ExtensionContext, owner: OperationState | undefined, value: unknown): void {
		const usage = normalizeUsage(value);
		if (usage && hasMeaningfulUsage(usage)) {
			if (owner) addUsage(owner.auxiliaryUsage, usage);
			else addUsage(idleAuxiliaryUsage, usage);
			addUsage(sessionAuxiliaryUsage, usage);
			if (!owner) evaluateIdleAuxiliaryUsage(ctx, usage, "树导航摘要");
		} else {
			recordUnknownTreeUsage(owner);
		}
		if (owner) evaluateOperationBudgets(ctx, owner);
	}

	/** 清除已完成或已转为未知的树摘要关联，本函数本身不修改用量计数。 */
	function clearPendingTree(): void {
		pendingTreeSummary = false;
		pendingTreeOperation = undefined;
		pendingTreeOldLeafId = undefined;
	}

	/** 汇总任务中不能确认完整用量的调用，待决树摘要始终归属发起任务。 */
	function operationUnknownUsage(operation: OperationState): number {
		return operation.zeroUsageReports + operation.missingUsageReports + operation.unknownAuxiliaryUsage +
			operation.unknownNestedUsage + pendingTreeCount(operation) + nativePendingCount(operation) +
			(operation.nativeWorkflowCapacityGap ? 1 : 0);
	}

	/** 会话下界不随新任务开始而清除，避免后续正常请求掩盖历史缺失。 */
	function sessionUnknownUsage(): number {
		return sessionZeroUsageReports + sessionMissingUsageReports + sessionUnknownAuxiliaryUsage +
			sessionUnknownNestedUsage + pendingTreeCount() + nativePendingCount() + (nativePoolHasGap() ? 1 : 0);
	}

	/** 响应订阅缺失只表示证据不足，与已知发生但缺用量的调用数量分别保留。 */
	function sessionHasUsageGap(): boolean {
		return sessionUnknownUsage() > 0 || nativeStats.queryResponseCoverageGaps > 0 || nativeStats.poolWindowCoverageGaps > 0;
	}

	/** 为指定任务或空闲阶段记录异常；仅供轮末摘要和主动查询，过程中不发送通知。 */
	function addAnomaly(
		ctx: ExtensionContext, code: string, title: string, detail: string, severity: Severity,
		owner: OperationState | null | undefined = undefined, estimatedRequest?: number,
	): void {
		const operation = owner === null ? undefined : owner ?? currentOperation;
		const existing = operation?.anomalies.find((item) => item.code === code);
		if (existing) {
			// 最终用量只校准当前请求的估算记录，不改写更早请求的已确认异常。
			if (existing.estimatedRequest === operation?.assistantRequests && estimatedRequest === undefined) {
				Object.assign(existing, { title, detail: truncateDetail(detail), severity });
				delete existing.estimatedRequest;
			}
			return;
		}
		if (operation && operation.anomalies.length >= MAX_ANOMALIES) return;
		if (!operation && recentAnomalies.some((item) => item.code === code && Date.now() - item.timestamp < 60_000)) return;

		const anomaly: Anomaly = { code, title, detail: truncateDetail(detail), severity, timestamp: Date.now(), estimatedRequest };
		sessionAnomalyCount++;
		operation?.seenAnomalies.add(code);
		operation?.anomalies.push(anomaly);
		if (!operation) {
			idleAnomalies.push(anomaly);
			if (idleAnomalies.length > MAX_ANOMALIES) idleAnomalies = idleAnomalies.slice(-MAX_ANOMALIES);
		}
		recentAnomalies.push(anomaly);
		if (recentAnomalies.length > MAX_ANOMALIES) recentAnomalies = recentAnomalies.slice(-MAX_ANOMALIES);
		renderStatus(ctx);
	}

	/** 按当前流的字节数记录待校准异常，不在流式过程中提醒，也不加入精确用量。 */
	function evaluateStreamingUsage(ctx: ExtensionContext, operation: OperationState): void {
		const output = Math.ceil((operation.streamTextBytes + operation.streamReasoningBytes) / 4);
		const reasoning = Math.ceil(operation.streamReasoningBytes / 4);
		const requestIndex = operation.assistantRequests + 1;
		if (output >= OUTPUT_RUNAWAY_TOKENS * 2) {
			addAnomaly(ctx, "output-runaway", "单次输出估算偏大（待校准）",
				`当前输出约 ${formatTokens(output)} Token，包含文本、推理和工具参数；最终以供应商用量为准`,
				"warning", operation, requestIndex);
		}
		if (reasoning >= REASONING_RUNAWAY_TOKENS * 2 && !["high", "xhigh", "max"].includes(String(ctx.thinkingLevel))) {
			addAnomaly(ctx, "reasoning-runaway", "推理输出估算偏大（待校准）",
				`当前推理约 ${formatTokens(reasoning)} Token，最终以供应商用量为准`, "warning", operation, requestIndex);
		}
	}

	/** 按最终上报字段校准本轮估算；输出总量不能替代缺失的推理细分，推理豁免仍然生效。 */
	function settleStreamingAnomalies(operation: OperationState, usage: MeterUsage | undefined, thinkingLevel: string): void {
		const calibrated = Boolean(usage && hasMeaningfulUsage(usage));
		const thinkingExpected = ["high", "xhigh", "max"].includes(thinkingLevel);
		const estimates = operation.anomalies.filter((item) => item.estimatedRequest === operation.assistantRequests);
		for (const anomaly of estimates) {
			const isReasoning = anomaly.code === "reasoning-runaway";
			// 失败或取消不参与相对比较，但有效上报的绝对推理用量仍可确认本轮已有预警。
			if (isReasoning && calibrated && usage && usage.reasoningReports > 0 &&
				usage.reasoning >= REASONING_RUNAWAY_TOKENS * 2 && !thinkingExpected) {
				anomaly.title = "推理 Token 异常偏高";
				anomaly.detail = `thinking=${thinkingLevel}，本次推理 ${formatTokens(usage.reasoning)} / 输出 ${formatTokens(usage.output)}`;
				delete anomaly.estimatedRequest;
				continue;
			}
			// 推理是 output 的子集：总输出低于阈值足以否定估算，否则缺少细分时不能推断推理低于阈值。
			const missingReasoning = isReasoning && calibrated && usage && usage.reasoningReports === 0 &&
				usage.output >= REASONING_RUNAWAY_TOKENS * 2;
			if ((calibrated && !missingReasoning) || (isReasoning && thinkingExpected)) {
				operation.anomalies = operation.anomalies.filter((item) => item !== anomaly);
				recentAnomalies = recentAnomalies.filter((item) => item !== anomaly);
				sessionAnomalyCount--;
				operation.seenAnomalies.delete(anomaly.code);
			} else {
				anomaly.title = anomaly.title.replace("待校准", "未校准");
				const reason = missingReasoning ? "推理未上报，估算未校准" : "本次最终用量缺失或全零，估算无法校准";
				anomaly.detail = truncateDetail(`${anomaly.detail}；${reason}`);
				delete anomaly.estimatedRequest;
			}
		}
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
	function evaluateOperationBudgets(ctx: ExtensionContext, operation = currentOperation): void {
		if (!operation) return;
		if (operation.assistantRequests >= REQUEST_STORM_COUNT) {
			addAnomaly(
				ctx,
				"request-count",
				"请求轮次较多，请检查任务进展",
				`已观察到 ${operation.assistantRequests} 次 assistant 请求`,
				"warning", operation,
			);
		}
		const cumulativePrompt = promptTokens(operation.mainUsage);
		if (cumulativePrompt >= REQUEST_STORM_PROMPT_TOKENS) {
			addAnomaly(
				ctx,
				"cumulative-prompt",
				"任务累计提示 Token 异常偏高",
				`已累计处理 ${formatTokens(cumulativePrompt)} 提示 Token`,
				"warning", operation,
			);
		}
		const reportedTotal = operationReportedTokens(operation);
		if (reportedTotal >= OPERATION_TOTAL_TOKENS) {
			addAnomaly(
				ctx,
				"cumulative-total",
				"任务全口径 Token 异常偏高",
				`主模型、压缩和工具内模型共上报 ${formatTokens(reportedTotal)} Token`,
				"warning", operation,
			);
		}
		if (operation.nestedUsage.totalTokens >= NESTED_TOTAL_TOKENS) {
			addAnomaly(
				ctx,
				"cumulative-nested-usage",
				"工具内模型累计消耗异常偏高",
				`工具内模型已累计上报 ${formatTokens(operation.nestedUsage.totalTokens)} Token`,
				"warning", operation,
			);
		}
	}

	/** 空闲压缩和树摘要不归入上次任务；单次上报超大时仍记录异常。 */
	function evaluateIdleAuxiliaryUsage(ctx: ExtensionContext, usage: MeterUsage, source: string): void {
		if (usage.totalTokens < OPERATION_TOTAL_TOKENS) return;
		addAnomaly(
			ctx,
			"idle-auxiliary-total",
			"空闲辅助模型调用异常偏高",
			`${source} 单次上报 ${formatTokens(usage.totalTokens)} Token，未归入上次任务`,
			"warning", null,
		);
	}

	/** 状态栏只显示计量进度和覆盖范围，不在任务过程中展示异常图标或发送告警。 */
	function renderStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const sessionLowerBound = sessionHasUsageGap() ? " · 窗口下界" : "";
		const activeOperation = currentOperation;
		if (activeOperation) {
			const latest = activeOperation.samples.at(-1);
			const cache = latest && latest.promptTokens > 0 ? ` · 缓存 ${Math.round(cacheReadRate(latest) * 100)}%` : "";
			const recent = latest ? ` · 最近 ${formatTokens(latest.promptTokens)}` : "";
			const liveOutput = Math.ceil((activeOperation.streamTextBytes + activeOperation.streamReasoningBytes) / 4);
			const streaming = liveOutput > 0 ? ` · 当前输出估算~${formatTokens(liveOutput)}` : "";
			const lowerBound = operationUnknownUsage(activeOperation) > 0 ? " · 本次下界" : "";
			ctx.ui.setStatus(
				STATUS_ID,
				`Token · 本次已上报 ${formatTokens(operationReportedTokens(activeOperation))} · 请求 ${Math.max(activeOperation.providerRequests, activeOperation.assistantRequests)}${recent}${cache}${streaming}${lowerBound}${sessionLowerBound}`,
			);
			return;
		}
		if (idleAnomalies.length > 0 || idleUnknownAuxiliaryUsage > 0 || pendingTreeCount("idle") > 0) {
			ctx.ui.setStatus(
				STATUS_ID,
				`Token 空闲辅助 · 已上报 ${formatTokens(idleAuxiliaryUsage.totalTokens)}${idleUnknownAuxiliaryUsage > 0 || pendingTreeCount("idle") > 0 ? " · 下界" : ""}${sessionLowerBound}`,
			);
			return;
		}
		if (lastOperation) {
			const lowerBound = operationUnknownUsage(lastOperation) > 0 ? " · 上次下界" : "";
			ctx.ui.setStatus(STATUS_ID, `Token · 上次已上报 ${formatTokens(operationReportedTokens(lastOperation))}${lowerBound}${sessionLowerBound}`);
			return;
		}
		const sessionTotal = sessionMainUsage.totalTokens + sessionAuxiliaryUsage.totalTokens + sessionNestedUsage.totalTokens;
		ctx.ui.setStatus(
			STATUS_ID,
			`Token 待命${sessionTotal > 0 ? ` · 窗口已上报 ${formatTokens(sessionTotal)}` : ""}${sessionLowerBound}`,
		);
	}

	/** 汇总本轮已上报用量用于本地 UI；不修改账本，缓存读写只计入输入一次。 */
	function buildOperationSummary(operation: OperationState): string {
		const usage = emptyUsage();
		addUsage(usage, operation.mainUsage);
		addUsage(usage, operation.nestedUsage);
		addUsage(usage, operation.auxiliaryUsage);
		const lines = ["本轮用量（已上报）"];
		if (usage.reports > 0) {
			const inputTotal = promptTokens(usage);
			// Pi 的 input 已排除缓存读写；普通输入和输出单价不同，此合计不是账单金额。
			const nonCachedTokens = usage.input + usage.output;
			lines.push(
				`输入总量：${formatExactTokens(inputTotal)}`,
				`  缓存读取：${formatExactTokens(usage.cacheRead)}｜读取命中率 ${formatInputShare(usage.cacheRead, inputTotal)}`,
				`  缓存写入：${formatExactTokens(usage.cacheWrite)}｜写入占比 ${formatInputShare(usage.cacheWrite, inputTotal)}`,
				`  普通输入：${formatExactTokens(usage.input)}｜普通输入占比 ${formatInputShare(usage.input, inputTotal)}`,
			);
			const reasoning = usage.reasoningReports > 0
				? `（其中已上报推理 ${formatExactTokens(usage.reasoning)}${usage.reasoningReports < usage.reports ? "，部分调用未上报推理分项" : ""}）`
				: "";
			lines.push(
				`输出：${formatExactTokens(usage.output)}${reasoning}`,
				`非缓存用量：${formatExactTokens(nonCachedTokens)}（普通输入 ${formatExactTokens(usage.input)} + 输出 ${formatExactTokens(usage.output)}）`,
				`总用量：${formatExactTokens(usage.totalTokens)}`,
			);
			if (operation.nestedUsage.reports > 0 || operation.auxiliaryUsage.reports > 0) {
				lines.push(`已含分项：主模型 ${formatExactTokens(operation.mainUsage.totalTokens)} · 子代理 ${formatExactTokens(operation.nestedUsage.totalTokens)} · 压缩/摘要 ${formatExactTokens(operation.auxiliaryUsage.totalTokens)}`);
			}
			if (usage.totalTokens !== inputTotal + usage.output) {
				lines.push("数据差异：供应商上报总量与输入、输出分项之和不一致。");
			}
		} else {
			lines.push("供应商未上报有效用量，无法确定本轮 Token 数。");
		}
		const elapsedSeconds = Math.max(0, (operation.endedAt ?? Date.now()) - operation.startedAt) / 1_000;
		lines.push(`主模型响应 ${operation.assistantRequests} 次 · 耗时 ${elapsedSeconds.toFixed(1)} 秒`);
		if (operationUnknownUsage(operation) > 0) {
			// 后台完成不再插入第二条小结；精确账本仍可在 /request-meter 中查看后续结算。
			lines.push("统计下界：存在未上报或尚未结算的调用；后续结果可用 /request-meter 查看。");
		}
		if (sharedState.alertsEnabled && operation.anomalies.length > 0) {
			lines.push(`本轮检测记录 ${operation.anomalies.length} 项：${operation.anomalies.slice(0, 3).map((item) => item.title).join("、")}；详情见 /request-meter。`);
		}
		return lines.join("\n");
	}

	/** 清除本扩展的终端小结，避免新一轮或新观察窗口继续显示旧账本。 */
	function clearOperationSummary(ctx: ExtensionContext): void {
		if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget(SUMMARY_WIDGET_ID, undefined);
	}

	/** 终端小结使用独立区域防止其他扩展覆盖；RPC 继续发送原有通知，均不写入模型上下文。 */
	function showOperationSummary(ctx: ExtensionContext, operation: OperationState): void {
		if (!ctx.hasUI) return;
		const summary = buildOperationSummary(operation);
		if (ctx.mode === "tui") {
			// 工厂组件保留完整小结，避免字符串数组的十行上限截掉统计下界等末尾证据。
			ctx.ui.setWidget(SUMMARY_WIDGET_ID, () => new Text(summary, 1, 0), { placement: "aboveEditor" });
		} else {
			ctx.ui.notify(summary, "info");
		}
	}

	/** 将一次精确主模型用量转为样本，并运行只依赖数字的保守异常规则。 */
	function recordMainUsage(ctx: ExtensionContext, usage: MeterUsage, metadata: AssistantMetadata): void {
		const operation = ensureOperation();
		addUsage(operation.mainUsage, usage);
		addUsage(sessionMainUsage, usage);
		operation.validUsageReports++;
		sessionValidUsageReports++;
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
			modelEvidence: operation.lastModelEvidence ?? responseModelEvidence(ctx, metadata),
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

		const cacheBaseline = operation.previousCacheSample;
		const cacheComparable = canCompare && cacheBaseline && cacheBaseline.boundary === sample.boundary &&
			cacheBaseline.modelKey === sample.modelKey && cacheBaseline.thinkingLevel === sample.thinkingLevel &&
			sample.timestamp - cacheBaseline.timestamp >= 0 &&
			sample.timestamp - cacheBaseline.timestamp <= CACHE_COMPARISON_MAX_AGE_MS ? cacheBaseline : undefined;
		if (cacheComparable) {
			const previousCacheRate = cacheReadRate(cacheComparable);
			const currentCacheRate = cacheReadRate(sample);
			const previousUncached = cacheComparable.input + cacheComparable.cacheWrite;
			const currentUncached = sample.input + sample.cacheWrite;
			if (
				cacheComparable.promptTokens >= 20_000 &&
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

		if (canCompare) {
			previousSample = sample;
			// 缓存仅在同任务短时间内比较；提示词增长仍保留独立的跨任务样本。
			operation.previousCacheSample = sample;
		}
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
		message: { toolName?: string; toolCallId?: string; content?: unknown; usage?: unknown; details?: unknown },
	): void {
		const operation = ensureOperation();
		const toolName = truncateDetail(message.toolName ?? "unknown-tool", 100);
		const estimate = estimateToolContent(message.content);
		operation.estimatedToolTokens += estimate.tokens;
		sessionEstimatedToolTokens += estimate.tokens;
		recordEstimatedContributor(ctx, `工具 ${toolName}`, estimate.tokens, estimate.images, "large-tool-result");
		if (recordWorkflowCoverage(message, operation) || recordNativeToolResult(ctx, message)) {
			evaluateOperationBudgets(ctx);
			renderStatus(ctx);
			return;
		}

		const nestedUsage = normalizeUsage(message.usage);
		if (nestedUsage && hasMeaningfulUsage(nestedUsage)) {
			// 顶层有效用量是工具的权威汇总，不能再叠加 details 内的同一批子请求。
			addUsage(operation.nestedUsage, nestedUsage);
			addUsage(sessionNestedUsage, nestedUsage);
		} else if (
			message.toolName === "subagent" && isRecord(message.details) &&
			["single", "parallel", "chain"].includes(String(message.details.mode)) && Array.isArray(message.details.results)
		) {
			const results = message.details.results;
			for (let index = 0; index < Math.min(results.length, MAX_SUBAGENT_RESULTS); index++) {
				const result = results[index];
				const usage = normalizeSubagentUsage(isRecord(result) ? result.usage : undefined);
				if (usage && hasMeaningfulUsage(usage)) {
					addUsage(operation.nestedUsage, usage);
					addUsage(sessionNestedUsage, usage);
				} else {
					recordUnknownNestedUsage(operation, usage ? "zero" : "missing");
				}
			}
			// 官方校验失败时 results 为空，代表尚未启动子任务；超预算部分只能保守记为未知。
			if (results.length > MAX_SUBAGENT_RESULTS) {
				recordUnknownNestedUsage(operation, "missing", results.length - MAX_SUBAGENT_RESULTS);
			}
		} else if (message.usage !== undefined || NATIVE_SUBAGENT_TOOLS.has(message.toolName ?? "")) {
			// 普通工具仅在显式上报无效用量时记缺口；已识别原生工具缺少观察接口及 usage 时也不能假装零消耗。
			recordUnknownNestedUsage(operation, nestedUsage ? "zero" : "missing");
		}
		evaluateOperationBudgets(ctx);
		renderStatus(ctx);
	}

	/** 同步记录任务与会话的工具模型用量缺口，不把未知请求伪造为零消耗。 */
	function recordUnknownNestedUsage(operation: OperationState | undefined, kind: "missing" | "zero", count = 1): void {
		if (operation) operation.unknownNestedUsage += count;
		sessionUnknownNestedUsage += count;
		if (kind === "zero") {
			if (operation) operation.zeroNestedUsage += count;
			sessionZeroNestedUsage += count;
		} else {
			if (operation) operation.missingNestedUsage += count;
			sessionMissingNestedUsage += count;
		}
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

	/** 复制供应商与工具上报的数字账本；工具文本和流式估算不参与精确总量。 */
	function usageSnapshot(main: MeterUsage, auxiliary: MeterUsage, nested: MeterUsage) {
		return {
			main: { ...main },
			auxiliary: { ...auxiliary },
			nested: { ...nested },
			reportedTotalTokens: main.totalTokens + auxiliary.totalTokens + nested.totalTokens,
			reportedTotalCost: main.cost + auxiliary.cost + nested.cost,
		};
	}

	/** 仅导出固定原因的指纹覆盖计数，不暴露请求内容或请求指纹。 */
	function fingerprintCoverageSnapshot(observedRequests: number, skipsByReason: FingerprintSkipCounts) {
		const skippedRequests = Object.values(skipsByReason).reduce((total, count) => total + count, 0);
		return {
			observedRequests,
			comparableRequests: observedRequests - skippedRequests,
			skippedRequests,
			skipsByReason: { ...skipsByReason },
		};
	}

	/** 输出已记录异常的数量及有界标识，不包含可能引用供应商错误原文的详细描述。 */
	function anomalySnapshot(anomalies: Anomaly[], count = anomalies.length) {
		return {
			count,
			retainedCount: anomalies.length,
			items: anomalies.map((anomaly) => ({
				code: anomaly.code,
				severity: anomaly.severity,
				timestamp: anomaly.timestamp,
				estimatedRequest: anomaly.estimatedRequest ?? null,
			})),
		};
	}

	/** 构造只读、固定版本的精确快照；无任务时保留零值结构，不创建任务或改变统计状态。 */
	function buildJsonSnapshot() {
		const operation = currentOperation ?? lastOperation;
		const zeroUsage = emptyUsage();
		const operationUnknown = operation ? operationUnknownUsage(operation) : 0;
		const sessionUnknown = sessionUnknownUsage();
		return {
			schemaVersion: 1,
			exportedAtMs: Date.now(),
			operation: {
				state: currentOperation ? "running" : lastOperation ? "settled" : "none",
				startedAtMs: operation?.startedAt ?? null,
				endedAtMs: operation?.endedAt ?? null,
				wallTimeMs: operation ? Math.max(0, (operation.endedAt ?? Date.now()) - operation.startedAt) : 0,
				wallTimeScope: "main-agent-window",
				modelEvidence: operation?.lastModelEvidence ?? null,
				// 只导出有界的有效用量样本；缺失和全零响应仍由 counts/coverage 明确反映。
				retainedUsageSamples: (operation?.samples ?? []).map((sample) => ({
					requestIndex: sample.requestIndex, timestamp: sample.timestamp, modelEvidence: sample.modelEvidence,
					input: sample.input, output: sample.output, cacheRead: sample.cacheRead, cacheWrite: sample.cacheWrite,
					reasoning: sample.reasoningReports > 0 ? sample.reasoning : null, totalTokens: sample.totalTokens, estimatedCost: sample.cost,
				})),
				usage: usageSnapshot(operation?.mainUsage ?? zeroUsage, operation?.auxiliaryUsage ?? zeroUsage, operation?.nestedUsage ?? zeroUsage),
				counts: {
					assistantRequests: operation?.assistantRequests ?? 0,
					providerRequests: operation?.providerRequests ?? 0,
					providerResponses: operation?.providerResponses ?? 0,
					observedHttpFailures: operation?.observedHttpFailures ?? 0,
					compactionAttempts: operation?.compactionAttempts ?? 0,
					compactions: operation?.compactions ?? 0,
				},
				coverage: {
					validUsageReports: operation?.validUsageReports ?? 0,
					zeroUsageReports: operation?.zeroUsageReports ?? 0,
					missingUsageReports: operation?.missingUsageReports ?? 0,
					unknownAuxiliaryUsage: operation?.unknownAuxiliaryUsage ?? 0,
					unknownNestedUsage: operation?.unknownNestedUsage ?? 0,
					missingNestedUsage: operation?.missingNestedUsage ?? 0,
					zeroNestedUsage: operation?.zeroNestedUsage ?? 0,
					missingCompactionUsage: operation?.missingCompactionUsage ?? 0,
					missingTreeUsage: operation?.missingTreeUsage ?? 0,
					cancelledCompactions: operation?.cancelledCompactions ?? 0,
					pendingTreeSummaries: operation ? pendingTreeCount(operation) : 0,
					nativePendingAgents: operation ? nativePendingCount(operation) : 0,
					nativeWorkflowCapacityGap: operation?.nativeWorkflowCapacityGap ?? false,
					unknownUsage: operationUnknown,
					lowerBound: operationUnknown > 0,
				},
				fingerprintCoverage: fingerprintCoverageSnapshot(operation?.providerRequests ?? 0, operation?.fingerprintSkips ?? emptyFingerprintSkips()),
				anomalies: anomalySnapshot(operation?.anomalies ?? []),
			},
			session: {
				observationWindow: { startedAtMs: observationStartedAt, reason: observationStartReason,
					historyRebuilt: false, scope: "since-observation-start" },
				usage: usageSnapshot(sessionMainUsage, sessionAuxiliaryUsage, sessionNestedUsage),
				counts: {
					assistantRequests: sessionValidUsageReports + sessionZeroUsageReports + sessionMissingUsageReports,
					providerRequests: sessionProviderRequests,
					providerResponses: sessionProviderResponses,
					observedHttpFailures: sessionObservedHttpFailures,
					compactionAttempts: sessionCompactionAttempts,
					compactions: sessionCompactions,
				},
				coverage: {
					validUsageReports: sessionValidUsageReports,
					zeroUsageReports: sessionZeroUsageReports,
					missingUsageReports: sessionMissingUsageReports,
					unknownAuxiliaryUsage: sessionUnknownAuxiliaryUsage,
					unknownNestedUsage: sessionUnknownNestedUsage,
					missingNestedUsage: sessionMissingNestedUsage,
					zeroNestedUsage: sessionZeroNestedUsage,
					missingCompactionUsage: sessionMissingCompactionUsage,
					missingTreeUsage: sessionMissingTreeUsage,
					cancelledCompactions: sessionCancelledCompactions,
					pendingTreeSummaries: pendingTreeCount(),
					nativePendingAgents: nativePendingCount(),
					nativePoolMismatch: nativePoolHasGap(),
					unknownUsage: sessionUnknown,
					nativeQueryResponseCoverageGaps: nativeStats.queryResponseCoverageGaps,
					nativePoolWindowCoverageGaps: nativeStats.poolWindowCoverageGaps,
					lowerBound: sessionHasUsageGap(),
				},
				fingerprintCoverage: fingerprintCoverageSnapshot(sessionProviderRequests, sessionFingerprintSkips),
				anomalies: anomalySnapshot(recentAnomalies, sessionAnomalyCount),
				nativeObserver: { enabled: nativeEnabled, trackedAgents: nativeAgents.size,
					compactionCoverageVersion: nativeCompactionCoverageVersion ?? null,
					pendingAgents: nativePendingCount(), trackedToolCalls: nativeToolCalls.size, ...nativeStats,
					poolUsage: { ...nativePoolUsage }, observedUsage: { ...nativeObservedUsage }, unmatchedPoolUsage: nativePoolDifference(),
					excludedPreWindowPoolUsage: { ...nativeExcludedPreWindowPoolUsage }, unscopedPoolUsage: { ...nativeUnscopedPoolUsage },
					poolBaselineGeneration: nativePoolBaseline?.generation ?? null },
				treeObserver: { identifiedStarts: identifiedTreeStarts, identifiedSettlements: identifiedTreeSettlements,
					trackedNavigations: identifiedTreeSummaries.size, capacitySkips: identifiedTreeCapacitySkips },
			},
		};
	}

	/** 生成不会进入模型上下文的会话报告，明确区分精确值与估算值。 */
	function buildReport(): string {
		const operation = currentOperation ?? lastOperation;
		const lines = ["Pi Request Meter"];
		if (!operation) {
			lines.push("当前观察窗口尚未观察到主模型请求。");
		} else {
			const elapsed = Math.max(0, (operation.endedAt ?? Date.now()) - operation.startedAt);
			const coverage = operation.assistantRequests > 0 ? (operation.validUsageReports / operation.assistantRequests) * 100 : 0;
			lines.push(
				`状态：${operation.anomalies.length > 0 ? `${operation.anomalies.length} 项异常` : currentOperation ? "监测中" : "正常"}`,
				`主代理墙钟窗口：${(elapsed / 1000).toFixed(1)} 秒（不累加并行代理耗时）· assistant ${operation.assistantRequests} 次 · provider hook ${operation.providerRequests} 次 · 可见 HTTP 响应 ${operation.providerResponses} 次`,
				`主模型用量完整度：${coverage.toFixed(0)}%（有效 ${operation.validUsageReports} / 全零 ${operation.zeroUsageReports} / 缺失 ${operation.missingUsageReports}）`,
				`本次用量覆盖：${operationUnknownUsage(operation) > 0 ? `下界，未知或待决 ${operationUnknownUsage(operation)} 次` : "已观察调用均有有效上报"}`,
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
			if (operation.unknownNestedUsage > 0) {
				lines.push(`工具内模型未知用量：${operation.unknownNestedUsage} 次（缺失 ${operation.missingNestedUsage} / 全零 ${operation.zeroNestedUsage}）`);
			}
			const skippedFingerprints = fingerprintSkipReport(operation.fingerprintSkips);
			if (skippedFingerprints) lines.push(`本次重复检测覆盖不足：${skippedFingerprints}；这些请求未参与重复比较`);
			if (
				operation.compactionAttempts > 0 ||
				operation.unknownAuxiliaryUsage > 0 ||
				pendingTreeCount(operation) > 0
			) {
				lines.push(
					`辅助调用：压缩尝试 ${operation.compactionAttempts} 次 · 成功 ${operation.compactions} 次 · 压缩缺失 ${operation.missingCompactionUsage} · 树摘要缺失 ${operation.missingTreeUsage} · 树摘要待决 ${pendingTreeCount(operation)} · 取消不确定 ${operation.cancelledCompactions}`,
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
						const evidence = sample.modelEvidence;
						return `- #${sample.requestIndex} 请求 ${evidence.requested.model ?? "未知"} / ${evidence.requested.thinkingLevel ?? "未知"} · 客户端 ${evidence.clientResolved.model ?? "未知"} / ${evidence.clientResolved.thinkingLevel ?? "未知"} · 供应商确认 ${evidence.providerConfirmed.model ?? "未知"} / ${evidence.providerConfirmed.thinkingLevel ?? "未知"} · 提示 ${formatTokens(sample.promptTokens)} · 缓存 ${Math.round(cacheReadRate(sample) * 100)}% · 输出 ${formatTokens(sample.output)} · 推理 ${reasoning} · ${sample.stopReason ?? "unknown"}`;
					}),
				);
			}
			if (operation.anomalies.length > 0) {
				lines.push("本次异常：", ...operation.anomalies.slice(-5).map((item) => `- ${item.title}：${item.detail}`));
			}
		}

		const sessionReports = sessionValidUsageReports + sessionZeroUsageReports + sessionMissingUsageReports;
		const sessionCoverage = sessionReports > 0 ? (sessionValidUsageReports / sessionReports) * 100 : 0;
		lines.push(
			`会话观察窗口：${new Date(observationStartedAt).toISOString()} 起 · 触发 ${observationStartReason}；仅累计此后观察到的事件，未重建历史账本。`,
			`观察窗口主模型用量完整度：${sessionCoverage.toFixed(0)}%（有效 ${sessionValidUsageReports} / 全零 ${sessionZeroUsageReports} / 缺失 ${sessionMissingUsageReports}）`,
			`观察窗口用量覆盖：${sessionHasUsageGap() ? `下界${sessionUnknownUsage() > 0 ? `，未知或待决 ${sessionUnknownUsage()} 次` : ""}${nativeStats.queryResponseCoverageGaps > 0 ? `，${nativeStats.queryResponseCoverageGaps} 个运行缺少后续响应覆盖证据` : ""}${nativeStats.poolWindowCoverageGaps > 0 ? "，工具池缺少观察窗口归属证据" : ""}` : "已观察调用均有有效上报"}`,
			usageReport("观察窗口主模型", sessionMainUsage),
		);
		if (sessionAuxiliaryUsage.reports > 0) lines.push(usageReport("观察窗口压缩/树摘要", sessionAuxiliaryUsage));
		if (sessionNestedUsage.reports > 0) lines.push(usageReport("观察窗口工具内模型（单独计）", sessionNestedUsage));
		if (sessionUnknownNestedUsage > 0) {
			lines.push(`观察窗口工具内模型未知用量：${sessionUnknownNestedUsage} 次（缺失 ${sessionMissingNestedUsage} / 全零 ${sessionZeroNestedUsage}）`);
		}
		const sessionSkippedFingerprints = fingerprintSkipReport(sessionFingerprintSkips);
		if (sessionSkippedFingerprints) lines.push(`观察窗口重复检测覆盖不足：${sessionSkippedFingerprints}；这些请求未参与重复比较`);
		lines.push(
			`观察窗口贡献估算：工具结果约 ${formatTokens(sessionEstimatedToolTokens)} · user bash 约 ${formatTokens(sessionEstimatedUserBashTokens)} Token`,
			`观察窗口辅助调用：压缩尝试 ${sessionCompactionAttempts} 次 · 压缩缺失 ${sessionMissingCompactionUsage} · 树摘要缺失 ${sessionMissingTreeUsage} · 树摘要待决 ${pendingTreeCount()} · 取消不确定 ${sessionCancelledCompactions} · 未知用量合计 ${sessionUnknownAuxiliaryUsage}`,
		);
		const historicalAnomalies = operation
			? recentAnomalies.filter((item) => !operation.anomalies.includes(item))
			: recentAnomalies;
		if (historicalAnomalies.length > 0) {
			lines.push("观察窗口其他已记录异常：", ...historicalAnomalies.slice(-5).map((item) => `- ${item.title}：${item.detail}`));
		} else if (!operation?.anomalies.length) {
			lines.push("异常：未发现达到保守阈值的行为");
		}
		lines.push(
			"模型证据：请求栏仅为发送前处理器所见的模型/档位，后续扩展仍可能改写；客户端值不是供应商确认，未返回的确认值为未知。",
			"边界：网络层失败可能不可见；其他扩展直接调用模型可能不经过 Agent 事件。",
			`轮末检测摘要：${sharedState.alertsEnabled ? "开启" : "关闭"}；过程中不自动通知`,
		);
		return lines.join("\n");
	}

	// 启动、重载、切换或恢复会话均重新观察；原因来自宿主事件，旧版本缺字段时明确标为通用开始。
	pi.on("session_start", async (event, ctx) => {
		clearOperationSummary(ctx);
		resetSessionState(["startup", "reload", "new", "resume", "fork"].includes(event.reason)
			? event.reason : "session-start");
		startNativeObservation(ctx);
		renderStatus(ctx);
	});

	// 多次 agent_start（重试、续跑）继续归入同一个 agent_settled 窗口。
	pi.on("agent_start", async (_event, ctx) => {
		startNativeObservation(ctx);
		if (!currentOperation) {
			clearOperationSummary(ctx);
			// 树摘要可能迟于原任务完成，保留待决摘要及各自发起归属，不能转记新任务。
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
		sessionProviderRequests++;
		operation.pendingRequestModel = requestModelEvidence(ctx, event.payload);
		const fingerprint = fingerprintPayload(event.payload);
		if (!fingerprint.comparable) {
			const reason = fingerprint.skipReason ?? "unsupported";
			operation.fingerprintSkips[reason]++;
			sessionFingerprintSkips[reason]++;
		}
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
		sessionProviderResponses++;
		if (event.status === 429 || event.status >= 500) {
			currentOperation.observedHttpFailures++;
			sessionObservedHttpFailures++;
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

	// 文本、推理和工具参数都计入输出估算；只加 delta，partial 和 end 的累计内容不能重复计数。
	pi.on("message_update", (event, ctx) => {
		const update = event.assistantMessageEvent as { type?: string; delta?: string };
		if (!["text_delta", "thinking_delta", "toolcall_delta"].includes(update.type ?? "") || typeof update.delta !== "string") return;
		const operation = ensureOperation();
		const bytes = Buffer.byteLength(update.delta, "utf8");
		if (update.type === "thinking_delta") operation.streamReasoningBytes += bytes;
		else operation.streamTextBytes += bytes;
		evaluateStreamingUsage(ctx, operation);
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
			api?: string;
			provider?: string;
			model?: string;
			responseModel?: string;
			responseId?: string;
			providerThinkingLevel?: string;
		};
		if (message.role !== "assistant") return;
		const operation = ensureOperation();
		operation.lastModelEvidence = responseModelEvidence(ctx, message, operation.pendingRequestModel);
		operation.pendingRequestModel = undefined;
		operation.assistantRequests++;
		operation.streamTextBytes = 0;
		operation.streamReasoningBytes = 0;
		const usage = normalizeUsage(message.usage);
		if (!usage) {
			operation.missingUsageReports++;
			sessionMissingUsageReports++;
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
			sessionZeroUsageReports++;
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
		settleStreamingAnomalies(operation, usage, comparisonKey(ctx, message).thinkingLevel);

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

	// 原生包的前台恢复没有 started/completed 事件，必须在执行前捕获累计基线及发起窗口。
	pi.on("tool_execution_start", (event, ctx) => {
		captureNativeToolStart(ctx, event.toolCallId, event.toolName, event.args);
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
		sessionCompactions++;
		if (operation) operation.compactions++;
		const compactEvent = event as { compactionEntry?: { usage?: unknown } };
		const usage = normalizeUsage(compactEvent.compactionEntry?.usage);
		if (usage && hasMeaningfulUsage(usage)) {
			if (operation) addUsage(operation.auxiliaryUsage, usage);
			else addUsage(idleAuxiliaryUsage, usage);
			addUsage(sessionAuxiliaryUsage, usage);
			if (!operation) evaluateIdleAuxiliaryUsage(ctx, usage, "上下文压缩");
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

	// 新 Pi 按 ID 保留每次导航的归属；旧 Pi 只保留一项旧叶节点关联。
	pi.on("session_before_tree", (event, ctx) => {
		settlePendingTreeAsUnknown();
		const expectsUsage = event.preparation.userWantsSummary && event.preparation.entriesToSummarize.length > 0;
		const navigationId = treeNavigationId(event);
		if (navigationId) {
			if (!identifiedTreeSummaries.has(navigationId)) {
				identifiedTreeStarts++;
				if (identifiedTreeSummaries.size < MAX_PENDING_TREE_SUMMARIES) {
					identifiedTreeSummaries.set(navigationId, { owner: currentOperation, expectsUsage });
				} else {
					// 不淘汰仍运行的摘要，容量外的结果不能可靠归属，只记录覆盖缺口。
					identifiedTreeCapacitySkips++;
					recordUnknownTreeUsage(currentOperation);
				}
			}
		} else if (expectsUsage) {
			pendingTreeSummary = true;
			pendingTreeOperation = currentOperation;
			pendingTreeOldLeafId = event.preparation.oldLeafId;
		}
		renderStatus(ctx);
	});

	// 树导航摘要同样是额外模型调用，若事件提供 usage 则单独计入辅助用量。
	pi.on("session_tree", (event, ctx) => {
		if (treeNavigationId(event)) {
			// 新协议统一由终止事件结算，成功导航事件只重置比较基线，避免同一用量相加两次。
			resetComparisonBoundary();
			return;
		}
		const treeEvent = event as { summaryEntry?: { usage?: unknown }; oldLeafId?: string | null };
		// 完成后的叶节点可能是新建摘要条目，不能与导航目标比较；仅用发起时的旧叶节点关联。
		const wasPending = pendingTreeSummary &&
			(pendingTreeOldLeafId === undefined || treeEvent.oldLeafId === undefined || pendingTreeOldLeafId === treeEvent.oldLeafId);
		// 没有请求 ID 时最多匹配一个待决摘要；明显不匹配的完成只记会话/空闲，不能污染新任务或清除待决项。
		const owner = wasPending ? pendingTreeOperation : undefined;
		const usage = normalizeUsage(treeEvent.summaryEntry?.usage);
		if (usage && hasMeaningfulUsage(usage)) {
			if (owner) addUsage(owner.auxiliaryUsage, usage);
			else addUsage(idleAuxiliaryUsage, usage);
			addUsage(sessionAuxiliaryUsage, usage);
			if (!owner) evaluateIdleAuxiliaryUsage(ctx, usage, "树导航摘要");
			if (wasPending) clearPendingTree();
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
		if (owner) evaluateOperationBudgets(ctx, owner);
		renderStatus(ctx);
	});

	// 旧 Pi 允许注册未知事件但不会发出；局部扩展类型让同一插件也能继续加载旧 SDK。
	const treeEvents = pi as ExtensionAPI & {
		on(event: "session_tree_end", handler: (event: { navigationId: string; summaryEntry?: { usage?: unknown } }, ctx: ExtensionContext) => void): void;
	};
	// 先删除 ID 再结算，重复结束事件、迟到的其他摘要和跨任务完成都不会串账。
	treeEvents.on("session_tree_end", (event, ctx) => {
		const navigationId = treeNavigationId(event);
		if (!navigationId) return;
		const pending = identifiedTreeSummaries.get(navigationId);
		if (!pending) return;
		identifiedTreeSummaries.delete(navigationId);
		identifiedTreeSettlements++;
		if (pending.expectsUsage || event.summaryEntry) {
			recordTreeSummaryUsage(ctx, pending.owner, event.summaryEntry?.usage);
		}
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

	// 重试、压缩及队列任务全部结束后结算一次；终端组件和 RPC 通知均不写入模型上下文。
	pi.on("agent_settled", async (_event, ctx) => {
		const operation = currentOperation;
		if (!operation) return;
		evaluateOperationBudgets(ctx);
		operation.endedAt = Date.now();
		lastOperation = operation;
		currentOperation = undefined;
		renderStatus(ctx);
		// 先封存窗口，避免重复 settled 再次输出；print/json 模式没有 UI，不污染其输出协议。
		showOperationSummary(ctx, operation);
	});

	// shutdown 清除自己的状态项和小结，不影响余额等其他扩展。
	pi.on("session_shutdown", async (_event, ctx) => {
		stopNativeObservation();
		currentOperation = undefined;
		clearOperationSummary(ctx);
		ctx.ui.setStatus(STATUS_ID, undefined);
	});

	pi.registerCommand("request-meter", {
		description: "查看 Token 用量、异常归因和监测边界；支持 json、reset、alerts on/off 轮末检测摘要",
		// 命令仅操作本地状态和 UI，不向模型发送消息。
		handler: async (args, ctx) => {
			const normalized = args.trim().toLowerCase();
			if (normalized === "json") {
				ctx.ui.notify(JSON.stringify(buildJsonSnapshot()), "info");
				return;
			}
			if (normalized === "reset") {
				clearOperationSummary(ctx);
				resetSessionState("manual-reset");
				startNativeObservation(ctx);
				renderStatus(ctx);
				ctx.ui.notify("Request Meter 已开始新的观察窗口；历史账本未重建", "info");
				return;
			}
			if (normalized === "alerts on" || normalized === "alerts off") {
				sharedState.alertsEnabled = normalized.endsWith("on");
				ctx.ui.notify(`Request Meter 轮末检测摘要已${sharedState.alertsEnabled ? "开启" : "关闭"}；用量小结仍显示，过程中不自动通知`, "info");
				return;
			}
			if (normalized) {
				ctx.ui.notify("用法：/request-meter [json | reset | alerts on | alerts off]", "warning");
				return;
			}
			ctx.ui.notify(buildReport(), recentAnomalies.some((item) => item.severity === "error") ? "error" : "info");
		},
	});
}
