# 🎭 LinkedIn LARP Detector — Backend

FastAPI service that accepts LinkedIn post text, routes it to a configured LLM (Groq or Ollama), and returns a structured LARP analysis. Includes Redis caching, per-IP rate limiting, and an Nginx reverse proxy config for production.

---

## Architecture

```
backend/
  ├── app/
  │   ├── main.py               ← App factory, global exception handlers
  │   ├── config.py             ← Pydantic settings (loaded from .env)
  │   ├── routes/
  │   │   └── analyze.py        ← POST /analyze endpoint
  │   ├── services/
  │   │   ├── groq_service.py   ← Groq (cloud) LLM integration
  │   │   └── ollama_service.py ← Ollama (local) LLM integration
  │   ├── core/
  │   │   ├── cache.py          ← Async-safe Redis cache (get/set with double-checked lock)
  │   │   ├── errors.py         ← ServiceError — maps internal errors to safe HTTP responses
  │   │   └── security.py       ← CORS config + input sanitization
  │   └── middleware/
  │       └── rate_limit.py     ← SlowAPI rate limiter with Redis fallback
  ├── nginx/
  │   └── larp.conf             ← Reverse proxy config with security headers
  ├── prompts/
  │   └── system_prompt.txt     ← LLM system prompt (validated at startup)
  ├── Dockerfile
  ├── docker-compose.yml        ← Local development
  ├── docker-compose.prod.yml   ← Production overrides (4 workers, no exposed Redis)
  ├── requirements.txt
  ├── .env.example
  └── .env                      ← (gitignored — never commit)
```

---

## Data Flow

```
POST /analyze
     │
     ▼
Pydantic validation + sanitize_post_text()
     │
     ▼
Redis cache lookup (if USE_CACHE=true)
  ├── HIT  → return cached result immediately
  └── MISS ↓
            ▼
     LLM_PROVIDER routing
       ├── groq   → groq_service.py   → Groq API (cloud)
       └── ollama → ollama_service.py → Ollama (local)
            │
            ▼
     _validate_and_format_response()
     (required fields, score clamped 0–100)
            │
            ▼
     Store in Redis (TTL = CACHE_TTL_SECONDS)
            │
            ▼
     Return JSON to extension
```

---

## Local Development

### Prerequisites

