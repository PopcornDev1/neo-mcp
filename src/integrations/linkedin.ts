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

/** Get a user's profile by vanity name (the URL slug) */
export async function getProfile(auth: LinkedInAuth, vanityName: string): Promise<any> {
    // Use the simpler profile endpoint without decoration ID
    const data = await linkedinApi(auth, `/identity/profiles/${encodeURIComponent(vanityName)}/profileView`);

    const profile = data.profile || data;
    return {
        firstName: profile.firstName,
        lastName: profile.lastName,
        headline: profile.headline,
        summary: profile.summary,
        location: profile.geoLocationName || profile.locationName,
        industry: profile.industryName,
        publicId: profile.miniProfile?.publicIdentifier || vanityName,
        connections: profile.connectionCount,
        followers: profile.followerCount,
    };
}

/** Get the authenticated user's own posts with engagement metrics */
export async function getMyPosts(auth: LinkedInAuth, count = 20): Promise<any[]> {
    // Use feed/updatesV2 filtered to own posts
    const data = await linkedinApi(auth, `/feed/updatesV2`, {
        params: {
            count: String(count),
            q: "memberShareFeed",
            start: "0",
        },
    });

    return extractPosts(data, count);
}

/** Get the user's feed */
export async function getFeed(auth: LinkedInAuth, count = 20): Promise<any[]> {
    const data = await linkedinApi(auth, `/feed/updatesV2`, {
        params: {
            count: String(count),
            q: "relevance",
            start: "0",
        },
    });

    return extractPosts(data, count);
}

function extractPosts(data: any, max: number): any[] {
    // LinkedIn's normalized response puts data in `included` array
    const included = data.included || data.elements || [];
    const posts: any[] = [];

    for (const item of included) {
        if (posts.length >= max) break;

        // Look for items that have commentary (actual posts)
        const commentary = item.commentary?.text?.text
            || item.value?.com?.linkedin?.voyager?.feed?.render?.UpdateV2?.commentary?.text?.text
            || "";

        if (!commentary) continue;

        const socialCounts = item.socialDetail?.totalSocialActivityCounts || {};

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
    const data = await linkedinApi(auth, `/contentcreation/shares`, {
        method: "POST",
        body: {
            comment: {
                text,
                attributes: [],
            },
            visibility: {
                code: "PUBLIC",
            },
            distribution: {
                feedDistribution: "MAIN_FEED",
                thirdPartyDistributionChannels: [],
            },
            origin: "MEMBER_SHARE",
        },
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
