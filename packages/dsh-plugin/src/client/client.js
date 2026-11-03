/*!
 * dsh-magic-context — client bundle.
 *
 * Browser half of the persistent bundle. Slot contributions:
 *
 *   1. `settings.section` (root, id "magic-context") — the Magic Context
 *      settings page: live status + an EDITABLE form over the DSH override
 *      layer (enabled, historian model / turn-end await, execute threshold +
 *      per-model overrides, protected tokens). Reads `magicContext/settings`,
 *      writes `magicContext/updateSettings`, which calls
 *      `settings.mutate("magic-host", ops, expectedRevision)` on the host. A
 *      stale revision answers `conflict` with the fresh view: the draft is kept
 *      and the next Save uses the new revision.
 *   2. `plugins.bundle.config` (keyed "dsh-magic-context") — the same form on
 *      the bundle's page in Plugins (the target of the indicator's "Settings"
 *      link through `pluginNavigation.openBundle`).
 *   3. `conversation.session.header.actions` (session) — status popover.
 *   4. `conversation.composer.dock` (session) — the Magic Context context
 *      indicator: a ring + percentage fed by the `magicContextPressure`
 *      projection (host/meter.ts), yellow from the execute threshold, red near
 *      / past the force threshold; click opens the details popover
 *      (`magicContext/context` + the `contextBreakdown` projection).
 *
 * Precedence shown on the page: DSH override (set here) > magic-context.jsonc
 * (project > user) > core default. "Inherit" = unset the DSH field. The jsonc
 * file is never written by this page.
 *
 * Client→Host channel: Typert Gateway over the shared `/api` RPC channel
 * (`connection.rpc.call('/api', 'magicContext/<method>', { args: { args } })`).
 * Every failure degrades to a visible message instead of breaking the UI.
 *
 * No `@deepseek-ai/dsh-client-ui-primitives` import (client bundle purity
 * rule): controls, icon and popover positioning are self-contained, styled
 * with DSW alias tokens in a self-injected `<style data-plugin-css>` block.
 *
 * Bundle contract: classic script registering via `window.__ModuleLoader__`
 * with the factory-form CJS shape used by the framework's own client bundles.
 */
