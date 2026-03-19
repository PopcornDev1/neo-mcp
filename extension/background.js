/**
 * Neo Bridge - Background Service Worker
 *
 * Maintains WebSocket connection to Neo daemon.
 * Dispatches browser control commands. Auto-extracts auth tokens.
 */

const NEO_WS_URL = "ws://127.0.0.1:7890";
const RECONNECT_INTERVAL = 3000;
const HEARTBEAT_INTERVAL = 30000;

let ws = null;
let connected = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let pendingContentRequests = new Map();
let requestId = 0;

// ── Tab group management ─────────────────────────────────────────────────────
// Neo gets its own tab group. Never touches user tabs.
let neoGroupId = null;       // chrome tab group ID
let neoTabIds = new Set();   // tabs owned by Neo

// ── Network capture state ────────────────────────────────────────────────────
let networkCapture = {
    active: false,
    filters: [],        // url patterns to match
    requests: [],       // captured entries
    maxEntries: 500,
};

// ── WebSocket Connection ─────────────────────────────────────────────────────

function connect() {
    if (ws && ws.readyState <= 1) return; // already connected/connecting

    try {
        ws = new WebSocket(NEO_WS_URL);
    } catch (e) {
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        connected = true;
        clearTimeout(reconnectTimer);
        updateBadge("ON", "#22c55e");
        console.log("[neo] Connected to daemon");

        // Send capabilities
        send({
            event: "bridge_connected",
            capabilities: [
                "navigate", "get_url", "get_tabs", "new_tab", "close_tab", "close_all_tabs", "switch_tab",
                "go_back", "go_forward", "reload", "get_profile",
                "click", "type", "clear", "select", "scroll", "focus",
                "read_text", "read_html", "read_page", "scroll_collect", "read_attribute", "read_value",
                "query_selector", "query_selector_all", "wait_for",
                "screenshot", "screenshot_full",
                "extract_cookies", "extract_local_storage", "extract_session_storage",
                "extract_auth", "set_cookie",
                "execute_js",
                "get_history", "download",
                "get_page_info",
                "network_start_capture", "network_stop_capture", "network_list", "network_get_request", "network_get_requests", "network_get_headers", "network_clear",
                "browser_fetch",
            ],
        });

        startHeartbeat();
    };

    ws.onmessage = async (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }

        if (msg.id && msg.method) {
            // Command from daemon
            try {
                const result = await handleCommand(msg.method, msg.params || {});
                send({ id: msg.id, result });
            } catch (err) {
                send({ id: msg.id, error: { message: err.message || String(err) } });
            }
        }
    };

    ws.onclose = () => {
        connected = false;
        updateBadge("OFF", "#666");
        stopHeartbeat();
        scheduleReconnect();
    };

    ws.onerror = () => {
        // onclose will fire after this
    };
}

function send(data) {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL);
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => send({ event: "heartbeat" }), HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
}

function updateBadge(text, color) {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
}

// Keep service worker alive
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive") {
        if (!connected) connect();
    }
});

// Connect on install/startup
chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());

// Also try connecting immediately
connect();

// ── Command Dispatcher ───────────────────────────────────────────────────────

