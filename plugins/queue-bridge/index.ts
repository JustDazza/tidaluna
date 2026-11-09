import { settings, Settings } from "./Settings";

export { Settings };

export const name = "Queue Bridge";

export const description = "Connects to Streamer.bot WebSocket to queue song requests into Tidal";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const COMMANDS = ["!sr", "!songrequest"];

/**
 * Name of the Streamer.bot action used to post replies in Twitch chat.
 * Create an action with this exact name "Queue Bridge Reply"
 * Create a sub-action that has the following sub-action
 * "Twitch > Chat > Send Message" sub-action whose text is: %message%
 */
const REPLY_ACTION_NAME = "Queue Bridge Reply";
const QUEUE_MODE: "next" | "last" = "last";
const INCLUDE_TRACK_LINK = true;
const SEARCH_LIMIT = 5;
function getCooldownMs(): number {
	const seconds = Number((settings as any).cooldownSeconds);
	return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_COOLDOWN_SECONDS) * 1000;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
let loggedDiscovery = false;

const seenMessageIds = new Set<string>();
const lastRequestAt = new Map<string, number>();

interface FoundTrack {
	id: number | string;
	title: string;
	artist: string;
}

interface ChatRequest {
	query: string;
	username: string;
	msgId?: string;
	role: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLunaLib(): any {
	return (window as any).luna?.lib || {};
}

function sendRaw(payload: unknown) {
	if (socket && socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(payload));
	}
}

function sendTwitchMessage(message: string) {
	sendRaw({
		request: "DoAction",
		action: { name: REPLY_ACTION_NAME },
		args: { message },
		id: `queue-bridge-reply-${Date.now()}`
	});
}

function subscribe() {
	sendRaw({
		request: "Subscribe",
		events: { Twitch: ["ChatMessage"] },
		id: "queue-bridge-sub"
	});
}

