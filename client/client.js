window.__ModuleLoader__.load({ id: "@sharework-ai/dsh-docwright", factory: (require) => {

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		_deepseek_ai_dsh_client_ui_primitives = __toESM(_deepseek_ai_dsh_client_ui_primitives, 1);
		//#region src/description.ts
		/** Resolve for a surface: the requested locale first, `en` as the fallback. */
		function resolveLocalized(text, locale) {
			if (text === void 0) return "";
			if (typeof text === "string") return text;
			if (locale !== "en" && typeof text[locale] === "string") return text[locale];
			return text.en;
		}
		//#endregion
		//#region src/client/api.ts
		var ApiError = class extends Error {
			code;
			params;
			detail;
			constructor(message, coded = {}) {
				super(message);
				this.name = "ApiError";
				if (coded.code !== void 0) this.code = coded.code;
				if (coded.params !== void 0) this.params = coded.params;
				if (coded.detail !== void 0) this.detail = coded.detail;
			}
		};
		async function parse(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new ApiError(`docwright: the server answered HTTP ${response.status} with a non-JSON body; is the docwright plugin loaded?`);
			}
			if (!response.ok) {
				const envelope = body;
				const message = typeof envelope.error === "string" && envelope.error.length > 0 ? envelope.error : `docwright request failed with HTTP ${response.status}`;
				const coded = {};
				if (typeof envelope.code === "string") coded.code = envelope.code;
				if (typeof envelope.params === "object" && envelope.params !== null) coded.params = envelope.params;
				if (typeof envelope.detail === "string") coded.detail = envelope.detail;
				throw new ApiError(message, coded);
			}
			return body;
		}
		/** Fetch the params catalog (packs, aggregation groups, config provenance). */
		async function fetchParams() {
			return parse(await fetch("/api/docwright/params", { headers: { accept: "application/json" } }));
		}
		/** Merge a Config patch through the host settings service (server-proxied). */
		async function saveConfigPatch(patch) {
			await parse(await fetch("/api/docwright/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ patch })
			}));
		}
		/** Set one pack param default in its manifest (server re-validates at load strength). `origin` echoes the card's rendered pack origin — a mismatch (a same-name copy changed the resolution in between) refuses the write. */
		async function savePackParam(pack, param, value, origin) {
			await parse(await fetch("/api/docwright/pack-param", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pack,
					param,
					value,
					...origin !== void 0 ? { origin } : {}
				})
			}));
		}
		/** Version standing of the managed packs; `pack` scopes the check to one
		* card (the check is per-card in the UI). One server-side market fetch. */
		async function fetchPackUpdates(pack) {
			const suffix = pack !== void 0 ? `?pack=${encodeURIComponent(pack)}` : "";
			return (await parse(await fetch(`/api/docwright/pack-updates${suffix}`, { headers: { accept: "application/json" } }))).updates;
		}
		/** Update one managed pack from the market (verified download, atomic swap). */
		async function updateManagedPack(pack, force = false) {
			return (await parse(await fetch("/api/docwright/pack-update", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pack,
					force
				})
			}))).version;
		}
		/** Delete one managed pack (its packsDir directory; restores a same-name builtin override if any). `force` bypasses the in-use guard (the UI sends it from the second confirm click, which named the consumers). */
		async function deleteManagedPack(pack, force = false) {
			await parse(await fetch("/api/docwright/pack-delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pack,
					force
				})
			}));
		}
		/** Toggle one pack's enabled state (docs/designs/pack-load-dirs.md). The server guards suite members (disable the suite instead) and in-use packs (force names the consumers). Returns the persisted array. */
		async function setPackDisabled(pack, disabled, force = false) {
			return (await parse(await fetch("/api/docwright/pack-disabled", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					pack,
					disabled,
					force
				})
			}))).disabled;
		}
		/** Suite standing for the Suites tab: the market's suite list with each
		* member's local placement. An empty array means the market has no suites
		* (or does not support them) — a one-line note, never an error. */
		async function fetchSuiteStatus() {
			return (await parse(await fetch("/api/docwright/suites", { headers: { accept: "application/json" } }))).suites;
		}
		/** Update a suite: refresh each outdated member to its market version. `force`
		* answers the server's aggregated compat-break gate (consumers below a
		* member's compat floor) after the user confirmed the warning. */
		async function updateSuite(suite, force = false) {
			return parse(await fetch("/api/docwright/suite-update", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					suite,
					force
				})
			}));
		}
		/** Delete a suite's installed members — all of them. Members with consumers
		* outside the suite need force (the UI's force checkbox after the warning
		* named those consumers). */
		async function deleteSuite(suite, force = false) {
			return parse(await fetch("/api/docwright/suite-delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					suite,
					force
				})
			}));
		}
		/** Install one pack (with its consumed closure) from the market into packsDir. */
		async function installMarketPack(pack) {
			return (await parse(await fetch("/api/docwright/pack-install", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ pack })
			}))).installed;
		}
		/** Install every suite member from the market into packsDir. */
		async function installMarketSuite(suite) {
			return (await parse(await fetch("/api/docwright/suite-install", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ suite })
			}))).installed;
		}
		//#endregion
		//#region src/client/icons.ts
		const DEPENDS_ICON_PATH = "M914.285 292.572h-73.142c-21.943 0-36.571 14.628-36.571 36.571 0 21.942 14.628 36.572 36.571 36.572h73.142c21.943 0 36.572 14.628 36.572 36.57v512c0 21.943-14.629 36.572-36.572 36.572h-512c-21.942 0-36.57-14.629-36.57-36.572V621.716c0-21.943-14.63-36.572-36.572-36.572-21.943 0-36.571 14.629-36.571 36.572v292.568c0 58.515 51.2 109.715 109.713 109.715h512C972.8 1024 1024 972.8 1024 914.285v-512c0-58.513-51.2-109.713-109.715-109.713M694.857 694.857c14.628-14.629 14.628-36.572 0-51.2L380.343 329.143c-14.628-14.628-36.571-14.628-51.2 0-14.628 14.629-14.628 36.572 0 51.2l321.829 321.829c7.313 7.313 29.256 7.313 43.885-7.315m-512-36.572h-73.141c-21.943 0-36.572-14.628-36.572-36.57v-512c0-21.943 14.629-36.572 36.572-36.572h512c21.942 0 36.57 14.629 36.57 36.572v292.569c0 21.943 14.63 36.572 36.572 36.572 21.943 0 36.572-14.629 36.572-36.572V109.716C731.428 51.2 680.228 0 621.716 0h-512C51.2 0 0 51.2 0 109.715v512c0 58.513 51.2 109.713 109.715 109.713h73.142c21.943 0 36.571-14.628 36.571-36.571 0-21.942-14.628-36.572-36.571-36.572";
		const SUITE_ICON_PATH = "M312.79104 494.81728l-132.11648-79.17568a22.15936 22.15936 0 0 0-30.6176 7.5776 22.46656 22.46656 0 0 0 7.5776 30.86336l132.13696 79.17568a22.03648 22.03648 0 0 0 30.6176-7.82336 22.13888 22.13888 0 0 0-7.59808-30.6176zm140.86144 465.98144c5.30432 3.11296 11.264 2.23232 16.7936-4.01408-5.05856 5.34528-11.03872 7.12704-16.7936 4.01408zM312.79104 494.7968l-132.11648-79.17568a22.15936 22.15936 0 0 0-30.6176 7.5776 22.46656 22.46656 0 0 0 7.5776 30.86336l132.13696 79.17568a22.03648 22.03648 0 0 0 30.6176-7.82336 22.13888 22.13888 0 0 0-7.59808-30.6176zm0 0l-132.11648-79.17568a22.15936 22.15936 0 0 0-30.6176 7.5776 22.46656 22.46656 0 0 0 7.5776 30.86336l132.13696 79.17568a22.03648 22.03648 0 0 0 30.6176-7.82336 22.13888 22.13888 0 0 0-7.59808-30.6176zm157.67552 461.94688c-5.5296 6.22592-11.50976 7.12704-16.7936 4.01408 5.7344 3.15392 11.71456 1.37216 16.7936-4.01408zm11.63264-57.9584v-397.7216l350.33088-198.8608 35.86048-21.74976c7.168-4.66944 8.54016-10.60864 9.48224-14.86848a22.528 22.528 0 0 0-12.1856-22.54848L469.66784 45.09696a22.4256 22.4256 0 0 0-20.25472 0l-395.8784 197.95968c-14.7456 9.66656-12.45184 31.06816-12.45184 33.3824V698.7776c0 7.82336 4.15744 15.19616 10.83392 19.33312 0 0 387.3792 234.0864 394.0352 237.07648 13.59872 6.67648 22.1184 4.83328 28.54912 1.6384l128.90112-74.58816c11.0592-6.4512 14.7456-20.48 8.2944-31.5392-6.22592-11.0592-20.48-14.7456-31.31392-8.51968l-89.088 51.79392v-0.22528l-9.19552 5.05856zm-45.11744-397.7216v396.5952L85.97504 686.14144v-384.4096l351.0272 199.35232zm22.56896-39.1168L111.28832 264.43776 459.5712 90.43968l348.2624 174.01856-348.2624 197.48864zM771.8912 865.77152l181.61664-109.09696a17.69472 17.69472 0 0 0 8.27392-14.9504V541.696c0-7.02464-5.28384-11.96032-11.03872-14.72512l-4.608-2.29376c-0.45056-0.22528-1.14688-0.22528-1.59744-0.22528h1.37216l-176.5376-88.1664a18.08384 18.08384 0 0 0-15.42144 0l-176.3328 88.1664a23.9616 23.9616 0 0 0-16.09728 22.20032v195.072c0 6.22592 3.21536 11.73504 8.51968 14.9504 0 0 179.95776 107.99104 180.87936 108.21632 0 0.02048 10.73152 7.9872 20.97152 0.90112zm-27.38176-44.19584l-148.48-89.53856V571.1872l148.48 84.00896v166.42048zm17.26464-196.096l-144.7936-82.18624L761.77408 471.04l144.54784 72.2944-144.54784 82.16576zm165.4784 106.55744l-148.21376 89.2928v-166.17472l148.23424-84.00896v160.89088z";
		/** One theme-adaptive inline icon: currentColor fill, sized to the line so it
		* never expands the row height, vertically centered. */
		function icon(pathData, size = 14) {
			return (0, react.createElement)("svg", {
				viewBox: "0 0 1024 1024",
				width: size,
				height: size,
				fill: "currentColor",
				style: {
					display: "inline-block",
					verticalAlign: "middle",
					flex: "none"
				},
				dangerouslySetInnerHTML: { __html: `<path d="${pathData}"/>` }
			});
		}
		//#endregion
		//#region src/client/locales.ts
		const en = {
			nav: "Docwright params",
			title: "Docwright parameters",
			marketTitle: "Docwright pack market",
			openExternal: "Open in new window ↗",
			zipBtn: "Download",
			bridgeInstalling: "Installing…",
			intro: "Maintains the parameter values defined in the plugin and the packs. Parameters obtained during the conversation, from materials or user input, are not managed here.",
			viewGroups: "Parameters",
			viewPacks: "Packs",
			viewConfig: "Plugin settings",
			loading: "Loading parameters…",
			loadFailed: "Could not load the parameters.",
			retry: "Retry",
			empty: "No parameters with declared defaults.",
			sources: "effective source",
			scopeWorkspace: "workspace",
			scopeTopic: "topic",
			originBuiltin: "built-in",
			originPacksDir: "packsDir: {root}",
			consumed: "Depends on:",
			missingDep: " (missing)",
			driftPolicy: "param drift",
			min: "min",
			max: "max",
			choices: "choices",
			extractable: "extractable from materials",
			overridable: "adjustable by materials",
			edit: "Edit",
			cancel: "Cancel",
			save: "Save",
			saving: "Saving…",
			saved: "Saved. Future generations use the new value; existing artifacts are unchanged.",
			saveConfig: "Save settings",
			configHint: "Changes apply immediately and survive restarts. provider and model only affect future generations.",
			inherited: "default",
			configured: "configured",
			unset: "not set",
			invalidJson: "Not valid JSON.",
			rangeTemplate: "Must be between {min} and {max}.",
			invalidNumber: "Not a valid number.",
			advanced: "Advanced",
			bandValue: "target {value}, tolerance band {min}-{max}",
			factorValue: "target {value}, tolerance x{down}-x{up}",
			shadowedNote: "Also declared in {packs}. The source declaration governs; details in the Packs view.",
			shadowedByNote: "managed by {pack}, not effective here",
			shadowedCopiesPill: "{count} shadowed",
			shadowedCopiesTitle: "Same-name copies from other roots that this copy shadows (the live one is the card above):",
			shadowedCopyVersion: "v{version}",
			updateCheckFailed: "Could not reach the pack market; showing local state only.",
			upToDate: "up to date",
			updateTo: "update to v{version}",
			notOnMarket: "not on the market",
			updateBtn: "Update",
			checkForUpdates: "Check updates",
			checking: "Checking…",
			paramsToggle: "Params",
			confirmUpdate: "Confirm update (overwrites local changes)",
			disableBtn: "Disable",
			enableBtn: "Enable",
			confirmDisable: "Confirm disable",
			confirmEnable: "Confirm enable",
			confirmDisableBreaks: "Disabling breaks the chains of: {packs}. Confirm to disable anyway",
			disabledPill: "disabled",
			disableDone: "Disabled.",
			enableDone: "Enabled.",
			deleteBtn: "Delete",
			confirmDelete: "Confirm delete",
			confirmDeleteBreaks: "Confirm delete ({packs} consume it — their chains break)",
			updatedDone: "Updated to v{version}.",
			deletedDone: "Deleted.",
			suitesSection: "Suites",
			packsSection: "Standalone packs",
			suitesEmpty: "No suites installed (the market lists none, or it does not support suites). Single-pack installs are unaffected.",
			suitesUnreachable: "Could not reach the pack market; suite status is unavailable.",
			suiteManagedTip: "Suite-managed — install, update, and delete go through the suite",
			suiteIncomplete: "incomplete",
			suiteMemberMissing: "missing",
			suiteUpdateBtn: "Update suite",
			suiteUpdateDone: "Updated: {packs}.",
			colMembers: "Members",
			suiteDeleteSummary: "Delete members: {packs}",
			suiteDeleteConfirm: "Confirm delete suite",
			suiteExternalRef: "consumed outside the suite",
			suiteExternalMembers: "Members consumed by packs outside the suite: {list}. Deleting breaks their chains.",
			suiteForce: "Force delete (the whole suite goes, outside consumers break)",
			suiteDeletedDone: "Deleted: {packs}.",
			suiteFillHint: "Members are missing. Ask the session: doc_market_install { \"suite\": \"<name>\" } installs the rest.",
			confirmForceUpdate: "Update anyway",
			"err.gateRejected": "The request was rejected by the host (HTTP {status}): not logged in, or the origin check failed. Refresh the page and sign in again.",
			"err.crossSiteWrite": "Write refused: the request origin does not match the deployment host (cross-site request). Operate from the dsh web UI.",
			"err.bodyTooLarge": "The request body exceeds the {max}-byte limit; nothing was written. Reduce the request size.",
			"err.invalidJsonBody": "The request body is not valid JSON; nothing was written.",
			"err.invalidPatchBody": "Malformed request: expected {\"patch\": {...}} (an object of Config keys); nothing was written.",
			"err.invalidParamBody": "Malformed request: non-empty pack and param names are required; nothing was written.",
			"err.valueRequired": "Missing value (the new default). The UI edits defaults; it does not remove them.",
			"err.noProfileEntry": "The host config editor lists no profile entry for docwright; the save was refused. Configure docwright via cordis.yml or the profile patch.",
			"err.unknownPack": "Unknown pack \"{pack}\". Available: {available}. Nothing was written.",
			"err.paramNotEditable": "Pack \"{pack}\" param {param} declares no default, and the UI maintains declared defaults only. Structural changes are a pack-author manifest edit with a version bump. Nothing was written.",
			"err.manifestCorrupt": "The pack \"{pack}\" manifest.json is not valid JSON; nothing was written. Fix the file first.",
			"err.paramVanished": "params.{param} no longer exists in the manifest (the file may have been edited concurrently); nothing was written. Refresh and retry.",
			"err.manifestInvalid": "The edited manifest failed the load-time validation; nothing was written. See the detail below.",
			"err.reloadFailed": "The manifest was written, but reloading the packs failed. Fix or revert {path}; until the reload succeeds the running tools keep the previous configuration.",
			"err.patternParamInvalid": "The new value for {param} is not a valid regex (it drives a validation rule); nothing was written. Fix the expression, or set the empty string to disable the check.",
			"err.packNotManaged": "Pack \"{pack}\" is not managed here: builtin packs ship with the plugin package, managed packs live under the packsDir. Nothing was written.",
			"err.marketUnreachable": "Could not reach the pack market; nothing was written. Retry later, or point marketUrl in cordis.yml at a reachable market.",
			"err.integrityFailed": "Integrity check failed for \"{pack}\" ({why}); nothing was written. Never force-install when the market index and the download disagree.",
			"err.updateFailed": "Pack \"{pack}\" update failed; the installed version is unchanged.",
			"err.absentFromMarket": "Pack \"{pack}\" is not listed on the market at {url}, so there is nothing to update from; nothing was written. Publish it there first, or install it into the packsDir directly.",
			"err.packInUse": "Pack \"{pack}\" is consumed by installed packs ({consumers}); deleting it breaks their chains. Confirm the delete again to proceed anyway, or keep it.",
			"err.suiteLaneMissing": "The suite lane is not wired on this deployment; nothing was written.",
			"err.originMismatch": "Pack \"{pack}\" now resolves from a different root than the card showed — the views were reloaded in between. Refresh and retry; nothing was written.",
			"err.marketNameClash": "The market index lists pack \"{pack}\" more than once; the target would be ambiguous. Nothing was written — report this to the market operator.",
			"err.compatBreak": "Updating \"{pack}\" may break consumers below the compat floor: {consumers}. Upgrade those consumers to their latest versions first, then update; or confirm again to update anyway.",
			"err.suiteConsumed": "Suite \"{pack}\" has members consumed by packs outside the suite ({consumers}); deleting it breaks their chains. Tick the force box to delete the whole suite anyway, or keep it."
		};
		const zh = {
			nav: "Docwright 参数",
			title: "Docwright 参数",
			marketTitle: "Docwright pack 市场",
			openExternal: "在新窗口打开 ↗",
			zipBtn: "下载",
			bridgeInstalling: "正在安装…",
			intro: "此处维护插件和包中定义的参数值，不包括那些在会话中从素材或用户输入中获得的参数。",
			viewGroups: "参数",
			viewPacks: "包",
			viewConfig: "插件设置",
			loading: "正在载入参数…",
			loadFailed: "参数载入失败。",
			retry: "重试",
			empty: "没有声明默认值的参数。",
			sources: "生效源",
			scopeWorkspace: "工作区级",
			scopeTopic: "话题级",
			originBuiltin: "内置",
			originPacksDir: "自定义目录：{root}",
			consumed: "依赖项：",
			missingDep: "（缺失）",
			driftPolicy: "参数漂移",
			min: "下限",
			max: "上限",
			choices: "可选项",
			extractable: "可从素材抽取",
			overridable: "可被素材调整",
			edit: "编辑",
			cancel: "取消",
			save: "保存",
			saving: "保存中…",
			saved: "已保存。之后的生成使用新值，已有产物不变。",
			saveConfig: "保存设置",
			configHint: "改动即时生效，重启后仍保留。provider 和 model 只影响之后的生成，不影响已有产物。",
			inherited: "默认",
			configured: "已配置",
			unset: "未设置",
			invalidJson: "不是合法 JSON。",
			rangeTemplate: "必须在 {min} 到 {max} 之间。",
			invalidNumber: "不是合法数字。",
			advanced: "高级",
			bandValue: "目标 {value}（容差带 {min}–{max}）",
			factorValue: "目标 {value}（容差 ×{down}–×{up}）",
			shadowedNote: "同名参数还声明于：{packs}（以生效源为准，详见包视图）。",
			shadowedByNote: "由 {pack} 管理，此处声明不生效",
			shadowedCopiesPill: "遮蔽 {count} 份同名",
			shadowedCopiesTitle: "来自其他根目录、被本卡遮蔽的同名副本（生效的是上面这张卡）：",
			shadowedCopyVersion: "v{version}",
			updateCheckFailed: "无法连接 pack 市场，仅显示本地状态。",
			upToDate: "已是最新",
			updateTo: "可更新到 v{version}",
			notOnMarket: "市场未收录",
			updateBtn: "更新",
			checkForUpdates: "检查更新",
			checking: "检查中…",
			paramsToggle: "参数",
			confirmUpdate: "确认更新（将覆盖本地改动）",
			disableBtn: "禁用",
			enableBtn: "启用",
			confirmDisable: "确认禁用",
			confirmEnable: "确认启用",
			confirmDisableBreaks: "禁用会打断这些包的链路：{packs}。确认仍要禁用",
			disabledPill: "已禁用",
			disableDone: "已禁用。",
			enableDone: "已启用。",
			deleteBtn: "删除",
			confirmDelete: "确认删除",
			confirmDeleteBreaks: "确认删除（{packs} 消费它，删除将断链）",
			updatedDone: "已更新到 v{version}。",
			deletedDone: "已删除。",
			suitesSection: "套件",
			packsSection: "独立包",
			suitesEmpty: "没有已安装的套件（市场没有套件，或该市场不支持套件）。单个 pack 的安装不受影响。",
			suitesUnreachable: "无法连接 pack 市场，套件状态不可用。",
			suiteManagedTip: "由套件管理：安装、更新、删除都走套件",
			suiteIncomplete: "不完整",
			suiteMemberMissing: "缺失",
			suiteUpdateBtn: "更新套件",
			suiteUpdateDone: "已更新：{packs}。",
			colMembers: "成员",
			suiteDeleteSummary: "删除成员：{packs}",
			suiteDeleteConfirm: "确认删除套件",
			suiteExternalRef: "被套件外引用",
			suiteExternalMembers: "以下成员被套件外的 pack 消费：{list}。删除会影响它们。",
			suiteForce: "强制删除（整个套件删除，外部引用断链）",
			suiteDeletedDone: "已删除：{packs}。",
			suiteFillHint: "成员未装齐。请在会话中执行 doc_market_install { \"suite\": \"<名称>\" } 补齐。",
			confirmForceUpdate: "仍要更新",
			"err.gateRejected": "请求被宿主拒绝（HTTP {status}）：未登录或来源校验未通过。刷新页面重新登录后再试。",
			"err.crossSiteWrite": "写入被拒绝：请求来源与部署主机不一致（跨站请求）。请从 dsh web 界面发起操作。",
			"err.bodyTooLarge": "请求体超过 {max} 字节上限，未写入任何内容。请缩小请求内容。",
			"err.invalidJsonBody": "请求体不是合法 JSON，未写入任何内容。",
			"err.invalidPatchBody": "请求格式错误：应为 {\"patch\": {...}}（Config 键的对象），未写入任何内容。",
			"err.invalidParamBody": "请求格式错误：需要非空的 pack 与 param 名称，未写入任何内容。",
			"err.valueRequired": "缺少 value（新的默认值）。界面只支持修改默认值，不支持删除。",
			"err.noProfileEntry": "宿主配置编辑器没有列出 docwright 的 profile entry，无法保存。请通过 cordis.yml 或 profile patch 配置 docwright。",
			"err.unknownPack": "找不到 pack「{pack}」。可用：{available}。未写入任何内容。",
			"err.paramNotEditable": "pack「{pack}」的参数 {param} 没有声明默认值，界面只维护已声明的默认值。结构性改动请由 pack 作者编辑 manifest 并升版。未写入任何内容。",
			"err.manifestCorrupt": "pack「{pack}」的 manifest.json 不是合法 JSON，未写入任何内容。请先修复该文件。",
			"err.paramVanished": "manifest 中已不存在参数 {param}（文件可能被同时编辑过），未写入任何内容。请刷新后重试。",
			"err.manifestInvalid": "修改后的 manifest 未通过装载期校验，未写入任何内容。请按下方详情修正。",
			"err.reloadFailed": "manifest 已写入，但重新装载 pack 失败。请修复或还原 {path}；装载成功之前，运行中的工具仍使用旧配置。",
			"err.patternParamInvalid": "参数 {param} 的新值不是合法正则表达式（它驱动一条校验规则），未写入任何内容。请修正表达式，或置空字符串以停用该检查。",
			"err.packNotManaged": "pack「{pack}」不在此处管理范围：内置 pack 随插件发行，可管理的 pack 在 packsDir 目录下。未写入任何内容。",
			"err.marketUnreachable": "无法连接 pack 市场，未做任何改动。可稍后重试，或在 cordis.yml 用 marketUrl 指向可达的市场。",
			"err.integrityFailed": "「{pack}」完整性校验失败（{why}），未写入任何内容。市场索引与下载内容不一致时请勿强行安装。",
			"err.updateFailed": "pack「{pack}」更新失败，已装版本未变。",
			"err.absentFromMarket": "pack「{pack}」不在市场 {url} 的收录中，没有可更新的来源，未写入任何内容。先在市场投稿该 pack，或直接把 pack 放进 packsDir。",
			"err.packInUse": "pack「{pack}」正被已安装的 {consumers} 消费，删除会让它们断链。再次确认删除可强制执行，或保留该 pack。",
			"err.suiteLaneMissing": "该部署未接入套件通道，未做任何改动。",
			"err.originMismatch": "pack「{pack}」当前生效的来源和卡片显示的不一致（期间列表被刷新过）。请刷新后重试；未写入任何内容。",
			"err.marketNameClash": "市场索引中 pack「{pack}」出现了多次，安装目标不明确。未写入任何内容，请联系市场管理员处理。",
			"err.compatBreak": "更新「{pack}」可能影响低于兼容下限的消费方：{consumers}。建议先把它们升级到最新版本再更新；再次确认可强制更新。",
			"err.suiteConsumed": "套件「{pack}」有成员被套件外的 pack 消费（{consumers}），删除会影响它们。勾选强制删除才会删除整个套件，否则不删除。"
		};
		function translate(dict) {
			return (key) => {
				const value = dict[key];
				return typeof value === "string" ? value : key;
			};
		}
		/** Fill a {key}-templated locale string. */
		function fill(template, vars) {
			return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
		}
		/** A save/load failure as the UI renders it: the localized catalog entry for
		* known codes, the raw server sentence otherwise, plus the raw detail line. */
		function renderError(error, lang) {
			const dict = lang === "zh" ? zh : en;
			const template = error.code === void 0 ? void 0 : dict[`err.${error.code}`];
			return {
				text: typeof template === "string" ? fill(template, { ...error.params ?? {} }) : error.message,
				...error.detail === void 0 ? {} : { detail: error.detail }
			};
		}
		//#endregion
		//#region src/client/ParamsSection.tsx
		/**
		* The Docwright params section: three views over one catalog fetch — the
		* installed list (suite cards with their read-only member rows first, then
		* standalone packs — docs/designs/pack-suites.md), shared-param groups (the
		* aggregation with effective-source resolution), and the plugin Config
		* form. Controls map from the
		* ParamSpec type (number → numeric input, enum → select, boolean → switch,
		* object → JSON-per-value with endpoints read-only); every parameter shows
		* its author's description inline beneath the name, resolved to the active
		* locale by the host's `locale.resolveText` (LocalizedText from the RPC,
		* en-fallback semantics of src/description.ts). Writes go through the
		* plugin's own routes (src/http.ts), never the conversation; their error
		* envelopes render through the locale catalog (locales.ts renderError). Any
		* change in ANY view re-fetches the whole block, so the suite cards and the
		* standalone pack list can never disagree.
		*
		* Styling: Tailwind utilities compiled from styles.css (injected once as
		* client/client.css — see index.tsx). Accent colors come from the pack
		* market's palette (@theme there); neutral surfaces, text and borders stay
		* on the host's --dsw-alias-* tokens via arbitrary values, so light/dark
		* follows the shell. Typography follows the host conversation body, not
		* ad-hoc sizes: one family and size for all running text (the .dw-root
		* component class); hierarchy comes from weight and the host's label grays,
		* never from font size. Only identifiers and values (param names, enum
		* members, JSON) sit in the host code face (.dw-code).
		*/
		const NS$1 = "docwright-params";
		/** The host's first muted gray (real theme token). */
		const muted = "text-[var(--dsw-alias-label-secondary,inherit)]";
		const smallMuted = `${muted} text-[0.82rem]`;
		/** Host state red (the market's danger is the same #dc2626 family). */
		const errorText = "text-[var(--dsw-alias-state-error-primary,#dc2626)]";
		/** Host code face, via the styles.css component class. */
		const code = "dw-code";
		/** Host code face + semibold: names and identifiers. */
		const name$1 = `${code} font-semibold`;
		const row = "flex items-center gap-2 py-1.5";
		const rowHead = "flex flex-wrap items-baseline gap-2 min-w-0";
		const desc = `${muted} whitespace-pre-wrap break-words`;
		/** The shared card shell: hairline border, host radius, second-layer fill. */
		const card = "border-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] rounded-[var(--dsw-radius-xl,20px)] bg-[var(--dsw-alias-bg-layer-2,transparent)] px-4 py-3 mb-3 overflow-hidden";
		/** The pack card's full-width header band: a quiet wash in the market's
		* primary blue that separates "which pack am I looking at" from the rows. */
		const packHead = `${rowHead} -mx-4 -my-3 mb-2.5 px-4 py-2.5 bg-[color-mix(in_srgb,var(--color-primary)_7%,transparent)]`;
		const suiteHead = `${rowHead} -mx-4 -my-3 mb-2.5 px-4 py-2.5 bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)]`;
		const actions = "flex items-center gap-2 mt-2";
		const chipOk = `${code} text-[var(--dsw-alias-link,#155dfc)] cursor-pointer hover:underline`;
		const chipMissing = errorText;
		const chip = "inline-flex rounded-full px-2 py-px text-[0.82rem] whitespace-nowrap border";
		const memberChip = `${chip} cursor-pointer bg-[color-mix(in_srgb,var(--dsw-alias-link,#155dfc)_10%,transparent)] border-[color-mix(in_srgb,var(--dsw-alias-link,#155dfc)_35%,transparent)] text-[var(--dsw-alias-link,#155dfc)] hover:bg-[color-mix(in_srgb,var(--dsw-alias-link,#155dfc)_18%,transparent)]`;
		const memberChipExternal = `${chip} cursor-pointer bg-[rgba(212,140,34,0.12)] border-[rgba(212,140,34,0.55)]`;
		const memberChipMissing = `${chip} bg-[rgba(197,48,48,0.10)] border-[rgba(197,48,48,0.38)] ${errorText}`;
		/** Anchor ids of the pack and suite cards (jump targets for the chips). The
		* pack anchor carries the ORIGIN ROOT: two same-code packs from different
		* roots (cross-root shadowing) must never collide on one id — the code alone
		* is not the full identity (org/name on the market, root/name locally). */
		const packAnchorId = (origin, name) => `docwright-pack-${name}-${origin.root}`;
		const suiteAnchorId = (name) => `docwright-suite-${name}`;
		/** The author's description, inline beneath the parameter name — the primary
		* explanation stays in view instead of hiding behind a hover. Locale
		* resolution: the host's resolveText when available, its semantics locally
		* otherwise (src/description.ts). */
		function DescriptionLine(props) {
			return (0, react.createElement)("div", { className: `${NS$1}-desc ${desc} mt-0.5` }, props.resolveText(props.text ?? ""));
		}
		/** One failing write/load as text + optional raw detail line. */
		function ErrorLine(props) {
			const rendered = renderError(props.error, props.lang);
			return (0, react.createElement)("span", { className: `${errorText} whitespace-pre-wrap` }, rendered.text, rendered.detail !== void 0 ? (0, react.createElement)("span", { className: `${muted} whitespace-pre-wrap` }, `\n${rendered.detail}`) : null);
		}
		/**
		* Human projection of a declared default: value-band objects read as
		* "target 60 (band 30-90)" instead of raw JSON; anything else that is not a
		* plain scalar falls back to JSON.
		*/
		function displayDefault(d, t) {
			if (typeof d.default !== "object" || d.default === null) return String(d.default);
			const o = d.default;
			if (typeof o.value === "number" && typeof o.min === "number" && typeof o.max === "number") return fill(t("bandValue"), {
				value: o.value,
				min: o.min,
				max: o.max
			});
			if (typeof o.value === "number" && typeof o.downFactor === "number" && typeof o.upFactor === "number") return fill(t("factorValue"), {
				value: o.value,
				down: o.downFactor,
				up: o.upFactor
			});
			return JSON.stringify(d.default);
		}
		/** Value-semantics flags, rendered as quiet pills. The confirm gate flag is
		* deliberately absent: it says nothing about maintaining the default (and is
		* not editable here), so it only confused readers. */
		function FlagPills(props) {
			const { d, t } = props;
			const flags = [];
			if (d.extractable) flags.push(t("extractable"));
			if (d.overridable) flags.push(t("overridable"));
			return flags.length === 0 ? null : (0, react.createElement)("div", { className: "flex gap-1 flex-wrap" }, flags.map((f) => (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, { key: f }, f)));
		}
		/** Constraint summary under the value: declared range and choices. Object
		* bands carry no note — the human projection ("target 60, band 30-90")
		* already says what value and endpoints mean, uniformly for every band. */
		function ConstraintLine(props) {
			const { d, t } = props;
			const bits = [];
			if (d.enumValues !== void 0) bits.push(`${t("choices")}: ${d.enumValues.join(" / ")}`);
			if (d.min !== void 0) bits.push(`${t("min")} ${d.min}`);
			if (d.max !== void 0) bits.push(`${t("max")} ${d.max}`);
			return bits.length === 0 ? null : (0, react.createElement)("div", { className: muted }, bits.join(" · "));
		}
		/** Validate one proposed default against the declaration (client-side mirror of the server gate). */
		function validateDraft(d, text) {
			if (d.type === "object") try {
				const parsed = JSON.parse(text);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "invalidJson";
				return;
			} catch {
				return "invalidJson";
			}
			if (d.enumValues !== void 0) return void 0;
			if (d.type === "number") {
				const n = Number(text);
				if (text.trim() === "" || !Number.isFinite(n)) return "invalidNumber";
				if (d.min !== void 0 && n < d.min || d.max !== void 0 && n > d.max) return "outOfRange";
				return;
			}
		}
		/**
		* One declaration's value line, editability decided by ROLE (not by view):
		* a source declaration is editable whereever it is shown (the parameter
		* view's governing row and the owning pack's row in the Packs view write
		* the same manifest field); a shadowed declaration renders its value
		* struck-through and muted — it NEVER takes effect on the chain (the
		* receipt base outranks it) — with an explicit note naming the manager.
		*/
		function ValueRow(props) {
			const { d, t } = props;
			if (d.role === "shadowed") return (0, react.createElement)("div", { className: rowHead }, (0, react.createElement)("span", { className: `${code} ${muted} line-through` }, displayDefault(d, t)), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, {}, fill(t("shadowedByNote"), { pack: d.shadowedBy ?? "" })));
			return (0, react.createElement)(EditSeat, {
				d,
				t,
				lang: props.lang,
				onSaved: props.onSaved,
				origin: props.origin
			});
		}
		/** The staged-edit control for a source declaration. `origin` (when known)
		* echoes the card's rendered pack origin so the server can refuse a write
		* whose target moved underneath the card (seen-vs-written guard). */
		function EditSeat(props) {
			const { d, t } = props;
			const [editing, setEditing] = (0, react.useState)(false);
			const [draft, setDraft] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const start = () => {
				setDraft(d.type === "object" ? JSON.stringify(d.default, null, 2) : String(d.default));
				setError(void 0);
				setEditing(true);
			};
			const save = async () => {
				const problem = validateDraft(d, draft);
				if (problem !== void 0) {
					setError(new Error(problem === "outOfRange" ? fill(t("rangeTemplate"), {
						min: String(d.min ?? ""),
						max: String(d.max ?? "")
					}) : t(problem)));
					return;
				}
				setBusy(true);
				setError(void 0);
				try {
					const value = d.type === "object" ? JSON.parse(draft) : d.type === "number" ? Number(draft) : draft;
					await savePackParam(d.pack, d.name, value, props.origin);
					setEditing(false);
					props.onSaved?.();
				} catch (saveError) {
					setError(saveError);
				} finally {
					setBusy(false);
				}
			};
			const valueLine = (0, react.createElement)("div", { className: rowHead }, (0, react.createElement)("span", { className: code }, displayDefault(d, t)), editing ? null : (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				onClick: start
			}, t("edit")));
			if (!editing) return valueLine;
			return (0, react.createElement)("div", null, d.enumValues !== void 0 ? (0, react.createElement)("select", {
				value: String(d.default),
				onChange: (e) => setDraft(e.target.value),
				className: "w-40"
			}, d.enumValues.map((v) => (0, react.createElement)("option", {
				key: String(v),
				value: String(v)
			}, String(v)))) : d.type === "object" ? (0, react.createElement)("textarea", {
				value: draft,
				onChange: (e) => setDraft(e.target.value),
				rows: 4,
				className: `w-full max-w-[480px] ${code}`
			}) : (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Input, {
				value: draft,
				type: d.type === "number" ? "number" : "text",
				step: "any",
				onChange: (e) => setDraft(e.target.value),
				style: { width: "160px" }
			}), (0, react.createElement)("div", { className: actions }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				disabled: busy,
				onClick: () => void save()
			}, busy ? t("saving") : t("save")), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				disabled: busy,
				onClick: () => setEditing(false)
			}, t("cancel")), error !== void 0 ? (0, react.createElement)(ErrorLine, {
				error,
				lang: props.lang
			}) : null));
		}
		/**
		* One aggregated parameter group = ONE card, top to bottom: name + flags,
		* the author's description in the muted gray, the effective source on its
		* own line (what governs is a fact of its own — not a prefix of the value
		* row), the effective value and its edit seat on the next, then declared
		* constraints. The shadowed declarations collapse into a single sentence —
		* their values never take effect (the receipt base outranks them), so
		* rendering them per-card repeated the same text N times and showed
		* misleading never-applied numbers.
		*/
		function ParamGroupCard(props) {
			const { name, declarations, t } = props;
			const governing = declarations.find((d) => d.role === "source") ?? declarations[0];
			const shadowed = declarations.filter((d) => d !== governing);
			const originOf = (pack) => props.rootOf(pack)?.origin;
			return (0, react.createElement)("div", { className: card }, (0, react.createElement)("div", { className: rowHead }, (0, react.createElement)("span", { className: name }, name), (0, react.createElement)(FlagPills, {
				d: governing,
				t
			})), (0, react.createElement)(DescriptionLine, {
				text: governing.description,
				resolveText: props.resolveText
			}), (0, react.createElement)("div", { className: "flex items-center gap-2 mt-1" }, (0, react.createElement)("span", { className: muted }, `${t("sources")}:`), declarations.filter((d) => d.role === "source").map((d) => {
				const origin = originOf(d.pack);
				return (0, react.createElement)("span", {
					key: d.pack,
					title: origin === void 0 ? d.pack : `${d.pack} · ${origin.kind} ${origin.root}`,
					onClick: origin !== void 0 ? () => props.onJump("packs", packAnchorId(origin, d.pack)) : void 0,
					className: origin !== void 0 ? `${chipOk} cursor-pointer` : chipOk
				}, d.pack);
			})), (0, react.createElement)(ValueRow, {
				d: governing,
				t,
				lang: props.lang,
				onSaved: props.onSaved,
				origin: originOf(governing.pack)
			}), (0, react.createElement)("div", { className: "mt-0.5" }, (0, react.createElement)(ConstraintLine, {
				d: governing,
				t
			})), shadowed.length > 0 ? (0, react.createElement)("div", { className: `${muted} mt-1` }, fill(t("shadowedNote"), { packs: shadowed.map((d) => d.pack).join(", ") })) : null);
		}
		/** Aggregated parameter view: one card per parameter name. */
		function GroupsView(props) {
			const { payload, t } = props;
			const rootOf = (0, react.useCallback)((pack) => payload.packs.find((p) => p.name === pack), [payload.packs]);
			if (payload.groups.length === 0) return (0, react.createElement)("p", { className: muted }, t("empty"));
			return (0, react.createElement)("div", null, payload.groups.map((g) => (0, react.createElement)(ParamGroupCard, {
				key: g.name,
				name: g.name,
				declarations: g.declarations,
				t,
				lang: props.lang,
				resolveText: props.resolveText,
				onSaved: props.onSaved,
				rootOf,
				onJump: props.onJump
			})));
		}
		/** One declaration row inside a pack's card. Source rows carry the edit seat; shadowed rows strike their never-applied value through. */
		function PackDeclRow(props) {
			const { d, t } = props;
			return (0, react.createElement)("div", { className: `${NS$1}-row ${row}` }, (0, react.createElement)("div", { className: "flex flex-col flex-1 min-w-0" }, (0, react.createElement)("div", { className: rowHead }, (0, react.createElement)("span", { className: name$1 }, d.name), (0, react.createElement)(FlagPills, {
				d,
				t
			})), (0, react.createElement)(DescriptionLine, {
				text: d.description,
				resolveText: props.resolveText
			}), (0, react.createElement)(ValueRow, {
				d,
				t,
				lang: props.lang,
				onSaved: props.onSaved,
				origin: props.origin
			}), (0, react.createElement)("div", { className: "mt-0.5" }, (0, react.createElement)(ConstraintLine, {
				d,
				t
			}))));
		}
		/** Which installed suites a pack belongs to, keyed by pack name (derived
		* once per suites fetch; a pure display marker on the pack card). */
		/** Trigger a same-origin ZIP download (the packaging route answers the raw
		* bytes; an <a download> anchor would work too, but a Button keeps the card
		* actions uniform). */
		function downloadZipFile(url, filename) {
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = filename;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
		}
		function suitesByPack(rows) {
			const map = /* @__PURE__ */ new Map();
			for (const suite of rows) for (const member of suite.members) {
				const list = map.get(member.name);
				if (list === void 0) map.set(member.name, [suite.name]);
				else if (!list.includes(suite.name)) list.push(suite.name);
			}
			return map;
		}
		/** Per-suite external consumers: for each member, the installed packs that
		* consume it and are NOT suite members themselves (the delete-time impact
		* list; a member with entries renders the external-reference mark). */
		function externalConsumersOf(suite, packs) {
			const members = new Set(suite.members.map((m) => m.name));
			const map = /* @__PURE__ */ new Map();
			for (const member of suite.members) {
				const consumers = packs.filter((p) => p.name !== member.name && !members.has(p.name) && p.consumes.includes(member.name)).map((p) => p.name);
				if (consumers.length > 0) map.set(member.name, consumers);
			}
			return map;
		}
		/** Per-pack flat view (pack-author / troubleshooting perspective). Each card
		* opens with a full-width blue-wash header band — pack identity reads as a
		* section of its own. The card is the overview: identity, description, and
		* actions; the pack's parameter declarations stay folded behind a toggle so
		* the installed-pack list reads at a glance. Market standing is CHECK-ON-DEMAND
		* (检查更新) — never fetched on view mount, and the button only turns into
		* 更新 after a check reports a newer version. */
		function PacksView(props) {
			const { payload, t } = props;
			const [lane, setLane] = (0, react.useState)({
				state: "idle",
				rows: []
			});
			const [laneDone, setLaneDone] = (0, react.useState)(void 0);
			const checkOne = (0, react.useCallback)((name) => {
				setLane((prev) => ({
					state: "checking",
					rows: prev.rows
				}));
				fetchPackUpdates(name).then((rows) => setLane((prev) => ({
					state: "ready",
					rows: [...prev.rows.filter((r) => r.name !== name), ...rows]
				}))).catch(() => setLane((prev) => ({
					state: "unreachable",
					rows: prev.rows
				})));
			}, []);
			const byName = (0, react.useMemo)(() => new Map(lane.rows.map((u) => [u.name, u])), [lane.rows]);
			const installedNames = (0, react.useMemo)(() => new Set(payload.packs.map((p) => p.name)), [payload.packs]);
			const disabledNames = (0, react.useMemo)(() => new Set(payload.disabledPacks ?? []), [payload.disabledPacks]);
			/** Active-card lookup by code (dependency chips and the groups view jump
			* through it; the anchor carries the origin root so same-code copies never
			* collide). */
			const rootOf = (0, react.useCallback)((pack) => payload.packs.find((p) => p.name === pack), [payload.packs]);
			/** Same-name copies that lost the cross-root clash, grouped by code. */
			const shadowedByName = (0, react.useMemo)(() => {
				const map = /* @__PURE__ */ new Map();
				for (const copy of payload.shadowedPacks ?? []) {
					const list = map.get(copy.name);
					if (list === void 0) map.set(copy.name, [copy]);
					else list.push(copy);
				}
				return map;
			}, [payload.shadowedPacks]);
			/** A suite member's FULL pack card, rendered nested inside its suite card
			* (params stay editable there; lane actions stay hidden — the suite owns
			* install/update/delete). */
			const renderMemberCard = (name) => {
				const pack = payload.packs.find((p) => p.name === name);
				if (pack === void 0) return null;
				return (0, react.createElement)(PackCard, {
					key: `${pack.name}-${pack.origin.root}`,
					pack,
					status: byName.get(pack.name),
					checked: byName.has(pack.name),
					laneState: lane.state,
					checkOne,
					t,
					lang: props.lang,
					flat: true,
					resolveText: props.resolveText,
					onJump: props.onJump,
					onSaved: props.onSaved,
					installed: installedNames,
					suites: props.suites.get(pack.name) ?? [],
					consumers: payload.packs.filter((other) => other.name !== pack.name && other.consumes.includes(pack.name)).map((other) => other.name),
					disabled: disabledNames.has(pack.name),
					shadowed: shadowedByName.get(pack.name) ?? [],
					rootOf,
					onDone: (text) => {
						setLaneDone(text);
						props.onSaved();
						checkOne(pack.name);
					}
				});
			};
			const standalone = payload.packs.filter((p) => (props.suites.get(p.name) ?? []).length === 0);
			const suiteRows = props.suitesLane?.state === "ok" ? props.suitesLane.rows : [];
			return (0, react.createElement)("div", null, lane.state === "unreachable" ? (0, react.createElement)("p", { className: muted }, t("updateCheckFailed")) : null, laneDone !== void 0 ? (0, react.createElement)("p", { className: muted }, laneDone) : null, suiteRows.length > 0 ? [(0, react.createElement)("h4", {
				key: "suites-head",
				className: `${muted} m-0 mb-2 font-semibold`
			}, t("suitesSection")), ...suiteRows.map((s) => (0, react.createElement)(SuiteCard, {
				key: `${s.org ?? ""}-${s.name}`,
				suite: s,
				packs: payload.packs,
				t,
				lang: props.lang,
				resolveText: props.resolveText,
				onJump: props.onJump,
				onSaved: props.onSaved,
				renderMember: renderMemberCard
			}))] : props.suitesLane !== void 0 ? (0, react.createElement)("p", {
				key: "suites-empty",
				className: muted
			}, props.suitesLane.state === "unreachable" ? t("suitesUnreachable") : t("suitesEmpty")) : null, standalone.length > 0 && suiteRows.length > 0 ? (0, react.createElement)("h4", {
				key: "packs-head",
				className: `${muted} mt-3 mb-2 font-semibold`
			}, t("packsSection")) : null, standalone.map((p) => (0, react.createElement)(PackCard, {
				key: `${p.name}-${p.origin.root}`,
				pack: p,
				status: byName.get(p.name),
				checked: byName.has(p.name),
				laneState: lane.state,
				checkOne,
				t,
				lang: props.lang,
				resolveText: props.resolveText,
				onJump: props.onJump,
				onSaved: props.onSaved,
				installed: installedNames,
				suites: props.suites.get(p.name) ?? [],
				consumers: payload.packs.filter((other) => other.name !== p.name && other.consumes.includes(p.name)).map((other) => other.name),
				disabled: disabledNames.has(p.name),
				shadowed: shadowedByName.get(p.name) ?? [],
				rootOf,
				onDone: (text) => {
					setLaneDone(text);
					props.onSaved();
					checkOne(p.name);
				}
			})));
		}
		/** One pack card: identity + description + action row on top; the parameter
		* declarations fold behind the 参数 toggle. */
		function PackCard(props) {
			const { pack, t } = props;
			const [paramsOpen, setParamsOpen] = (0, react.useState)(false);
			const [shadowedOpen, setShadowedOpen] = (0, react.useState)(false);
			const qualified = props.status?.org !== void 0 ? `${props.status.org}/${pack.name}@v${pack.version}` : `${pack.name}@v${pack.version}`;
			return (0, react.createElement)("div", {
				id: packAnchorId(pack.origin, pack.name),
				className: props.flat === true ? "mt-0.5" : card
			}, (0, react.createElement)("div", { className: props.flat === true ? rowHead : packHead }, (0, react.createElement)("span", {
				className: name$1,
				title: qualified
			}, pack.name), pack.author !== void 0 ? (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, { title: qualified }, pack.author) : null, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, {}, `v${pack.version}`), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, {}, pack.scope === "workspace" ? t("scopeWorkspace") : t("scopeTopic")), pack.origin.kind === "builtin" ? (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, {}, t("originBuiltin")) : null, pack.paramDriftPolicy !== void 0 ? (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, {}, `${t("driftPolicy")}: ${pack.paramDriftPolicy}`) : null, props.disabled ? (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, {}, t("disabledPill")) : null), (0, react.createElement)("div", { className: `${desc} mb-1` }, props.resolveText(pack.description)), pack.consumes.length > 0 ? (0, react.createElement)("div", { className: `${muted} mt-1 flex gap-1.5 flex-wrap items-center` }, (0, react.createElement)("span", {
				title: t("consumed"),
				className: "inline-flex items-center"
			}, icon(DEPENDS_ICON_PATH)), pack.consumes.map((dep) => {
				const depPack = props.rootOf(dep);
				const installed = depPack !== void 0;
				const origin = depPack?.origin;
				return (0, react.createElement)("span", {
					key: dep,
					title: installed ? origin !== void 0 ? `${dep} · ${origin.kind} ${origin.root}` : dep : `${dep}${t("missingDep")}`,
					onClick: installed && origin !== void 0 ? () => props.onJump("packs", packAnchorId(origin, dep)) : void 0,
					className: installed ? chipOk : chipMissing
				}, dep);
			})) : null, (0, react.createElement)("div", { className: "mt-1 flex gap-2 items-center flex-wrap" }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				onClick: () => setParamsOpen((v) => !v)
			}, `${paramsOpen ? "▾" : "▸"} ${t("paramsToggle")}`), pack.origin.kind === "packsDir" && props.suites.length === 0 ? (0, react.createElement)(PackLaneActions, {
				pack,
				status: props.status,
				checked: props.checked,
				laneState: props.laneState,
				check: props.checkOne,
				t,
				lang: props.lang,
				consumers: props.consumers,
				disabled: props.disabled,
				onDone: props.onDone
			}) : null), paramsOpen ? (0, react.createElement)("div", { className: "mt-1.5 border-t-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] pt-1.5" }, pack.params.length === 0 ? (0, react.createElement)("p", { className: muted }, t("empty")) : pack.params.map((d) => (0, react.createElement)(PackDeclRow, {
				key: d.name,
				d,
				t,
				lang: props.lang,
				resolveText: props.resolveText,
				onSaved: props.onSaved,
				origin: pack.origin
			}))) : null, props.shadowed.length > 0 ? (0, react.createElement)("div", { className: "mt-1.5 border-t-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] pt-1.5" }, (0, react.createElement)("div", { className: rowHead }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, { title: t("shadowedCopiesTitle") }, fill(t("shadowedCopiesPill"), { count: props.shadowed.length })), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				onClick: () => setShadowedOpen((v) => !v)
			}, `${shadowedOpen ? "▾" : "▸"} ${t("shadowedCopiesTitle")}`)), shadowedOpen ? props.shadowed.map((copy, i) => (0, react.createElement)("div", {
				key: `${copy.dir}-${i}`,
				className: `${smallMuted} mt-0.5`,
				title: copy.dir
			}, `${copy.origin.kind} · ${copy.origin.root} · v${copy.version}`)) : null) : null);
		}
		/** One managed pack's lane actions: check-on-demand market standing plus
		* two-step update/delete. 检查更新 is always visible and re-checkable; only a
		* check that reports a newer version turns it into the two-step 更新. Both
		* actions overwrite or remove a packsDir directory, so a click is always the
		* second one — arming resets on completion and on any refresh; the update
		* confirm names the overwrite explicitly, the delete confirm names installed
		* consumers. A server failure renders through the locale catalog
		* (what/why/what-to-do) under the buttons. */
		function PackLaneActions(props) {
			const { t } = props;
			const [armed, setArmed] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const run = (kind, updateForce = false) => {
				setBusy(true);
				setError(void 0);
				const call = kind === "update" ? updateManagedPack(props.pack.name, updateForce) : kind === "delete" ? deleteManagedPack(props.pack.name, props.consumers.length > 0) : setPackDisabled(props.pack.name, kind === "disable", props.consumers.length > 0 && kind === "disable");
				const doneText = kind === "update" ? void 0 : kind === "disable" ? t("disableDone") : kind === "enable" ? t("enableDone") : t("deletedDone");
				call.then((result) => props.onDone(kind === "update" ? fill(t("updatedDone"), { version: typeof result === "string" ? result : "" }) : doneText ?? ""), (cause) => setError(cause instanceof Error ? cause : new Error(String(cause)))).finally(() => {
					setBusy(false);
					setArmed(void 0);
				});
			};
			const standing = props.checked && props.laneState === "ready" ? props.status === void 0 || !props.status.onMarket ? t("notOnMarket") : props.status.updateAvailable ? fill(t("updateTo"), { version: props.status.marketVersion ?? "" }) : t("upToDate") : null;
			const updateAvailable = props.checked && props.laneState === "ready" && props.status !== void 0 && props.status.onMarket && props.status.updateAvailable;
			const compatBlocked = error?.code === "compatBreak";
			const checkLabel = props.checked && props.laneState === "checking" ? t("checking") : updateAvailable ? armed === "update" ? compatBlocked ? t("confirmForceUpdate") : t("confirmUpdate") : t("updateBtn") : t("checkForUpdates");
			const rendered = rendered_error(error, props.lang);
			return (0, react.createElement)("span", { className: "inline-flex gap-2 items-center" }, standing !== null ? (0, react.createElement)("span", { className: smallMuted }, standing) : null, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				disabled: busy || props.checked && props.laneState === "checking",
				onClick: () => updateAvailable ? armed === "update" ? run("update", compatBlocked) : setArmed("update") : props.check(props.pack.name)
			}, checkLabel), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				disabled: busy,
				onClick: () => armed === "delete" ? run("delete") : setArmed("delete")
			}, armed === "delete" ? props.consumers.length > 0 ? fill(t("confirmDeleteBreaks"), { packs: props.consumers.join(", ") }) : t("confirmDelete") : t("deleteBtn")), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				title: t("zipBtn"),
				onClick: () => downloadZipFile(`/api/docwright/pack-zip?pack=${encodeURIComponent(props.pack.name)}`, `${props.pack.name}.zip`)
			}, t("zipBtn")), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				disabled: busy,
				onClick: () => {
					const kind = props.disabled ? "enable" : "disable";
					armed === kind ? run(kind) : setArmed(kind);
				}
			}, props.disabled ? armed === "enable" ? t("confirmEnable") : t("enableBtn") : armed === "disable" ? props.consumers.length > 0 ? fill(t("confirmDisableBreaks"), { packs: props.consumers.join(", ") }) : t("confirmDisable") : t("disableBtn")), busy ? (0, react.createElement)("span", { className: muted }, t("saving")) : null, rendered !== void 0 ? (0, react.createElement)("span", { className: `${errorText} whitespace-pre-wrap` }, rendered.text, rendered.detail !== void 0 ? (0, react.createElement)("span", { className: `${muted} whitespace-pre-wrap` }, `\n${rendered.detail}`) : null) : null);
		}
		/** renderError under its real name (a local alias keeps the call sites short). */
		function rendered_error(error, lang) {
			if (error === void 0) return void 0;
			const coded = error;
			return renderError({
				message: error.message,
				...coded.code !== void 0 ? { code: coded.code } : {},
				...coded.params !== void 0 ? { params: coded.params } : {},
				...coded.detail !== void 0 ? { detail: coded.detail } : {}
			}, lang);
		}
		/** One suite card INSIDE the packs view (docs/designs/pack-suites.md): the
		* suite is a grouping of the one installed list, not a separate tab. Member
		* rows are read-only — install/update/delete go through the suite buttons;
		* a member chip click expands the member's full pack card in place (its
		* parameter declarations stay editable there, its lane actions stay hidden).
		* Members with consumers OUTSIDE the suite carry the external-reference
		* mark; deleting such a suite needs the force box (the confirm area names
		* the affected consumers). A compatBreak refusal on 更新套件 arms one force
		* re-run that answers the server's aggregated warning. */
		function SuiteCard(props) {
			const { suite, t, resolveText } = props;
			const [armedDelete, setArmedDelete] = (0, react.useState)(false);
			const [forceDelete, setForceDelete] = (0, react.useState)(false);
			const [openMember, setOpenMember] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const [done, setDone] = (0, react.useState)(void 0);
			const installed = suite.members.filter((m) => m.localVersion !== void 0);
			const external = (0, react.useMemo)(() => externalConsumersOf(suite, props.packs), [suite, props.packs]);
			const needsForce = external.size > 0;
			const compatBlocked = error?.code === "compatBreak";
			const runUpdate = (force) => {
				setBusy(true);
				setError(void 0);
				updateSuite(suite.name, force).then((result) => {
					setDone(fill(t("suiteUpdateDone"), { packs: result.updated.map((u) => `${u.name}@${u.version}`).join(", ") || t("upToDate") }));
					props.onSaved();
				}, (cause) => setError(cause instanceof Error ? cause : new Error(String(cause)))).finally(() => setBusy(false));
			};
			const runDelete = () => {
				setBusy(true);
				setError(void 0);
				deleteSuite(suite.name, forceDelete).then((result) => {
					setDone(fill(t("suiteDeletedDone"), { packs: result.deleted.join(", ") }));
					setArmedDelete(false);
					props.onSaved();
				}, (cause) => setError(cause instanceof Error ? cause : new Error(String(cause)))).finally(() => setBusy(false));
			};
			const rendered = rendered_error(error, props.lang);
			const installedNames = new Set(props.packs.map((p) => p.name));
			return (0, react.createElement)("div", {
				id: suiteAnchorId(suite.name),
				className: card
			}, (0, react.createElement)("div", { className: suiteHead }, (0, react.createElement)("span", { className: `${name$1} text-[0.95rem]` }, `${suite.org !== void 0 && suite.org !== "" ? `${suite.org}/` : ""}${suite.name}@v${suite.version}`), suite.incomplete ? (0, react.createElement)("span", { className: smallMuted }, t("suiteFillHint")) : null), (0, react.createElement)("div", { className: `${desc} mb-1` }, resolveText(suite.description)), (0, react.createElement)("div", null, (0, react.createElement)("div", { className: `${muted} mt-1 flex gap-1.5 flex-wrap items-center` }, (0, react.createElement)("span", {
				title: t("colMembers"),
				className: "inline-flex items-center"
			}, icon(SUITE_ICON_PATH)), suite.members.map((m) => {
				const referenced = external.has(m.name);
				const isOpen = openMember === m.name;
				return (0, react.createElement)("span", {
					key: m.name,
					title: referenced ? `${m.name}: ${t("suiteExternalRef")}` : m.name,
					onClick: installedNames.has(m.name) ? () => setOpenMember(isOpen ? void 0 : m.name) : void 0,
					className: installedNames.has(m.name) === false ? memberChipMissing : referenced ? memberChipExternal : `${memberChip}${isOpen ? " font-semibold" : ""}`
				}, m.localVersion === void 0 ? m.name : `${m.name}@${m.localVersion}${referenced ? " ↗" : ""}`);
			})), (0, react.createElement)("div", { className: actions }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				disabled: busy,
				onClick: () => runUpdate(compatBlocked)
			}, compatBlocked ? t("confirmForceUpdate") : t("suiteUpdateBtn")), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				disabled: busy,
				onClick: () => {
					setArmedDelete((v) => !v);
					setForceDelete(false);
				}
			}, armedDelete ? t("cancel") : t("deleteBtn")), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				title: t("zipBtn"),
				onClick: () => downloadZipFile(`/api/docwright/suite-zip?suite=${encodeURIComponent(suite.name)}`, `${suite.name}.zip`)
			}, t("zipBtn")), busy ? (0, react.createElement)("span", { className: smallMuted }, t("saving")) : null, done !== void 0 && !busy ? (0, react.createElement)("span", { className: smallMuted }, done) : null, rendered !== void 0 ? (0, react.createElement)(ErrorLine, {
				error,
				lang: props.lang
			}) : null), armedDelete ? (0, react.createElement)("div", { className: `${smallMuted} mt-1.5 border-t-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] pt-1.5` }, fill(t("suiteDeleteSummary"), { packs: installed.map((m) => m.name).join("、") || "—" }), needsForce ? (0, react.createElement)("div", { className: "mt-1" }, fill(t("suiteExternalMembers"), { list: [...external.entries()].map(([m, cs]) => `${m} ← ${cs.join(", ")}`).join("；") }), (0, react.createElement)("label", { className: "mt-1 flex items-center gap-1.5 cursor-pointer" }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: forceDelete,
				onChange: (e) => setForceDelete(e.target.checked)
			}), t("suiteForce"))) : null, (0, react.createElement)("div", { className: "mt-1.5" }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				disabled: busy || installed.length === 0 || needsForce && !forceDelete,
				onClick: runDelete
			}, t("suiteDeleteConfirm")))) : null, openMember !== void 0 ? (0, react.createElement)("div", { className: "mt-1.5 border-t-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] pt-1.5" }, props.renderMember(openMember) ?? (0, react.createElement)("p", { className: muted }, openMember)) : null));
		}
		function ConfigView(props) {
			const { payload, t } = props;
			const entries = payload.config;
			const [drafts, setDrafts] = (0, react.useState)({});
			const [switches, setSwitches] = (0, react.useState)({});
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const [done, setDone] = (0, react.useState)(false);
			const toplevel = entries.filter((e) => !e.key.includes(".") && e.type !== "object");
			const advanced = entries.filter((e) => e.key.startsWith("oscillation.") && e.type !== "object");
			const draftOf = (e) => drafts[e.key] ?? (e.value === void 0 ? "" : String(e.value));
			const dirty = entries.some((e) => {
				if (e.type === "boolean") return switches[e.key] !== void 0 && switches[e.key] !== e.value;
				if (e.type === "object" || e.key.includes(".")) return false;
				const draft = drafts[e.key];
				return draft !== void 0 && draft !== (e.value === void 0 ? "" : String(e.value));
			});
			const renderRow = (e) => {
				const invalid = (() => {
					if (e.type === "number" && drafts[e.key] !== void 0) {
						const n = Number(drafts[e.key]);
						return drafts[e.key] !== "" && !Number.isFinite(n);
					}
					return false;
				})();
				const control = e.type === "boolean" ? (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
					checked: switches[e.key] ?? e.value === true,
					onChange: (next) => setSwitches((prev) => ({
						...prev,
						[e.key]: next
					})),
					label: e.key
				}) : e.choices !== void 0 ? (0, react.createElement)("select", {
					value: draftOf(e) || String(e.value ?? ""),
					onChange: (ev) => setDrafts((prev) => ({
						...prev,
						[e.key]: ev.target.value
					})),
					className: "w-40"
				}, e.choices.map((c) => (0, react.createElement)("option", {
					key: String(c),
					value: String(c)
				}, String(c)))) : (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Input, {
					value: draftOf(e),
					type: e.type === "number" ? "number" : "text",
					step: "any",
					"aria-invalid": invalid,
					onChange: (ev) => setDrafts((prev) => ({
						...prev,
						[e.key]: ev.target.value
					})),
					style: { width: "160px" }
				});
				return (0, react.createElement)("div", {
					key: e.key,
					className: `${NS$1}-row ${row}`
				}, (0, react.createElement)("div", { className: "flex flex-col flex-1 min-w-0" }, (0, react.createElement)("div", { className: rowHead }, (0, react.createElement)("span", { className: name$1 }, e.key), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Pill, {}, e.origin === "configured" ? t("configured") : e.value === void 0 ? t("unset") : t("inherited"))), e.description !== void 0 ? (0, react.createElement)(DescriptionLine, {
					text: e.description,
					resolveText: props.resolveText
				}) : null, control, e.origin === "default" && e.default !== void 0 && String(e.default) !== String(e.value ?? "") ? (0, react.createElement)("div", { className: muted }, `${t("inherited")}: ${String(e.default)}`) : null));
			};
			const saveAll = async () => {
				const patch = {};
				for (const e of entries) {
					if (e.type === "object" || e.key.includes(".")) continue;
					if (e.type === "boolean") {
						const next = switches[e.key];
						if (next !== void 0 && next !== e.value) patch[e.key] = next;
						continue;
					}
					const draft = drafts[e.key];
					if (draft === void 0 || draft === (e.value === void 0 ? "" : String(e.value))) continue;
					patch[e.key] = e.type === "number" ? Number(draft) : draft === "" ? void 0 : draft;
				}
				if (Object.keys(patch).length === 0) return;
				setBusy(true);
				setError(void 0);
				try {
					await saveConfigPatch(patch);
					setDone(true);
					setDrafts({});
					setSwitches({});
					props.onSaved();
				} catch (saveError) {
					setError(saveError);
				} finally {
					setBusy(false);
				}
			};
			const [showAdvanced, setShowAdvanced] = (0, react.useState)(false);
			return (0, react.createElement)("div", null, (0, react.createElement)("p", { className: muted }, t("configHint")), toplevel.map((e) => renderRow(e)), advanced.length > 0 ? (0, react.createElement)("div", { className: "mt-2" }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				variant: "ghost",
				onClick: () => setShowAdvanced((v) => !v)
			}, `${showAdvanced ? "▾" : "▸"} ${t("advanced")}`), showAdvanced ? advanced.map((e) => renderRow(e)) : null) : null, (0, react.createElement)("div", { className: actions }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: "primary",
				disabled: !dirty || busy,
				onClick: () => void saveAll()
			}, busy ? t("saving") : t("saveConfig")), done && !dirty ? (0, react.createElement)("span", { className: muted }, t("saved")) : null, error !== void 0 ? (0, react.createElement)(ErrorLine, {
				error,
				lang: props.lang
			}) : null));
		}
		/** The section: one fetch cycle, three views (docs/designs/pack-suites.md). */
		function ParamsSection(props) {
			const lang = props.lang === "zh" ? "zh" : "en";
			const t = (0, react.useMemo)(() => translate(lang === "zh" ? zh : en), [lang]);
			const [payload, setPayload] = (0, react.useState)(void 0);
			const [suites, setSuites] = (0, react.useState)(void 0);
			const [error, setError] = (0, react.useState)(void 0);
			const [view, setView] = (0, react.useState)("packs");
			/** Chip jumps: the suites live inside the packs view now, so a legacy
			* 'suites' target lands there too; then scroll the anchored card into view
			* once it has rendered (one frame is enough for React). */
			const jumpTo = (0, react.useCallback)((rawTarget, anchor) => {
				setView(rawTarget === "suites" ? "packs" : rawTarget);
				window.setTimeout(() => {
					document.getElementById(anchor)?.scrollIntoView({
						behavior: "smooth",
						block: "center"
					});
				}, 60);
			}, []);
			const refresh = (0, react.useCallback)(() => {
				fetchParams().then((p) => {
					setPayload(p);
					setError(void 0);
				}).catch((e) => setError(e));
				fetchSuiteStatus().then((rows) => setSuites({
					state: "ok",
					rows
				})).catch(() => setSuites((prev) => ({
					state: "unreachable",
					rows: prev?.rows ?? []
				})));
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const suiteMarkers = (0, react.useMemo)(() => suitesByPack(suites?.rows ?? []), [suites]);
			if (error !== void 0) return (0, react.createElement)("div", { className: "dw-root" }, (0, react.createElement)("p", { className: `${errorText} whitespace-pre-wrap` }, renderError(error, lang).text), (0, react.createElement)("p", { className: muted }, error.message), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				size: "sm",
				onClick: refresh
			}, t("retry")));
			if (payload === void 0) return (0, react.createElement)("p", { className: `dw-root ${muted}` }, t("loading"));
			const tabs = [
				{
					value: "packs",
					label: t("viewPacks"),
					id: `${NS$1}-packs`,
					panelId: `${NS$1}-packs-panel`
				},
				{
					value: "groups",
					label: t("viewGroups"),
					id: `${NS$1}-groups`,
					panelId: `${NS$1}-groups-panel`
				},
				{
					value: "config",
					label: t("viewConfig"),
					id: `${NS$1}-config`,
					panelId: `${NS$1}-config-panel`
				}
			];
			return (0, react.createElement)("div", { className: `${NS$1}-section dw-root` }, (0, react.createElement)("h3", { className: "m-0 mb-1 font-semibold" }, t("title")), (0, react.createElement)("p", { className: `${muted} m-0 mb-2` }, t("intro")), (0, react.createElement)("div", { className: "mt-2 mb-3" }, (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
				items: [...tabs],
				value: view,
				onChange: (v) => setView(v),
				label: t("title")
			})), view === "groups" ? (0, react.createElement)(GroupsView, {
				payload,
				t,
				lang,
				resolveText: props.resolveText,
				onSaved: refresh,
				onJump: jumpTo
			}) : null, view === "packs" ? (0, react.createElement)(PacksView, {
				payload,
				suites: suiteMarkers,
				suitesLane: suites,
				t,
				lang,
				resolveText: props.resolveText,
				onJump: jumpTo,
				onSaved: refresh
			}) : null, view === "config" ? (0, react.createElement)(ConfigView, {
				payload,
				t,
				lang,
				resolveText: props.resolveText,
				onSaved: refresh
			}) : null);
		}
		//#endregion
		//#region src/client/MarketTab.tsx
		/**
		* The Plugins-page pack-market tab: the pack market embedded in place. The
		* site is anonymous-readable (catalog and tarball downloads); account
		* features keep their own Supabase session inside the frame — partitioned
		* storage, so the frame signs in separately from the standalone site. An
		* always-visible header offers the standalone escape hatch, which also
		* covers deployments where the frame is refused.
		*
		* The market URL is deployment state, not a bundle constant: the tab
		* resolves it once per mount from the plugin's own params payload
		* (Config.marketUrl, served by src/http.ts), falling back to the published
		* default. That keeps the published default PRODUCTION (npm users get the
		* production market with zero configuration) while a dev instance points
		* marketUrl at its own market — the one environment knob, no build-time
		* flavors. Styling is Tailwind (styles.css; the market's accent palette with
		* host theme tokens for neutrals — same discipline as ParamsSection).
		*/
		/** The published default (production market). */
		const MARKET_URL = "https://dm.shrwk.com/";
		const secondary = "text-[var(--dsw-alias-label-secondary,inherit)]";
		function isMarketMessage(event, marketOrigin, frame) {
			if (event.origin !== marketOrigin) return false;
			if (frame === null || event.source !== frame.contentWindow) return false;
			const data = event.data;
			return typeof data === "object" && data !== null && data.source === "docwright-market";
		}
		function MarketTab(props) {
			const t = translate(props.lang === "zh" ? zh : en);
			const [url, setUrl] = (0, react.useState)(MARKET_URL);
			const [bridgeStatus, setBridgeStatus] = (0, react.useState)(null);
			const frameRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				fetchParams().then((payload) => {
					const configured = normalizeMarketUrl(payload.config.find((e) => e.key === "marketUrl")?.value);
					if (configured !== void 0) setUrl(configured);
				}).catch(() => {});
			}, []);
			const marketOrigin = (() => {
				try {
					return new URL(url).origin;
				} catch {
					return "";
				}
			})();
			(0, react.useEffect)(() => {
				if (marketOrigin === "") return;
				const onMessage = (event) => {
					if (!isMarketMessage(event, marketOrigin, frameRef.current)) return;
					const { type, id, kind, name } = event.data;
					if (type !== "install-request") return;
					const reply = (message) => {
						event.source?.postMessage({
							source: "docwright-market",
							id,
							...message
						}, { targetOrigin: event.origin });
					};
					if (typeof id !== "string" || id.length === 0 || kind !== "pack" && kind !== "suite" || typeof name !== "string" || name.length === 0) {
						reply({
							type: "install-result",
							ok: false,
							message: "malformed install request (need string id, kind \"pack\"|\"suite\", non-empty name)"
						});
						return;
					}
					reply({ type: "install-accepted" });
					setBridgeStatus(t("bridgeInstalling"));
					(kind === "pack" ? installMarketPack(name) : installMarketSuite(name)).then((installed) => {
						setBridgeStatus(null);
						reply({
							type: "install-result",
							ok: true,
							installed
						});
					}, (error) => {
						setBridgeStatus(null);
						reply({
							type: "install-result",
							ok: false,
							message: error instanceof ApiError ? error.message : String(error?.message ?? error)
						});
					});
				};
				window.addEventListener("message", onMessage);
				return () => window.removeEventListener("message", onMessage);
			}, [marketOrigin, t]);
			return (0, react.createElement)("div", { className: "dw-root flex flex-col gap-2 min-h-[480px] h-[calc(100vh-150px)]" }, (0, react.createElement)("div", { className: "flex items-baseline gap-2.5 flex-none" }, (0, react.createElement)("span", { className: "font-semibold text-sm" }, t("marketTitle")), (0, react.createElement)("span", { className: `${secondary} text-xs` }, url.replace(/\/$/, "")), bridgeStatus !== null && (0, react.createElement)(react.Fragment, null, (0, react.createElement)("span", { className: `text-xs text-[var(--color-accent,#2b7fff)]` }, bridgeStatus)), (0, react.createElement)("a", {
				href: url,
				target: "_blank",
				rel: "noreferrer",
				className: `${secondary} text-xs no-underline`
			}, t("openExternal"))), (0, react.createElement)("iframe", {
				key: url,
				src: url,
				title: t("marketTitle"),
				className: "flex-1 w-full border-[0.5px] border-[var(--dsw-alias-border-l4,transparent)] rounded-[var(--dsw-radius-xl,20px)] bg-[var(--dsw-alias-bg-layer-1,#fff)]",
				ref: frameRef
			}));
		}
		function normalizeMarketUrl(value) {
			if (typeof value !== "string" || !/^https:\/\//.test(value)) return void 0;
			return value.endsWith("/") ? value : `${value}/`;
		}
		//#endregion
		//#region src/client/generated-css.ts
		/** GENERATED by scripts/build-client-css.mjs from src/client/styles.css — do not edit. */
		const CLIENT_CSS_BUNDLE = "/*! tailwindcss v4.3.5 | MIT License | https://tailwindcss.com */\n@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:block))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after,::backdrop{--tw-rotate-x:initial;--tw-rotate-y:initial;--tw-rotate-z:initial;--tw-skew-x:initial;--tw-skew-y:initial;--tw-border-style:solid;--tw-font-weight:initial;--tw-ordinal:initial;--tw-slashed-zero:initial;--tw-numeric-figure:initial;--tw-numeric-spacing:initial;--tw-numeric-fraction:initial;--tw-shadow:0 0 #0000;--tw-shadow-color:initial;--tw-shadow-alpha:100%;--tw-inset-shadow:0 0 #0000;--tw-inset-shadow-color:initial;--tw-inset-shadow-alpha:100%;--tw-ring-color:initial;--tw-ring-shadow:0 0 #0000;--tw-inset-ring-color:initial;--tw-inset-ring-shadow:0 0 #0000;--tw-ring-inset:initial;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-offset-shadow:0 0 #0000;--tw-outline-style:solid;--tw-blur:initial;--tw-brightness:initial;--tw-contrast:initial;--tw-grayscale:initial;--tw-hue-rotate:initial;--tw-invert:initial;--tw-opacity:initial;--tw-saturate:initial;--tw-sepia:initial;--tw-drop-shadow:initial;--tw-drop-shadow-color:initial;--tw-drop-shadow-alpha:100%;--tw-drop-shadow-size:initial}}}@layer theme{:root,:host{--spacing:.25rem;--text-xs:.75rem;--text-xs--line-height:calc(1 / .75);--text-sm:.875rem;--text-sm--line-height:calc(1.25 / .875);--font-weight-normal:400;--font-weight-semibold:600;--color-primary:#155dfc;--color-accent:#2b7fff}}@layer base;@layer components{.dw-root{font-family:var(--dsw-font-family,inherit);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}.dw-code{font-family:var(--dsh-font-family-code,ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)}}@layer utilities{.collapse{visibility:collapse}.invisible{visibility:hidden}.visible{visibility:visible}.absolute{position:absolute}.fixed{position:fixed}.relative{position:relative}.static{position:static}.container{width:100%}@media (min-width:40rem){.container{max-width:40rem}}@media (min-width:48rem){.container{max-width:48rem}}@media (min-width:64rem){.container{max-width:64rem}}@media (min-width:80rem){.container{max-width:80rem}}@media (min-width:96rem){.container{max-width:96rem}}.m-0{margin:0}.-mx-4{margin-inline:calc(var(--spacing) * -4)}.-my-3{margin-block:calc(var(--spacing) * -3)}.mt-0{margin-top:0}.mt-0\\.5{margin-top:calc(var(--spacing) * .5)}.mt-1{margin-top:var(--spacing)}.mt-1\\.5{margin-top:calc(var(--spacing) * 1.5)}.mt-2{margin-top:calc(var(--spacing) * 2)}.mt-3{margin-top:calc(var(--spacing) * 3)}.mb-0{margin-bottom:0}.mb-1{margin-bottom:var(--spacing)}.mb-2{margin-bottom:calc(var(--spacing) * 2)}.mb-2\\.5{margin-bottom:calc(var(--spacing) * 2.5)}.mb-3{margin-bottom:calc(var(--spacing) * 3)}.block{display:block}.contents{display:contents}.flex{display:flex}.hidden{display:none}.inline{display:inline}.inline-block{display:inline-block}.inline-flex{display:inline-flex}.table{display:table}.h-\\[calc\\(100vh-150px\\)\\]{height:calc(100vh - 150px)}.min-h-\\[480px\\]{min-height:480px}.w-40{width:calc(var(--spacing) * 40)}.w-full{width:100%}.max-w-\\[480px\\]{max-width:480px}.min-w-0{min-width:0}.flex-1{flex:1}.flex-none{flex:none}.shrink-0{flex-shrink:0}.grow{flex-grow:1}.transform{transform:var(--tw-rotate-x, ) var(--tw-rotate-y, ) var(--tw-rotate-z, ) var(--tw-skew-x, ) var(--tw-skew-y, )}.cursor-pointer{cursor:pointer}.resize{resize:both}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.items-baseline{align-items:baseline}.items-center{align-items:center}.gap-1{gap:var(--spacing)}.gap-1\\.5{gap:calc(var(--spacing) * 1.5)}.gap-2{gap:calc(var(--spacing) * 2)}.gap-2\\.5{gap:calc(var(--spacing) * 2.5)}.gap-3{gap:calc(var(--spacing) * 3)}.overflow-hidden{overflow:hidden}.rounded{border-radius:.25rem}.rounded-\\[var\\(--dsw-radius-xl\\,20px\\)\\]{border-radius:var(--dsw-radius-xl,20px)}.rounded-full{border-radius:2147483647px}.border{border-style:var(--tw-border-style);border-width:1px}.border-\\[0\\.5px\\]{border-style:var(--tw-border-style);border-width:.5px}.border-t-\\[0\\.5px\\]{border-top-style:var(--tw-border-style);border-top-width:.5px}.border-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-link\\,\\#155dfc\\)_35\\%\\,transparent\\)\\]{border-color:var(--dsw-alias-link,#155dfc)}@supports (color:color-mix(in lab, red, red)){.border-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-link\\,\\#155dfc\\)_35\\%\\,transparent\\)\\]{border-color:color-mix(in srgb,var(--dsw-alias-link,#155dfc) 35%,transparent)}}.border-\\[rgba\\(21\\,93\\,252\\,0\\.35\\)\\]{border-color:#155dfc59}.border-\\[rgba\\(197\\,48\\,48\\,0\\.38\\)\\]{border-color:#c5303061}.border-\\[rgba\\(212\\,140\\,34\\,0\\.55\\)\\]{border-color:#d48c228c}.border-\\[var\\(--dsw-alias-border-l4\\,transparent\\)\\]{border-color:var(--dsw-alias-border-l4,transparent)}.bg-\\[color-mix\\(in_srgb\\,var\\(--color-primary\\)_7\\%\\,transparent\\)\\]{background-color:#155dfc12}@supports (color:color-mix(in lab, red, red)){.bg-\\[color-mix\\(in_srgb\\,var\\(--color-primary\\)_7\\%\\,transparent\\)\\]{background-color:color-mix(in srgb,var(--color-primary) 7%,transparent)}}.bg-\\[color-mix\\(in_srgb\\,var\\(--color-primary\\)_14\\%\\,transparent\\)\\]{background-color:#155dfc24}@supports (color:color-mix(in lab, red, red)){.bg-\\[color-mix\\(in_srgb\\,var\\(--color-primary\\)_14\\%\\,transparent\\)\\]{background-color:color-mix(in srgb,var(--color-primary) 14%,transparent)}}.bg-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-link\\,\\#155dfc\\)_10\\%\\,transparent\\)\\]{background-color:var(--dsw-alias-link,#155dfc)}@supports (color:color-mix(in lab, red, red)){.bg-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-link\\,\\#155dfc\\)_10\\%\\,transparent\\)\\]{background-color:color-mix(in srgb,var(--dsw-alias-link,#155dfc) 10%,transparent)}}.bg-\\[rgba\\(21\\,93\\,252\\,0\\.08\\)\\]{background-color:#155dfc14}.bg-\\[rgba\\(197\\,48\\,48\\,0\\.10\\)\\]{background-color:#c530301a}.bg-\\[rgba\\(212\\,140\\,34\\,0\\.12\\)\\]{background-color:#d48c221f}.bg-\\[var\\(--dsw-alias-bg-layer-1\\)\\]{background-color:var(--dsw-alias-bg-layer-1)}.bg-\\[var\\(--dsw-alias-bg-layer-1\\,\\#fff\\)\\]{background-color:var(--dsw-alias-bg-layer-1,#fff)}.bg-\\[var\\(--dsw-alias-bg-layer-2\\,transparent\\)\\]{background-color:var(--dsw-alias-bg-layer-2,transparent)}.px-2{padding-inline:calc(var(--spacing) * 2)}.px-4{padding-inline:calc(var(--spacing) * 4)}.py-1{padding-block:var(--spacing)}.py-1\\.5{padding-block:calc(var(--spacing) * 1.5)}.py-2{padding-block:calc(var(--spacing) * 2)}.py-2\\.5{padding-block:calc(var(--spacing) * 2.5)}.py-3{padding-block:calc(var(--spacing) * 3)}.py-px{padding-block:1px}.pt-1{padding-top:var(--spacing)}.pt-1\\.5{padding-top:calc(var(--spacing) * 1.5)}.text-sm{font-size:var(--text-sm);line-height:var(--tw-leading,var(--text-sm--line-height))}.text-xs{font-size:var(--text-xs);line-height:var(--tw-leading,var(--text-xs--line-height))}.text-\\[0\\.82rem\\]{font-size:.82rem}.text-\\[0\\.95rem\\]{font-size:.95rem}.font-normal{--tw-font-weight:var(--font-weight-normal);font-weight:var(--font-weight-normal)}.font-semibold{--tw-font-weight:var(--font-weight-semibold);font-weight:var(--font-weight-semibold)}.break-words{overflow-wrap:break-word}.whitespace-nowrap{white-space:nowrap}.whitespace-pre-wrap{white-space:pre-wrap}.text-\\[var\\(--color-accent\\,\\#2b7fff\\)\\]{color:var(--color-accent,#2b7fff)}.text-\\[var\\(--color-primary\\,\\#155dfc\\)\\]{color:var(--color-primary,#155dfc)}.text-\\[var\\(--dsw-alias-label-secondary\\,inherit\\)\\]{color:var(--dsw-alias-label-secondary,inherit)}.text-\\[var\\(--dsw-alias-link\\,\\#155dfc\\)\\]{color:var(--dsw-alias-link,#155dfc)}.text-\\[var\\(--dsw-alias-state-error-primary\\,\\#dc2626\\)\\]{color:var(--dsw-alias-state-error-primary,#dc2626)}.lowercase{text-transform:lowercase}.ordinal{--tw-ordinal:ordinal;font-variant-numeric:var(--tw-ordinal, ) var(--tw-slashed-zero, ) var(--tw-numeric-figure, ) var(--tw-numeric-spacing, ) var(--tw-numeric-fraction, )}.line-through{text-decoration-line:line-through}.no-underline{text-decoration-line:none}.opacity-60{opacity:.6}.shadow{--tw-shadow:0 1px 3px 0 var(--tw-shadow-color,#0000001a), 0 1px 2px -1px var(--tw-shadow-color,#0000001a);box-shadow:var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)}.outline{outline-style:var(--tw-outline-style);outline-width:1px}.filter{filter:var(--tw-blur, ) var(--tw-brightness, ) var(--tw-contrast, ) var(--tw-grayscale, ) var(--tw-hue-rotate, ) var(--tw-invert, ) var(--tw-saturate, ) var(--tw-sepia, ) var(--tw-drop-shadow, )}@media (hover:hover){.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-link\\,\\#155dfc\\)_18\\%\\,transparent\\)\\]:hover{background-color:var(--dsw-alias-link,#155dfc)}@supports (color:color-mix(in lab, red, red)){.hover\\:bg-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-link\\,\\#155dfc\\)_18\\%\\,transparent\\)\\]:hover{background-color:color-mix(in srgb,var(--dsw-alias-link,#155dfc) 18%,transparent)}}.hover\\:bg-\\[rgba\\(21\\,93\\,252\\,0\\.16\\)\\]:hover{background-color:#155dfc29}.hover\\:underline:hover{text-decoration-line:underline}}}@property --tw-rotate-x{syntax:\"*\";inherits:false}@property --tw-rotate-y{syntax:\"*\";inherits:false}@property --tw-rotate-z{syntax:\"*\";inherits:false}@property --tw-skew-x{syntax:\"*\";inherits:false}@property --tw-skew-y{syntax:\"*\";inherits:false}@property --tw-border-style{syntax:\"*\";inherits:false;initial-value:solid}@property --tw-font-weight{syntax:\"*\";inherits:false}@property --tw-ordinal{syntax:\"*\";inherits:false}@property --tw-slashed-zero{syntax:\"*\";inherits:false}@property --tw-numeric-figure{syntax:\"*\";inherits:false}@property --tw-numeric-spacing{syntax:\"*\";inherits:false}@property --tw-numeric-fraction{syntax:\"*\";inherits:false}@property --tw-shadow{syntax:\"*\";inherits:false;initial-value:0 0 #0000}@property --tw-shadow-color{syntax:\"*\";inherits:false}@property --tw-shadow-alpha{syntax:\"<percentage>\";inherits:false;initial-value:100%}@property --tw-inset-shadow{syntax:\"*\";inherits:false;initial-value:0 0 #0000}@property --tw-inset-shadow-color{syntax:\"*\";inherits:false}@property --tw-inset-shadow-alpha{syntax:\"<percentage>\";inherits:false;initial-value:100%}@property --tw-ring-color{syntax:\"*\";inherits:false}@property --tw-ring-shadow{syntax:\"*\";inherits:false;initial-value:0 0 #0000}@property --tw-inset-ring-color{syntax:\"*\";inherits:false}@property --tw-inset-ring-shadow{syntax:\"*\";inherits:false;initial-value:0 0 #0000}@property --tw-ring-inset{syntax:\"*\";inherits:false}@property --tw-ring-offset-width{syntax:\"<length>\";inherits:false;initial-value:0}@property --tw-ring-offset-color{syntax:\"*\";inherits:false;initial-value:#fff}@property --tw-ring-offset-shadow{syntax:\"*\";inherits:false;initial-value:0 0 #0000}@property --tw-outline-style{syntax:\"*\";inherits:false;initial-value:solid}@property --tw-blur{syntax:\"*\";inherits:false}@property --tw-brightness{syntax:\"*\";inherits:false}@property --tw-contrast{syntax:\"*\";inherits:false}@property --tw-grayscale{syntax:\"*\";inherits:false}@property --tw-hue-rotate{syntax:\"*\";inherits:false}@property --tw-invert{syntax:\"*\";inherits:false}@property --tw-opacity{syntax:\"*\";inherits:false}@property --tw-saturate{syntax:\"*\";inherits:false}@property --tw-sepia{syntax:\"*\";inherits:false}@property --tw-drop-shadow{syntax:\"*\";inherits:false}@property --tw-drop-shadow-color{syntax:\"*\";inherits:false}@property --tw-drop-shadow-alpha{syntax:\"<percentage>\";inherits:false;initial-value:100%}@property --tw-drop-shadow-size{syntax:\"*\";inherits:false}";
		//#endregion
		//#region src/client/index.tsx
		/**
		* docwright UI client half: mounts the plugin's three host surfaces, each
		* reached through `slots.inject`, which waits for the slot to exist — a host
		* that never declares one never runs its registration (dsh-market's detection
		* pattern — no version strings):
		*
		* - `settings.section` (+ `settings.section.icon`): a top-level Settings nav
		*   entry rendering the params maintenance views (dsh-market's Settings entry
		*   recipe; the icon id must equal the section id or the shell never draws it).
		* - `plugins.tab`: a tab on the Plugins page's tab row (after 已安装) opening
		*   the pack market (dm.shrwk.com) in place. Order 1 lands after the host's
		*   own Discover tab; dsh-market's tab takes -1 to sit before it.
		* - `plugins.bundle.config`: the configuration card on the bundle's own
		*   Plugins page, keyed by this package's name.
		*
		* The 0.1.7-era `settings.plugins.tab` seat is intentionally NOT registered:
		* the top-level section supersedes it (one settings home, like dsh-market,
		* which dropped the inner tab too).
		*
		* Built by tsdown into the __ModuleLoader__ factory bundle at client/client.js;
		* externals resolve through the loader's module table. Containment follows
		* dsh-market's lesson: a throw inside the host's client bootstrap takes the
		* whole app down, so each mounting is wrapped separately and a failure costs
		* that one surface for the session, never the shell.
		*/
		/** Compiled Tailwind CSS — generated-css.ts is emitted by
		* scripts/build-client-css.mjs from src/client/styles.css (run by
		* build:client and typecheck; never hand-edited). */
		const NS = "docwright-params";
		/** The bundle's package name — the key `plugins.bundle.config` is contracted to. */
		const PACKAGE_NAME = "@sharework-ai/dsh-docwright";
		/** The style-tag identity — one sheet per page, idempotent across remounts. */
		const CSS_TAG_ID = "docwright/client.css";
		/** Inject the plugin's stylesheet once (dsh-market's data-plugin-css
		* pattern). Utilities are global class names but carry no host reset — the
		* sheet defines exactly the utilities this bundle uses. */
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_TAG_ID);
			tag.textContent = CLIENT_CSS_BUNDLE;
			document.head.appendChild(tag);
		}
		/** The settings.section id; `settings.section.icon` must register the same id. */
		const SECTION_ID = "docwright";
		/** The plugins.tab id. */
		const MARKET_TAB_ID = "docwright-market";
		/** Primitives this bundle requires that older hosts may lack. */
		const REQUIRED_PRIMITIVES = [
			"Button",
			"Input",
			"Pill",
			"SegmentedTabs",
			"Switch"
		];
		function missingPrimitives(mod) {
			return REQUIRED_PRIMITIVES.filter((name) => mod[name] === void 0);
		}
		const name = "docwright-params";
		const inject = ["slots", "locale"];
		function apply(ctx) {
			const gaps = missingPrimitives(_deepseek_ai_dsh_client_ui_primitives);
			if (gaps.length > 0) {
				console.warn(`[docwright] host ui-primitives missing ${gaps.join(", ")} — params section disabled (newer dsh web required)`);
				return;
			}
			try {
				injectStyles();
				mountSection(ctx);
			} catch (error) {
				console.error("[docwright] surfaces failed to mount; the rest of the app is unaffected.", error);
			}
		}
		/** Register one slot cell, converting whatever disposer the host hands back
		* into a fiber-owned cleanup (absent disposers become no-ops). */
		function own(ctx, label, register) {
			const off = register();
			ctx.effect(() => () => {
				if (typeof off === "function") off();
			}, label);
		}
		function mountSection(ctx) {
			let lang = ctx.locale.getSnapshot().active === "zh" ? "zh" : "en";
			ctx.locale.subscribe(() => {
				lang = ctx.locale.getSnapshot().active === "zh" ? "zh" : "en";
			});
			const label = () => lang === "zh" ? "Docwright 参数" : "Docwright params";
			const marketLabel = () => lang === "zh" ? "Docwright 市场" : "Docwright packs";
			const resolveText = (value) => {
				if (typeof ctx.locale.resolveText === "function") return ctx.locale.resolveText(value);
				return resolveLocalized(value, lang);
			};
			const params = () => (0, react.createElement)(ParamsSection, {
				lang,
				resolveText
			});
			try {
				ctx.slots.inject("settings.section", () => {
					own(ctx, "docwright: settings section", () => ctx.slots.register({
						name: "settings.section",
						id: SECTION_ID,
						order: 45,
						label,
						locale: NS,
						inject: () => ({ lang })
					}, params));
				});
			} catch (error) {
				console.error("[docwright] settings section failed to register.", error);
			}
			try {
				ctx.slots.inject("settings.section.icon", () => {
					own(ctx, "docwright: settings icon", () => ctx.slots.register({
						name: "settings.section.icon",
						id: SECTION_ID
					}, (owner = {}) => (0, react.createElement)(DocwrightMark, { size: owner.size ?? 16 })));
				});
			} catch (error) {
				console.error("[docwright] settings icon failed to register.", error);
			}
			try {
				ctx.slots.inject("plugins.tab", () => {
					own(ctx, "docwright: plugins market tab", () => ctx.slots.register({
						name: "plugins.tab",
						id: MARKET_TAB_ID,
						order: 1,
						label: marketLabel,
						locale: NS,
						inject: () => ({ lang })
					}, () => (0, react.createElement)(MarketTab, { lang })));
				});
			} catch (error) {
				console.error("[docwright] plugins market tab failed to register.", error);
			}
			try {
				ctx.slots.inject("plugins.bundle.config", () => {
					own(ctx, "docwright: bundle config card", () => ctx.slots.register({
						name: "plugins.bundle.config",
						key: PACKAGE_NAME,
						locale: NS,
						inject: () => ({ lang })
					}, (owner = {}) => owner.view === "summary" ? null : params()));
				});
			} catch (error) {
				console.error("[docwright] bundle config card failed to register.", error);
			}
		}
		/** The section's nav glyph: a document sheet with a check, currentColor. */
		function DocwrightMark(owner) {
			const size = owner.size ?? 16;
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.3,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			}, (0, react.createElement)("path", { d: "M3.5 1.5h5.8l3.2 3.2v9.8h-9z" }), (0, react.createElement)("path", { d: "M9.3 1.5v3.2h3.2" }), (0, react.createElement)("path", { d: "M5.5 8.2h5" }), (0, react.createElement)("path", { d: "M5.5 10.6l1.2 1.2 2.3-2.3" }));
		}
		//#endregion
		exports.DocwrightMark = DocwrightMark;
		exports.apply = apply;
		exports.inject = inject;
		exports.missingPrimitives = missingPrimitives;
		exports.name = name;
		return module.exports;
	}
});
