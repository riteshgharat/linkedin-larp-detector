import json
import os
from pathlib import Path

from groq import AsyncGroq
from app.config import settings

# Load the system prompt once at module level
_PROMPT_PATH = Path(__file__).parent.parent.parent / "prompts" / "system_prompt.txt"
_SYSTEM_PROMPT: str = _PROMPT_PATH.read_text(encoding="utf-8")

_client = AsyncGroq(api_key=settings.groq_api_key)


async def analyze_post(text: str) -> dict:
    """
    Call Groq with the post text and return a structured analysis dict.
    Raises on API or parse errors — caller handles retries / error responses.
    """
    completion = await _client.chat.completions.create(
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
        temperature=0.2,       # Low temp → consistent, deterministic scoring
        max_tokens=512,
        response_format={"type": "json_object"},
    )

    raw = completion.choices[0].message.content
    data = json.loads(raw)

    # Validate required fields are present
    required = {"score", "category", "reason", "translation"}
    missing = required - data.keys()
    if missing:
        raise ValueError(f"Groq response missing fields: {missing}")

    # Clamp score to valid range
    data["score"] = max(0, min(100, int(data["score"])))

    return {
        "score": data["score"],
        "category": str(data["category"]),
        "reason": str(data["reason"]),
        "translation": str(data["translation"]),
    }