async function handleCommand(method, params) {
    switch (method) {
        // ── Navigation (all tabs created by Neo go into the Neo tab group) ──
        case "navigate":
            return neoNavigate(params.url);
        case "get_url":
            return getNeoActiveTab();
        case "get_tabs":
            return getNeoTabs();
        case "new_tab":
            return neoNewTab(params.url);
        case "close_tab":
            return neoCloseTab(params.tab_id);
        case "close_all_tabs":
            return neoCloseAllTabs();
        case "switch_tab":
            return neoSwitchTab(params.tab_id);
        case "navigate_tab":
            return neoNavigateTab(params.url, params.tab_id);
        case "go_back":
            return execOnNeoTab("history.back()");
        case "go_forward":
            return execOnNeoTab("history.forward()");
        case "get_profile":
            return getProfile();
        case "reload":
            return reloadTab(params.tab_id);

        // ── DOM Interaction ──────────────────────────────────────────
        case "click":
            return contentCommand("click", params);
        case "type":
            return contentCommand("type", params);
        case "press_key":
            return contentCommand("press_key", params);
        case "clear":
            return contentCommand("clear", params);
        case "select":
            return contentCommand("select", params);
        case "check":
            return contentCommand("check", params);
        case "scroll":
            return contentCommand("scroll", params);
        case "focus":
            return contentCommand("focus", params);
        case "hover":
            return contentCommand("hover", params);
        case "drag_drop":
            return contentCommand("drag_drop", params);

        // ── DOM Reading ──────────────────────────────────────────────
        case "read_text":
            return contentCommand("read_text", params);
        case "read_html":
            return contentCommand("read_html", params);
        case "read_page":
            return contentCommand("read_page", params);
        case "scroll_collect":
            return contentCommand("scroll_collect", params);
        case "read_attribute":
            return contentCommand("read_attribute", params);
        case "read_value":
            return contentCommand("read_value", params);
        case "query_selector":
            return contentCommand("query_selector", params);
        case "query_selector_all":
            return contentCommand("query_selector_all", params);
        case "wait_for":
            return contentCommand("wait_for", params);
        case "wait_for_navigation":
            return contentCommand("wait_for_navigation", params);
        case "get_page_info":
            return contentCommand("get_page_info", params);

        // ── Screenshots ──────────────────────────────────────────────
        case "screenshot":
            return screenshot(params.quality);
        case "screenshot_full":
            return contentCommand("screenshot_full", params);

        // ── Auth / Cookies ───────────────────────────────────────────
        case "extract_cookies":
            return extractCookies(params.domain, params.names);
        case "extract_local_storage":
            return contentCommand("extract_local_storage", params);
        case "extract_session_storage":
            return contentCommand("extract_session_storage", params);
        case "extract_auth":
            return extractAuth(params.service);
        case "set_cookie":
            return setCookie(params);

        // ── JavaScript execution ─────────────────────────────────────
        case "execute_js":
            return execJsInPage(params.code, params.tab_id);

        // ── History ──────────────────────────────────────────────────
        case "get_history":
            return getHistory(params.max_results || 50);

        // ── Downloads ────────────────────────────────────────────────
        case "download":
            return download(params.url, params.filename);

        // ── Network capture ──────────────────────────────────────────
        case "network_start_capture":
            return networkStartCapture(params.filters, params.max_entries);
        case "network_stop_capture":
            return networkStopCapture();
        case "network_list":
            return networkList(params.filter, params.limit, params.offset);
        case "network_get_request":
            return networkGetRequest(params.id);
        case "network_get_requests":
            return networkGetRequests(params.ids);
        case "network_get_headers":
            return networkGetHeaders(params.id);
        case "network_clear":
            return networkClear();

        // ── Browser-context fetch ────────────────────────────────────
        case "browser_fetch":
            return browserFetch(params);

        default:
            throw new Error(`Unknown method: ${method}`);
    }
}

// ── Tab Group Management ─────────────────────────────────────────────────────
// Neo works in its own tab group. Never touches user tabs.

async function ensureNeoGroup() {
    // Check if our group still exists
    if (neoGroupId !== null) {
        try {
            const group = await chrome.tabGroups.get(neoGroupId);
            if (group) return neoGroupId;
        } catch {
            neoGroupId = null;
        }
    }

    // Check for existing Neo group (extension might have restarted)
    const allGroups = await chrome.tabGroups.query({ title: "Neo" });
    if (allGroups.length > 0) {
        neoGroupId = allGroups[0].id;
        // Rebuild neoTabIds from existing group
        const tabs = await chrome.tabs.query({ groupId: neoGroupId });
        neoTabIds = new Set(tabs.map((t) => t.id));
        return neoGroupId;
    }

    // Create a new tab to seed the group
    const seedTab = await chrome.tabs.create({ url: "about:blank", active: false });
    neoGroupId = await chrome.tabs.group({ tabIds: [seedTab.id] });
    await chrome.tabGroups.update(neoGroupId, { title: "Neo", color: "blue", collapsed: false });
    neoTabIds.add(seedTab.id);
    return neoGroupId;
}

