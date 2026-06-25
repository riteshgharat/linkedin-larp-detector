# 🎭 LinkedIn LARP Detector

A Chrome extension that uses AI to detect performative LinkedIn posts — rating how "LARPy" they are and translating what the author is actually saying beneath the performance.

---

## What is LinkedIn LARPing?

**LARP** (Live Action Role Play) on LinkedIn means crafting posts that perform authenticity, vulnerability, or wisdom — not to share genuine insight, but to build a personal brand and farm engagement.

Examples:
- *"I almost didn't apply… but I got the job at Google."* → Humble Brag
- *"Failure is just success wearing a disguise."* → Thought Leader Cosplay
- *"I slept 4 hours. Shipped the feature. Repeat."* → Hustle Mindset

The detector scores each post 0–100 and tells you what it *actually* means.

---

## Architecture

```
extension/          ← Chrome Extension (Manifest V3)
  ├── manifest.json
  ├── background.js ← Service Worker: proxies API calls
  ├── content.js    ← Injected into LinkedIn: adds "🔍 Detect LARP" buttons
  ├── popup/        ← Extension popup UI
  └── utils/api.js

backend/            ← FastAPI + Redis (Docker)
  ├── app/
  │   ├── main.py
  │   ├── config.py
  │   ├── routes/analyze.py
  │   ├── services/groq_service.py
  │   ├── core/cache.py
  │   ├── core/security.py
  │   └── middleware/rate_limit.py
  └── prompts/system_prompt.txt
```

**Data flow:**
1. Extension captures post text → sends to backend via Service Worker
2. Backend checks Redis cache → if hit, returns instantly (no API cost)
3. On cache miss → calls Groq (Llama 3.3 70B) with system prompt
4. Groq returns structured JSON → cached in Redis for 24h → returned to extension
5. Extension renders inline result card with score, category, reason, and "translation"

---

## LARP Categories

| Category | What it means |
|---|---|
| **Humble Brag** | Disguised boast pretending to be modesty |
| **Fake Vulnerability** | Curated "struggle" that conveniently ends in triumph |
| **Thought Leader Cosplay** | Vague aphorisms with zero substance |
| **Hustle Mindset** | Glorifying overwork as a virtue |
| **Engagement Bait** | Posts designed to force comments/reactions |
| **Name Dropper** | Borrowing status via celebrity/company mentions |
| **Fake Relatability** | Wealthy person pretending to be just like you |
| **Mission Creep** | Inflating ordinary work into world-changing impact |
| **Genuine** | Actually authentic — rare, but it exists |

**Score scale:** `0-20` Genuine → `21-40` Mildly LARPy → `41-60` Moderate → `61-80` High → `81-100` Peak LARP

---

## How to run the extensions
If you wanna connect to the hosted backend
### Load the Chrome extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder

### Test it

