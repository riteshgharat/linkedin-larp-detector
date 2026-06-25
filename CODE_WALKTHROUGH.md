# LinkedIn LARP Detector Code Walkthrough

This file is the "please explain it like I'm new" version of the project.

I explain the backend, the Chrome extension, the Redis cache, the Groq API call, and the EC2 deployment path. For the longer files (`content.js`, `popup.js`, `popup.css`, and `popup.html`), I explain them in the exact order they run, but I group tightly related lines together so the explanation stays readable.

## 1. What the app does

The project has two big parts:

1. The **backend** receives LinkedIn post text, cleans it, checks Redis, and if needed asks Groq for an analysis.
2. The **Chrome extension** injects a button into LinkedIn posts and sends selected text to the backend.

The response is always a JSON object with:

1. `score` - how LARPy the post is, from `0` to `100`
2. `category` - the category name like `Humble Brag` or `Thought Leader Cosplay`
3. `reason` - short explanation of why it got that score
4. `translation` - the blunt plain-English meaning
5. `cached` - whether the response came from Redis instead of Groq

## 2. Request flow

Here is the full path a post takes:

1. The extension gets the text from LinkedIn or the popup textarea.
2. The extension sends that text to the background worker.
3. The background worker calls `POST /analyze` on the backend.
4. FastAPI validates and sanitizes the text.
5. The backend creates a Redis cache key from the normalized text.
6. If Redis already has the answer, it returns that immediately.
7. If Redis misses, the backend calls Groq with the system prompt.
8. Groq returns JSON.
9. The backend validates the JSON, clamps the score to `0-100`, stores it in Redis for 24 hours, and returns it.
10. The extension renders the result in the popup or directly inside the LinkedIn post.

## 3. Backend files

### `backend/app/config.py`

1. `from pydantic_settings import BaseSettings` imports Pydantic's settings base class, which reads environment variables and validates them.
2. `from typing import List` imports the `List` type so the settings class can type `allowed_origins` as a list of strings.
3. `class Settings(BaseSettings):` starts the settings object that maps environment variables to Python attributes.
4. `groq_api_key: str` is required and must be present in the environment.
5. `groq_model: str = "llama-3.3-70b-versatile"` sets the default Groq model.
6. `redis_url: str = "redis://localhost:6379"` sets the default Redis connection string for local development.
7. `cache_ttl_seconds: int = 86400` stores analysis results for 24 hours, so the same text does not keep calling the API.
8. `max_post_length: int = 3000` limits how much text the backend will accept.
9. `rate_limit_per_minute: int = 10` sets the per-minute request limit.
10. `rate_limit_per_day: int = 100` sets the per-day request limit.
11. `allowed_origins: List[str] = ["http://localhost"]` is a fallback list of allowed CORS origins, though the app actually uses `CORS_ORIGINS` from `security.py`.
12. `environment: str = "development"` tells the app whether it is running locally or in production.
13. `class Config:` defines Pydantic config for this settings model.
14. `env_file = ".env"` tells Pydantic to read environment variables from a local `.env` file too.
15. `settings = Settings()` creates one settings object at import time, so the rest of the code can import `settings` and use the values immediately.

### `backend/app/core/security.py`

1. `from app.config import settings` imports the app settings so this file can use the environment.
2. `CORS_ORIGINS: list[str] = (` starts the list of allowed cross-origin request sources.
3. `["*"]` is used in development so the backend accepts requests from anywhere, including the extension while you are testing locally.
4. `if settings.environment == "development"` decides which origin list to use based on the environment.
5. `else [` switches to the production list.
6. `"chrome-extension://*",` is intended to allow the extension in production, but this is more of a placeholder than a perfect production CORS rule because real Chrome extension origins are specific IDs.
7. `]` closes the production list.
8. `)` closes the `CORS_ORIGINS` tuple-style expression.
9. `def sanitize_post_text(text: str) -> str:` defines the input cleaning function used before any analysis happens.
10. `"""Strip whitespace and enforce length limits."""` documents the intent: clean the post text and reject bad input.
11. `text = text.strip()` removes leading and trailing whitespace.
12. `if not text:` rejects empty strings after trimming.
13. `raise ValueError("Post text cannot be empty")` stops the request early if the user submits blank text.
14. `if len(text) > settings.max_post_length:` rejects text that is too long.
15. `raise ValueError(` starts the error message for oversized posts.
16. `f"Post exceeds {settings.max_post_length} character limit"` tells the caller exactly why it failed.
17. `)` closes the error message.
18. `return text` gives back the cleaned text.

### `backend/app/core/cache.py`

1. `import hashlib` imports SHA-256 hashing for cache keys.
2. `import json` lets the code serialize and deserialize cached analysis results.
3. `import redis.asyncio as redis` imports the async Redis client.
4. `from app.config import settings` imports Redis URL and TTL settings.
5. `_client: redis.Redis | None = None` starts with no Redis client and uses lazy initialization.
6. `def get_client() -> redis.Redis:` defines a helper that returns a Redis client instance.
7. `global _client` says this function will reuse the module-level client variable.
8. `if _client is None:` checks whether the client has already been created.
9. `_client = redis.from_url(settings.redis_url, decode_responses=True)` creates the Redis connection and tells Redis to return normal strings instead of bytes.
10. `return _client` returns the shared client so all cache calls use the same connection.
11. `def make_cache_key(text: str) -> str:` defines the function that turns a post into a deterministic Redis key.
12. `"""Same post text always maps to the same cache key."""` explains the goal of the function.
13. `return f"larp:{hashlib.sha256(text.strip().lower().encode()).hexdigest()}"` normalizes the text by trimming spaces and lowercasing it, hashes it with SHA-256, and prefixes it with `larp:` so the key namespace stays organized.
14. `async def get_cached(text: str) -> dict | None:` looks up a cached response for that post.
15. `result = await get_client().get(make_cache_key(text))` asks Redis for the stored JSON string.
16. `return json.loads(result) if result else None` converts the JSON string back into a Python dictionary, or returns `None` if Redis had nothing.
17. `async def set_cached(text: str, data: dict) -> None:` stores a fresh analysis result.
18. `await get_client().setex(` writes the value with an expiration time.
19. `make_cache_key(text),` uses the deterministic key from the text.
20. `settings.cache_ttl_seconds,` sets the TTL, which is 24 hours by default.
21. `json.dumps(data),` stores the Python dictionary as JSON text.
22. `)` closes the Redis call.

### `backend/app/middleware/rate_limit.py`

1. `from slowapi import Limiter` imports the rate limiter object.
2. `from slowapi.util import get_remote_address` imports a helper that uses the requester's IP address as the rate-limit key.
3. `from app.config import settings` imports the minute/day limit values.
4. `limiter = Limiter(` creates the shared limiter instance.
5. `key_func=get_remote_address,` means each client is tracked by IP address.
6. `storage_uri=settings.redis_url,` tells SlowAPI to store rate-limit state in Redis.
7. `default_limits=[` starts the default limit list.
8. `f"{settings.rate_limit_per_day}/day",` sets the daily limit.
9. `f"{settings.rate_limit_per_minute}/minute",` sets the minute-by-minute limit.
10. `],` closes the default limits list.
11. `)` closes the limiter setup.

### `backend/app/schemas/larp.py`

1. `from pydantic import BaseModel, field_validator` imports Pydantic model support and the validation decorator.
2. `from app.core.security import sanitize_post_text` imports the input-cleaning function.
3. `class AnalyzeRequest(BaseModel):` defines the request body model for `POST /analyze`.
4. `text: str` says the request must include a `text` field containing the LinkedIn post.
5. `@field_validator("text")` attaches a validator to the `text` field.
6. `@classmethod` makes the validator a class method, which is how Pydantic expects it.
7. `def validate_text(cls, v: str) -> str:` receives the raw text value before the model is created.
8. `return sanitize_post_text(v)` trims the text and rejects empty or overly long input.
9. `class AnalyzeResponse(BaseModel):` defines the shape of the JSON the backend sends back.
10. `score: int` is the 0-100 LARP score.
11. `category: str` is the label like `Humble Brag`.
12. `reason: str` explains the rating.
13. `translation: str` rewrites the post in plain English.
14. `cached: bool = False` defaults to `False` so new analyses are marked uncached unless the route changes it.

### `backend/app/services/groq_service.py`

