/**
 * LinkedIn integration via Voyager API.
 * Uses li_at cookie + JSESSIONID (csrf) extracted from browser.
 *
 * All requests go through the browser extension (browserFetch) because
 * LinkedIn blocks direct Node.js fetch via TLS fingerprinting / Cloudflare.
 */

const VOYAGER = "https://www.linkedin.com/voyager/api";

export interface LinkedInAuth {
    li_at: string;
    jsessionid: string;
}

// Set by the MCP server at init
let _browserCommand: ((method: string, params: Record<string, any>) => Promise<any>) | null = null;

export function setBrowserCommand(fn: (method: string, params: Record<string, any>) => Promise<any>) {
    _browserCommand = fn;
}

async function linkedinApi<T = any>(
    auth: LinkedInAuth,
    path: string,
    options: { method?: string; body?: any; params?: Record<string, string> } = {}
): Promise<T> {
    const url = new URL(`${VOYAGER}${path}`);
    if (options.params) {
        for (const [k, v] of Object.entries(options.params)) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
        "csrf-token": auth.jsessionid,
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
        "Accept": "application/vnd.linkedin.normalized+json+2.1",
    };

    if (options.body) {
        headers["Content-Type"] = "application/json";
    }

    // Route through browser extension — carries real browser TLS fingerprint
    if (_browserCommand) {
        const result = await _browserCommand("browser_fetch", {
            url: url.toString(),
            method: options.method || "GET",
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            credentials: "include",
        });

        if (result.error) throw new Error(result.error);
        if (!result.ok) {
            const text = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
            throw new Error(`LinkedIn API ${result.status}: ${text.slice(0, 200)}`);
        }

        return result.body as T;
    }

    // Fallback: direct fetch (may fail due to TLS fingerprinting)
    headers["Cookie"] = `li_at=${auth.li_at}; JSESSIONID="${auth.jsessionid}"`;
    headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    const response = await fetch(url.toString(), {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`LinkedIn API ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json() as Promise<T>;
}

/** Get the authenticated user's mini-profile (objectUrn, name) */
async function getMe(auth: LinkedInAuth): Promise<{ objectUrn: string; entityUrn: string }> {
    const data = await linkedinApi(auth, `/me`);
    const profile = data.miniProfile || data;
    return {
        objectUrn: profile.objectUrn || "",
        entityUrn: profile.entityUrn || profile.objectUrn || "",
    };
}

/** Get a user's profile by vanity name (the URL slug) */
export async function getProfile(auth: LinkedInAuth, vanityName: string): Promise<any> {
    // The old /identity/profiles/{name}/profileView returns 410 (Gone).
    // Use the dash endpoint with memberIdentity query.
    const data = await linkedinApi(auth, `/identity/dash/profiles`, {
        params: {
            q: "memberIdentity",
            memberIdentity: vanityName,
            decorationId: "com.linkedin.voyager.dash.deco.identity.profile.FullProfile-91",
        },
    });

    // Normalized response: find the Profile entity in the included array
    const included: any[] = data.included || [];
    const profile = included.find((e: any) =>
        e.$type?.includes("Profile") && (e.firstName || e.publicIdentifier)
    ) || {};

    return {
        firstName: profile.firstName,
        lastName: profile.lastName,
        headline: profile.headline?.text || profile.headline,
        summary: profile.summary?.text || profile.summary,
        location: profile.geoLocation?.geo?.defaultLocalizedName
            || profile.geoLocationName
            || profile.locationName,
        industry: profile.industry?.name || profile.industryName,
        publicId: profile.publicIdentifier || vanityName,
        connections: profile.connectionsCount || profile.connectionCount,
        followers: profile.followersCount || profile.followerCount,
    };
}

/** Get the authenticated user's own posts with engagement metrics */
export async function getMyPosts(auth: LinkedInAuth, count = 20): Promise<any[]> {
    // Get our member URN to filter to own posts only
    let memberUrn = "";
    try {
        const me = await getMe(auth);
        memberUrn = me.objectUrn;
    } catch {}

    const params: Record<string, string> = {
        count: String(count),
        q: "memberShareFeed",
        moduleKey: "memberShareFeed",
        start: "0",
        paginationToken: "",
    };
    if (memberUrn) params.memberUrn = memberUrn;

    const data = await linkedinApi(auth, `/feed/updatesV2`, { params });
    return extractPosts(data, count);
}

/** Get the user's feed */
export async function getFeed(auth: LinkedInAuth, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/feed/updatesV2`, {
        params: {
            count: String(count),
            q: "relevance",
            start: "0",
            paginationToken: "",
        },
    });

    return extractPosts(data, count);
}

function extractPosts(data: any, max: number): any[] {
    // LinkedIn's normalized response puts ALL entities in `included`.
    // engagement data (socialDetail) lives as a separate entity referenced
    // by URN via the "*socialDetail" pointer field on the update entity.
    const included: any[] = data.included || data.elements || [];

    // Build a URN → entity map for cross-referencing
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn || item.urn || item.updateUrn;
        if (urn) byUrn.set(urn, item);
    }

    const posts: any[] = [];

    for (const item of included) {
        if (posts.length >= max) break;

        // Only process update items (skip authors, social details, etc.)
        const isUpdate = item["$type"]?.includes("UpdateV2")
            || item["$type"]?.includes("update.Update")
            || !!item.updateUrn;
        if (!isUpdate) continue;

        // Extract post text from commentary (several nesting shapes exist)
        const commentary = item.commentary?.text?.text
            || item.commentary?.text
            || item.value?.["com.linkedin.voyager.feed.render.UpdateV2"]?.commentary?.text?.text
            || "";

        if (!commentary) continue;

        // Look up the socialDetail entity by URN reference.
        // LinkedIn stores the reference as "*socialDetail" (a URN pointer).
        const socialDetailUrn = item["*socialDetail"];
        const socialDetail = socialDetailUrn
            ? byUrn.get(socialDetailUrn)
            : item.socialDetail;

        const socialCounts = socialDetail?.totalSocialActivityCounts || {};

        posts.push({
            text: commentary.slice(0, 1000),
            created: item.createdAt ? new Date(item.createdAt).toISOString() : null,
            likes: socialCounts.numLikes || 0,
            comments: socialCounts.numComments || 0,
            reposts: socialCounts.numShares || 0,
            impressions: socialCounts.numImpressions || null,
            urn: item.updateUrn || item.urn,
        });
    }

    return posts;
}