async function sha256Base64(input: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

async function authenticate(password: string, salt: string, challenge: string) {
	const secret = await sha256Base64(password + salt);
	const authentication = await sha256Base64(secret + challenge);
	sendRaw({ request: "Authenticate", authentication, id: "queue-bridge-auth" });
}

// ---------------------------------------------------------------------------
// Query cleaning
// ---------------------------------------------------------------------------

async function resolveQuery(rawQuery: string): Promise<string> {
	let query = rawQuery.trim();

	if (query.includes("youtube.com") || query.includes("youtu.be")) {
		try {
			const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(query)}&format=json`);
			if (res.ok) {
				const data = await res.json();
				const title: string = data.title || "";
				const author: string = (data.author_name || "").replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "").trim();
				if (title && !title.includes("-") && author) {
					query = `${author} - ${title}`;
				} else if (title) {
					query = title;
				}
			}
		} catch (e) {
			console.warn("[QueueBridge] Failed to resolve YouTube oEmbed:", e);
		}
	} else {
		const byMatch = query.match(/^(.*?)\s+by\s+(.*)$/i);
		if (byMatch) {
			query = `${byMatch[2].trim()} - ${byMatch[1].trim()}`;
		}
	}

	query = query.replace(/^[\d+.•*\-\s]+/, "").trim();
	query = query
		.replace(/[([]\s*(official\s*(music\s*)?video|lyric\s*video|audio|hd|4k|remastered|visualizer)\s*[)\]]/gi, "")
		.trim();

	return query;
}

// ---------------------------------------------------------------------------
// Tidal search (returns plain data, NOT a Luna MediaItem wrapper)
// ---------------------------------------------------------------------------

function pickBest(items: any[], query: string): any {
	const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	if (tokens.length === 0) return items[0];

	let best = items[0];
	let bestScore = -1;
	for (const item of items) {
		const artist = item.artist?.name ?? item.artists?.[0]?.name ?? "";
		const haystack = `${artist} ${item.title ?? item.name ?? ""}`.toLowerCase();
		const score = tokens.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0);
		if (score > bestScore) {
			best = item;
			bestScore = score;
		}
	}
	return best;
}

async function searchTidal(query: string): Promise<FoundTrack | null> {
	const lunaLib = getLunaLib();

	if (typeof lunaLib.getCredentials !== "function") {
		throw new Error("luna.lib.getCredentials is not available.");
	}

	const creds = await lunaLib.getCredentials();
	const token = creds?.token || creds?.accessToken || creds?.authorization;
	const countryCode = creds?.countryCode || "GB";

	if (!token) {
		throw new Error("No Tidal access token found in Luna credentials.");
	}

	const url = `https://api.tidal.com/v1/search/tracks?query=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&countryCode=${countryCode}`;
	const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

	if (!response.ok) {
		throw new Error(`Tidal search failed with HTTP ${response.status}.`);
	}

	const json = await response.json();
	const items = json?.items || json?.tracks?.items || json?.data;

	if (!Array.isArray(items) || items.length === 0) {
		return null;
	}

	const raw = pickBest(items, query);
	return {
		id: raw.id,
		title: raw.title ?? raw.name ?? query,
		artist: raw.artist?.name ?? raw.artists?.[0]?.name ?? ""
	};
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

function logDiscovery() {
	if (loggedDiscovery) return;
	loggedDiscovery = true;
	const lib = getLunaLib();
	console.log("[QueueBridge] luna.lib keys:", Object.keys(lib));
	console.log(
		"[QueueBridge] playQueue actions:",
		Object.keys(lib.redux?.actions ?? {}).filter((k) => k.startsWith("playQueue"))
	);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function queueFingerprint(): string {
	try {
		const state = getLunaLib().redux?.store?.getState?.();
		return JSON.stringify(state?.playQueue ?? null);
	} catch {
		return "";
	}
}

function getQueuePosition(trackId: number | string, fromEnd = true): number | null {
	try {
		const pq = getLunaLib().redux?.store?.getState?.()?.playQueue;
		if (!pq) return null;

		const elements: any[] | undefined = [pq.elements, pq.items, pq.queue].find(Array.isArray);
		const current = Number(pq.currentIndex);
		if (!elements || !Number.isFinite(current)) return null;

		const idPattern = new RegExp(`(?<!\\d)${String(trackId)}(?!\\d)`);
		const matches = (i: number) => idPattern.test(JSON.stringify(elements[i]));

		if (fromEnd) {
			for (let i = elements.length - 1; i > current; i--) if (matches(i)) return i - current;
		} else {
			for (let i = current + 1; i < elements.length; i++) if (matches(i)) return i - current;
		}
		return null;
	} catch {
		return null;
	}
}

let workingAddLastIndex = -1;

let queueLock: Promise<void> = Promise.resolve();

async function addToEnd(track: FoundTrack): Promise<boolean> {
	const store = getLunaLib().redux?.store;
	if (!store) return false;

	const id = String(track.id);
	const candidates = [
		{ type: "playQueue/ADD_LAST", payload: { mediaItemIds: [id], context: { type: "user", id: "queue-bridge" } } },
		{ type: "playQueue/ADD_LAST", payload: { mediaItemIds: [id] } },
		{ type: "playQueue/ADD_MEDIA_ITEMS_TO_QUEUE", payload: { mediaItemIds: [id], position: "last" } }
	];

	const order = candidates.map((_, i) => i);
	if (workingAddLastIndex >= 0) {
		order.splice(order.indexOf(workingAddLastIndex), 1);
		order.unshift(workingAddLastIndex);
	}

	for (const i of order) {
		const before = queueFingerprint();
		try {
			store.dispatch(candidates[i]);
		} catch (err) {
			console.warn("[QueueBridge] Dispatch threw for", JSON.stringify(candidates[i]), err);
			continue;
		}
		await sleep(400);
		if (queueFingerprint() !== before) {
			workingAddLastIndex = i;
			console.log("[QueueBridge] Appended to end of queue using:", JSON.stringify(candidates[i]));
			return true;
		}
		console.warn("[QueueBridge] Queue unchanged after:", JSON.stringify(candidates[i]));
	}
	return false;
}

async function queueTrackInner(track: FoundTrack): Promise<number | null> {
	const lib = getLunaLib();

	if (QUEUE_MODE === "last") {
		if (await addToEnd(track)) return getQueuePosition(track.id, true);
		console.warn("[QueueBridge] Could not append to end of queue, falling back to playNext.");
	}

	if (typeof lib.PlayState?.playNext === "function") {
		await lib.PlayState.playNext([track.id]);
		await sleep(300);
		return getQueuePosition(track.id, false);
	}

	throw new Error("No supported queue method found (PlayState.playNext missing).");
}

function queueTrack(track: FoundTrack): Promise<number | null> {
	const run = queueLock.then(() => queueTrackInner(track));
	queueLock = run.catch(() => {});
	return run;
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

function extractRequest(data: any): ChatRequest | null {
	// Chat command straight from Streamer.bot's Twitch ChatMessage event
	if (data?.event?.source === "Twitch" && data?.event?.type === "ChatMessage") {
		const payload = data.data;
		const msg = payload?.message;

		const text: string =
			payload?.text ||
			msg?.text ||
			(typeof msg === "object" ? msg?.message : undefined) ||
			(typeof msg === "string" ? msg : "") ||
			"";

		const username: string =
			(typeof msg === "object" ? msg?.displayName || msg?.username : undefined) ||
			payload?.user?.name ||
			payload?.user?.displayName ||
			payload?.user?.login ||
			payload?.username ||
			"";

		const lower = text.toLowerCase();
		const command = COMMANDS.find((c) => lower.startsWith(`${c} `));
		if (!command) return null;

		const query = text.slice(command.length).trim();
		if (!query) return null;

		return {
			query,
			username,
			msgId: (typeof msg === "object" ? msg?.msgId : undefined) || payload?.messageId,
			role: Number((typeof msg === "object" ? msg?.role : undefined) ?? payload?.user?.role ?? 0)
		};
	}

	if (data?.action === "queue" && data?.query) {
		return { query: String(data.query), username: data.user || "", role: 0 };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

async function handleRequest(req: ChatRequest) {
	const userTag = req.username ? `@${req.username} ` : "";

	if (req.msgId) {
		if (seenMessageIds.has(req.msgId)) return;
		seenMessageIds.add(req.msgId);
		if (seenMessageIds.size > 200) {
			seenMessageIds.delete(seenMessageIds.values().next().value as string);
		}
	}

	// Cooldown (mods and broadcaster, role >= 3, are exempt)
	if (req.username && req.role < 3) {
		const key = req.username.toLowerCase();
		const now = Date.now();
		if (now - (lastRequestAt.get(key) ?? 0) < USER_COOLDOWN_MS) {
			console.log(`[QueueBridge] Cooldown active for ${req.username}, ignoring.`);
			return;
		}
		lastRequestAt.set(key, now);
	}

	console.log(`[QueueBridge] Extracted query: "${req.query}" from ${req.username || "unknown"}`);

	try {
		const searchQuery = await resolveQuery(req.query);
		if (!searchQuery) {
			sendTwitchMessage(`❌ ${userTag}Could not parse a valid track name.`);
			return;
		}

		console.log(`[QueueBridge] Searching Tidal for: "${searchQuery}"`);
		const track = await searchTidal(searchQuery);

		if (!track) {
			console.warn(`[QueueBridge] Track not found for: "${searchQuery}"`);
			sendTwitchMessage(`❌ ${userTag}Could not find '${searchQuery}' on Tidal.`);
			return;
		}

		const position = await queueTrack(track);

		const label = track.artist ? `${track.title} - ${track.artist}` : track.title;
		const positionText = position ? ` at #${position}${position === 1 ? " (playing next)" : ""}` : "";
		const linkText = INCLUDE_TRACK_LINK ? ` https://tidal.com/browse/track/${track.id}` : "";
		const prefix = req.username ? `@${req.username}, added` : "Added";
		console.log(`[QueueBridge] Queued: ${label} (id ${track.id}, position ${position ?? "unknown"})`);
		sendTwitchMessage(`${prefix} ${label} to the queue${positionText}${linkText}`);
	} catch (err) {
		console.error("[QueueBridge] Error processing request:", err);
		sendTwitchMessage(`❌ ${userTag}Something went wrong queueing that song.`);
	}
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function scheduleReconnect() {
	if (disposed) return;
	if (reconnectTimer) clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(connect, 5000);
}

function connect() {
	if (disposed) return;

	const port = settings.webSocketPort || 8080;
	const url = `ws://127.0.0.1:${port}`;
	console.log(`[QueueBridge] Connecting to Streamer.bot WebSocket at ${url}...`);

	try {
		const ws = new WebSocket(url);
		socket = ws;

		ws.onopen = () => {
			console.log("[QueueBridge] Connected to Streamer.bot WebSocket!");
			logDiscovery();
			subscribe();
		};

		ws.onmessage = async (event) => {
			try {
				const data = JSON.parse(event.data);

				if (data?.request === "Hello") {
					const auth = data.authentication;
					const password = (settings as any).webSocketPassword;
					if (auth?.salt && auth?.challenge && password) {
						await authenticate(password, auth.salt, auth.challenge);
						subscribe();
					}
					return;
				}

				const req = extractRequest(data);
				if (req) await handleRequest(req);
			} catch (err) {
				console.error("[QueueBridge] Error processing message:", err);
			}
		};

		ws.onclose = () => {
			if (disposed) return;
			console.log("[QueueBridge] WebSocket disconnected. Reconnecting in 5s...");
			scheduleReconnect();
		};

		ws.onerror = (err) => {
			console.error("[QueueBridge] WebSocket error:", err);
		};
	} catch (err) {
		console.error("[QueueBridge] Connection error:", err);
		scheduleReconnect();
	}
}

connect();

export const unloads = new Set([
	() => {
		disposed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (socket) {
			try {
				socket.close();
			} catch {}
			socket = null;
			console.log("[QueueBridge] WebSocket disconnected.");
		}
	}
]);