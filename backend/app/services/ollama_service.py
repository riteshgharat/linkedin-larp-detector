import json
import logging
from pathlib import Path
import httpx

from app.config import settings
from app.core.errors import ServiceError

logger = logging.getLogger(__name__)

_PROMPT_PATH = Path(__file__).parent.parent.parent / "prompts" / "system_prompt.txt"


def _load_system_prompt() -> str:
    """Load the system prompt from disk, raising a clear error if missing (WR-02)."""
    if not _PROMPT_PATH.exists():
        raise RuntimeError(
            f"System prompt not found at {_PROMPT_PATH}. "
            "Ensure prompts/system_prompt.txt is present in the backend directory."
        )
    return _PROMPT_PATH.read_text(encoding="utf-8")


_SYSTEM_PROMPT: str = _load_system_prompt()
_REQUIRED_FIELDS = frozenset({"score", "category", "reason", "translation"})
ANALYSIS_TIMEOUT_SECONDS = 30.0


async def analyze_post_ollama(text: str) -> dict:
    """Call local Ollama service and return a structured analysis dict."""
    url = f"{settings.ollama_base_url.rstrip('/')}/api/chat"
    payload = {
        "model": settings.ollama_model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"Analyze the following LinkedIn post and return ONLY the JSON object:\n\n{text}",
            },
        ],
        "stream": False,
        "format": "json",
        "options": {
            "temperature": 0.2
        }
    }

    try:
        async with httpx.AsyncClient(timeout=ANALYSIS_TIMEOUT_SECONDS) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            response_data = response.json()
    except httpx.TimeoutException:
        logger.warning("Ollama analysis timed out")
        raise ServiceError("Ollama analysis timed out. Please try again.", 504)
    except httpx.HTTPStatusError as exc:
        logger.error("Ollama API returned status %s: %s", exc.response.status_code, exc)
        raise ServiceError("Analysis service unavailable. Please try again.", 503)  # WR-03: no status code leak
    except Exception as exc:
        logger.error("Ollama connection error: %s", exc)
        raise ServiceError("Could not connect to local Ollama service. Is Ollama running?", 503)

    try:
        raw = response_data["message"]["content"]
        data = json.loads(raw)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        logger.error("Ollama returned empty or malformed JSON content: %s", exc)
        raise ServiceError("Ollama returned invalid response format. Please try again.", 502)

    missing = _REQUIRED_FIELDS - data.keys()
    if missing:
        logger.error("Ollama response missing fields: %s", missing)
        raise ServiceError("Analysis failed. Model response missing required fields.", 502)

    try:
        score = max(0, min(100, int(data["score"])))
    except (TypeError, ValueError) as exc:
        logger.error("Ollama returned an invalid score: %s", exc)
        raise ServiceError("Analysis failed. Model returned an invalid score.", 502)

    return {
        "score": score,
        "category": str(data["category"]),
        "reason": str(data["reason"]),
        "translation": str(data["translation"]),
    }
