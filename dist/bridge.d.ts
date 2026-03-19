/**
 * WebSocket bridge to the Neo Browser Extension.
 *
 * First instance starts a WebSocket SERVER on port 7890 — the extension connects here.
 * Additional instances connect as CLIENTS to the existing server, which proxies
 * commands to the extension. All MCP instances share one extension connection.
 */
export declare function startBridge(port?: number): Promise<void>;
export declare function isBridgeConnected(): boolean;
export declare function browserCommand(method: string, params?: Record<string, any>, timeoutMs?: number): Promise<any>;
