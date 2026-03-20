/**
 * Neo Bridge - Page World Helper
 *
 * Runs in the page's MAIN world (not the isolated content script world).
 * This means window.__neo_call is visible to any page JS, including
 * Claude in Chrome's javascript_tool.
 *
 * Communication: postMessage → content.js (isolated world) → background.js
 */

(function () {
    if (window.__neo_bridge_available) return;

    window.__neo_bridge_available = true;

    /**
     * Call a Neo Bridge command and get the result.
     * @param {string} method - Command name (e.g. "extract_auth", "browser_fetch")
     * @param {object} params - Command parameters
     * @returns {Promise<any>} - Command result
     */
    window.__neo_call = function (method, params) {
        return new Promise(function (resolve, reject) {
            var id = "neo_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
            var timeout = setTimeout(function () {
                window.removeEventListener("message", handler);
                reject(new Error("Neo command timed out after 30s"));
            }, 30000);

            function handler(event) {
                if (event.source !== window) return;
                if (!event.data || event.data.type !== "neo_response") return;
                if (event.data.id !== id) return;
                window.removeEventListener("message", handler);
                clearTimeout(timeout);
                var res = event.data.result;
                if (res && res.error) reject(new Error(res.error));
                else resolve(res);
            }

            window.addEventListener("message", handler);
            window.postMessage(
                { type: "neo_command", id: id, method: method, params: params || {} },
                "*"
            );
        });
    };
})();