/** Create a text post */
export async function createPost(auth: LinkedInAuth, text: string): Promise<any> {
    // Get author URN (needed for UGC post format)
    let authorUrn = "";
    try {
        const me = await getMe(auth);
        // objectUrn is like "urn:li:member:12345" — need "urn:li:person:12345" for authoring
        authorUrn = me.objectUrn.replace("urn:li:member:", "urn:li:person:");
    } catch {}

    // Use normShares — the replacement for the deprecated /contentcreation/shares endpoint
    const body: any = {
        visibleToGuest: true,
        commentary: {
            text,
            attributes: [],
        },
        distribution: {
            feedDistribution: "MAIN_FEED",
            thirdPartyDistributionChannels: [],
        },
    };
    if (authorUrn) body.author = authorUrn;

    const data = await linkedinApi(auth, `/contentcreation/normShares`, {
        method: "POST",
        body,
    });

    return { posted: true, urn: data.urn || data.value?.urn };
}

/** Search for people */
export async function searchPeople(auth: LinkedInAuth, query: string, count = 10): Promise<any[]> {
    const data = await linkedinApi(auth, `/search/dash/clusters`, {
        params: {
            origin: "GLOBAL_SEARCH_HEADER",
            q: "all",
            keywords: query,
            "resultType": "PEOPLE",
            count: String(count),
            start: "0",
        },
    });

    const included = data.included || [];
    return included
        .filter((e: any) => e.firstName || e.title?.text)
        .slice(0, count)
        .map((p: any) => ({
            name: p.title?.text || `${p.firstName} ${p.lastName}`,
            headline: p.headline?.text || p.headline || "",
            publicId: p.publicIdentifier || "",
            location: p.subline?.text || "",
        }));
}

