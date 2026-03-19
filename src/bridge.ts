/**
 * WebSocket bridge to the Neo Browser Extension.
 *
 * First instance starts a WebSocket SERVER on port 7890 — the extension connects here.
 * Additional instances connect as CLIENTS to the existing server, which proxies
 * commands to the extension. All MCP instances share one extension connection.
 */

import { WebSocketServer, WebSocket } from "ws";

const DEFAULT_PORT = 7890;

let extensionSocket: WebSocket | null = null;
let pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let nextId = 1;
let mode: "server" | "client" | null = null;

// ── Server mode (first instance) ─────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let clientSockets = new Set<WebSocket>(); // other MCP instances connected as clients

function startServer(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        wss = new WebSocketServer({ host: "127.0.0.1", port });

        wss.on("listening", () => {
            mode = "server";
            console.error(`[neo-mcp] Bridge server on ws://127.0.0.1:${port}`);
            resolve();
        });

        wss.on("error", (err: any) => {
            if (err.code === "EADDRINUSE") {
                wss = null;
                reject(err); // signal to try client mode
            }
        });

        wss.on("connection", (ws) => {
            // First message determines if this is the extension or another MCP instance
            let identified = false;

            ws.on("message", (data) => {
                let msg: any;
                try { msg = JSON.parse(data.toString()); } catch { return; }

                // Extension sends {event: "bridge_connected"} on connect
                if (!identified && msg.event === "bridge_connected") {
                    identified = true;
                    console.error("[neo-mcp] Browser extension connected");
                    extensionSocket = ws;
                    return;
                }

                // Extension sends responses to our commands
                if (extensionSocket === ws && msg.id && pendingRequests.has(msg.id)) {
                    const pending = pendingRequests.get(msg.id)!;
                    pendingRequests.delete(msg.id);
                    clearTimeout(pending.timer);
                    if (msg.error) pending.reject(new Error(msg.error.message || "Bridge error"));
                    else pending.resolve(msg.result);
                    return;
                }

                // Extension sends responses — might be for a proxied client request
                if (extensionSocket === ws && msg.id) {
                    // Forward response to all clients (the one that sent it will match the id)
                    for (const client of clientSockets) {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(data.toString());
                        }
                    }
                    return;
                }

                // Client MCP instance sending a command — proxy to extension
                if (!identified) {
                    identified = true;
                    clientSockets.add(ws);
                    console.error("[neo-mcp] Client MCP instance connected");
                }

                if (extensionSocket && extensionSocket.readyState === WebSocket.OPEN) {
                    extensionSocket.send(data.toString());
                } else {
                    ws.send(JSON.stringify({ id: msg.id, error: { message: "Browser extension not connected" } }));
                }
            });

            ws.on("close", () => {
                if (extensionSocket === ws) {
                    console.error("[neo-mcp] Browser extension disconnected");
                    extensionSocket = null;
                }
                clientSockets.delete(ws);
            });

            ws.on("error", () => {});
        });
    });
}

// ── Client mode (additional instances) ───────────────────────────────────────

let clientWs: WebSocket | null = null;

function startClient(port: number): Promise<void> {
    return new Promise((resolve) => {
        clientWs = new WebSocket(`ws://127.0.0.1:${port}`);

        clientWs.on("open", () => {
            mode = "client";
            console.error(`[neo-mcp] Connected to existing bridge on port ${port}`);
            resolve();
        });

        clientWs.on("message", (data) => {
            let msg: any;
            try { msg = JSON.parse(data.toString()); } catch { return; }

            if (msg.id && pendingRequests.has(msg.id)) {
                const pending = pendingRequests.get(msg.id)!;
                pendingRequests.delete(msg.id);
                clearTimeout(pending.timer);
                if (msg.error) pending.reject(new Error(msg.error.message || "Bridge error"));
                else pending.resolve(msg.result);
            }
        });

        clientWs.on("close", () => {
            console.error("[neo-mcp] Lost connection to bridge server");
            clientWs = null;
        });

        clientWs.on("error", () => {
            // Can't connect — bridge server may have died
            console.error("[neo-mcp] Could not connect to bridge server");
            clientWs = null;
            resolve(); // don't crash, just run without bridge
        });
    });
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startBridge(port = DEFAULT_PORT): Promise<void> {
    try {
        await startServer(port);
    } catch {
        // Port taken — another MCP instance is already running the server
        await startClient(port);
    }
}

export function isBridgeConnected(): boolean {
    if (mode === "server") {
        return extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN;
    }
    if (mode === "client") {
        return clientWs !== null && clientWs.readyState === WebSocket.OPEN;
    }
    return false;
}

export function browserCommand(method: string, params: Record<string, any> = {}, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
        const socket = mode === "server" ? extensionSocket : clientWs;

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            reject(new Error("Browser extension not connected. Make sure Chrome is running with the Neo Bridge extension."));
            return;
        }

        const id = nextId++;
        const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error(`Browser command "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pendingRequests.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
    });
}