- Go to [linkedin.com](https://www.linkedin.com)
- A **🔍 Detect LARP** button will appear on each post
- Click it to get the analysis inline
- Or click the extension icon to paste text manually


## Local Development
If you wanna run backend locally

### Prerequisites

- Docker & Docker Compose
- A [Groq API key](https://console.groq.com/)
- Chrome or Chromium browser

### 1. Start the backend

```bash
cd backend

# Copy and fill in your Groq API key
cp .env.example .env
# Edit .env → set GROQ_API_KEY=gsk_...

# Start FastAPI + Redis
docker compose up --build
```

API will be available at `http://localhost:8000`  
Health check: `http://localhost:8000/health`

### 2. Load the Chrome extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 3. Test it

- Go to [linkedin.com](https://www.linkedin.com)
- A **🔍 Detect LARP** button will appear on each post
- Click it to get the analysis inline
- Or click the extension icon to paste text manually

---

## Configuration

All backend settings live in `backend/.env`:

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | *(required)* | Your Groq API key |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model to use |
| `USE_CACHE` | `false` | Set to `true` to cache analysis results in Redis |
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL (rate limiting always uses Redis) |
| `CACHE_TTL_SECONDS` | `86400` | Cache duration (24h), only when `USE_CACHE=true` |
| `MAX_POST_LENGTH` | `3000` | Max input characters |
| `RATE_LIMIT_PER_MINUTE` | `10` | Requests/minute per IP |
| `RATE_LIMIT_PER_DAY` | `100` | Requests/day per IP |
| `ENVIRONMENT` | `development` | `development` or `production` |

The extension's backend URL defaults to `http://localhost:8000` and can be changed via the **⚙️ Settings** panel in the popup.

---

## API Reference

### `POST /analyze`

Analyze a LinkedIn post for LARP content.

**Request:**
```json
{ "text": "I almost gave up on my startup 3 times. Then we hit $1M ARR." }
```

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

**Rate limits:** 10 req/min, 100 req/day per IP  
**Max input:** 3000 characters

### `GET /health`

```json
{ "status": "ok" }
```

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
cd backend
cp .env.example .env
# Edit .env:
#   GROQ_API_KEY=gsk_...
#   ENVIRONMENT=production
#   USE_CACHE=true          # optional — enables Redis result caching
```

### 3. Build & run production containers

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

This starts FastAPI (4 workers) + Redis. Redis is not exposed externally.

Verify: `curl http://localhost:8000/health`

### 4. Nginx reverse proxy

Copy the included config and point it at the local API:

```bash
sudo cp nginx/larp.conf /etc/nginx/sites-available/larp
sudo ln -sf /etc/nginx/sites-available/larp /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

Edit `/etc/nginx/sites-available/larp` — replace `server_name _;` with your domain (or Elastic IP hostname), and change the upstream to host networking:

```nginx
proxy_pass http://127.0.0.1:8000;
```

Test and reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 5. HTTPS (recommended)

If you have a domain pointing at the server:

```bash
sudo certbot --nginx -d api.yourdomain.com
```

Certbot auto-renews. Your extension API URL becomes `https://api.yourdomain.com`.

### 6. Extension configuration

In the extension popup **Settings**, set the API URL to your production endpoint (e.g. `https://api.yourdomain.com`).

Also add that host to `extension/manifest.json` under `host_permissions`:

```json
"host_permissions": [
  "https://www.linkedin.com/*",
  "https://api.yourdomain.com/*"
]
```

Then reload the extension in `chrome://extensions/`.

### Stable public address (EC2 IP changes on stop/start)

EC2 **public IPs change** every time you stop and start the instance. Do **not** point the extension at a raw IP. Use one of these:

| Approach | Cost | How |
|---|---|---|
| **Elastic IP (recommended)** | Free while instance is running | EC2 → Elastic IPs → Allocate → Associate with your instance. IP stays fixed across reboots. |
| **Domain + Route 53** | ~$0.50/mo for hosted zone | Buy a domain, create an A record pointing to your Elastic IP. Extension uses `https://api.yourdomain.com`. |
| **Application Load Balancer** | ~$16/mo | ALB gets a stable DNS name (`xxx.elb.amazonaws.com`). Overkill for a single instance. |

**Elastic IP is the simplest fix:** allocate one, associate it with your EC2 instance, and use that IP (or a domain pointing to it) in the extension settings. The IP survives reboots; you only lose it if you release the Elastic IP or terminate the instance.

Set `ENVIRONMENT=production` — this switches CORS from `*` (allow all) to `chrome-extension://*` (extension only).

---

## Packaging the Extension

To create a distributable ZIP:

```bash
cd extension
zip -r ../linkedin-larp-detector-extension.zip . \
  --exclude "*.DS_Store" \
  --exclude "__pycache__/*"
```

Upload `linkedin-larp-detector-extension.zip` as a GitHub Release asset.

---

## Security Notes

- **`.env` is gitignored** — never commit it
- **Rate limiting** is enforced server-side via Redis (SlowAPI), not just client-side
- **Input sanitization** happens at the Pydantic schema layer before any API call
- **Stack traces are never returned** to the client — generic error messages only
- **Redis is not exposed** in production (docker-compose.prod.yml)
- **CORS** is locked to extension-only in production

---

## Tech Stack

| Layer | Tech |
|---|---|
| Extension | Chrome Manifest V3, Vanilla JS |
| Backend | FastAPI (Python 3.11) |
| AI | Groq API — Llama 3.3 70B Versatile |
| Cache | Redis 7 |
| Rate Limiting | SlowAPI + Redis |
| Containerization | Docker + Docker Compose |
| Reverse Proxy | Nginx |