/** Get connections */
export async function getConnections(auth: LinkedInAuth, count = 50): Promise<any[]> {
    const data = await linkedinApi(auth, `/relationships/dash/connections`, {
        params: {
            count: String(count),
            q: "search",
            sortType: "RECENTLY_ADDED",
            start: "0",
        },
    });

    const included = data.included || [];
    return included
        .filter((e: any) => e.firstName)
        .slice(0, count)
        .map((c: any) => ({
            name: `${c.firstName} ${c.lastName}`,
            headline: c.headline || "",
            publicId: c.publicIdentifier || "",
        }));
}

// ── Messaging ────────────────────────────────────────────────────────────────

/** List recent message conversations */
export async function getConversations(auth: LinkedInAuth, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/messaging/conversations`, {
        params: {
            keyVersion: "LEGACY_INBOX",
            count: String(count),
            start: "0",
        },
    });

    const included: any[] = data.included || [];
    const elements: any[] = data.elements || [];

    // Build URN lookup for participant mini-profiles
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn || item["*miniProfile"];
        if (urn) byUrn.set(urn, item);
    }

    return elements.slice(0, count).map((conv: any) => {
        // Extract participant names from included mini-profiles
        const participantUrns: string[] = conv["*participants"] || [];
        const participants = participantUrns.map((pUrn: string) => {
            const participant = byUrn.get(pUrn);
            if (!participant) return pUrn;
            const mp = participant.miniProfile || participant["*miniProfile"];
            const profile = mp ? (typeof mp === "string" ? byUrn.get(mp) : mp) : participant;
            if (profile?.firstName) return `${profile.firstName} ${profile.lastName || ""}`.trim();
            return participant.firstName ? `${participant.firstName} ${participant.lastName || ""}`.trim() : pUrn;
        });

        const lastEvent = conv.events?.[0] || {};
        const msgBody = lastEvent.eventContent?.attributedBody?.text
            || lastEvent.eventContent?.body
            || lastEvent.subtype
            || "";

        return {
            conversationId: conv.entityUrn || conv.backendConversationUrn || "",
            participants,
            lastMessage: msgBody.slice(0, 300),
            lastActivityAt: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
            unreadCount: conv.unreadCount || 0,
        };
    });
}

/** Get messages in a specific conversation */
export async function getConversationMessages(auth: LinkedInAuth, conversationId: string, count = 20): Promise<any[]> {
    // conversationId might be a full URN or just the ID — extract the ID part
    const convId = conversationId.includes(",") ? conversationId : conversationId.replace(/.*:/, "");

    const data = await linkedinApi(auth, `/messaging/conversations/${encodeURIComponent(convId)}/events`, {
        params: {
            count: String(count),
            start: "0",
        },
    });

    const elements: any[] = data.elements || [];
    const included: any[] = data.included || [];

    // Build URN lookup for sender profiles
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn;
        if (urn) byUrn.set(urn, item);
    }

    return elements.map((evt: any) => {
        const senderUrn = evt.from?.["*miniProfile"] || evt["*from"] || "";
        const sender = byUrn.get(senderUrn);
        const senderName = sender
            ? `${sender.firstName || ""} ${sender.lastName || ""}`.trim()
            : senderUrn;

        const body = evt.eventContent?.attributedBody?.text
            || evt.eventContent?.body
            || evt.subtype
            || "";

        return {
            messageId: evt.entityUrn || "",
            sender: senderName,
            body: body.slice(0, 2000),
            sentAt: evt.createdAt ? new Date(evt.createdAt).toISOString() : null,
        };
    });
}

/** Send a message to a LinkedIn member */
export async function sendMessage(auth: LinkedInAuth, recipientUrn: string, body: string): Promise<any> {
    // recipientUrn should be like "urn:li:fsd_profile:ACoAAA..." or "urn:li:member:12345"
    // If a vanity name is passed, we need to resolve it first
    let targetUrn = recipientUrn;
    if (!targetUrn.startsWith("urn:")) {
        // Assume it's a vanity name — resolve to profile URN
        const profile = await getProfile(auth, targetUrn);
        if (!profile.publicId) throw new Error(`Could not resolve recipient "${recipientUrn}"`);
        // We need the member URN; fetch via the profile data
        const data = await linkedinApi(auth, `/identity/dash/profiles`, {
            params: { q: "memberIdentity", memberIdentity: targetUrn },
        });
        const included: any[] = data.included || [];
        const profileEntity = included.find((e: any) => e.$type?.includes("Profile") && e.entityUrn);
        if (profileEntity?.entityUrn) {
            targetUrn = profileEntity.entityUrn;
        } else {
            throw new Error(`Could not resolve member URN for "${recipientUrn}"`);
        }
    }

    const me = await getMe(auth);
    const senderUrn = me.entityUrn || me.objectUrn;

    const msgBody = {
        keyVersion: "LEGACY_INBOX",
        conversationCreate: {
            recipients: [targetUrn],
            subtype: "MEMBER_TO_MEMBER",
            eventCreate: {
                value: {
                    "com.linkedin.voyager.messaging.create.MessageCreate": {
                        attributedBody: {
                            text: body,
                            attributes: [],
                        },
                    },
                },
            },
        },
    };

    const data = await linkedinApi(auth, `/messaging/conversations`, {
        method: "POST",
        body: msgBody,
    });

    return { sent: true, conversationUrn: data.value?.entityUrn || data.entityUrn || null };
}

// ── Reactions & Comments ─────────────────────────────────────────────────────

/** React to a post (like, celebrate, support, love, insightful, funny) */
export async function reactToPost(auth: LinkedInAuth, postUrn: string, reactionType: string = "LIKE"): Promise<any> {
    // Normalize the URN — accept update URN or activity URN
    let activityUrn = postUrn;
    if (postUrn.includes("ugcPost")) {
        activityUrn = postUrn;
    } else if (postUrn.includes("activity")) {
        activityUrn = postUrn;
    }

    const data = await linkedinApi(auth, `/feed/reactions`, {
        method: "POST",
        body: {
            reactionType: reactionType.toUpperCase(),
            reactionsUrn: activityUrn,
        },
    });

    return { reacted: true, type: reactionType.toUpperCase(), postUrn: activityUrn };
}

/** Comment on a post */
export async function commentOnPost(auth: LinkedInAuth, postUrn: string, text: string): Promise<any> {
    let authorUrn = "";
    try {
        const me = await getMe(auth);
        authorUrn = me.objectUrn.replace("urn:li:member:", "urn:li:person:");
    } catch {}

    const body: any = {
        threadUrn: postUrn,
        commentary: {
            text,
            attributes: [],
        },
    };
    if (authorUrn) body.author = authorUrn;

    const data = await linkedinApi(auth, `/feed/normComments`, {
        method: "POST",
        body,
    });

    return { commented: true, urn: data.urn || data.value?.urn || null };
}

/** Get comments on a post */
export async function getPostComments(auth: LinkedInAuth, postUrn: string, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/feed/comments`, {
        params: {
            q: "comments",
            updateUrn: postUrn,
            count: String(count),
            start: "0",
            sortOrder: "RELEVANCE",
        },
    });

    const included: any[] = data.included || [];
    const elements: any[] = data.elements || included;

    // Build URN map for author lookup
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn;
        if (urn) byUrn.set(urn, item);
    }

    return elements
        .filter((e: any) => e.commentary || e.comment || e.message)
        .slice(0, count)
        .map((c: any) => {
            const commentText = c.commentary?.text?.text
                || c.commentary?.text
                || c.comment?.values?.[0]?.value
                || c.message?.text
                || "";

            // Resolve author
            const authorRef = c["*commenter"] || c["*author"] || c.commenter;
            const author = authorRef ? byUrn.get(authorRef) : null;
            const authorName = author
                ? `${author.firstName || ""} ${author.lastName || ""}`.trim()
                : "";

            return {
                text: commentText.slice(0, 500),
                author: authorName,
                likes: c.numLikes || c.socialDetail?.totalSocialActivityCounts?.numLikes || 0,
                created: c.createdAt ? new Date(c.createdAt).toISOString() : null,
                urn: c.entityUrn || "",
            };
        });
}

