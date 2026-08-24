# Global Persistent Timer + Visitor Counter

A production-ready, globally shared wall-clock timer built with **Cloudflare Workers** and **Durable Objects**, plus a live visitor log with bot filtering.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RegisterMySite-com/durable-object-timer)

One single timer for the entire website. It starts the first time anyone visits, keeps counting accurately even when every visitor leaves (for hours or days), and shows the correct elapsed time the moment someone returns.

It also records every visitor's IP, country (with flag), city, User-Agent and timestamp, then assigns a **bot score** (0-100).

- **Total Visits** - all-time counter
- **Real Visitors** / **Suspected Bots** - two columns for the last 24 hours
- Bot score combines Cloudflare Bot Management, known bot User-Agents, missing headers, verified-bot flag, and simple behavioral signals (rapid repeats from the same IP). Score >= 45 -> Suspected Bot column.

## Deploy to Cloudflare

Click the button above, or use this markdown on any page:

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/RegisterMySite-com/durable-object-timer)
```

Repo: [https://github.com/RegisterMySite-com/durable-object-timer](https://github.com/RegisterMySite-com/durable-object-timer)

After deploy you will get a `*.workers.dev` URL (or attach a custom domain). Replace `YOUR_WORKER_URL` in the examples below with that hostname.

## Embed analytics on any webpage (1×1 iframe)

You can collect visitor vs bot analytics on **any** HTML site by embedding a 1×1 transparent iframe that points at your deployed Worker. Every time a page loads, the iframe hits the Worker, which records the visit (IP, geo, User-Agent) and runs bot scoring — without showing anything to the user.

### Minimal embed

Paste this just before `</body>` on any page:

```html
<!-- durable-object-timer analytics pixel (1×1) -->
<iframe
  src="https://YOUR_WORKER_URL/api/status"
  width="1"
  height="1"
  style="position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none;"
  title="analytics"
  loading="eager"
  referrerpolicy="no-referrer-when-downgrade"
></iframe>
```

`/api/status` both records the visit **and** returns JSON. The iframe does not need to display the response; the request alone is enough for tracking.

### Alternative: hit the HTML root

If you prefer the main page endpoint (also records a visit):

```html
<iframe
  src="https://YOUR_WORKER_URL/"
  width="1"
  height="1"
  style="position:absolute;width:1px;height:1px;border:0;clip:rect(0,0,0,0);"
  title="analytics"
  loading="eager"
></iframe>
```

### Example with a custom domain

```html
<iframe
  src="https://global-timer.example.com/api/status"
  width="1"
  height="1"
  style="position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none;"
  title="analytics"
></iframe>
```

### What gets recorded

Each iframe load records:

| Field | Source |
|-------|--------|
| IP | `CF-Connecting-IP` |
| Country / city | Cloudflare `request.cf` |
| User-Agent | Request headers |
| Timestamp | Server wall clock |
| Bot score (0–100) | CF Bot Management + UA patterns + behavior |
| Real vs bot | Score >= 45 → Suspected Bot |

View results on the Worker dashboard UI (`https://YOUR_WORKER_URL/`) or via:

```bash
curl https://YOUR_WORKER_URL/api/status
```

### Notes

- The iframe is invisible (`1×1`, `opacity:0`, no pointer events).
- Cross-origin embeds work; the Worker responds with permissive CORS.
- Some browsers or privacy extensions may block third-party iframes; first-party custom domains (e.g. `analytics.yourdomain.com`) improve reliability.
- Bot scoring still runs on iframe traffic (crawlers, headless tools, empty UAs, etc.).

## How it works

### The startTime approach (critical design decision)

We **do not** keep a counter and increment it every second in the background. That would require the Durable Object to stay awake forever (expensive and against hibernation).

Instead:

1. The first time the timer is started we store a single value in Durable Object storage:

   ```ts
   startTime = Date.now(); // Unix timestamp in milliseconds
   ```

2. On every subsequent request (or WebSocket message) we simply calculate:

   ```ts
   elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
   ```

Because the calculation uses the real wall clock, the timer continues correctly while the Durable Object is hibernated or completely evicted from memory. When a visitor returns days later the elapsed time is still exact.

### Visitor tracking + bot filtering

On every page load, `/api/status` call, or WebSocket connect the Worker / Durable Object records:

