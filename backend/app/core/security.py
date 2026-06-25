from app.config import settings

CORS_ORIGINS: list[str] = (
    ["*"] if settings.environment == "development" else []
)

# Prod: match any installed Chrome extension origin (chrome-extension://<id>)
CORS_ORIGIN_REGEX: str | None = (
    None if settings.environment == "development" else r"^chrome-extension://.*$"
)


def sanitize_post_text(text: str) -> str:
    """Strip whitespace and enforce length limits."""
    text = text.strip()
    if not text:
        raise ValueError("Post text cannot be empty")
    if len(text) > settings.max_post_length:
        raise ValueError(
            f"Post exceeds {settings.max_post_length} character limit"
        )
    return text
