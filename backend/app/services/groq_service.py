import asyncio
import json
import logging
from pathlib import Path

from groq import (
    APIConnectionError,
    APIError,
    APITimeoutError,
    AsyncGroq,
    RateLimitError,
)

from app.config import settings
from app.core.errors import ServiceError
from app.services.ollama_service import analyze_post_ollama

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

_groq_client = None

def get_groq_client():
    global _groq_client
    if _groq_client is None:
        if not settings.groq_api_key:
            raise ServiceError("Groq API key is missing. Please set GROQ_API_KEY in your environment/dot-env.", 500)
        _groq_client = AsyncGroq(api_key=settings.groq_api_key, timeout=ANALYSIS_TIMEOUT_SECONDS)
    return _groq_client


async def _analyze_post_groq(text: str) -> dict:
    """Call Groq API and return a structured analysis dict."""
    client = get_groq_client()
    try:
        completion = await asyncio.wait_for(
            client.chat.completions.create(
                model=settings.groq_model,
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": (
                            "Analyze the following LinkedIn post and return ONLY the JSON object:\n\n"
                            f"{text}"
                        ),
                    },
                ],
                temperature=0.2,
                max_tokens=512,
                response_format={"type": "json_object"},
            ),
            timeout=ANALYSIS_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.warning("Groq analysis timed out")
        raise ServiceError("Analysis timed out. Please try again.", 504)
    except RateLimitError as exc:
        logger.warning("Groq rate limit hit: %s", exc)
        raise ServiceError("Service is busy. Please try again shortly.", 503)
    except (APIConnectionError, APITimeoutError) as exc:
        logger.warning("Groq connection error: %s", exc)
        raise ServiceError("Analysis service unavailable. Please try again.", 503)
    except APIError as exc:
        logger.error("Groq API error (status=%s): %s", exc.status_code, exc)
        if exc.status_code and exc.status_code >= 500:
            raise ServiceError("Analysis service unavailable. Please try again.", 503)
        raise ServiceError("Analysis failed. Please try again.", 502)

    try:
        raw = completion.choices[0].message.content
        data = json.loads(raw)
    except (IndexError, AttributeError, TypeError) as exc:
        logger.error("Groq returned an empty or malformed response: %s", exc)
        raise ServiceError("Analysis failed. Please try again.", 502)
    except json.JSONDecodeError as exc:
        logger.error("Groq returned non-JSON content: %s", exc)
        raise ServiceError("Analysis failed. Please try again.", 502)

    return _validate_and_format_response(data)


def _validate_and_format_response(data: dict) -> dict:
    """Ensure the response dict contains required fields with expected types."""
    missing = _REQUIRED_FIELDS - data.keys()
    if missing:
        logger.error("LLM response missing fields: %s", missing)
        raise ServiceError("Analysis failed. Model response missing required fields.", 502)

    try:
        score = max(0, min(100, int(data["score"])))
    except (TypeError, ValueError) as exc:
        logger.error("LLM returned an invalid score: %s", exc)
        raise ServiceError("Analysis failed. Model returned an invalid score.", 502)

    return {
        "score": score,
        "category": str(data["category"]),
        "reason": str(data["reason"]),
        "translation": str(data["translation"]),
    }


async def analyze_post(text: str) -> dict:
    """Entrypoint to analyze post text. Routes based on settings.llm_provider."""
    if settings.llm_provider.lower() == "ollama":
        return await analyze_post_ollama(text)
    else:
        return await _analyze_post_groq(text)