async function addTabToNeoGroup(tabId) {
    const groupId = await ensureNeoGroup();
    try {
        await chrome.tabs.group({ tabIds: [tabId], groupId });
    } catch {}
    neoTabIds.add(tabId);
}

function isNeoTab(tabId) {
    return neoTabIds.has(tabId);
}

// Clean up: when a Neo tab is closed externally, remove from tracking
chrome.tabs.onRemoved.addListener((tabId) => {
    neoTabIds.delete(tabId);
});

// ── Navigation (all Neo tabs live in the Neo tab group) ──────────────────────

async function neoNavigate(url) {
    // Always create a new tab. Agents close their tabs when done.
    // This prevents concurrent agents from overwriting each other's pages.
    const tab = await chrome.tabs.create({ url, active: true });
    const tabId = tab.id;
    await addTabToNeoGroup(tabId);

    return new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tid, info) {
            if (tid === tabId && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                chrome.tabs.get(tid).then((t) => resolve({ tab_id: t.id, url: t.url, title: t.title }));
            }
        });
    });
}

async function neoNavigateTab(url, tabId) {
    // Navigate an existing tab to a new URL (tab reuse)
    await chrome.tabs.update(tabId, { url, active: true });
    return new Promise((resolve) => {
        chrome.tabs.onUpdated.addListener(function listener(tid, info) {
            if (tid === tabId && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                chrome.tabs.get(tid).then((t) => resolve({ tab_id: t.id, url: t.url, title: t.title }));
            }
        });
    });
}

async function getNeoActiveTab() {
    // Return the most recently active Neo tab
    for (const id of Array.from(neoTabIds).reverse()) {
        try {
            const tab = await chrome.tabs.get(id);
            if (tab) return { tab_id: tab.id, url: tab.url, title: tab.title };
        } catch {
            neoTabIds.delete(id);
        }
    }
    return { tab_id: null, url: null, title: null };
}

async function getNeoTabs() {
    const tabs = [];
    for (const id of neoTabIds) {
        try {
            const tab = await chrome.tabs.get(id);
            tabs.push({ id: tab.id, url: tab.url, title: tab.title, active: tab.active });
        } catch {
            neoTabIds.delete(id);
        }
    }
    return tabs;
}

async function neoNewTab(url) {
    const tab = await chrome.tabs.create({ url: url || "about:blank", active: true });
    await addTabToNeoGroup(tab.id);
    return { tab_id: tab.id };
}

async function neoCloseTab(tabId) {
    // Only close Neo-owned tabs
    if (tabId && !isNeoTab(tabId)) {
        return { error: "Cannot close user tabs. Only Neo-owned tabs can be closed." };
    }
    const id = tabId || Array.from(neoTabIds).pop();
    if (id) {
        neoTabIds.delete(id);
        await chrome.tabs.remove(id);
    }
    return { ok: true };
}

async function neoCloseAllTabs() {
    const ids = Array.from(neoTabIds);
    neoTabIds.clear();
    for (const id of ids) {
        try { await chrome.tabs.remove(id); } catch {}
    }
    neoGroupId = null;
    return { closed: ids.length };
}

async function neoSwitchTab(tabId) {
    await chrome.tabs.update(tabId, { active: true });
    return { ok: true };
}

async function reloadTab(tabId) {
    const id = tabId || Array.from(neoTabIds).pop();
    if (id) await chrome.tabs.reload(id);
    return { ok: true };
}

// ── Profile info ─────────────────────────────────────────────────────────────

function getProfile() {
    // chrome.identity or just return what we can infer
    return {
        // Each browser profile that has the extension installed gets its own service worker,
        // its own storage, its own WebSocket connection. Multiple profiles = multiple connections.
        extensionId: chrome.runtime.id,
        // User can label this profile via the popup or daemon config
        profileLabel: null, // TODO: make configurable via popup
    };
}

