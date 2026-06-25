import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.core.errors import ServiceError
from app.core.security import CORS_ORIGIN_REGEX, CORS_ORIGINS
from app.middleware.rate_limit import limiter
from app.routes.analyze import router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="LinkedIn LARP Detector",
    description="Detect performative LinkedIn posts using AI.",
    version="1.0.0",
)

app.state.limiter = limiter

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


def _error_response(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": message})


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return _error_response(429, "Rate limit exceeded. Try again shortly.")


@app.exception_handler(ServiceError)
async def service_error_handler(request: Request, exc: ServiceError):
    logger.warning("Service error on %s: %s", request.url.path, exc.message)
    return _error_response(exc.status_code, exc.message)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        message = detail.get("error", str(detail))
    else:
        message = str(detail)
    return _error_response(exc.status_code, message)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    return _error_response(422, "Invalid request. Check your input and try again.")


@app.exception_handler(Exception)
async def generic_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s: %s", request.url.path, exc)
    return _error_response(500, "Analysis failed. Please try again.")


app.include_router(router)


@app.get("/health")
async def health():
    return {"status": "ok"}