- IP address (`CF-Connecting-IP`)
- Country & city (from Cloudflare's `request.cf` geo data)
- User-Agent
- Timestamp
- Composite bot score (0-100)

Storage:

- `totalVisits` - monotonically increasing all-time counter
- `recentVisits` - array pruned to the last 24 hours (capped at 60 entries)

The UI shows two columns: **Real Visitors** and **Suspected Bots** (with score badges and reasons).

### Architecture

```
Browser  --HTTP/WS-->  Worker  --RPC / fetch-->  Durable Object "Timer"
                                                   |
                                                   +- storage: {
                                                        startTime,
                                                        totalVisits,
                                                        recentVisits[]
                                                      }
```

- **Worker** (`src/index.ts`)
  - Serves the HTML frontend
  - Exposes `/api/status`
  - Forwards WebSocket upgrades to the Durable Object
  - Extracts client IP + geo + UA and calls `recordVisit`

- **Durable Object class `Timer`**
  - Single instance obtained with `idFromName("global-timer")`
  - RPC methods: `start()`, `getElapsedSeconds()`, `getStatus()`, `recordVisit()`, `reset()`
  - WebSocket Hibernation API for live clients
  - Persistent storage via `this.ctx.storage` (SQLite-backed)

### Why the timer stays accurate when no one is on the site

Durable Objects can be removed from memory after a short period of inactivity (hibernation). Hibernated WebSockets stay connected, but the object itself is gone. Because we only store a timestamp and never rely on in-memory counters or recurring alarms, the next request simply reads the stored `startTime` and recomputes the elapsed seconds from `Date.now()`. No background work is required.

### WebSocket strategy

- Client opens a WebSocket to `/ws`.
- On connect the Durable Object records the visit and immediately sends the current status (including recent visitors).
- The browser then runs a local `setInterval` that advances the display every second using the received `startTime`.
  This keeps the UI smooth **without** waking the Durable Object every second.
- Fallback polling of `/api/status` is also implemented.

## Project structure

```
durable-object-timer/
├── package.json
├── wrangler.toml          # Durable Object binding + SQLite migration
├── tsconfig.json
├── src/
│   └── index.ts           # Worker + Timer Durable Object + embedded frontend
└── README.md
```

## Deploy (CLI)

### Prerequisites

- Node.js 18+
- A Cloudflare account
- Wrangler CLI (installed via the project)

```bash
cd durable-object-timer
npm install
```

### Local development

```bash
npx wrangler dev
```

Open the URL shown (usually `http://localhost:8787`).
Note: in local mode `request.cf` geo data is usually absent and the IP will appear as `127.0.0.1`. Real country/city data appears only after deployment to the Cloudflare edge.

### Production deploy

```bash
npx wrangler deploy
```

Or use the Deploy to Cloudflare button at the top of this README.

### Configuration notes

`wrangler.toml` already contains:

```toml
[[durable_objects.bindings]]
name = "TIMER"
class_name = "Timer"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Timer"]
```

New Durable Object namespaces must use the SQLite storage backend (`new_sqlite_classes`). The classic key-value API (`storage.get` / `storage.put`) continues to work on top of SQLite.

## API

| Method | Path          | Description                                      |
|--------|---------------|--------------------------------------------------|
| GET    | `/`           | HTML frontend (records a visit)                  |
| GET    | `/api/status` | JSON status + records a visit                    |
| GET    | `/ws`         | WebSocket upgrade (visit recorded inside the DO) |

## Making it per-room or per-user later

The current design uses a single well-known name:

```ts
const id = env.TIMER.idFromName("global-timer");
```

To support many independent timers simply derive the ID from a room or user identifier:

```ts
const roomId = url.searchParams.get("room") ?? "default";
const id = env.TIMER.idFromName(`timer:${roomId}`);
const stub = env.TIMER.get(id);
```

Each unique name gets its own Durable Object instance with completely isolated storage.

## Key takeaways

- Store a timestamp, never a live counter.
- Let the wall clock do the work.
- Use WebSocket Hibernation so idle connections cost almost nothing.
- Keep the Durable Object constructor and message handlers cheap so hibernation wake-ups stay fast.
- Prefer RPC methods for ordinary operations; reserve `fetch` for WebSocket upgrades.
- Visitor data is pruned automatically to the last 24 hours.
- Bot score >= 45 filters visitors into the Suspected Bots column.
- Embed a 1×1 iframe to collect analytics on any site.

Enjoy the timer that never sleeps.
