from pydantic_settings import BaseSettings
from typing import List


class Settings(BaseSettings):
    llm_provider: str = "groq"  # "groq" or "ollama"
    groq_api_key: str = ""      # Optional now, required only if using Groq
    groq_model: str = "llama-3.3-70b-versatile"
    
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3"

    use_cache: bool = False
    redis_url: str = "redis://localhost:6379"
    cache_ttl_seconds: int = 86400        # 24 h — same post = same result
    max_post_length: int = 3000
    rate_limit_per_minute: int = 10
    rate_limit_per_day: int = 100  # WR-05: aligned with .env.example and active .env
    allowed_origins: List[str] = ["http://localhost"]
    environment: str = "development"

    class Config:
        env_file = ".env"


settings = Settings()