// ── Notifications ────────────────────────────────────────────────────────────

/** Get recent notifications */
export async function getNotifications(auth: LinkedInAuth, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/feed/notifications`, {
        params: {
            count: String(count),
            start: "0",
        },
    });

    const elements: any[] = data.elements || [];
    const included: any[] = data.included || [];

    return elements.slice(0, count).map((n: any) => ({
        headline: n.headline?.text || n.headline || "",
        description: n.additionalDescription?.text || n.description?.text || "",
        type: n.trackingData?.notificationType || n.notificationType || "",
        read: !!n.read,
        createdAt: n.publishedAt ? new Date(n.publishedAt).toISOString() : null,
        actionUrl: n.navigationUrl || n.cta?.navigationUrl || "",
    }));
}

// ── Connection Requests ──────────────────────────────────────────────────────

/** Send a connection request */
export async function sendConnectionRequest(auth: LinkedInAuth, vanityName: string, message?: string): Promise<any> {
    // Resolve vanity name to a profile URN
    const data = await linkedinApi(auth, `/identity/dash/profiles`, {
        params: { q: "memberIdentity", memberIdentity: vanityName },
    });
    const included: any[] = data.included || [];
    const profileEntity = included.find((e: any) => e.$type?.includes("Profile") && e.entityUrn);
    if (!profileEntity?.entityUrn) throw new Error(`Could not find profile for "${vanityName}"`);

    const targetUrn = profileEntity.entityUrn;

    const body: any = {
        inviteeProfileUrn: targetUrn,
    };
    if (message) {
        body.customMessage = message;
    }

    const result = await linkedinApi(auth, `/relationships/invitations`, {
        method: "POST",
        body,
    });

    return { sent: true, to: vanityName };
}

/** Get pending connection requests (received) */
export async function getInvitations(auth: LinkedInAuth, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/relationships/invitationViews`, {
        params: {
            count: String(count),
            start: "0",
            q: "receivedInvitation",
        },
    });

    const included: any[] = data.included || [];
    const elements: any[] = data.elements || [];

    // Build URN map
    const byUrn = new Map<string, any>();
    for (const item of included) {
        const urn = item.entityUrn;
        if (urn) byUrn.set(urn, item);
    }

    return elements.slice(0, count).map((inv: any) => {
        const fromRef = inv["*fromMember"] || inv["*genericInviter"];
        const from = fromRef ? byUrn.get(fromRef) : null;
        const fromName = from
            ? `${from.firstName || ""} ${from.lastName || ""}`.trim()
            : "";

        return {
            invitationId: inv.entityUrn || "",
            from: fromName,
            headline: from?.headline || from?.occupation || "",
            message: inv.message || "",
            sentAt: inv.sentTime ? new Date(inv.sentTime).toISOString() : null,
        };
    });
}

/** Accept or decline a connection request */
export async function respondToInvitation(auth: LinkedInAuth, invitationId: string, accept: boolean): Promise<any> {
    // invitationId might be a full URN — extract the numeric part
    const id = invitationId.replace(/.*:/, "");
    const action = accept ? "accept" : "ignore";

    await linkedinApi(auth, `/relationships/invitations/${id}/${action}`, {
        method: "POST",
    });

    return { [action]: true, invitationId: id };
}
