// ==UserScript==
// @name         Catiecli Playground Executor
// @version      2.6.0
// @description  在 AI Studio Playground 页面激活：① WS Executor 模式——接收后端请求，页面 WAA proof + fetch 调用 MakerSuite；② 定时 Cookie 推送模式——保持该页面打开，每 40–50 分钟安全续推会话 Cookie 到用户配置的 catiecli 云端。
// @author       catiecli
// @namespace    https://catiecli.sukaka.top/
// @match        https://aistudio.google.com/*prompts*
// @match        https://alkalimakersuite-pa.clients6.google.com/*
// @connect      127.0.0.1
// @connect      catiecli.sukaka.top
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @grant        GM.xmlHttpRequest
// @grant        GM_openInTab
// @noframes
// @homepageURL  https://catiecli.sukaka.top/
// ==/UserScript==

/*
 * ============================== 使用说明 ==============================
 *
 * 1. 确保账号下已创建 cat- 前缀 API Key。
 *
 * 2. 安装本脚本后打开 Playground 页面：
 *    https://aistudio.google.com/prompts/new_chat
 *    ⚠ Cookie 推送（云端模式）需要 Tampermonkey 开启「开发者模式」
 *      （Chrome 扩展页 → Tampermonkey → 开发者模式开关），否则 GM_cookie 不可用。
 *
 * 3. 面板出现后：
 *    a. 菜单（或面板按钮）里设置 catiecli API Key
 *    b. 首次与每次新建/刷新页面时，脚本可自动发送一条 "hi" 激活 WAA；
 *       也可关闭自动激活，由你手动发送消息。
 *       脚本靠这次请求捕获页面的 WAA service 引用与 GenerateContent
 *       公共请求头，完成引导后面板显示"WAA 就绪"。
 *    c. 脚本自动连接 WS 并注册，面板显示"已连接"。
 *
 * 4. 【云端无头模式（推荐）】点击面板「推送 Cookie」按钮（或菜单
 *    「☁ 推送 Cookie 到云端」）：脚本用 GM_cookie 导出 AI Studio /
 *    Google 域全部 Cookie（含 HttpOnly 的 SAPISID / __Secure-*），
 *    POST 到 catiecli 后端。之后无需保持页面在线，请求 pggo- 前缀
 *    模型即由云端用你的 Cookie 无头执行。
 *
 * 5. 开启自动续推后，脚本每 40–50 分钟重新导出并推送登录 Cookie，
 *    避免后台会话过期。此操作会将 Google 登录 Cookie（包括 HttpOnly）
 *    发送至 catiecli 云端；只有信任该服务时才开启。关闭标签页/浏览器期间
 *    不会执行，需至少保持一个 AI Studio 页面打开并登录。
 *
 * 5. 可选：面板里的「小窗保活」「后台音频保活」两个开关可分别开启（也可同时开），
 *    防止浏览器冻结/休眠后台标签页导致 WS 掉线。
 *
 * ====================================================================
 */

