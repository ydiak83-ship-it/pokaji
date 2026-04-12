from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth.router import router as auth_router
from app.config import settings
from app.database import engine
from app.models import Base
from app.payments.router import router as payments_router
from app.videos import router as videos_router_module
from app.videos.router import router as videos_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=3600.0, write=None, pool=10.0)
        ) as client:
            videos_router_module.http_client = client
            videos_router_module.redis_client = redis_client
            yield
    finally:
        await redis_client.aclose()


app = FastAPI(title="Pokaji API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.app_url, "http://localhost:3000", "chrome-extension://*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(videos_router)
app.include_router(payments_router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
