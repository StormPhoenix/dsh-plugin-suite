import { createReadStream, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { BlockAssembler, ReasoningEffortId, createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { downloadArtifact } from "@electron/get";
import extract from "@electron-internal/extract-zip";
//#region .local/dsh-pet-windows/src/host/balance/internal.ts
/**
* 余额查询的**内部工具**（host 侧）：网络策略 + 响应校验 + 金额处理。
*
* 只给 ./providers/* 用。所有服务商共用同一套口径：
* - 网络：20s 超时 + 3 次重试（实测该环境对境外端点间歇性超时）；
* - 校验：必填字段缺失/非法一律 `throw`，**绝不静默当 0**（失败要显式暴露成 fetch-error）；
* - 可选字段：缺失就是缺失（`undefined`），不补默认值。
*/
/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 2e4;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;
/** fetch 一次，带超时；失败抛错（调用方决定是否重试） */
async function fetchOnce(url, key) {
	return fetch(url, {
		headers: {
			Authorization: "Bearer " + key,
			"User-Agent": "dsh-pet-balance"
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
}
/** fetch + 重试；全败抛最后错误 */
async function fetchWithRetry(url, key) {
	let last;
	for (let i = 0; i <= RETRIES; i++) try {
		return await fetchOnce(url, key);
	} catch (e) {
		last = e;
		if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
	}
	throw last instanceof Error ? last : new Error(String(last));
}
/** 数字兜底校验：数值化失败或非有限数 → throw（数据异常显式报错，不静默当 0） */
function num(value, what) {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return n;
}
/** 字符串兜底校验：非空字符串，否则 throw */
function str(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return value;
}
/** 宽松数值（数字或数字字符串）：缺失/空/非法 → undefined（可选字段用；必填字段走 num() 抛错） */
function looseNum(value) {
	if (value === void 0 || value === null || value === "") return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : void 0;
}
/** 取对象：不是对象（含数组/null）→ undefined */
function obj(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/**
* 重置时间：字符串原样（ISO 8601）；数字时间戳按秒/毫秒自动识别转 ISO；0 / 负数 / 非法 → undefined。
* 真实报文里空闲窗口是 `resetAt: 0`（占位值，不是 1970 年重置）→ 视为「无重置时间」。
*/
function resetTime(value) {
	if (typeof value === "string") return value.length > 0 ? value : void 0;
	const n = looseNum(value);
	if (n === void 0 || n <= 0) return void 0;
	const ms = n < 0xe8d4a51000 ? n * 1e3 : n;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? void 0 : d.toISOString();
}
/** 一个限额窗口（`{used, cap, resetAt}`）→ 百分比 + 满额度 + 重置时间；形态不认识 → undefined（该窗口视为不存在） */
function readWindow(value) {
	const w = obj(value);
	if (!w) return void 0;
	const used = looseNum(w.used);
	const cap = looseNum(w.cap);
	if (used === void 0 || cap === void 0 || cap <= 0) return void 0;
	return {
		percent: Math.max(0, used / cap * 100),
		capUsd: cap,
		resetsAt: resetTime(w.resetAt)
	};
}
/** 查询串：只带出现过的参数（`orgId` 取不到时不硬塞空值） */
function queryString(params) {
	const pairs = Object.entries(params).filter(([, v]) => v !== void 0);
	return pairs.length > 0 ? "?" + pairs.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&") : "";
}
/**
* 账号侧金额 → 两位小数字符串。
*
* 平台回传的是**保留服务端精度的原始串**（实测形如 `9.9902690000000000`，README 亦声明
* 允许 `0E-16`、`5.0000000000000000` 这类写法），直接显示会变成 `¥9.9902690000000000`，
* 与官方路由的 `¥8.79` 风格不一致 —— 故在这里收敛到两位小数。
* 非法（非数字）仍抛错，绝不伪造 0。
*/
function money(value, what) {
	const raw = str(value, what);
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 账号余额金额非法 " + what);
	return n.toFixed(2);
}
/**
* 两个金额串相加 → 两位小数。
* 走整数分相加（先四舍五入到分），避免 0.1+0.2 这类二进制浮点误差在金额上显形。
*/
function sumMoney(a, b) {
	return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}
//#endregion
//#region .local/dsh-pet-windows/src/host/balance/providers/commandcode.ts
/**
* Command Code（provider id `commandcode`）—— 三窗口用量，走**控制面** `/alpha/*`。
*
* 用量在官方 CLI 使用的未文档化控制面上，与推理数据面的 `/provider`、`/provider/v1` 不是同一条
* 路径：先 whoami 取 orgId，再依次取额度 / 订阅 / 当期消耗（**串行 4 次调用**）。
*
* 数据来源与口径（与官方 CLI 的 `/alpha` 路由一致）：
* - `credits`：`monthlyCredits` + `purchasedCredits` + `freeCredits` = 剩余额度；
* - `windowLimits`：`limited` 为真才有 5h（`fiveHour`）/ 周窗口，各 `{used, cap, resetAt}`；
* - `usage/summary` 的 `totalCost` = 当期已消耗 → 月度百分比 = 消耗 /（消耗 + 剩余）；
* - 订阅接口（可选）只提供月度重置时间（`currentPeriodEnd`）。
*
* 展示形态与 opencode 相同（`shape: 'windows'`），展示层因而共用同一套「取最紧迫窗口」逻辑。
*/
/** 滚动窗时长（展示名）：本服务商的 5h 窗口就是 `windowLimits.fiveHour` */
const ROLLING_LABEL$1 = "5h";
/** 抓一次 JSON（GET + Bearer），HTTP 非 2xx 抛错；`label` 是接口路径，只进错误信息（便于自查哪一个失败） */
async function fetchJson(url, key, label) {
	const res = await fetchWithRetry(url, key);
	if (!res.ok) throw new Error("commandcode " + label + " HTTP " + res.status);
	return await res.json();
}
/**
* 解析三个接口的响应 → 成功结果（纯函数：网络与凭证都在外面，测试直接喂真实报文）。
*
* 失败口径：**必填字段缺失/非法一律抛错**（调用方落成 `fetch-error`，绝不伪造 0 余额）；
* 可选信息（不限额窗口、`cap` 为 0、占位重置时间、订阅缺失）一律省略。
*/
function parseCommandCode(creditsBody, subscriptionBody, summaryBody, provider) {
	const root = obj(creditsBody);
	const credits = obj(root?.credits);
	if (!credits) throw new Error("dsh-pet: commandcode 响应缺少 credits");
	const creditFields = [
		credits.monthlyCredits,
		credits.purchasedCredits,
		credits.freeCredits
	];
	if (creditFields.every((v) => looseNum(v) === void 0)) throw new Error("dsh-pet: commandcode credits 响应缺少额度字段");
	const remaining = creditFields.reduce((sum, v) => sum + Math.max(0, looseNum(v) ?? 0), 0);
	const spentRaw = obj(summaryBody)?.totalCost;
	if (spentRaw === void 0 || spentRaw === null) throw new Error("dsh-pet: commandcode usage 响应缺少 totalCost");
	const spent = Math.max(0, num(spentRaw, "totalCost"));
	const pool = spent + remaining;
	const data = { monthly: pool > 0 ? spent / pool * 100 : 0 };
	if (pool > 0) data.monthlyCapUsd = pool;
	const periodEnd = obj(obj(subscriptionBody)?.data)?.currentPeriodEnd;
	if (typeof periodEnd === "string" && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;
	const limits = obj(root?.windowLimits) ?? obj(credits.windowLimits);
	if (limits?.limited === true) {
		const fiveHour = readWindow(limits.fiveHour);
		if (fiveHour) {
			data.rolling = fiveHour.percent;
			data.rollingCapUsd = fiveHour.capUsd;
			data.rollingLabel = ROLLING_LABEL$1;
			if (fiveHour.resetsAt) data.rollingResetsAt = fiveHour.resetsAt;
		}
		const weekly = readWindow(limits.weekly);
		if (weekly) {
			data.weekly = weekly.percent;
			data.weeklyCapUsd = weekly.capUsd;
			if (weekly.resetsAt) data.weeklyResetsAt = weekly.resetsAt;
		}
	}
	return {
		ok: true,
		provider,
		shape: "windows",
		data
	};
}
const commandCode = {
	ids: ["commandcode"],
	credential: {
		mode: "ref",
		ref: "COMMANDCODE_API_KEY"
	},
	async fetch({ key, provider }) {
		const org = obj(obj(await fetchJson("https://api.commandcode.ai/alpha/whoami" + queryString({ limits: "1" }), key, "/alpha/whoami"))?.org);
		const orgId = typeof org?.id === "string" && org.id.length > 0 ? org.id : void 0;
		const credits = await fetchJson("https://api.commandcode.ai/alpha/billing/credits" + queryString({ orgId }), key, "/alpha/billing/credits");
		let subscription;
		try {
			subscription = await fetchJson("https://api.commandcode.ai/alpha/billing/subscriptions" + queryString({ orgId }), key, "/alpha/billing/subscriptions");
		} catch {
			subscription = void 0;
		}
		const periodStart = obj(obj(subscription)?.data)?.currentPeriodStart;
		const summary = await fetchJson("https://api.commandcode.ai/alpha/usage/summary" + queryString({
			since: typeof periodStart === "string" ? periodStart : void 0,
			orgId
		}), key, "/alpha/usage/summary");
		return parseCommandCode(credits, subscription, summary, provider);
	}
};
//#endregion
//#region .local/dsh-pet-windows/src/host/balance/deepseek-common.ts
/**
* DeepSeek 峰谷计价档位（北京时间）：
* - 高峰：工作日 9:00–12:00、14:00–18:00；其余为空闲（低谷）
* - 周六/周日全天按低谷价计费（自 2026-08-23 起，周末不再区分峰谷）
*
* 在**取数时刻**算好后随数据带出（而不是展示时刻）：气泡只在刷新后显示 ≤10 秒（客户端 1s 轮询
* 拉取），与显示时刻的偏差只有 1~2 秒。换来的是展示层完全不需要知道任何计价规则。
*/
function deepseekPricingTier(now = /* @__PURE__ */ new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(now);
	const pick = (type) => parts.find((p) => p.type === type)?.value;
	const weekday = pick("weekday");
	const hour = Number(pick("hour"));
	if (weekday === "Sat" || weekday === "Sun") return "idle";
	return hour >= 9 && hour < 12 || hour >= 14 && hour < 18 ? "peak" : "idle";
}
//#endregion
//#region .local/dsh-pet-windows/src/host/balance/providers/deepseek-account.ts
/**
* DSH 账号路由（provider id `deepseek-account`）—— 免费额度 / 平台登录，账户金额。
*
* 这条路由**没有 API Key**（`credential.mode === 'none'`）：凭证是 DSH 账号服务持有的授权记录，
* 因此不发任何 HTTP，只经调用方注入的 `resolveAccount`（= `ctx.deepseekAccount.getBalance`）取快照。
*
* 展示口径与 `deepseek-official` **完全一致**（同一个 shape）：气泡都是「余额（峰/谷）¥x.xx」，
* 金额语义也对齐官方定义 —— `total` = 赠送 + 充值（`granted` + `toppedUp`）。差异只在取数。
* 档位基准与峰谷档位取自 ./deepseek-common.ts（两条 deepseek 路由同一套口径）。
*/
/**
* 账号余额快照 → 成功结果（纯函数，便于测试直接喂真实结构）。
*
* 失败口径：没有可用的充值钱包（未登录 / 查询失败 / 空数组）→ 抛错，由调用方落成 `fetch-error`；
* 金额非法同理 —— **绝不伪造 0 余额**。
*
* 币种：钱包自带 `CNY`/`USD`，这里一并带出去，展示层据此选符号（CNY → ¥）。
*/
function parseAccountBalance(snapshot, provider) {
	if (!snapshot) throw new Error("dsh-pet: 账号未登录（deepseek-account）");
	if (snapshot.status !== "ready") throw new Error("dsh-pet: 账号余额查询失败");
	const wallets = Array.isArray(snapshot.value) ? snapshot.value : [];
	if (wallets.length === 0) throw new Error("dsh-pet: 账号没有充值钱包余额");
	const first = obj(wallets[0]);
	if (!first) throw new Error("dsh-pet: 账号钱包结构非法");
	const currency = typeof first.currency === "string" && first.currency.length > 0 ? first.currency : "CNY";
	const toppedUp = money(first.balance, "balance");
	const bonus = (Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []).map((w) => obj(w)).find((w) => w !== void 0 && w.currency === currency);
	const granted = bonus ? money(bonus.balance, "bonus balance") : "0.00";
	return {
		ok: true,
		provider,
		shape: "money",
		data: {
			currency,
			total: sumMoney(granted, toppedUp),
			granted,
			toppedUp,
			fullBalance: "20",
			tier: deepseekPricingTier()
		}
	};
}
const deepseekAccount = {
	ids: ["deepseek-account"],
	credential: { mode: "none" },
	async fetch({ provider, resolveAccount }) {
		if (!resolveAccount) throw new Error("dsh-pet: 缺少账号服务（" + provider + "）");
		return parseAccountBalance(await resolveAccount(), provider);
	}
};
//#endregion
//#region .local/dsh-pet-windows/src/host/balance/providers/deepseek-official.ts
/**
* DeepSeek 官方 API Key 路由（provider id `deepseek-official`）—— 账户金额。
*
* 接口：`GET https://api.deepseek.com/user/balance`（Bearer）。
* 三个金额由接口原样透传（不自己按 `granted + topped_up` 重算 `total_balance`）—— 官方路由给的
* 数字比本插件推算的可信。档位基准与峰谷档位取自 ./deepseek-common.ts（两条 deepseek 路由同一套口径）。
*
* 与账号路由（./deepseek-account.ts）**同 shape、同形**：展示层共用同一套气泡，差异只在取数。
*/
const deepseekOfficial = {
	ids: ["deepseek-official"],
	credential: {
		mode: "ref",
		ref: "DEEPSEEK_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://api.deepseek.com/user/balance", key);
		if (!res.ok) throw new Error("deepseek balance HTTP " + res.status);
		const infos = (await res.json())?.balance_infos;
		if (!Array.isArray(infos) || infos.length === 0) throw new Error("dsh-pet: deepseek balance 响应缺少 balance_infos");
		const first = infos[0];
		return {
			ok: true,
			provider,
			shape: "money",
			data: {
				currency: str(first.currency, "currency"),
				total: str(first.total_balance, "total_balance"),
				granted: str(first.granted_balance, "granted_balance"),
				toppedUp: str(first.topped_up_balance, "topped_up_balance"),
				fullBalance: "20",
				tier: deepseekPricingTier()
			}
		};
	}
};
//#endregion
//#region .local/dsh-pet-windows/src/host/balance/providers/opencode-go.ts
/**
* OpenCode Go（provider id `opencode-go`）—— 三窗口用量。
*
* 接口：`GET https://opencode.ai/zen/go/v1/usage`（Bearer），响应 `{ usage: { rolling, weekly, monthly } }`。
* 该接口保证三个窗口都在，故三窗与三个重置时间全是必填（缺一个就说明响应形态变了 → 报错，不静默）。
*
* 满额度是**本服务商的业务常量**（接口不回报），跟着数据带出去；滚动窗是 5 小时。
*
* 注意 `opencode-go` 与 `opencode` 是两个 id：Zen 按量版（`opencode`）没有用量接口，不登记。
*/
/** 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月 */
const QUOTA_USD = {
	rolling: 12,
	weekly: 30,
	monthly: 60
};
/** 滚动窗时长（展示名）：本服务商是 5 小时 */
const ROLLING_LABEL = "5h";
//#endregion
//#region .local/dsh-pet-windows/src/host/balance/index.ts
/**
* 余额查询（host 半侧）：把「当前服务商」映射到对应的余额/用量接口并抓取。
*
* 设计：
* - 数据源按「服务商 provider id」寻址（来源 = agentDefaultModel.currentSelection().provider）；
* - 只登记**有查询接口**的服务商（公开文档化，或第一方 CLI 正在用的未文档化路由）；一个都没有的
*   服务商不在此表 → 显式 `unsupported`，由上层决定不显示，绝不静默伪造 0 余额；
* - **一个服务商 = 一个自包含文件**（见 ./providers/）：接口地址、业务常量、响应解析都在它自己那份，
*   本文件只留注册表与统一的凭证/失败口径。加一个服务商 = 加一个 provider 文件 + 在下面加一行；
* - key 由调用方经 DSH 官方 credentialRef 解析后注入（不直接读 .credentials.yaml）；
* - 例外：DSH 账号路由（`deepseek-account`，免费额度 / 平台登录）**没有** API Key，它的凭证是
*   账号服务持有的授权记录，由调用方经 `resolveAccount` 注入查询（同样不直接读凭证存储）；
* - 失败口径统一：provider 只负责成功路径，任何失败一律 `throw`，这里统一落成 `fetch-error`。
*/
/** 已登记的服务商（登记口径见模块头：只收有接口的，其余 → `unsupported`） */
const BALANCE_PROVIDERS = [
	{
		ids: ["opencode-go"],
		credential: {
			mode: "ref",
			ref: "OPENCODE_GO_API_KEY"
		},
		async fetch({ key, provider }) {
			const res = await fetchWithRetry("https://opencode.ai/zen/go/v1/usage", key);
			if (!res.ok) throw new Error("opencode usage HTTP " + res.status);
			const usage = (await res.json())?.usage;
			if (!usage || typeof usage !== "object") throw new Error("dsh-pet: opencode usage 响应缺少 usage");
			const u = usage;
			const rolling = u.rolling, weekly = u.weekly, monthly = u.monthly;
			if (!rolling || !weekly || !monthly) throw new Error("dsh-pet: opencode usage 响应缺少窗口");
			return {
				ok: true,
				provider,
				shape: "windows",
				data: {
					rolling: num(rolling.percent, "rolling.percent"),
					weekly: num(weekly.percent, "weekly.percent"),
					monthly: num(monthly.percent, "monthly.percent"),
					rollingCapUsd: QUOTA_USD.rolling,
					weeklyCapUsd: QUOTA_USD.weekly,
					monthlyCapUsd: QUOTA_USD.monthly,
					rollingLabel: ROLLING_LABEL,
					rollingResetsAt: str(rolling.resetsAt, "rolling.resetsAt"),
					weeklyResetsAt: str(weekly.resetsAt, "weekly.resetsAt"),
					monthlyResetsAt: str(monthly.resetsAt, "monthly.resetsAt")
				}
			};
		}
	},
	commandCode,
	deepseekOfficial,
	deepseekAccount
];
/** provider id → 唯一匹配定义；未匹配返回 undefined（= 不支持查询） */
function matchBalanceProvider(provider) {
	return BALANCE_PROVIDERS.find((p) => p.ids.includes(provider));
}
/**
* 失败结果（三种 reason 一个出口，避免各处手写字段）。
* `message` 缺省时**不写这个键** —— 叶子的形状是对外契约，多一个 `undefined` 键会让
* `deepStrictEqual` 一类的严格比对失败（消费端也按「有/无」判断）。
*/
function failed(provider, reason, message) {
	return message === void 0 ? {
		ok: false,
		provider,
		reason
	} : {
		ok: false,
		provider,
		reason,
		message
	};
}
/**
* 按当前服务商查询余额。
* @param provider agentDefaultModel.currentSelection().provider
* @param resolveKey 凭证解析：ref 名 → key（由调用方注入 ctx.credentials.resolve）
* @param resolveAccount 账号余额查询（由调用方注入 ctx.deepseekAccount.getBalance）；
*   只被 `deepseek-account` 用到。缺省时该路由报 `credential-missing`（账号服务不在场）
* @returns 结构化结果：成功 / 不支持 / 缺凭证 / 抓取失败（失败带 message，绝不返回伪造数字）
*/
async function queryBalance(provider, resolveKey, resolveAccount) {
	const def = matchBalanceProvider(provider);
	if (!def) return failed(provider, "unsupported");
	let key = "";
	if (def.credential.mode === "ref") {
		const resolved = await resolveKey(def.credential.ref);
		if (!resolved) return failed(provider, "credential-missing", "缺少凭证 " + def.credential.ref);
		key = resolved;
	} else if (!resolveAccount) return failed(provider, "credential-missing", "缺少账号服务（" + provider + "）");
	try {
		return await def.fetch({
			provider,
			key,
			resolveAccount
		});
	} catch (e) {
		return failed(provider, "fetch-error", e instanceof Error ? e.message : String(e));
	}
}
//#endregion
//#region .local/dsh-pet-windows/src/host/llm-reasoning.ts
/**
* 当前 provider/model 是否声明支持 reasoning effort（含 "off"）。
* 能力缺失或查询失败一律保守返回 false（= 不传，等价于模型默认行为，避免请求失败）。
*/
async function supportsReasoningOff(ctx, provider, model) {
	const llm = ctx.llm;
	if (!llm || typeof llm.resolveModelInfo !== "function") return false;
	try {
		return (await llm.resolveModelInfo(provider, model))?.reasoning?.efforts?.some((e) => e.id === "off") ?? false;
	} catch {
		return false;
	}
}
//#endregion
//#region .local/dsh-pet-windows/src/host/model-selection.ts
/** 读条目配置里的 whisperModel / chatModel：
*  两个字段都非空 → 该选择；都为空（内置默认）→ undefined（= 跟随当前对话）；
*  结构不对 / 只填一半（合并器已挡下，这里再防御一次）→ undefined。 */
function configuredModel(conf, key) {
	const raw = conf?.[key];
	if (!raw || typeof raw !== "object") return void 0;
	const m = raw;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return void 0;
	const provider = m.provider.trim();
	const model = m.model.trim();
	return provider && model ? {
		provider,
		model
	} : void 0;
}
/** 当前对话的模型（agentDefaultModel.currentSelection）；未配置 / 抛错 → undefined */
function currentModel(ctx) {
	try {
		const sel = ctx.agentDefaultModel?.currentSelection();
		return sel?.provider && sel?.model ? {
			provider: sel.provider,
			model: sel.model
		} : void 0;
	} catch {
		return;
	}
}
/** 候选链：配置的模型优先，其次当前对话的模型；同一个选择只留一次。
*  返回空数组 = 两个来源都拿不到（生成侧据此回「当前对话未配置模型」）。 */
function modelCandidates(ctx, preferred) {
	const out = [];
	const push = (m) => {
		if (!m) return;
		if (out.some((x) => x.provider === m.provider && x.model === m.model)) return;
		out.push(m);
	};
	push(preferred);
	push(currentModel(ctx));
	return out;
}
/** 报错/日志用的选择标签：provider/model */
function modelLabel(m) {
	return m.provider + "/" + m.model;
}
//#endregion
//#region .local/dsh-pet-windows/src/host/whisper.ts
/**
* 碎碎念生成（host 半侧）：用 DSH 的 LLM 统一抽象层（ctx.llm）按条目配置的 whisperModel
* （留空 = 当前对话用的 provider/model）生成一句话。与余额不同：不自己拼各服务商端点、不碰凭证——
* ctx.llm 已接管适配器路由/模型解析/凭据，天然与对话页完全一致。
*
* 设计：
* - provider/model：条目配置的 whisperModel 优先（留空 = 不指定），失败回落到
*   agentDefaultModel.currentSelection()（当前对话的模型，与余额同源）重试一次——
*   候选链见 model-selection.ts；
* - system = 用户配置的 whisperPrompt（人设），user = 一个极简的"说句话"请求；
* - 配图（可选）：开启 whisperImageEnabled 时，由调用方从表情包池随机抽一张传入，
*   把该图描述注入 user 指令，让这句话配合画面说——随机而非让模型选：
*   碎碎念本身没有上下文可选（人设固定、无用户输入），交模型"选"只能盲选且多了幻觉风险；
* - reasoningEffort: 'off' —— 仅当模型声明支持 reasoning effort（含 "off"）时传，
*   关闭深度思考：碎碎念只求随口一句，不开推理（省时省 token）。无 reasoning 元数据的
*   模型（如 reasoningEfforts: false）显式传 off 会被 dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT
*   并折叠成空流（表现为"模型未返回文本"），因此这类模型省略该字段（语义等价于不传）；
* - 流式收集 + BlockAssembler 拼装文本；生成失败显式返回结构化原因，不伪造文案；
* - 短超时（LLM 冷启动/慢响应时快速放弃，不留挂起请求）。
*/
/** 单次生成超时（ms）：骈骈念不需要长输出，30s 足够 */
const TIMEOUT_MS$1 = 3e4;
/** 碎碎念指令：纯文本（原行为） */
const USER_TEXT = "随便说一句日常碎碎念，一句就好，20 字以内。";
/**
* 碎碎念指令：带表情包（用户开启 whisperImageEnabled 时）——要求模型配合作画说一句。
* 明确「正文仍是一句话」：图是配图，不是让模型描述画面本身。
*/
function userTextWithMeme(meme) {
	return "随便说一句日常碎碎念，一句就好，20 字以内。\n这次会配一张表情包一起显示，图的内容是：" + meme.name + "（" + meme.desc + "）。\n请让这句话和这张图的情绪/场景自然契合，像是配合画面说出来的；不要描述画面本身。";
}
/**
* 用指定（或当前对话的）provider/model 生成一句碎碎念。
* @param ctx 宿主上下文（注入 agentDefaultModel / llm）
* @param system 人设提示词（whisperPrompt）
* @param meme 配图（开启配图时传入；缺省 = 纯文本碎碎念）。生成成功时原样带回，
*             客户端据此展示图片（host 不判断模型是否真的贴合）
* @param preferred 条目配置单独指定的模型（whisperModel）；缺省 / 留空 = 只用当前对话的模型
* @returns 生成的文本（+ 配图），或结构化失败（provider 缺失 / 生成错误）
*/
async function generateWhisper(ctx, system, meme, preferred) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: "模型未返回文本"
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith$1(ctx, llm, sel, system, meme);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) console.warn(`dsh-pet: 碎碎念用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用**一个**确定的 provider/model 跑一次生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith$1(ctx, llm, sel, system, meme) {
	const deadline = AbortSignal.timeout(TIMEOUT_MS$1);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const options = {
		provider: sel.provider,
		model: sel.model,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: meme ? userTextWithMeme(meme) : USER_TEXT
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: "模型未返回文本"
	};
	return meme ? {
		ok: true,
		text,
		image: meme.name
	} : {
		ok: true,
		text
	};
}
//#endregion
//#region .local/dsh-pet-windows/src/host/memes.ts
/**
* 表情包池（host 半侧）：把配置的 memes 映射（名称 → 描述）解析成可用的候选池。
*
* 设计：
* - memes 是「键 = <表情包目录>/<键>.png，值 = 该图内容描述」，碎碎念/对话共用同一张表；
* - 目录是一条**链**（调用方给，顺序即优先级）：种类独占目录 → 用户目录 → 包内目录。
*   名字在链上任一目录里存在即算命中——这与 /pic/memes 路由的逐目录查找**必须同一份顺序**
*   （池说"这张能选"，路由就得"取得到"，否则气泡会图裂）；链怎么算由调用方
*   （host/index.ts 的 memeDirsFor）唯一决定，本模块只按给定顺序查盘；
* - 只认**磁盘上真实存在**的图片：配置里写了但文件缺失的条目静默剔除（不告警刷屏，
*   用户删图后不必同步改配置）；文件在但配置没写的图不参与（无从得知它的描述）；
* - 顺序 = **配置里写的顺序**（不排序）：它是对外可见的语义——chatImageLimit 的"前 N 张"
*   与交给模型看的清单都按它走，用户靠调整书写顺序决定优先级；
* - 纯函数 + 目录参数，便于测试（不碰全局状态）。
*/
/**
* 从配置的 memes 映射解析出候选池。
* @param memes 配置的 memes 值（未配置/类型非法 → 空池）
* @param dirs 表情包目录链（顺序即优先级；空链 → 空池）
* @returns 按**配置里写的顺序**排列的候选池（链上哪个目录都没有该图、或描述为空 → 剔除）
*/
function readMemePool(memes, dirs) {
	if (!memes || typeof memes !== "object" || Array.isArray(memes)) return [];
	if (dirs.length === 0) return [];
	const out = [];
	for (const [name, desc] of Object.entries(memes)) {
		const text = typeof desc === "string" ? desc.trim() : "";
		if (!name || !text) continue;
		if (!dirs.some((dir) => existsSync(join(dir, name + ".png")))) continue;
		out.push({
			name,
			desc: text
		});
	}
	return out;
}
/** 抽一张图（均匀随机）；空池返回 undefined */
function pickMeme(pool, random = Math.random) {
	if (pool.length === 0) return void 0;
	return pool[Math.floor(random() * pool.length) % pool.length];
}
/** 模型选图校验：只在池内命中时才认（防幻觉出池外名称）；命中返回该条目，否则 undefined */
function matchMeme(pool, name) {
	const key = String(name ?? "").trim();
	return key ? pool.find((m) => m.name === key) : void 0;
}
/** 配图选择标记：`[图:名称]` 附在回复末尾（容忍全角冒号与前后空白） */
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
/**
* 从模型回复里取配图（对话选图的解析半侧；纯函数，无 LLM 依赖）：
* - 命中池内 → 采纳该图，并把标记从正文剥离（标记不得留在用户可见文本里）；
* - 未命中（模型幻觉名称）/ 空池 / 只回标记不回正文 → 一律视为"没选"，
*   **正文原样保留**（解析失败绝不吞掉回复）。
*/
function extractChatImage(text, pool) {
	const m = IMG_TAG.exec(text);
	if (!m) return { text };
	const hit = matchMeme(pool, m[1] ?? "");
	const body = text.slice(0, m.index).trim();
	if (!hit || !body) return { text };
	return {
		text: body,
		image: hit.name
	};
}
/** 表情包清单 → 给模型看的候选列表（一行一张：名称 + 描述） */
function memeCatalog(pool) {
	return pool.map((m) => "- " + m.name + "：" + m.desc).join("\n");
}
/**
* 按「对话配图张数上限」（配置 chatImageLimit）截断候选池。
*
* 语义（与配置注释、设置页提示同一套口径）：
*   - `limit <= 0` / 非有限数 → **原样返回**（0 = 不限制，与旧行为逐字一致）；
*   - `limit > 0` → 取**池内前 limit 张**。池由 readMemePool 按**配置里写的顺序**给出，
*     所以"前 N 张"就是你在配置里写在前面的那 N 条——想让哪几张优先被发出去，往前写就行。
*   - 小数向下取整（与 slice 的口径一致，避免出现"取 2.5 张"这种含糊值）。
*
* 为什么要它：整张清单是**每条对话消息都要附**的（见 chat.ts 的 imageInstruction），
* token 随张数线性增长；截断后模型只从这几张里挑，单条消息的配图开销上限立刻可控。
* 只作用于对话选图——碎碎念只带抽中的那一张（whisper 侧不经过本函数）。
*/
function limitPool(pool, limit) {
	const n = Math.floor(Number(limit));
	if (!Number.isFinite(n) || n <= 0) return pool;
	return pool.slice(0, n);
}
//#endregion
//#region .local/dsh-pet-windows/src/host/chat.ts
/**
* 对话生成（host 半侧）：用 DSH 的 LLM 统一抽象层（ctx.llm）按条目配置的 chatModel
* （留空 = 当前对话用的 provider/model）生成一句回复。与碎碎念（generateWhisper）同构，区别是：
*  - 输入带历史对话（memory.json 截取的最近 N 轮），历史以 user/assistant 消息进入请求；
*  - user 消息 = 用户刚输入的话（不是"随便叨叨"指令）；
*  - 回复放宽到 256 token（对话比碎碎念可说得稍多），超时放宽到 60s。
*
* 设计：
*  - provider/model：条目配置的 chatModel 优先（留空 = 不指定），失败回落到
*    agentDefaultModel.currentSelection()（当前对话的模型，与余额/碎碎念同源）重试一次——
*    候选链见 model-selection.ts；
*  - system = 用户配置的 whisperPrompt（人设：碎碎念与对话共用同一人设）；
*  - reasoningEffort: 'off' —— 仅当模型声明支持 reasoning effort（含 "off"）时传，
*    关闭深度思考：闲聊对话不需要推理。无 reasoning 元数据的模型（如
*    reasoningEfforts: false）显式传 off 会被 dsh-llm 判为 UNSUPPORTED_REASONING_EFFORT
*    并折叠成空流（表现为"模型未返回文本"），因此这类模型省略该字段（语义等价于不传）；
*  - 历史 assistant 消息用 createAssistantMessage 构造（provider/model 记当前选择，
*    仅作消息角色载体，不涉及适配器回放）；
*  - 流式收集 + BlockAssembler 拼装文本；生成失败显式返回结构化原因，不伪造文案。
*
* 配图（可选，pool 非空时）：与碎碎念「随机抽」不同——对话有真实上下文（用户输入 + 历史），
* 故把整张表情包清单交给模型由它**按语境选**一张；模型在末尾附标记 [图:名称]，
* host 解析并**只在池内命中时**采纳（防幻觉出池外名称），未选/选错则不配图
* （对话配图是点缀，不强制每句都带）。
*/
/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够 */
const TIMEOUT_MS = 6e4;
/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守） */
function imageInstruction(pool) {
	return "\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n" + memeCatalog(pool) + "\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。";
}
/**
* 生成一句对话回复。
* @param ctx 宿主上下文（注入 agentDefaultModel / llm）
* @param system 人设提示词（whisperPrompt）
* @param history 最近记忆（按时间正序；user/assistant 交替）
* @param userText 用户刚输入的话
* @param pool 表情包候选池（开启对话配图时传入；空/缺省 = 纯文本，指令与解析都不介入）
* @param preferred 条目配置单独指定的模型（chatModel）；缺省 / 留空 = 只用当前对话的模型
* @returns 回复文本（+ 命中池内的配图名），或结构化失败（provider 缺失 / 生成错误）
*/
async function generateChat(ctx, system, history, userText, pool = [], preferred) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: "模型未返回文本"
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith(ctx, llm, sel, system, history, userText, pool);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) console.warn(`dsh-pet: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用**一个**确定的 provider/model 跑一次对话生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith(ctx, llm, sel, system, history, userText, pool) {
	const historyMessages = history.map((m) => m.role === "user" ? createUserMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: { kind: "user" }
	}) : createAssistantMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: {
			provider: sel.provider,
			model: sel.model
		}
	}));
	const deadline = AbortSignal.timeout(TIMEOUT_MS);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const wantImage = pool.length > 0;
	const options = {
		provider: sel.provider,
		model: sel.model,
		messages: [...historyMessages, createUserMessage({
			content: [{
				type: "text",
				text: wantImage ? userText + imageInstruction(pool) : userText
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: "模型未返回文本"
	};
	if (!wantImage) return {
		ok: true,
		text
	};
	const picked = extractChatImage(text, pool);
	return picked.image ? {
		ok: true,
		text: picked.text,
		image: picked.image
	} : {
		ok: true,
		text: picked.text
	};
}
//#endregion
//#region .local/dsh-pet-windows/src/host/config.ts
/**
* host 侧配置模块 —— 全项目唯一的配置读取入口与写盘出口。
*
* 角色：
*   - readAllConfig()：读取 内置默认（assets/config.jsonc，绝对正确）+ 用户主配置
*     （main-config.jsonc）+ 文件宠物（pet/<名>-config.json，一个文件一个条目），
*     逐字段合并后返回 **绝对正确** 的完成品聚合：
*       { main: {...}, test1: {...}, ... }
*     每个条目都是对应配置文件的原文结构（字段名/位置/嵌套一律不动），且所有字段已填满。
*   - saveUserConfig()：设置页写盘（PUT /config），白名单重建用户层 main-config.jsonc；
*     与读取分离——写的是「可编辑层」，文件宠物永不回写、不进此模式。
*   - syncUserConfigFromDefault()：设置页「同步」写盘（POST /config），把内置默认
*     （assets/config.jsonc 原文，含注释）整份写入用户层——既是「恢复默认」，又直接给出
*     一份可编辑的完整配置（不必再自己从包内复制）。合并结果与「没有用户层」等价。
*
* 合并规则（唯一规则）：
*   - 内置默认配置是唯一默认值来源（「代码里的配置绝对正确」）；
*   - 覆盖文件写了 → 用自己的值；**没写 → 静默填内置默认值**（结构性常态，不告警——
*     设置页写的用户层本就只含 pets + notificationsEnabled；文件宠物也可以写得很短）；
*   - **对象字段也是整段替换**（`physics` / `eventsRefreshSec` / `whisperModel` … 都适用）：
*     写了就整段用自己的，缺的子键**不会**从内置默认补回来——消费端各自兜底
*     （如余额周期读不到就按 1800、碎碎念按 300）；
*   - **显式写了但非法**（类型/结构/白名单外）→ 告警 + 填内置默认值
*     （同一 文件+字段 进程内只告警一次，避免每请求刷屏；保证返回绝不出现残缺/非法值）；
*   - **例外：全局默认**（GLOBAL_DEFAULT_KEYS 那 9 个「用户级成本/偏好/环境/节奏」字段）——
*     文件宠物条目的基座取**用户层**（main-config.jsonc）而不是内置默认，即"设置页改一次，
*     所有宠物都生效"；种类文件仍可在自己顶层覆盖（写了就用自己那份）；
*   - 身份字段例外（无默认可填）：id 必须存在、全局唯一（缺失/重复/非法/冲突 →
*     跳过该实例并告警）；name 缺失/空 → 按该宠物 id 处理并告警（既定规则，不继承默认名字）。
*
* 消费端契约：其他代码（路由/命令/碎碎念/对话/桌面）只消费 readAllConfig 的返回值，
* 不做任何校验/兜底；浏览器与桌面通过 GET /dsh-pet-7340/config 拿到同一份成品。
*
* 本模块是 host 自包含实现（不 import src/shared —— DSH 单文件加载约束）；
* 浏览器/桌面侧的对应纯逻辑（把成品拍平成渲染列表）在 src/shared/config.ts。
*/
const CORNER_SET = new Set([
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
]);
const PET_DISPLAY_SET = new Set([
	"web",
	"desktop",
	"both",
	"none"
]);
/** id 禁用的字符（Windows 文件名保留符 + 控制字符，防配置值逃逸文件路径）。
*  同时被 thumb 路由的 petId 校验复用：那里同样是"标识符不得当路径片段"。 */
const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;
/**
* 「全局默认 + 种类可覆盖」的顶层字段白名单 —— 用户层（main-config.jsonc）里写下的值会成为
* **所有条目**的默认值；种类文件 `pet/<名>-config.json` 仍可在自己顶层覆盖（写了就用自己那份）。
*
* 判据：这几个是**用户级「成本 / 偏好 / 环境 / 节奏」参数**，不是「这个种类长什么样」——
*   - `chatMemoryRounds`：带多少历史进上下文 = token 成本
*   - `whisperModel` / `chatModel`：碎碎念 / 对话用哪个模型 = 成本与能力偏好
*   - `whisperImageEnabled` / `chatImageEnabled`：要不要把表情包清单附进请求 = token 成本
*   - `chatImageLimit`：对话那张清单**最多几张**——同属 token 成本（清单每条消息都附）
*   - `eventsRefreshSec`：多久调一次模型 / 拉一次余额 = 成本与节奏。注意它内部两个键的**消费端**
*     不同：`.whisper` 按宠物所属条目读（种类可覆盖）；`.balance` 只读 main 条目
*     （余额数据一份 + host 只有一个定时器，架构上给不了每种类一个周期）
*   - `physics`：拖拽抛掷手感；`petCollision` 更是**跨宠物**行为（相撞按动量守恒弹开），
*     按种类分在语义上站不住：两只不同种类的宠物相撞时用谁的系数？
*   - `confineToScreen`：多屏是用户环境 / 使用习惯，不是宠物属性
*
* 不在名单里的顶层字段基座仍是**内置默认**：`whisperPrompt`（人设）、`memes`（表情包）、
* `animations` / `animationWeights`（与素材根绑定）、`workStatusTexts`（文案）——一个种类一份
* 动画池 / 一份人设 / 一个表情包目录，各写一份才是 pet pack 的意义。
*/
const GLOBAL_DEFAULT_KEYS = [
	"physics",
	"confineToScreen",
	"whisperImageEnabled",
	"chatImageEnabled",
	"chatImageLimit",
	"chatMemoryRounds",
	"whisperModel",
	"chatModel",
	"eventsRefreshSec"
];
/** 已告警过的 文件:字段（进程内去重：同一问题只告警一次，避免每请求刷屏；重启重置） */
const warnedKeys = /* @__PURE__ */ new Set();
function warnOnce(key, message) {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	console.warn("dsh-pet: " + message);
}
/** 剥除 JSONC 注释（行注释 // 与块注释）得到纯 JSON */
function stripJsonc(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^\\:])\/\/.*$/gm, "$1").trim();
}
/** 读取并解析 JSONC 文件；不存在/解析失败 → undefined（调用方决定处理） */
function readJsonc(path) {
	try {
		const raw = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
		return raw && typeof raw === "object" ? raw : void 0;
	} catch {
		return;
	}
}
/**
* 读磁盘上的用户层原对象（JSONC 容忍——与读取路径 readAllConfig 共用同一份解析器）。
*
* 写路径必须用它：`PUT /config` 的「透传保留」要把用户手改的高级字段（physics /
* whisperPrompt / animations / memes / ...）原样带回，而用户层可能是「同步」写入的
* **带 // 注释的 config.jsonc 原文**。那里若用严格 `JSON.parse`，解析必然抛错、又被
* catch 静默吞掉，existing 就成了 undefined —— 保存时白名单重建，高级字段全部丢失
* （这正是「保存把用户精调配置抹掉」那次老 bug 的复发路径）。
*
* 文件不存在 / 损坏 → undefined（调用方按「无既有字段」处理，不阻塞保存）。
*/
function readUserConfig(paths) {
	const file = effectiveUserFile(paths);
	return file ? readJsonc(file) : void 0;
}
/**
* 用户层**存在但解析不了**（真损坏：语法错误，连 JSONC 剥注释都救不回来）。
*
* 用途：`PUT /config`（保存）的损坏预检。保存是「白名单重建」，一旦 existing 读不出来，
* 文件里原有的内容（用户手写的 animations / physics / memes / ...）就会被整份丢掉——
* 而且全程静默。所以宿主这里**先不写盘**，回 409 让设置页弹窗（取消 = 不动文件；
* 确认 = 强行重建），绝不静默丢配置。
*
* 文件不存在 → false（没有东西可丢，正常首次保存）。
*/
function userConfigUnparsable(paths) {
	const file = effectiveUserFile(paths);
	return file !== void 0 && readJsonc(file) === void 0;
}
/** 实际生效的用户层文件：优先 .jsonc；不存在则回落到旧的 .json（迁移前的老用户）；
*  两者都不存在 → undefined（首次使用，无用户层）。 */
function effectiveUserFile(paths) {
	if (existsSync(paths.userFile)) return paths.userFile;
	if (paths.legacyUserFile && existsSync(paths.legacyUserFile)) return paths.legacyUserFile;
}
/**
* 老用户一次性迁移：`main-config.json` → `main-config.jsonc`（**重命名**，内容一字不动）。
*
* 为什么改扩展名：用户层从「同步」起就是带 `//` 注释的 JSONC 原文，挂在 `.json` 名下名不副实
* （编辑器会当严格 JSON 报错）。改成 `.jsonc` 后与包内默认 `config.jsonc` 同名同格式。
*
* 语义：新文件已存在 → 什么都不做（绝不用旧文件覆盖新文件）；旧文件不存在 → 什么都不做；
* 重命名失败（占用/权限）→ 静默放过，读取侧对旧路径有回落，功能不受影响。
*/
function migrateUserConfig(paths, log) {
	const legacy = paths.legacyUserFile;
	if (!legacy || !existsSync(legacy) || existsSync(paths.userFile)) return false;
	try {
		renameSync(legacy, paths.userFile);
	} catch {
		return false;
	}
	log?.(`用户配置已迁移到 JSONC：${legacy} → ${paths.userFile}`);
	return true;
}
/** 扫描 pet/ 目录：<名>-config.(json|jsonc) → 条目（按文件名排序） */
function scanPetFiles(petDir) {
	let entries;
	try {
		entries = readdirSync(petDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((e) => e.isFile()).map((e) => e.name).filter((name) => /^.+?-config\.(json|jsonc)$/.test(name)).sort().map((name) => ({
		prefix: name.replace(/-config\.(json|jsonc)$/, ""),
		path: join(petDir, name)
	}));
}
/** animations 段完整性校验（与旧 assertAnimationsHost 同一套规则；不 throw，非法返回 false） */
function animationsValid(a) {
	if (!a || typeof a !== "object") return false;
	const anims = a;
	for (const key of [
		"idle",
		"turn",
		"drag",
		"clicks"
	]) if (!Array.isArray(anims[key])) return false;
	const moves = anims.moves;
	if (!moves || typeof moves !== "object" || typeof moves.default !== "object" || moves.default === null || !Array.isArray(moves.actions)) return false;
	if (!Array.isArray(anims.categories)) return false;
	const ev = anims.events;
	if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
	const evEntries = ev;
	for (const pool of Object.values(evEntries)) {
		if (!Array.isArray(pool) || pool.length === 0) return false;
		for (const slot of pool) if (typeof slot === "string") {
			if (slot.length === 0) return false;
		} else if (Array.isArray(slot)) {
			if (slot.length === 0) return false;
			for (const name of slot) if (typeof name !== "string" || name.length === 0) return false;
		} else return false;
	}
	const balance = evEntries.balance;
	return Array.isArray(balance) && balance.length > 0;
}
/** animationWeights 段校验（idle/turn/move 三个非负数字） */
function weightsValid(w) {
	if (!w || typeof w !== "object") return false;
	const weights = w;
	for (const key of [
		"idle",
		"turn",
		"move"
	]) {
		const v = Number(weights[key]);
		if (!Number.isFinite(v) || v < 0) return false;
	}
	return true;
}
/** physics 段校验：gravity ≥ 0（0 = 无重力，合法）、restitution ∈ [0,1]、groundFriction ≥ 0（均为有限数字）、
*  ceilingBounce 为布尔、throwPower > 0（有限数字）、petCollision 为布尔 */
function physicsValid(value) {
	if (!value || typeof value !== "object") return false;
	const p = value;
	const g = Number(p.gravity);
	const r = Number(p.restitution);
	const f = Number(p.groundFriction);
	const tp = Number(p.throwPower);
	return Number.isFinite(g) && g >= 0 && Number.isFinite(r) && r >= 0 && r <= 1 && Number.isFinite(f) && f >= 0 && typeof p.ceilingBounce === "boolean" && Number.isFinite(tp) && tp > 0 && typeof p.petCollision === "boolean";
}
/** whisperModel / chatModel 段校验：{ provider, model } 两个字符串，
*  **要么都留空（= 跟随当前对话的模型）要么都非空**——只填一半（选了服务商没选模型，或反之）
*  会拼出"用 A 家的模型名去问 B 家"这种必然失败的组合，按非法处理（告警 + 取默认）。 */
function modelSelectionValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const m = value;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return false;
	return m.provider.trim() === "" === (m.model.trim() === "");
}
/** workStatusTexts 段校验：二维数组——外层每项都是非空字符串数组（档位文案，每档可多句随机）；空数组不可用 */
function workStatusTextsValid(value) {
	if (!Array.isArray(value) || value.length === 0) return false;
	for (const group of value) {
		if (!Array.isArray(group) || group.length === 0) return false;
		for (const text of group) if (typeof text !== "string" || text.length === 0) return false;
	}
	return true;
}
/** 顶层标量字段的合法性（非法与缺失同处理：取默认值 + 告警） */
function topFieldValid(key, value) {
	switch (key) {
		case "whisperPrompt": return typeof value === "string" && value.length > 0;
		case "chatMemoryRounds": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "chatImageLimit": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "notificationsEnabled": return typeof value === "boolean";
		case "whisperImageEnabled": return typeof value === "boolean";
		case "chatImageEnabled": return typeof value === "boolean";
		case "confineToScreen": return typeof value === "boolean";
		case "animations": return animationsValid(value);
		case "animationWeights": return weightsValid(value);
		case "eventsRefreshSec": return eventsRefreshSecValid(value);
		case "physics": return physicsValid(value);
		case "whisperModel":
		case "chatModel": return modelSelectionValid(value);
		case "workStatusTexts": return workStatusTextsValid(value);
		default: return true;
	}
}
/**
* eventsRefreshSec 段校验：事件名 → 间隔秒（正的有限数字）。
*
* 只校验「写下的每个值都合法」，**不**要求键集合与内置默认一致——这个字段和别的顶层字段
* 一样是**整段替换**：缺的键就是缺（消费端各自兜底 1800 / 300），多写的键原样保留
* （不再像旧的逐键深合并那样静默丢弃不认识的键）。空对象合法（等于全走消费端兜底）。
*/
function eventsRefreshSecValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const v of Object.values(value)) {
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) return false;
	}
	return true;
}
/**
* 文件宠物条目的合并基座：内置默认 + 白名单字段改用**用户层**的值。
*
* 为什么：那 9 个字段是用户级成本/偏好/环境/节奏参数，不是种类属性——用户在设置页改一次，
* 期望所有宠物（含 pet pack）都生效。没有这一步，文件宠物只能拿到内置默认值，
* 于是"设置页写着全局、实际只影响主宠物"（见 GLOBAL_DEFAULT_KEYS 的判据）。
*
* 语义仍是「种类可覆盖」：种类文件顶层写了自己的值 → 走 overlay 覆盖（mergeEntry 负责）。
* 用户层写了但非法的值直接跳过（main 条目那边合并时已告警过一次，这里不再重复刷屏）。
*/
function packBase(base, mainOverlay) {
	if (!mainOverlay) return base;
	let out;
	for (const key of GLOBAL_DEFAULT_KEYS) {
		const own = mainOverlay[key];
		if (own === void 0 || !topFieldValid(key, own)) continue;
		out ??= { ...base };
		out[key] = own;
	}
	return out ?? base;
}
/** 一个覆盖文件 → 完整条目：顶层逐字段合并（没写/非法 → 内置默认 + 告警），pets 逐实例 */
function mergeEntry(base, overlay, label, basePets, seenIds) {
	const out = {};
	for (const key of Object.keys(base)) {
		if (key === "pets") {
			out.pets = mergePets(basePets, overlay?.[key], label, seenIds);
			continue;
		}
		const own = overlay ? overlay[key] : void 0;
		if (own === void 0) {
			out[key] = base[key];
			continue;
		}
		if (!topFieldValid(key, own)) {
			warnOnce(`${label}:${key}`, `「${label}」的 ${key} 非法，已取默认值`);
			out[key] = base[key];
			continue;
		}
		out[key] = own;
	}
	return out;
}
/** pets 数组合并：文件没写/空 → 默认列表；逐实例合并（缺字段 → 内置默认 pets[0]，静默）。 */
function mergePets(basePets, raw, label, seenIds) {
	const basePet = basePets[0] ?? {};
	if (!Array.isArray(raw) || raw.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 缺失或为空，已取默认宠物列表`);
		return basePets;
	}
	const out = [];
	for (const item of raw) {
		const pet = mergePet(basePet, item, label, seenIds);
		if (pet) out.push(pet);
	}
	if (out.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 全部被跳过（id 非法/重复/冲突），已取默认宠物列表`);
		return basePets;
	}
	return out;
}
/** 宠物实例字段取数字；缺失 → 静默取默认（结构性常态）；显式写但非法 → 告警 + 默认 */
function petNumber(own, def, min, label, field, id) {
	const n = Number(own);
	if (own !== void 0 && own !== null && Number.isFinite(n) && n >= min) return n;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Number(def);
}
/** 宠物实例字段取布尔；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petBool(own, def, label, field, id) {
	if (typeof own === "boolean") return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Boolean(def);
}
/** 宠物实例字段取白名单枚举；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petEnum(own, set, def, label, field, id) {
	if (typeof own === "string" && set.has(own)) return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return typeof def === "string" ? def : "";
}
/** 一只实例 → 完成品实例（id 必须自己的且全局唯一；其余字段没写/非法 → 默认 + 告警） */
function mergePet(base, raw, label, seenIds) {
	const p = raw && typeof raw === "object" ? raw : {};
	const id = typeof p.id === "string" ? p.id.trim() : "";
	if (!id || id.length > 64 || ID_FORBIDDEN.test(id) || seenIds.has(id)) {
		warnOnce(`${label}:id:${id || "(空)"}`, `「${label}」的宠物 id「${id || "(空)"}」非法、重复或已存在，已跳过该实例`);
		return null;
	}
	seenIds.add(id);
	const rawName = typeof p.name === "string" ? p.name.trim() : "";
	const name = rawName || id;
	if (!rawName) warnOnce(`${label}:name:${id}`, `宠物「${id}」缺少 name，已按 id 处理`);
	const basePos = base.position && typeof base.position === "object" ? base.position : {};
	const ownPos = p.position && typeof p.position === "object" ? p.position : {};
	return {
		id,
		name,
		size: petNumber(p.size, base.size, 1, label, "size", id),
		balanceEnabled: petBool(p.balanceEnabled, base.balanceEnabled, label, "balanceEnabled", id),
		whisperEnabled: petBool(p.whisperEnabled, base.whisperEnabled, label, "whisperEnabled", id),
		workStatusEnabled: petBool(p.workStatusEnabled, base.workStatusEnabled, label, "workStatusEnabled", id),
		fixedEnabled: petBool(p.fixedEnabled, base.fixedEnabled, label, "fixedEnabled", id),
		display: petEnum(p.display, PET_DISPLAY_SET, base.display, label, "display", id),
		position: {
			corner: petEnum(ownPos.corner, CORNER_SET, basePos.corner, label, "position.corner", id),
			marginX: petNumber(ownPos.marginX, basePos.marginX, -Infinity, label, "position.marginX", id),
			marginY: petNumber(ownPos.marginY, basePos.marginY, -Infinity, label, "position.marginY", id)
		}
	};
}
/**
* 唯一读取函数：内置默认 + 用户主配置 + 文件宠物逐字段合并后的完成品聚合。
* 返回 { main: {...}, test1: {...}, ... } —— 每个条目都是原文件结构且所有字段已填满，
* 消费端直接读，不做任何校验/兜底。每次调用重新读文件：修改配置刷新/重启即生效。
*/
function readAllConfig(paths) {
	const base = readJsonc(paths.defaultFile);
	if (!base) throw new Error("dsh-pet: 内置默认配置缺失或解析失败（安装损坏）：" + paths.defaultFile);
	const basePets = Array.isArray(base.pets) ? base.pets : [];
	const seenIds = /* @__PURE__ */ new Set();
	const out = {};
	const userFile = effectiveUserFile(paths);
	const mainOverlay = userFile ? readJsonc(userFile) : void 0;
	if (userFile && !mainOverlay) warnOnce("file:" + userFile, "用户主配置解析失败，已按无用户配置处理：" + userFile);
	out.main = mergeEntry(base, mainOverlay, "main-config.jsonc", basePets, seenIds);
	const filePetBase = packBase(base, mainOverlay);
	for (const file of scanPetFiles(paths.petDir)) {
		const parsed = readJsonc(file.path);
		if (!parsed) {
			warnOnce("file:" + file.path, "文件宠物配置解析失败，已跳过：" + file.path);
			continue;
		}
		out[file.prefix] = mergeEntry(filePetBase, parsed, file.prefix + "-config.json", basePets, seenIds);
	}
	return out;
}
/** 拍平全部条目的 pets 为单列表（host 消费端用：桌面宠物列表 / 命令 / 当前桌宠解析） */
function flattenPetList(merged) {
	const out = [];
	for (const conf of Object.values(merged)) if (Array.isArray(conf?.pets)) out.push(...conf.pets);
	return out;
}
/** 在完成品聚合里按实例 id 定位宠物及其所属条目（host 内部消费索引）：
*  条目 key 即素材根（assetRoot）；条目级字段（whisperPrompt/chatMemoryRounds/animations）随条目取。 */
function findPetInstance(merged, petId) {
	for (const [entry, conf] of Object.entries(merged)) {
		const found = (Array.isArray(conf?.pets) ? conf.pets : []).find((p) => String(p.id) === petId);
		if (found) return {
			entry,
			conf,
			pet: found
		};
	}
}
/**
* 保存用户层（PUT /config）：更新 main-config.jsonc，接受可编辑字段（pets + 全局开关：
* notificationsEnabled / whisperImageEnabled / chatImageEnabled / confineToScreen + physics
* + whisperModel / chatModel + chatMemoryRounds + chatImageLimit）。
* 编辑语义：**非白名单顶层字段（whisperPrompt / eventsRefreshSec / memes 等）从
* `existing`（当前磁盘上的用户文件原对象）原样透传保留**——
* 用户手动编辑的精调配置不会被设置页保存抹掉（旧实现是纯白名单重建，会整体覆盖丢失）。
* 白名单字段同理只在请求体**真的传了**时才算白名单：没传就走透传，不会被抹成默认值。
* 非法 → 返回 null（宿主回 400）。与读取分离——文件宠物永不回写、不在本模式内。
*/
function saveUserConfig(raw, existing) {
	const o = raw && typeof raw === "object" ? raw : {};
	const arr = Array.isArray(o.pets) ? o.pets : null;
	if (!arr || !arr.length) return null;
	const out = [];
	for (const p of arr) {
		if (!p || typeof p !== "object") return null;
		const pp = p;
		const id = String(pp.id ?? "");
		if (!id || id.length > 64 || ID_FORBIDDEN.test(id)) return null;
		const size = Number(pp.size);
		if (!Number.isFinite(size) || size <= 0) return null;
		let name = typeof pp.name === "string" ? pp.name.trim() : "";
		if (!name) {
			console.warn(`dsh-pet: pet「${id}」缺少 name，已按默认 ${id}（宠物 id）处理`);
			name = id;
		}
		const balanceEnabled = pp.balanceEnabled;
		if (typeof balanceEnabled !== "boolean") return null;
		const whisperEnabled = pp.whisperEnabled;
		if (whisperEnabled !== void 0 && typeof whisperEnabled !== "boolean") return null;
		const workStatusEnabled = pp.workStatusEnabled;
		if (workStatusEnabled !== void 0 && typeof workStatusEnabled !== "boolean") return null;
		const fixedEnabled = pp.fixedEnabled;
		if (fixedEnabled !== void 0 && typeof fixedEnabled !== "boolean") return null;
		const display = String(pp.display ?? "");
		if (!PET_DISPLAY_SET.has(display)) return null;
		const pos = pp.position && typeof pp.position === "object" ? pp.position : {};
		const corner = String(pos.corner ?? "");
		if (!CORNER_SET.has(corner)) return null;
		const marginX = Number(pos.marginX);
		const marginY = Number(pos.marginY);
		if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
		out.push({
			id,
			name,
			size,
			balanceEnabled,
			whisperEnabled,
			workStatusEnabled,
			fixedEnabled,
			display,
			position: {
				corner,
				marginX,
				marginY
			}
		});
	}
	const ne = o.notificationsEnabled;
	if (ne !== void 0 && typeof ne !== "boolean") return null;
	const wie = o.whisperImageEnabled;
	if (wie !== void 0 && typeof wie !== "boolean") return null;
	const cie = o.chatImageEnabled;
	if (cie !== void 0 && typeof cie !== "boolean") return null;
	const cts = o.confineToScreen;
	if (cts !== void 0 && typeof cts !== "boolean") return null;
	const ph = o.physics;
	if (ph !== void 0 && !physicsValid(ph)) return null;
	const wm = o.whisperModel;
	if (wm !== void 0 && !modelSelectionValid(wm)) return null;
	const cm = o.chatModel;
	if (cm !== void 0 && !modelSelectionValid(cm)) return null;
	const cmr = o.chatMemoryRounds;
	if (cmr !== void 0 && !topFieldValid("chatMemoryRounds", cmr)) return null;
	const cil = o.chatImageLimit;
	if (cil !== void 0 && !topFieldValid("chatImageLimit", cil)) return null;
	const cleanModel = (v) => ({
		provider: String(v.provider).trim(),
		model: String(v.model).trim()
	});
	const outConfig = { pets: out };
	if (ne !== void 0) outConfig.notificationsEnabled = ne;
	if (wie !== void 0) outConfig.whisperImageEnabled = wie;
	if (cie !== void 0) outConfig.chatImageEnabled = cie;
	if (cts !== void 0) outConfig.confineToScreen = cts;
	if (ph !== void 0) outConfig.physics = ph;
	if (wm !== void 0) outConfig.whisperModel = cleanModel(wm);
	if (cm !== void 0) outConfig.chatModel = cleanModel(cm);
	if (cmr !== void 0) outConfig.chatMemoryRounds = Number(cmr);
	if (cil !== void 0) outConfig.chatImageLimit = Number(cil);
	const bodyOwned = new Set(["pets"]);
	if (ne !== void 0) bodyOwned.add("notificationsEnabled");
	if (wie !== void 0) bodyOwned.add("whisperImageEnabled");
	if (cie !== void 0) bodyOwned.add("chatImageEnabled");
	if (cts !== void 0) bodyOwned.add("confineToScreen");
	if (ph !== void 0) bodyOwned.add("physics");
	if (wm !== void 0) bodyOwned.add("whisperModel");
	if (cm !== void 0) bodyOwned.add("chatModel");
	if (cmr !== void 0) bodyOwned.add("chatMemoryRounds");
	if (cil !== void 0) bodyOwned.add("chatImageLimit");
	if (existing && typeof existing === "object") for (const key of Object.keys(existing)) {
		if (bodyOwned.has(key)) continue;
		outConfig[key] = existing[key];
	}
	return outConfig;
}
/**
* 同步用户层（POST /config，设置页「同步」）：把内置默认配置**原文**写入用户主配置文件。
*
* 为什么是"复制原文"而不是"删除用户层"（旧实现）：删掉之后用户手上没有配置文件，
* 想手改高级字段（physics / whisperPrompt / animations / memes / ...）就得自己从包内
* assets/config.jsonc 复制一份——这一步是死的、每次都要做。这里直接把那份文件（含全部
* 中文注释、全部字段）落到用户配置路径上：既等价于恢复默认（合并结果 = 内置默认），
* 又让用户拿到一份开箱可编辑的完整配置。
*
* 注释无害：读取侧统一走 readJsonc（stripJsonc 剥注释），带注释写入照样能读。
*
* 注意（调用方要在 UI 上讲清楚）：文件一旦生成即成为**显式覆盖层**——用户层写了什么就
* 覆盖内置默认的对应字段，所以插件升级改了内置默认后，这个文件里的旧值仍会继续生效。
*
* 默认文件缺失/目录不可写 → 直接抛（宿主回 500）：绝不静默留下半个配置文件。
*/
function syncUserConfigFromDefault(paths) {
	const raw = readFileSync(paths.defaultFile, "utf8");
	mkdirSync(dirname(paths.userFile), { recursive: true });
	writeFileSync(paths.userFile, raw, "utf8");
}
/**
* 对话记忆截取：从消息列表里取尾部 `rounds` 轮（1 轮 = 1 问 1 答 → 2 条）。
*
* 为什么单独抽一个函数：`rounds = 0` 表示「不带历史」。若直接写 `messages.slice(-rounds * 2)`，
* 会踩 JS 的 `-0` 陷阱——`-0 === 0`，`slice(-0)` 返回**整个数组**而不是空数组，
* 于是「关掉历史」反而变成「带全部历史」（用户实测：设 0 后问生日，10 秒后仍答得出）。
* 这里显式分支：0 → 空列表；> 0 → 截尾部。`rounds` 由合并器保证为非负有限数，
* 负数/NaN 兜底按 0 处理（不产出荒谬的 slice 行为）。
*/
function sliceMemoryRounds(messages, rounds) {
	return rounds > 0 ? messages.slice(-Math.floor(rounds) * 2) : [];
}
//#endregion
//#region .local/dsh-pet-windows/src/host/broadcast.ts
/**
* 第三方投喂（`POST /dsh-pet-7340/broadcast`）的**纯决策层**。
*
* 背景（issue #76）：宿主侧其他插件（女仆巡检验等）想说自己的话，需要一个把它们给的文本
* 放进桌宠气泡的入口。这个端点**不生成**内容，只搬运——和 /whisper（用 LLM 生成）分工不同。
*
* 为什么单独一层：本功能的契约就是这几条校验规则（文本非空、宠物必须真实存在、
* 配图必须命中包内表情包池），它们必须能脱离 HTTP 与真实文件系统被单测——路由层
* （src/host/index.ts）在源码形态下读不到包内 assets，测不了这些分支。
*
* 设计口径：
* - **不设长度限制，也不限频**：投喂是显式的调用方行为，内容与频率都由调用方自己负责；
*   宿主只保证"非空就搬运"，不做静默丢弃、截断或排队。
* - 配图只认**该桌宠条目表情包池内**的名称（池内命中即取其规范名）：杜绝第三方注入外部地址，
*   前端也就不会去加载任意 URL。与对话选图共用同一份 matchMeme 校验。
* - 失败一律返回明确 reason，不抛异常（路由据此回 HTTP 200 + ok:false，与 /chat 口径一致）。
* - memeDirs 是参数而非模块常量：池的目录链由调用方（host/index.ts 的 memeDirsFor）唯一决定，
*   便于测试注入临时目录（同 memes.ts 的约定）。
*/
/**
* 投喂文本规范化：非字符串 / 纯空白 → 空串。
* 路由与决策层**共用这一条规则**（路由用它先短路掉"空文本"，避免为了一个必然失败的
* 请求去读配置；两处若各写一遍就会走样）。
*/
function normalizeBroadcastText(text) {
	return typeof text === "string" ? text.trim() : "";
}
/**
* 把外部给的 `{ text, image }` 与当前配置核对成一个结论。
*
* @param cfg readAllConfig 的合并成品（所有字段已填满，这里不做兜底解析）
* @param requested `?pet=` 的原值（可为空串）
* @param active `resolveActivePetId()` 的结果（可为空串；无宠物时为空）
* @param text 外部给的文本（未规范化）
* @param image 外部给的配图名（未规范化；空/缺省 = 不配图）
* @param memeDirs 条目（素材根）→ 表情包目录链（顺序即优先级）；决定池里哪些图真实存在
*/
function decideBroadcast(args) {
	const { cfg, requested, active, memeDirs } = args;
	const text = normalizeBroadcastText(args.text);
	if (!text) return {
		ok: false,
		reason: "bad-request",
		message: "text 为空"
	};
	const petId = String(requested || active || "main");
	if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	const rawImage = typeof args.image === "string" ? args.image.trim() : "";
	if (!rawImage) return {
		ok: true,
		petId,
		text
	};
	const found = findPetInstance(cfg, petId);
	const hit = matchMeme(readMemePool((found ? found.conf : cfg.main ?? {}).memes, memeDirs(found ? found.entry : "main")), rawImage);
	if (!hit) return {
		ok: false,
		reason: "unknown-image",
		message: "配图不在表情包池内：" + rawImage
	};
	return {
		ok: true,
		petId,
		text,
		image: hit.name
	};
}
//#endregion
//#region .local/dsh-pet-windows/src/host/anim.ts
/**
* 播放动画（`POST /dsh-pet-7340/anim`）的**纯决策层**。
*
* 用途：宿主侧其他插件想让桌宠播一段动画（"点播"），效果与右键菜单里点「动作」树完全一致
* ——两端都复用同一个菜单动作处理函数，本模块只负责**判定该不该播、播哪一个**。
*
* 为什么单独一层：契约就是"名字必须在菜单能点到的集合里"。播放端对不存在的动画没有兜底
* （名字即文件名，404 → 加载失败 → 表现为"点了没反应"），所以名字校验是硬要求，且必须能
* 脱离 HTTP 单测。本模块只依赖配置（动画池都在 animations 里，不碰文件系统），可完全离线测。
*
* 允许集合 = 右键菜单三级树叶里所有 `anim` 的并集。菜单树的唯一事实来源是
* src/shared/menu.ts 的 buildMenuTree()，它取这 7 个池：idle / turn / drag / clicks /
* moves.actions / categories / events。
* **host 不 import src/shared**（DSH 单文件加载约束，见 index.ts 顶部说明），所以这里按同一
* 口径自包含实现一份；两边的守卫测试会同时钉住这份口径，任一侧改了池子就会有一边失败。
*/
/** 字符串数组收窄（配置里的池子；非数组/空串 → 空数组） */
function strings(v) {
	return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : [];
}
/**
* 该条目的 animations 配置 → 可点播的动画名（去重，保持首次出现顺序）。
* 池子与顺序对齐 src/shared/menu.ts 的 buildMenuTree()：
*   待机 → 转向 → 拖拽 → 点击回应 → 移动 → config 随机动作分类 → 事件（数组槽位展平）
*/
function animationNames(animations) {
	const a = animations && typeof animations === "object" ? animations : {};
	const out = [];
	const push = (names) => {
		for (const n of names) if (!out.includes(n)) out.push(n);
	};
	push(strings(a.idle));
	push(strings(a.turn));
	push(strings(a.drag));
	push(strings(a.clicks));
	const moves = a.moves && typeof a.moves === "object" ? a.moves : {};
	push(Array.isArray(moves.actions) ? moves.actions.map((m) => m && typeof m === "object" ? m.name : void 0).filter((x) => typeof x === "string" && x !== "") : []);
	if (Array.isArray(a.categories)) {
		for (const c of a.categories) if (c && typeof c === "object") push(strings(c.actions));
	}
	const events = a.events && typeof a.events === "object" ? a.events : {};
	for (const key of Object.keys(events)) {
		const pool = events[key];
		if (!Array.isArray(pool)) continue;
		const names = [];
		for (const slot of pool) if (typeof slot === "string") names.push(slot);
		else names.push(...strings(slot));
		push(names);
	}
	return out;
}
/**
* 把外部给的点播请求与当前配置核对成一个结论。
*
* @param cfg readAllConfig 的合并成品（所有字段已填满，这里不做兜底解析）
* @param requested `?pet=` 的原值（可为空串）
* @param active `resolveActivePetId()` 的结果（可为空串；无宠物时为空）
* @param name 外部给的动画名（未规范化）
*/
function decideAnim(args) {
	const { cfg, requested, active } = args;
	const name = typeof args.name === "string" ? args.name.trim() : "";
	if (!name) return {
		ok: false,
		reason: "bad-request",
		message: "name 为空"
	};
	const petId = String(requested || active || "main");
	if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	const conf = (findPetInstance(cfg, petId) ?? { conf: cfg.main ?? {} }).conf;
	if (!animationNames(conf.animations).includes(name)) return {
		ok: false,
		reason: "unknown-animation",
		message: "没有这个动画：" + name
	};
	return {
		ok: true,
		petId,
		name
	};
}
//#endregion
//#region .local/dsh-pet-windows/src/host/work-status.ts
/**
* turn/end reason.kind → 状态：
*   completed → success、错误系（error/max-tokens/timeout）→ error、blocked → waiting（回合被阻塞，等用户确认）；
*   其余（aborted 等）→ null＝该会话回合已结束，由调用方清理会话回空闲——绝不残留上一档
*   （否则回合被打断后会永远卡在 working，即当年"这一步正在进行中哦"挂死的根因）。
*/
function turnEndState(kind) {
	if (kind === "completed") return "success";
	if (kind === "error" || kind === "max-tokens" || kind === "timeout") return "error";
	if (kind === "blocked") return "waiting";
	return null;
}
/** ask_user_question 工具名：模型在等用户选择题答复 → 归为 waiting（等待确认）而非普通工作 */
const USER_QUESTION_TOOL$1 = "ask_user_question";
/** 解析 update_goal 的 arguments（原始 JSON 字符串）→ 收尾动作；解析失败/非收尾动作 → null */
function goalUpdateAction(args) {
	try {
		const o = JSON.parse(args);
		const action = String(o?.action ?? "");
		if (action === "complete" || action === "blocked") return action;
	} catch {}
	return null;
}
/**
* turn/end reason=completed 的终局判定：
*   - 非 goal 轮（默认）→ success（原行为：一轮答完即成功）；
*   - 自动续跑轮中间轮（goalRound && 未收尾）→ result：本轮完成 ≠ 整个任务完成，不庆祝；
*   - 收尾轮 complete → success（整个目标达成，庆祝）；
*   - 收尾轮 blocked → error（目标被阻塞结束，诚实地表沮丧而非庆祝）。
*/
function completedState(turn) {
	if (!turn?.goalRound) return "success";
	if (turn.closing === "blocked") return "error";
	if (turn.closing === "complete") return "success";
	return "result";
}
/** 从会话事件压缩出工作状态；无变化/不关心返回 null。
*  turn 为当前回合上下文（goal 续跑轮判定），只影响 turn/end completed 的终局语义。 */
function reduceWorkStatus(event, turn) {
	switch (event?.type) {
		case "turn/start": return "thinking";
		case "tool/call":
			if (String(event?.data?.name ?? "") === USER_QUESTION_TOOL$1) return "waiting";
			return "working";
		case "tool/result": return "result";
		case "approval/asked": return "waiting";
		case "turn/end": {
			const reason = turnEndState(String(event?.data?.reason?.kind ?? ""));
			if (reason === "success") return completedState(turn);
			return reason;
		}
		default: return null;
	}
}
/**
* todo/write 的 in_progress/pending 项文本 → 任务详情；null = 无（清单已全部完成）。
*
* 取**最后一个** in_progress（最近开始的那一步），而不是第一个：agent 常把新步骤标成 in_progress
* 却忘了把上一步标 completed，取第一个就会永远停在最早那步——issue #59 场景 1（分阶段任务文案
* 不随进度变化）的成因。没有进行中的项时回落到第一个 pending（= 下一步要做的）。
*/
function currentTaskFromTodo(event) {
	const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
	let current;
	for (const t of todos) if (t?.status === "in_progress") current = t;
	if (!current) current = todos.find((t) => t?.status === "pending");
	const content = String(current?.content ?? "").trim();
	if (!content) return null;
	const points = Array.from(content);
	return points.length > 40 ? `${points.slice(0, 40).join("")}…` : content;
}
/** 展示优先级：waiting > error > working > thinking > result > success
*  （result 高于 success：任何会话的进行中过渡态都不被别处已完成态压过，防中途庆祝；同档按最近更新优先） */
const WORK_STATUS_PRIORITY = {
	waiting: 60,
	error: 50,
	working: 40,
	thinking: 30,
	result: 25,
	success: 20
};
/** 展示用条目：所有会话里优先级最高者（同优先级取 seq 更大者）；无会话 → undefined */
function pickDisplayed(entries) {
	let best;
	for (const entry of entries) if (!best || WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] || WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq) best = entry;
	return best;
}
/**
* 工作状态聚合（纯逻辑，可单测）：按会话维护 state/task，对外只暴露一个展示快照。
*
* 为什么 task 必须挂在会话条目上（issue #59 的主因）：它原先是一个**全局单值**，只由 todo/write
* 写入、没有任何独立于 todo/write 的生命周期，于是 agent 写过一次清单之后，这条文案就跟着此后
* 所有会话活动一直显示——会话结束、开一段完全无关的新对话都不消失，配置里的 workStatusTexts
* 档位文案也被永久屏蔽。挂进条目后文案与它的会话**同生共死**：
*   - 条目被清（回合中断 / 终态过期）→ 文案随之消失；
*   - 新一轮 turn/start → 由调用方清空（上一轮的详情不该在新一轮继续挂着）；
*   - 清单里再无 in_progress/pending → 写成 null，回落档位文案。
* 展示时 state 与 task 取自**同一个** best 会话，因此也不会再出现"A 会话的状态配 B 会话的文案"。
*/
var WorkStatusStore = class {
	constructor() {
		this.sessions = /* @__PURE__ */ new Map();
		this.snap = {
			state: null,
			task: null,
			ts: 0
		};
	}
	/** 该会话当前是否有活动条目（决定 todo/write 是否还值得更新它的文案） */
	has(sessionId) {
		return this.sessions.has(sessionId);
	}
	/** 该会话当前档位（无条目 / 已清 → undefined） */
	stateOf(sessionId) {
		return this.sessions.get(sessionId)?.state;
	}
	/** 写会话状态（保留该会话已有的 task）；同状态且 seq 不更新 → 无变化返回 false（防刷屏） */
	setState(sessionId, state, seq = 0) {
		const prev = this.sessions.get(sessionId);
		if (prev?.state === state && prev.seq >= seq) return false;
		this.sessions.set(sessionId, {
			state,
			seq,
			task: prev?.task ?? null
		});
		this.refresh();
		return true;
	}
	/** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动（它不会被展示） */
	setTask(sessionId, task) {
		const prev = this.sessions.get(sessionId);
		if (!prev || prev.task === task) return false;
		this.sessions.set(sessionId, {
			...prev,
			task
		});
		this.refresh();
		return true;
	}
	/** 清掉某会话（回合结束 / 终态过期）：它的 task 一并消失，不会残留到后续活动里 */
	clear(sessionId) {
		if (!this.sessions.delete(sessionId)) return false;
		this.refresh();
		return true;
	}
	/** 展示快照（对象引用稳定，供 /work-status 直接序列化） */
	snapshot() {
		return this.snap;
	}
	/** 重算展示：state 与 task **任一**变化才更新 ts（轮询侧据此触发，两端都靠它刷新） */
	refresh() {
		const best = pickDisplayed(this.sessions.values());
		const nextState = best?.state ?? null;
		const nextTask = best?.task ?? null;
		if (nextState === this.snap.state && nextTask === this.snap.task) return;
		this.snap.state = nextState;
		this.snap.task = nextTask;
		this.snap.ts = Date.now();
	}
};
//#endregion
//#region .local/dsh-pet-windows/src/host/notify-events.ts
/**
* 这条会话的事件该不该变成通知。
*
* 子代理（`origin === 'subagent'`）与更深层委派（`delegationDepth > 0`）一律不发：
* 你等的是父对话，不是某一路子代理跑完。实测 3 个子代理会连弹 3 条「对话完成」，
* 而宿主的 298 条会话里 198 条是子代理——通知直接变刷屏（issue #82）。
*
* **判据必须是 `origin`，绝不能用 `parentSession`。** 宿主 `parentSession` 的语义是
* "fork 自哪条会话"（SessionHeader 注释原文：*the session this one was forked from*），
* 普通 fork 也带它——本机实测正在对话的那条主会话就是 fork，`parentSession` 有值而
* `origin` 为空。用它判子代理会把主对话一起静音。官方 dsh-subagent 的归档准入是同一套判据：
* *"A fork shares the lineage field without the origin"*（archive-admission.js）。
*
* 判据不可用（session / header 缺失或形状不对）→ **放行**：宁可多弹一条，
* 也不能因为宿主换了字段形状就让通知整体失效。
*/
function shouldNotifySession(session) {
	const header = session?.header;
	if (!header || typeof header !== "object") return true;
	if (header.origin === "subagent") return false;
	const depth = header.delegationDepth;
	if (typeof depth === "number" && Number.isFinite(depth) && depth > 0) return false;
	return true;
}
/** turn/end reason.kind → 通知类别；不弹的分支返回 null（与 shared/notify.ts 过滤一致） */
function turnEndNotifyKind(kind) {
	if (kind === "completed") return "completed";
	if (kind === "error" || kind === "max-tokens") return kind;
	return null;
}
/** ask_user_question 工具名（与 work-status.ts 同源；该工具触发时模型在等用户选择题答复） */
const USER_QUESTION_TOOL = "ask_user_question";
/** 解析 tool/call 的 arguments（JSON 字符串）→ questions 数组；解析失败/非数组 → null */
function parseToolQuestions(args) {
	if (typeof args !== "string") return null;
	try {
		const questions = JSON.parse(args)?.questions;
		if (!Array.isArray(questions)) return null;
		return questions;
	} catch {
		return null;
	}
}
/**
* 把一条 session/event 子事件压缩成通知帧；不关心/过滤型事件返回 null。
* 帧形状与 shared/notify.ts 的 frameToToast 期望完全一致（浏览器侧映射零改动）。
* data 按宽松 Record 接收（approval/asked 的 reason 是字符串、turn/end 的是对象），内部各自安全取值。
*/
function reduceNotifyFrame(event) {
	if (!event?.type) return null;
	switch (event.type) {
		case "turn/end": {
			const reason = event.data?.reason;
			if (!turnEndNotifyKind(reason?.kind)) return null;
			return {
				type: "session/event",
				event: {
					type: "turn/end",
					data: { reason }
				}
			};
		}
		case "approval/asked": {
			const data = event.data ?? {};
			return {
				type: "approval/requested",
				...typeof data.toolName === "string" && data.toolName ? { toolName: data.toolName } : {},
				...typeof data.reason === "string" && data.reason ? { reason: data.reason } : {}
			};
		}
		case "tool/call": {
			if (String(event.data?.name ?? "") !== USER_QUESTION_TOOL) return null;
			const questions = parseToolQuestions(event.data?.arguments);
			if (!questions || questions.length === 0) return null;
			return {
				type: "question/requested",
				questions
			};
		}
		default: return null;
	}
}
/** agent/error（无回合位置的失败）→ host/agent-error 帧（与 shared 期望的 message 字段一致） */
function agentErrorFrame(error) {
	return {
		type: "host/agent-error",
		message: typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "")
	};
}
//#endregion
//#region .local/dsh-pet-windows/src/host/storage-paths.ts
/**
* 插件存储位置清单（设置页「卸载与存储」区块的数据源）。
*
* 这四类位置分属互不相干的基准目录，本模块按「谁写得进谁说了算」分两种来源：
*
*   1) 直接吃真实写入方给的路径（零重复，不存在漂移）：
*      - 用户数据    ← 调用方传 index.ts 的 userRoot（拼 'dsh-pet' 的地方只有那一处）
*      - Electron    ← 调用方传 helper-process.ts 的 electronLandingDir()（下载方的唯一定义）
*
*   2) 系统规则，本模块按平台镜像一份（写入方不是本仓库的代码，无法调用）：
*      - 桌面端 userData  ← Electron 的 app.getPath('userData')
*      - Electron 下载缓存 ← @electron/get 默认 cacheRoot = env-paths('electron').cache
*
* 第 2 类里唯一能靠调用消掉的字面量是桌面端应用名（main.js 的 app.setName），
* 但那个文件是独立 CJS（无构建、不可 import），只能在两处各写一遍——
* storage-paths.test.ts 直接读 main.js 校验它，改了不同步就红。
* 第 2 类的其余部分（env-paths 的平台口径、Electron 的 userData 口径）是上游约定，
* 用逐平台用例钉住；上游若改口径，这里必须跟着改（测试只保证我们自己没写错）。
*
* 本模块只做路径推导，不复制任何写入逻辑。
*/
/** 桌面端 Electron userData 目录名（= main.js 的 app.setName 入参） */
const DESKTOP_APP_NAME = "dsh-pet-electron-helper";
/** Electron 下载缓存的应用名（@electron/get 写死 env-paths('electron')，与插件名无关） */
const ELECTRON_PATHS_NAME = "electron";
/**
* 桌面端 userData 目录（Electron app.getPath('userData') 的等价推导）。
*
* 与 Electron 的口径逐平台对齐：
*   win32  = %APPDATA%\<name>（appData 在 Windows 就是 Roaming）
*   darwin = ~/Library/Application Support/<name>
*   linux  = $XDG_CONFIG_HOME/<name>，未设则 ~/.config/<name>
*/
function desktopUserDataDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), DESKTOP_APP_NAME);
	if (platform === "darwin") return join(home, "Library", "Application Support", DESKTOP_APP_NAME);
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), DESKTOP_APP_NAME);
}
/**
* Electron 安装包下载缓存目录（@electron/get 默认 cacheRoot = env-paths('electron').cache）。
*
* env-paths 的口径：win32 在 LOCALAPPDATA 下多一层 Cache，macOS 用 ~/Library/Caches，
* Linux 用 $XDG_CACHE_HOME（默认 ~/.cache）——都是「应用名单独一层」。
* 该目录与其它用 @electron/get 的工具共用，删掉只是下次重新下载。
*/
function electronCacheDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), ELECTRON_PATHS_NAME, "Cache");
	if (platform === "darwin") return join(home, "Library", "Caches", ELECTRON_PATHS_NAME);
	return join(env.XDG_CACHE_HOME || join(home, ".cache"), ELECTRON_PATHS_NAME);
}
/**
* 插件在本机落盘的全部位置（顺序即设置页展示顺序：先用户数据，后运行时与缓存，最后插件本体）。
*
* 前两条直接取真实写入方的路径（userDataRoot / electronDir 由调用方从写盘方传入），
* 只有系统级目录（桌面端 userData 与 Electron 下载缓存）由本模块按平台推导。
* @param input 各基准目录与平台/环境（测试注入）
* @returns 条目数组；exists 由当前磁盘状态即时判定
*/
function storageEntries(input) {
	return [
		{
			key: "userData",
			path: input.userDataRoot
		},
		{
			key: "electron",
			path: input.electronDir
		},
		{
			key: "desktopCache",
			path: desktopUserDataDir(input)
		},
		{
			key: "electronCache",
			path: electronCacheDir(input)
		},
		{
			key: "package",
			path: input.packageRoot
		}
	].map((it) => ({
		...it,
		exists: existsSync(it.path)
	}));
}
/**
* 从本包路径反推 profile 名（设置页拼卸载命令用）。
*
* 常规安装形态是 <$DSH_HOME>/profiles/<name>/node_modules/dsh-pet；命中即得 <name>。
* 反推不出来的情况（link: 安装到别处、或装在 profiles/node_modules 共享层）返回 undefined，
* 由客户端退回占位符——宁可不给具体名字，也不猜一个错的。
* @param packageRoot 本包根目录
* @returns profile 名，或 undefined
*/
function profileNameFrom(packageRoot) {
	return /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(packageRoot)?.[1];
}
//#endregion
//#region .local/dsh-pet-windows/src/host/state.ts
/** 空叶子：counter=0 表示"从未写过"——前端首拉把它当基线，之后 counter 变化才渲染 */
const emptyLeaf = () => ({
	counter: 0,
	data: null
});
/** 轮询统一状态存储（一个插件实例一个；进程内内存态，重启即空） */
var PollStateStore = class {
	constructor() {
		this.last = 0;
		this.sections = {
			balance: emptyLeaf(),
			workStatus: emptyLeaf(),
			notify: emptyLeaf()
		};
		this.pets = /* @__PURE__ */ new Map();
	}
	/** 下一个 counter：`Date.now()` 与「上一个 +1」取大——单调、不回退、同毫秒不重复 */
	next() {
		this.last = Math.max(Date.now(), this.last + 1);
		return this.last;
	}
	/**
	* 写一个全局叶子（余额 / 工作状态 / 通知）。
	* 每次都整体替换叶子对象（不原地改字段），保证 `read()` 拿到的引用不会半新半旧。
	*/
	writeSection(name, data) {
		this.sections[name] = {
			counter: this.next(),
			data
		};
	}
	/** 写一只宠物的叶子（宠物条目不存在则自动建立，两个槽位一起建好，形状恒定） */
	writePet(petId, leaf, data) {
		let entry = this.pets.get(petId);
		if (!entry) {
			entry = {
				say: emptyLeaf(),
				anim: emptyLeaf()
			};
			this.pets.set(petId, entry);
		}
		entry[leaf] = {
			counter: this.next(),
			data
		};
	}
	/**
	* 当前 S（GET /state 的响应体）。
	* 返回的 sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
	* 所以消费端不会读到写了一半的叶子。
	*/
	read() {
		return {
			sections: { ...this.sections },
			pets: Object.fromEntries(this.pets)
		};
	}
};
//#endregion
//#region .local/dsh-pet-windows/src/host/window-activation.ts
/** Create one activation caller; dispose rejects outstanding requests and detaches listeners. */
function windowActivation(transport, deadlineMs = 2e3) {
	let nextId = 1;
	let disposed = false;
	const pending = /* @__PURE__ */ new Map();
	const unavailable = () => /* @__PURE__ */ new Error("Desktop window activation is unavailable");
	const disconnect = () => {
		for (const request of pending.values()) request.reject(unavailable());
	};
	const message = (input) => {
		if (typeof input !== "object" || input === null || !("type" in input) || input.type !== "window-activated" || !("requestId" in input) || typeof input.requestId !== "number" || !Number.isSafeInteger(input.requestId) || "error" in input && typeof input.error !== "string") return;
		const request = pending.get(input.requestId);
		if ("error" in input) request?.reject(new Error(input.error));
		else request?.resolve();
	};
	transport.on("message", message);
	transport.on("disconnect", disconnect);
	return {
		async activate() {
			if (disposed || !transport.connected) throw unavailable();
			const requestId = nextId++;
			let timer;
			try {
				await new Promise((resolve, reject) => {
					pending.set(requestId, {
						resolve,
						reject
					});
					timer = setTimeout(() => reject(/* @__PURE__ */ new Error("Desktop window activation timed out")), deadlineMs);
					try {
						transport.send({
							type: "activate-window",
							requestId
						}, (error) => {
							if (error !== null) reject(error);
						});
					} catch (error) {
						reject(error);
					}
				});
			} finally {
				clearTimeout(timer);
				pending.delete(requestId);
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			transport.off("message", message);
			transport.off("disconnect", disconnect);
			disconnect();
		}
	};
}
//#endregion
//#region .local/dsh-pet-windows/src/host/helper-process.ts
/**
* 桌面 Helper 进程管理器 —— 拉起/守护 Electron 透明窗口进程。
*
* 架构：Helper 与宿主之间除了日志，还有一条 **stdin/stdout JSON 行协议**（bridge）：
*   - 渲染端不再直接访问 DSH WebServer（DSH Desktop 2.0.3+ 的浏览器访问闸门会给插件自拉的
*     独立进程裸 HTTP 请求回 403），改走自定义 scheme `dsh-pet-bridge://` → Electron 主进程
*     （main.js 的 protocol.handle）→ 本模块的管道 → 宿主 handlePetRoute（与 HTTP 路由同一份逻辑）。
*   - 协议行统一前缀 `dsh-pet-bridge:`，与普通日志行区分（main.js 的 console 输出也走 stdout）。
*   - 素材（webm/字体/光标）不把二进制过管道：宿主返回文件绝对路径，main.js 自行读盘应答。
* 本文件负责解析 Electron 可执行文件、以子进程方式拉起 electron-helper/main.js、
* 守护协议通道、并在异常退出时自动重启。
*/
const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultHelperMain = resolve(packageRoot, "runtime", "electron-helper", "main.js");
/** 协议行前缀：stdout/stdin 里以此开头的整行 JSON 属于 bridge 协议，其余为日志 */
const BRIDGE_PREFIX = "dsh-pet-bridge:";
/**
* 解析 Electron 可执行文件。
* 优先级：
*   1. 显式候选（用户配置）/ DSH_PET_ELECTRON_PATH 环境变量
*   2. 本机已安装的 electron npm 包（require('electron') 返回二进制路径）
*   3. $DSH_HOME/electron（默认 ~/.dsh/electron）—— ensureElectronDownload 的落地路径
*   4. 都不存在时由 ensureElectronDownload() 进程内异步下载（不 spawn 子进程，
*      避免 process.execPath 在 Electron 宿主（如 DSH Desktop）里指向宿主 exe 导致崩溃）
*/
function resolveElectronPath(candidates = []) {
	const seen = /* @__PURE__ */ new Set();
	const list = [];
	const push = (value) => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		list.push(value);
	};
	for (const value of candidates) push(value);
	if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
	try {
		const resolved = require("electron");
		if (typeof resolved === "string" && resolved) push(resolved);
	} catch {}
	push(defaultElectronExe());
	return list.find((value) => existsSync(value));
}
/** $DSH_HOME（默认 ~/.dsh），与 ensure-electron.mjs 的 HOME 计算一致。 */
/**
* 判断当前环境能否真的跑起 Electron 图形窗口。
*
* 【为什么需要】Linux 无显示环境（服务器 / 容器 / 纯 CLI）下，Electron 能被成功
* 下载并 spawn 拉起，但初始化图形栈时立刻崩溃。配合 Helper 的守护循环
* （异常退出自动重启），结果是每秒反复「拉起→崩溃→重启」，每个 core dump
* 约 14MB —— 实测几小时可堆到数十 GB 打满磁盘。必须在拉起之前判断。
*
* 判定口径（只拦「明确跑不起来」的情况）：
*   - win32 / darwin：桌面系统，放行（macOS 无 DISPLAY 也走 WindowServer）；
*   - linux：需要 DISPLAY 或 WAYLAND_DISPLAY 其一，都没有则判为无显示环境。
*
* 【逃生口】DSH_PET_DESKTOP_FORCE=1 强制跳过，供 Xvfb / 远程桌面等
* 「环境变量没设但其实能显示」的场景使用。
*/
function hasGraphicalDisplay() {
	if (process.platform !== "linux") return true;
	if (process.env.DSH_PET_DESKTOP_FORCE === "1") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
function dshHomeDir() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	return process.env.DSH_HOME || join(userProfile, ".dsh");
}
/** 当前平台标识（win32 / darwin / linux） */
const PLAT = process.platform;
/** $DSH_HOME/electron 落地目录下，可执行文件的相对路径（按平台） */
const ELECTRON_REL = PLAT === "win32" ? "electron.exe" : PLAT === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron";
/**
* Electron 运行时落地目录（$DSH_HOME/electron）—— 下载解压的目标，
* 也是设置页「卸载与存储」里让用户清理的那个目录。
*
* 唯一定义处：解析（resolveElectronPath / defaultElectronExe）与下载
* （ensureElectronDownload）全部走这里，避免同一个目录字面量在多个模块各写一遍，
* 改了一处而另一处没改（设置页就会显示一个永远不存在的路径）。
*/
function electronLandingDir() {
	return join(dshHomeDir(), "electron");
}
/** Electron 落地路径：$DSH_HOME/electron/<按平台的可执行文件>。 */
function defaultElectronExe() {
	return join(electronLandingDir(), ELECTRON_REL);
}
/**
* 进程内下载并解压 Electron 到 $DSH_HOME/electron。
* 不 spawn 子进程：在 CLI node 与 Electron 宿主（DSH Desktop）里都可用，
* 修复原 ensure-electron.mjs 用 process.execPath 调脚本导致宿主重复拉起的问题。
* 已存在则原样返回；失败返回 undefined（不影响 DSH 与浏览器 overlay）。
*/
async function ensureElectronDownload(options = {}) {
	const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || "43.3.0";
	const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
	const timeoutMs = options.timeoutMs ?? 600 * 1e3;
	const targetDir = electronLandingDir();
	const exe = defaultElectronExe();
	if (existsSync(exe)) return exe;
	const log = (message) => console.log(`[dsh-pet] ${message}`);
	const warn = (message) => console.warn(`[dsh-pet] ${message}`);
	const startedAt = Date.now();
	log(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`);
	mkdirSync(targetDir, { recursive: true });
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`Electron download timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
		let nextLogAt = Date.now() + 3e3;
		try {
			const zipPath = await downloadArtifact({
				version: `v${version}`,
				artifactName: "electron",
				mirrorOptions: { mirror: mirror.replace(/\/$/, "") + "/" },
				downloadOptions: {
					signal: controller.signal,
					quiet: true,
					getProgressCallback: async (progress) => {
						const now = Date.now();
						if (!progress.total || now < nextLogAt) return;
						nextLogAt = now + 3e3;
						log(`downloading ${(progress.transferred / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB`);
					}
				}
			});
			log(`download complete (${((Date.now() - startedAt) / 1e3).toFixed(1)}s), extracting to ${targetDir} ...`);
			await extract(zipPath, { dir: targetDir });
			if (!existsSync(exe)) throw new Error(`Electron zip extracted, but ${ELECTRON_REL} not found`);
			log(`ready in ${((Date.now() - startedAt) / 1e3).toFixed(1)}s: ${exe}`);
			return exe;
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		warn(`ensure failed: ${error instanceof Error ? error.message : String(error)}`);
		warn("desktop pet unavailable. Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.");
		return;
	}
}
function defaultLaunch(options = {}) {
	const electronPath = resolveElectronPath([options.electronPath]);
	if (!electronPath) throw new Error("dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.");
	return {
		command: electronPath,
		args: [options.helperPath || defaultHelperMain]
	};
}
/** 停止 helper 的等待上限（ms）：超过就升级 SIGKILL（issue #64） */
const HELPER_STOP_TIMEOUT_MS = 3e3;
/** SIGKILL 之后还给进程多久退出（ms）；到点仍未退出就放弃等待，绝不无限挂住调用方 */
const HELPER_STOP_GRACE_MS = 1e3;
/**
* spawn helper 用的环境变量（纯函数，可独立测试）。
*
* **必须删掉 `ELECTRON_RUN_AS_NODE`**（issue #63）：宿主自己可能就是个 Electron 应用（DSH Desktop），
* 它的 `process.env` 里可能带着这个变量；原样透传会让我们 spawn 的 Electron 以**纯 Node 模式**启动——
* 内置 `electron` 模块根本不注册，main.js 顶部 `require('electron')` 直接 MODULE_NOT_FOUND →
* helper 崩 → 守护循环重启 → 12 次熔断 → 桌面模式彻底不再出现，且没有任何用户可见提示。
*
* 为什么是"删除"而不是设成空串：Electron 只看这个变量**存不存在**。实测 Electron 43.3.0（Windows，
* 与插件用的是同一份二进制）：删除 → `process.type=browser`、`require('electron')` 正常拿到 app；
* 设 `''` → 直接 abort（exit 134，`node::CreateEnvironment` 断言失败）；设 `'0'`/`'false'`/`'1'` →
* 都进纯 Node 模式。运行期再 `delete process.env` 已经晚了（模块加载器在进程启动瞬间就定了）。
*/
function helperSpawnEnv(hostPid, extra) {
	const env = {
		...process.env,
		DSH_PET_HOST_PID: String(hostPid),
		...extra
	};
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}
var HelperProcess = class {
	constructor(options = {}, logger = console) {
		this.options = options;
		this.logger = logger;
		this.child = void 0;
		this.stopping = false;
		this.restartTimer = void 0;
		this.restartFailures = 0;
		this.lastStartAt = 0;
		this.stdoutBuffer = "";
	}
	start() {
		if (this.child || this.stopping) return this.child;
		this.lastStartAt = Date.now();
		const helperPath = this.options.helperPath || defaultHelperMain;
		const launch = this.options.command ? {
			command: this.options.command,
			args: this.options.args || [helperPath]
		} : defaultLaunch(this.options);
		const command = launch.command;
		const child = spawn(command, this.options.args || launch.args, {
			cwd: this.options.cwd || packageRoot,
			env: helperSpawnEnv(process.pid, this.options.env),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		child.once("error", (error) => {
			this.logger.error?.(`dsh-pet desktop helper failed to start: ${error.message}`);
		});
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = void 0;
			if (!this.stopping) {
				this.logger.warn?.(`dsh-pet desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`);
				this.scheduleRestart();
			}
		});
		child.stdout.on("data", (chunk) => {
			this.onStdoutChunk(String(chunk));
		});
		child.stderr.on("data", (chunk) => {
			const line = String(chunk).trim();
			if (line) this.logger.warn?.(`[dsh-pet desktop helper] ${line}`);
		});
		child.stdin?.on("error", () => {});
		return child;
	}
	/** stdout 按行缓冲：`dsh-pet-bridge:` 前缀整行 = 协议请求，其余 = 日志行 */
	onStdoutChunk(chunk) {
		this.stdoutBuffer += chunk;
		let nl;
		while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed.startsWith("dsh-pet-bridge:")) {
				this.handleBridgeLine(trimmed);
				continue;
			}
			this.logger.debug?.(`[dsh-pet desktop helper] ${trimmed}`);
		}
	}
	/** 处理一条协议请求：交给宿主 bridgeHandler，结果按 id POST 回 main.js 的回调服务器
	*  （cb 由请求行携带；不走 stdin —— Electron 主进程收不到 piped stdin） */
	async handleBridgeLine(line) {
		if (!this.child?.stdin || !this.options.bridgeHandler) return;
		let req;
		try {
			req = JSON.parse(line.slice(15));
		} catch {
			this.logger.warn?.("[dsh-pet desktop helper] bridge 协议行非法，已忽略");
			return;
		}
		if (typeof req.id !== "number") return;
		try {
			const resp = await this.options.bridgeHandler(req);
			this.sendBridgeResponse(req, resp);
		} catch (e) {
			this.sendBridgeResponse(req, {
				id: req.id,
				status: 500,
				contentType: "application/json; charset=utf-8",
				body: JSON.stringify({ error: `bridge handler error: ${e instanceof Error ? e.message : String(e)}` })
			});
		}
	}
	/** 把应答发回 main.js：优先 POST 到请求行携带的 cb（本地回调服务器）；无 cb 时回写 stdin（低版本兼容） */
	sendBridgeResponse(req, resp) {
		const cb = typeof req.cb === "string" && /^https?:[/][/]/.test(req.cb) ? req.cb : "";
		if (cb) {
			fetch(cb, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(resp)
			}).catch(() => {});
			return;
		}
		const child = this.child;
		if (!child?.stdin || child.stdin.destroyed) return;
		try {
			child.stdin.write(BRIDGE_PREFIX + JSON.stringify(resp) + "\n");
		} catch {}
	}
	/** 停止 helper：发 SIGTERM 即返回，**不等它退出**。宿主退出/插件卸载路径用它——
	*  宿主马上就没了（Windows 有 job 对象、POSIX 有 helper 自己的 host-liveness 兜底，见 issue #56）。
	*  **停止后要立刻重启的场景必须用 stopAndWait()**，否则新旧进程会短暂重叠（issue #64）。 */
	stop(reason = "plugin-disposed") {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = void 0;
		this.logger.debug?.(`dsh-pet desktop helper stopping (${reason})`);
		const child = this.child;
		if (!child) return;
		child.kill();
	}
	/**
	* 停止 helper 并**等它真正退出**（issue #64）：原实现只发一次 SIGTERM 就返回、紧接着 spawn 新进程，
	* 而 Electron 收到 SIGTERM 后关窗、销毁 GPU/动画合成器是异步的（几百 ms 起）——旧窗口（旧大小）
	* 还没消失、新窗口（新大小）已经画出来，桌面上就短暂出现"两只宠物"。
	*   ① 先置 `stopping`（由 stop() 完成）：守护逻辑不得把这次主动停止误判成崩溃去自动重启；
	*   ② 只等 `exit`，**不等 `close`**：stdio 管道关闭远早于进程真正退出（实测 SIGTERM 后 ~10ms 就触发）；
	*   ③ 超时（默认 3s）升级 SIGKILL；SIGKILL 后再给 1s 宽限，仍未退出就放弃等待——
	*      配置保存绝不能因为一个退不掉的子进程而被无限挂住。
	*/
	async stopAndWait(reason = "plugin-disposed", timeoutMs = HELPER_STOP_TIMEOUT_MS) {
		this.stop(reason);
		const child = this.child;
		if (!child) return;
		await waitForChildExit(child, timeoutMs, () => {
			this.logger.warn?.(`dsh-pet desktop helper 未在 ${timeoutMs}ms 内退出，升级 SIGKILL（${reason}）`);
			try {
				child.kill("SIGKILL");
			} catch {}
		});
	}
	scheduleRestart() {
		if (this.restartTimer || this.stopping) return;
		if (helperRunIsStable(Date.now() - this.lastStartAt)) this.restartFailures = 0;
		else this.restartFailures += 1;
		if (shouldCircuitBreak(this.restartFailures, this.resolveMaxFailures())) {
			this.logger.error?.(`dsh-pet desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped, no more restarts. Fix the environment (e.g. DISPLAY/headless) or set DSH_PET_RESTART_MAX_FAILURES to raise the limit.`);
			return;
		}
		const base = this.resolveRestartBaseMs();
		const delay = restartBackoffDelayMs(this.restartFailures - 1, base);
		this.logger.warn?.(`dsh-pet desktop helper exited; restarting in ${Math.round(delay)}ms (attempt ${this.restartFailures}, consecutive-crash limit ${this.resolveMaxFailures()})`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			this.start();
		}, delay);
		this.restartTimer.unref?.();
	}
	/** 退避基值：DSH_PET_RESTART_BASE_MS（ms，>0）可调，默认 750。 */
	resolveRestartBaseMs() {
		return envPositiveInt(process.env.DSH_PET_RESTART_BASE_MS, RESTART_BASE_MS_DEFAULT);
	}
	/** 熔断阈值：DSH_PET_RESTART_MAX_FAILURES（次，>0）可调，默认 12。 */
	resolveMaxFailures() {
		return envPositiveInt(process.env.DSH_PET_RESTART_MAX_FAILURES, RESTART_MAX_FAILURES_DEFAULT);
	}
};
/**
* 等子进程真正退出（issue #64 的"停止要等干净"那一步）：
*   - 已经退出（exitCode/signalCode 有值）→ 立即 resolve，不挂监听；
*   - 只等 `exit`：`close` 只代表 stdio 管道关闭，远早于进程真正退出；
*   - 到 timeoutMs 调 onTimeout()（调用方升级 SIGKILL），再给 HELPER_STOP_GRACE_MS 宽限；
*   - 宽限到点仍未退出就 resolve——调用方（配置保存触发的重启）绝不能被无限挂住。
*/
function waitForChildExit(child, timeoutMs, onTimeout) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		let giveUpTimer;
		const done = () => {
			clearTimeout(killTimer);
			if (giveUpTimer) clearTimeout(giveUpTimer);
			child.removeListener("exit", done);
			resolve();
		};
		const killTimer = setTimeout(() => {
			onTimeout();
			giveUpTimer = setTimeout(done, HELPER_STOP_GRACE_MS);
			giveUpTimer.unref?.();
		}, timeoutMs);
		killTimer.unref?.();
		child.once("exit", done);
	});
}
/** 稳定运行判定阈值：Helper 连续无崩溃运行 ≥ 3 分钟后，重启失败计数清零。 */
const HELPER_STABLE_MS = 180 * 1e3;
/**
* 指数退避：第 n 次（0 起）失败后等待 base × 2ⁿ，封顶 30s。
* 默认 base 750ms 保持与旧版首延一致，序列：750 → 1500 → 3000 → … → 30000。
*/
function restartBackoffDelayMs(consecutiveFailures, baseMs = 750) {
	const MAX = 3e4;
	const raw = baseMs * 2 ** Math.max(0, consecutiveFailures);
	return Math.min(raw, MAX);
}
/** 熔断判定：连续崩溃 ≥ limit（默认 12，按默认退避累计约 3 分钟）次后不再自动重启。 */
function shouldCircuitBreak(consecutiveFailures, limit = 12) {
	return consecutiveFailures >= limit;
}
/** 稳定运行判定：距上次拉起 ≥ HELPER_STABLE_MS 视为一次「成功运行」，可清零计数。 */
function helperRunIsStable(elapsedMs) {
	return elapsedMs >= HELPER_STABLE_MS;
}
/** 退避基值（ms）：默认 750 与旧版首延一致，DSH_PET_RESTART_BASE_MS 可调。 */
const RESTART_BASE_MS_DEFAULT = 750;
/** 熔断阈值（连续崩溃次数）：默认 12，DSH_PET_RESTART_MAX_FAILURES 可调。 */
const RESTART_MAX_FAILURES_DEFAULT = 12;
/** 非负整数 env 解析（非法/未设回落默认），供重启参数读取共用。 */
function envPositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
//#endregion
//#region .local/dsh-pet-windows/src/host/index.ts
/**
* dsh-pet 宿主半侧（host half）—— 宠物插件的"后端"部分
*
* 职责：提供 `/dsh-pet-7340/` 前缀的**业务能力**（handlePetRoute 纯函数，路由与桌面管道共用）。
* 全部配置（内置默认 + 用户主配置 + 文件宠物）由 ./config 的 readAllConfig 统一读取合并，
* 本文件只消费它的返回值（绝对正确、零校验），不再接触任何配置文件。
*
* 两个入口消费同一份 handlePetRoute：
*   - HTTP 路由：注册在 DSH WebServer 上（浏览器 overlay / 设置页 / 斜杠命令用）
*   - 桌面 Helper 管道：helper-process.ts 的 bridgeHandler（DSH_PET_BRIDGE=1 时经
*     dsh-pet-bridge:// scheme + stdout JSON 行 + 本地回调，**不走 HTTP**——
*     DSH Desktop 2.0.3+ 的浏览器访问闸门会拦插件子进程的裸 HTTP 请求）
* 两端行为严格一致（硬契约：浏览器/桌面功能/文案/配置完全对齐）。
*
* 路由：
*   /dsh-pet-7340/config             → 合并后的**成品配置**（{ main:{...}, test1:{...}, ... }，
*                                每条目字段已填满；浏览器/桌面/设置页的唯一配置入口）
*                                GET 读取成品；PUT 保存用户层（白名单重建 main-config.jsonc）、
*                                POST 同步用户层（把内置默认 config.jsonc **原文**整份写入，
*                                含注释与全部高级字段；合并结果与「没有用户层」等价）——
*                                两个写接口的**响应体都是保存后的成品聚合**，设置页即时生效
*                                直接拍平这份响应，客户端不再有第二份"补吹条目级字段"的实现
*   /dsh-pet-7340/reload              → 桌面端「重载配置」（右键菜单，POST）：重启桌面 Helper，全部桌面
*                                宠物窗口按最新配置重建（改配置文件后不必回设置页点保存）；与保存走
*                                **同一条**重启路径（syncDesktop），宠物数量/display/size 变化同样生效
*   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径 + 全部存储位置清单
*                                       （设置页「高级配置」「卸载与存储」展示用）
*   /dsh-pet-7340/models              → 可选「服务商 + 模型」清单（设置页「AI 模型」下拉框数据源；
*                                       与 DSH 模型选择器同源，取宿主 llm 服务的 listProviders/listModels）
*   /dsh-pet-7340/thumb/<素材根>/<动画名>.webm|.mov  → 素材按宠物归属（.mov 为 macOS 定制，扩展名取决于
*       客户端播放常量 ANIMATION_EXT；本路由固定双扩展名兜底）：
*       文件宠物 = $DSH_HOME/dsh-pet/pet/<素材根>-animation/（只查自己的，绝不回落）；
*       主宠物   = $DSH_HOME/dsh-pet/main-animation/<webm|mov>（用户目录，优先）→ 包内 assets/<webm|mov>
*       <素材根> 是**标识符**（pet/ 下文件名前缀），含分隔符/保留字符即 400（见 ID_FORBIDDEN）
*   /dsh-pet-7340/state               → **轮询统一状态 S**（GET，前端 1s 轮询的唯一数据源）：
*                                       { sections: { balance, workStatus, notify }, pets: { <id>: { say } } }，
*                                       每个叶子 = { counter, data }；counter 变了前端才渲染。
*                                       只读、纯内存、零副作用（绝不在这里触发外部调用/模型生成）。
*   /dsh-pet-7340/balance              → 余额刷新（POST 动作端点，写 S；数据从 /state 读）
*   /dsh-pet-7340/whisper              → 让某只宠物立即说一句（POST 动作端点，写 S 的 pets.<id>.say）
*   /dsh-pet-7340/broadcast            → 第三方投喂：把外部给定的文本写进气泡（POST 动作端点，写 S 的
*                                       pets.<id>.say；不生成、只搬运，供宿主侧其他插件集成）
*   /dsh-pet-7340/anim                 → 点播动画：让桌宠播一段指定动画（POST 动作端点，写 S 的
*                                       pets.<id>.anim；效果与右键「动作」菜单一致，供其他插件调用）
*   /dsh-pet-7340/chat                 → 对话与记忆（GET 最近窗口 / POST 对话并写 memory.json；
*                                       POST 只回 {ok}，回复同样写 S 的 pets.<id>.say）
*   /dsh-pet-7340/font|pic             → 字体 / 通知图标素材
*
* 系统通知不属于宠物行为、不在这里的旧实现是：浏览器半侧 notify.ts 经 connection 事件流
* （api.events.mux/host）监听 DSH 事件。但 DSH 0.1.5 已删除该事件流 API——通知改为
* host 侧监听宿主事件（session/event + agent/error）生成帧写进 S 的 sections.notify，
* 浏览器统一轮询 /state 后弹 toast（帧契约与 shared/notify.ts 一致；单槽，见下方 pushNotifyFrame）。
*
* 桌面模式（Electron 透明窗）没有独立配置文件：宠物显示在哪全部由宠物条目的 display 决定
* （web=仅浏览器 / desktop=仅桌面 / both=两者 / none=都不显示；缺失时合并器填内置默认值）。
*
* 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内；
*         PUT 保存经 saveUserConfig 白名单重建，id 过滤文件名非法字符。
*
* TODO(类型)：peer 依赖类型包本地暂不可解析，ctx/req/res 暂用 any；
*             依赖可解析后替换为 DSH 官方类型。
*/
/** 插件行 id（与 cordis.patch.yml 一致） */
const name = "pet";
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ llm（对话模型调用）+ commands（/balance 斜杠命令） */
const inject = [
	"webServer",
	"agentDefaultModel",
	"credentials",
	"llm",
	"commands"
];
/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** 包内表情包目录（表情包池的最后一环：assets/memes/<名称>.png） */
const PACKAGE_MEMES_DIR = join(join(PACKAGE_ROOT, "assets"), "memes");
/** 路由前缀 */
const ROUTE_PREFIX = "/dsh-pet-7340";
/** 不同扩展名对应的 Content-Type 映射 */
const MIME = {
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".png": "image/png",
	".json": "application/json; charset=utf-8",
	".jsonc": "application/json; charset=utf-8",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2"
};
/**
* 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
* @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
*/
function resolveAsset(root, rel) {
	if (rel.length === 0) return void 0;
	const candidate = normalize(join(root, rel));
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	if (candidate !== root && !candidate.startsWith(rootWithSep)) return void 0;
	return candidate;
}
/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root, rel) {
	const candidate = resolveAsset(root, rel);
	return candidate && existsSync(candidate) ? candidate : void 0;
}
/**
* 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。
*
* Content-Length 必须取自**正在读的那个 fd**（open 事件里 fstat），不能先 stat 再另开流：用户往
* $DSH_HOME/dsh-pet/main-animation/webm/ 复制或同名覆盖素材时，stat 与真正开始读之间文件会被截断/
* 改写，一旦实际字节数少于声明的长度，这个响应就**永远不结束、也不报错**（浏览器表现为 stalled、
* 视频 loadeddata 永不触发且无 error）——正是 issue #62 现场"数据断供"的一种成因。同一个 fd 的
* fstat 拿到的大小与随后读出的字节天然一致。
*/
function sendFile(res, file, contentType) {
	const stream = createReadStream(file);
	stream.once("open", (fd) => {
		if (res.destroyed || res.writableEnded) {
			stream.destroy();
			return;
		}
		try {
			res.writeHead(200, {
				"content-type": contentType,
				"content-length": fstatSync(fd).size,
				"cache-control": "public, max-age=3600"
			});
		} catch {
			res.writeHead(200, {
				"content-type": contentType,
				"cache-control": "public, max-age=3600"
			});
		}
		stream.pipe(res);
	});
	stream.on("error", () => res.destroy());
	res.on("close", () => stream.destroy());
}
/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible = (display) => display === "desktop" || display === "both";
/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
function sendJson(res, status, obj, headers = {}) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		...headers
	});
	res.end(body);
}
/** 发送纯文本响应（素材 404/400 等显式错误文案） */
function sendText(res, status, body) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(body);
}
/** 收集请求体（文本） */
function readBody(req) {
	return new Promise((resolve2, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由 + 斜杠命令（/balance /pet /chat）。 */
function apply(ctx) {
	const activation = process.platform === "win32" && process.env.DSH_DESKTOP_WINDOW_ACTIVATION === "1" && process.send ? windowActivation({
		get connected() {
			return process.connected;
		},
		send(message, callback) {
			return process.send(message, callback);
		},
		on(event, listener) {
			return process.on(event, listener);
		},
		off(event, listener) {
			return process.off(event, listener);
		}
	}) : void 0;
	if (activation) ctx.effect(() => () => activation.dispose());
	const userRoot = join(resolveDshHome(), "dsh-pet");
	const userConfigPath = join(userRoot, "main-config.jsonc");
	const legacyUserConfigPath = join(userRoot, "main-config.json");
	const petConfigDir = join(userRoot, "pet");
	const configPaths = {
		defaultFile: join(PACKAGE_ROOT, "assets", "config.jsonc"),
		userFile: userConfigPath,
		legacyUserFile: legacyUserConfigPath,
		petDir: petConfigDir
	};
	migrateUserConfig(configPaths, (msg) => console.log("[dsh-pet] " + msg));
	const thumbUserRoot = join(userRoot, "main-animation");
	const memesUserRoot = join(userRoot, "memes");
	/**
	* 表情包目录链 —— 与动画素材（/thumb）**同一套素材归属语义**：
	*   - `pet/<素材根>-memes/` 存在（种类自带表情包）：**只查它**，池与路由都不回落——
	*     查不到即 404 / 该条目剔除（与 `pet/<素材根>-animation/` 的独占规则逐字一致）；
	*   - 否则：用户目录 `$DSH_HOME/dsh-pet/memes/` 优先，其次包内 `assets/memes/`（逐文件合并，
	*     与「main-animation/<ext> → 包内 assets/<ext>」的主素材链同构）。
	* 池（readMemePool）与路由（/pic/memes）必须走**同一个函数**：池里能选的名字，
	* 路由必须取得到，否则气泡配图会图裂。
	* 素材根一律先过 resolveAsset：它来自 URL 段，Windows 上 %5C 解出的反斜杠不会被
	* rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘（与 /thumb 同一道防线）。
	*/
	const memeDirsFor = (assetRoot) => {
		const own = resolveAsset(petConfigDir, assetRoot + "-memes");
		if (own !== void 0 && existsSync(own)) return [own];
		return [memesUserRoot, PACKAGE_MEMES_DIR];
	};
	const state = new PollStateStore();
	const workStatus = new WorkStatusStore();
	let publishedWork = "\0";
	const publishWorkStatus = () => {
		const snap = workStatus.snapshot();
		const key = String(snap.state) + "\0" + String(snap.task);
		if (key === publishedWork) return;
		publishedWork = key;
		state.writeSection("workStatus", {
			state: snap.state,
			task: snap.task
		});
	};
	const pushNotifyFrame = (frame) => {
		state.writeSection("notify", frame);
	};
	const turnFlags = /* @__PURE__ */ new Map();
	/** 终态（success/error）展示窗口定时器：约 60s 后清掉该会话条目，陈旧完成态不再浮上来（Bug 2/3） */
	const terminalTimers = /* @__PURE__ */ new Map();
	const TERMINAL_KEEP_MS = 60 * 1e3;
	/** 取消某会话待执行的终态清理：会话已回到非终态，那次清理到点后既不清理也不重排，留着只会误导 */
	const cancelTerminalCleanup = (sessionId) => {
		const t = terminalTimers.get(sessionId);
		if (t === void 0) return;
		clearTimeout(t);
		terminalTimers.delete(sessionId);
	};
	/** 排一个终态清理定时器（每会话一个，已排则跳过） */
	const scheduleTerminalCleanup = (sessionId) => {
		if (terminalTimers.has(sessionId)) return;
		const t = setTimeout(() => {
			terminalTimers.delete(sessionId);
			const sessionState = workStatus.stateOf(sessionId);
			if (sessionState === "success" || sessionState === "error") {
				workStatus.clear(sessionId);
				turnFlags.delete(sessionId);
				publishWorkStatus();
			}
		}, TERMINAL_KEEP_MS);
		terminalTimers.set(sessionId, t);
	};
	let activePetId = "";
	const lastWhisperAt = /* @__PURE__ */ new Map();
	const memoryPath = join(userRoot, "memory.json");
	let chatQueue = Promise.resolve();
	/** 读记忆文件：不存在 → 空；损坏 → 显式报错 + 备份原始文件（绝不静默丢数据）+ 重建空记忆 */
	const readMemory = async () => {
		let raw;
		try {
			raw = await readFile(memoryPath, "utf8");
		} catch {
			return {};
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object") throw new Error("not an object");
			return parsed;
		} catch (e) {
			console.error(`dsh-pet: 记忆文件损坏已备份（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`);
			try {
				await mkdir(userRoot, { recursive: true });
				await writeFile(`${memoryPath}.bak-${Date.now()}`, raw, "utf8");
			} catch {}
			return {};
		}
	};
	const writeMemory = async (mem) => {
		await mkdir(userRoot, { recursive: true });
		await writeFile(memoryPath, JSON.stringify(mem, null, 2), "utf8");
	};
	/** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
	const withMemoryLock = (fn) => {
		const run = chatQueue.then(fn, fn);
		chatQueue = run.then(() => void 0, () => void 0);
		return run;
	};
	/** 某宠物的最终人设 system：所属条目（非文件宠物 → main 条目）的 whisperPrompt（合并器已填默认）
	*  + 无条件追加一句名字声明（name，缺失已按 id）——碎碎念与对话共用同一拼装。 */
	const petSystemPrompt = (petId, cfg) => {
		const found = findPetInstance(cfg, petId);
		const conf = found ? found.conf : cfg.main ?? {};
		const prompt = typeof conf.whisperPrompt === "string" ? conf.whisperPrompt : "";
		const nameLine = "你的名字是“" + (found ? String(found.pet.name || found.pet.id || petId) : petId) + "”。";
		return prompt ? prompt + "\n" + nameLine : nameLine;
	};
	/** 对话记忆轮数（1 轮 = 1 问 1 答）：所属条目/主条目的 chatMemoryRounds（合并器已填默认非负数字） */
	const memoryRounds = (petId, cfg) => {
		const found = findPetInstance(cfg, petId);
		const v = Number(found?.conf.chatMemoryRounds ?? cfg.main?.chatMemoryRounds);
		return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
	};
	/** 生成/返回某宠物的一句碎碎念（周期 GET 与菜单手动触发共用的同一逻辑）：
	*  每只宠物独立生成（所属条目的人设）。生成成功就写进 S 的 pets.<id>.say——
	*  碎碎念 / 命令气泡 / 对话回复在前端本来就是**同一条展示链路**（同一个 triggerWhisper、
	*  同一个气泡槽、同一批 events.whisper 动画），所以合并成同一个叶子；"周期内不重复"由
	*  调度侧的 lastWhisperAt 保证，不再需要一份 whisperCache（多端共享也由 S 天然保证）。
	*  配图（whisperImageEnabled 开启时）：从表情包池**随机抽 1 张**，把描述注入指令并随文本一起写。 */
	const publishWhisper = async (petId) => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		const conf = found ? found.conf : cfg.main ?? {};
		const entry = found ? found.entry : "main";
		const result = await generateWhisper(ctx, petSystemPrompt(petId, cfg), conf.whisperImageEnabled === true ? pickMeme(readMemePool(conf.memes, memeDirsFor(entry))) : void 0, configuredModel(conf, "whisperModel"));
		if (!result.ok) {
			console.warn("[dsh-pet] 碎碎念生成失败 pet=" + petId + " reason=" + result.reason + (result.message ? " " + result.message : ""));
			return false;
		}
		state.writePet(petId, "say", result.image ? {
			text: result.text,
			image: result.image
		} : { text: result.text });
		return true;
	};
	/** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 把回复写进 S 的 pets.<id>.say。
	*  供 POST /chat（动作端点）与 /chat 命令共用同一条路径（锁内读写，防两端交错写盘）。
	*  配图（chatImageEnabled 开启时）：把表情包清单交给模型按语境选一张，命中池内才随回复写回。 */
	const chatWithPet = async (petId, text) => withMemoryLock(async () => {
		const cfg = readAllConfig(configPaths);
		const rounds = memoryRounds(petId, cfg);
		const found = findPetInstance(cfg, petId);
		const conf = (found ?? { conf: cfg.main ?? {} }).conf;
		const system = petSystemPrompt(petId, cfg);
		const pool = conf.chatImageEnabled === true ? limitPool(readMemePool(conf.memes, memeDirsFor(found?.entry ?? "main")), Number(conf.chatImageLimit)) : [];
		const mem = await readMemory();
		const bucketKey = found?.entry ?? petId;
		const bucket = mem[bucketKey] ??= {};
		const entry = bucket[petId] ??= { messages: [] };
		const generated = await generateChat(ctx, system, sliceMemoryRounds(entry.messages, rounds), text, pool, configuredModel(conf, "chatModel"));
		if (!generated.ok) return generated;
		const now = Date.now();
		entry.messages.push({
			role: "user",
			content: text,
			ts: now
		});
		entry.messages.push({
			role: "assistant",
			content: generated.text,
			ts: now
		});
		await writeMemory(mem);
		state.writePet(petId, "say", generated.image ? {
			text: generated.text,
			image: generated.image
		} : { text: generated.text });
		return { ok: true };
	});
	/**
	* 当前生效宠物列表 = readAllConfig 成品拍平（main + 文件宠物全部条目；合并器已保证 id 唯一、
	* 字段填满），命令与桌面模式都从这里取。
	*/
	const effectivePetList = () => flattenPetList(readAllConfig(configPaths));
	/** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
	const balancePeriodSec = (cfg) => {
		const ers = cfg.main?.eventsRefreshSec;
		const n = Number(ers?.balance);
		return Number.isFinite(n) && n > 0 ? n : 1800;
	};
	/** 碎碎念周期（秒）：该宠物**所属条目**的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 300） */
	const whisperPeriodSec = (cfg, petId) => {
		const ers = (findPetInstance(cfg, petId) ?? { conf: cfg.main ?? {} }).conf.eventsRefreshSec;
		const n = Number(ers?.whisper);
		return Number.isFinite(n) && n > 0 ? n : 300;
	};
	/**
	* 刷新余额并写入 S —— host 侧**唯一**的余额查询点。
	*
	* 改造前是每个客户端各自按自己的定时器去查（浏览器一个 + 桌面每窗口一个）：同一份外部 API
	* 被重复请求、两端还可能看到新旧不一致的数据。现在只有这里查，两端都从 /state 读同一份结果。
	*
	* 失败也写进 S（reason 区分 unsupported / credential-missing / fetch-error）——余额不可用要弹
	* 文字说明气泡，不能静默；意外异常同样落成 fetch-error，不吞。
	*
	* @param manual 这次刷新是不是"用户要的"（/balance 命令、桌面「查看余额」菜单）。
	*   标记随数据一起写进叶子：只有 host 知道是谁要的，前端据此决定余额不可用时要不要**必弹**
	*   文字说明（decideBalanceNotice 的 explicit；周期刷新则只在原因变化时弹一次，免得反复刷屏）。
	*/
	/**
	* 账号服务要求的调用方身份（`AccountClientMetadata`）：Platform 用它派生五个客户端头，
	* 只影响**请求来源标识**与**服务端本地化文案**，不参与余额数值与币种。
	*
	* - version：本插件版本（读自身 package.json；读不到回落 '0.0.0'——该字段只是标识）
	* - locale：本插件是中文产品，固定 `zh-CN`（Platform 侧归一到 zh_CN）
	* - timezoneOffsetSeconds：本机 UTC 偏移（东八区为 +28800）
	*/
	const accountClientMetadata = () => {
		let version = "0.0.0";
		try {
			const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
			if (typeof raw.version === "string" && raw.version.length > 0) version = raw.version;
		} catch {}
		return {
			version,
			locale: "zh-CN",
			timezoneOffsetSeconds: -(/* @__PURE__ */ new Date()).getTimezoneOffset() * 60
		};
	};
	const refreshBalance = async (manual = false) => {
		const mark = (v) => manual ? {
			...v,
			manual: true
		} : v;
		try {
			const result = await queryBalance(ctx.agentDefaultModel.currentSelection().provider, async (ref) => {
				return (await ctx.credentials.resolve(credentialRef(ref)))?.value;
			}, async () => {
				const account = ctx.get("deepseekAccount", false);
				if (!account) return void 0;
				return account.getBalance(accountClientMetadata());
			});
			state.writeSection("balance", mark(result));
		} catch (e) {
			state.writeSection("balance", mark({
				ok: false,
				provider: "unknown",
				reason: "fetch-error",
				message: e instanceof Error ? e.message : String(e)
			}));
		}
	};
	/** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
	const resolveActivePetId = () => {
		try {
			const eff = effectivePetList();
			if (eff.length === 0) return "";
			if (activePetId && eff.some((p) => String(p.id) === activePetId)) return activePetId;
			return String(eff[0].id);
		} catch {
			return activePetId;
		}
	};
	/** 宠物的显示名（name，缺失回落 id）——命令文案用 */
	const petDisplayName = (pet) => {
		return String(pet.name ?? "").trim() || String(pet.id ?? "");
	};
	let hasDesktopPet = false;
	const refreshDesktop = () => {
		hasDesktopPet = false;
		try {
			hasDesktopPet = effectivePetList().some((p) => isDesktopVisible(p.display));
		} catch (e) {
			ctx.logger?.warn?.(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
		}
	};
	refreshDesktop();
	/** 桌面可见宠物列表（[{id,size}]）：透传 Helper 决定创建几个局部窗口（每宠物一个）。 */
	const desktopPetList = () => {
		try {
			return effectivePetList().filter((p) => isDesktopVisible(p.display)).map((p) => ({
				id: String(p.id),
				size: Number(p.size)
			}));
		} catch {
			return [];
		}
	};
	let helper;
	let startRetryTimer;
	let electronEnsure;
	let disposed = false;
	/** 「无图形环境」提示只在进程生命周期内打一次，避免守护循环刷屏 */
	let displayWarned = false;
	/** 用已确认存在的 Electron 路径拉起桌面 Helper（每只桌面宠物一个局部小窗口）。 */
	const launchHelper = (electronPath) => {
		if (helper || disposed) return;
		if (!hasDesktopPet) return;
		const port = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 0;
		if (!port || port <= 0) {
			if (!startRetryTimer) {
				startRetryTimer = setTimeout(() => {
					startRetryTimer = void 0;
					launchHelper(electronPath);
				}, 500);
				startRetryTimer.unref?.();
			}
			return;
		}
		const configUrl = `${`http://127.0.0.1:${port}`}${ROUTE_PREFIX}/config`;
		helper = new HelperProcess({
			electronPath,
			env: {
				DSH_PET_CONFIG_URL: configUrl,
				DSH_PET_SCALE: "1",
				DSH_PET_HOST_EXECUTABLE: process.execPath,
				DSH_PET_BRIDGE: "1",
				DSH_PET_PETS: JSON.stringify(desktopPetList())
			},
			bridgeHandler: async (req) => {
				if (req.method === "POST" && req.url === "/dsh-pet-7340/activate-desktop") {
					let result;
					try {
						if (!activation) throw new Error("当前 Desktop 不支持直接唤起，请更新并重启 DSH Desktop");
						await activation.activate();
						result = { ok: true };
					} catch (error) {
						result = {
							ok: false,
							reason: error instanceof Error ? error.message : String(error)
						};
					}
					return {
						id: req.id,
						status: 200,
						contentType: "application/json",
						body: JSON.stringify(result)
					};
				}
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", req.body);
				if (result.kind === "file") return {
					id: req.id,
					status: 200,
					contentType: result.contentType,
					file: result.file
				};
				if (result.kind === "text") return {
					id: req.id,
					status: result.status,
					contentType: "text/plain; charset=utf-8",
					body: result.body
				};
				return {
					id: req.id,
					status: result.status,
					contentType: "application/json; charset=utf-8",
					body: JSON.stringify(result.obj)
				};
			}
		}, ctx.logger ?? console);
		try {
			helper.start();
			ctx.logger?.info?.(`dsh-pet desktop helper started (config: ${configUrl})`);
		} catch (e) {
			ctx.logger?.warn?.(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
			helper = void 0;
		}
	};
	/** 拉起桌面 Helper：先探测本机 Electron；缺失时进程内异步下载
	*  （不 spawn 子进程，CLI node 与 DSH Desktop 均适用），下载完成后自动拉起。 */
	const startHelper = () => {
		if (helper || electronEnsure || disposed) return;
		if (!hasDesktopPet) return;
		if (!hasGraphicalDisplay()) {
			if (!displayWarned) {
				displayWarned = true;
				ctx.logger?.warn?.("[dsh-pet] 未检测到图形显示环境（DISPLAY/WAYLAND_DISPLAY 均为空），已跳过桌面宠物。浏览器内宠物不受影响；如需在服务器上启用桌面模式，请配置 Xvfb 后设置 DSH_PET_DESKTOP_FORCE=1。");
			}
			return;
		}
		const found = resolveElectronPath();
		if (found) {
			launchHelper(found);
			return;
		}
		console.warn(`[dsh-pet] Electron not found, downloading to ${defaultElectronExe()} ...`);
		electronEnsure = ensureElectronDownload().then((path) => {
			if (path) launchHelper(path);
			else console.warn("[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later.");
		}).finally(() => {
			electronEnsure = void 0;
		});
	};
	/** 停止桌面 Helper（保留配置，可再次拉起）。宿主退出/插件卸载路径：不等它退干净（见 stopAndWait）。 */
	const stopHelper = (reason = "settings-change") => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		helper?.stop(reason);
		helper = void 0;
	};
	/** 停止并**等旧 helper 真正退出**：配置变更触发的"停旧起新"专用（issue #64）。 */
	const stopHelperAndWait = async (reason) => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		const old = helper;
		helper = void 0;
		await old?.stopAndWait(reason);
	};
	/**
	* 宠物配置（display / size 等）变更后：重解析桌面宠物，**等旧 helper 退出**再拉起新的。
	*
	* 为什么要等（issue #64）：Electron 收到 SIGTERM 后关窗是异步的（几百 ms 起），"发完 kill 就 spawn
	* 新进程"会让旧窗口（旧大小）与新窗口（新大小）短暂共存——用户看到的就是"改完大小冒出来第二只宠物"。
	* 为什么要串行：连续保存会触发多次重启，两次重启交错同样会同时拉起两个 helper，所以用队列串起来。
	* 队列自身绝不留下 rejected 状态，否则后续保存再也不会重启 helper。
	*/
	let desktopSyncQueue = Promise.resolve();
	const syncDesktop = () => {
		desktopSyncQueue = desktopSyncQueue.then(async () => {
			refreshDesktop();
			await stopHelperAndWait("desktop-config-change");
			startHelper();
		}).catch((e) => {
			ctx.logger?.warn?.(`[dsh-pet] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
		});
		return desktopSyncQueue;
	};
	/** 扩展名 → 素材子目录名（webm → webm/，mov → mov/；其余落在动画目录平级放行） */
	const animSubdirFor = (ext) => ext === ".mov" ? "mov" : "webm";
	/** 包内动画素材根：按扩展名取子目录（webm/ 随包发布；mov/ 不存在时为 404 兜底，仅 macOS 自维护）。 */
	const assetRootFor = (ext) => join(PACKAGE_ROOT, "assets", animSubdirFor(ext));
	/** 用户动画根：按扩展名取子目录（main-animation/webm 或 main-animation/mov）。 */
	const userRootFor = (ext) => join(thumbUserRoot, animSubdirFor(ext));
	/** 单次业务路由(WebServer 注册 → HTTP 落盘 / 桌面 Helper 管道 → scheme 应答,共用同一份实现):
	*  输入只需 rawUrl(/dsh-pet-7340/... + 查询) + method + body 文本;返回 RouteResult(JSON/文本/文件),
	*  消费方各自落盘——业务逻辑只有一份,两端天然一致(硬契约:浏览器/桌面行为严格对齐)。 */
	const handlePetRoute = async (rawUrl, method, body) => {
		const url = new URL(rawUrl, "http://localhost");
		const rest = decodeURIComponent(url.pathname.slice(14));
		if (rest === "config") {
			if (method === "GET") try {
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
			if (method === "PUT") try {
				const clean = saveUserConfig(JSON.parse(body ?? ""), readUserConfig(configPaths));
				if (!clean) return {
					kind: "json",
					status: 400,
					obj: { error: "invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）" }
				};
				if (url.searchParams.get("force") !== "1" && userConfigUnparsable(configPaths)) return {
					kind: "json",
					status: 409,
					obj: {
						error: "user config is unparsable",
						needConfirm: true,
						userFile: userConfigPath
					}
				};
				await mkdir(userRoot, { recursive: true });
				await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
				syncDesktop();
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			if (method === "POST") {
				try {
					syncUserConfigFromDefault(configPaths);
				} catch (e) {
					return {
						kind: "json",
						status: 500,
						obj: { error: e instanceof Error ? e.message : String(e) }
					};
				}
				syncDesktop();
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			}
			return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
		}
		if (rest === "reload") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			syncDesktop();
			return {
				kind: "json",
				status: 200,
				obj: { reloading: true }
			};
		}
		if (rest === "config/meta") return {
			kind: "json",
			status: 200,
			obj: {
				user: userConfigPath,
				default: join(PACKAGE_ROOT, "assets", "config.jsonc"),
				animations: thumbUserRoot,
				memes: memesUserRoot,
				storage: storageEntries({
					userDataRoot: userRoot,
					electronDir: electronLandingDir(),
					home: homedir(),
					packageRoot: PACKAGE_ROOT
				}),
				profile: profileNameFrom(PACKAGE_ROOT) ?? ""
			}
		};
		if (rest === "models") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const llm = ctx.llm;
				const named = (id, name) => {
					const pid = String(id ?? "");
					return {
						id: pid,
						name: String(name ?? "") || pid
					};
				};
				let providers = (typeof llm?.listProviders === "function" ? llm.listProviders() : []).map((p) => named(p?.id, p?.name));
				if (providers.length === 0 && typeof llm?.listConfigurableProviders === "function") providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
				providers = providers.filter((p) => p.id);
				return {
					kind: "json",
					status: 200,
					obj: { providers: await Promise.all(providers.map(async (p) => {
						let models = [];
						try {
							const list = await llm?.listModels?.(p.id);
							models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
						} catch {}
						return {
							...p,
							models
						};
					})) }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
		}
		if (rest === "state") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			return {
				kind: "json",
				status: 200,
				obj: state.read(),
				headers: { "cache-control": "no-cache, no-store" }
			};
		}
		if (rest === "balance") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			await refreshBalance(true);
			return {
				kind: "json",
				status: 200,
				obj: { ok: true }
			};
		}
		if (rest === "whisper") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const petId = String(url.searchParams.get("pet") ?? "");
			try {
				return {
					kind: "json",
					status: 200,
					obj: await publishWhisper(petId) ? { ok: true } : {
						ok: false,
						reason: "generate-error"
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "broadcast") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			if (!normalizeBroadcastText(o.text)) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: "text 为空"
				}
			};
			try {
				const d = decideBroadcast({
					cfg: readAllConfig(configPaths),
					requested: String(url.searchParams.get("pet") ?? ""),
					active: resolveActivePetId(),
					text: o.text,
					image: o.image,
					memeDirs: memeDirsFor
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				state.writePet(d.petId, "say", d.image ? {
					text: d.text,
					image: d.image
				} : { text: d.text });
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "anim") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			try {
				const d = decideAnim({
					cfg: readAllConfig(configPaths),
					requested: String(url.searchParams.get("pet") ?? ""),
					active: resolveActivePetId(),
					name: o.name
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				state.writePet(d.petId, "anim", { name: d.name });
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "chat") {
			const petId = String(url.searchParams.get("pet") ?? "");
			try {
				if (method === "GET") {
					const cfg = readAllConfig(configPaths);
					const list = (((await readMemory())[findPetInstance(cfg, petId)?.entry ?? petId] ?? {})[petId]?.messages ?? []).slice();
					const rounds = memoryRounds(petId, cfg);
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							messages: sliceMemoryRounds(list, rounds),
							rounds
						}
					};
				}
				if (method === "POST") {
					const parsed = JSON.parse(body ?? "null") ?? {};
					const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
					if (!text) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息为空"
						}
					};
					if (text.length > 2e3) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息过长（限 2000 字）"
						}
					};
					return {
						kind: "json",
						status: 200,
						obj: await chatWithPet(petId, text)
					};
				}
				return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		const [scope, ...restParts] = rest.split("/");
		if (scope === "font") {
			const fontFile = resolveExisting(join(PACKAGE_ROOT, "assets", "fonts"), restParts.join("/"));
			if (fontFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: font not found"
			};
			return {
				kind: "file",
				file: fontFile,
				contentType: MIME[fontFile.slice(fontFile.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream"
			};
		}
		if (scope === "pic") {
			if (restParts[0] === "memes") {
				const segs = restParts.slice(1);
				const scoped = segs.length >= 2;
				const assetRoot = scoped ? segs[0] : "main";
				if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) return {
					kind: "text",
					status: 400,
					body: "dsh-pet: invalid asset root"
				};
				const rel = (scoped ? segs.slice(1) : segs).join("/");
				let picFile;
				for (const dir of memeDirsFor(assetRoot)) {
					picFile = resolveExisting(dir, rel);
					if (picFile !== void 0) break;
				}
				if (picFile === void 0) return {
					kind: "text",
					status: 404,
					body: "dsh-pet: pic not found"
				};
				const ext = picFile.slice(picFile.lastIndexOf(".")).toLowerCase();
				return {
					kind: "file",
					file: picFile,
					contentType: MIME[ext] ?? "application/octet-stream"
				};
			}
			const picFile = resolveExisting(join(PACKAGE_ROOT, "assets", "pic"), restParts.join("/"));
			if (picFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: pic not found"
			};
			return {
				kind: "file",
				file: picFile,
				contentType: MIME[picFile.slice(picFile.lastIndexOf(".")).toLowerCase()] ?? "application/octet-stream"
			};
		}
		if (scope !== "thumb") return {
			kind: "text",
			status: 400,
			body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
		};
		const [petId, ...nameParts] = restParts;
		if (!petId || nameParts.length === 0) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
		};
		if (ID_FORBIDDEN.test(petId)) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: invalid pet id"
		};
		const fileName = nameParts.join("/");
		const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
		if (ext !== ".webm" && ext !== ".mov") return {
			kind: "text",
			status: 400,
			body: "dsh-pet: unsupported animation format (expected .webm or .mov)"
		};
		const extraAnimDir = resolveAsset(petConfigDir, petId + "-animation");
		const file = extraAnimDir !== void 0 && existsSync(extraAnimDir) ? resolveExisting(extraAnimDir, fileName) : resolveExisting(userRootFor(ext), fileName) ?? resolveExisting(assetRootFor(ext), fileName);
		if (file === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: asset not found"
		};
		return {
			kind: "file",
			file,
			contentType: MIME[ext] ?? "application/octet-stream"
		};
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			try {
				const body = req.method === "PUT" || req.method === "POST" ? await readBody(req) : void 0;
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", body);
				if (result.kind === "json") sendJson(res, result.status, result.obj, result.headers);
				else if (result.kind === "text") sendText(res, result.status, result.body);
				else sendFile(res, result.file, result.contentType);
			} catch (e) {
				sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
	}), "dsh-pet: /dsh-pet-7340 asset route");
	ctx.effect(() => {
		const dispose = ctx.on("session/event", (session, event) => {
			const type = event?.type;
			if (!type) return;
			const sessionId = String(session?.header?.id ?? session?.id ?? "unknown");
			if (type === "todo/write") {
				if (workStatus.has(sessionId)) {
					workStatus.setTask(sessionId, currentTaskFromTodo(event));
					publishWorkStatus();
				}
				return;
			}
			if (type === "user/message") {
				if ((event?.data?.source)?.kind === "goal") {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.goalRound = true;
					turnFlags.set(sessionId, flags);
				}
				return;
			}
			if (type === "turn/start") {
				turnFlags.set(sessionId, {
					goalRound: false,
					closing: null
				});
				workStatus.setTask(sessionId, null);
				publishWorkStatus();
			}
			if (type === "tool/call" && String(event?.data?.name ?? "") === "update_goal") {
				const action = goalUpdateAction(String(event?.data?.arguments ?? ""));
				if (action) {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.closing = action;
					turnFlags.set(sessionId, flags);
				}
			}
			const next = reduceWorkStatus(event, turnFlags.get(sessionId));
			if (!next) {
				if (type === "turn/end") {
					turnFlags.delete(sessionId);
					cancelTerminalCleanup(sessionId);
					workStatus.clear(sessionId);
					publishWorkStatus();
				}
				return;
			}
			const seq = Number(event.seq ?? 0);
			if (!workStatus.setState(sessionId, next, seq)) return;
			publishWorkStatus();
			if (next === "success" || next === "error") scheduleTerminalCleanup(sessionId);
			else cancelTerminalCleanup(sessionId);
		});
		return () => {
			dispose();
			for (const t of terminalTimers.values()) clearTimeout(t);
			terminalTimers.clear();
		};
	}, "dsh-pet: work-status session events");
	ctx.effect(() => {
		const sessionDispose = ctx.on("session/event", (session, event) => {
			if (!shouldNotifySession(session)) return;
			const frame = reduceNotifyFrame(event);
			if (frame) pushNotifyFrame(frame);
		});
		const errorDispose = ctx.on("agent/error", (payload) => {
			pushNotifyFrame(agentErrorFrame(payload?.error));
		});
		return () => {
			sessionDispose();
			errorDispose();
		};
	}, "dsh-pet: notify frames");
	ctx.effect(() => ctx.commands.register({
		name: "balance",
		description: "手动触发桌宠余额显示（立即弹出余额气泡）",
		handler: () => {
			refreshBalance(true);
			return {
				kind: "success",
				text: "已触发桌宠余额显示"
			};
		}
	}), "dsh-pet: /balance command");
	ctx.effect(() => {
		let disposed = false;
		let timer = null;
		function arm(sec) {
			if (disposed) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		async function tick() {
			let sec;
			try {
				const cfg = readAllConfig(configPaths);
				sec = balancePeriodSec(cfg);
				if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
			} catch {
				return;
			}
			arm(sec);
		}
		tick();
		return () => {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: balance poll");
	ctx.effect(() => {
		let disposed = false;
		let timer = null;
		function arm(sec) {
			if (disposed) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		function tick() {
			let next = 300;
			try {
				const cfg = readAllConfig(configPaths);
				const now = Date.now();
				let min = Infinity;
				for (const pet of flattenPetList(cfg)) {
					const petId = String(pet.id ?? "");
					if (!petId || pet.whisperEnabled !== true) continue;
					const sec = whisperPeriodSec(cfg, petId);
					min = Math.min(min, sec);
					if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1e3) continue;
					lastWhisperAt.set(petId, now);
					publishWhisper(petId).catch(() => {});
				}
				if (Number.isFinite(min)) next = min;
			} catch {
				return;
			}
			arm(next);
		}
		tick();
		return () => {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: whisper poll");
	ctx.effect(() => ctx.commands.register({
		name: "pet",
		description: "选择桌宠（/chat 对话的目标；支持选择框或手输 id/名字）",
		input: { hint: "[宠物 id 或名字]（留空查看当前）" },
		handler: ({ rawInput }) => {
			const arg = rawInput.trim();
			let eff;
			try {
				eff = effectivePetList();
			} catch {
				eff = [];
			}
			if (!arg) {
				const cur = resolveActivePetId();
				const found = eff.find((p) => String(p.id) === cur);
				return {
					kind: "success",
					text: "当前桌宠：" + (found ? petDisplayName(found) : cur || "（无可交互桌宠）")
				};
			}
			const byId = eff.find((p) => String(p.id) === arg);
			if (byId) {
				activePetId = String(byId.id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byId)
				};
			}
			const byName = eff.filter((p) => petDisplayName(p) === arg);
			if (byName.length === 1) {
				activePetId = String(byName[0].id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byName[0])
				};
			}
			if (byName.length > 1) return {
				kind: "error",
				text: "「" + arg + "」有 " + byName.length + " 只桌宠（id：" + byName.map((p) => String(p.id)).join("、") + "），请用 id 指定"
			};
			return {
				kind: "error",
				text: "找不到桌宠「" + arg + "」（id 或名字都行；/pet 回车可打开选择框）"
			};
		}
	}), "dsh-pet: /pet command");
	ctx.effect(() => ctx.commands.register({
		name: "chat",
		description: "与桌宠对话：留空 = 碎碎念一句；输入消息 = 正常对话",
		input: { hint: "[消息]（留空 = 碎碎念）" },
		handler: ({ rawInput }) => {
			const petId = resolveActivePetId();
			if (!petId) return {
				kind: "error",
				text: "没有可交互的桌宠"
			};
			const text = rawInput.trim();
			if (!text) {
				publishWhisper(petId).catch((e) => console.warn("[dsh-pet] 碎碎念异常：" + (e instanceof Error ? e.message : String(e))));
				return {
					kind: "success",
					text: "已让桌宠碎碎念一句"
				};
			}
			if (text.length > 2e3) return {
				kind: "error",
				text: "消息过长（限 2000 字）"
			};
			chatWithPet(petId, text).then((r) => {
				if (!r.ok) console.warn("[dsh-pet] 对话失败 reason=" + r.reason + (r.message ? " " + r.message : ""));
			});
			return {
				kind: "success",
				text: "已发送，桌宠马上回应"
			};
		}
	}), "dsh-pet: /chat command");
	ctx.effect(() => () => {
		disposed = true;
		stopHelper("dsh-host-stop");
	});
	startHelper();
}
//#endregion
export { apply, inject, name };
