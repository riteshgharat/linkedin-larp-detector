from fastapi import APIRouter, Request
from app.schemas.larp import AnalyzeRequest, AnalyzeResponse
from app.services.groq_service import analyze_post
from app.core.cache import get_cached, set_cached
from app.middleware.rate_limit import limiter

router = APIRouter()


@router.post("/analyze", response_model=AnalyzeResponse)
@limiter.limit("10/minute")
async def analyze(request: Request, body: AnalyzeRequest):
    # 1. Cache hit → return immediately, no Groq call, no cost
    cached = await get_cached(body.text)
    if cached:
        return {**cached, "cached": True}

    # 2. Cache miss → call Groq
    result = await analyze_post(body.text)

    # 3. Persist result for future identical posts
    await set_cached(body.text, result)

    return {**result, "cached": False}
