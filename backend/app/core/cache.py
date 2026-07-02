import asyncio
import hashlib
import json
import logging

import redis.asyncio as redis
from redis.exceptions import RedisError

from app.config import settings

logger = logging.getLogger(__name__)

_client: redis.Redis | None = None
_client_lock = asyncio.Lock()  # WR-04: guards lazy init against concurrent coroutines

_REQUIRED_FIELDS = frozenset({"score", "category", "reason", "translation"})


async def get_client() -> redis.Redis:
    """Return the shared Redis client, initializing it once (concurrency-safe)."""
    global _client
    if _client is None:
        async with _client_lock:
            # Double-checked locking: re-test inside the lock
            if _client is None:
                _client = redis.from_url(
                    settings.redis_url,
                    decode_responses=True,
                    socket_connect_timeout=2,
                    socket_timeout=2,
                    retry_on_timeout=True,
                    health_check_interval=30,
                )
    return _client


def make_cache_key(text: str) -> str:
    """Same post text always maps to the same cache key."""
    return f"larp:{hashlib.sha256(text.strip().lower().encode()).hexdigest()}"


def _parse_cached_result(raw: str) -> dict | None:
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.warning("Cache contained invalid JSON: %s", exc)
        return None

    if not isinstance(data, dict) or not _REQUIRED_FIELDS <= data.keys():
        logger.warning("Cache entry missing required analysis fields")
        return None

    return data


async def get_cached(text: str) -> dict | None:
    if not settings.use_cache:
        return None

    try:
        result = await (await get_client()).get(make_cache_key(text))
    except RedisError as exc:
        logger.warning("Cache read failed: %s", exc)
        return None
    except Exception as exc:
        logger.exception("Unexpected cache read error: %s", exc)
        return None

    if not result:
        return None

    return _parse_cached_result(result)


async def set_cached(text: str, data: dict) -> None:
    if not settings.use_cache:
        return

    try:
        payload = json.dumps(data)
        await (await get_client()).setex(
            make_cache_key(text),
            settings.cache_ttl_seconds,
            payload,
        )
    except (RedisError, TypeError) as exc:
        logger.warning("Cache write failed: %s", exc)
    except Exception as exc:
        logger.exception("Unexpected cache write error: %s", exc)