- Docker & Docker Compose
- **One of** the following LLM backends:
  - A [Groq API key](https://console.groq.com/) *(cloud, free tier available)*
  - [Ollama](https://ollama.com/) running locally *(fully offline)*

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env` for your chosen LLM provider:

**Option A — Groq (cloud):**
```env
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile
```

**Option B — Ollama (local, fully offline):**
```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://host.docker.internal:11434   # Docker → host Ollama
OLLAMA_MODEL=llama3
```

> Make sure Ollama is running on your host: `ollama serve` and `ollama pull llama3`

### 2. Start the backend

```bash
docker compose up --build
```

API available at `http://localhost:8000`
Health check: `http://localhost:8000/health`

---

## Configuration

All settings are read from `backend/.env` via Pydantic `BaseSettings`. Each variable maps directly to the corresponding `Settings` field in `app/config.py`.

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `groq` | `groq` or `ollama` — selects the AI backend |
| `GROQ_API_KEY` | *(required if using Groq)* | Your Groq API key |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model to use |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL (use `host.docker.internal` inside Docker) |
| `OLLAMA_MODEL` | `llama3` | Ollama model name (e.g. `llama3`, `mistral`) |
| `USE_CACHE` | `false` | Set to `true` to cache analysis results in Redis |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL (rate limiting always uses Redis) |
| `CACHE_TTL_SECONDS` | `86400` | Cache TTL in seconds (24h); only when `USE_CACHE=true` |
| `MAX_POST_LENGTH` | `3000` | Max input characters accepted by the API |
| `RATE_LIMIT_PER_MINUTE` | `10` | Requests/minute per IP |
| `RATE_LIMIT_PER_DAY` | `100` | Requests/day per IP |
| `ENVIRONMENT` | `development` | `development` (CORS open) or `production` (extension-only CORS) |

---

## API Reference

### `POST /analyze`

Analyze a LinkedIn post for LARP content.

**Request:**
```json
{ "text": "I almost gave up on my startup 3 times. Then we hit $1M ARR." }
```

| Field | Type | Constraints |
|---|---|---|
| `text` | `string` | Required. 1–3000 characters. Whitespace-trimmed. |

**Response:**
```json
{
  "score": 72,
  "category": "Humble Brag",
  "reason": "The post opens with manufactured struggle ('almost gave up 3 times') only to pivot immediately to a revenue milestone. The vulnerability is a setup, not a confession.",
  "translation": "We made a million dollars. I'm mentioning the struggle so it sounds earned rather than lucky.",
  "cached": false
}
```

| Field | Type | Description |
|---|---|---|
| `score` | `integer` | 0–100 LARP intensity score |
| `category` | `string` | LARP archetype (e.g. "Humble Brag", "Thought Leader Cosplay") |
| `reason` | `string` | Short explanation of the verdict |
| `translation` | `string` | Plain-English rewrite of what the post actually says |
| `cached` | `boolean` | `true` if returned from Redis cache |

**Rate limits:** 10 req/min, 100 req/day per IP
**Max input:** 3000 characters

**Error responses** — all errors return a safe generic message, no stack traces:

| Status | Meaning |
|---|---|
| `422` | Invalid request (empty text, missing field, oversized input) |
| `429` | Rate limit exceeded |
| `502` | LLM returned invalid or incomplete response |
| `503` | LLM service unavailable (connection/rate limit error) |
| `504` | LLM request timed out (30s limit) |

---

### `GET /health`

```json
{ "status": "ok" }
```

Returns `200` when the API is up. Does not check Redis or LLM connectivity.

---

## Production Deployment

### 1. EC2 setup

```bash
# On a fresh Ubuntu EC2 instance
sudo apt update && sudo apt install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx
sudo usermod -aG docker $USER
# Log out and back in so docker group applies
```

Open inbound ports in the EC2 **Security Group**: `22` (SSH), `80` (HTTP), `443` (HTTPS).

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — minimum required settings:
#   LLM_PROVIDER=groq          # or ollama
#   GROQ_API_KEY=gsk_...       # required if LLM_PROVIDER=groq
#   ENVIRONMENT=production      # locks CORS to chrome-extension://* only
#   USE_CACHE=true              # optional — cache results in Redis for 24h
```

### 3. Build & run production containers

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

This starts FastAPI (4 workers) + Redis. Redis is not exposed externally.

Verify: `curl http://localhost:8000/health`

### 4. Nginx reverse proxy

```bash
sudo cp nginx/larp.conf /etc/nginx/sites-available/larp
sudo ln -sf /etc/nginx/sites-available/larp /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

Edit `/etc/nginx/sites-available/larp` — replace `server_name _;` with your domain or Elastic IP:

```nginx
server_name api.yourdomain.com;  # or your Elastic IP
proxy_pass http://127.0.0.1:8000;
```

Test and reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The included `nginx/larp.conf` already sets:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: no-referrer`
- `client_max_body_size 16k` — blocks oversized payloads
- `proxy_read_timeout 30s` — matches the LLM request timeout

### 5. HTTPS (recommended)

```bash
sudo certbot --nginx -d api.yourdomain.com
```

Certbot auto-renews. Set the extension API URL to `https://api.yourdomain.com`.

### Stable public address

EC2 **public IPs change** on every stop/start. Do **not** hard-code a raw IP. Options:

| Approach | Cost | Notes |
|---|---|---|
| **Elastic IP (recommended)** | Free while running | EC2 → Elastic IPs → Allocate → Associate. Survives reboots. |
| **Domain + Route 53** | ~$0.50/mo | A record → Elastic IP. Gives a clean hostname for Certbot. |
| **Application Load Balancer** | ~$16/mo | Stable DNS name. Overkill for a single instance. |

---

## Security Notes

- **`.env` is gitignored** — never commit it; use `.env.example` as the reference
- **Input sanitized at schema layer** — `sanitize_post_text()` called by Pydantic `field_validator` before any LLM call
- **Stack traces never returned** — all exception handlers return generic safe messages
- **Upstream error codes not leaked** — Groq/Ollama HTTP status codes are logged server-side only; client always receives a normalized error message
- **System prompt validated at startup** — missing `prompts/system_prompt.txt` raises a clear `RuntimeError` with the file path; the app refuses to start rather than silently failing on the first request
- **Redis client is async-safe** — `get_client()` uses `asyncio.Lock()` with double-checked locking; no duplicate connections under concurrent coroutines
- **Rate limiting degrades gracefully** — `resilient_limit()` allows requests through if Redis is unavailable, so a Redis outage doesn't take down the API
- **Redis not exposed in production** — `docker-compose.prod.yml` omits the Redis port mapping
- **CORS locked in production** — `ENVIRONMENT=production` switches from `allow_origins=["*"]` to `allow_origin_regex=r"^chrome-extension://.*$"`; no browser tab can call the API directly

---

## Tech Stack

| Layer | Tech |
|---|---|
| Framework | FastAPI (Python 3.11), Uvicorn |
| Settings | Pydantic v2 `BaseSettings` |
| AI (cloud) | Groq API — Llama 3.3 70B Versatile |
| AI (local) | Ollama — any compatible model (llama3, mistral, …) |
| Cache | Redis 7 (async, optional, TTL-based) |
| Rate Limiting | SlowAPI + Redis (graceful fallback if Redis unavailable) |
| Containerization | Docker + Docker Compose |
| Reverse Proxy | Nginx (security headers, 16KB body limit, 30s timeout) |
