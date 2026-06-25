import functools
import logging

from redis.exceptions import RedisError
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.config import settings

logger = logging.getLogger(__name__)

limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=settings.redis_url,
    default_limits=[
        f"{settings.rate_limit_per_day}/day",
        f"{settings.rate_limit_per_minute}/minute",
    ],
)


def resilient_limit(limit_string: str):
    """Apply rate limits, but allow requests through if Redis is unavailable."""

    def decorator(func):
        rate_limited = limiter.limit(limit_string)(func)

        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            try:
                return await rate_limited(*args, **kwargs)
            except RedisError as exc:
                logger.warning(
                    "Rate limit storage unavailable; allowing request: %s", exc
                )
                return await func(*args, **kwargs)

        return wrapper

    return decorator
