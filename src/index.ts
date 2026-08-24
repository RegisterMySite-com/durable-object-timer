/**
 * Persistent Global Clock Timer + Visitor Counter + Bot Scoring
 * Cloudflare Workers + Durable Objects
 *
 * Architecture overview
 * ---------------------
 * - A single Durable Object instance (idFromName("global-timer")) holds the
 *   authoritative startTime and visitor statistics.
 * - We NEVER increment a counter every second.  Instead we store one Unix
 *   timestamp (ms) the first time the timer is started.  On every request we
 *   simply compute:
 *
 *     elapsedSeconds = Math.floor((Date.now() - startTime) / 1000)
 *
 * - Because the calculation uses wall-clock time, the timer continues
 *   correctly even while the Durable Object is hibernated or completely
 *   evicted.
 *
 * Visitor tracking + bot scoring
 * ------------------------------
 * - On every page load / status request / WebSocket connect we record:
 *     IP, country, city, User-Agent, timestamp
 * - A composite botScore (0–100, higher = more likely bot) is calculated from:
 *     • Cloudflare Bot Management score (when available)
 *     • Known bot / crawler User-Agents
 *     • Missing or suspicious headers
 *     • Verified-bot flag
 *     • Simple behavioral signals (very rapid repeats from same IP)
 * - recentVisitors is pruned to the last 24 hours (max ~60 entries)
 * - UI shows two columns: Real Visitors | Suspected Bots (with score)
 */

import { DurableObject } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  TIMER: DurableObjectNamespace<Timer>;
}

export interface VisitorInfo {
  /** Client IP (from CF-Connecting-IP) */
  ip: string;
  /** ISO 3166-1 alpha-2 country code, or null */
  country: string | null;
  /** City name if available, or null */
  city: string | null;
  /** Unix timestamp (ms) when the visit was recorded */
  timestamp: number;
  /** Raw User-Agent string */
  userAgent: string;
  /** 0–100 composite score; higher = more likely bot */
  botScore: number;
  /** True when botScore >= BOT_THRESHOLD */
  isBot: boolean;
  /** Short human-readable reasons that contributed to the score */
  botReasons: string[];
  /** Cloudflare's native bot score (1–99, lower = more bot) if present */
  cfBotScore: number | null;
  /** Cloudflare verified good bot flag */
  verifiedBot: boolean;
}

export interface TimerStatus {
  elapsedSeconds: number;
  startTime: number | null;
  isRunning: boolean;
  serverTime: number;
  totalVisits: number;
  /** All recent visits (last 24 h). Client splits into real vs bots. */
  recentVisitors: VisitorInfo[];
}

// Threshold: score >= this value lands in the "Suspected Bots" column
const BOT_THRESHOLD = 45;

// ---------------------------------------------------------------------------
// Bot scoring helpers (pure functions – easy to test / extend)
// ---------------------------------------------------------------------------

const KNOWN_BOT_UA_PATTERNS: RegExp[] = [
  /googlebot/i,
  /bingbot/i,
  /slurp/i, // Yahoo
  /duckduckbot/i,
  /baiduspider/i,
  /yandexbot/i,
  /facebot/i,
  /facebookexternalhit/i,
  /twitterbot/i,
  /linkedinbot/i,
  /embedly/i,
  /quora link preview/i,
  /showyoubot/i,
  /outbrain/i,
  /pinterest/i,
  /applebot/i,
  /semrushbot/i,
  /ahrefsbot/i,
  /mj12bot/i,
  /dotbot/i,
  /petalbot/i,
  /bytespider/i, // ByteDance / TikTok
  /gptbot/i,
  /claudebot/i,
  /anthropic/i,
  /ccbot/i,
  /chatgpt/i,
  /oai-searchbot/i,
  /curl\//i,
  /wget\//i,
  /python-requests/i,
  /python-urllib/i,
  /scrapy/i,
  /httpclient/i,
  /java\//i,
  /go-http-client/i,
  /okhttp/i,
  /node-fetch/i,
  /axios\//i,
  /libwww-perl/i,
  /phantomjs/i,
  /headlesschrome/i,
  /puppeteer/i,
  /selenium/i,
  /webdriver/i,
  /bot\b/i,
  /crawler/i,
  /spider/i,
  /scraper/i,
  /http-client/i,
  /monitoring/i,
  /uptime/i,
  /pingdom/i,
  /statuscake/i,
  /gtmetrix/i,
];

