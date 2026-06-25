from fastapi import APIRouter, Request

from app.core.cache import get_cached, set_cached
from app.middleware.rate_limit import resilient_limit
from app.schemas.larp import AnalyzeRequest, AnalyzeResponse
from app.services.groq_service import analyze_post

router = APIRouter()


@router.post("/analyze", response_model=AnalyzeResponse)
@resilient_limit("10/minute")
async def analyze(request: Request, body: AnalyzeRequest):
    cached = await get_cached(body.text)
    if cached:
        return {**cached, "cached": True}

    result = await analyze_post(body.text)

    await set_cached(body.text, result)

    return {**result, "cached": False}