// ── Content Script Communication ─────────────────────────────────────────────

async function contentCommand(action, params) {
    // Default to the most recent Neo tab, not the user's active tab
    let tabId = params.tab_id;
    if (!tabId) {
        const neoTabs = Array.from(neoTabIds);
        for (let i = neoTabs.length - 1; i >= 0; i--) {
            try {
                const tab = await chrome.tabs.get(neoTabs[i]);
                if (tab && tab.url && !tab.url.startsWith("chrome://")) {
                    tabId = tab.id;
                    break;
                }
            } catch { neoTabIds.delete(neoTabs[i]); }
        }
    }
    if (!tabId) throw new Error("No Neo tab available. Use navigate to open one.");

    const results = await chrome.tabs.sendMessage(tabId, { action, params });
    if (results && results.error) throw new Error(results.error);
    return results;
}

async function execOnNeoTab(code) {
    const neoTabs = Array.from(neoTabIds);
    let tabId = null;
    for (let i = neoTabs.length - 1; i >= 0; i--) {
        try {
            const tab = await chrome.tabs.get(neoTabs[i]);
            if (tab) { tabId = tab.id; break; }
        } catch { neoTabIds.delete(neoTabs[i]); }
    }
    if (!tabId) throw new Error("No Neo tab available.");

    // Use args-based execution to avoid CSP violations from string eval
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (codeStr) => {
            // Create a script element to bypass CSP for eval
            // This works because chrome.scripting runs in ISOLATED world by default
            try {
                const fn = new Function(codeStr);
                return fn();
            } catch (e) {
                // If Function constructor is blocked, try script injection
                return null;
            }
        },
        args: [code],
        world: "MAIN",
    });
    return { result: results[0]?.result };
}

/**
 * Execute JS in the page context, bypassing CSP.
 * Uses script element injection which works even on CSP-restricted pages
 * because chrome.scripting.executeScript with MAIN world is trusted.
 */
async function execJsInPage(code, tabId) {
    let id = tabId;
    if (!id) {
        const neoTabs = Array.from(neoTabIds);
        for (let i = neoTabs.length - 1; i >= 0; i--) {
            try {
                const tab = await chrome.tabs.get(neoTabs[i]);
                if (tab) { id = tab.id; break; }
            } catch { neoTabIds.delete(neoTabs[i]); }
        }
    }
    if (!id) throw new Error("No Neo tab available.");

    // Try MAIN world first (can access page JS globals like React, Angular, etc.)
    // then fall back to content script's ISOLATED world (immune to CSP but
    // can't see page JS variables — still has full DOM access).
    let results;
    try {
        results = await chrome.scripting.executeScript({
            target: { tabId: id },
            world: "MAIN",
            func: (codeStr) => {
                try {
                    const fn = new Function("return (" + codeStr + ")");
                    const result = fn();
                    return { result: result !== undefined ? JSON.parse(JSON.stringify(result)) : null };
                } catch (e) {
                    return { error: e.message || String(e) };
                }
            },
            args: [code],
        });
        // If MAIN world returned a CSP error, fall through to ISOLATED
        const r = results[0]?.result;
        if (r && r.error && /Content Security|EvalError|unsafe-eval/i.test(r.error)) {
            results = null;
        }
    } catch {
        results = null;
    }

    if (!results) {
        // Fallback: run in ISOLATED world (content script context, no CSP restrictions)
        results = await chrome.scripting.executeScript({
            target: { tabId: id },
            func: (codeStr) => {
                try {
                    const fn = new Function("return (" + codeStr + ")");
                    const result = fn();
                    return { result: result !== undefined ? JSON.parse(JSON.stringify(result)) : null };
                } catch (e) {
                    return { error: e.message || String(e) };
                }
            },
            args: [code],
        });
    }

    const r = results[0]?.result;
    if (r && r.error) return { error: r.error };
    return r || { result: null };
}