(function () {
    "use strict";

    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const HOST = typeof __CatieHost !== "undefined" ? __CatieHost : null;

    // ==================== 常量 ====================

    const GENERATE_URL =
        "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
    const GENERATE_PATH =
        "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";

    const EXECUTOR_TYPE = "playground"; // 与后端 EXECUTOR_TYPE_PLAYGROUND 对应
    const CLIENT_VERSION = "2.6.0";
    const WS_URL = "wss://catiecli.sukaka.top/api/build/ws";
    const PUSH_URL = "https://catiecli.sukaka.top/api/pggo/push";
    const SCRIPT_URL = "https://catiecli.sukaka.top/api/pg/script.user.js"; // @downloadURL 同源
    const AUTO_PUSH_ENABLED_KEY = "pg_auto_cookie_push";
    const AUTO_PUSH_NEXT_KEY = "pg_auto_cookie_push_next";
    const AUTO_PUSH_LAST_KEY = "pg_auto_cookie_push_last";
    const AUTO_PUSH_BASE_MS = (HOST?.settings?.pushMinutes || 45) * 60 * 1000;
    const AUTO_PUSH_JITTER_MS = HOST ? 0 : 5 * 60 * 1000;
    const AUTO_PUSH_RETRY_MS = 15 * 60 * 1000;
    const AUTO_HI_ENABLED_KEY = "pg_auto_activate_hi";
    const KEY_BOOTSTRAP_URL = "";
    const KEY_BOOTSTRAP_TOKEN = "";

    // 单次上游 fetch（含读取响应体）的最长等待
    const FETCH_TIMEOUT_MS = 900000;
    // 请求在脚本队列里等待超过此时长则视为过期，直接丢弃（后端多半已放弃/重试）
    const QUEUE_MAX_WAIT_MS = 60000;

    // 持久化：请求头快照
    const WAA_STORE_KEY = "pg_waa_snapshot";
    const WAA_PERSIST_TTL = 24 * 3600 * 1000; // 持久记录有效期 24h

    // ==================== 配置（GM 存储） ====================

    const cfg = {
        apiKey: GM_getValue("pg_api_key", ""),
        autoCookiePush: GM_getValue(AUTO_PUSH_ENABLED_KEY, false) === true,
        autoActivateHi: GM_getValue(AUTO_HI_ENABLED_KEY, true) !== false,
    };

    function saveCfg() {
        GM_setValue("pg_api_key", cfg.apiKey);
    }

    function bootstrapAccountKey() {
        if (cfg.apiKey || !KEY_BOOTSTRAP_URL || !KEY_BOOTSTRAP_TOKEN || typeof GM === "undefined" || !GM.xmlHttpRequest) return Promise.resolve(false);
        return new Promise((resolve) => {
            let finished = false;
            const done = (value) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => done(false), 4000);
            try {
                GM.xmlHttpRequest({
                    method: "POST",
                    url: KEY_BOOTSTRAP_URL,
                    headers: { "Authorization": "Bearer " + KEY_BOOTSTRAP_TOKEN, "Content-Type": "application/json" },
                    data: "{}",
                    timeout: 3500,
                    onload: (response) => {
                        try {
                            if (response.status !== 200) return done(false);
                            const data = JSON.parse(response.responseText);
                            if (typeof data.apiKey !== "string" || !data.apiKey.startsWith("cat-")) return done(false);
                            cfg.apiKey = data.apiKey;
                            data.apiKey = "";
                            saveCfg();
                            if (state.waaReady) scheduleConnect(0);
                            log("🔐 已从本机账号保险箱恢复 API Key");
                            done(true);
                        } catch (_) { done(false); }
                    },
                    onerror: () => done(false),
                    ontimeout: () => done(false),
                });
            } catch (_) { done(false); }
        });
    }

    // 面板位置持久化键
    const PANEL_POS_KEY = "pg_panel_pos";

    GM_registerMenuCommand("⚙ 设置 API Key (cat-...)", () => {
        openKeyEditor();
    });

    GM_registerMenuCommand("👁 显示/隐藏面板", () => {
        if (!panelEl) return;
        panelEl.style.display = panelEl.style.display === "none" ? "block" : "none";
    });

    GM_registerMenuCommand("🪟 小窗保活 开/关", () => {
        togglePip();
    });

    GM_registerMenuCommand("🔊 后台音频保活 开/关", () => {
        toggleAudio();
    });

    GM_registerMenuCommand("☁ 推送 Cookie 到云端 (pggo)", () => {
        pushCookiesToCloud().catch((e) => log("推送失败: " + e));
    });

    GM_registerMenuCommand("⏱ 自动续推 Cookie 开/关", () => {
        toggleAutoCookiePush();
    });

    GM_registerMenuCommand("💬 自动发送 hi 激活开/关", () => {
        toggleAutoActivateHi();
    });

    GM_registerMenuCommand("🔍 检查更新", () => {
        checkForUpdate(true).catch((e) => log("⚠ 检查更新失败: " + e));
    });

    // ==================== 工具 ====================

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function waitFor(fn, timeoutMs = 60000, intervalMs = 250) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const value = fn();
            if (value) return value;
            if (Date.now() > deadline) return null;
            await sleep(intervalMs);
        }
    }

    async function sha256Hex(text) {
        const data = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest("SHA-256", data);
        return [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    async function sha1Hex(text) {
        const data = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest("SHA-1", data);
        return [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    function getCookie(name) {
        const m = document.cookie.match(
            new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")
        );
        return m ? m[1] : null;
    }

    // 现算 SAPISIDHASH（参考 aistudio-executor）：捕获来的 authorization 头是页面
    // 上次发消息时生成的，里面的 timestamp 会过期。每次请求重新计算；
    // 读不到 cookie 或算不出时返回 null（保留捕获的那份）。
    async function freshAuthHeader() {
        try {
            const sid =
                getCookie("SAPISID") ||
                getCookie("APISID") ||
                getCookie("__Secure-3PAPISID");
            if (!sid) return null;
            const ts = Math.floor(Date.now() / 1000);
            const digest = await sha1Hex(ts + " " + sid + " " + W.location.origin);
            return "SAPISIDHASH " + ts + "_" + digest;
        } catch (_) {
            return null;
        }
    }

    function normalizeNewlines(s) {
        return String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    const logs = [];
    function log(msg) {
        if (HOST) HOST.log(msg);
        logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (logs.length > 200) logs.shift();
        console.log("[PG-EXEC]", msg);
        captureNotice(String(msg));
        updatePanel();
    }

    // ==================== 状态 ====================

    const state = {
        ws: null,
        wsStatus: "disconnected", // disconnected | connecting | connected
        waaReady: false,
        waaSnapshotKey: null,
        waaPersistedTs: 0, // 持久化请求头快照的时间戳（0 = 无）
        reconnectTimer: null,
        reconnectDelay: 1000,
        queueTail: Promise.resolve(), // 请求串行队列（proof 绑定输入框，必须串行）
        aborted: new Set(), // 已取消的 requestId
        controllers: new Map(), // requestId -> AbortController
        requestCount: 0,
        queueDepth: 0, // 已收到但尚未开始执行的请求数
        bundleReady: false,
        outbox: [], // 待补发消息（WS 断线期间完成的请求结果，重连注册成功后按序补发）
        autoActivationStarted: false,
        autoPushTimer: null,
        autoPushBusy: false,
        autoPushNextAt: Number(GM_getValue(AUTO_PUSH_NEXT_KEY, 0)) || 0,
        autoPushLastAt: Number(GM_getValue(AUTO_PUSH_LAST_KEY, 0)) || 0,
        pushBusy: false,
        lastPingAt: 0,
        lastPongAt: 0,
        pingCount: 0,
        pongCount: 0,
    };

    // 单条补发消息最长保留时间（超时丢弃，避免无限堆积）
    const OUTBOX_MAX_AGE_MS = 10 * 60 * 1000;
    // 补发消息条数上限（超出后丢最旧）
    const OUTBOX_MAX_ITEMS = 200;

    // 更新检查结果：null=未检查，"checking"=检查中，"latest"=已是最新，"X.Y.Z"=远端新版本号
    let updateInfo = null;

    function waaCapturedHeaders() {
        return W.__pgWaaHeaders || null;
    }

    // ==================== 请求头：合并 + 持久化 ====================
    // WAA service 是页面活对象，无法序列化，刷新后必须靠页面再发一次请求；
    // 但请求头（x-goog-api-key 等）是纯字符串，可以持久化并在刷新后恢复。

    function persistWaa() {
        const h = waaCapturedHeaders();
        if (!h || !h["x-goog-api-key"]) return; // 没有关键头不落盘，避免覆盖好记录
        try {
            const ts = Date.now();
            GM_setValue(
                WAA_STORE_KEY,
                JSON.stringify({
                    ts,
                    headers: h,
                    snapshotKey: state.waaSnapshotKey,
                })
            );
            state.waaPersistedTs = ts;
        } catch (_) {}
    }

    function loadPersistedWaa() {
        try {
            const s = JSON.parse(GM_getValue(WAA_STORE_KEY, "null"));
            if (s && s.headers && Date.now() - s.ts < WAA_PERSIST_TTL) return s;
        } catch (_) {}
        return null;
    }

    // 合并写入：新头覆盖同名旧头，但不会丢掉已有的键（尤其 x-goog-api-key）
    function setCapturedHeaders(h) {
        if (!h || !Object.keys(h).length) return;
        W.__pgWaaHeaders = { ...(W.__pgWaaHeaders || {}), ...h };
        persistWaa();
    }

    // 取可用请求头：内存优先；内存里没有关键头时回退持久化记录
    function getHeaders() {
        const live = waaCapturedHeaders();
        if (live && live["x-goog-api-key"]) return live;
        const p = loadPersistedWaa();
        if (p) {
            W.__pgWaaHeaders = { ...p.headers, ...(live || {}) };
            return W.__pgWaaHeaders;
        }
        return live;
    }

    // ==================== UI 面板（Shadow DOM，样式与页面隔离） ====================
    // 设计目标：新手一眼看懂"现在该做什么"——顶部状态横幅 + 3 步清单，
    // 大按钮、大字号（手机友好），Key 在面板内输入（不弹 prompt），日志可复制。

    const PANEL_COLLAPSED_KEY = "pg_panel_collapsed";
    const PANEL_MARGIN = 8;
    const STEP_TITLES = ["设置 API Key", "发送 hi 激活页面", "连接服务器"];
    const STEP_HINTS = [
        "点下方「🔑 设置 Key」，粘贴 cat- 开头的密钥",
        cfg.autoActivateHi ? "页面加载后会尝试自动发送 hi；若失败请手动发送" : "在 AI Studio 页面底部的聊天框里发送 hi",
        "前两步完成后会自动连接",
    ];

    let panelEl = null; // Shadow DOM 宿主（fixed 定位，可拖动）
    const ui = {};
    let panelCollapsed = false;
    let keyEditorOpen = false;
    let logOpen = false;
    const notice = { text: "", level: "info", ts: 0 };

    const PANEL_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.wrap {
  --bg: #15171c; --card: #1e2128; --line: #323744; --fg: #f1f3f7; --muted: #9ba1b0;
  --accent: #6b8bff; --ok: #34d399; --warn: #fbbf24; --err: #f87171;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fg);
  -webkit-text-size-adjust: 100%;
}
@media (prefers-color-scheme: light) {
  .wrap {
    --bg: #ffffff; --card: #f3f4f8; --line: #d9dce5; --fg: #161922; --muted: #5d6475;
    --accent: #3b5bdb; --ok: #0f9f6e; --warn: #b7791f; --err: #d92d3a;
  }
}
.card {
  width: min(340px, calc(100vw - 16px));
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: 0 10px 36px rgba(0, 0, 0, .38);
  overflow: hidden;
}
.head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--line);
  cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none;
}
.title { flex: 1; font-weight: 700; font-size: 15px; }
.chip { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.iconbtn {
  flex: none; width: 34px; height: 34px; border: 0; border-radius: 10px;
  background: transparent; color: var(--muted); font-size: 18px; line-height: 1; cursor: pointer;
}
.iconbtn:hover { background: var(--card); color: var(--fg); }
.body {
  padding: 12px 14px 14px;
  display: flex; flex-direction: column; gap: 12px;
  max-height: min(72vh, 600px); overflow-y: auto; overscroll-behavior: contain;
}
.banner {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 12px; border-radius: 14px;
  border: 1px solid var(--line); background: var(--card);
}
.banner.ok { border-color: var(--ok); background: rgba(52, 211, 153, .12); }
.banner.warn { border-color: var(--warn); background: rgba(251, 191, 36, .12); }
.banner.info { border-color: var(--accent); background: rgba(107, 139, 255, .12); }
.bicon {
  flex: none; width: 30px; height: 30px; border-radius: 50%;
  display: grid; place-items: center;
  font-weight: 800; font-size: 15px; color: #0b0d12; background: var(--muted);
}
.banner.ok .bicon { background: var(--ok); }
.banner.warn .bicon { background: var(--warn); }
.banner.info .bicon { background: var(--accent); color: #fff; }
.btitle { font-weight: 700; font-size: 15px; line-height: 1.35; }
.bsub { color: var(--muted); font-size: 13px; margin-top: 2px; }
.steps { display: flex; flex-direction: column; gap: 6px; }
.step { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; background: var(--card); border: 1px solid transparent; }
.step.cur { border-color: var(--accent); }
.num {
  flex: none; width: 24px; height: 24px; border-radius: 50%;
  display: grid; place-items: center;
  font-size: 12px; font-weight: 800; background: var(--line); color: var(--muted);
}
.step.done .num { background: var(--ok); color: #06281c; }
.step.cur .num { background: var(--accent); color: #fff; }
.txt { flex: 1; min-width: 0; font-weight: 600; }
.sub { font-size: 12px; font-weight: 400; color: var(--muted); word-break: break-word; }
.notice {
  display: none; gap: 6px; align-items: flex-start;
  padding: 8px 6px 8px 12px; border-radius: 12px; font-size: 13px;
  border: 1px solid var(--line); background: var(--card);
}
.notice.ok { border-color: var(--ok); }
.notice.err { border-color: var(--err); background: rgba(248, 113, 113, .1); }
.notice.warn { border-color: var(--warn); }
.updatebox {
  display: none; align-items: center; gap: 8px;
  padding: 8px 8px 8px 12px; border-radius: 12px;
  border: 1px solid var(--warn); background: rgba(251, 191, 36, .12);
  font-size: 13px;
}
.utext { flex: 1; min-width: 0; }
.ntext { flex: 1; min-width: 0; padding-top: 5px; white-space: pre-wrap; word-break: break-word; max-height: 150px; overflow-y: auto; }
.keybox {
  display: none; flex-direction: column; gap: 8px;
  padding: 12px; border-radius: 14px; background: var(--card); border: 1px solid var(--accent);
}
.klabel { font-size: 13px; color: var(--muted); }
.keyrow { display: flex; gap: 8px; }
.input {
  flex: 1; min-width: 0; height: 42px; padding: 0 12px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  font: inherit; font-size: 16px;
}
.input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.btn {
  min-height: 42px; padding: 0 14px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--card); color: var(--fg);
  font: inherit; font-weight: 600; cursor: pointer;
}
.btn:hover { border-color: var(--muted); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.big { width: 100%; min-height: 48px; font-size: 15px; }
.btn.sm { min-height: 34px; padding: 0 12px; font-size: 13px; border-radius: 10px; }
.btn.ghost { background: transparent; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.hint { font-size: 12px; color: var(--muted); margin-top: -6px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.switch {
  display: flex; align-items: center; gap: 12px; width: 100%; min-height: 50px;
  padding: 8px 12px; border-radius: 12px; border: 1px solid var(--line);
  background: var(--card); color: var(--fg); font: inherit; text-align: left; cursor: pointer;
}
.sw-text { flex: 1; min-width: 0; }
.sw-title { font-weight: 600; }
.sw-sub { font-size: 12px; color: var(--muted); }
.track { flex: none; width: 44px; height: 26px; border-radius: 999px; background: var(--line); position: relative; transition: background .15s; }
.track::after {
  content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px;
  border-radius: 50%; background: #fff; transition: transform .15s;
}
.switch[aria-checked="true"] .track { background: var(--ok); }
.switch[aria-checked="true"] .track::after { transform: translateX(18px); }
.stats { font-size: 12px; color: var(--muted); text-align: center; }
.kagroup { display: flex; flex-direction: column; gap: 8px; }
.kagroup .hint { margin-top: 0; }
.logwrap { display: flex; flex-direction: column; gap: 8px; }
.logbox { display: none; flex-direction: column; gap: 8px; }
.logbar { display: flex; gap: 8px; }
.loglist {
  max-height: 210px; overflow-y: auto; padding: 8px; border-radius: 10px;
  background: var(--card); border: 1px solid var(--line);
  font: 12px/1.55 ui-monospace, Menlo, Consolas, monospace; word-break: break-all;
}
.ll.err { color: var(--err); }
.ll.ok { color: var(--ok); }
.ll.warn { color: var(--warn); }
.pill {
  display: none; align-items: center; gap: 8px;
  padding: 10px 16px; border-radius: 999px;
  background: var(--bg); border: 1px solid var(--line);
  box-shadow: 0 6px 22px rgba(0, 0, 0, .35);
  font-weight: 700; cursor: pointer;
  user-select: none; -webkit-user-select: none; touch-action: none;
}
.pdot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
.pdot.ok { background: var(--ok); }
.pdot.warn { background: var(--warn); }
.pdot.info { background: var(--accent); }
`;

    // 轻量建元素工具：h("div", {class, text, onclick, ...属性}, ...子节点)
    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (k === "class") el.className = v;
                else if (k === "text") el.textContent = v;
                else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
                else el.setAttribute(k, v);
            }
        }
        for (const kid of kids.flat()) {
            if (kid == null || kid === false) continue;
            el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
        }
        return el;
    }

    function fmtTime(ts) {
        try {
            return new Date(ts).toLocaleTimeString();
        } catch {
            return "?";
        }
    }

    // 把关键日志提炼成面板里的"最近提示"（新手不用翻日志）。
    // ✅ 成功 / ❌ ✖ 失败 / ⚠ ⏭ 警告；缩进行（排查步骤）并入上一条提示。
    function captureNotice(msg) {
        const now = Date.now();
        if (/^\s{2,}/.test(msg)) {
            if (notice.text && now - notice.ts < 2500) {
                notice.text = (notice.text + "\n" + msg.trim()).slice(0, 700);
                notice.ts = now;
            }
            return;
        }
        const m = msg.match(/^(✅|❌|✖|⚠|⏭)\s*/);
        if (!m) return;
        const sym = m[1];
        notice.level = sym === "✅" ? "ok" : sym === "❌" || sym === "✖" ? "err" : "warn";
        notice.text = msg.slice(m[0].length).slice(0, 300);
        notice.ts = now;
    }

    function saveKey(raw) {
        const key = String(raw || "").trim();
        const changed = key !== cfg.apiKey;
        cfg.apiKey = key;
        saveCfg();
        if (!key) log("⚠ API Key 已清空");
        else if (!key.startsWith("cat-")) log("⚠ Key 通常以 cat- 开头，请确认没有粘贴错");
        else log("✅ API Key 已保存");
        keyEditorOpen = false;
        if (changed && state.ws) disconnectWs("Key 已更改，重新连接");
        updatePanel();
        scheduleConnect(0);
        if (cfg.autoCookiePush && state.waaReady) scheduleAutoCookiePush(2000);
        if (key && !state.waaReady) autoActivateWithHi().catch(() => {});
    }

    function openKeyEditor() {
        if (!panelEl) {
            // 面板还没建好（页面加载中）：退回系统弹窗
            const key = prompt("Catiecli API Key (cat- 前缀):", cfg.apiKey);
            if (key !== null) saveKey(key);
            return;
        }
        if (panelEl.style.display === "none") panelEl.style.display = "block";
        if (panelCollapsed) setCollapsed(false);
        keyEditorOpen = true;
        ui.keyInput.value = cfg.apiKey || "";
        updatePanel();
        setTimeout(() => {
            try { ui.keyInput.focus(); } catch (_) {}
        }, 60);
    }

    function copyLogs() {
        const text = logs.join("\n");
        const ok = () => log("✅ 日志已复制到剪贴板");
        const fallback = () => {
            try {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.cssText = "position:fixed;left:0;top:0;opacity:0;";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                ta.remove();
                ok();
            } catch (_) {
                log("⚠ 复制失败，请长按日志文字手动选择复制");
            }
        };
        try {
            navigator.clipboard.writeText(text).then(ok, fallback);
        } catch (_) {
            fallback();
        }
    }

    function setCollapsed(v) {
        panelCollapsed = !!v;
        try { GM_setValue(PANEL_COLLAPSED_KEY, panelCollapsed); } catch (_) {}
        ui.card.style.display = panelCollapsed ? "none" : "block";
        ui.pill.style.display = panelCollapsed ? "flex" : "none";
        requestAnimationFrame(() => {
            if (!panelEl) return;
            const r = panelEl.getBoundingClientRect();
            applyPanelPos(r.left, r.top);
        });
    }

    function buildPanel() {
        if (HOST) return;
        panelCollapsed = GM_getValue(PANEL_COLLAPSED_KEY, false) === true;

        panelEl = document.createElement("div");
        panelEl.style.cssText =
            "position:fixed;left:0;top:0;z-index:2147483647;display:block;";
        const root = panelEl.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = PANEL_CSS;
        root.appendChild(style);
        const wrap = h("div", { class: "wrap" });
        root.appendChild(wrap);

        // ---- 收起态：小圆标（点一下展开，可拖动）----
        ui.pillDot = h("span", { class: "pdot" });
        ui.pillText = h("span", { text: "Catiecli" });
        ui.pill = h("div", { class: "pill", title: "点击展开（可拖动）" }, "🐱", ui.pillDot, ui.pillText);

        // ---- 标题栏 ----
        ui.collapseBtn = h("button", {
            class: "iconbtn", title: "收起", "aria-label": "收起", text: "—",
            onclick: () => setCollapsed(true),
        });
        ui.head = h(
            "div", { class: "head" },
            h("span", { class: "title", text: "🐱 Catiecli 执行器" }),
            h("span", { class: "chip", text: "v" + CLIENT_VERSION }),
            ui.collapseBtn
        );

        // ---- 状态横幅 + 三步清单 ----
        ui.bIcon = h("div", { class: "bicon" });
        ui.bTitle = h("div", { class: "btitle" });
        ui.bSub = h("div", { class: "bsub" });
        ui.banner = h("div", { class: "banner" }, ui.bIcon, h("div", null, ui.bTitle, ui.bSub));

        // ---- 更新提示条（有新版本时显示） ----
        ui.updateBtn = h("button", {
            class: "btn sm primary", text: "⬇ 更新",
            onclick: () => openUpdatePage(),
        });
        ui.updateBox = h(
            "div", { class: "updatebox" },
            h("div", { class: "utext" }, "🔔 有新版本 ", ui.updateVersion = h("b", null), "，建议更新"),
            ui.updateBtn
        );
        ui.updateVersion.textContent = "";

        ui.steps = STEP_TITLES.map((t, i) => {
            const num = h("div", { class: "num", text: String(i + 1) });
            const sub = h("div", { class: "sub" });
            const row = h("div", { class: "step" }, num, h("div", { class: "txt" }, h("div", { text: t }), sub));
            return { row, num, sub };
        });
        ui.stepsBox = h("div", { class: "steps" }, ui.steps.map((s) => s.row));

        // ---- 最近提示 ----
        ui.noticeText = h("div", { class: "ntext" });
        ui.notice = h(
            "div", { class: "notice" },
            ui.noticeText,
            h("button", {
                class: "iconbtn", "aria-label": "关闭提示", text: "×",
                onclick: () => { notice.text = ""; updatePanel(); },
            })
        );

        // ---- Key 输入（面板内，不弹系统框）----
        ui.keyInput = h("input", {
            class: "input", type: "password", placeholder: "cat-example-your-key",
            autocomplete: "off", spellcheck: "false", autocapitalize: "off",
        });
        ui.keyInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") saveKey(ui.keyInput.value);
        });
        const eye = h("button", {
            class: "btn sm", text: "显示",
            onclick: () => {
                const show = ui.keyInput.type === "password";
                ui.keyInput.type = show ? "text" : "password";
                eye.textContent = show ? "隐藏" : "显示";
            },
        });
        ui.keyBox = h(
            "div", { class: "keybox" },
            h("div", { class: "klabel", text: "粘贴你的 API Key（cat- 开头）" }),
            h("div", { class: "keyrow" }, ui.keyInput, eye),
            h(
                "div", { class: "keyrow" },
                h("button", { class: "btn primary", style: "flex:1", text: "保存", onclick: () => saveKey(ui.keyInput.value) }),
                h("button", { class: "btn", text: "取消", onclick: () => { keyEditorOpen = false; updatePanel(); } })
            )
        );

        // ---- 操作区 ----
        ui.pushBtn = h("button", {
            class: "btn primary big", text: "☁ 推送 Cookie 到云端",
            onclick: () => {
                pushCookiesToCloud().catch((e) => log("推送异常: " + ((e && e.message) || e)));
            },
        });
        ui.pushHint = h("div", { class: "hint" });
        ui.keyBtn = h("button", { class: "btn", text: "🔑 设置 Key", onclick: openKeyEditor });
        ui.reconnectBtn = h("button", {
            class: "btn", text: "🔄 重连",
            onclick: () => { disconnectWs("手动重连"); scheduleConnect(0); },
        });
        const makeSwitch = (title, sub, onclick) =>
            h(
                "button", { class: "switch", role: "switch", "aria-checked": "false", onclick },
                h(
                    "div", { class: "sw-text" },
                    h("div", { class: "sw-title", text: title }),
                    h("div", { class: "sw-sub", text: sub })
                ),
                h("div", { class: "track" })
            );
        ui.hiBtn = makeSwitch("💬 自动发送 hi 激活", "页面加载后尝试激活 WAA；失败时会提示手动发送", () => toggleAutoActivateHi());
        ui.cloudPushBtn = makeSwitch("⏱ 定时更新并推送 Cookie", "约每 45 分钟重推一次；仅在此页面保持打开时运行", () => toggleAutoCookiePush());
        ui.scheduleStatus = h("div", { class: "hint", text: "关闭状态：不会自动向云端发送 Google 登录 Cookie。" });
        ui.autoGroup = h(
            "div", { class: "kagroup" },
            h("div", { class: "klabel", text: "自动初始化与凭证续期" }),
            ui.hiBtn,
            ui.cloudPushBtn,
            ui.scheduleStatus,
            h("div", { class: "hint warn", text: "启用续推后会周期性把 Google 登录 Cookie（包括 HttpOnly）发送给 catiecli 云端。仅在信任该服务时启用。关闭浏览器期间不会续推。" })
        );
        ui.pipBtn = makeSwitch("🪟 小窗保活", "弹出画中画小窗，浏览器会把本页当作前台", () => togglePip());
        ui.audioBtn = makeSwitch("🔊 后台音频保活", "持续静音播放，浏览器不会冻结本标签页", () => toggleAudio());
        ui.kaGroup = h(
            "div", { class: "kagroup" },
            h("div", { class: "klabel", text: "防止被浏览器冻结（可单独开关，也可同时开启）" }),
            ui.pipBtn,
            ui.audioBtn,
            h("div", { class: "hint", text: "手机浏览器不支持小窗时，请用后台音频。" })
        );
        ui.stats = h("div", { class: "stats" });

        // ---- 日志（默认折叠，可复制）----
        ui.logToggle = h("button", {
            class: "btn ghost sm", text: "▸ 查看日志",
            onclick: () => { logOpen = !logOpen; updatePanel(); },
        });
        ui.logList = h("div", { class: "loglist" });
        ui.logBox = h(
            "div", { class: "logbox" },
            h(
                "div", { class: "logbar" },
                h("button", { class: "btn sm", text: "复制日志", onclick: copyLogs }),
                h("button", { class: "btn sm", text: "清空", onclick: () => { logs.length = 0; updatePanel(); } })
            ),
            ui.logList
        );

        ui.body = h(
            "div", { class: "body" },
            ui.banner, ui.updateBox, ui.stepsBox, ui.notice, ui.keyBox,
            ui.pushBtn, ui.pushHint,
            ui.autoGroup,
            h("div", { class: "grid" }, ui.keyBtn, ui.reconnectBtn),
            ui.kaGroup, ui.stats,
            h("div", { class: "logwrap" }, ui.logToggle, ui.logBox)
        );
        ui.card = h("div", { class: "card" }, ui.head, ui.body);

        wrap.appendChild(ui.pill);
        wrap.appendChild(ui.card);
        ui.card.style.display = panelCollapsed ? "none" : "block";
        ui.pill.style.display = panelCollapsed ? "flex" : "none";

        makeDraggable(ui.head);
        makeDraggable(ui.pill, () => setCollapsed(false));
        document.documentElement.appendChild(panelEl);
        restorePanelPos();
        installPanelGuards();
        updatePanel();
    }

    function updatePanel() {
        if (!panelEl || !ui.card) return;
        const hasKey = !!cfg.apiKey;
        const waaOk = state.bundleReady && state.waaReady;
        const wsOk = state.wsStatus === "connected";
        const connecting = state.wsStatus === "connecting";
        const done = [hasKey, waaOk, wsOk];
        const cur = done.indexOf(false); // -1 = 三步全部完成

        // 三步清单
        const masked = hasKey ? cfg.apiKey.slice(0, 8) + "…" + cfg.apiKey.slice(-4) : "";
        const subs = [
            hasKey ? "已设置：" + masked : STEP_HINTS[0],
            waaOk ? "已完成" : !state.bundleReady ? "等待 AI Studio 页面加载完成…" : cfg.autoActivateHi ? "自动尝试发送 hi；若页面拒绝，请手动发送" : STEP_HINTS[1],
            wsOk
                ? "已连接，随时可接收请求"
                : connecting
                ? "连接中…"
                : hasKey && waaOk
                ? "未连接，正在自动重连（也可点「🔄 重连」）"
                : STEP_HINTS[2],
        ];
        ui.steps.forEach((s, i) => {
            s.row.className = "step" + (done[i] ? " done" : i === cur ? " cur" : "");
            s.num.textContent = done[i] ? "✓" : String(i + 1);
            s.sub.textContent = subs[i];
        });

        // 状态横幅：永远只告诉用户"现在该做什么"
        let level, icon, title, sub;
        if (cur === -1) {
            level = "ok"; icon = "✓"; title = "一切就绪，可以使用";
            sub = "请保持本页打开（建议开启下方保活，减少掉线）";
        } else if (cur === 1 && !state.bundleReady) {
            level = "info"; icon = "…"; title = "正在等待页面加载…";
            sub = "请等 AI Studio 页面完全打开";
        } else if (cur === 2) {
            level = connecting ? "info" : "warn";
            icon = connecting ? "…" : "!";
            title = connecting ? "正在连接服务器…" : "尚未连接服务器";
            sub = connecting ? "" : "正在自动重连，也可点下方「🔄 重连」";
        } else {
            level = "warn"; icon = String(cur + 1);
            title = "下一步：" + STEP_TITLES[cur];
            sub = STEP_HINTS[cur];
        }
        ui.banner.className = "banner " + level;
        ui.bIcon.textContent = icon;
        ui.bTitle.textContent = title;
        ui.bSub.textContent = sub;
        ui.bSub.style.display = sub ? "block" : "none";

        // 更新提示条
        const hasUpdate = !!updateInfo && updateInfo !== "checking" && updateInfo !== "latest";
        ui.updateBox.style.display = hasUpdate ? "flex" : "none";
        if (hasUpdate) ui.updateVersion.textContent = "v" + updateInfo;

        // 收起态小圆标
        ui.pillDot.className = "pdot " + level;
        ui.pillText.textContent = level === "ok" ? "已就绪" : level === "info" ? "连接中" : "需要操作";

        // 最近提示
        if (notice.text) {
            ui.notice.style.display = "flex";
            ui.notice.className = "notice " + notice.level;
            ui.noticeText.textContent = notice.text;
        } else {
            ui.notice.style.display = "none";
        }

        // Key 编辑区 / 按钮
        ui.keyBox.style.display = keyEditorOpen ? "flex" : "none";
        ui.keyBtn.textContent = hasKey ? "🔑 修改 Key" : "🔑 设置 Key";
        ui.keyBtn.className = "btn" + (cur === 0 && !keyEditorOpen ? " primary" : "");

        // 推送：必须本页完成"发一条消息"引导后才可用
        ui.pushBtn.disabled = !waaOk;
        ui.pushBtn.title = waaOk ? "导出当前会话 Cookie 推送到云端" : "请先在页面发送一条消息";
        ui.pushHint.textContent = waaOk
            ? "推送后无需挂机：云端用你的 Cookie 无头执行 pggo- 模型（多账号可各推一份）"
            : "需要先完成第 2 步（在页面发一条消息）才能推送";

        ui.hiBtn.setAttribute("aria-checked", cfg.autoActivateHi ? "true" : "false");
        ui.cloudPushBtn.setAttribute("aria-checked", cfg.autoCookiePush ? "true" : "false");
        if (cfg.autoCookiePush) {
            const next = state.autoPushNextAt > Date.now()
                ? `下次续推约 ${Math.max(1, Math.ceil((state.autoPushNextAt - Date.now()) / 60000))} 分钟后`
                : state.autoPushBusy ? "正在更新当前账号的云端 Cookie…" : "已开启，等待 WAA 与 API Key 就绪后开始";
            ui.scheduleStatus.textContent = state.autoPushLastAt
                ? `上次成功 ${new Date(state.autoPushLastAt).toLocaleTimeString("zh-CN")} · ${next}`
                : next;
        } else {
            ui.scheduleStatus.textContent = "关闭状态：不会自动向云端发送 Google 登录 Cookie。";
        }

        // 保活开关
        ui.pipBtn.setAttribute("aria-checked", keepalive.pip ? "true" : "false");
        ui.audioBtn.setAttribute("aria-checked", keepalive.audio ? "true" : "false");

        ui.stats.textContent = `已处理 ${state.requestCount} 个请求 · 排队等待 ${state.queueDepth} 个`;

        // 日志
        ui.logToggle.textContent = logOpen ? "▾ 收起日志" : "▸ 查看日志";
        ui.logBox.style.display = logOpen ? "flex" : "none";
        if (logOpen) {
            const frag = document.createDocumentFragment();
            for (const line of logs) {
                const cls = /❌|✖|失败|异常/.test(line)
                    ? "err"
                    : /✅|✔/.test(line)
                    ? "ok"
                    : /⚠|⏭|⊘/.test(line)
                    ? "warn"
                    : "";
                frag.appendChild(h("div", { class: "ll " + cls, text: line }));
            }
            ui.logList.replaceChildren(frag);
            ui.logList.scrollTop = ui.logList.scrollHeight;
        }
    }

    // ==================== 面板位置 / 拖动 ====================

    function clampPanelPos(x, y) {
        const w = panelEl.offsetWidth;
        const hgt = panelEl.offsetHeight;
        const vw = W.innerWidth;
        const vh = W.innerHeight;
        const maxX = Math.max(PANEL_MARGIN, vw - w - PANEL_MARGIN);
        const maxY = Math.max(PANEL_MARGIN, vh - hgt - PANEL_MARGIN);
        return {
            x: Math.min(Math.max(x, PANEL_MARGIN), maxX),
            y: Math.min(Math.max(y, PANEL_MARGIN), maxY),
        };
    }

    function applyPanelPos(x, y) {
        const pos = clampPanelPos(x, y);
        panelEl.style.left = pos.x + "px";
        panelEl.style.top = pos.y + "px";
        return pos;
    }

    function restorePanelPos() {
        let saved = null;
        try {
            saved = JSON.parse(GM_getValue(PANEL_POS_KEY, "null"));
        } catch {
            saved = null;
        }
        if (
            saved &&
            typeof saved.x === "number" &&
            typeof saved.y === "number" &&
            isFinite(saved.x) &&
            isFinite(saved.y)
        ) {
            const pos = applyPanelPos(saved.x, saved.y);
            GM_setValue(PANEL_POS_KEY, JSON.stringify(pos));
        } else {
            // 默认：右下角
            applyPanelPos(
                W.innerWidth - panelEl.offsetWidth - 12,
                W.innerHeight - panelEl.offsetHeight - 12
            );
        }
    }

    // 拖动手柄（标题栏 / 收起态圆标）。onTap：没有发生位移的轻点（圆标用来展开）。
    function makeDraggable(handle, onTap) {
        let dragging = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let origLeft = 0;
        let origTop = 0;

        handle.addEventListener("pointerdown", (ev) => {
            if (ev.pointerType === "mouse" && ev.button !== 0) return;
            if (ev.target && ev.target.closest && ev.target.closest("button, input")) return;
            dragging = true;
            moved = false;
            startX = ev.clientX;
            startY = ev.clientY;
            const rect = panelEl.getBoundingClientRect();
            origLeft = rect.left;
            origTop = rect.top;
            try { handle.setPointerCapture(ev.pointerId); } catch (_) {}
            handle.style.cursor = "grabbing";
        });

        handle.addEventListener("pointermove", (ev) => {
            if (!dragging) return;
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            moved = true;
            applyPanelPos(origLeft + dx, origTop + dy);
        });

        const endDrag = (ev, cancelled) => {
            if (!dragging) return;
            dragging = false;
            handle.style.cursor = "";
            try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
            if (moved) {
                const rect = panelEl.getBoundingClientRect();
                const pos = applyPanelPos(rect.left, rect.top);
                GM_setValue(PANEL_POS_KEY, JSON.stringify(pos));
            } else if (!cancelled && onTap) {
                onTap();
            }
        };
        handle.addEventListener("pointerup", (ev) => endDrag(ev, false));
        handle.addEventListener("pointercancel", (ev) => endDrag(ev, true));
    }

    // 窗口缩放 / 内容高度变化（展开日志、提示变长）时，保证面板不跑出可视区
    function installPanelGuards() {
        const reclamp = () => {
            if (!panelEl || panelEl.style.display === "none") return;
            const r = panelEl.getBoundingClientRect();
            applyPanelPos(r.left, r.top);
        };
        W.addEventListener("resize", reclamp);
        try {
            new ResizeObserver(reclamp).observe(panelEl);
        } catch (_) {}
    }

    // ==================== WAA 层：hook 页面 ====================

    // wrap MakerSuite 的 snapshot 函数，捕获 WAA service 引用
    // （动态定位：按函数源码特征匹配，避免硬编码混淆后的 key）
    function installSnapshotHook() {
        const makerSuite = W.default_MakerSuite;
        if (!makerSuite) return "no_default_MakerSuite";
        const currentKey = W.__pgWaaSnapshotKey;
        if (currentKey && makerSuite[currentKey]?.__pgWrapped) {
            state.waaSnapshotKey = currentKey;
            return currentKey;
        }
        let snapshotKey = null;
        for (const key of Object.keys(makerSuite)) {
            try {
                if (typeof makerSuite[key] !== "function") continue;
                const source = makerSuite[key].toString();
                if (
                    source.includes(".snapshot({") &&
                    source.includes("content") &&
                    source.includes("yield")
                ) {
                    snapshotKey = key;
                    break;
                }
            } catch (_) {}
        }
        if (!snapshotKey) return "no_snapshot_fn";
        const original = makerSuite[snapshotKey];
        const wrapped = function (...args) {
            const service = args[0];
            if (
                service &&
                (typeof service === "object" || typeof service === "function")
            ) {
                W.__pgWaaService = service;
                persistWaa(); // 页面每次发消息都刷新持久记录
                if (!state.waaReady) {
                    state.waaReady = true;
                    log("WAA service 已捕获，引导完成");
                    updatePanel(); // 按钮亮起与说明切换由 updatePanel 统一处理
                    scheduleConnect(0);
                    if (cfg.autoCookiePush) scheduleAutoCookiePush(state.autoPushNextAt > Date.now() ? undefined : 3000);
                }
            }
            return original.apply(this, args);
        };
        wrapped.__pgWrapped = true;
        makerSuite[snapshotKey] = wrapped;
        W.__pgWaaSnapshotKey = snapshotKey;
        state.waaSnapshotKey = snapshotKey;
        return snapshotKey;
    }

    // 记录页面自身 GenerateContent 请求的 headers（合并 + 持久化）。
    // 页面上下文 fetch 自动带 cookie，脚本请求复用捕获的显式头。
    // 保存原生 fetch 到 W.__pgOrigFetch：脚本自己发请求走它，不触发捕获。
    function installFetchCapture() {
        const originalFetch = W.fetch;
        if (typeof originalFetch !== "function") return;
        if (originalFetch.__pgWrapped) return; // 已安装
        W.__pgOrigFetch = originalFetch;
        const matches = (input) => {
            const raw =
                typeof input === "string"
                    ? input
                    : input && input.url;
            if (!raw) return false;
            try {
                return new URL(raw, W.location.href).pathname === GENERATE_PATH;
            } catch {
                return false;
            }
        };
        const recordHeaders = (h) => {
            const captured = {};
            if (!h) return;
            try {
                if (typeof h.forEach === "function") {
                    h.forEach((v, k) => (captured[String(k).toLowerCase()] = String(v)));
                } else if (Array.isArray(h)) {
                    for (const [k, v] of h) captured[String(k).toLowerCase()] = String(v);
                } else if (typeof h === "object") {
                    for (const [k, v] of Object.entries(h))
                        captured[String(k).toLowerCase()] = String(v);
                }
            } catch (_) {}
            if (!Object.keys(captured).length) return;
            setCapturedHeaders(captured);
            log(
                "已捕获页面请求头 (" + Object.keys(captured).length + " 项" +
                    (captured["x-goog-api-key"] ? ", 含 api-key" : ", 无 api-key") + ")"
            );
        };
        const fetchWrapper = function (input, init) {
            try {
                if (matches(input)) {
                    recordHeaders(init && init.headers);
                    if (!init && input instanceof W.Request) {
                        recordHeaders(input.headers);
                    }
                }
            } catch (_) {}
            return originalFetch.apply(this, arguments);
        };
        fetchWrapper.__pgWrapped = true;
        W.fetch = fetchWrapper;
    }

    // grpc-web 页面可能走 XHR：wrap open/setRequestHeader/send 记录 headers
    function installXhrCapture() {
        const proto = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
        if (!proto) return;
        if (proto.__pgXhrWrapped) return; // 已安装
        proto.__pgXhrWrapped = true;
        const origOpen = proto.open;
        const origSetRH = proto.setRequestHeader;
        const origSend = proto.send;
        const urls = new WeakMap();
        const headerMap = new WeakMap();
        proto.open = function (method, url, ...rest) {
            urls.set(this, String(url));
            return origOpen.call(this, method, url, ...rest);
        };
        proto.setRequestHeader = function (k, v) {
            const h = headerMap.get(this) || {};
            h[String(k).toLowerCase()] = String(v);
            headerMap.set(this, h);
            return origSetRH.call(this, k, v);
        };
        proto.send = function (body) {
            const url = urls.get(this);
            if (url) {
                try {
                    if (new URL(url, W.location.href).pathname === GENERATE_PATH) {
                        const h = headerMap.get(this) || {};
                        if (Object.keys(h).length) {
                            setCapturedHeaders(h);
                            log(
                                "已捕获页面 XHR 请求头" +
                                    (h["x-goog-api-key"] ? "（含 api-key）" : "（无 api-key）")
                            );
                        }
                    }
                } catch (_) {}
            }
            return origSend.call(this, body);
        };
    }

    // 把 prompt 写入页面输入框并触发页面表单状态同步
    function fillPrompt(prompt) {
        const visible = (el) => el.checkVisibility({ visibilityProperty: true });
        const items = [...document.querySelectorAll("ms-prompt-box textarea")].filter(visible);
        if (items.length > 1) throw new Error("提示词输入框匹配多个可见目标");
        const textarea = items[0];
        if (!textarea) throw new Error("未找到可见的提示词输入框（ms-prompt-box textarea）");
        const setter = Object.getOwnPropertyDescriptor(
            W.HTMLTextAreaElement.prototype,
            "value"
        ).set;
        setter.call(textarea, prompt);
        textarea.dispatchEvent(
            new W.InputEvent("input", {
                bubbles: true,
                inputType: "insertText",
                data: prompt,
            })
        );
        textarea.dispatchEvent(new W.Event("change", { bubbles: true }));
        return textarea.value;
    }

    // 焦点扰动：模拟真实用户交互，推动 Angular zone 刷新受控状态。
    // 长时间后台运行后 Angular 的合成事件不再触发变更检测，
    // 页面呈现"卡住"——用户手动点输入框/发送才恢复。这里主动复现该交互。
    function nudgeFocus(textarea) {
        try {
            textarea.focus();
            textarea.dispatchEvent(new W.Event("focusin", { bubbles: true }));
            textarea.blur();
            textarea.dispatchEvent(new W.Event("focusout", { bubbles: true }));
        } catch (_) {}
    }

    async function syncPrompt(prompt) {
        const deadline = Date.now() + 8000;
        let nudgeCountdown = 0;
        for (;;) {
            const value = fillPrompt(prompt);
            if (normalizeNewlines(value) === normalizeNewlines(prompt)) {
                // 同步成功后做一次焦点扰动，确保后续 snapshot 请求能被
                // 页面事件循环正常处理（防"卡住直到用户手动点发送"）
                if (prompt) {
                    const visible = (el) => el.checkVisibility({ visibilityProperty: true });
                    const textarea = [...document.querySelectorAll("ms-prompt-box textarea")].filter(visible)[0];
                    if (textarea) nudgeFocus(textarea);
                }
                return;
            }
            // 每两次重试做一次焦点扰动，逐步加大力度
            if (++nudgeCountdown % 2 === 0) {
                const visible = (el) => el.checkVisibility({ visibilityProperty: true });
                const textarea = [...document.querySelectorAll("ms-prompt-box textarea")].filter(visible)[0];
                if (textarea) nudgeFocus(textarea);
            }
            if (Date.now() > deadline) {
                throw mkError(503, "prompt_sync_failed", "页面提示词输入框状态未同步");
            }
            await sleep(150);
        }
    }

    function visibleElement(el) {
        try {
            return !!el && el.checkVisibility({ visibilityProperty: true });
        } catch (_) {
            return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        }
    }

    // Localized labels vary by account. Prefer the prompt's run component and
    // stable Material icon names; never search outside this prompt box.
    function findPromptSendButton(textarea) {
        const box = textarea && textarea.closest("ms-prompt-box");
        if (!box) return null;
        const candidates = [...box.querySelectorAll("button,[role=button]")].filter((el) =>
            visibleElement(el) && !el.disabled && !el.hasAttribute("disabled") &&
            el.getAttribute("aria-disabled") !== "true" && !el.closest("[inert]")
        );
        const scored = candidates.map((el) => {
            const text = [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("data-tooltip"), el.textContent]
                .filter(Boolean).join(" ").trim().toLowerCase();
            const icons = [...el.querySelectorAll("mat-icon,.material-icons,.material-symbols-outlined,.material-symbols-rounded,[data-mat-icon-name]")]
                .flatMap((icon) => [icon.getAttribute("data-mat-icon-name"), icon.textContent])
                .filter(Boolean).flatMap((value) => value.trim().toLowerCase().split(/\s+/));
            if (/stop|cancel|停止|取消|删除|clear|清空/.test(text) ||
                icons.some((icon) => /^(?:stop|stop_circle|cancel|close|delete|delete_forever|clear|pause|pause_circle)$/.test(icon))) {
                return { el, score: -100 };
            }
            let score = 0;
            if (el.closest("ms-run-button")) score += 100;
            if (icons.some((icon) => /^(?:keyboard_return|send|arrow_upward|play_arrow|play_circle|play_circle_filled)$/.test(icon))) score += 40;
            if (/send|submit|run|generate|发送|提交|运行|生成/.test(text)) score += 10;
            return { el, score };
        }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
        if (scored.length > 1 && scored[0].score === scored[1].score) return null;
        return scored[0]?.el || null;
    }

    async function autoActivateWithHi() {
        if (!cfg.autoActivateHi || state.waaReady || state.autoActivationStarted || !state.bundleReady || !cfg.apiKey) return;
        state.autoActivationStarted = true;
        log("💬 自动引导：等待 AI Studio 输入框，准备发送 hi…");
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            try {
                const textarea = [...document.querySelectorAll("ms-prompt-box textarea")].find(visibleElement);
                if (!textarea) {
                    await sleep(500);
                    continue;
                }
                if (textarea.value.trim() && textarea.value.trim() !== "hi") {
                    log("⚠ 输入框已有草稿，未覆盖，请手动发送以激活");
                    return;
                }
                fillPrompt("hi");
                nudgeFocus(textarea);
                await sleep(350);
                const sendButton = findPromptSendButton(textarea);
                if (sendButton) {
                    sendButton.click();
                    log("💬 已点击发送 hi，等待确认 WAA 就绪…");
                    return;
                }
                const form = textarea.closest("form");
                if (form && typeof form.requestSubmit === "function") {
                    form.requestSubmit();
                    log("💬 已提交 hi 表单，等待确认 WAA 就绪…");
                    return;
                }
            } catch (e) {
                log("⚠ 自动发送 hi 暂未完成：" + ((e && e.message) || e));
            }
            await sleep(800);
        }
        log("⚠ 未找到可用的发送按钮，请在页面聊天框手动发送 hi");
    }

    // 生成 fresh WAA proof（digest 为 sha256hex(binding)），带硬超时与重试
    async function takeProof(digest) {
        const makerSuite = W.default_MakerSuite;
        const service = W.__pgWaaService;
        const snapshotKey = W.__pgWaaSnapshotKey;
        if (
            !makerSuite ||
            !service ||
            !snapshotKey ||
            typeof makerSuite[snapshotKey] !== "function"
        ) {
            throw mkError(503, "waa_not_ready", "WAA service 未就绪，请先在页面发送一条消息");
        }
        // snapshot 可能因页面 zone 冻结而永不回调——用超时+重试兜底，
        // 重试前做焦点扰动唤醒页面事件循环
        const attempt = async (timeoutMs) => {
            return Promise.race([
                Promise.resolve(makerSuite[snapshotKey](service, digest)),
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error("proof_timeout")),
                        timeoutMs
                    )
                ),
            ]);
        };
        let proof;
        let lastErr = null;
        for (let round = 0; round < 3; round++) {
            try {
                proof = await attempt(round === 0 ? 20000 : 30000);
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                log(`proof 第 ${round + 1} 次尝试失败: ${e && e.message}`);
                // 页面 bundle 热更新会把 snapshot 函数换掉（旧 key 失效）——重扫 hook
                try {
                    const r = installSnapshotHook();
                    if (r === "no_snapshot_fn") log("⚠ 重扫：未找到 snapshot 函数（页面可能改版）");
                } catch (_) {}
                // 焦点扰动唤醒页面
                try {
                    const visible = (el) => el.checkVisibility({ visibilityProperty: true });
                    const textarea = [...document.querySelectorAll("ms-prompt-box textarea")].filter(visible)[0];
                    if (textarea) nudgeFocus(textarea);
                } catch (_) {}
                await sleep(300);
            }
        }
        if (lastErr) {
            throw mkError(504, "waa_proof_timeout", "WAA proof 生成超时（页面可能被浏览器冻结，请切回该标签页）");
        }
        if (typeof proof !== "string" || !proof.startsWith("!")) {
            throw mkError(502, "waa_proof_invalid", "fresh WAA proof 前缀无效: " + String(proof).slice(0, 40));
        }
        return proof;
    }

    function ensureWaaReady() {
        if (!state.waaReady) {
            throw mkError(503, "waa_not_ready", "WAA 未就绪：请在页面上手动发送一条消息完成引导");
        }
        const headers = getHeaders();
        if (!headers || !headers["x-goog-api-key"]) {
            log("请求头现有键: " + Object.keys(headers || {}).join(",") + "（无 x-goog-api-key）");
            throw mkError(503, "waa_headers_missing", "缺少页面请求头捕获（x-goog-api-key），请在页面上发送一条消息");
        }
    }

    // ==================== Cookie 推送（云端无头模式） ====================
    // GM_cookie 需要浏览器扩展页开启 Tampermonkey「开发者模式」才能使用。
    // 导出 aistudio.google.com + google.com 相关域 Cookie（含 HttpOnly），
    // POST 到后端 /api/pggo/push，后端转发 Go 微服务落盘，
    // 之后 pggo- 模型由云端无头执行。

    function gmCookieList(query) {
        return new Promise((resolve) => {
            try {
                GM_cookie.list(query, (cookies, error) => {
                    if (error) resolve({ cookies: null, error: String(error) });
                    else resolve({ cookies: cookies || [], error: null });
                });
            } catch (e) {
                resolve({ cookies: null, error: String(e) });
            }
        });
    }

    // 检测当前登录的 Google 账号邮箱（用于凭证命名）。
    // 依次尝试：One Bar 账号按钮 aria-label、页面内嵌的邮箱文本。
    function detectEmail() {
        // 1. One Bar 账号按钮：aria-label 形如 "Google Account: Alice
        //    (alice@example.com)" 或 "Google 帐号：…"
        try {
            const links = document.querySelectorAll(
                'a[href*="accounts.google.com"], a[href*="myaccount.google.com"]'
            );
            for (const link of links) {
                const label = link.getAttribute("aria-label") || "";
                const m = label.match(/[\w.+-]+@[\w.-]+\.\w+/);
                if (m) return m[0].toLowerCase();
            }
        } catch (_) {}
        // 2. img alt（账号头像）
        try {
            for (const img of document.querySelectorAll("img[alt]")) {
                const m = (img.getAttribute("alt") || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
                if (m) return m[0].toLowerCase();
            }
        } catch (_) {}
        // 3. 页面全文兜底（One Bar 展开后的菜单项）
        try {
            const m = (document.body.innerText || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
            if (m) return m[0].toLowerCase();
        } catch (_) {}
        return null;
    }

    // Google 系 Cookie 的过滤条件（丢弃误收集的其他域）
    function isGoogleDomain(domain) {
        const d = String(domain || "").replace(/^\./, "").toLowerCase();
        return d === "google.com" || d.endsWith(".google.com") ||
            d === "googlegroups.com" || d.endsWith(".googlegroups.com");
    }

    // 收集 Cookie。
    // GM_cookie.list({url: X}) 语义 = 浏览器对 X 实际将发送的完整 Cookie
    // （含 HttpOnly），与请求 Cookie 头完全一致（Cookie 是 forbidden header，
    // 脚本读不到请求头，url 查询与之等价）。按 GenerateContent 请求端点查询，
    // 即云端将发送的同一套 Cookie。核心件缺失时按 name 逐项补查。
    async function collectCookies() {
        const byKey = new Map();
        const addCookie = (c, source) => {
            if (!c || !c.name || !isGoogleDomain(c.domain)) return;
            const key = `${c.name}|${c.domain}|${c.path || "/"}`;
            if (!byKey.has(key)) byKey.set(key, { ...c, source });
        };
        const stats = { reqURL: null, pageURL: null, byName: 0 };

        // --- 策略 1：按请求端点 url 查询（= 浏览器发 GenerateContent 时带的 Cookie，
        //     含 HttpOnly，与请求 Cookie 头语义完全一致） ---
        try {
            const { cookies, error } = await gmCookieList({ url: GENERATE_URL });
            if (error) {
                stats.reqURL = `失败(${String(error).slice(0, 40)})`;
                log(`⚠ 请求端点 url 查询失败: ${String(error).slice(0, 80)}`);
            } else {
                stats.reqURL = cookies.length;
                cookies.forEach((c) => addCookie(c, "reqURL"));
            }
        } catch (_) {}

        // --- 策略 2：按 aistudio 页面 url 查询（补漏） ---
        // 部分 Tampermonkey/浏览器对请求端点的 url 查询只暴露子集，
        // 页面域查询能补回会话 Cookie（SID/HSID/__Secure-1PSID 等）。
        // 双份同名由下方"同名收敛"消除，不会再引发 CookieMismatch。
        // ⚠ Tampermonkey 限制：GM_cookie 查询的 url 必须被本脚本的
        //    @match/@include 覆盖。2.4.7 把 @include 收窄到路径含 prompts 后，
        //    根路径 "https://aistudio.google.com/" 不再被覆盖，查询恒失败
        //    （报 "the URL needs to be included by the script's @match or @include"）。
        //    改查含 prompts 的路径；Google Cookie 均在 path=/，结果集不变。
        try {
            const { cookies, error } = await gmCookieList({ url: "https://aistudio.google.com/prompts/" });
            if (error) {
                stats.pageURL = `失败(${String(error).slice(0, 40)})`;
            } else {
                stats.pageURL = cookies.length;
                cookies.forEach((c) => addCookie(c, "pageURL"));
            }
        } catch (_) {}

        // --- 策略 3：核心 Cookie 缺失时按 name 逐项补查 ---
        const has = (name) => [...byKey.values()].some((c) => c.name === name);
        const core = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID"];
        const missing = core.filter((n) => !has(n));
        if (missing.length && typeof GM_cookie !== "undefined" && GM_cookie.list) {
            for (const name of missing) {
                try {
                    const { cookies, error } = await gmCookieList({ name });
                    if (error) continue;
                    const found = (cookies || []).filter((c) => isGoogleDomain(c.domain));
                    found.forEach((c) => addCookie(c, "byName"));
                    stats.byName += found.length;
                } catch (_) {}
            }
        }

        // --- 同名收敛：同一名称多份（不同 domain/host-only）只保留一份，
        // 否则 Cookie 头重复发送同名值，Google 判 CookieMismatch。
        // 优先保留请求端点查询结果（= 浏览器真实将发送的属性），其次 path 更长者。
        const merged = [...byKey.values()];
        const byName = new Map();
        for (const c of merged) {
            const prev = byName.get(c.name);
            if (!prev) {
                byName.set(c.name, c);
                continue;
            }
            const score = (x) => (x.source === "reqURL" ? 2 : x.source === "pageURL" ? 1 : 0) * 100 + (x.path || "/").length;
            if (score(c) > score(prev)) byName.set(c.name, c);
        }
        const finalCookies = [...byName.values()];

        log(
            `Cookie 收集统计: 请求端点=${stats.reqURL} | 页面=${stats.pageURL}` +
            (stats.byName ? ` | 按名补查+${stats.byName}` : "") +
            ` → 同名收敛 ${finalCookies.length} 条`
        );
        return finalCookies;
    }

    async function pushCookiesToCloud() {
        if (state.pushBusy) throw new Error("已有 Cookie 推送正在进行，请稍后重试");
        state.pushBusy = true;
        try { return await performCookiePush(); }
        finally { state.pushBusy = false; }
    }

    async function performCookiePush() {
        if (!cfg.apiKey) {
            log("推送 Cookie 前，请先设置 cat- API Key");
            updatePanel();
            throw new Error("尚未设置 API Key");
        }
        log("☁ 开始导出 Cookie…");
        if (typeof GM_cookie === "undefined" || !GM_cookie.list) {
            log("❌ GM_cookie 不可用：请在 Tampermonkey 扩展管理页开启「开发者模式」后刷新页面重试");
            log("   （手机浏览器 Via/X 部分版本不支持 GM_cookie，请改用 Firefox/Edge + Tampermonkey）");
            throw new Error("GM_cookie 不可用");
        }
        const cookies = await collectCookies();
        if (!cookies.length) {
            log("❌ 未导出到任何 Cookie（未登录？或浏览器限制 Cookie 读取，请确认 Tampermonkey 开发者模式已开启）");
            throw new Error("未导出 Cookie，可能需要重新登录");
        }
        const names = new Set(cookies.map((c) => c.name));
        // 会话必需 8 件套：签名 3 件（SAPISID 系）+ 会话 5 件（SID 系）。
        // 缺任一件 Google 必判 401——推送前就拦下，明示缺什么
        const required = [
            "SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID",
            "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID",
        ];
        const missing = required.filter((n) => !names.has(n));
        if (missing.length) {
            log(`❌ 缺少会话必需 Cookie（共 ${missing.length} 件）: ${missing.join(", ")}`);
            log("   排查：Tampermonkey 默认不向脚本开放全部 Cookie（尤其 HttpOnly 的会话 Cookie），");
            log("   需把「允许脚本访问 Cookie」设为 all，步骤如下：");
            log("   ① 打开篡改猴（Tampermonkey）管理面板（浏览器工具栏图标 → 管理面板）");
            log("   ② 切到「设置」页签，把顶部「配置模式」选为「高级」");
            log("   ③ 在高级设置里找到「安全」一栏，把「允许脚本访问 Cookie」改为 all");
            log("   ④ 点击保存，然后回到本页刷新重试");
            log("   注：若改完仍失败，请确认浏览器扩展页已开启「开发者模式」（Chrome/Edge 需开启才能用 GM_cookie）");
            throw new Error("缺少必要的登录 Cookie");
        }
        const email = detectEmail();
        if (email) {
            log(`账号: ${email}`);
        } else {
            log("⚠ 未检测到账号邮箱（可在页面点开右上角账号菜单后重试），凭证将以临时名保存");
        }
        const payload = {
            email: email || undefined,
            cookies: cookies.map((c) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || "/",
                expirationDate: typeof c.expirationDate === "number" ? c.expirationDate : -1,
                httpOnly: !!c.httpOnly,
                secure: !!c.secure,
                sameSite: c.sameSite || "unspecified",
            })),
        };
        const body = JSON.stringify(payload);
        log(`☁ 推送 ${cookies.length} 条 Cookie 到云端${email ? `（${email}）` : ""}…`);
        const result = await new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: "POST",
                url: PUSH_URL,
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": cfg.apiKey,
                },
                data: body,
                timeout: 30000,
                onload: (resp) => {
                    try {
                        const data = JSON.parse(resp.responseText);
                        if (resp.status === 200) {
                            const at = data.created_at
                                ? new Date(data.created_at * 1000).toLocaleString("zh-CN", { hour12: false })
                                : "";
                            log(`✅ 凭证「${data.label || email || "?"}」已推送/更新${at ? `（更新时间 ${at}）` : ""}（${data.cookies} 条 Cookie），pggo- 模型已可用`);
                            resolve(data);
                        } else {
                            const msg = data?.error?.message || data?.detail || resp.responseText;
                            log(`❌ 推送失败 [${resp.status}]: ${msg}`);
                            reject(mkError(resp.status, "push_failed", msg));
                        }
                    } catch (e) {
                        log(`❌ 推送响应解析失败: ${e}`);
                        reject(mkError(502, "push_response_invalid", String(e)));
                    }
                },
                onerror: (e) => {
                    log("❌ 推送网络错误: " + (e && e.error));
                    reject(mkError(502, "push_network_error", String(e && e.error)));
                },
                ontimeout: () => {
                    log("❌ 推送超时");
                    reject(mkError(504, "push_timeout", "推送超时"));
                },
            });
        });
        if (result) {
            state.autoPushLastAt = Date.now();
            GM_setValue(AUTO_PUSH_LAST_KEY, state.autoPushLastAt);
        }
        scheduleAutoCookiePush(nextAutoPushDelay());
        updatePanel();
        return result;
    }

    function nextAutoPushDelay() {
        return AUTO_PUSH_BASE_MS + Math.floor(Math.random() * (AUTO_PUSH_JITTER_MS * 2 + 1)) - AUTO_PUSH_JITTER_MS;
    }

    function clearAutoCookiePushTimer() {
        if (state.autoPushTimer) {
            clearTimeout(state.autoPushTimer);
            state.autoPushTimer = null;
        }
    }

    function scheduleAutoCookiePush(delayMs) {
        clearAutoCookiePushTimer();
        if (!cfg.autoCookiePush || !cfg.apiKey || !state.waaReady) return;
        const existing = state.autoPushNextAt > Date.now() ? state.autoPushNextAt - Date.now() : null;
        const delay = Math.max(1000, delayMs ?? existing ?? nextAutoPushDelay());
        state.autoPushNextAt = Date.now() + delay;
        GM_setValue(AUTO_PUSH_NEXT_KEY, state.autoPushNextAt);
        state.autoPushTimer = setTimeout(async () => {
            state.autoPushTimer = null;
            if (!state.waaReady) return;
            if (!cfg.autoCookiePush) {
                return;
            }
            if (state.autoPushBusy) return scheduleAutoCookiePush(10 * 60 * 1000);
            state.autoPushBusy = true;
            updatePanel();
            try {
                await pushCookiesToCloud();
            } catch (e) {
                log("⚠ 自动续推失败，将在 15 分钟后重试：" + ((e && e.message) || e));
                scheduleAutoCookiePush(AUTO_PUSH_RETRY_MS);
            } finally {
                state.autoPushBusy = false;
                // pushCookiesToCloud() may return early when GM_cookie is unavailable,
                // so retain a retry schedule even when no exception was thrown.
                if (cfg.autoCookiePush && !state.autoPushTimer) scheduleAutoCookiePush(AUTO_PUSH_RETRY_MS);
                updatePanel();
            }
        }, delay);
        updatePanel();
    }

    function toggleAutoCookiePush() {
        cfg.autoCookiePush = !cfg.autoCookiePush;
        GM_setValue(AUTO_PUSH_ENABLED_KEY, cfg.autoCookiePush);
        clearAutoCookiePushTimer();
        if (cfg.autoCookiePush) {
            log("⏱ 已开启自动续推 Cookie（约每 40–50 分钟，页面需保持打开）");
            scheduleAutoCookiePush(3000);
        } else {
            state.autoPushNextAt = 0;
            GM_setValue(AUTO_PUSH_NEXT_KEY, 0);
            log("⏹ 已关闭自动续推 Cookie");
        }
        updatePanel();
    }

    function toggleAutoActivateHi() {
        cfg.autoActivateHi = !cfg.autoActivateHi;
        GM_setValue(AUTO_HI_ENABLED_KEY, cfg.autoActivateHi);
        log(cfg.autoActivateHi ? "💬 已开启页面加载后自动发送 hi" : "⏹ 已关闭自动发送 hi，请手动发送消息激活");
        updatePanel();
    }

    // ==================== 更新检查 ====================

    // 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0
    function cmpVersion(a, b) {
        const pa = String(a).split(".").map(Number);
        const pb = String(b).split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d > 0 ? 1 : -1;
        }
        return 0;
    }

    // 检查更新：拉取 SCRIPT_URL 的脚本头，比对 @version。
    // manual=true 表示用户手动触发（结果即使无更新也在日志提示）。
    // 注意不能直接检查 Tampermonkey 自身的更新状态——脚本可能被设置
    // 为"从不检查更新"，所以脚本自己拉一次头部做比对。
    async function checkForUpdate(manual) {
        updateInfo = "checking";
        updatePanel();
        log("🔍 检查更新…（当前 v" + CLIENT_VERSION + "）");
        const result = await new Promise((resolve) => {
            const done = (v) => {
                updateInfo = v; // null / "latest" / "新版本号"
                updatePanel();
                resolve(v);
            };
            let settled = false;
            const finish = (v) => {
                if (!settled) { settled = true; done(v); }
            };
            try {
                GM.xmlHttpRequest({
                    method: "GET",
                    url: SCRIPT_URL + "?_ts=" + Date.now(), // 破缓存
                    timeout: 15000,
                    onload: (resp) => {
                        try {
                            if (resp.status !== 200) {
                                log(`⚠ 检查更新失败 [${resp.status}]`);
                                finish(null);
                                return;
                            }
                            const m = (resp.responseText || "").match(/@version\s+([\d.]+)/);
                            if (!m) {
                                log("⚠ 检查更新失败：远端脚本头无 @version");
                                finish(null);
                                return;
                            }
                            const remote = m[1];
                            if (cmpVersion(remote, CLIENT_VERSION) > 0) {
                                log(`🔔 发现新版本 v${remote}（当前 v${CLIENT_VERSION}），请在面板点击「⬇ 更新」`);
                                finish(remote);
                            } else {
                                if (manual) log(`✅ 已是最新版本（v${CLIENT_VERSION}）`);
                                finish("latest");
                            }
                        } catch (e) {
                            log("⚠ 检查更新解析失败: " + e);
                            finish(null);
                        }
                    },
                    onerror: () => { log("⚠ 检查更新网络错误"); finish(null); },
                    ontimeout: () => { log("⚠ 检查更新超时"); finish(null); },
                });
            } catch (e) {
                log("⚠ 检查更新异常: " + e);
                finish(null);
            }
        });
        return result;
    }

    // 打开更新页（新标签页加载脚本 → Tampermonkey 弹确认 → 更新）
    function openUpdatePage() {
        const url = SCRIPT_URL + "?_update=" + Date.now(); // 破缓存，确保拿到最新版
        log("⬇ 打开更新页: " + url);
        try {
            if (typeof GM_openInTab === "function") {
                GM_openInTab(url, { active: true });
                return;
            }
            // GM.openInTab 兜底（@grant GM.xmlHttpRequest 之外的新式 API）
            if (typeof GM !== "undefined" && GM.openInTab) {
                GM.openInTab(url, { active: true });
                return;
            }
            window.open(url, "_blank");
        } catch (e) {
            log("⚠ 打开更新页失败: " + e + "，请手动访问 " + url);
        }
    }

    // ==================== 网页保活（小窗 / 后台音频，可分别开关） ====================
    // 原理：浏览器会冻结/丢弃"完全后台"的标签页（timer 节流、JS 冻结、
    // 内存节省），导致 WS 断开后无法重连。两种状态可豁免：
    //   a. 画中画（PiP）小窗在播视频 —— 页面视为前台活跃，不冻结不节流；
    //   b. 标签页"正在播放音频" —— 不冻结、不深度节流、不被丢弃。
    // 两种保活相互独立：可只开一个，也可同时开启。
    //   小窗：canvas 视频流 + 画中画（需要用户手势，点开关即是）；
    //   音频：WebAudio 近无声正弦波（30Hz、极低增益，人耳不可闻、扬声器无法重放，
    //         但浏览器仍判定为"正在播放音频"）。

    const keepalive = {
        pip: false, // 小窗保活是否开启
        audio: false, // 后台音频保活是否开启
        videoEl: null,
        canvas: null,
        drawTimer: null,
        audioCtx: null,
        osc: null,
    };

    function drawKeepaliveFrame(canvas) {
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#111116";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#4ade80";
        ctx.font = "16px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("🐱 保活中", canvas.width / 2, canvas.height / 2 - 8);
        ctx.fillStyle = "#9a9aa8";
        ctx.font = "10px system-ui, sans-serif";
        ctx.fillText(
            new Date().toLocaleTimeString(),
            canvas.width / 2,
            canvas.height / 2 + 12
        );
    }

    // ---------- 小窗（画中画） ----------

    async function startPip() {
        if (keepalive.pip) return;
        // requestPictureInPicture 需要用户手势（点开关即是），且要求视频
        // 元数据就绪（readyState >= 1），所以先就绪、play，再请求 PiP
        let video = null;
        try {
            if (document.pictureInPictureEnabled === false) {
                throw new Error("浏览器不支持画中画");
            }
            const canvas = document.createElement("canvas");
            canvas.width = 256;
            canvas.height = 144;
            drawKeepaliveFrame(canvas);
            const stream = canvas.captureStream(1); // 1fps，极低开销
            video = document.createElement("video");
            video.srcObject = stream;
            video.muted = true;
            video.playsInline = true;
            video.style.cssText =
                "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
            document.documentElement.appendChild(video);
            if (!(await waitFor(() => video.readyState >= 1, 3000, 30))) {
                throw new Error("视频流未就绪");
            }
            await video.play();
            await video.requestPictureInPicture();
            video.addEventListener("leavepictureinpicture", () => {
                // 用户手动关掉小窗：同步关闭开关，避免面板显示"开着"但实际没在保活
                if (keepalive.pip) {
                    log("⚠ 小窗被关闭，小窗保活已停止（需要请重新打开开关）");
                    stopPip(true);
                }
            });
            keepalive.videoEl = video;
            keepalive.canvas = canvas;
            keepalive.drawTimer = setInterval(
                () => drawKeepaliveFrame(canvas),
                1000
            );
            keepalive.pip = true;
            log("✅ 小窗保活已开启");
        } catch (e) {
            if (video) {
                try {
                    video.pause();
                    video.srcObject = null;
                } catch (_) {}
                video.remove();
            }
            log("❌ 小窗保活开启失败：" + ((e && e.message) || e) + "（手机浏览器多数不支持，可改用后台音频）");
        }
        updatePanel();
    }

    function stopPip(silent) {
        const wasOn = keepalive.pip;
        keepalive.pip = false; // 先置位，避免 leavepictureinpicture 事件回调里重复停止
        try {
            if (document.pictureInPictureElement) document.exitPictureInPicture();
        } catch (_) {}
        if (keepalive.drawTimer) {
            clearInterval(keepalive.drawTimer);
            keepalive.drawTimer = null;
        }
        if (keepalive.videoEl) {
            try {
                keepalive.videoEl.pause();
                keepalive.videoEl.srcObject = null;
            } catch (_) {}
            keepalive.videoEl.remove();
            keepalive.videoEl = null;
        }
        keepalive.canvas = null;
        if (wasOn && !silent) log("🔴 小窗保活已关闭");
        updatePanel();
    }

    function togglePip() {
        if (keepalive.pip) {
            stopPip();
        } else {
            startPip().catch((e) =>
                log("❌ 小窗保活异常: " + ((e && e.message) || e))
            );
        }
    }

    // ---------- 后台音频 ----------

    async function startAudio() {
        if (keepalive.audio) return;
        let audioCtx = null;
        try {
            const AudioCtx = W.AudioContext || W.webkitAudioContext;
            if (!AudioCtx) throw new Error("浏览器不支持 AudioContext");
            audioCtx = new AudioCtx();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = "sine";
            osc.frequency.value = 30;
            gain.gain.value = 0.001;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            if (audioCtx.state === "suspended") await audioCtx.resume();
            osc.start();
            // 浏览器可能因中断（来电、切换音频源）把它暂停：尽力恢复
            audioCtx.onstatechange = () => {
                if (keepalive.audio && audioCtx && audioCtx.state !== "running") {
                    log("⚠ 后台音频被浏览器暂停，正在尝试恢复…");
                    audioCtx.resume().catch(() => {});
                }
            };
            keepalive.audioCtx = audioCtx;
            keepalive.osc = osc;
            keepalive.audio = true;
            log("✅ 后台音频保活已开启");
        } catch (e) {
            if (audioCtx) {
                try {
                    audioCtx.close();
                } catch (_) {}
            }
            log("❌ 后台音频保活开启失败：" + ((e && e.message) || e));
        }
        updatePanel();
    }

    function stopAudio() {
        const wasOn = keepalive.audio;
        keepalive.audio = false;
        if (keepalive.osc) {
            try {
                keepalive.osc.stop();
            } catch (_) {}
            keepalive.osc = null;
        }
        if (keepalive.audioCtx) {
            try {
                keepalive.audioCtx.onstatechange = null;
                keepalive.audioCtx.close();
            } catch (_) {}
            keepalive.audioCtx = null;
        }
        if (wasOn) log("🔴 后台音频保活已关闭");
        updatePanel();
    }

    function toggleAudio() {
        if (keepalive.audio) {
            stopAudio();
        } else {
            startAudio().catch((e) =>
                log("❌ 后台音频保活异常: " + ((e && e.message) || e))
            );
        }
    }

    // 切回本页时，若音频被系统暂停则尽力恢复
    document.addEventListener("visibilitychange", () => {
        if (
            document.visibilityState === "visible" &&
            keepalive.audio &&
            keepalive.audioCtx &&
            keepalive.audioCtx.state === "suspended"
        ) {
            keepalive.audioCtx.resume().catch(() => {});
        }
    });

    // ==================== WS 心跳保活（worker 驱动） ====================
    // 后台标签页的主线程 setInterval 会被浏览器节流（隐藏 5 分钟后压到每分钟一次），
    // 心跳一断，中间的代理/CDN（wss 经 nginx 等）会按空闲超时掐掉连接——表现为
    // "后台挂一会儿就掉线、切回来才重连"。Worker 线程的定时器不受页面节流影响，
    // 由它 tick，主线程在 message 事件里补发心跳（message 派发不受节流限制）。
    // （照 aistudio-executor 的 startKeepAlive；worker 起不来时回退主线程定时器。）
    //
    // 注意：aistudio.google.com 全站开启 Trusted Types（require-trusted-types-for
    // 'script'），new Worker(blobURL) 的 URL 参数只接受 TrustedScriptURL，直接传
    // blob: 字符串会抛 "This assignment requires a TrustedScriptURL"。
    // Tampermonkey 沙箱里 createScriptURL 策略是页面提供的，不可靠，所以这里
    // 先探测 window.trustedTypes 可用性，构造失败/无策略一律走主线程定时器兜底。
    let kaWorker = null;
    let kaTimer = null;
    let pongSeen = false; // 后端是否应答过 ping（新版 build_service 回 pong）
    let pingsOut = 0; // 已发出但未收到任何下行应答的心跳数

    function wsHeartbeat() {
        if (state.wsStatus !== "connected") return;
        // 半开检测：只有在后端确认会回 pong 的情况下才做判定——
        // 旧版后端不回，这里绝不能凭"没收到消息"就断线重连（空闲也连接健康）。
        if (pongSeen && pingsOut >= 3) {
            log("⚠ 心跳 3 轮无应答（60s 无下行），判定半开连接，主动断开重连");
            pingsOut = 0;
            disconnectWs("heartbeat-timeout");
            scheduleConnect(1000);
            return;
        }
        if (wsSend({ type: "ping", ts: Date.now() })) {
            pingsOut++;
            state.lastPingAt = Date.now();
            state.pingCount++;
        }
    }

    function startHeartbeatWorker() {
        if (kaWorker || kaTimer) return;
        const HEARTBEAT_MS = 20000;
        const fallbackToTimer = () => {
            if (kaTimer) return;
            try {
                if (kaWorker) kaWorker.terminate();
            } catch (_) {}
            kaWorker = null;
            kaTimer = setInterval(wsHeartbeat, HEARTBEAT_MS);
        };
        let url = null;
        try {
            url = URL.createObjectURL(
                new Blob(
                    [
                        "const t=setInterval(()=>postMessage('tick')," +
                            HEARTBEAT_MS +
                            ");onmessage=e=>{if(e.data==='stop'){clearInterval(t);close()}};",
                    ],
                    { type: "text/javascript" }
                )
            );
            // Trusted Types（require-trusted-types-for 'script'）下 Worker 的
            // scriptURL 是 TrustedScriptURL 槽位，传字符串会抛
            // "This assignment requires a TrustedScriptURL"。
            // 依次尝试：① 自建策略（CSP trusted-types 未锁名时可用）
            //          ② 页面 defaultPolicy（AI Studio 自建过默认策略时蹭用）
            //          ③ 无 TT 环境直接传 blob URL
            // 都不行就回退主线程定时器（配合面板的音频/小窗保活开关）。
            let workerUrl = null;
            const tt = W.trustedTypes;
            if (tt && tt.createPolicy) {
                try {
                    workerUrl = tt
                        .createPolicy("catiecli-ka", { createScriptURL: (s) => s })
                        .createScriptURL(url);
                } catch (_) {
                    if (tt.defaultPolicy) {
                        workerUrl = tt.defaultPolicy.createScriptURL(url);
                    }
                }
            } else {
                workerUrl = url;
            }
            if (!workerUrl) throw new Error("Trusted Types 锁定，无法构造 worker 脚本 URL");
            kaWorker = new Worker(workerUrl);
            kaWorker.onmessage = (ev) => {
                if (ev.data === "tick") wsHeartbeat();
            };
            kaWorker.onerror = () => {
                log("⚠ 心跳 worker 异常，回退主线程定时器");
                fallbackToTimer();
            };
        } catch (e) {
            log("⚠ 心跳 worker 不可用（" + ((e && e.message) || e) + "），用主线程定时器");
            fallbackToTimer();
        }
    }

    // ==================== 请求执行（协议无关） ====================

    function mkError(httpStatus, code, message) {
        return { httpStatus, code, message, __pgError: true };
    }

    // requestBody 结构（后端 pg_proxy 下发）：
    //   {"wire": [...], "binding": "..."}
    // 执行：binding 写入输入框 → proof 注入 wire[4] → 页面 fetch → 回传原始文本
    // onChunk 存在时切真流式：响应头到达后逐块读取逐块回调（增量下发），
    // 完整文本仍作为返回值（后端非流式路径与统计共用）
    async function runGenerate(requestId, payload, signal, tm, onChunk) {
        tm = tm || {};
        ensureWaaReady();
        const { wire, binding } = payload;
        if (!Array.isArray(wire) || typeof binding !== "string") {
            throw mkError(400, "invalid_payload", "requestBody 缺少 wire/binding 字段");
        }

        // 1. binding 写入页面输入框（WAA proof 与输入框状态强绑定）
        let t = Date.now();
        await syncPrompt(binding);
        tm.sync = Date.now() - t;

        // 2. fresh proof 注入 field 5（wire[4]）
        t = Date.now();
        const digest = await sha256Hex(binding);
        wire[4] = await takeProof(digest);
        tm.proof = Date.now() - t;

        // 3. 页面上下文发送（FETCH_TIMEOUT_MS 硬超时，防 fetch 永久挂起）
        //    使用原生 fetch（W.__pgOrigFetch），避免触发自己的请求头捕获
        const captured = getHeaders();
        const headers = { ...captured };
        // 重放黑名单（参考 aistudio-executor 的 HEADER_DENY）：x-goog-ext-* 是页面
        // "那一发"请求的 LoggingContext，绑定当时的模型/会话/档位——旧值重放无效，
        // 甚至可能被上游掐连接；content-length/host/connection 由浏览器接管，不重放
        for (const k of Object.keys(headers)) {
            if (/^(content-length|host|connection|x-goog-ext-)/.test(k)) delete headers[k];
        }
        headers["content-type"] = "application/json+protobuf";
        // authorization 现算：捕获那份的 SAPISIDHASH 时间戳会过期
        const freshAuth = await freshAuthHeader();
        if (
            freshAuth &&
            (!headers["authorization"] ||
                String(headers["authorization"]).startsWith("SAPISIDHASH "))
        ) {
            headers["authorization"] = freshAuth;
        }
        // 自管超时（覆盖"读取响应体"阶段），不依赖 AbortSignal.any
        // （部分手机浏览器没有它，会丢失取消信号）
        const fetchAc = new AbortController();
        let timedOut = false;
        const fetchTimer = setTimeout(() => {
            timedOut = true;
            try { fetchAc.abort(); } catch (_) {}
        }, FETCH_TIMEOUT_MS);
        const onOuterAbort = () => {
            try { fetchAc.abort(); } catch (_) {}
        };
        if (signal) {
            if (signal.aborted) onOuterAbort();
            else signal.addEventListener("abort", onOuterAbort, { once: true });
        }
        const doFetch = W.__pgOrigFetch || W.fetch;
        t = Date.now();
        let gotResponseHeaders = false;
        try {
            const resp = await doFetch.call(W, GENERATE_URL, {
                method: "POST",
                headers,
                body: JSON.stringify(wire),
                credentials: "include",
                signal: fetchAc.signal,
            });
            gotResponseHeaders = true;

            if (!resp.ok) {
                const text = await resp.text().catch(() => "");
                throw mkError(
                    resp.status,
                    "upstream_http_error",
                    `上游 HTTP ${resp.status}` +
                        (text ? `: ${text.slice(0, 300)}` : "")
                );
            }
            let raw;
            if (onChunk && resp.body && typeof resp.body.getReader === "function") {
                // 真流式：逐块读取逐块回调（上游 repeated 帧增量下发）。
                // 多字节 UTF-8 序列可能跨块：TextDecoder({stream:true}) 负责
                // 跨块拼接，不产生 U+FFFD。上游确认 200 后取消不再回滚已
                // 推送的块（后端已发头，只能继续或报错）
                const reader = resp.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let sent = 0;
                let acc = "";
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const piece = decoder.decode(value, { stream: true });
                    if (!piece) continue;
                    acc += piece;
                    try {
                        onChunk(piece);
                        sent++;
                    } catch (_) {
                        // 回调失败（WS 断开等）：deliverResult 内部已暂存 outbox，不中断读取
                    }
                }
                const tail = decoder.decode();
                if (tail) {
                    acc += tail;
                    try { onChunk(tail); sent++; } catch (_) {}
                }
                raw = acc;
                tm.fetch = Date.now() - t;
                if (sent === 0 && (!raw || !raw.trim())) {
                    throw mkError(502, "empty_response", "上游返回空内容");
                }
            } else {
                raw = await resp.text();
                tm.fetch = Date.now() - t;
            }
            if (signal && signal.aborted && !timedOut) {
                throw mkError(499, "cancelled", "请求已取消");
            }
            // 空响应不能当成功回传（否则后端拿到"完成"但没有任何文字）
            if (!raw || !raw.trim()) {
                throw mkError(502, "empty_response", "上游返回空内容");
            }
            return raw;
        } catch (e) {
            if (e && e.__pgError) throw e;
            if (timedOut) {
                throw mkError(
                    504,
                    "upstream_timeout",
                    `上游 ${FETCH_TIMEOUT_MS / 1000}s 无响应（页面可能被后台冻结，或上游卡住）`
                );
            }
            // TypeError: Failed to fetch —— 原生错误零细节，补齐现场用于定位：
            //   aborted（谁触发）/ 页面可见性 / navigator.onLine / 耗时 /
            //   请求头键名（判断是否引导）/ fetch 来源
            if (e instanceof TypeError || (e && e.name === "TypeError")) {
                const abortedBy =
                    fetchAc.signal.aborted
                        ? timedOut ? "自管超时" : (signal && signal.aborted ? "后端取消/硬超时" : "未知来源 abort")
                        : "无";
                const detail = [
                    `网络层 fetch 失败（TypeError: ${(e && e.message) || e}）`,
                    `阶段=${gotResponseHeaders ? "响应头已到，读正文时断流（请求已被上游受理，多为网络路径被切）" : "未收到响应头（建连失败或被上游掐断，查头/proof）"}`,
                    `abort=${abortedBy}`,
                    `耗时=${Date.now() - t}ms`,
                    `proof=${tm.proof || 0}ms 同步=${tm.sync || 0}ms`,
                    `页面可见性=${document.visibilityState}`,
                    `在线状态=${navigator.onLine ? "在线" : "离线"}`,
                    `请求头键=[${Object.keys(headers).join(",")}]`,
                    `x-goog-api-key=${headers["x-goog-api-key"] ? "有" : "无"}`,
                    `fetch来源=${W.__pgOrigFetch ? "原生 fetch（未被改写）" : "window.fetch（⚠ 可能被页面/其他脚本改写）"}`,
                ].join(" | ");
                log(`⚠ 上游 fetch 诊断 [${requestId.slice(0, 8)}]: ${detail}`);
                throw mkError(502, "upstream_fetch_failed", detail);
            }
            throw e;
        } finally {
            clearTimeout(fetchTimer);
            if (signal) signal.removeEventListener("abort", onOuterAbort);
        }
    }

    // 请求结束清理：直接清空 textarea 值（不等待 Angular 同步确认，
    // 失败也不重试——清理失败不影响下一个请求写入）
    async function finishRequestCleanup() {
        try {
            const visible = (el) => el.checkVisibility({ visibilityProperty: true });
            const textarea = [...document.querySelectorAll("ms-prompt-box textarea")].filter(visible)[0];
            if (textarea) {
                const setter = Object.getOwnPropertyDescriptor(
                    W.HTMLTextAreaElement.prototype,
                    "value"
                ).set;
                setter.call(textarea, "");
                textarea.dispatchEvent(new W.Event("input", { bubbles: true }));
            }
        } catch (_) {}
    }

    function enqueue(task) {
        state.queueTail = state.queueTail.then(task, task);
        return state.queueTail;
    }

    async function handleRequest(msg) {
        const { requestId, model, stream, requestBody } = msg;
        let payload;
        try {
            payload = JSON.parse(requestBody);
        } catch (e) {
            sendError(requestId, 400, {
                code: "invalid_request_body",
                message: "requestBody 不是有效 JSON: " + e.message,
            });
            return;
        }
        state.requestCount++;
        const recvTs = Date.now();
        log(
            `▶ 请求 ${requestId.slice(0, 8)} model=${model}${stream ? " (stream)" : ""}` +
                `（队列前方等待 ${state.queueDepth} 个）`
        );
        state.queueDepth++;
        await enqueue(async () => {
            state.queueDepth = Math.max(0, state.queueDepth - 1);
            if (state.aborted.has(requestId)) {
                state.aborted.delete(requestId);
                return;
            }
            // 过期丢弃：排队太久的请求后端多半已放弃/重试，
            // 再执行只会占住串行队列、拖慢后面的新请求
            const waited = Date.now() - recvTs;
            if (waited > QUEUE_MAX_WAIT_MS) {
                sendError(requestId, 503, {
                    code: "queue_stale",
                    message: `请求在脚本队列等待 ${Math.round(waited / 1000)}s，已过期丢弃`,
                });
                log(`⏭ 丢弃过期请求 ${requestId.slice(0, 8)}（排队 ${Math.round(waited / 1000)}s）`);
                return;
            }
            const tm = { queueWait: waited };
            const controller = new AbortController();
            state.controllers.set(requestId, controller);
            // 硬超时：整个请求最长 10 分钟，防止任何环节挂起阻塞串行队列
            const hardTimer = setTimeout(() => {
                try { controller.abort(); } catch (_) {}
            }, 10 * 60 * 1000);
            try {
                if (stream) {
                    // 真流式：逐块 stream-chunk（保序经 deliverResult 的
                    // outbox 直发/补发机制），读完后单发 stream-end。
                    // WS 掉线时 chunk 进 outbox 暂存，重连后按序补发
                    let rawLen = 0;
                    let chunkCount = 0;
                    const raw = await runGenerate(
                        requestId,
                        payload,
                        controller.signal,
                        tm,
                        (piece) => {
                            chunkCount++;
                            rawLen += piece.length;
                            deliverResult({
                                type: "stream-chunk",
                                requestId,
                                chunkBody: piece,
                            });
                        }
                    );
                    if (state.aborted.has(requestId)) {
                        state.aborted.delete(requestId);
                        return;
                    }
                    const ok = deliverResult({ type: "stream-end", requestId, status: 200 });
                    const info =
                        `${rawLen}字节/${chunkCount}块 排队${Math.round((tm.queueWait || 0) / 1000)}s ` +
                        `同步${tm.sync || 0}ms proof${tm.proof || 0}ms 上游${Math.round((tm.fetch || 0) / 1000)}s`;
                    log(
                        ok
                            ? `✔ 完成（流式） ${requestId.slice(0, 8)} ${info}`
                            : `✔ 完成但 WS 未连接，已暂存待补发 ${requestId.slice(0, 8)} ${info}`
                    );
                    if (rawLen < 200) {
                        log("⚠ 响应内容很短: " + String(raw).slice(0, 160));
                    }
                } else {
                    const raw = await runGenerate(requestId, payload, controller.signal, tm);
                    if (state.aborted.has(requestId)) {
                        state.aborted.delete(requestId);
                        return;
                    }
                    const ok = deliverResult({
                        type: "response",
                        requestId,
                        status: 200,
                        rawResponse: raw,
                    });
                    const info =
                        `${raw.length}字节 排队${Math.round((tm.queueWait || 0) / 1000)}s ` +
                        `同步${tm.sync || 0}ms proof${tm.proof || 0}ms 上游${Math.round((tm.fetch || 0) / 1000)}s`;
                    log(
                        ok
                            ? `✔ 完成 ${requestId.slice(0, 8)} ${info}`
                            : `✔ 完成但 WS 未连接，已暂存待补发 ${requestId.slice(0, 8)} ${info}`
                    );
                    if (raw.length < 200) {
                        log("⚠ 响应内容很短: " + raw.slice(0, 160));
                    }
                }
            } catch (e) {
                if (state.aborted.has(requestId)) {
                    state.aborted.delete(requestId);
                    sendError(requestId, 499, {
                        code: "cancelled",
                        message: "请求已取消",
                    });
                    log(`⊘ 取消 ${requestId.slice(0, 8)}`);
                } else if (e && e.__pgError) {
                    sendError(requestId, e.httpStatus || 502, {
                        code: e.code,
                        message: e.message,
                    });
                    log(`✖ 失败 ${requestId.slice(0, 8)} [${e.httpStatus}] ${e.message}`);
                } else {
                    const eName = (e && e.name) || "Error";
                    const eMsg = (e && e.message) || String(e);
                    const stackHead = (e && e.stack) ? String(e.stack).split("\n").slice(0, 3).join(" ⏎ ").slice(0, 300) : "";
                    sendError(requestId, 502, {
                        code: "executor_error",
                        message: `${eName}: ${eMsg}`,
                    });
                    log(`✖ 异常 ${requestId.slice(0, 8)}: ${eName}: ${eMsg}`);
                    if (stackHead) log(`  异常堆栈: ${stackHead}`);
                    log(`  现场: 可见性=${document.visibilityState} 在线=${navigator.onLine ? "是" : "否"} WAA=${state.waaReady ? "就绪" : "未就绪"} WS=${state.wsStatus}`);
                }
            } finally {
                clearTimeout(hardTimer);
                state.controllers.delete(requestId);
                await finishRequestCleanup();
                updatePanel();
            }
        });
    }

    // ==================== WS 客户端 ====================

    function wsSend(obj) {
        if (!state.ws || state.ws.readyState !== 1) return false;
        try {
            state.ws.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            log("WS 发送失败: " + e.message);
            return false;
        }
    }

    // 断线续传保序：一旦有消息进入 outbox（断线），后续消息一律先排队，
    // 等 outbox 冲刷完再恢复直发——避免"新连接直发的新消息先于暂存的
    // 旧消息到达后端"造成流式乱序。
    let outboxHold = false;

    // 结果投递：在线且无积压则直发；断线或 outbox 未冲刷完则暂存。
    // request 的最终结果（response/stream-chunk+stream-end/error）允许迟到，
    // 后端会按 requestId 匹配等待中的请求（park/收养机制），顺序保持 FIFO。
    // stream-chunk 是原始文本的连续切片，天然可无损拼接：outbox 超容量时
    // 把最旧两条同请求相邻 chunk 合并成一条，既守容量上限又不丢内容
    // （避免长流断线暂存被 shift 截断造成中间内容缺失）
    function deliverResult(obj) {
        if (!outboxHold && wsSend(obj)) return true;
        if (obj && obj.requestId) {
            state.outbox.push({ msg: obj, ts: Date.now() });
            while (state.outbox.length > OUTBOX_MAX_ITEMS) {
                const first = state.outbox[0];
                const second = state.outbox[1];
                if (
                    second &&
                    first.msg.type === "stream-chunk" &&
                    second.msg.type === "stream-chunk" &&
                    first.msg.requestId === second.msg.requestId
                ) {
                    second.msg.chunkBody =
                        (first.msg.chunkBody || "") + (second.msg.chunkBody || "");
                    state.outbox.shift();
                } else {
                    state.outbox.shift(); // 无可合并（边界/非 chunk）：退化为丢最旧
                }
            }
            if (!outboxHold) {
                outboxHold = true;
                log(`📤 进入补发模式（已暂存 ${String(obj.requestId).slice(0, 8)}，共 ${state.outbox.length} 条）`);
            }
        }
        return false;
    }

    // 重连注册成功后补发 outbox（按 FIFO 顺序）；排空前保持补发模式，
    // 排空后恢复直发。再次断线则维持补发模式留待下次重连。
    function flushOutbox() {
        if (!state.outbox.length) {
            outboxHold = false;
            return;
        }
        const now = Date.now();
        // 先清理过期条目
        state.outbox = state.outbox.filter(
            (item) => now - item.ts < OUTBOX_MAX_AGE_MS
        );
        let sent = 0;
        while (state.outbox.length) {
            const { msg } = state.outbox[0];
            if (!wsSend(msg)) break; // 再次断线，留待下次重连
            state.outbox.shift();
            sent++;
        }
        if (sent) log(`📤 补发完成，发出 ${sent} 条`);
        outboxHold = state.outbox.length > 0;
        if (state.outbox.length) {
            log(`⚠ 补发中断，剩余 ${state.outbox.length} 条待下次重连`);
        }
    }

    function sendError(requestId, status, error) {
        deliverResult({
            type: "error",
            requestId,
            status: Number(status) || 502,
            error: {
                code: error.code || "error",
                message: error.message || String(error),
            },
        });
    }

    function scheduleConnect(delayMs) {
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(() => connectWs(), delayMs || 0);
    }

    function disconnectWs(reason) {
        state.wsStatus = "disconnected";
        if (state.ws) {
            try {
                state.ws.close();
            } catch (_) {}
            state.ws = null;
        }
        if (state.reconnectTimer) {
            clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
        }
        updatePanel();
        if (reason) log("WS 断开: " + reason);
    }

    function connectWs() {
        if (!state.waaReady || !state.bundleReady) return;
        if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) {
            return; // 已在连接/已连接
        }
        if (!cfg.apiKey) {
            log("未设置 API Key，跳过连接（菜单里设置后自动连接）");
            updatePanel();
            return;
        }
        state.wsStatus = "connecting";
        updatePanel();
        let ws;
        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            log("WS 创建失败: " + e.message);
            state.wsStatus = "disconnected";
            scheduleConnect(5000);
            return;
        }
        state.ws = ws;
        pingsOut = 0;
        pongSeen = false;
        startHeartbeatWorker();

        ws.onopen = () => {
            log("WS 已连接，发送 register…");
            wsSend({
                type: "register",
                clientVersion: CLIENT_VERSION,
                apiKey: cfg.apiKey,
                executorType: EXECUTOR_TYPE,
            });
        };

        ws.onmessage = (ev) => {
            pingsOut = 0; // 任何下行都证明连接活着
            let msg;
            try {
                msg = JSON.parse(ev.data);
            } catch (_) {
                return;
            }
            switch (msg.type) {
                case "registered":
                    state.wsStatus = "connected";
                    state.reconnectDelay = 1000;
                    log("✅ 注册成功（playground executor 已在线）");
                    updatePanel();
                    flushOutbox();
                    break;
                case "pong":
                    pongSeen = true; // 后端支持 ping/pong：此后启用半开检测
                    state.lastPongAt = Date.now();
                    state.pongCount++;
                    break;
                case "request":
                    handleRequest(msg).catch((e) =>
                        log("handleRequest 异常: " + e)
                    );
                    break;
                case "cancel": {
                    const rid = msg.requestId;
                    if (rid) {
                        state.aborted.add(rid);
                        const c = state.controllers.get(rid);
                        if (c) {
                            try {
                                c.abort();
                            } catch (_) {}
                        }
                    }
                    break;
                }
                case "error": {
                    log("后端错误: " + (msg.message || msg.code || JSON.stringify(msg)));
                    break;
                }
                default:
                    break;
            }
        };

        ws.onclose = (ev) => {
            if (state.ws !== ws) return; // 旧连接（已被替换/主动断开）的迟到事件，忽略
            state.wsStatus = "disconnected";
            state.ws = null;
            updatePanel();
            const delay = Math.min(state.reconnectDelay, 30000);
            state.reconnectDelay *= 2;
            if (ev.code === 4002) {
                log("WS 关闭(4002): API Key 已变更，请更新 Key 后重连");
                return; // 不自动重连
            }
            if (ev.code === 4008 || ev.code === 1008) {
                log(`WS 关闭(${ev.code}): ${ev.reason || "注册被拒绝"}`);
                return;
            }
            log(`WS 关闭(code=${ev.code})，${delay / 1000}s 后重连`);
            scheduleConnect(delay);
        };

        ws.onerror = () => {
            log("WS 连接错误: " + WS_URL);
        };
    }

    // ==================== 唤醒钩子（照 aistudio-executor 的 wake） ====================
    // 整页冻结醒来 / 网络恢复 / bfcache 回退时，立即查一次连接：
    // 健康时是空操作；断开时省掉最长 30 秒的退避等待——用户切回标签页的
    // 那一刻就该在线，而不是"再等 N 秒"。
    const wake = () => {
        if (document.visibilityState === "hidden") return;
        if (!cfg.apiKey) return;
        if (state.wsStatus === "connected") {
            // 已连接也可能被中间层单向掐断（半开）——心跳数据未超时则无害，直接补一发
            wsHeartbeat();
        } else if (!state.reconnectTimer) {
            state.reconnectDelay = 1000; // 用户在场，别再用大退避
            scheduleConnect(0);
        }
    };
    document.addEventListener("visibilitychange", wake);
    W.addEventListener("online", wake);
    W.addEventListener("pageshow", wake);

    // ==================== 主流程 ====================

    async function main() {
        // The short-lived local install ticket bootstraps the already-encrypted account key.
        const keyBootstrap = bootstrapAccountKey().catch(() => false);
        // 0. 最先安装 fetch/XHR 捕获（document-start，早于页面脚本取走 fetch 引用，
        //    也不依赖 bundle）。放在最前面是为了让页面拿到的就是包装后的 fetch。
        try {
            installFetchCapture();
            installXhrCapture();
        } catch (e) {
            log("请求头捕获安装异常: " + e);
        }

        // 1. 恢复持久化的请求头，并记录一次"页面(重)载入"用于排查后台被杀/刷新
        const persisted = loadPersistedWaa();
        if (persisted) {
            W.__pgWaaHeaders = { ...persisted.headers, ...(W.__pgWaaHeaders || {}) };
            state.waaPersistedTs = persisted.ts;
            log(`页面(重)载入；已恢复持久化请求头，上次引导 ${fmtTime(persisted.ts)}`);
        } else {
            log("页面(重)载入；无持久化记录，需在页面发送一条消息");
        }

        // 面板尽早出现
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", buildPanel, { once: true });
        } else {
            buildPanel();
        }

        // 启动时后台静默检查更新（结果只进日志/面板，不打扰）
        if (!HOST) checkForUpdate(false).catch(() => {});

        // 等页面 bundle 暴露 default_MakerSuite（SPA，可能较慢）
        log("等待页面 bundle（default_MakerSuite）…");
        const ok = await waitFor(
            () => {
                try {
                    return W.default_MakerSuite != null;
                } catch {
                    return false;
                }
            },
            120000,
            500
        );
        if (!ok) {
            log("❌ 120s 内未找到 default_MakerSuite，请确认页面已完全加载（或 Google 改版）");
            return;
        }
        state.bundleReady = true;
        updatePanel();

        // 安装 snapshot hook
        const hookResult = installSnapshotHook();
        if (hookResult === "no_snapshot_fn") {
            log("❌ 未找到 snapshot 函数（Google 可能已改版），执行器不可用");
            updatePanel();
            return;
        }
        log(`hook 安装完成 (snapshotKey=${state.waaSnapshotKey})，等待页面引导…`);
        updatePanel();
        await keyBootstrap;

        // 用正常提示框路径完成一次最小页面引导；若 Google 页面结构改版，
        // 自动化会停在提示，不会点击页面外部按钮。
        autoActivateWithHi().catch((e) => log("自动 hi 引导异常：" + ((e && e.message) || e)));

        // WAA 就绪后由 snapshot hook 回调触发 scheduleConnect；
        // 这里兜底：如果之前已完成引导（SPA 内部导航），直接连
        const ready = await waitFor(() => state.waaReady, 10 * 60 * 1000, 1000);
        if (!ready) { log("⚠ 激活超时，WAA 未就绪；未启动反代和自动推送"); return; }
        updatePanel(); // 按钮态/说明由 updatePanel 统一刷新
        scheduleConnect(0);
        if (cfg.autoCookiePush) scheduleAutoCookiePush(state.autoPushNextAt > Date.now() ? undefined : 3000);
    }

    if (HOST) HOST.attach({
        status: () => ({
            bundleReady: state.bundleReady, waaReady: state.waaReady, wsStatus: state.wsStatus,
            lastPingAt: state.lastPingAt, lastPongAt: state.lastPongAt,
            pingCount: state.pingCount, pongCount: state.pongCount,
            lastPushAt: state.autoPushLastAt, nextPushAt: state.autoPushNextAt, pushBusy: state.pushBusy,
            requestCount: state.requestCount, queueDepth: state.queueDepth,
            autoCookiePush: cfg.autoCookiePush, email: detectEmail() || null
        }),
        activate: () => { state.autoActivationStarted = false; return autoActivateWithHi(); },
        reconnect: () => { disconnectWs("控制台请求重连"); scheduleConnect(0); },
        push: () => { ensureWaaReady(); return pushCookiesToCloud(); }
    });
    main().catch((e) => log("主流程异常: " + e));
})();
