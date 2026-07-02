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
  ├── background.js ← Service Worker: proxies API calls, manages API URL storage
  ├── content.js    ← Injected into LinkedIn: injects icon button, renders results safely
  ├── popup/        ← Extension popup UI (manual paste + settings panel)
  └── utils/api.js  ← Shared fetch helpers for popup

backend/            ← FastAPI + Redis (Docker)
  ├── app/
  │   ├── main.py               ← App factory, exception handlers
  │   ├── config.py             ← Pydantic settings (loaded from .env)
  │   ├── routes/analyze.py     ← POST /analyze endpoint
  │   ├── services/
  │   │   ├── groq_service.py   ← Groq (cloud) LLM integration
  │   │   └── ollama_service.py ← Ollama (local) LLM integration
  │   ├── core/
  │   │   ├── cache.py          ← Async-safe Redis cache (get/set)
  │   │   ├── errors.py         ← ServiceError — maps internal errors to safe HTTP responses
  │   │   └── security.py       ← CORS config + input sanitization
  │   └── middleware/rate_limit.py ← SlowAPI rate limiter with Redis fallback
  ├── nginx/larp.conf           ← Reverse proxy config with security headers
  ├── prompts/system_prompt.txt ← LLM system prompt (validated at startup)
  ├── Dockerfile
  ├── docker-compose.yml        ← Local development
  └── docker-compose.prod.yml  ← Production overrides (4 workers, no exposed Redis)
```

**Data flow:**
1. Extension captures post text → sent to backend via Service Worker (`background.js`)
2. Backend validates + sanitizes input → checks Redis cache → returns hit instantly
3. On cache miss → calls configured LLM (Groq or Ollama) with system prompt
4. LLM returns structured JSON → validated → cached in Redis 24h → returned to extension
5. Extension renders result inline using **safe DOM construction** (no `innerHTML` with dynamic data)

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
- A sparkle **✦** icon button will appear on each post's action bar (next to Comment / Repost)
- Click it — the post text blurs with a shimmer animation while analysis runs
- Results appear inline below the post: score badge, category, plain-English summary, and reason
- Clicking again on an already-analyzed post replaces the result (no duplicates)
- If a post has a **"See more"** link, the extension auto-expands it before analyzing
- Or click the extension icon to paste text manually in the popup


## Local Development
If you wanna run backend locally

### Prerequisites

- Docker & Docker Compose
- **One of** the following LLM backends:
  - A [Groq API key](https://console.groq.com/) *(cloud, free tier available)*
  - [Ollama](https://ollama.com/) running locally *(fully offline)*
- Chrome or Chromium browser

### 1. Start the backend

```bash
cd backend
cp .env.example .env
```

Then edit `.env` for your chosen LLM provider:

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

```bash
# Start FastAPI + Redis
docker compose up --build
```

API available at `http://localhost:8000` — health check: `http://localhost:8000/health`