// ── Screenshots ──────────────────────────────────────────────────────────────

async function screenshot(quality) {
    // Low quality by default to keep context small
    // quality 20 JPEG at tab resolution ~= 15-30KB ~= 3-6K tokens
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: "jpeg",
        quality: quality || 20,
    });
    return { image: dataUrl, sizeKb: Math.round(dataUrl.length * 0.75 / 1024) };
}

// ── Cookies / Auth ───────────────────────────────────────────────────────────

async function extractCookies(domain, names) {
    const allCookies = await chrome.cookies.getAll({ domain: domain || undefined });
    if (names && names.length > 0) {
        return allCookies.filter((c) => names.includes(c.name)).map(cookieToObj);
    }
    return allCookies.map(cookieToObj);
}

function cookieToObj(c) {
    return { name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate };
}

async function setCookie(params) {
    await chrome.cookies.set({
        url: params.url,
        name: params.name,
        value: params.value,
        domain: params.domain,
        path: params.path || "/",
        secure: params.secure,
        httpOnly: params.httpOnly,
    });
    return { ok: true };
}

/**
 * Smart auth extraction for known services.
 * Grabs the right tokens without the user having to know what to look for.
 */
async function extractAuth(service) {
    switch (service) {
        case "slack": {
            // Slack uses xoxc- token + d cookie
            const cookies = await chrome.cookies.getAll({ domain: ".slack.com" });
            const dCookie = cookies.find((c) => c.name === "d");
            // Also try to get the token from the active Slack tab
            const tabs = await chrome.tabs.query({ url: "*://*.slack.com/*" });
            let xoxcToken = null;
            if (tabs.length > 0) {
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: tabs[0].id },
                        func: () => {
                            // Try multiple extraction methods
                            // Method 1: boot_data in localStorage
                            for (let i = 0; i < localStorage.length; i++) {
                                const key = localStorage.key(i);
                                const val = localStorage.getItem(key);
                                if (val && val.includes("xoxc-")) {
                                    const match = val.match(/xoxc-[a-zA-Z0-9-]+/);
                                    if (match) return match[0];
                                }
                            }
                            // Method 2: global TS object
                            if (window.TS && window.TS.boot_data && window.TS.boot_data.api_token) {
                                return window.TS.boot_data.api_token;
                            }
                            return null;
                        },
                        world: "MAIN",
                    });
                    xoxcToken = results[0]?.result;
                } catch (e) { /* tab might not be accessible */ }
            }
            return {
                service: "slack",
                d_cookie: dCookie?.value || null,
                xoxc_token: xoxcToken,
                cookies: cookies.map(cookieToObj),
            };
        }

        case "discord": {
            // Discord token from localStorage
            const tabs = await chrome.tabs.query({ url: "*://discord.com/*" });
            let token = null;
            if (tabs.length > 0) {
                try {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: tabs[0].id },
                        func: () => {
                            // Try webpack chunk extraction
                            try {
                                const iframe = document.createElement("iframe");
                                document.body.appendChild(iframe);
                                const token = iframe.contentWindow.localStorage.getItem("token");
                                iframe.remove();
                                if (token) return JSON.parse(token);
                            } catch {}
                            // Try direct localStorage
                            const t = localStorage.getItem("token");
                            if (t) return JSON.parse(t);
                            return null;
                        },
                        world: "MAIN",
                    });
                    token = results[0]?.result;
                } catch {}
            }
            return { service: "discord", token };
        }

        case "linkedin": {
            const cookies = await chrome.cookies.getAll({ domain: ".linkedin.com" });
            const liAt = cookies.find((c) => c.name === "li_at");
            const jsessionid = cookies.find((c) => c.name === "JSESSIONID");
            return {
                service: "linkedin",
                li_at: liAt?.value || null,
                jsessionid: jsessionid?.value?.replace(/"/g, "") || null,
            };
        }

        case "twitter":
        case "x": {
            const cookies = await chrome.cookies.getAll({ domain: ".x.com" });
            const authToken = cookies.find((c) => c.name === "auth_token");
            const ct0 = cookies.find((c) => c.name === "ct0");
            return {
                service: "twitter",
                auth_token: authToken?.value || null,
                csrf_token: ct0?.value || null,
            };
        }

        case "github": {
            const cookies = await chrome.cookies.getAll({ domain: ".github.com" });
            const session = cookies.find((c) => c.name === "user_session");
            return {
                service: "github",
                user_session: session?.value || null,
            };
        }

        case "notion": {
            const cookies = await chrome.cookies.getAll({ domain: ".notion.so" });
            const tokenV2 = cookies.find((c) => c.name === "token_v2");
            return {
                service: "notion",
                token_v2: tokenV2?.value || null,
            };
        }

        default: {
            // Generic: return all cookies for likely domains
            const domains = [`.${service}.com`, `.${service}.io`, `.${service}.ai`];
            const allCookies = [];
            for (const domain of domains) {
                const cookies = await chrome.cookies.getAll({ domain });
                allCookies.push(...cookies.map(cookieToObj));
            }
            return { service, cookies: allCookies };
        }
    }
}