1. `import json` is used to parse the model's JSON output.
2. `import os` is imported but not used in this file, so it looks like leftover code.
3. `from pathlib import Path` is used to build the path to the prompt file.
4. `from groq import AsyncGroq` imports the async Groq client.
5. `from app.config import settings` imports the API key and model name.
6. `_PROMPT_PATH = Path(__file__).parent.parent.parent / "prompts" / "system_prompt.txt"` builds the absolute path to the system prompt file by walking up from this file's location.
7. `_SYSTEM_PROMPT: str = _PROMPT_PATH.read_text(encoding="utf-8")` loads the prompt once at import time so every request can reuse it without reading the disk again.
8. `_client = AsyncGroq(api_key=settings.groq_api_key)` creates the Groq client using the configured API key.
9. `async def analyze_post(text: str) -> dict:` defines the async helper that sends the post text to Groq and returns a Python dictionary.
10. `"""Call Groq with the post text and return a structured analysis dict.` documents the function's job.
11. `Raises on API or parse errors - caller handles retries / error responses.` tells you the function expects its caller to handle failures.
12. `"""` closes the docstring.
13. `_client.chat.completions.create(` starts the chat-completion request.
14. `model=settings.groq_model,` uses the configured model.
15. `messages=[` starts the prompt message list.
16. `{"role": "system", "content": _SYSTEM_PROMPT},` gives the model the rules, categories, scoring rubric, and output format.
17. `{"role": "user",` begins the actual user message containing the post.
18. `"content": (` opens the text that will be analyzed.
19. `"Analyze the following LinkedIn post and return ONLY the JSON object:\n\n"` tells the model to ignore everything except a JSON object.
20. `f"{text}"` inserts the LinkedIn post itself.
21. `),` closes the user content string.
22. `},` closes the user message object.
23. `],` closes the messages list.
24. `temperature=0.3,` keeps output more consistent and less random.
25. `max_tokens=512,` caps the response size.
26. `response_format={"type": "json_object"},` asks Groq to return a JSON object directly.
27. `)` closes the API call.
28. `raw = completion.choices[0].message.content` extracts the response text from the first completion choice.
29. `data = json.loads(raw)` parses the JSON string into a Python dictionary.
30. `required = {"score", "category", "reason", "translation"}` defines the fields the backend must receive.
31. `missing = required - data.keys()` checks whether any required keys are absent.
32. `if missing:` starts the failure branch for incomplete JSON.
33. `raise ValueError(f"Groq response missing fields: {missing}")` fails loudly if the model left anything out.
34. `data["score"] = max(0, min(100, int(data["score"])))` clamps the score to the valid range and converts it to an integer.
35. `return {` starts the normalized output dictionary.
36. `"score": data["score"],` returns the cleaned score.
37. `"category": str(data["category"]),` forces the category into a string.
38. `"reason": str(data["reason"]),` forces the explanation into a string.
39. `"translation": str(data["translation"]),` forces the plain-English summary into a string.
40. `}` closes the returned dictionary.

### `backend/app/routes/analyze.py`

1. `from fastapi import APIRouter, Request` imports the router object and the request type.
2. `from app.schemas.larp import AnalyzeRequest, AnalyzeResponse` imports the request and response schemas.
3. `from app.services.groq_service import analyze_post` imports the Groq analysis helper.
4. `from app.core.cache import get_cached, set_cached` imports the Redis cache helpers.
5. `from app.middleware.rate_limit import limiter` imports the rate limiter.
6. `router = APIRouter()` creates the route group.
7. `@router.post("/analyze", response_model=AnalyzeResponse)` registers the `POST /analyze` endpoint and tells FastAPI what response shape to expect.
8. `@limiter.limit("10/minute")` adds an explicit per-minute limit on top of the default limiter config.
9. `async def analyze(request: Request, body: AnalyzeRequest):` defines the endpoint function and receives the validated request body.
10. `# 1. Cache hit -> return immediately, no Groq call, no cost` describes the fast path.
11. `cached = await get_cached(body.text)` asks Redis whether this exact post has already been analyzed.
12. `if cached:` checks whether Redis returned data.
13. `return {**cached, "cached": True}` returns the cached response and flips the `cached` flag on.
14. `# 2. Cache miss -> call Groq` describes the slow path.
15. `result = await analyze_post(body.text)` sends the text to Groq.
16. `# 3. Persist result for future identical posts` explains why the next line exists.
17. `await set_cached(body.text, result)` writes the new result to Redis with a TTL.
18. `return {**result, "cached": False}` returns the fresh analysis and marks it uncached.

### `backend/app/main.py`

1. `from fastapi import FastAPI, Request` imports the FastAPI app class and the request object used in exception handlers.
2. `from fastapi.middleware.cors import CORSMiddleware` imports the CORS middleware.
3. `from fastapi.responses import JSONResponse` imports the JSON response helper used by error handlers.
4. `from slowapi import _rate_limit_exceeded_handler` imports SlowAPI's default handler, although this file does not actually use it.
5. `from slowapi.errors import RateLimitExceeded` imports the exception class for rate-limit failures.
6. `from app.core.security import CORS_ORIGINS` imports the allowed origins list.
7. `from app.middleware.rate_limit import limiter` imports the shared limiter so FastAPI can attach it.
8. `from app.routes.analyze import router` imports the route module.
9. `app = FastAPI(` creates the FastAPI application object.
10. `title="LinkedIn LARP Detector",` sets the OpenAPI title.
11. `description="Detect performative LinkedIn posts using AI.",` gives the API a short description.
12. `version="1.0.0",` sets the API version.
13. `)` closes the app creation call.
14. `# Attach SlowAPI limiter to app state` explains the next line.
15. `app.state.limiter = limiter` stores the limiter on the app so SlowAPI can use it.
16. `app.add_middleware(` begins the CORS setup.
17. `CORSMiddleware,` installs the cross-origin middleware.
18. `allow_origins=CORS_ORIGINS,` uses the environment-sensitive list from `security.py`.
19. `allow_methods=["POST", "GET"],` only permits the methods this project needs.
20. `allow_headers=["Content-Type"],` permits JSON request bodies.
21. `)` closes the middleware setup.
22. `@app.exception_handler(RateLimitExceeded)` defines the custom response for rate-limit errors.
23. `async def rate_limit_handler(request: Request, exc: RateLimitExceeded):` receives the request and exception.
24. `return JSONResponse(` starts the JSON error response.
25. `status_code=429,` uses HTTP 429 "Too Many Requests".
26. `content={"error": "Rate limit exceeded. Try again shortly."},` sends a simple client-friendly error.
27. `)` closes the response.
28. `@app.exception_handler(Exception)` defines a catch-all handler for unexpected errors.
29. `async def generic_handler(request: Request, exc: Exception):` catches any unhandled exception.
30. `# Never leak stack traces to the client` documents the security goal.
31. `return JSONResponse(` starts the generic error response.
32. `status_code=500,` returns HTTP 500 for server failures.
33. `content={"error": "Analysis failed. Please try again."},` hides internal details from the client.
34. `)` closes the response.
35. `app.include_router(router)` registers the `/analyze` route.
36. `@app.get("/health")` registers a simple health-check endpoint.
37. `async def health():` defines the health-check function.
38. `return {"status": "ok"}` returns a tiny success JSON object.

### `backend/app/__init__.py`

1. `# LinkedIn LARP Detector - app package` is only a package marker comment.

### `backend/app/core/__init__.py`

1. `# core package` marks the `core` folder as a package.

### `backend/app/middleware/__init__.py`

1. `# middleware package` marks the `middleware` folder as a package.

### `backend/app/routes/__init__.py`

1. `# routes package` marks the `routes` folder as a package.

### `backend/app/schemas/__init__.py`

1. `# schemas package` marks the `schemas` folder as a package.

### `backend/app/services/__init__.py`

1. `# services package` marks the `services` folder as a package.

## 4. The system prompt

### `backend/prompts/system_prompt.txt`

This file is the "brain instruction manual" for Groq. It tells the model:

1. What a LinkedIn LARP is.
2. Which categories it can choose from.
3. How to score posts from `0` to `100`.
4. What signals to look for, like vague emotional storytelling, bragging disguised as humility, and engagement bait.
5. To return only JSON, with no markdown and no extra commentary.

The most important part is the output contract:

1. `score` must be an integer from `0` to `100`.
2. `category` must be one of the allowed labels.
3. `reason` must explain the score.
4. `translation` must rewrite the post in blunt plain English.

That prompt matters because the backend assumes the model will follow it and return valid JSON.

## 5. Backend packaging and deployment files

### `backend/requirements.txt`

