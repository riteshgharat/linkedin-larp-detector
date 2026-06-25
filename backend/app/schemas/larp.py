from pydantic import BaseModel, field_validator
from app.core.security import sanitize_post_text


class AnalyzeRequest(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def validate_text(cls, v: str) -> str:
        return sanitize_post_text(v)


class AnalyzeResponse(BaseModel):
    score: int          # 0-100 LARP score
    category: str       # e.g. "Humble Brag", "Fake Vulnerability", etc.
    reason: str         # Short explanation of the verdict
    translation: str    # Plain-English rewrite of what the post actually means
    cached: bool = False
