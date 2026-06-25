from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    groq_api_key: str
    groq_model: str = "llama-3.3-70b-versatile"
    redis_url: str = "redis://localhost:6379"
    cache_ttl_seconds: int = 86400        # 24 h — same post = same result
    max_post_length: int = 3000
    rate_limit_per_minute: int = 10
    rate_limit_per_day: int = 20
    allowed_origins: List[str] = ["http://localhost"]
    environment: str = "development"

    class Config:
        env_file = ".env"


settings = Settings()
