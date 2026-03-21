/**
 * Slack integration for Neo MCP.
 *
 * Uses browser-extracted tokens (xoxc- with d cookie, or xoxp-/xoxb-).
 * Credentials are stored via Neo's credential system (extract_auth).
 */

const API = "https://slack.com/api";

export interface SlackAuth {
    token: string;
    cookie?: string; // d cookie for xoxc- tokens
}

// ── API Layer ────────────────────────────────────────────────────────────────

async function slackApi<T = any>(
    auth: SlackAuth,
    method: string,
    params: Record<string, string> = {}
): Promise<T> {
    const isClientToken = auth.token.startsWith("xoxc-");

    if (isClientToken) {
        const body = new URLSearchParams({ token: auth.token, ...params });
        const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
        if (auth.cookie) headers["Cookie"] = auth.cookie;
        const res = await fetch(`${API}/${method}`, { method: "POST", headers, body: body.toString() });
        const data = await res.json();
        if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
        return data as T;
    }

    // Standard xoxp/xoxb token
    const url = new URL(`${API}/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${auth.token}` } });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
    return data as T;
}

async function slackApiJson<T = any>(
    auth: SlackAuth,
    method: string,
    body: Record<string, any>
): Promise<T> {
    if (auth.token.startsWith("xoxc-")) {
        const form = new URLSearchParams({ token: auth.token });
        for (const [k, v] of Object.entries(body)) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
        const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
        if (auth.cookie) headers["Cookie"] = auth.cookie;
        const res = await fetch(`${API}/${method}`, { method: "POST", headers, body: form.toString() });
        const data = await res.json();
        if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
        return data as T;
    }

    const res = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
    return data as T;
}

// ── Caches ───────────────────────────────────────────────────────────────────

const channelCaches = new Map<string, Map<string, string>>(); // name → id
const userCaches = new Map<string, Map<string, string>>(); // userId → displayName