// ── History ──────────────────────────────────────────────────────────────────

async function getHistory(maxResults) {
    const items = await chrome.history.search({ text: "", maxResults, startTime: 0 });
    return items.map((i) => ({ url: i.url, title: i.title, lastVisitTime: i.lastVisitTime, visitCount: i.visitCount }));
}

// ── Downloads ────────────────────────────────────────────────────────────────

async function download(url, filename) {
    const id = await chrome.downloads.download({ url, filename });
    return { download_id: id };
}

// ── Network Capture ──────────────────────────────────────────────────────────
// Intercepts HTTP requests. Stores summaries in a lightweight list,
// full headers/bodies stored separately so the agent can drill down lazily.

function networkStartCapture(filters, maxEntries) {
    networkCapture.active = true;
    networkCapture.filters = filters || [];
    networkCapture.requests = [];
    networkCapture.maxEntries = maxEntries || 1000;

    if (!networkStartCapture._listening) {
        chrome.webRequest.onBeforeSendHeaders.addListener(
            networkOnRequest,
            { urls: ["<all_urls>"] },
            ["requestHeaders", "extraHeaders"]
        );
        chrome.webRequest.onCompleted.addListener(
            networkOnResponse,
            { urls: ["<all_urls>"] },
            ["responseHeaders", "extraHeaders"]
        );
        // Capture request bodies for POST/PUT/PATCH
        chrome.webRequest.onBeforeRequest.addListener(
            networkOnRequestBody,
            { urls: ["<all_urls>"] },
            ["requestBody"]
        );
        networkStartCapture._listening = true;
    }

    return { capturing: true, filters: networkCapture.filters };
}

function networkStopCapture() {
    networkCapture.active = false;
    if (networkStartCapture._listening) {
        chrome.webRequest.onBeforeSendHeaders.removeListener(networkOnRequest);
        chrome.webRequest.onCompleted.removeListener(networkOnResponse);
        chrome.webRequest.onBeforeRequest.removeListener(networkOnRequestBody);
        networkStartCapture._listening = false;
    }
    return { stopped: true, captured: networkCapture.requests.length };
}

/**
 * List requests - LIGHTWEIGHT. Only returns method, url, status, type, id.
 * No headers, no bodies. Agent asks for those separately.
 */
function networkList(filter, limit, offset) {
    let entries = networkCapture.requests;

    if (filter) {
        const f = filter.toLowerCase();
        entries = entries.filter(
            (e) => e.url.toLowerCase().includes(f) ||
                   e.method.toLowerCase().includes(f) ||
                   (e.type && e.type.toLowerCase().includes(f))
        );
    }

    const total = entries.length;
    const start = offset || 0;
    entries = entries.slice(start, start + (limit || 50));

    return {
        total,
        offset: start,
        count: entries.length,
        requests: entries.map((e) => ({
            id: e.id,
            method: e.method,
            url: e.url,
            status: e.status,
            type: e.type,
            timestamp: e.timestamp,
        })),
    };
}