1. `fastapi==0.115.5` provides the web framework and validation layer.
2. `uvicorn[standard]==0.32.1` runs the FastAPI app.
3. `pydantic==2.10.3` provides schema validation.
4. `pydantic-settings==2.6.1` reads environment variables into the settings class.
5. `groq==0.13.0` is the Groq API client.
6. `redis==5.2.1` provides async Redis support.
7. `slowapi==0.1.9` adds rate limiting.
8. `python-dotenv==1.0.1` helps load `.env` files in development.

### `backend/Dockerfile`

1. `FROM python:3.11-slim` starts from a small Python 3.11 image.
2. `WORKDIR /app` sets `/app` as the working directory inside the container.
3. `# Install dependencies first - Docker layer caching means this only` explains why requirements are copied before the source code.
4. `# rebuilds when requirements.txt changes, not on every code change.` finishes the caching explanation.
5. `COPY requirements.txt .` copies the dependency list into the container.
6. `RUN pip install --no-cache-dir -r requirements.txt` installs the Python packages.
7. `COPY . .` copies the rest of the backend source code.
8. `EXPOSE 8000` documents that the app listens on port 8000.
9. `CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]` starts Uvicorn and serves the FastAPI app.

### `backend/docker-compose.yml`

1. `version: "3.8"` selects the Compose file format.
2. `services:` begins the service definitions.
3. `api:` defines the FastAPI app container.
4. `build: .` builds the API image from the current `backend` folder.
5. `ports:` starts the port mapping block.
6. `"8000:8000"` maps host port 8000 to container port 8000.
7. `env_file: .env` loads backend environment variables from `.env`.
8. `volumes:` starts the source-code mount.
9. `- .:/app` mounts the local backend folder into the container so code changes show up immediately.
10. `# Hot-reload: source changes reflect immediately` explains the mount.
11. `depends_on:` tells Compose that the API should start after Redis.
12. `- redis` names the dependency.
13. `command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` starts Uvicorn in reload mode for development.
14. `redis:` defines the Redis service.
15. `image: redis:7-alpine` uses the official lightweight Redis image.
16. `ports:` starts Redis port mapping.
17. `"6379:6379"` exposes Redis locally so you can inspect it during development.

### `backend/docker-compose.prod.yml`

1. `version: "3.8"` matches the base compose file.
2. `services:` starts the production overrides.
3. `api:` overrides the API service.
4. `command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4` runs more workers and disables reload.
5. `restart: always` keeps the API container alive if it crashes or the host reboots.
6. `environment:` starts environment overrides.
7. `- ENVIRONMENT=production` makes the app switch to production behavior.
8. `redis:` overrides the Redis service.
9. `ports: []` removes the Redis host port exposure in production.
10. `# Redis NOT exposed externally in production` explains why the port is removed.
11. `restart: always` keeps Redis running.

### `backend/nginx/larp.conf`

1. `server {` starts the Nginx server block.
2. `listen 80;` makes Nginx accept HTTP traffic on port 80.
3. `server_name _;` accepts any host name.
4. `# Security headers` marks the next block.
5. `add_header X-Frame-Options "DENY";` prevents the site from being embedded in iframes.
6. `add_header X-Content-Type-Options "nosniff";` stops browsers from MIME-sniffing responses.
7. `add_header X-XSS-Protection "1; mode=block";` enables legacy XSS protection headers.
8. `add_header Referrer-Policy "no-referrer";` strips referrer information.
9. `location / {` starts the proxy rule for normal requests.
10. `proxy_pass http://api:8000;` forwards requests to the Docker service named `api`.
11. `proxy_set_header Host $host;` forwards the original host header.
12. `proxy_set_header X-Real-IP $remote_addr;` forwards the real client IP.
13. `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` preserves the proxy chain.
14. `proxy_set_header X-Forwarded-Proto $scheme;` tells the backend whether the request used HTTP or HTTPS.
15. `# Prevent slow-loris and large payload attacks` explains the next limits.
16. `client_max_body_size 16k;` caps request size at 16 KB.
17. `proxy_read_timeout 30s;` avoids hanging forever while waiting for the backend.
18. `proxy_connect_timeout 5s;` limits connection setup time.
19. `}` closes the location block.
20. `# Block direct access to sensitive paths` explains the next rule.
21. `location ~ /\. {` matches dotfiles like `.env`.
22. `deny all;` blocks access to those paths.
23. `}` closes the server block.

## 6. Extension files

### `extension/manifest.json`

1. `"manifest_version": 3,` says this is a Manifest V3 extension.
2. `"name": "LinkedIn LARP Detector",` names the extension.
3. `"version": "1.0.0",` sets the extension version.
4. `"description": "Detects performative LinkedIn posts and translates what they actually mean.",` describes what it does.
5. `"permissions": ["activeTab", "storage", "scripting"],` grants the extension access to the active tab, persistent storage, and script injection APIs.
6. `"host_permissions": [` starts the list of hosts the extension may access.
7. `"https://www.linkedin.com/*",` allows the extension to run on LinkedIn pages.
8. `"http://localhost:8000/*"` allows it to talk to the local backend during development.
9. `],` closes the host permission list.
10. `"background": {` starts the background worker config.
11. `"service_worker": "background.js"` tells Chrome which file runs in the background.
12. `},` closes the background config.
13. `"content_scripts": [` starts the list of scripts injected into pages.
14. `{` opens the LinkedIn content-script entry.
15. `"matches": ["https://www.linkedin.com/*"],` injects the script only on LinkedIn.
16. `"js": ["content.js"],` loads the content script JavaScript.
17. `"css": [],` means no extra content-script CSS is injected.
18. `"run_at": "document_idle"` waits until the page is mostly loaded.
19. `},` closes the content-script entry.
20. `],` closes the content-script list.
21. `"action": {` starts the browser action popup config.
22. `"default_popup": "popup/popup.html",` makes the popup open when you click the extension icon.
23. `"default_icon": {` starts the popup icon mapping.
24. `"16": "icons/icon16.png",` sets the 16px icon.
25. `"48": "icons/icon48.png",` sets the 48px icon.
26. `"128": "icons/icon128.png"` sets the 128px icon.
27. `},` closes the icon mapping.
28. `},` closes the action block.
29. `"icons": {` sets the extension's icon set.
30. `"16": "icons/icon16.png",` sets the 16px icon again for install pages and Chrome UI.
31. `"48": "icons/icon48.png",` sets the 48px icon.
32. `"128": "icons/icon128.png"` sets the 128px icon.
33. `},` closes the icons block.
34. `"web_accessible_resources": [` starts the list of static files pages can access.
35. `{` opens the resource rule.
36. `"resources": ["icons/*"],` exposes the icon files to LinkedIn pages if needed.
37. `"matches": ["https://www.linkedin.com/*"]` limits that exposure to LinkedIn.
38. `}` closes the resource rule.
39. `]` closes the web-accessible resources list.

### `extension/background.js`

1. The comment at the top explains that this file is the service worker that receives messages and proxies API calls.
2. `const DEFAULT_API_URL = "http://localhost:8000";` sets the fallback backend URL.
3. `chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {` opens the message listener.
4. `if (message.type === "ANALYZE_POST") {` checks for analysis requests from the popup or content script.
5. `handleAnalyze(message.text).then(sendResponse).catch((err) => {` runs the analysis asynchronously and returns the response through the callback.
6. `sendResponse({ error: err.message || "Analysis failed" });` returns a readable error message if anything fails.
7. `});` closes the error callback.
8. `return true;` keeps the message channel open because the response is async.
9. `}` closes the analysis branch.
10. `if (message.type === "GET_API_URL") {` handles requests to read the saved backend URL.
11. `chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL }, (result) => {` reads from synced Chrome storage with a fallback default.
12. `sendResponse({ apiUrl: result.apiUrl });` returns the stored URL.
13. `});` closes the storage callback.
14. `return true;` keeps the channel open.
15. `}` closes that branch.
16. `if (message.type === "SET_API_URL") {` handles requests to save a new backend URL.
17. `chrome.storage.sync.set({ apiUrl: message.apiUrl }, () => {` writes the URL to synced storage.
18. `sendResponse({ success: true });` confirms the save completed.
19. `});` closes the callback.
20. `return true;` keeps the channel open.
21. `}` closes the storage branch.
22. `});` closes the message listener.
23. `async function handleAnalyze(text) {` defines the helper that actually calls the backend.
24. `const { apiUrl } = await new Promise((resolve) =>` wraps `chrome.storage.sync.get` in a Promise so it can be `await`ed.
25. `chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL }, resolve)` reads the stored API URL.
26. `);` closes the promise wrapper.
27. `const response = await fetch(`${apiUrl}/analyze`, {` sends the post text to the backend.
28. `method: "POST",` uses the POST method.
29. `headers: { "Content-Type": "application/json" },` tells the backend the body is JSON.
30. `body: JSON.stringify({ text }),` sends the post text in JSON form.
31. `});` closes the fetch options.
32. `if (!response.ok) {` checks whether the backend returned an error status.
33. `const err = await response.json().catch(() => ({}));` tries to read the backend's JSON error message.
34. `throw new Error(err.error || \`HTTP ${response.status}\`);` throws a readable error.
35. `}` closes the error branch.
36. `return response.json();` returns the successful analysis JSON.
37. `}` closes the helper function.