async function resolveChannelId(auth: SlackAuth, nameOrId: string): Promise<string> {
    if (/^[A-Z0-9]+$/.test(nameOrId)) return nameOrId;
    if (!channelCaches.has(auth.token)) {
        const cache = new Map<string, string>();
        let cursor = "";
        do {
            const data = await slackApi<any>(auth, "conversations.list", {
                types: "public_channel,private_channel,mpim,im", limit: "200",
                ...(cursor ? { cursor } : {}),
            });
            for (const ch of data.channels || []) cache.set(ch.name, ch.id);
            cursor = data.response_metadata?.next_cursor || "";
        } while (cursor);
        channelCaches.set(auth.token, cache);
    }
    return channelCaches.get(auth.token)!.get(nameOrId.replace(/^#/, "")) || nameOrId;
}

async function resolveUserName(auth: SlackAuth, userId: string): Promise<string> {
    if (!userCaches.has(auth.token)) userCaches.set(auth.token, new Map());
    const cache = userCaches.get(auth.token)!;
    if (cache.has(userId)) return cache.get(userId)!;
    try {
        const data = await slackApi<any>(auth, "users.info", { user: userId });
        const name = data.user?.profile?.display_name || data.user?.real_name || userId;
        cache.set(userId, name);
        return name;
    } catch {
        cache.set(userId, userId);
        return userId;
    }
}

// ── Channels ─────────────────────────────────────────────────────────────────

export async function listChannels(auth: SlackAuth): Promise<Array<{
    id: string; name: string; isMember: boolean; numMembers: number; topic: string; purpose: string;
}>> {
    const channels: Array<{ id: string; name: string; isMember: boolean; numMembers: number; topic: string; purpose: string }> = [];
    let cursor = "";
    do {
        const data = await slackApi<any>(auth, "conversations.list", {
            types: "public_channel,private_channel", limit: "200",
            ...(cursor ? { cursor } : {}),
        });
        for (const ch of data.channels || []) {
            channels.push({
                id: ch.id, name: ch.name, isMember: ch.is_member, numMembers: ch.num_members || 0,
                topic: ch.topic?.value || "", purpose: ch.purpose?.value || "",
            });
        }
        cursor = data.response_metadata?.next_cursor || "";
    } while (cursor);
    return channels;
}

export async function getChannelInfo(auth: SlackAuth, channel: string): Promise<any> {
    const channelId = await resolveChannelId(auth, channel);
    const data = await slackApi<any>(auth, "conversations.info", { channel: channelId });
    return data.channel;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface SlackMessage {
    id: string;
    channel: string;
    channelName: string;
    from: string;
    text: string;
    timestamp: Date;
    threadId?: string;
    replyCount?: number;
}

export async function readMessages(auth: SlackAuth, channel: string, opts: {
    limit?: number; oldest?: number; latest?: number; includeDMs?: boolean;
} = {}): Promise<SlackMessage[]> {
    const { limit = 50, oldest, latest } = opts;
    const channelId = await resolveChannelId(auth, channel);
    const params: Record<string, string> = { channel: channelId, limit: String(Math.min(limit, 200)) };
    if (oldest) params.oldest = (oldest / 1000).toFixed(6);
    if (latest) params.latest = (latest / 1000).toFixed(6);

    const data = await slackApi<any>(auth, "conversations.history", params);
    const messages: SlackMessage[] = [];
    for (const msg of data.messages || []) {
        if (!msg.text || msg.type !== "message") continue;
        const from = msg.user ? await resolveUserName(auth, msg.user) : (msg.bot_profile?.name || "bot");
        messages.push({
            id: msg.ts || "", channel: channelId, channelName: channel.replace(/^#/, ""),
            from, text: msg.text, timestamp: new Date(parseFloat(msg.ts || "0") * 1000),
            threadId: msg.thread_ts, replyCount: msg.reply_count,
        });
    }
    return messages;
}

export async function readThread(auth: SlackAuth, channel: string, threadTs: string, limit = 50): Promise<SlackMessage[]> {
    const channelId = await resolveChannelId(auth, channel);
    const data = await slackApi<any>(auth, "conversations.replies", {
        channel: channelId, ts: threadTs, limit: String(Math.min(limit, 200)),
    });
    const messages: SlackMessage[] = [];
    for (const msg of data.messages || []) {
        if (!msg.text) continue;
        const from = msg.user ? await resolveUserName(auth, msg.user) : (msg.bot_profile?.name || "bot");
        messages.push({
            id: msg.ts || "", channel: channelId, channelName: channel,
            from, text: msg.text, timestamp: new Date(parseFloat(msg.ts || "0") * 1000),
            threadId: msg.thread_ts,
        });
    }
    return messages;
}

export async function readDMs(auth: SlackAuth, limit = 20): Promise<SlackMessage[]> {
    const ims = await slackApi<any>(auth, "conversations.list", { types: "im", limit: "50" });
    const messages: SlackMessage[] = [];
    for (const im of (ims.channels || []).slice(0, 20)) {
        try {
            const history = await slackApi<any>(auth, "conversations.history", {
                channel: im.id, limit: String(Math.min(limit, 50)),
            });
            for (const msg of history.messages || []) {
                if (!msg.text || msg.type !== "message") continue;
                const from = msg.user ? await resolveUserName(auth, msg.user) : "unknown";
                messages.push({
                    id: msg.ts || "", channel: im.id, channelName: `DM:${from}`,
                    from, text: msg.text, timestamp: new Date(parseFloat(msg.ts || "0") * 1000),
                    threadId: msg.thread_ts,
                });
            }
        } catch {}
    }
    return messages;
}

export async function searchMessages(auth: SlackAuth, query: string, opts: {
    limit?: number; sort?: "score" | "timestamp";
} = {}): Promise<Array<SlackMessage & { permalink?: string }>> {
    const { limit = 20, sort = "timestamp" } = opts;
    const data = await slackApi<any>(auth, "search.messages", {
        query, count: String(limit), sort, sort_dir: "desc",
    });
    const results: Array<SlackMessage & { permalink?: string }> = [];
    for (const match of data.messages?.matches || []) {
        results.push({
            id: match.ts || "", channel: match.channel?.id || "", channelName: match.channel?.name || "",
            from: match.username || match.user || "", text: match.text || "",
            timestamp: new Date(parseFloat(match.ts || "0") * 1000),
            threadId: match.permalink?.includes("thread_ts=") ? match.permalink.split("thread_ts=")[1] : undefined,
            permalink: match.permalink,
        });
    }
    return results;
}

// ── Sending ──────────────────────────────────────────────────────────────────

export async function postMessage(auth: SlackAuth, channel: string, text: string, threadTs?: string): Promise<string> {
    const channelId = await resolveChannelId(auth, channel);
    const body: Record<string, any> = { channel: channelId, text };
    if (threadTs) body.thread_ts = threadTs;
    const result = await slackApiJson<any>(auth, "chat.postMessage", body);
    return result.ts;
}

export async function addReaction(auth: SlackAuth, channel: string, timestamp: string, emoji: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApi<any>(auth, "reactions.add", { channel: channelId, timestamp, name: emoji.replace(/:/g, "") });
}

export async function removeReaction(auth: SlackAuth, channel: string, timestamp: string, emoji: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApi<any>(auth, "reactions.remove", { channel: channelId, timestamp, name: emoji.replace(/:/g, "") });
}

export async function updateMessage(auth: SlackAuth, channel: string, timestamp: string, text: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApiJson<any>(auth, "chat.update", { channel: channelId, ts: timestamp, text });
}

export async function deleteMessage(auth: SlackAuth, channel: string, timestamp: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApi<any>(auth, "chat.delete", { channel: channelId, ts: timestamp });
}

export async function setChannelTopic(auth: SlackAuth, channel: string, topic: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApi<any>(auth, "conversations.setTopic", { channel: channelId, topic });
}

export async function setChannelPurpose(auth: SlackAuth, channel: string, purpose: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApi<any>(auth, "conversations.setPurpose", { channel: channelId, purpose });
}

// ── Users ────────────────────────────────────────────────────────────────────

export async function listUsers(auth: SlackAuth): Promise<Array<{
    id: string; name: string; realName: string; displayName: string; email: string; isBot: boolean; isAdmin: boolean;
}>> {
    const users: Array<{ id: string; name: string; realName: string; displayName: string; email: string; isBot: boolean; isAdmin: boolean }> = [];
    let cursor = "";
    do {
        const data = await slackApi<any>(auth, "users.list", { limit: "200", ...(cursor ? { cursor } : {}) });
        for (const u of data.members || []) {
            if (u.deleted) continue;
            users.push({
                id: u.id, name: u.name, realName: u.real_name || "",
                displayName: u.profile?.display_name || u.real_name || u.name,
                email: u.profile?.email || "", isBot: !!u.is_bot, isAdmin: !!u.is_admin,
            });
        }
        cursor = data.response_metadata?.next_cursor || "";
    } while (cursor);
    return users;
}

export async function getUserProfile(auth: SlackAuth, userId: string): Promise<any> {
    const data = await slackApi<any>(auth, "users.info", { user: userId });
    return data.user;
}

export async function setStatus(auth: SlackAuth, text: string, emoji?: string, expiration?: number): Promise<void> {
    const profile: Record<string, any> = { status_text: text, status_emoji: emoji || "" };
    if (expiration) profile.status_expiration = expiration;
    await slackApiJson<any>(auth, "users.profile.set", { profile });
}

// ── Channels Management ──────────────────────────────────────────────────────

export async function createChannel(auth: SlackAuth, name: string, isPrivate = false): Promise<any> {
    const data = await slackApiJson<any>(auth, "conversations.create", { name, is_private: isPrivate });
    return data.channel;
}

export async function archiveChannel(auth: SlackAuth, channel: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApi<any>(auth, "conversations.archive", { channel: channelId });
}

export async function inviteToChannel(auth: SlackAuth, channel: string, userIds: string[]): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApiJson<any>(auth, "conversations.invite", { channel: channelId, users: userIds.join(",") });
}

export async function kickFromChannel(auth: SlackAuth, channel: string, userId: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApi<any>(auth, "conversations.kick", { channel: channelId, user: userId });
}

// ── Pins & Bookmarks ────────────────────────────────────────────────────────

export async function pinMessage(auth: SlackAuth, channel: string, timestamp: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApi<any>(auth, "pins.add", { channel: channelId, timestamp });
}

export async function unpinMessage(auth: SlackAuth, channel: string, timestamp: string): Promise<void> {
    const channelId = await resolveChannelId(auth, channel);
    await slackApi<any>(auth, "pins.remove", { channel: channelId, timestamp });
}

export async function listPins(auth: SlackAuth, channel: string): Promise<any[]> {
    const channelId = await resolveChannelId(auth, channel);
    const data = await slackApi<any>(auth, "pins.list", { channel: channelId });
    return data.items || [];
}
