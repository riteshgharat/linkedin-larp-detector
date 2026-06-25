import hashlib
import json
import redis.asyncio as redis
from app.config import settings

_client: redis.Redis | None = None


def get_client() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.from_url(settings.redis_url, decode_responses=True)
    return _client


def make_cache_key(text: str) -> str:
    """Same post text always maps to the same cache key."""
    return f"larp:{hashlib.sha256(text.strip().lower().encode()).hexdigest()}"


async def get_cached(text: str) -> dict | None:
    result = await get_client().get(make_cache_key(text))
    return json.loads(result) if result else None


async def set_cached(text: str, data: dict) -> None:
    await get_client().setex(
        make_cache_key(text),
        settings.cache_ttl_seconds,
        json.dumps(data),
    )