/**
 * Compute a 0–100 bot likelihood score.
 * Higher number = more likely to be a bot.
 */
function computeBotScore(opts: {
  userAgent: string;
  cfBotScore: number | null; // Cloudflare's 1–99 (lower = more bot)
  verifiedBot: boolean;
  country: string | null;
  recentSameIpCount: number; // how many times this IP appeared in the last few minutes
}): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const ua = (opts.userAgent || "").trim();

  // 1. Cloudflare Bot Management (strongest signal when present)
  //    CF score 1–99 where *lower* = more bot → invert for our scale
  if (opts.cfBotScore !== null && opts.cfBotScore > 0) {
    // Map CF 1 → our 99, CF 99 → our 1
    const inverted = 100 - opts.cfBotScore;
    score += inverted * 0.55; // weight 55 %
    if (opts.cfBotScore <= 29) {
      reasons.push(`CF bot score ${opts.cfBotScore} (likely automated)`);
    } else if (opts.cfBotScore <= 50) {
      reasons.push(`CF bot score ${opts.cfBotScore}`);
    }
  }

  // 2. Verified good bots (Google, Bing, etc.) – still bots, just legitimate
  if (opts.verifiedBot) {
    score = Math.max(score, 70);
    reasons.push("Cloudflare verified bot");
  }

  // 3. Known bot / crawler User-Agent patterns
  let matchedKnown = false;
  for (const re of KNOWN_BOT_UA_PATTERNS) {
    if (re.test(ua)) {
      score += 35;
      reasons.push(`UA matches known bot pattern`);
      matchedKnown = true;
      break;
    }
  }

  // 4. Empty / extremely short / missing UA
  if (!ua || ua.length < 12) {
    score += 40;
    reasons.push("Missing or very short User-Agent");
  }

  // 5. Generic “bot/crawler/spider” keywords even if not in the hard list
  if (!matchedKnown && /\b(bot|crawler|spider|scraper|crawl)\b/i.test(ua)) {
    score += 25;
    reasons.push("UA contains bot/crawler keywords");
  }

  // 6. Headless / automation tools
  if (/headless|puppeteer|selenium|webdriver|phantom/i.test(ua)) {
    score += 30;
    reasons.push("Headless / automation tool detected");
  }

  // 7. Missing country (often true for pure datacenter / some bots)
  if (!opts.country) {
    score += 8;
    reasons.push("No geo/country data");
  }

  // 8. Simple behavioral signal – many hits from same IP in a short window
  if (opts.recentSameIpCount >= 5) {
    score += 20;
    reasons.push(`Rapid repeats from same IP (${opts.recentSameIpCount})`);
  } else if (opts.recentSameIpCount >= 3) {
    score += 10;
    reasons.push(`Multiple hits from same IP (${opts.recentSameIpCount})`);
  }

  // Clamp
  score = Math.max(0, Math.min(100, Math.round(score)));

  // De-duplicate reasons
  const uniqueReasons = [...new Set(reasons)];

  return { score, reasons: uniqueReasons };
}

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class Timer extends DurableObject<Env> {
  private static readonly START_TIME_KEY = "startTime";
  private static readonly TOTAL_VISITS_KEY = "totalVisits";
  private static readonly RECENT_VISITS_KEY = "recentVisits";
  private static readonly MAX_RECENT = 60;
  private static readonly RECENT_MS = 24 * 60 * 60 * 1000; // 24 h

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // -------------------------------------------------------------------------
  // RPC methods
  // -------------------------------------------------------------------------

  async start(): Promise<number> {
    const existing = await this.ctx.storage.get<number>(Timer.START_TIME_KEY);
    if (existing !== undefined && existing !== null) return existing;
    const now = Date.now();
    await this.ctx.storage.put(Timer.START_TIME_KEY, now);
    this.broadcastStatus();
    return now;
  }

  async getElapsedSeconds(): Promise<number> {
    const startTime = await this.ensureStarted();
    return Math.floor((Date.now() - startTime) / 1000);
  }

  async reset(): Promise<void> {
    await this.ctx.storage.delete(Timer.START_TIME_KEY);
    this.broadcastStatus();
  }

  /**
   * Record a visitor and compute bot score.
   */
  async recordVisit(
    ip: string,
    country: string | null,
    city: string | null,
    userAgent: string,
    cfBotScore: number | null,
    verifiedBot: boolean,
  ): Promise<void> {
    await this.ensureStarted();

    const currentTotal =
      (await this.ctx.storage.get<number>(Timer.TOTAL_VISITS_KEY)) ?? 0;
    await this.ctx.storage.put(Timer.TOTAL_VISITS_KEY, currentTotal + 1);

    const now = Date.now();
    let recent =
      (await this.ctx.storage.get<VisitorInfo[]>(Timer.RECENT_VISITS_KEY)) ??
      [];

    // Prune > 24 h
    const cutoff = now - Timer.RECENT_MS;
    recent = recent.filter((v) => v.timestamp >= cutoff);

    // Behavioral: count how many times this IP appeared in the last 5 minutes
    const fiveMinAgo = now - 5 * 60 * 1000;
    const recentSameIpCount = recent.filter(
      (v) => v.ip === ip && v.timestamp >= fiveMinAgo,
    ).length;

    const { score, reasons } = computeBotScore({
      userAgent,
      cfBotScore,
      verifiedBot,
      country,
      recentSameIpCount,
    });

    const entry: VisitorInfo = {
      ip: ip || "unknown",
      country: country || null,
      city: city || null,
      timestamp: now,
      userAgent: userAgent || "",
      botScore: score,
      isBot: score >= BOT_THRESHOLD,
      botReasons: reasons,
      cfBotScore,
      verifiedBot,
    };

    recent.unshift(entry);
    if (recent.length > Timer.MAX_RECENT) {
      recent = recent.slice(0, Timer.MAX_RECENT);
    }

    await this.ctx.storage.put(Timer.RECENT_VISITS_KEY, recent);
    this.broadcastStatus();
  }

  async getStatus(): Promise<TimerStatus> {
    const startTime =
      (await this.ctx.storage.get<number>(Timer.START_TIME_KEY)) ?? null;
    const serverTime = Date.now();
    const elapsedSeconds =
      startTime !== null ? Math.floor((serverTime - startTime) / 1000) : 0;

    const totalVisits =
      (await this.ctx.storage.get<number>(Timer.TOTAL_VISITS_KEY)) ?? 0;

    let recent =
      (await this.ctx.storage.get<VisitorInfo[]>(Timer.RECENT_VISITS_KEY)) ??
      [];
    const cutoff = serverTime - Timer.RECENT_MS;
    recent = recent.filter((v) => v.timestamp >= cutoff);

    return {
      elapsedSeconds,
      startTime,
      isRunning: startTime !== null,
      serverTime,
      totalVisits,
      recentVisitors: recent,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async ensureStarted(): Promise<number> {
    const existing = await this.ctx.storage.get<number>(Timer.START_TIME_KEY);
    if (existing !== undefined && existing !== null) return existing;
    const now = Date.now();
    await this.ctx.storage.put(Timer.START_TIME_KEY, now);
    return now;
  }

  private async broadcastStatus(): Promise<void> {
    const status = await this.getStatus();
    const payload = JSON.stringify({ type: "status", ...status });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket Hibernation
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const info = extractClientInfo(request);
    await this.recordVisit(
      info.ip,
      info.country,
      info.city,
      info.userAgent,
      info.cfBotScore,
      info.verifiedBot,
    );

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const status = await this.getStatus();
    server.send(JSON.stringify({ type: "status", ...status }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);
    const cmd = text.trim().toLowerCase();
    if (cmd === "status" || cmd === "ping" || cmd === "get") {
      await this.ensureStarted();
      const status = await this.getStatus();
      ws.send(JSON.stringify({ type: "status", ...status }));
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      ws.close(code, reason || "Durable Object closing");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error", error);
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const id = env.TIMER.idFromName("global-timer");
    const stub = env.TIMER.get(id);

    if (path === "/ws") {
      return stub.fetch(request);
    }

    if (path === "/api/status") {
      try {
        const info = extractClientInfo(request);
        await stub.recordVisit(
          info.ip,
          info.country,
          info.city,
          info.userAgent,
          info.cfBotScore,
          info.verifiedBot,
        );
        const status = await stub.getStatus();
        return json(status);
      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }

    if (path === "/" || path === "/index.html") {
      try {
        const info = extractClientInfo(request);
        await stub.recordVisit(
          info.ip,
          info.country,
          info.city,
          info.userAgent,
          info.cfBotScore,
          info.verifiedBot,
        );
      } catch {
        /* non-fatal */
      }

      return new Response(HTML_PAGE, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          ...corsHeaders(),
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

/**
 * Extract IP, geo, User-Agent and Cloudflare Bot Management signals.
 */
function extractClientInfo(request: Request): {
  ip: string;
  country: string | null;
  city: string | null;
  userAgent: string;
  cfBotScore: number | null;
  verifiedBot: boolean;
} {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "127.0.0.1";

  const ua = request.headers.get("User-Agent") || "";

  // request.cf is populated at the Cloudflare edge
  const cf = (request as any).cf as
    | {
        country?: string;
        city?: string;
        botManagement?: {
          score?: number;
          verifiedBot?: boolean;
        };
      }
    | undefined;

  const cfBotScore =
    typeof cf?.botManagement?.score === "number"
      ? cf.botManagement.score
      : null;

  const verifiedBot = Boolean(cf?.botManagement?.verifiedBot);

  return {
    ip,
    country: cf?.country ?? null,
    city: cf?.city ?? null,
    userAgent: ua,
    cfBotScore,
    verifiedBot,
  };
}

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Global Persistent Timer</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --green: #3fb950;
      --red: #f85149;
      --orange: #d29922;
      --mono: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      padding: 1.5rem;
      padding-top: 2.5rem;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--muted);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      margin-bottom: 1.5rem;
    }
    .timer-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.2rem 2.5rem;
      text-align: center;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      max-width: 560px;
      width: 100%;
    }
    #display {
      font-family: var(--mono);
      font-size: clamp(2.6rem, 11vw, 5rem);
      font-weight: 500;
      letter-spacing: 0.05em;
      color: var(--accent);
      line-height: 1.1;
      margin-bottom: 0.4rem;
      text-shadow: 0 0 20px rgba(88,166,255,0.25);
    }
    #total-seconds {
      font-family: var(--mono);
      font-size: 0.95rem;
      color: var(--muted);
      margin-bottom: 1.25rem;
    }
    .stats-row {
      display: flex;
      justify-content: space-around;
      gap: 0.75rem;
      margin-bottom: 1.25rem;
      padding: 0.9rem 0;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
    }
    .stat { text-align: center; }
    .stat-value {
      font-family: var(--mono);
      font-size: 1.45rem;
      font-weight: 600;
      color: var(--accent);
    }
    .stat-value.bots { color: var(--orange); }
    .stat-label {
      font-size: 0.7rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-top: 0.2rem;
    }
    .meta {
      display: grid;
      gap: 0.5rem;
      text-align: left;
      font-size: 0.82rem;
      color: var(--muted);
      margin-bottom: 1.25rem;
    }
    .meta div {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
    }
    .meta span:last-child {
      font-family: var(--mono);
      color: var(--text);
      word-break: break-all;
    }
    .actions {
      display: flex;
      gap: 0.75rem;
      justify-content: center;
    }
    button {
      font-family: inherit;
      font-size: 0.88rem;
      font-weight: 500;
      padding: 0.55rem 1.15rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    button:hover {
      background: #21262d;
      border-color: var(--muted);
    }
    #connection {
      margin-top: 1.1rem;
      font-size: 0.8rem;
      color: var(--muted);
    }
    #connection.connected { color: var(--green); }
    #connection.disconnected { color: var(--red); }

    /* Two-column visitor panels */
    .visitors-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-top: 1.5rem;
      max-width: 920px;
      width: 100%;
    }
    @media (max-width: 700px) {
      .visitors-grid { grid-template-columns: 1fr; }
    }
    .visitors-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      display: flex;
      flex-direction: column;
    }
    .visitors-card h2 {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 0.9rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .visitors-card h2 .count {
      font-family: var(--mono);
      background: #21262d;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.75rem;
      color: var(--text);
    }
    .visitors-card.bots h2 .count { background: #3d2e00; color: var(--orange); }
    .visitor-list {
      list-style: none;
      max-height: 380px;
      overflow-y: auto;
      flex: 1;
    }
    .visitor-list li {
      display: flex;
      align-items: flex-start;
      gap: 0.65rem;
      padding: 0.65rem 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.82rem;
    }
    .visitor-list li:last-child { border-bottom: none; }
    .flag {
      font-size: 1.3rem;
      line-height: 1;
      min-width: 1.5rem;
      text-align: center;
    }
    .visitor-info { flex: 1; min-width: 0; }
    .visitor-location {
      color: var(--text);
      font-weight: 500;
    }
    .visitor-meta {
      font-family: var(--mono);
      font-size: 0.72rem;
      color: var(--muted);
      margin-top: 0.15rem;
      word-break: break-all;
    }
    .visitor-reasons {
      font-size: 0.7rem;
      color: var(--orange);
      margin-top: 0.2rem;
      line-height: 1.3;
    }
    .visitor-right {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 0.25rem;
      flex-shrink: 0;
    }
    .visitor-time {
      font-size: 0.72rem;
      color: var(--muted);
      white-space: nowrap;
    }
    .score-badge {
      font-family: var(--mono);
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.12rem 0.4rem;
      border-radius: 4px;
      background: #3d2e00;
      color: var(--orange);
    }
    .score-badge.high { background: #4a1515; color: #f85149; }
    .score-badge.mid { background: #3d2e00; color: var(--orange); }
    .empty-visitors {
      color: var(--muted);
      font-size: 0.82rem;
      text-align: center;
      padding: 1.2rem 0;
    }
    footer {
      margin-top: 2.2rem;
      font-size: 0.72rem;
      color: var(--muted);
      text-align: center;
      max-width: 480px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <h1>Global Persistent Timer</h1>

  <div class="timer-card">
    <div id="display">00:00:00</div>
    <div id="total-seconds">0 seconds</div>

    <div class="stats-row">
      <div class="stat">
        <div class="stat-value" id="total-visits">0</div>
        <div class="stat-label">Total Visits</div>
      </div>
      <div class="stat">
        <div class="stat-value" id="real-count">0</div>
        <div class="stat-label">Real (24 h)</div>
      </div>
      <div class="stat">
        <div class="stat-value bots" id="bot-count">0</div>
        <div class="stat-label">Bots (24 h)</div>
      </div>
    </div>

    <div class="meta">
      <div>
        <span>Status</span>
        <span id="status-text">connecting…</span>
      </div>
      <div>
        <span>Started at</span>
        <span id="start-time">—</span>
      </div>
      <div>
        <span>Server time</span>
        <span id="server-time">—</span>
      </div>
    </div>

    <div class="actions">
      <button id="btn-refresh">Force Refresh</button>
    </div>
  </div>

  <div class="visitors-grid">
    <div class="visitors-card real">
      <h2>Real Visitors <span class="count" id="real-list-count">0</span></h2>
      <ul class="visitor-list" id="real-list">
        <li class="empty-visitors">No real visitors yet</li>
      </ul>
    </div>
    <div class="visitors-card bots">
      <h2>Suspected Bots <span class="count" id="bot-list-count">0</span></h2>
      <ul class="visitor-list" id="bot-list">
        <li class="empty-visitors">No bots detected yet</li>
      </ul>
    </div>
  </div>

  <div id="connection" class="disconnected">● Disconnected</div>

  <footer>
    Timer stores a single start timestamp in a Durable Object and stays accurate
    even when nobody is visiting. Bot score (0–100) combines Cloudflare Bot
    Management, User-Agent patterns, geo signals and simple behavior.
    Threshold ≥ 45 → Suspected Bot.
  </footer>

  <script>
    const displayEl     = document.getElementById("display");
    const totalEl       = document.getElementById("total-seconds");
    const statusTextEl  = document.getElementById("status-text");
    const startTimeEl   = document.getElementById("start-time");
    const serverTimeEl  = document.getElementById("server-time");
    const totalVisitsEl = document.getElementById("total-visits");
    const realCountEl   = document.getElementById("real-count");
    const botCountEl    = document.getElementById("bot-count");
    const realListCount = document.getElementById("real-list-count");
    const botListCount  = document.getElementById("bot-list-count");
    const realList      = document.getElementById("real-list");
    const botList       = document.getElementById("bot-list");
    const connEl        = document.getElementById("connection");
    const btnRefresh    = document.getElementById("btn-refresh");

    let startTime = null;
    let tickInterval = null;
    let socket = null;
    let reconnectTimer = null;

    function formatHMS(totalSeconds) {
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;
      return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
    }

    function countryFlag(code) {
      if (!code || code.length !== 2) return "🏳️";
      const cc = code.toUpperCase();
      return String.fromCodePoint(...[...cc].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
    }

    function relativeTime(ts) {
      const diff = Math.floor((Date.now() - ts) / 1000);
      if (diff < 60) return diff + "s ago";
      if (diff < 3600) return Math.floor(diff / 60) + "m ago";
      if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
      return Math.floor(diff / 86400) + "d ago";
    }

    function render(elapsed) {
      displayEl.textContent = formatHMS(elapsed);
      totalEl.textContent = elapsed.toLocaleString() + " second" + (elapsed === 1 ? "" : "s");
    }

    function visitorItem(v, showScore) {
      const loc = [v.city, v.country].filter(Boolean).join(", ") || "Unknown location";
      const flag = countryFlag(v.country);
      const scoreClass = v.botScore >= 70 ? "high" : v.botScore >= 45 ? "mid" : "";
      const reasons = (v.botReasons && v.botReasons.length)
        ? \`<div class="visitor-reasons">\${v.botReasons.slice(0, 3).join(" · ")}</div>\`
        : "";
      const scoreBadge = showScore
        ? \`<span class="score-badge \${scoreClass}">\${v.botScore}</span>\`
        : "";
      return \`
        <li>
          <span class="flag">\${flag}</span>
          <div class="visitor-info">
            <div class="visitor-location">\${loc}</div>
            <div class="visitor-meta">\${v.ip}</div>
            \${reasons}
          </div>
          <div class="visitor-right">
            \${scoreBadge}
            <span class="visitor-time">\${relativeTime(v.timestamp)}</span>
          </div>
        </li>
      \`;
    }

    function renderVisitors(visitors) {
      const real = [];
      const bots = [];
      (visitors || []).forEach(v => {
        if (v.isBot) bots.push(v);
        else real.push(v);
      });

      realCountEl.textContent = real.length.toLocaleString();
      botCountEl.textContent = bots.length.toLocaleString();
      realListCount.textContent = real.length;
      botListCount.textContent = bots.length;

      realList.innerHTML = real.length
        ? real.map(v => visitorItem(v, false)).join("")
        : '<li class="empty-visitors">No real visitors yet</li>';

      botList.innerHTML = bots.length
        ? bots.map(v => visitorItem(v, true)).join("")
        : '<li class="empty-visitors">No bots detected yet</li>';
    }

    function applyStatus(data) {
      startTime = data.startTime;
      statusTextEl.textContent = data.isRunning ? "Running" : "Not started";
      startTimeEl.textContent = data.startTime
        ? new Date(data.startTime).toISOString()
        : "—";
      serverTimeEl.textContent = new Date(data.serverTime).toISOString();
      totalVisitsEl.textContent = (data.totalVisits || 0).toLocaleString();
      renderVisitors(data.recentVisitors || []);

      if (data.isRunning && data.startTime) {
        const elapsed = Math.floor((Date.now() - data.startTime) / 1000);
        render(Math.max(0, elapsed));
        startLocalTicker();
      } else {
        render(0);
        stopLocalTicker();
      }
    }

    function startLocalTicker() {
      stopLocalTicker();
      tickInterval = setInterval(() => {
        if (startTime == null) return;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        render(Math.max(0, elapsed));
      }, 1000);
    }

    function stopLocalTicker() {
      if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
      }
    }

    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = proto + "//" + location.host + "/ws";
      socket = new WebSocket(wsUrl);

      socket.addEventListener("open", () => {
        connEl.textContent = "● Connected (WebSocket)";
        connEl.className = "connected";
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
      });

      socket.addEventListener("message", (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "status") applyStatus(msg);
        } catch (e) {
          console.warn("Bad WS message", e);
        }
      });

      socket.addEventListener("close", () => {
        connEl.textContent = "● Disconnected – reconnecting…";
        connEl.className = "disconnected";
        stopLocalTicker();
        reconnectTimer = setTimeout(connect, 2000);
      });

      socket.addEventListener("error", () => socket.close());
    }

    async function pollStatus() {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        applyStatus(data);
        connEl.textContent = "● Connected (polling)";
        connEl.className = "connected";
      } catch (err) {
        console.error(err);
        connEl.textContent = "● Error – retrying…";
        connEl.className = "disconnected";
      }
    }

    btnRefresh.addEventListener("click", () => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send("status");
      } else {
        pollStatus();
      }
    });

    connect();
    setTimeout(() => {
      if (startTime == null) pollStatus();
    }, 4000);
  </script>
</body>
</html>`;