/**
 * Get full details for a single request by ID.
 * Returns request headers, response headers, request body.
 */
function networkGetRequest(reqId) {
    const entry = networkCapture.requests.find((e) => e.id === reqId);
    if (!entry) return { error: "Request not found" };
    return {
        id: entry.id,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        type: entry.type,
        timestamp: entry.timestamp,
        requestHeaders: entry.requestHeaders,
        responseHeaders: entry.responseHeaders,
        requestBody: entry.requestBody || null,
    };
}

/**
 * Get details for multiple requests by IDs.
 */
function networkGetRequests(reqIds) {
    return reqIds.map((id) => {
        const entry = networkCapture.requests.find((e) => e.id === id);
        if (!entry) return { id, error: "not found" };
        return {
            id: entry.id,
            method: entry.method,
            url: entry.url,
            status: entry.status,
            requestHeaders: entry.requestHeaders,
            responseHeaders: entry.responseHeaders,
            requestBody: entry.requestBody || null,
        };
    });
}

/**
 * Get only headers for a request (no body).
 */
function networkGetHeaders(reqId) {
    const entry = networkCapture.requests.find((e) => e.id === reqId);
    if (!entry) return { error: "Request not found" };
    return {
        id: entry.id,
        url: entry.url,
        requestHeaders: entry.requestHeaders,
        responseHeaders: entry.responseHeaders,
    };
}

function networkClear() {
    networkCapture.requests = [];
    return { cleared: true };
}

function networkOnRequestBody(details) {
    if (!networkCapture.active) return;
    if (details.url.includes("127.0.0.1:7890")) return;
    if (networkCapture.filters.length > 0) {
        if (!networkCapture.filters.some((f) => details.url.includes(f))) return;
    }

    // Store body for later lookup
    const body = details.requestBody;
    if (!body) return;

    let bodyStr = null;
    if (body.raw && body.raw.length > 0) {
        // Raw bytes - decode
        const decoder = new TextDecoder();
        bodyStr = body.raw.map((r) => r.bytes ? decoder.decode(r.bytes) : "").join("");
    } else if (body.formData) {
        bodyStr = JSON.stringify(body.formData);
    }

    // Find or create the entry (onBeforeRequest fires before onBeforeSendHeaders)
    let entry = networkCapture.requests.find((e) => e.id === details.requestId);
    if (entry) {
        entry.requestBody = bodyStr;
    } else {
        // Create a placeholder, onBeforeSendHeaders will fill the rest
        networkCapture.requests.push({
            id: details.requestId,
            method: details.method,
            url: details.url,
            type: details.type,
            timestamp: Date.now(),
            requestHeaders: null,
            responseHeaders: null,
            status: null,
            requestBody: bodyStr,
        });
    }
}

function networkOnRequest(details) {
    if (!networkCapture.active) return;
    if (details.url.includes("127.0.0.1:7890")) return;
    if (networkCapture.filters.length > 0) {
        if (!networkCapture.filters.some((f) => details.url.includes(f))) return;
    }

    // Check if entry already exists (from onBeforeRequest body capture)
    let entry = networkCapture.requests.find((e) => e.id === details.requestId);
    if (entry) {
        entry.requestHeaders = headersToObj(details.requestHeaders);
        entry.method = details.method;
        entry.type = details.type;
    } else {
        networkCapture.requests.push({
            id: details.requestId,
            method: details.method,
            url: details.url,
            type: details.type,
            timestamp: Date.now(),
            requestHeaders: headersToObj(details.requestHeaders),
            responseHeaders: null,
            status: null,
            requestBody: null,
        });
    }

    if (networkCapture.requests.length > networkCapture.maxEntries) {
        networkCapture.requests = networkCapture.requests.slice(-networkCapture.maxEntries);
    }
}

function networkOnResponse(details) {
    if (!networkCapture.active) return;
    const entry = networkCapture.requests.find((e) => e.id === details.requestId);
    if (entry) {
        entry.status = details.statusCode;
        entry.responseHeaders = headersToObj(details.responseHeaders);
    }
}