### `extension/utils/api.js`

1. The comment at the top says this file is meant to be a shared API helper for popup code.
2. `const DEFAULT_API_URL = "http://localhost:8000";` sets the same local default backend URL.
3. `export async function getApiUrl() {` exposes a function that reads the backend URL from storage.
4. `return new Promise((resolve) => {` wraps the Chrome callback API in a Promise.
5. `chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL }, (r) =>` reads the saved URL.
6. `resolve(r.apiUrl)` returns the value to the caller.
7. `);` closes the storage callback.
8. `});` closes the Promise.
9. `}` closes `getApiUrl`.
10. `export async function setApiUrl(url) {` exposes a function that saves a new backend URL.
11. `return new Promise((resolve) =>` wraps the save operation in a Promise.
12. `chrome.storage.sync.set({ apiUrl: url }, resolve)` writes the URL.
13. `);` closes the Promise.
14. `}` closes `setApiUrl`.
15. `export async function analyzePost(text) {` defines the direct fetch helper.
16. `const apiUrl = await getApiUrl();` loads the current backend URL.
17. `const res = await fetch(`${apiUrl}/analyze`, {` calls the analysis endpoint.
18. `method: "POST",` uses POST.
19. `headers: { "Content-Type": "application/json" },` sends JSON.
20. `body: JSON.stringify({ text }),` sends the text payload.
21. `});` closes the fetch options.
22. `if (!res.ok) {` checks for an HTTP error.
23. `const err = await res.json().catch(() => ({}));` tries to parse the backend error.
24. `throw new Error(err.error || \`HTTP ${res.status}\`);` throws a readable message.
25. `}` closes the error branch.
26. `return res.json();` returns the successful JSON response.
27. `}` closes `analyzePost`.
28. `export async function checkHealth() {` defines a helper that calls the health endpoint.
29. `const apiUrl = await getApiUrl();` reads the backend URL.
30. `const res = await fetch(`${apiUrl}/health`, { method: "GET" });` checks whether the backend is alive.
31. `if (!res.ok) throw new Error(\`Backend unreachable (HTTP ${res.status})\`);` throws if the health check fails.
32. `return res.json();` returns the health JSON.
33. `}` closes `checkHealth`.

### `extension/content.js`

