// 设置页面板（client 半边）—— 手写 __ModuleLoader__ 包，不走打包器。
// 契约（沿用 dsh-deepseek-web-login 实测结论）：
//  · 包体必须是 window.__ModuleLoader__.load({ id, factory })，factory 用 CJS 风格 require('react')；
//  · slots.register 必须带 name 字段，渲染函数必须返回 React 元素，否则 React #130；
//  · 与宿主同源，所以直接 fetch('/grok-web/api/...')。
window.__ModuleLoader__.load({
	id: "dsh-grok-web",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const react = require("react");
		const h = react.createElement;
		const API = "/grok-web/api";

		const box = { display: "flex", flexDirection: "column", gap: 10 };
		const row = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
		const card = {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,.28))",
			borderRadius: 8,
		};
		const muted = { opacity: 0.65, fontSize: 12 };
		const ok = { color: "var(--dsw-alias-label-success, #2e9e5b)" };
		const bad = { color: "var(--dsw-alias-label-danger, #d24545)" };
		const log = {
			fontFamily: "var(--dsw-alias-font-mono, monospace)",
			fontSize: 12,
			lineHeight: 1.5,
			maxHeight: "10em",
			overflowY: "auto",
			whiteSpace: "pre-wrap",
			margin: 0,
		};

		const text = (value) => (value === undefined || value === null ? "" : String(value));

		/** 一次拉取状态；失败时把错误原样交给面板显示，不静默。 */
		async function fetchStatus() {
			const response = await fetch(`${API}/status`, { method: "GET", credentials: "same-origin" });
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(text(body?.error?.message) || `HTTP ${response.status}`);
			return body;
		}

		async function post(route, payload) {
			const response = await fetch(API + route, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload || {}),
				credentials: "same-origin",
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(text(body?.error?.message) || `HTTP ${response.status}`);
			if (body?.error) throw new Error(`${text(body.error.code) ? `[${body.error.code}] ` : ""}${text(body.error.message)}`);
			return body;
		}

		function Panel() {
			const [status, setStatus] = react.useState(null);
			const [probe, setProbe] = react.useState(null);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [port, setPort] = react.useState("9222");

			const refresh = react.useCallback(async () => {
				try {
					setStatus(await fetchStatus());
					setError("");
				} catch (cause) {
					setError(text(cause?.message ?? cause));
				}
			}, []);

			react.useEffect(() => {
				refresh();
				const timer = window.setInterval(refresh, 2000);
				return () => window.clearInterval(timer);
			}, [refresh]);

			const run = react.useCallback(
				async (action) => {
					setBusy(true);
					setError("");
					try {
						await action();
						await refresh();
					} catch (cause) {
						setError(text(cause?.message ?? cause));
					} finally {
						setBusy(false);
					}
				},
				[refresh],
			);

			const job = status?.job;
			const auth = status?.auth || {};
			const lines = Array.isArray(job?.lines) ? job.lines.slice(-12) : [];
			const proxy = status?.proxy || {};

			return h("div", { style: box }, [
				h(
					"div",
					{ key: "intro", style: muted },
					"用浏览器登录态把 grok.com 网页版接成 DSH 的模型。模型名、超时、代理等参数在「插件设置 → dsh-grok-web」里改。",
				),
				h("div", { key: "state", style: card }, [
					h("div", { style: row }, [
						h("strong", null, auth.loggedIn ? "已有登录态" : "无登录态"),
						h("span", { style: auth.loggedIn ? ok : bad }, auth.loggedIn ? "●" : "●"),
						h("span", { style: muted }, `来源 ${text(auth.source) || "-"} / x-userid ${text(auth.userId) || "-"}`),
					]),
					auth.capturedAt ? h("div", { style: muted }, `抓取时间 ${auth.capturedAt}`) : null,
					auth.file ? h("div", { style: muted }, `文件 ${auth.file}`) : null,
					auth.reason ? h("div", { style: muted }, text(auth.reason)) : null,
					Array.isArray(auth.expiredCookies) && auth.expiredCookies.length
						? h("div", { style: bad }, `已过期的 cookie：${auth.expiredCookies.join(", ")}`)
						: null,
					h(
						"div",
						{ style: muted },
						`代理 ${text(proxy.url) || "直连"}（${text(proxy.source)}）/ 默认档 ${text(status?.model) || "fast"}`,
					),
				]),
				h("div", { key: "actions", style: row }, [
					h(
						"button",
						{
							type: "button",
							disabled: busy || Boolean(job && !job.done),
							onClick: () => run(() => post("/login")),
						},
						"浏览器登录",
					),
					h("input", {
						style: { width: "7em" },
						value: port,
						placeholder: "调试端口",
						"aria-label": "调试端口",
						onChange: (event) => setPort(event.target.value),
					}),
					h(
						"button",
						{
							type: "button",
							disabled: busy || !(Number(port) > 0) || Boolean(job && !job.done),
							onClick: () => run(() => post("/import", { cdpPort: Number(port) })),
						},
						"从调试端口导入",
					),
					h(
						"button",
						{
							type: "button",
							disabled: busy || !auth.loggedIn,
							onClick: () =>
								run(async () => {
									setProbe(await post("/probe"));
								}),
						},
						"探活",
					),
				]),
				probe?.ok ? h("div", { key: "probe", style: ok }, `握手通过：session=${text(probe.sessionId)}`) : null,
				job && !job.done ? h("div", { key: "running", style: muted }, "任务进行中…") : null,
				lines.length || job?.error || error
					? h("div", { key: "log", style: card }, [
							h("span", { style: muted }, "进度"),
							h("pre", { style: log }, lines.join("\n")),
							job?.error ? h("span", { style: bad }, `[${text(job.error.code)}] ${text(job.error.message)}`) : null,
							error ? h("span", { style: bad }, text(error)) : null,
						])
					: null,
			]);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => {
				try {
					return ctx.slots.inject("settings.section", () =>
						ctx.slots.register({ name: "settings.section", id: "dsh-grok-web", order: 47, label: () => "Grok 网页版" }, () =>
							h(Panel),
						),
					);
				} catch (cause) {
					console.warn("[dsh-grok-web] settings.section 槽位不可用，设置页面板将不可见：", cause);
					return;
				}
			}, "dsh-grok-web: settings panel");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