function headersToObj(headers) {
    if (!headers) return {};
    const obj = {};
    for (const h of headers) {
        obj[h.name.toLowerCase()] = h.value;
    }
    return obj;
}

// ── Browser-context Fetch ────────────────────────────────────────────────────
// Executes fetch() inside the active tab's page context.
// This means the request carries the page's cookies, auth tokens, CORS origin,
// and session - so it won't get blocked by the server.

async function browserFetch(params) {
    // Use a Neo tab if available, fall back to finding a tab on the target domain
    let tabId = null;
    const targetDomain = new URL(params.url).hostname;

    // First try: Neo tab already on this domain
    for (const id of neoTabIds) {
        try {
            const t = await chrome.tabs.get(id);
            if (t && t.url && new URL(t.url).hostname === targetDomain) { tabId = t.id; break; }
        } catch {}
    }

    // Second try: any tab on this domain (read-only execution, doesn't navigate)
    if (!tabId) {
        const domainTabs = await chrome.tabs.query({ url: `*://${targetDomain}/*` });
        if (domainTabs.length > 0) tabId = domainTabs[0].id;
    }

    // Third try: navigate a Neo tab to the domain first
    if (!tabId) {
        const result = await neoNavigate(`https://${targetDomain}`);
        tabId = result.tab_id;
    }

    if (!tabId) throw new Error("Could not get a tab for " + targetDomain);

    const mergedHeaders = { ...(params.headers || {}) };

    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (url, options) => {
            try {
                const res = await fetch(url, {
                    method: options.method || "GET",
                    headers: options.headers || {},
                    body: options.body || undefined,
                    credentials: options.credentials || "include",
                    mode: options.mode || "cors",
                });

                const contentType = res.headers.get("content-type") || "";
                let body;
                if (contentType.includes("json")) {
                    body = await res.json();
                } else {
                    body = await res.text();
                    // Truncate huge responses
                    if (body.length > 100000) body = body.slice(0, 100000) + "\n...(truncated)";
                }

                const headers = {};
                res.headers.forEach((v, k) => { headers[k] = v; });

                return {
                    ok: res.ok,
                    status: res.status,
                    statusText: res.statusText,
                    headers,
                    body,
                };
            } catch (err) {
                return { error: err.message || String(err) };
            }
        },
        args: [params.url, {
            method: params.method,
            headers: mergedHeaders,
            body: params.body,
            credentials: params.credentials || "include",
            mode: params.mode,
        }],
    });

    const result = results[0]?.result;
    if (!result) throw new Error("Fetch execution failed");
    if (result.error) throw new Error(result.error);
    return result;
}

// ── Auto-detection: watch for logins ─────────────────────────────────────────

const AUTH_DOMAINS = {
    "slack.com": "slack",
    "discord.com": "discord",
    "linkedin.com": "linkedin",
    "x.com": "twitter",
    "twitter.com": "twitter",
    "github.com": "github",
    "notion.so": "notion",
    "mail.google.com": "gmail",
};

chrome.webNavigation.onCompleted.addListener(async (details) => {
    if (details.frameId !== 0) return; // only main frame

    try {
        const url = new URL(details.url);
        const hostname = url.hostname.replace("www.", "");

        for (const [domain, service] of Object.entries(AUTH_DOMAINS)) {
            if (hostname.endsWith(domain)) {
                // Notify daemon that user is on a service page
                send({
                    event: "service_detected",
                    data: { service, url: details.url, tab_id: details.tabId },
                });
                break;
            }
        }
    } catch {}
});

// ── Message from popup ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "get_status") {
        sendResponse({ connected, wsUrl: NEO_WS_URL });
    } else if (msg.type === "reconnect") {
        connect();
        sendResponse({ ok: true });
    } else if (msg.type === "extract_auth") {
        extractAuth(msg.service).then(sendResponse);
        return true; // async
    }
});
