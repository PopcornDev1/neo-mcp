/**
 * LinkedIn integration via Voyager API.
 * Uses li_at cookie + JSESSIONID (csrf) extracted from browser.
 *
 * All requests go through the browser extension (browserFetch) because
 * LinkedIn blocks direct Node.js fetch via TLS fingerprinting / Cloudflare.
 */
export interface LinkedInAuth {
    li_at: string;
    jsessionid: string;
}
export declare function setBrowserCommand(fn: (method: string, params: Record<string, any>) => Promise<any>): void;
/** Get a user's profile by vanity name (the URL slug) */
export declare function getProfile(auth: LinkedInAuth, vanityName: string): Promise<any>;
/** Get the authenticated user's own posts with engagement metrics */
export declare function getMyPosts(auth: LinkedInAuth, count?: number): Promise<any[]>;
/** Get the user's feed */
export declare function getFeed(auth: LinkedInAuth, count?: number): Promise<any[]>;
/** Create a text post */
export declare function createPost(auth: LinkedInAuth, text: string): Promise<any>;
/** Search for people */
export declare function searchPeople(auth: LinkedInAuth, query: string, count?: number): Promise<any[]>;
/** Get connections */
export declare function getConnections(auth: LinkedInAuth, count?: number): Promise<any[]>;