window.__ModuleLoader__.load({
	id: "dsh-magic-context",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		// `createSnapshotStore` lives in the framework's static module
		// `@deepseek-ai/dsh-client-store` (0.2.1-rc.5 web boot `staticModules`);
		// there is no `@deepseek-ai/dsh-client-runtime` package at 0.2.x.
		var clientStore = require("@deepseek-ai/dsh-client-store");
		var reactDom = null;
		try {
			reactDom = require("react-dom");
		} catch (_error) {
			reactDom = null;
		}
		var jsx = jsxRuntime.jsx;
		var jsxs = jsxRuntime.jsxs;

		/* ------------------------------------------------ i18n */
		var ZH = typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "");
		var STRINGS = {
			title: ["Magic Context", "Magic Context"],
			subtitle: ["dsh-magic-context · DeepSeek Harness adapter", "dsh-magic-context · DSH 适配器"],
			status: ["Status", "状态"],
			settings: ["Settings", "设置"],
			loading: ["Loading…", "读取中…"],
			refresh: ["Refresh", "刷新"],
			close: ["Close", "关闭"],
			save: ["Save", "保存"],
			saving: ["Saving…", "保存中…"],
			saved: ["Saved — applied live.", "已保存，已在线生效。"],
			truncatedTools: ["Truncated tool results", "已截断的工具结果"],
			savingSlow: ["Still saving — DSH applies profile edits between agent steps; this can take a moment while a turn is running.", "仍在保存——DSH 在智能体步骤之间写入配置，正在运行的回合可能让它稍慢。"],
			savingGaveUp: ["Saving is taking unusually long. Reloaded the current values: if your change is not shown yet it is still queued and will apply when DSH finishes the write; your edits are kept.", "保存耗时异常。已重新读取当前值：若尚未显示你的修改，它仍在排队，DSH 写入完成后即生效；你的编辑已保留。"],
			reset: ["Discard changes", "放弃修改"],
			inherit: ["Inherit", "继承"],
			override: ["Override", "覆盖"],
			effective: ["Effective", "生效值"],
			src_dsh: ["DSH override", "DSH 覆盖"],
			src_jsonc: ["magic-context.jsonc", "magic-context.jsonc"],
			src_default: ["core default", "核心默认"],
			src_profile: ["profile row (cordis.patch.yml)", "配置行（cordis.patch.yml）"],
			f_enabled: ["Enabled", "启用"],
			f_enabled_hint: ["Pauses per-step Magic work live (tools stay listed).", "在线暂停每步的 MC 处理（工具仍保留）。"],
			f_historianModel: ["Historian model", "Historian 模型"],
			f_historianModel_hint: ["provider/model — use a large-window route.", "provider/model —— 请用大窗口路由。"],
			f_await: ["Historian turn-end await (ms)", "回合结束等待 historian（毫秒）"],
			f_await_hint: ["0 = off. For one-shot hosts (dsh headless).", "0 为关闭；用于一次性宿主（dsh headless）。"],
			f_threshold: ["Execute threshold (%)", "执行阈值（%）"],
			f_threshold_hint: ["20–90. Force threshold = max(85, execute + 2).", "20–90；强制阈值 = max(85, 执行+2)。"],
			f_byModel: ["Per-model execute threshold", "按模型的执行阈值"],
			f_byModel_hint: ["provider/model → %, merged over jsonc per-model keys.", "provider/model → %，叠加在 jsonc 的按模型配置上。"],
			f_protected: ["Protected tokens", "保护 token 数"],
			f_protected_hint: ["4000–1000000; unset = derived default.", "4000–1000000；不设则按窗口推导。"],
			add_model: ["Add model", "添加模型"],
			remove: ["Remove", "移除"],
			precedence: ["Precedence: DSH override > magic-context.jsonc (project > user) > core default. Inherit = use the jsonc value. This page never writes the jsonc file.", "优先级：DSH 覆盖 > magic-context.jsonc（项目 > 用户）> 核心默认。“继承”即使用 jsonc 的值；本页不会改写 jsonc 文件。"],
			conflict: ["Settings changed elsewhere since this page loaded. Reloaded the latest values; your edits are kept — review and Save again.", "设置在别处被修改，已载入最新值并保留你的修改；请核对后再次保存。"],
			unavailable: ["Settings endpoint unavailable", "设置端点不可用"],
			readonly: ["Read-only", "只读"],
			pending_title: ["magic-context.jsonc changed — these sections apply after a DSH restart:", "magic-context.jsonc 已修改，以下配置需重启 DSH 后生效："],
			pending_running: ["running", "运行中的值"],
			pending_next: ["pending restart", "待重启生效"],
			configPath: ["Config file", "配置文件"],
			invalid: ["Invalid value", "无效值"],
			meter_aria: ["Magic Context: {p} of context used", "Magic Context：上下文已用 {p}"],
			meter_title: ["Context", "上下文"],
			used: ["Used", "已用"],
			window: ["Window", "窗口"],
			execute: ["Execute threshold", "执行阈值"],
			force: ["Force threshold", "强制阈值"],
			emergency: ["Emergency wall", "紧急上限"],
			system: ["System prompt", "系统提示词"],
			tools: ["Tools", "工具"],
			messages: ["Conversation", "对话"],
			compartments: ["Compartments", "Compartments"],
			historian: ["Historian", "Historian"],
			h_idle: ["idle", "空闲"],
			h_running: ["running", "运行中"],
			h_failed: ["failed", "失败"],
			h_never: ["not run yet", "尚未运行"],
			pendingDrops: ["Pending drops", "待处理 drops"],
			pendingOutbox: ["Pending surface rewrites", "待提交的改写"],
			knowledge: ["Memory / knowledge injected", "记忆/知识注入"],
			nudge: ["Nudge", "Nudge"],
			nudge_none: ["none", "无"],
			notePending: ["note nudge pending", "笔记提醒待发"],
			notManaged: ["Magic Context is not enabled in this session's preset ({preset}).", "此会话的预设（{preset}）未启用 Magic Context。"],
			disabled: ["Magic Context is paused (enabled = false).", "Magic Context 已暂停（enabled = false）。"],
			openSettings: ["Magic Context settings", "Magic Context 设置"],
			settingsWhere: ["Open Settings → Magic Context", "请打开 设置 → Magic Context"],
			detailsUnavailable: ["Details unavailable", "详情不可用"],
			approx: ["≈", "≈"]
		};
		function L(key, vars) {
			var pair = STRINGS[key];
			var text = pair === void 0 ? key : pair[ZH ? 1 : 0];
			if (vars !== void 0) {
				Object.keys(vars).forEach(function (name) {
					text = text.split("{" + name + "}").join(String(vars[name]));
				});
			}
			return text;
		}

		/* ------------------------------------------------ styles */
		var CSS_TAG_ID = "dsh-magic-context/status.css";
		var css = [
			".ckmc-root{position:relative}",
			".ckmc-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:5px;padding:3px 6px;font-size:12px;line-height:18px;display:inline-flex}",
			".ckmc-trigger:hover,.ckmc-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}",
			".ckmc-chevron{transition:transform .15s}",
			".ckmc-chevronOpen{transform:rotate(180deg)}",
			".ckmc-menu{z-index:100;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);width:min(420px,calc(100vw - 32px));max-height:min(480px,calc(100vh - 140px));box-shadow:var(--dsw-shadow-lv3);border-radius:12px;padding:10px;position:absolute;top:calc(100% + 5px);left:0;overflow:auto}",
			".ckmc-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px;min-width:0;margin-bottom:12px}",
			".ckmc-title{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);font-weight:600;margin:0 0 4px}",
			".ckmc-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}",
			".ckmc-row{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:20px;border-top:1px solid var(--dsw-alias-border-l2);padding:4px 0;min-width:0}",
			".ckmc-row:first-of-type{border-top:0}",
			".ckmc-label{color:var(--dsw-alias-label-tertiary);flex:none}",
			".ckmc-value{color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono);min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ckmc-valueOk{color:var(--dsw-alias-state-success-primary)}",
			".ckmc-valueErr{color:var(--dsw-alias-label-error)}",
			".ckmc-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin:4px 0 0}",
			".ckmc-notice{font-size:12px;line-height:18px;border-radius:8px;padding:6px 8px;margin:8px 0 0;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".ckmc-noticeErr{color:var(--dsw-alias-label-error)}",
			".ckmc-btn{min-height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:16px;padding:3px 10px}",
			".ckmc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".ckmc-btn:disabled{opacity:.5;cursor:default}",
			".ckmc-btnPrimary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1, #fff);border-color:transparent}",
			".ckmc-btnPrimary:hover:not(:disabled){color:var(--dsw-alias-bg-layer-1, #fff);opacity:.9}",
			".ckmc-actions{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}",
			".ckmc-loading{font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
			".ckmc-field{border-top:1px solid var(--dsw-alias-border-l2);padding:10px 0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center}",
			".ckmc-field:first-of-type{border-top:0}",
			".ckmc-fieldLabel{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}",
			".ckmc-fieldMeta{grid-column:1 / -1;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
			".ckmc-fieldControl{grid-column:1 / -1;display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
			".ckmc-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden}",
			".ckmc-seg button{background:0 0;border:0;padding:2px 8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
			".ckmc-seg button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".ckmc-input{box-sizing:border-box;min-width:0;width:220px;max-width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1, transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;padding:3px 8px;font-family:var(--dsw-font-mono)}",
			".ckmc-inputNarrow{width:90px}",
			".ckmc-input:disabled{opacity:.6}",
			".ckmc-inputErr{border-color:var(--dsw-alias-label-error)}",
			".ckmc-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".ckmc-modelRow{display:flex;gap:6px;align-items:center;margin-top:4px}",
			/* composer indicator — mirrors the native ContextMeter geometry */
			".ckmc-meter{flex:none;display:inline-flex}",
			".ckmc-meterTrigger{border-radius:var(--dsw-radius-sm, 6px);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}",
			".ckmc-meterTrigger:hover,.ckmc-meterTrigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".ckmc-ringTrack{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}",
			".ckmc-ringFill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round}",
			".ckmc-ringTick{stroke:var(--dsw-alias-label-quaternary, var(--dsw-alias-border-l3));stroke-width:1px}",
			".ckmc-warn .ckmc-ringFill{stroke:var(--dsw-alias-state-warning-primary, #e5a50a)}",
			".ckmc-warn{color:var(--dsw-alias-state-warning-primary, #b7791f)}",
			".ckmc-danger .ckmc-ringFill{stroke:var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error, #e5484d))}",
			".ckmc-danger{color:var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error, #e5484d))}",
			".ckmc-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg, 12px);background:var(--dsw-specific-menu);width:min(300px,100vw - 24px);max-height:min(560px,100vh - 80px);overflow:auto;backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent, var(--dsw-shadow-lv3));color:var(--dsw-alias-label-secondary);cursor:default;border:1px solid var(--dsw-alias-border-l1);padding:12px;font-size:12px;line-height:20px;position:fixed}",
			".ckmc-panelHead{display:flex;align-items:baseline;gap:6px}",
			".ckmc-panelPct{color:var(--dsw-alias-label-primary);font-weight:600;font-size:14px}",
			".ckmc-panelFig{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}",
			".ckmc-bar{position:relative;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:6px;margin:10px 0 4px;display:flex;overflow:visible}",
			".ckmc-seg2{height:100%;min-width:2px;flex:none;background:var(--ckmc-tint,var(--dsw-alias-label-tertiary))}",
			".ckmc-seg2:first-child{border-radius:999px 0 0 999px}",
			".ckmc-mark{position:absolute;top:-3px;bottom:-3px;width:2px;border-radius:1px}",
			".ckmc-markExec{background:var(--dsw-alias-state-warning-primary, #e5a50a)}",
			".ckmc-markForce{background:var(--dsw-alias-state-error-primary, #e5484d)}",
			".ckmc-tSystem{--ckmc-tint:var(--dsw-static-neutral-bluish-400, #8e9bb0)}",
			".ckmc-tTools{--ckmc-tint:#a78bfa}",
			".ckmc-tMessages{--ckmc-tint:var(--dsw-static-blue-450, #4c8bf5)}",
			".ckmc-swatch{background:var(--ckmc-tint);border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}",
			".ckmc-section{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}",
			".ckmc-kv{display:flex;justify-content:space-between;gap:12px;padding:1px 0}",
			".ckmc-kv dt{color:var(--dsw-alias-label-secondary)}",
			".ckmc-kv dd{margin:0;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);text-align:right;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ckmc-link{background:0 0;border:0;padding:0;margin-top:10px;color:var(--dsw-alias-label-link, var(--dsw-static-blue-450, #4c8bf5));cursor:pointer;font-size:12px}"
		].join("");
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-magic-context";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/* ------------------------------------- host communication */
		var CHANNEL = "/api";
		var NAMESPACE = "magicContext";

		/**
		 * Call one `magicContext/<method>` Remote. Wire shape: the gateway
		 * expects payload = { args: { <wire>: value } }; every descriptor
		 * declares one parameter with wire "args", so the argument object rides
		 * under payload.args.args. Never throws.
		 */
		function callRemote(connection, method, args) {
			if (connection === void 0 || connection === null || connection.rpc === void 0 || typeof connection.rpc.call !== "function") {
				return Promise.resolve({ ok: false, error: { code: "unavailable", message: "connection.rpc is unavailable on this page", details: {} } });
			}
			return connection.rpc.call(CHANNEL, NAMESPACE + "/" + method, { args: { args: args === void 0 ? {} : args } }).then(
				function (result) { return result; },
				function (error) {
					return { ok: false, error: { code: "transport", message: String(error && error.message !== void 0 ? error.message : error), details: {} } };
				}
			);
		}

		function errorText(result) {
			return result && result.error && result.error.message !== void 0 ? result.error.message : "unknown";
		}

		/**
		 * Settings epoch: bumped after every successful save so the composer
		 * indicator (a different slot component) re-reads `magicContext/context`
		 * at once instead of waiting for the next `magicContextPressure`
		 * projection update (recomputed per agent step only).
		 */
		var settingsEpoch = clientStore.createSnapshotStore({ epoch: 0 });
		function bumpSettingsEpoch() {
			try { settingsEpoch.set({ epoch: settingsEpoch.getSnapshot().epoch + 1 }); } catch (_error) { /* indicator refresh is best-effort */ }
		}
		function useSettingsEpoch() {
			var state = react.useState(settingsEpoch.getSnapshot());
			var setState = state[1];
			react.useEffect(function () {
				setState(settingsEpoch.getSnapshot());
				return settingsEpoch.subscribe(function () { setState(settingsEpoch.getSnapshot()); });
			}, []);
			return state[0];
		}
		/** Save watchdog timings (ms): "still saving" hint, then stop waiting and reload. */
		var SAVE_SLOW_MS = 3000;
		var SAVE_GIVE_UP_MS = 20000;

		/**
		 * One save's watchdog: the "still saving" hint at SAVE_SLOW_MS, then
		 * give up (stop blocking, reload) at SAVE_GIVE_UP_MS. `settle()` (the
		 * reply arrived) and `dispose()` (the form unmounted) clear both timers
		 * so neither fires into an unmounted component. `settle()` answers
		 * whether the reply beat the give-up deadline.
		 */
		function createSaveWatchdog(handlers, timers) {
			var set = timers && timers.set ? timers.set : function (fn, ms) { return setTimeout(fn, ms); };
			var clear = timers && timers.clear ? timers.clear : function (id) { clearTimeout(id); };
			var gaveUp = false;
			var finished = false;
			var slowTimer = set(function () { if (!finished) handlers.onSlow(); }, SAVE_SLOW_MS);
			var giveUpTimer = set(function () {
				if (finished) return;
				gaveUp = true;
				finished = true;
				clear(slowTimer);
				handlers.onGiveUp();
			}, SAVE_GIVE_UP_MS);
			function stop() { finished = true; clear(slowTimer); clear(giveUpTimer); }
			return {
				settle: function () { var inTime = !gaveUp; stop(); return inTime; },
				dispose: stop
			};
		}

		/**
		 * Draft after a successful save reply: the saved view's values when the
		 * reply is current; a late reply (after give-up / a newer save) keeps the
		 * user's draft — the diff against the new view still shows what is unsaved.
		 */
		function draftAfterSave(current, draft, view) {
			return current ? draftFromView(view) : draft;
		}

		/**
		 * The reading the ring shows: the projection, with the thresholds /
		 * enabled flag of a fresher `magicContext/context` read while the
		 * projection has not moved since that read was started (`live.base`).
		 * Once the projection updates (next step) it is authoritative again.
		 */
		function withLiveThresholds(pressure, live) {
			if (!pressure || !live || live.base !== pressure || !live.details || !live.details.thresholds) return pressure;
			var t = live.details.thresholds;
			var next = Object.assign({}, pressure);
			if (typeof t.executePercentage === "number") next.executePercentage = t.executePercentage;
			if (typeof t.forcePercentage === "number") next.forcePercentage = t.forcePercentage;
			if (typeof t.emergencyPercentage === "number") next.emergencyPercentage = t.emergencyPercentage;
			if (typeof live.details.enabled === "boolean") next.enabled = live.details.enabled;
			if (typeof t.executePercentage === "number" && typeof pressure.contextWindow === "number") {
				next.executeTokens = Math.round(pressure.contextWindow * t.executePercentage / 100);
			}
			if (typeof t.forcePercentage === "number" && typeof pressure.contextWindow === "number") {
				next.forceTokens = Math.round(pressure.contextWindow * t.forcePercentage / 100);
			}
			return next;
		}

		/** Status snapshot store (hooks seat of the slot contract). */
		function StatusController(connection) {
			this.connection = connection;
			this.store = clientStore.createSnapshotStore({ state: "idle", status: null, error: null });
			this.refresh = this.refresh.bind(this);
		}
		StatusController.prototype.refresh = function (args) {
			var controller = this;
			controller.store.set({ state: "loading", status: null, error: null });
			return callRemote(controller.connection, "status", args).then(function (result) {
				if (result.ok === true) controller.store.set({ state: "ready", status: result.value, error: null });
				else controller.store.set({ state: "error", status: null, error: result.error });
			});
		};

		/* ------------------------------------------------ helpers */
		function formatTokens(value) {
			if (typeof value !== "number" || !isFinite(value)) return "—";
			var scaled = function (n) { return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10); };
			if (value < 1e3) return String(Math.round(value));
			if (value < 1e6) return scaled(value / 1e3) + "K";
			return scaled(value / 1e6) + "M";
		}
		function sourceLabel(source) {
			return source === "dsh" ? L("src_dsh") : source === "profile" ? L("src_profile") : source === "jsonc" ? L("src_jsonc") : L("src_default");
		}
		function displayValue(value) {
			if (value === void 0 || value === null) return "—";
			if (typeof value === "object") {
				return Object.keys(value).map(function (key) { return key + "=" + value[key]; }).join(", ");
			}
			return String(value);
		}
		function shallowEqual(a, b) {
			if (a === b) return true;
			if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
			var ka = Object.keys(a), kb = Object.keys(b);
			if (ka.length !== kb.length) return false;
			for (var i = 0; i < ka.length; i++) if (a[ka[i]] !== b[ka[i]]) return false;
			return true;
		}
		function ChevronIcon(props) {
			return jsx("svg", {
				viewBox: "0 0 14 14", width: "14", height: "14", "aria-hidden": true,
				className: "ckmc-chevron" + (props.open ? " ckmc-chevronOpen" : ""),
				children: jsx("path", { d: "M3.5 5.25 7 8.75l3.5-3.5", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" })
			});
		}

		/* -------------------------------------- status summary */
		function storageText(status) {
			if (status.storage === void 0 || status.storage === null) return "unknown";
			if (status.storage.ok === true) return "ok · schema v" + status.storage.schemaVersion + "/" + status.storage.latestSupported;
			var reason = status.storage.reason !== void 0 ? status.storage.reason : "error";
			return reason + (status.storage.detail !== void 0 && status.storage.detail !== "" ? " · " + status.storage.detail : "");
		}
		function summaryRows(status) {
			return [
				{ label: "harness", value: "dsh", tone: "ok" },
				{ label: "storage", value: storageText(status), tone: status.storage && status.storage.ok ? "ok" : "err" },
				{ label: "config", value: status.config && status.config.exists ? "present" : "missing", tone: status.config && status.config.exists ? "ok" : "err" },
				{ label: "session", value: status.sessionId !== void 0 && status.sessionId !== null ? status.sessionId : "—" }
			];
		}
		function Rows(props) {
			return jsx("div", {
				children: props.rows.map(function (row) {
					return jsxs("div", {
						className: "ckmc-row",
						children: [
							jsx("span", { className: "ckmc-label", children: row.label }),
							jsx("span", { className: "ckmc-value" + (row.tone === "ok" ? " ckmc-valueOk" : row.tone === "err" ? " ckmc-valueErr" : ""), title: row.value, children: row.value })
						]
					}, row.label);
				})
			});
		}
		function StatusSummary(props) {
			var snapshot = props.useMagicStatus(function (state) { return state; });
			var rows = snapshot.status === null ? [] : summaryRows(snapshot.status);
			return jsxs("div", {
				className: "ckmc-card",
				children: [
					jsx("h3", { className: "ckmc-title", children: L("title") + " · " + L("status") }),
					jsx("p", { className: "ckmc-desc", children: L("subtitle") }),
					snapshot.state === "loading" ? jsx("p", { className: "ckmc-loading", children: L("loading") }) : null,
					snapshot.state === "error" ? jsx("p", { className: "ckmc-loading", children: L("unavailable") + ": " + (snapshot.error && snapshot.error.message !== void 0 ? snapshot.error.message : "unknown") }) : null,
					snapshot.state === "ready" ? jsx(Rows, { rows: rows }) : null,
					jsxs("div", {
						className: "ckmc-actions",
						children: [
							jsx("button", { type: "button", className: "ckmc-btn", disabled: snapshot.state === "loading", onClick: function () { props.onRefresh(); }, children: L("refresh") }),
							props.onClose !== void 0 ? jsx("button", { type: "button", className: "ckmc-btn", onClick: props.onClose, children: L("close") }) : null
						]
					})
				]
			});
		}

		/* -------------------------------------- settings editor */
		function pendingJson(v) {
			var t;
			try { t = v === undefined ? "—" : JSON.stringify(v); } catch (e) { t = String(v); }
			return t.length > 120 ? t.slice(0, 117) + "..." : t;
		}
		var SCALAR_FIELDS = ["enabled", "historianModel", "historianAwaitAtTurnEndMs", "executeThresholdPercentage", "protectedTokens"];

		/** Draft from the user layer: present = override, absent = inherit. */
		function draftFromView(view) {
			var user = (view && view.user) || {};
			var draft = {};
			SCALAR_FIELDS.forEach(function (field) {
				draft[field] = user[field] === void 0 ? { mode: "inherit", value: "" } : { mode: "override", value: user[field] };
			});
			var byModel = user.executeThresholdByModel || {};
			draft.executeThresholdByModel = Object.keys(byModel).map(function (key) { return { model: key, value: byModel[key] }; });
			return draft;
		}

		/** Parse/validate one draft value against the bounds; returns { ok, value } or { ok:false }. */
		function parseField(field, raw, bounds) {
			if (field === "enabled") return { ok: true, value: raw === true };
			if (field === "historianModel") {
				var text = String(raw).trim();
				return /^[^\s/]+\/\S+$/.test(text) ? { ok: true, value: text } : { ok: false };
			}
			var n = typeof raw === "number" ? raw : Number(String(raw).trim());
			if (!isFinite(n) || String(raw).trim() === "") return { ok: false };
			var b = field === "historianAwaitAtTurnEndMs" ? bounds.historianAwaitAtTurnEndMs : field === "protectedTokens" ? bounds.protectedTokens : bounds.executeThresholdPercentage;
			if (b !== void 0 && (n < b.min || n > b.max)) return { ok: false };
			if ((field === "historianAwaitAtTurnEndMs" || field === "protectedTokens") && Math.floor(n) !== n) return { ok: false };
			return { ok: true, value: n };
		}

		/** Ops from (user layer → draft); invalid fields block the save. */
		function opsFromDraft(view, draft) {
			var user = (view && view.user) || {};
			var bounds = (view && view.bounds) || {};
			var ops = [];
			var invalid = [];
			SCALAR_FIELDS.forEach(function (field) {
				var entry = draft[field];
				if (entry.mode === "inherit") {
					if (user[field] !== void 0) ops.push({ op: "unset", path: [field] });
					return;
				}
				var parsed = parseField(field, entry.value, bounds);
				if (!parsed.ok) { invalid.push(field); return; }
				if (user[field] !== parsed.value) ops.push({ op: "set", path: [field], value: parsed.value });
			});
			var next = {};
			draft.executeThresholdByModel.forEach(function (row) {
				var key = String(row.model).trim();
				if (key === "") return;
				// Same rule as the host validator: provider/model, <= 256 chars.
				if (key.length > 256 || !/^[^\s/]+\/\S+$/.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") { invalid.push("executeThresholdByModel:" + key); return; }
				var parsed = parseField("executeThresholdPercentage", row.value, bounds);
				if (!parsed.ok) { invalid.push("executeThresholdByModel:" + key); return; }
				next[key] = parsed.value;
			});
			var current = user.executeThresholdByModel || {};
			if (!shallowEqual(next, current)) {
				ops.push(Object.keys(next).length === 0 ? { op: "unset", path: ["executeThresholdByModel"] } : { op: "set", path: ["executeThresholdByModel"], value: next });
			}
			return { ops: ops, invalid: invalid };
		}

		function Segmented(props) {
			return jsxs("span", {
				className: "ckmc-seg",
				role: "group",
				children: [
					jsx("button", { type: "button", "aria-pressed": props.mode === "inherit", disabled: props.disabled, onClick: function () { props.onChange("inherit"); }, children: L("inherit") }),
					jsx("button", { type: "button", "aria-pressed": props.mode === "override", disabled: props.disabled, onClick: function () { props.onChange("override"); }, children: L("override") })
				]
			});
		}

		function FieldRow(props) {
			var eff = props.effective;
			return jsxs("div", {
				className: "ckmc-field",
				children: [
					jsx("span", { className: "ckmc-fieldLabel", children: props.label }),
					props.segmented === false ? null : jsx(Segmented, { mode: props.entry.mode, disabled: props.disabled, onChange: props.onMode }),
					jsx("div", { className: "ckmc-fieldControl", children: props.children }),
					jsx("span", {
						className: "ckmc-fieldMeta",
						children: L("effective") + ": " + displayValue(eff && eff.value) + " · " + sourceLabel(eff && eff.source) + (props.hint ? " — " + props.hint : "")
					})
				]
			});
		}

		/**
		 * The editable form. `connection` is the shared RPC connection; the
		 * component owns its view/draft state and serializes saves.
		 */
		function SettingsEditor(props) {
			var connection = props.connection;
			var viewState = react.useState({ state: "loading", view: null, error: null });
			var vs = viewState[0], setVs = viewState[1];
			var draftState = react.useState(null);
			var draft = draftState[0], setDraft = draftState[1];
			var noticeState = react.useState(null);
			var notice = noticeState[0], setNotice = noticeState[1];
			var savingState = react.useState(false);
			var saving = savingState[0], setSaving = savingState[1];
			var saveSeq = react.useRef(0);
			var mountedRef = react.useRef(true);
			var watchdogRef = react.useRef(null);
			// Unmount: no timer and no late reply may touch this component.
			react.useEffect(function () {
				mountedRef.current = true;
				return function () {
					mountedRef.current = false;
					if (watchdogRef.current) watchdogRef.current.dispose();
					watchdogRef.current = null;
				};
			}, []);

			var load = react.useCallback(function (keepDraft) {
				setVs(function (prev) { return { state: prev.view ? "ready" : "loading", view: prev.view, error: null }; });
				return callRemote(connection, "settings", {}).then(function (result) {
					if (!mountedRef.current) return;
					if (result.ok === true) {
						setVs({ state: "ready", view: result.value, error: null });
						if (!keepDraft) setDraft(draftFromView(result.value));
					} else {
						setVs({ state: "error", view: null, error: errorText(result) });
					}
				});
			}, [connection]);
			react.useEffect(function () { load(false); }, [load]);

			if (vs.state === "loading" || draft === null) {
				return jsx("div", { className: "ckmc-card", children: jsx("p", { className: "ckmc-loading", children: vs.state === "error" ? L("unavailable") + ": " + vs.error : L("loading") }) });
			}
			if (vs.state === "error" || vs.view === null) {
				return jsxs("div", { className: "ckmc-card", children: [
					jsx("p", { className: "ckmc-loading", children: L("unavailable") + ": " + vs.error }),
					jsx("button", { type: "button", className: "ckmc-btn", onClick: function () { load(false); }, children: L("refresh") })
				] });
			}
			var view = vs.view;
			var editable = view.available === true && view.writable === true && !saving;
			var plan = opsFromDraft(view, draft);
			var dirty = plan.ops.length > 0 || plan.invalid.length > 0;
			var setEntry = function (field, patch) {
				setNotice(null);
				setDraft(function (prev) {
					var next = Object.assign({}, prev);
					next[field] = Object.assign({}, prev[field], patch);
					return next;
				});
			};
			var setMode = function (field, mode) {
				var eff = view.effective && view.effective[field === "executeThresholdPercentage" ? "executeThreshold" : field];
				var seed = draft[field].value;
				if (mode === "override" && (seed === "" || seed === void 0)) {
					var v = eff ? eff.value : "";
					seed = field === "enabled" ? v !== false : typeof v === "object" && v !== null ? v["default"] : v === void 0 || v === null ? "" : v;
				}
				setEntry(field, { mode: mode, value: seed });
			};
			var input = function (field, narrow, type) {
				var entry = draft[field];
				var bad = entry.mode === "override" && !parseField(field, entry.value, view.bounds || {}).ok;
				return jsx("input", {
					className: "ckmc-input" + (narrow ? " ckmc-inputNarrow" : "") + (bad ? " ckmc-inputErr" : ""),
					type: type || "text",
					inputMode: type === "number" ? "numeric" : void 0,
					disabled: !editable || entry.mode === "inherit",
					value: entry.mode === "inherit" ? "" : String(entry.value),
					placeholder: entry.mode === "inherit" ? L("inherit") : "",
					"aria-invalid": bad ? "true" : "false",
					onChange: function (event) { setEntry(field, { value: event.target.value }); }
				});
			};
			var save = function () {
				if (plan.invalid.length > 0 || plan.ops.length === 0) return;
				var seq = saveSeq.current + 1;
				saveSeq.current = seq;
				setSaving(true);
				setNotice(null);
				// Watchdog: DSH serializes profile writes with the running turn,
				// so the reply can lag (round 8: >3 s although the row was
				// already written). Say so after SAVE_SLOW_MS; after
				// SAVE_GIVE_UP_MS stop blocking the form and reload the real
				// state (the draft is kept). A late reply still lands below.
				if (watchdogRef.current) watchdogRef.current.dispose();
				var watchdog = createSaveWatchdog({
					onSlow: function () {
						if (mountedRef.current && saveSeq.current === seq) setNotice({ tone: "info", text: L("savingSlow") });
					},
					onGiveUp: function () {
						if (!mountedRef.current || saveSeq.current !== seq) return;
						saveSeq.current = seq + 1;
						setSaving(false);
						setNotice({ tone: "err", text: L("savingGaveUp") });
						load(true);
					}
				});
				watchdogRef.current = watchdog;
				callRemote(connection, "updateSettings", { ops: plan.ops, expectedRevision: view.revision }).then(function (result) {
					watchdog.settle();
					if (watchdogRef.current === watchdog) watchdogRef.current = null;
					if (!mountedRef.current) return;
					var current = saveSeq.current === seq;
					if (current) setSaving(false);
					if (result.ok !== true) {
						if (current) setNotice({ tone: "err", text: L("unavailable") + ": " + errorText(result) });
						return;
					}
					var value = result.value;
					if (value.ok === true) {
						setVs({ state: "ready", view: value.view, error: null });
						setDraft(function (prev) { return draftAfterSave(current, prev, value.view); });
						setNotice({ tone: "ok", text: L("saved") });
						// Thresholds / enabled changed: refresh the composer ring now.
						bumpSettingsEpoch();
						return;
					}
					if (!current) return;
					if (value.view) setVs({ state: "ready", view: value.view, error: null });
					setNotice({ tone: "err", text: value.code === "conflict" ? L("conflict") : (value.code === "invalid" ? L("invalid") + ": " : "") + value.message });
				});
			};
			var byModelRows = draft.executeThresholdByModel;
			var effT = view.effective && view.effective.executeThreshold;
			return jsxs("div", {
				className: "ckmc-card",
				children: [
					jsx("h3", { className: "ckmc-title", children: L("title") + " · " + L("settings") }),
					jsx("p", { className: "ckmc-desc", children: L("precedence") }),
					Array.isArray(view.pendingRestart) && view.pendingRestart.length > 0
						? jsxs("div", { className: "ckmc-notice", children: [
							jsx("p", { children: L("pending_title") }),
							jsx("ul", { children: view.pendingRestart.map(function (c) {
								return jsx("li", { children: c.key + " — " + L("pending_running") + ": " + pendingJson(c.running) + " · " + L("pending_next") + ": " + pendingJson(c.next) }, c.key);
							}) })
						] })
						: null,
					view.available !== true || view.writable !== true
						? jsx("p", { className: "ckmc-notice ckmc-noticeErr", children: L("readonly") + (view.reason ? ": " + view.reason : "") })
						: null,
					jsx(FieldRow, {
						label: L("f_enabled"), hint: L("f_enabled_hint"), entry: draft.enabled, effective: view.effective.enabled,
						disabled: !editable, onMode: function (m) { setMode("enabled", m); },
						children: jsxs("label", { className: "ckmc-check", children: [
							jsx("input", { type: "checkbox", disabled: !editable || draft.enabled.mode === "inherit", checked: draft.enabled.mode === "override" ? draft.enabled.value === true : view.effective.enabled.value === true, onChange: function (event) { setEntry("enabled", { value: event.target.checked }); } }),
							jsx("span", { children: L("f_enabled") })
						] })
					}),
					jsx(FieldRow, {
						label: L("f_historianModel"), hint: L("f_historianModel_hint"), entry: draft.historianModel, effective: view.effective.historianModel,
						disabled: !editable, onMode: function (m) { setMode("historianModel", m); }, children: input("historianModel", false, "text")
					}),
					jsx(FieldRow, {
						label: L("f_await"), hint: L("f_await_hint"), entry: draft.historianAwaitAtTurnEndMs, effective: view.effective.historianAwaitAtTurnEndMs,
						disabled: !editable, onMode: function (m) { setMode("historianAwaitAtTurnEndMs", m); }, children: input("historianAwaitAtTurnEndMs", true, "number")
					}),
					jsx(FieldRow, {
						label: L("f_threshold"), hint: L("f_threshold_hint"), entry: draft.executeThresholdPercentage, effective: effT,
						disabled: !editable, onMode: function (m) { setMode("executeThresholdPercentage", m); }, children: input("executeThresholdPercentage", true, "number")
					}),
					jsx(FieldRow, {
						label: L("f_byModel"), hint: L("f_byModel_hint"), segmented: false, entry: { mode: "override" }, effective: effT,
						children: jsxs("div", { children: [
							byModelRows.map(function (row, index) {
								var bad = String(row.model).trim() !== "" && !parseField("executeThresholdPercentage", row.value, view.bounds || {}).ok;
								return jsxs("div", { className: "ckmc-modelRow", children: [
									jsx("input", { className: "ckmc-input", disabled: !editable, value: row.model, placeholder: "provider/model", onChange: function (event) {
										var value = event.target.value;
										setNotice(null);
										setDraft(function (prev) { var rows = prev.executeThresholdByModel.slice(); rows[index] = { model: value, value: rows[index].value }; return Object.assign({}, prev, { executeThresholdByModel: rows }); });
									} }),
									jsx("input", { className: "ckmc-input ckmc-inputNarrow" + (bad ? " ckmc-inputErr" : ""), disabled: !editable, value: String(row.value), inputMode: "numeric", onChange: function (event) {
										var value = event.target.value;
										setNotice(null);
										setDraft(function (prev) { var rows = prev.executeThresholdByModel.slice(); rows[index] = { model: rows[index].model, value: value }; return Object.assign({}, prev, { executeThresholdByModel: rows }); });
									} }),
									jsx("button", { type: "button", className: "ckmc-btn", disabled: !editable, onClick: function () {
										setNotice(null);
										setDraft(function (prev) { var rows = prev.executeThresholdByModel.slice(); rows.splice(index, 1); return Object.assign({}, prev, { executeThresholdByModel: rows }); });
									}, children: L("remove") })
								] }, index);
							}),
							jsx("button", { type: "button", className: "ckmc-btn", style: { marginTop: "6px" }, disabled: !editable, onClick: function () {
								setDraft(function (prev) { return Object.assign({}, prev, { executeThresholdByModel: prev.executeThresholdByModel.concat([{ model: "", value: 65 }]) }); });
							}, children: L("add_model") })
						] })
					}),
					jsx(FieldRow, {
						label: L("f_protected"), hint: L("f_protected_hint"), entry: draft.protectedTokens, effective: view.effective.protectedTokens,
						disabled: !editable, onMode: function (m) { setMode("protectedTokens", m); }, children: input("protectedTokens", true, "number")
					}),
					notice !== null ? jsx("p", { className: "ckmc-notice" + (notice.tone === "err" ? " ckmc-noticeErr" : ""), role: notice.tone === "err" ? "alert" : "status", children: notice.text }) : null,
					jsxs("div", {
						className: "ckmc-actions",
						children: [
							jsx("button", { type: "button", className: "ckmc-btn ckmc-btnPrimary", disabled: !editable || !dirty || plan.invalid.length > 0, onClick: save, children: saving ? L("saving") : L("save") }),
							jsx("button", { type: "button", className: "ckmc-btn", disabled: saving || !dirty, onClick: function () { setNotice(null); setDraft(draftFromView(view)); }, children: L("reset") }),
							jsx("button", { type: "button", className: "ckmc-btn", disabled: saving, onClick: function () { load(dirty); }, children: L("refresh") })
						]
					}),
					jsx("p", { className: "ckmc-hint", children: L("configPath") + ": " + (view.jsonc ? view.jsonc.path + (view.jsonc.exists ? "" : " (missing)") : "—") + " · revision " + (view.revision === void 0 ? "—" : view.revision) })
				]
			});
		}

		/* ------------------------------- settings.section entry */
		function MagicSettingsSection(props) {
			return jsxs("div", {
				className: "ckmc-root",
				children: [
					jsx(StatusSummary, { useMagicStatus: props.useMagicStatus, onRefresh: function () { props.refresh({}); } }),
					jsx(SettingsEditor, { connection: props.connection })
				]
			});
		}

		/* ------------------------- plugins.bundle.config entry */
		function MagicBundleConfig(props) {
			if (props.view === "summary") return L("title") + " — " + L("settings");
			return jsx(SettingsEditor, { connection: props.connection });
		}

		/* -------------------- header action entry (session) */
		function useDismiss(open, setOpen, refs) {
			react.useEffect(function () {
				if (!open) return;
				var closeOutside = function (event) {
					var inside = refs.some(function (ref) { return ref.current && event.target instanceof Node && ref.current.contains(event.target); });
					if (!inside) setOpen(false);
				};
				var onKeyDown = function (event) { if (event.key === "Escape") setOpen(false); };
				document.addEventListener("pointerdown", closeOutside);
				document.addEventListener("keydown", onKeyDown);
				return function () {
					document.removeEventListener("pointerdown", closeOutside);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
		}
		function MagicHeaderAction(props) {
			var openState = react.useState(false);
			var open = openState[0], setOpen = openState[1];
			var rootRef = react.useRef(null);
			useDismiss(open, setOpen, [rootRef]);
			react.useEffect(function () { if (open) props.refresh({ sessionId: props.sessionId }); }, [open]);
			return jsxs("div", {
				ref: rootRef,
				className: "ckmc-root",
				children: [
					jsxs("button", {
						type: "button", className: "ckmc-trigger", "aria-expanded": open ? "true" : "false",
						"aria-label": L("title") + " " + L("status"), title: L("title") + " " + L("status"),
						onClick: function () { setOpen(!open); },
						children: [jsx("span", { children: "MC" }), jsx(ChevronIcon, { open: open })]
					}),
					open ? jsx("div", { className: "ckmc-menu", children: jsx(StatusSummary, {
						useMagicStatus: props.useMagicStatus,
						onRefresh: function () { props.refresh({ sessionId: props.sessionId }); },
						onClose: function () { setOpen(false); }
					}) }) : null
				]
			});
		}

		/* ------------------------- composer dock indicator */
		var RADIUS = 5.5;
		var CIRCUMFERENCE = 2 * Math.PI * RADIUS;
		/** Points below the force threshold where the ring already turns red. */
		var FORCE_APPROACH = 3;

		/** Tone for a reading: normal → warn (≥ execute) → danger (≥ force − 3). */
		function meterTone(pressure) {
			if (!pressure || typeof pressure.percent !== "number" || pressure.managed !== true || pressure.enabled !== true) return "";
			if (pressure.percent >= pressure.forcePercentage - FORCE_APPROACH) return "ckmc-danger";
			if (pressure.percent >= pressure.executePercentage) return "ckmc-warn";
			return "";
		}

		function anchoredStyle(anchor) {
			if (!anchor || typeof anchor.getBoundingClientRect !== "function") return { visibility: "hidden", left: 0, top: 0 };
			var rect = anchor.getBoundingClientRect();
			var width = Math.min(300, window.innerWidth - 24);
			var left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
			return { left: left + "px", bottom: Math.max(12, window.innerHeight - rect.top + 8) + "px" };
		}

		function openMagicSettings(ctxRef) {
			var nav = null;
			try { nav = ctxRef && typeof ctxRef.get === "function" ? ctxRef.get("pluginNavigation") : null; } catch (_error) { nav = null; }
			if (nav && typeof nav.openBundle === "function") { nav.openBundle("dsh-magic-context"); return true; }
			return false;
		}

		function KV(props) {
			return jsxs("div", { className: "ckmc-kv", children: [jsx("dt", { children: props.k }), jsx("dd", { title: String(props.v), children: props.v })] });
		}

		function MeterPanel(props) {
			var p = props.pressure;
			var d = props.details;
			var breakdown = props.breakdown;
			var used = p.usedTokens;
			var pct = p.percent;
			var total = breakdown ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens : 0;
			var segs = breakdown && total > 0 ? [
				{ key: "systemTokens", cls: "ckmc-tSystem", label: L("system") },
				{ key: "toolsTokens", cls: "ckmc-tTools", label: L("tools") },
				{ key: "messageTokens", cls: "ckmc-tMessages", label: L("messages") }
			] : [];
			var managed = p.managed === true;
			var historianState = d && d.historian ? L("h_" + d.historian.state) : "—";
			var nudgeText = d && d.nudge ? ([d.nudge.band, d.nudge.level].filter(Boolean).join(" · ") || L("nudge_none")) + (d.nudge.notePending ? " · " + L("notePending") : "") : "—";
			return jsxs("div", {
				ref: props.panelRef,
				className: "ckmc-panel",
				role: "dialog",
				"aria-label": L("meter_title"),
				style: props.style,
				children: [
					jsxs("div", { className: "ckmc-panelHead", children: [
						jsx("span", { children: L("meter_title") }),
						jsx("span", { className: "ckmc-panelPct " + meterTone(p), children: typeof pct === "number" ? pct + "%" : "—" }),
						jsx("span", { className: "ckmc-panelFig", children: formatTokens(used) + " / " + formatTokens(p.contextWindow) })
					] }),
					jsxs("div", { className: "ckmc-bar", children: [
						(segs.length > 0 ? segs : [{ key: "_all", cls: "", label: "" }]).map(function (seg) {
							var width = seg.key === "_all" ? pct : pct * breakdown[seg.key] / total;
							return width > 0 ? jsx("span", { className: "ckmc-seg2 " + seg.cls, style: { width: width + "%" } }, seg.key) : null;
						}),
						managed ? jsx("span", { className: "ckmc-mark ckmc-markExec", title: L("execute"), style: { left: "calc(" + p.executePercentage + "% - 1px)" } }) : null,
						managed ? jsx("span", { className: "ckmc-mark ckmc-markForce", title: L("force"), style: { left: "calc(" + p.forcePercentage + "% - 1px)" } }) : null
					] }),
					!managed ? jsx("p", { className: "ckmc-hint", children: L("notManaged", { preset: p.agentPreset || "?" }) }) : null,
					managed && p.enabled !== true ? jsx("p", { className: "ckmc-hint", children: L("disabled") }) : null,
					jsxs("dl", { className: "ckmc-section", style: { margin: "10px 0 0" }, children: [
						jsx(KV, { k: L("used"), v: formatTokens(used) + (typeof pct === "number" ? " (" + pct + "%)" : "") }),
						jsx(KV, { k: L("window"), v: formatTokens(p.contextWindow) + (p.model ? " · " + p.provider + "/" + p.model : "") }),
						managed ? jsx(KV, { k: L("execute"), v: p.executePercentage + "%" + (p.executeTokens !== void 0 ? " · " + formatTokens(p.executeTokens) : "") + (p.thresholdMode === "tokens" ? " (tokens)" : "") }) : null,
						managed ? jsx(KV, { k: L("force"), v: p.forcePercentage + "%" + (p.forceTokens !== void 0 ? " · " + formatTokens(p.forceTokens) : "") }) : null,
						managed ? jsx(KV, { k: L("emergency"), v: p.emergencyPercentage + "%" }) : null
					] }),
					segs.length > 0 ? jsx("dl", { className: "ckmc-section", style: { margin: "10px 0 0" }, children: segs.map(function (seg) {
						return jsxs("div", { className: "ckmc-kv " + seg.cls, children: [
							jsxs("dt", { children: [jsx("span", { className: "ckmc-swatch" }), seg.label] }),
							jsx("dd", { children: L("approx") + formatTokens(breakdown[seg.key]) })
						] }, seg.key);
					}) }) : null,
					managed ? jsx("dl", { className: "ckmc-section", style: { margin: "10px 0 0" }, children: d === null
						? [jsx("p", { className: "ckmc-loading", children: props.detailsError ? L("detailsUnavailable") + ": " + props.detailsError : L("loading") }, "l")]
						: [
							jsx(KV, { k: L("compartments"), v: String(d.compartments) }, "c"),
							jsx(KV, { k: L("historian"), v: historianState + (d.historian.lastError && d.historian.state === "failed" ? " · " + d.historian.lastError : "") }, "h"),
							jsx(KV, { k: L("pendingDrops"), v: String(d.pending.drops) }, "pd"),
							d.pending.outbox > 0 ? jsx(KV, { k: L("pendingOutbox"), v: String(d.pending.outbox) }, "po") : null,
							d.tags && d.tags.truncated > 0 ? jsx(KV, { k: L("truncatedTools"), v: String(d.tags.truncated) }, "tt") : null,
							jsx(KV, { k: L("knowledge"), v: L("approx") + formatTokens(d.knowledge.m0Tokens + d.knowledge.m1Tokens) + " (m0 " + formatTokens(d.knowledge.m0Tokens) + " · m1 " + formatTokens(d.knowledge.m1Tokens) + ")" }, "k"),
							jsx(KV, { k: L("nudge"), v: nudgeText }, "n")
						] }) : null,
					jsx("button", { type: "button", className: "ckmc-link", onClick: props.onOpenSettings, children: props.settingsFallback ? L("settingsWhere") : L("openSettings") + " →" })
				]
			});
		}

		function MagicMeterDock(props) {
			var projected = props.useProjection("magicContextPressure");
			var epoch = useSettingsEpoch().epoch;
			var liveState = react.useState(null);
			var live = liveState[0], setLive = liveState[1];
			var pressure = withLiveThresholds(projected, live);
			var breakdown = props.useProjection("contextBreakdown");
			var openState = react.useState(false);
			var open = openState[0], setOpen = openState[1];
			var detailsState = react.useState({ details: null, error: null });
			var details = detailsState[0], setDetails = detailsState[1];
			var fallbackState = react.useState(false);
			var settingsFallback = fallbackState[0], setSettingsFallback = fallbackState[1];
			var rootRef = react.useRef(null);
			var panelRef = react.useRef(null);
			var available = pressure !== void 0 && pressure !== null && typeof pressure.percent === "number";
			useDismiss(open && available, setOpen, [rootRef, panelRef]);
			// After a Save (epoch bump) re-read the thresholds at once: the
			// projection itself only moves on the next agent step.
			react.useEffect(function () {
				if (epoch === 0 || !available || projected.managed !== true) return;
				var cancelled = false;
				var base = projected;
				callRemote(props.connection, "context", {
					sessionId: props.sessionId,
					model: base.provider && base.model ? base.provider + "/" + base.model : void 0,
					contextWindow: base.contextWindow
				}).then(function (result) {
					if (cancelled || result.ok !== true) return;
					setLive({ base: base, details: result.value });
				});
				return function () { cancelled = true; };
			}, [epoch]);
			react.useEffect(function () {
				if (!open || !available || pressure.managed !== true) return;
				var cancelled = false;
				setDetails({ details: null, error: null });
				callRemote(props.connection, "context", {
					sessionId: props.sessionId,
					model: pressure.provider && pressure.model ? pressure.provider + "/" + pressure.model : void 0,
					contextWindow: pressure.contextWindow
				}).then(function (result) {
					if (cancelled) return;
					if (result.ok === true) setDetails({ details: result.value, error: null });
					else setDetails({ details: null, error: errorText(result) });
				});
				return function () { cancelled = true; };
			}, [open, available, props.sessionId, epoch]);
			if (!available) return null;
			var percent = pressure.percent;
			var tone = meterTone(pressure);
			var reading = percent + "%";
			var panel = open ? jsx(MeterPanel, {
				panelRef: panelRef,
				style: anchoredStyle(rootRef.current),
				pressure: pressure,
				breakdown: breakdown,
				details: details.details,
				detailsError: details.error,
				settingsFallback: settingsFallback,
				onOpenSettings: function () {
					if (openMagicSettings(props.ctxRef)) setOpen(false);
					else setSettingsFallback(true);
				}
			}) : null;
			return jsxs("span", {
				ref: rootRef,
				className: "ckmc-meter " + tone,
				children: [
					jsxs("button", {
						type: "button",
						className: "ckmc-meterTrigger",
						"aria-label": L("meter_aria", { p: reading }),
						title: L("meter_aria", { p: reading }) + (pressure.managed === true ? " · " + L("execute") + " " + pressure.executePercentage + "% · " + L("force") + " " + pressure.forcePercentage + "%" : ""),
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						onClick: function () { setOpen(!open); },
						children: [
							jsxs("svg", { viewBox: "0 0 14 14", width: "14", height: "14", "aria-hidden": true, children: [
								jsx("circle", { className: "ckmc-ringTrack", cx: "7", cy: "7", r: RADIUS }),
								jsx("circle", { className: "ckmc-ringFill", cx: "7", cy: "7", r: RADIUS, strokeDasharray: (CIRCUMFERENCE * percent / 100) + " " + CIRCUMFERENCE, transform: "rotate(-90 7 7)" })
							] }),
							jsx("span", { children: reading })
						]
					}),
					panel !== null && reactDom !== null && typeof reactDom.createPortal === "function" ? reactDom.createPortal(panel, document.body) : panel
				]
			});
		}

		/* ------------------------------------------------ mount */
		function apply(ctx) {
			var connection = ctx.get("connection");
			// One controller per slot: the settings section is root-scoped and
			// refreshes with no session, while the header action is session-
			// scoped — sharing one store would leak the session into the card.
			var sectionController = new StatusController(connection);
			var headerController = new StatusController(connection);

			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "magic-context",
					order: 60,
					label: "Magic Context",
					inject: function () {
						return { hooks: { magicStatus: sectionController.store }, refresh: sectionController.refresh, connection: connection };
					}
				}, MagicSettingsSection);
			});

			ctx.slots.inject("plugins.bundle.config", function () {
				return ctx.slots.register({
					name: "plugins.bundle.config",
					key: "dsh-magic-context",
					inject: function () { return { connection: connection }; }
				}, MagicBundleConfig);
			});

			ctx.slots.inject("conversation.session.header.actions", function () {
				return ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "magic-context-status",
					order: 40,
					label: L("title") + " " + L("status"),
					inject: function () {
						return { hooks: { magicStatus: headerController.store }, refresh: headerController.refresh };
					}
				}, MagicHeaderAction);
			});

			ctx.slots.inject("conversation.composer.dock", function () {
				return ctx.slots.register({
					name: "conversation.composer.dock",
					id: "magic-context-meter",
					order: 1000,
					label: "Magic Context",
					inject: function () { return { connection: connection, ctxRef: ctx }; }
				}, MagicMeterDock);
			});
		}

		exports.name = "dsh-magic-context";
		exports.inject = ["slots", "connection"];
		exports.apply = apply;
		/* test seams (pure helpers; no DOM) */
		exports.__test = { opsFromDraft: opsFromDraft, draftFromView: draftFromView, parseField: parseField, meterTone: meterTone, callRemote: callRemote, withLiveThresholds: withLiveThresholds, settingsEpoch: settingsEpoch, bumpSettingsEpoch: bumpSettingsEpoch, SAVE_SLOW_MS: SAVE_SLOW_MS, SAVE_GIVE_UP_MS: SAVE_GIVE_UP_MS, createSaveWatchdog: createSaveWatchdog, draftAfterSave: draftAfterSave };
		return module.exports;
	}
});
