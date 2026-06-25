from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from app.core.security import CORS_ORIGIN_REGEX, CORS_ORIGINS
from app.middleware.rate_limit import limiter
from app.routes.analyze import router

app = FastAPI(
    title="LinkedIn LARP Detector",
    description="Detect performative LinkedIn posts using AI.",
    version="1.0.0",
)

# Attach SlowAPI limiter to app state
app.state.limiter = limiter

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"error": "Rate limit exceeded. Try again shortly."},
    )


@app.exception_handler(Exception)
async def generic_handler(request: Request, exc: Exception):
    # Never leak stack traces to the client
    return JSONResponse(
        status_code=500,
        content={"error": "Analysis failed. Please try again."},
    )


app.include_router(router)


@app.get("/health")
async def health():
    return {"status": "ok"}
