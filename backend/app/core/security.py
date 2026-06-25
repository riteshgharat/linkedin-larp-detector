from app.config import settings

CORS_ORIGINS: list[str] = (
    ["*"]                        # Dev: allow all origins (including extension)
    if settings.environment == "development"
    else [
        "chrome-extension://*",  # Prod: extension requests only
    ]
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