1. The top comment says this file is injected into LinkedIn pages.
2. It explains the main behavior: find post containers, add a `Detect LARP` button, extract text, call the background worker, and render the result inline.
3. `const PROCESSED_ATTR = "data-larp-injected";` marks posts that have already been handled so the script does not inject duplicate buttons.
4. `const SCORE_COLORS = {` starts the color map for score tiers.
5. `genuine:  { bg: "#e6f9f0", border: "#34d399", text: "#065f46" },` defines the colors for authentic posts.
6. `mild:     { bg: "#fefce8", border: "#facc15", text: "#713f12" },` defines mild-LARP colors.
7. `moderate: { bg: "#fff7ed", border: "#fb923c", text: "#7c2d12" },` defines moderate-LARP colors.
8. `high:     { bg: "#fef2f2", border: "#f87171", text: "#7f1d1d" },` defines high-LARP colors.
9. `peak:     { bg: "#1a0505",  border: "#dc2626", text: "#fca5a5" },` defines the most extreme colors.
10. `};` closes the color map.
11. `function getScoreTier(score) {` converts a numeric score into a tier key.
12. `if (score <= 20) return "genuine";` maps low scores to genuine.
13. `if (score <= 40) return "mild";` maps the next range to mild.
14. `if (score <= 60) return "moderate";` maps the middle range to moderate.
15. `if (score <= 80) return "high";` maps the higher range to high.
16. `return "peak";` sends everything above 80 to peak.
17. `}` closes the tier function.
18. `function getScoreLabel(score) {` turns the score into the label shown in the UI.
19. `if (score <= 20) return "✅ Genuine";` returns the label for low scores.
20. `if (score <= 40) return "🟡 Mildly LARPy";` returns the label for mild scores.
21. `if (score <= 60) return "🟠 Moderate LARP";` returns the label for moderate scores.
22. `if (score <= 80) return "🔴 High LARP";` returns the label for high scores.
23. `return "💀 Peak LARP";` returns the label for the highest scores.
24. `}` closes the label function.
25. `function extractPostText(postEl) {` starts the text extraction helper.
26. The comment above it says LinkedIn uses different layouts in different places, so the script tries several selectors.
27. `const selectors = [` starts the list of likely text containers.
28. `.feed-shared-update-v2__description,` targets one common feed layout.
29. `.feed-shared-text,` targets another common layout.
30. `.update-components-text,` targets another LinkedIn text wrapper.
31. `[data-test-id='main-feed-activity-card__commentary'],` targets a specific test-id container.
32. `.attributed-text-segment-list__content,` targets attributed content segments.
33. `];` closes the selector list.
34. `for (const sel of selectors) {` loops through the candidate selectors.
35. `const el = postEl.querySelector(sel);` checks whether the post contains that selector.
36. `if (el && el.innerText.trim()) return el.innerText.trim();` returns the first non-empty text it finds.
37. `}` ends the selector loop.
38. The fallback comment says that if none of the selectors worked, the code will grab the largest text block inside the post.
39. `const blocks = Array.from(postEl.querySelectorAll("p, span"));` collects paragraphs and spans.
40. `const text = blocks` starts the fallback text assembly.
41. `.map((b) => b.innerText.trim())` turns each block into trimmed text.
42. `.filter((t) => t.length > 20)` removes tiny fragments that are probably UI labels.
43. `.join("\n");` joins the remaining blocks into one string.
44. `return text.trim();` returns the final text.
45. `}` closes the extraction helper.
46. `function renderResultCard(container, data) {` builds the inline result card.
47. `const old = container.querySelector(".larp-result-card");` checks whether there is already a card in that post.
48. `if (old) old.remove();` removes the old card if present.
49. `const tier = getScoreTier(data.score);` converts the score into a tier.
50. `const colors = SCORE_COLORS[tier];` pulls the tier color palette.
51. `const label = getScoreLabel(data.score);` gets the human-readable label.
52. `const card = document.createElement("div");` creates the outer card element.
53. `card.className = "larp-result-card";` gives it a class name for styling.
54. `card.style.cssText = \`` starts inline styling for the whole card.
55. `margin: 12px 0;` adds spacing.
56. `padding: 16px;` gives the card internal breathing room.
57. `border-radius: 12px;` rounds the corners.
58. `border: 2px solid ${colors.border};` uses the tier border color.
59. `background: ${colors.bg};` uses the tier background color.
60. `color: ${colors.text};` uses the tier text color.
61. `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;` keeps the card readable.
62. `font-size: 14px;` sets the text size.
63. `line-height: 1.5;` improves readability.
64. `animation: larpFadeIn 0.3s ease;` adds a small fade-in.
65. ``;` closes the inline CSS string.
66. `card.innerHTML = \`` starts the HTML template for the result card.
67. The embedded `<style>` block defines a small animation and the internal card classes.
68. `.larp-score-row` lays out the score, label, and close button in one row.
69. `.larp-badge` styles the pill label.
70. `.larp-score-num` makes the numeric score large and bold.
71. `.larp-category` styles the category text.
72. `.larp-section-title` styles the small uppercase section headings.
73. `.larp-reason` gives space to the explanation.
74. `.larp-translation` puts the plain-English meaning in a shaded box.
75. `.larp-cached` shows the cached indicator.
76. `.larp-close` styles the dismiss button.
77. `.larp-close:hover` makes the close button more visible on hover.
78. The HTML after the style block lays out the score row, reason section, translation section, and cached badge.
79. `${data.cached ? '<div class="larp-cached">Cached result</div>' : ""}` only shows the cached label when the response came from Redis.
80. `\`;` closes the template string.
81. `card.querySelector(".larp-close").addEventListener("click", () => card.remove());` makes the close button remove the card.
82. `container.insertBefore(card, container.querySelector(".larp-analyze-btn")?.nextSibling || null);` tries to place the result near the button.
83. `container.appendChild(card);` ensures the card gets added to the DOM even if the insert position was not found.
84. `}` closes the render helper.
85. `function injectButton(postEl) {` injects the `Detect LARP` button into one post element.
86. `if (postEl.hasAttribute(PROCESSED_ATTR)) return;` skips posts that already have a button.
87. `postEl.setAttribute(PROCESSED_ATTR, "true");` marks the post as processed.
88. `const btn = document.createElement("button");` creates the button.
89. `btn.className = "larp-analyze-btn";` assigns a class for lookup and styling.
90. `btn.textContent = "Detect LARP";` sets the button text.
91. `btn.style.cssText = \`` starts the inline button style.
92. `display: inline-flex; align-items: center; gap: 6px;` lays out the icon and text.
93. `margin: 8px 0 0 4px; padding: 6px 14px;` spaces the button.
94. `border: 1.5px solid #0a66c2; border-radius: 999px;` gives it a LinkedIn-like pill shape.
95. `background: transparent; color: #0a66c2;` starts with a clean outline look.
96. `font-size: 13px; font-weight: 600; cursor: pointer;` makes it look clickable.
97. `transition: all 0.2s ease;` smooths hover animations.
98. ``;` closes the button style.
99. `btn.onmouseenter = () => {` starts the hover-in effect.
100. `btn.style.background = "#0a66c2";` fills the button.
101. `btn.style.color = "#fff";` switches text to white.
102. `};` closes the hover-in handler.
103. `btn.onmouseleave = () => {` starts the hover-out effect.
104. `btn.style.background = "transparent";` returns the button to the outline look.
105. `btn.style.color = "#0a66c2";` restores the blue text.
106. `};` closes the hover-out handler.
107. `btn.addEventListener("click", async () => {` starts the analysis click handler.
108. `const text = extractPostText(postEl);` gets the visible post text.
109. `if (!text) {` checks whether extraction succeeded.
110. `alert("Could not extract post text. Try selecting and copying it manually.");` tells the user to paste the text manually.
111. `return;` stops the handler.
112. `}` closes the empty-text branch.
113. `btn.textContent = "Analyzing...";` shows that work is in progress.
114. `btn.disabled = true;` prevents double-clicks.
115. `try {` starts the async request block.
116. `const result = await chrome.runtime.sendMessage({` sends the post text to the background worker.
117. `type: "ANALYZE_POST",` tells the background worker what action to perform.
118. `text,` sends the extracted post text.
119. `});` closes the message.
120. `if (result.error) {` checks for a background-worker error.
121. `throw new Error(result.error);` turns the error field into a real exception.
122. `}` closes the error check.
123. `renderResultCard(postEl, result);` inserts the result card under the post.
124. `} catch (err) {` handles any fetch or analysis failure.
125. `renderResultCard(postEl, {` creates a fallback error card.
126. `score: 0,` uses a neutral score for the error state.
127. `category: "Error",` labels the result as an error.
128. `reason: \`Failed to analyze: ${err.message}\`,` shows the error message.
129. `translation: "Could not reach the analysis server. Check your connection.",` gives a plain-English failure message.
130. `cached: false,` marks it as uncached.
131. `});` closes the fallback object.
132. `} finally {` resets the button no matter what happened.
133. `btn.textContent = "Detect LARP";` restores the original label.
134. `btn.disabled = false;` re-enables the button.
135. `}` closes the click handler.
136. The comment after the handler explains that the button is appended to the social action bar if LinkedIn has one, or to the post itself otherwise.
137. `const actionBar =` starts the action-bar lookup.
138. `.feed-shared-social-action-bar` is the preferred LinkedIn action bar selector.
139. `.social-actions-bar` is a fallback selector.
140. `[data-test-id='social-actions__reaction-like-button']?.parentElement` uses a button's parent when the older selectors are missing.
141. `postEl;` falls back to the whole post element if no action bar exists.
142. `actionBar.appendChild(btn);` inserts the button.
143. `}` closes the inject helper.
144. `function scanPosts() {` scans the page for posts.
145. `const selectors = [` starts the post-container selector list.
146. `.feed-shared-update-v2,` targets a common feed post container.
147. `.occludable-update,` targets another LinkedIn post wrapper.
148. `[data-urn],` targets elements with a URN attribute.
149. `];` closes the selector list.
150. `for (const sel of selectors) {` loops through the candidate selectors.
151. `document.querySelectorAll(sel).forEach((el) => injectButton(el));` injects buttons into every matching post.
152. `}` closes the loop.
153. `}` closes the scanning helper.
154. `scanPosts();` runs the initial scan immediately.
155. `const observer = new MutationObserver(() => scanPosts());` watches LinkedIn's dynamically loaded DOM and rescans when new posts appear.
156. `observer.observe(document.body, { childList: true, subtree: true });` tells the observer to watch all DOM changes under the body.

### `extension/popup/popup.html`

1. `<!DOCTYPE html>` tells the browser this is HTML5.
2. `<html lang="en">` opens the document and declares English.
3. `<head>` starts the metadata section.
4. `<meta charset="UTF-8" />` enables UTF-8 text.
5. `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` makes the popup scale correctly on different screen sizes.
6. `<title>LinkedIn LARP Detector</title>` sets the popup title.
7. `<link rel="stylesheet" href="popup.css" />` loads the popup stylesheet.
8. `</head>` closes the head.
9. `<body>` starts the visible UI.
10. `<div class="app">` wraps the whole popup.
11. `<!-- Header -->` is a visual comment, not code.
12. `<header class="header">` starts the top bar.
13. `<div class="logo">` wraps the logo area.
14. `<span class="logo-icon">` contains the icon emoji.
15. `<div>` inside the logo contains the title and subtitle.
16. `<div class="logo-title">LARP Detector</div>` shows the main title.
17. `<div class="logo-sub">LinkedIn Edition</div>` shows the subtitle.
18. `</div>` closes the title block.
19. `</div>` closes the logo wrapper.
20. `<button id="settingsBtn" ...>⚙️</button>` opens the settings panel when clicked.
21. `</header>` closes the top bar.
22. `<!-- Status pill -->` is a comment explaining the next block.
23. `<div id="statusBar" class="status-bar">` shows backend status.
24. `<span id="statusDot" class="status-dot status-checking"></span>` is the colored status light.
25. `<span id="statusText">Checking backend…</span>` is the status message.
26. `</div>` closes the status bar.
27. `<!-- Main panel -->` introduces the main input area.
28. `<main id="mainPanel">` starts the main view.
29. `<p class="hint">...` tells the user they can paste text or use the LinkedIn button.
30. `<div class="textarea-wrapper">` groups the text area and its character counter.
31. `<textarea id="postInput" ...></textarea>` is where the user pastes the post.
32. `maxlength="3000"` matches the backend limit.
33. `rows="6"` gives the textarea a default height.
34. `<div class="char-count"><span id="charCount">0</span> / 3000</div>` displays the live character count.
35. `</div>` closes the textarea wrapper.
36. `<button id="analyzeBtn" class="btn btn-primary" disabled>` is the manual analyze button.
37. `<span id="analyzeBtnText">Analyze Post</span>` holds the button label.
38. `<span id="analyzeBtnSpinner" class="spinner hidden"></span>` is the loading spinner.
39. `</button>` closes the button.
40. `<!-- Result card -->` introduces the analysis result area.
41. `<div id="resultCard" class="result-card hidden">` is hidden until analysis succeeds.
42. `<div class="result-header">` holds the score and verdict.
43. `<div class="score-block">` wraps the large score.
44. `<span id="scoreNum" class="score-num">—</span>` shows the numeric score.
45. `<span class="score-label">/ 100</span>` clarifies the scale.
46. `</div>` closes the score block.
47. `<div class="score-meta">` holds the text verdict and category.
48. `<div id="scoreVerdict" class="score-verdict">—</div>` shows the tier label.
49. `<div id="scoreCategory" class="score-category">—</div>` shows the category name.
50. `</div>` closes the meta block.
51. `</div>` closes the result header.
52. `<div class="score-bar-track">` is the background for the score bar.
53. `<div id="scoreBar" class="score-bar"></div>` is the animated fill bar.
54. `</div>` closes the track.
55. `<div class="result-section">` starts the "Why it scored this way" section.
56. `<div class="section-title">Why it scored this way</div>` labels the section.
57. `<p id="reasonText" class="section-body">—</p>` is where the explanation appears.
58. `</div>` closes that section.
59. `<div class="result-section">` starts the translation section.
60. `<div class="section-title">What they actually mean</div>` labels it.
61. `<p id="translationText" class="section-body translation">—</p>` shows the plain-English rewrite.
62. `</div>` closes that section.
63. `<div id="cachedBadge" class="cached-badge hidden">Cached result</div>` shows when Redis supplied the answer.
64. `</div>` closes the result card.
65. `<!-- Error message -->` introduces the error area.
66. `<div id="errorMsg" class="error-msg hidden"></div>` shows failures when the backend is down or returns an error.
67. `</main>` closes the main panel.
68. `<!-- Settings panel -->` introduces the hidden settings view.
69. `<div id="settingsPanel" class="settings-panel hidden">` starts the panel that edits the backend URL.
70. `<h2 class="settings-title">Settings</h2>` labels the panel.
71. `<label class="settings-label" for="apiUrlInput">Backend URL</label>` labels the input field.
72. `<input id="apiUrlInput" ... />` lets the user change the backend address.
73. `type="url"` tells the browser it should be a URL.
74. `placeholder="http://localhost:8000"` shows the default development URL.
75. `<button id="saveSettingsBtn" ...>Save</button>` saves the new backend URL.
76. `<button id="backBtn" ...>← Back</button>` returns to the main view.
77. `</div>` closes the settings panel.
78. `</div>` closes the app wrapper.
79. `<script src="popup.js"></script>` loads the popup logic.
80. `</body>` closes the body.
81. `</html>` closes the document.

### `extension/popup/popup.js`

1. The top comment says this file handles health checks, manual analysis, result rendering, and settings.
2. `const DEFAULT_API_URL = "http://localhost:8000";` sets the fallback backend address.
3. `const TIER_COLORS = {` starts the color map used in the popup.
4. `genuine:  "#34d399",` is the green color for genuine posts.
5. `mild:     "#facc15",` is the yellow color for mild LARP.
6. `moderate: "#fb923c",` is the orange color for moderate LARP.
7. `high:     "#f87171",` is the red color for high LARP.
8. `peak:     "#dc2626",` is the deep red color for peak LARP.
9. `};` closes the color map.
10. `const TIER_VERDICTS = {` starts the map from tier keys to label text.
11. `genuine:  "✅ Genuine",` defines the genuine label.
12. `mild:     "🟡 Mildly LARPy",` defines the mild label.
13. `moderate: "🟠 Moderate LARP",` defines the moderate label.
14. `high:     "🔴 High LARP",` defines the high label.
15. `peak:     "💀 Peak LARP",` defines the peak label.
16. `};` closes the verdict map.
17. `function getScoreTier(score) {` converts a score into a tier key.
18. `if (score <= 20) return "genuine";` maps low scores to genuine.
19. `if (score <= 40) return "mild";` maps the next range to mild.
20. `if (score <= 60) return "moderate";` maps the next range to moderate.
21. `if (score <= 80) return "high";` maps the next range to high.
22. `return "peak";` maps everything else to peak.
23. `}` closes the helper.
24. The DOM reference block stores every important element from the popup so the script can update them later.
25. `const statusDot = ...` holds the status indicator dot.
26. `const statusText = ...` holds the status message.
27. `const postInput = ...` holds the textarea.
28. `const charCount = ...` holds the character counter.
29. `const analyzeBtn = ...` holds the analyze button.
30. `const analyzeBtnTxt = ...` holds the analyze button label span.
31. `const analyzeBtnSpn = ...` holds the spinner span.
32. `const resultCard = ...` holds the result card container.
33. `const scoreNum = ...` holds the numeric score display.
34. `const scoreVerdict = ...` holds the verdict label.
35. `const scoreCat = ...` holds the category label.
36. `const scoreBar = ...` holds the progress bar element.
37. `const reasonText = ...` holds the explanation text.
38. `const translText = ...` holds the translation text.
39. `const cachedBadge = ...` holds the cached badge.
40. `const errorMsg = ...` holds the error box.
41. `const mainPanel = ...` holds the main panel.
42. `const settingsPanel = ...` holds the settings panel.
43. `const settingsBtn = ...` holds the gear button.
44. `const backBtn = ...` holds the back button.
45. `const saveSetBtn = ...` holds the save button.
46. `const apiUrlInput = ...` holds the URL input.
47. The API helper block below duplicates the same idea as `utils/api.js`, but keeps the popup self-contained because this popup is loaded as a plain script, not as a module bundle.
48. `async function getApiUrl() {` reads the backend URL from Chrome storage.
49. `return new Promise((resolve) =>` wraps the callback API in a Promise.
50. `chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL }, (r) =>` reads the stored URL.
51. `resolve(r.apiUrl)` returns the URL.
52. `);` closes the callback.
53. `}` closes the helper.
54. `async function setApiUrl(url) {` stores a new backend URL.
55. `return new Promise((resolve) =>` wraps the save operation.
56. `chrome.storage.sync.set({ apiUrl: url }, resolve)` writes the URL.
57. `);` closes the Promise.
58. `}` closes the helper.
59. `async function checkHealth(apiUrl) {` checks whether the backend is alive.
60. `const res = await fetch(`${apiUrl}/health`, { method: "GET" });` calls the health endpoint.
61. `if (!res.ok) throw new Error(\`HTTP ${res.status}\`);` throws if the backend replied with an error.
62. `return res.json();` returns the health JSON.
63. `}` closes the helper.
64. `async function pingBackend() {` runs the status check shown when the popup opens.
65. `const apiUrl = await getApiUrl();` reads the saved URL.
66. `try {` starts the success/failure branch.
67. `await checkHealth(apiUrl);` makes the request.
68. `statusDot.className = "status-dot status-ok";` switches the dot to green.
69. `statusText.textContent = "Backend connected";` shows success text.
70. `} catch {` handles errors.
71. `statusDot.className = "status-dot status-error";` switches the dot to red.
72. `statusText.textContent = "Backend unreachable - check your server";` warns the user.
73. `}` closes the error handler.
74. `}` closes `pingBackend`.
75. `postInput.addEventListener("input", () => {` updates the UI every time the user types.
76. `const len = postInput.value.length;` measures the current text length.
77. `charCount.textContent = len;` updates the counter.
78. `analyzeBtn.disabled = len === 0;` disables the button when the textarea is empty.
79. `charCount.style.color = len > 2700 ? "#f87171" : "";` turns the counter red when the user gets close to the limit.
80. `});` closes the input handler.
81. `function renderResult(data) {` writes the analysis result into the popup.
82. `const tier = getScoreTier(data.score);` gets the tier.
83. `const color = TIER_COLORS[tier];` gets the matching color.
84. `const verdict = TIER_VERDICTS[tier];` gets the tier label.
85. `scoreNum.textContent = data.score;` shows the numeric score.
86. `scoreNum.style.color = color;` colors the number.
87. `scoreVerdict.textContent = verdict;` shows the verdict label.
88. `scoreVerdict.style.color = color;` colors the verdict label.
89. `scoreCat.textContent = data.category;` shows the category.
90. `reasonText.textContent = data.reason;` shows the explanation. This is safe because it uses `textContent` instead of `innerHTML`.
91. `translText.textContent = data.translation;` shows the plain-English rewrite.
92. `scoreBar.style.width = `${data.score}%`;` fills the bar to match the score.
93. `scoreBar.style.background = \`linear-gradient(90deg, ${color}99, ${color})\`;` gives the bar a gradient.
94. `cachedBadge.classList.toggle("hidden", !data.cached);` shows the cached badge only when the backend says the answer came from Redis.
95. `resultCard.classList.remove("hidden");` makes the result card visible.
96. `}` closes the render helper.
97. `analyzeBtn.addEventListener("click", async () => {` starts the manual analysis handler.
98. `const text = postInput.value.trim();` gets the typed text.
99. `if (!text) return;` does nothing if the user clicked with an empty box.
100. `analyzeBtnTxt.textContent = "Analyzing...";` shows the loading text.
101. `analyzeBtnSpn.classList.remove("hidden");` shows the spinner.
102. `analyzeBtn.disabled = true;` prevents double-clicks.
103. `errorMsg.classList.add("hidden");` hides any old error.
104. `resultCard.classList.add("hidden");` hides the old result while the new request is running.
105. `try {` starts the async request block.
106. `const result = await chrome.runtime.sendMessage({` sends the text to the background worker.
107. `type: "ANALYZE_POST",` names the action.
108. `text,` includes the post text.
109. `});` closes the message.
110. `if (result.error) throw new Error(result.error);` turns background errors into exceptions.
111. `renderResult(result);` paints the new result card.
112. `} catch (err) {` handles request failures.
113. `errorMsg.textContent = \`Failed to analyze: ${err.message || "Analysis failed. Is the backend running?"}\`;` shows a friendly error.
114. `errorMsg.classList.remove("hidden");` shows the error box.
115. `} finally {` resets the button state.
116. `analyzeBtnTxt.textContent = "Analyze Post";` restores the label.
117. `analyzeBtnSpn.classList.add("hidden");` hides the spinner.
118. `analyzeBtn.disabled = postInput.value.trim().length === 0;` leaves the button disabled only if the box is empty.
119. `}` closes the click handler.
120. `settingsBtn.addEventListener("click", async () => {` opens the settings panel.
121. `const url = await getApiUrl();` reads the current backend URL.
122. `apiUrlInput.value = url;` pre-fills the input.
123. `mainPanel.classList.add("hidden");` hides the main panel.
124. `settingsPanel.classList.remove("hidden");` shows settings.
125. `});` closes the settings-open handler.
126. `backBtn.addEventListener("click", () => {` handles the back button.
127. `settingsPanel.classList.add("hidden");` hides settings.
128. `mainPanel.classList.remove("hidden");` shows the main UI again.
129. `});` closes the back handler.
130. `saveSetBtn.addEventListener("click", async () => {` handles saving the backend URL.
131. `const url = apiUrlInput.value.trim();` reads the typed URL.
132. `if (!url) return;` ignores empty values.
133. `await setApiUrl(url);` saves the new URL.
134. `settingsPanel.classList.add("hidden");` hides settings.
135. `mainPanel.classList.remove("hidden");` returns to the main UI.
136. `pingBackend();` checks whether the new backend URL works.
137. `});` closes the save handler.
138. `pingBackend();` runs immediately when the popup opens.

### `extension/popup/popup.css`

This file is mostly styling, so the best way to understand it is to read it as "theme tokens first, then layout, then components, then utilities."

1. `:root {` starts the CSS variable block.
2. `--bg: #0f0f13;` defines the popup background color.
3. `--surface: #1a1a24;` defines the main surface color.
4. `--surface-2: #22223a;` defines a slightly lighter surface for nested areas.
5. `--border: #2e2e45;` defines the border color.
6. `--accent: #6c63ff;` defines the accent color used for buttons and focus states.
7. `--accent-glow: rgba(108, 99, 255, 0.25);` defines the soft focus glow.
8. `--text: #e8e8f0;` defines the main text color.
9. `--text-muted: #8888a8;` defines secondary text.
10. `--radius: 12px;` defines the large rounding radius.
11. `--radius-sm: 8px;` defines the smaller rounding radius.
12. `--genuine: #34d399;` defines the genuine score color.
13. `--mild: #facc15;` defines the mild score color.
14. `--moderate: #fb923c;` defines the moderate score color.
15. `--high: #f87171;` defines the high score color.
16. `--peak: #dc2626;` defines the peak score color.
17. `}` closes the theme block.
18. `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }` resets the layout model so sizing behaves predictably.
19. `body {` starts the base popup styling.
20. `width: 360px;` sets the popup width.
21. `min-height: 200px;` gives it a minimum height.
22. `background: var(--bg);` uses the theme background.
23. `color: var(--text);` uses the theme text color.
24. `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;` sets the base font stack.
25. `font-size: 14px;` sets the default size.
26. `line-height: 1.5;` improves readability.
27. `-webkit-font-smoothing: antialiased;` makes text look a bit cleaner on WebKit browsers.
28. `}` closes the body style.
29. `.app { padding: 0 0 12px; }` adds bottom spacing around the whole popup.
30. `.header {` styles the top bar.
31. `display: flex; align-items: center; justify-content: space-between;` spreads the logo and settings button apart.
32. `padding: 16px 16px 12px;` adds spacing.
33. `border-bottom: 1px solid var(--border);` draws a divider.
34. `background: linear-gradient(135deg, #13131f 0%, #1a1a2e 100%);` adds a subtle gradient.
35. `}` closes the header.
36. `.logo { display: flex; align-items: center; gap: 10px; }` lays out the logo icon and text.
37. `.logo-icon { font-size: 26px; filter: drop-shadow(0 0 8px rgba(108,99,255,0.6)); }` makes the emoji icon stand out.
38. `.logo-title { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; color: var(--text); }` styles the title.
39. `.logo-sub { font-size: 11px; color: var(--text-muted); }` styles the subtitle.
40. `.icon-btn {` styles the settings button.
41. `background: none; border: 1px solid var(--border); border-radius: var(--radius-sm);` gives it a small outlined shape.
42. `color: var(--text-muted); cursor: pointer; font-size: 16px; padding: 6px 8px;` sets the button behavior and size.
43. `transition: all 0.2s;` smooths hover changes.
44. `}` closes the icon button style.
45. `.icon-btn:hover { background: var(--surface-2); color: var(--text); border-color: var(--accent); }` highlights the settings button on hover.
46. `.status-bar {` styles the status strip.
47. `display: flex; align-items: center; gap: 8px;` lays out the dot and message.
48. `padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border);` gives it a separated band look.
49. `font-size: 12px; color: var(--text-muted);` makes the status text secondary.
50. `}` closes the status bar.
51. `.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }` defines the round dot.
52. `.status-checking { background: var(--text-muted); animation: pulse 1.2s infinite; }` makes the dot pulse while loading.
53. `.status-ok { background: var(--genuine); }` makes the dot green on success.
54. `.status-error { background: var(--peak); }` makes the dot red on failure.
55. `@keyframes pulse {` starts the animation.
56. `0%, 100% { opacity: 1; }` keeps the dot visible at the start and end.
57. `50% { opacity: 0.3; }` fades it in the middle.
58. `}` closes the animation.
59. `main {` styles the main content area.
60. `padding: 14px 16px;` adds inner spacing.
61. `display: flex; flex-direction: column; gap: 12px;` stacks the children with spacing.
62. `}` closes the main style.
63. `.hint { font-size: 12px; color: var(--text-muted); text-align: center; line-height: 1.6; }` styles the helper text.
64. `.textarea-wrapper { position: relative; }` makes the character counter position relative to the textarea.
65. `textarea {` styles the input box.
66. `width: 100%; resize: vertical; background: var(--surface); border: 1.5px solid var(--border); border-radius: var(--radius-sm);` gives it the base look.
67. `color: var(--text); font-family: inherit; font-size: 13px; line-height: 1.5;` sets the readable text style.
68. `padding: 10px 12px 28px; transition: border-color 0.2s; outline: none;` adds room for the counter and removes the default outline.
69. `}` closes the textarea style.
70. `textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }` gives the textarea a visible focus ring.
71. `textarea::placeholder { color: var(--text-muted); }` styles the placeholder text.
72. `.char-count { position: absolute; bottom: 8px; right: 10px; font-size: 11px; color: var(--text-muted); }` places the counter inside the input wrapper.
73. `.btn {` styles all buttons.
74. `width: 100%; padding: 10px 16px; border-radius: var(--radius-sm); border: none;` gives the button shape.
75. `cursor: pointer; font-size: 14px; font-weight: 600; letter-spacing: 0.02em;` makes it feel clickable.
76. `transition: all 0.2s ease; display: flex; align-items: center; justify-content: center; gap: 8px;` makes the layout and animation consistent.
77. `}` closes the button base style.
78. `.btn-primary { background: linear-gradient(135deg, var(--accent) 0%, #9b59b6 100%); color: #fff; box-shadow: 0 4px 14px rgba(108,99,255,0.35); }` gives the main action button a bold look.
79. `.btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(108,99,255,0.5); }` makes it lift on hover.
80. `.btn-primary:active:not(:disabled) { transform: translateY(0); }` snaps it back down when pressed.
81. `.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }` makes disabled buttons obviously inactive.
82. `.btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }` styles the secondary button.
83. `.btn-ghost:hover { background: var(--surface-2); color: var(--text); }` highlights the secondary button on hover.
84. `.spinner {` styles the loading spinner.
85. `width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%;` draws the spinner circle.
86. `animation: spin 0.7s linear infinite;` spins it.
87. `}` closes the spinner style.
88. `@keyframes spin { to { transform: rotate(360deg); } }` defines the rotation animation.
89. `.result-card {` styles the analysis result container.
90. `background: var(--surface); border: 1.5px solid var(--border); border-radius: var(--radius); padding: 14px;` gives it a card look.
91. `animation: slideIn 0.3s ease;` makes it appear smoothly.
92. `}` closes the result card style.
93. `@keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }` defines the entrance animation.
94. `.result-header { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }` lays out the score and labels.
95. `.score-block { display: flex; align-items: baseline; gap: 3px; flex-shrink: 0; }` keeps the score compact.
96. `.score-num { font-size: 40px; font-weight: 800; line-height: 1; }` makes the score big.
97. `/* color set dynamically by JS */` notes that JavaScript colors the score number.
98. `.score-label { font-size: 14px; color: var(--text-muted); font-weight: 600; }` styles the `/ 100` text.
99. `.score-verdict { font-size: 13px; font-weight: 700; margin-bottom: 2px; }` styles the verdict label.
100. `.score-category { font-size: 11px; color: var(--text-muted); font-style: italic; }` styles the category label.
101. `.score-bar-track { height: 5px; background: var(--border); border-radius: 999px; overflow: hidden; margin-bottom: 14px; }` sets the background track for the score bar.
102. `.score-bar { height: 100%; border-radius: 999px; transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1); }` makes the bar animate smoothly.
103. `.result-section { margin-bottom: 10px; }` spaces the sections.
104. `.result-section:last-of-type { margin-bottom: 0; }` removes the bottom margin on the last section.
105. `.section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin-bottom: 4px; }` styles the small heading text.
106. `.section-body { font-size: 13px; line-height: 1.55; color: var(--text); }` styles the body copy.
107. `.section-body.translation { background: var(--surface-2); border-radius: var(--radius-sm); padding: 10px 12px; font-style: italic; color: var(--text-muted); border-left: 3px solid var(--accent); }` gives the translation block a quoted look.
108. `.cached-badge { font-size: 11px; color: var(--text-muted); text-align: right; margin-top: 8px; }` styles the cached indicator.
109. `.error-msg {` styles the error box.
110. `background: rgba(220, 38, 38, 0.1); border: 1px solid rgba(220, 38, 38, 0.4); border-radius: var(--radius-sm);` gives it a warning look.
111. `color: #fca5a5; font-size: 13px; padding: 10px 12px; text-align: center;` makes the message readable.
112. `}` closes the error style.
113. `.settings-panel { padding: 16px; display: flex; flex-direction: column; gap: 8px; }` lays out the settings form.
114. `.settings-title { font-size: 15px; font-weight: 700; margin-bottom: 4px; }` styles the settings heading.
115. `.settings-label { font-size: 12px; color: var(--text-muted); font-weight: 600; }` styles the input label.
116. `.settings-input {` styles the URL input.
117. `background: var(--surface); border: 1.5px solid var(--border); border-radius: var(--radius-sm);` gives it the same visual language as the textarea.
118. `color: var(--text); font-family: monospace; font-size: 13px; outline: none; padding: 9px 12px; transition: border-color 0.2s; width: 100%;` makes it readable and full-width.
119. `}` closes the input style.
120. `.settings-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }` gives the input focus feedback.
121. `.hidden { display: none !important; }` is the utility class used to hide and show panels.

## 7. How the APIs work

The backend has two endpoints:

1. `POST /analyze`
2. `GET /health`

### `POST /analyze`

The `POST /analyze` flow is:

1. The client sends JSON like `{ "text": "..." }`.
2. FastAPI parses it into `AnalyzeRequest`.
3. `sanitize_post_text()` trims the string and rejects empty or oversized input.
4. `get_cached()` hashes the normalized text and checks Redis.
5. If Redis has a hit, the backend returns the saved JSON with `cached: true`.
6. If Redis misses, `analyze_post()` calls Groq.
7. The Groq response is parsed and validated.
8. The result is stored in Redis with `setex()`.
9. The backend returns the response with `cached: false`.

### `GET /health`

This endpoint just returns:

1. `{"status": "ok"}`

It exists so the popup can quickly check whether the backend is alive.

## 8. How Redis cache works

Redis is doing two different jobs here:

1. Caching analysis results.
2. Storing rate-limit counters for SlowAPI.

### Cache behavior

1. The key is built from the normalized text, not the raw input.
2. The normalization is `strip().lower()`, so `Hello`, ` hello `, and `HELLO` all map to the same cache key.
3. The text is hashed with SHA-256 so the Redis key stays short and consistent.
4. The stored value is a JSON string with score, category, reason, and translation.
5. The TTL is 86,400 seconds, which is 24 hours.
6. After 24 hours, Redis deletes the cached value automatically.

### Why this matters

1. Identical posts do not hit the Groq API again.
2. That saves money.
3. It also makes repeated analyses feel instant.

## 9. How the extension works

### Content script

1. `content.js` is injected into LinkedIn pages.
2. It scans the page for post containers.
3. It adds one `Detect LARP` button per post.
4. It extracts the post text with several LinkedIn-specific selectors.
5. It listens for dynamic DOM changes with a `MutationObserver`, because LinkedIn loads posts as a single-page app.
6. When the user clicks the button, it sends the text to the background worker.
7. When the response comes back, it renders a card directly under the post.

### Background worker

1. `background.js` listens for messages.
2. It reads the stored backend URL from `chrome.storage.sync`.
3. It sends the request to the backend with `fetch`.
4. It returns JSON to the content script or popup.
5. It centralizes network access so both the popup and the content script can reuse the same API path.

### Popup

1. The popup lets you paste text manually.
2. It checks backend health when it opens.
3. It lets you change the backend URL from the settings screen.
4. It renders the score, category, explanation, translation, and cached badge.

## 10. EC2 deployment

If you want to run this on an AWS EC2 instance, here is the practical path.

### What you need to change first

1. The backend URL in the extension cannot stay `http://localhost:8000`.
2. `extension/manifest.json` must allow your EC2 domain or public IP in `host_permissions`.
3. `backend/app/core/security.py` must allow the extension's real origin in CORS.
4. If you publish the extension, the extension origin will be a real `chrome-extension://<id>` value, not the wildcard placeholder currently in the code.

### Simple deployment plan

1. Launch an Ubuntu EC2 instance.
2. Open SSH `22` in the security group from your IP.
3. Open `80` and `443` in the security group if you want web access and HTTPS.
4. SSH into the instance.
5. Install Docker and the Docker Compose plugin.
6. Clone this repository onto the EC2 box.
7. Go into `backend/`.
8. Create a `.env` file with at least:

   ```env
   GROQ_API_KEY=your_key_here
   GROQ_MODEL=llama-3.3-70b-versatile
   REDIS_URL=redis://redis:6379
   CACHE_TTL_SECONDS=86400
   MAX_POST_LENGTH=3000
   RATE_LIMIT_PER_MINUTE=10
   RATE_LIMIT_PER_DAY=100
   ENVIRONMENT=production
   ```

9. Run the production Compose stack:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
   ```

10. Check the containers with `docker compose ps`.
11. Check logs with `docker compose logs -f api`.
12. Confirm the health endpoint works at `http://<ec2-public-ip>:8000/health` if you expose port 8000 directly.

### Better production setup

1. Use Nginx in front of the API.
2. Point a domain name at the EC2 instance.
3. Terminate HTTPS at Nginx.
4. Proxy traffic to the API container on port 8000.
5. Use the included `backend/nginx/larp.conf` as the starting point.

Important note: the repo includes the Nginx config file, but it is not wired into `docker-compose.yml` yet. That means you either run Nginx on the host or add it as another service in Compose.

### Extension changes for EC2

1. Open the extension popup.
2. Go to Settings.
3. Replace `http://localhost:8000` with your public API URL.
4. Save the new value.
5. Reload LinkedIn.
6. If you changed the extension host permissions, reload the extension from `chrome://extensions/`.

### Security notes for EC2

1. Keep Redis private.
2. Do not expose port 6379 to the internet.
3. Use HTTPS if the API is public.
4. Update the CORS allowlist to the real extension origin before shipping.
5. Make sure your `.env` file is not committed to git.

## 11. A few things I want you to know

1. `backend/app/services/groq_service.py` imports `os` but does not use it.
2. `extension/utils/api.js` and `extension/popup/popup.js` duplicate a lot of the same API helper logic.
3. `backend/app/core/security.py` uses `chrome-extension://*` as a production CORS placeholder, but that is not a great final production rule.
4. `content.js` uses `innerHTML` when rendering the result card, which means the backend output should be treated carefully before public release.

If you want, the next step I can do is turn this into an even more beginner-friendly version with diagrams, or I can patch the code to fix the deployment rough edges I pointed out.
