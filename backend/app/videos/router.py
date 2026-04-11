import json
import tempfile
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from jose import JWTError, jwt
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.utils import get_current_user
from app.config import settings
from app.database import get_db
from app.models import User, Video
from app.schemas import VideoResponse, VideoUpdate
from app.videos.service import (
    delete_from_s3,
    generate_slug,
    get_presigned_url,
    process_uploaded_video,
)

router = APIRouter(prefix="/api/videos", tags=["videos"])

_STREAM_TOKEN_TTL = 3600  # seconds


async def _get_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, decode_responses=True)

FREE_VIDEO_LIMIT = 25
FREE_MAX_DURATION_SEC = 300  # 5 minutes


def _video_to_response(
    video: Video,
    replies_count: int = 0,
    author_email: str | None = None,
) -> VideoResponse:
    thumbnail_url = get_presigned_url(video.thumbnail_key) if video.thumbnail_key else None
    video_url = get_presigned_url(video.file_key) if video.status == "ready" else None
    return VideoResponse(
        id=video.id,
        title=video.title,
        slug=video.slug,
        duration=video.duration,
        views=video.views,
        status=video.status,
        is_public=video.is_public,
        thumbnail_url=thumbnail_url,
        video_url=video_url,
        created_at=video.created_at,
        replies_count=replies_count,
        author_email=author_email,
    )


@router.post("/upload", response_model=VideoResponse, status_code=status.HTTP_201_CREATED)
async def upload_video(
    file: UploadFile,
    reply_to_slug: str | None = Form(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VideoResponse:
    # Reset monthly counter if 30 days passed
    now = datetime.now(timezone.utc)
    period_started = user.period_started_at
    if period_started.tzinfo is None:
        period_started = period_started.replace(tzinfo=timezone.utc)
    if now - period_started > timedelta(days=30):
        user.videos_this_period = 0
        user.period_started_at = now

    lifetime = settings.is_lifetime(user.email)

    # Check free tier limits — counts all created videos, deletions don't reset it
    if not lifetime and user.plan == "free" and user.videos_this_period >= FREE_VIDEO_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Бесплатный тариф: лимит {FREE_VIDEO_LIMIT} видео в месяц исчерпан. Обновите до Pro.",
        )

    video_id = uuid.uuid4()
    slug = generate_slug()

    # Save uploaded file to temp
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        content = await file.read()
        max_bytes = settings.upload_max_size_mb * 1024 * 1024
        if len(content) > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Файл слишком большой. Максимум {settings.upload_max_size_mb} МБ.",
            )
        tmp.write(content)
        tmp_path = Path(tmp.name)

    try:
        # Process: transcode + thumbnail + S3 upload
        file_key, thumb_key, duration = process_uploaded_video(
            tmp_path, str(user.id), str(video_id)
        )
    finally:
        tmp_path.unlink(missing_ok=True)

    # Check duration limit for free users
    if not lifetime and user.plan == "free" and duration > FREE_MAX_DURATION_SEC:
        delete_from_s3(file_key)
        delete_from_s3(thumb_key)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Free plan limited to {FREE_MAX_DURATION_SEC // 60} minute videos.",
        )

    # Resolve reply_to_id from slug (must be a public video)
    reply_to_id = None
    if reply_to_slug:
        reply_result = await db.execute(
            select(Video).where(Video.slug == reply_to_slug, Video.is_public.is_(True))
        )
        original = reply_result.scalar_one_or_none()
        if original:
            reply_to_id = original.id

    video = Video(
        id=video_id,
        user_id=user.id,
        slug=slug,
        file_key=file_key,
        thumbnail_key=thumb_key,
        duration=duration,
        status="ready",
        reply_to_id=reply_to_id,
    )
    db.add(video)
    user.videos_this_period += 1
    await db.commit()
    await db.refresh(video)

    return _video_to_response(video)


@router.get("", response_model=list[VideoResponse])
async def list_videos(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[VideoResponse]:
    videos_result = await db.execute(
        select(Video).where(Video.user_id == user.id).order_by(Video.created_at.desc())
    )
    videos = videos_result.scalars().all()

    if not videos:
        return []

    video_ids = [v.id for v in videos]
    counts_result = await db.execute(
        select(Video.reply_to_id, func.count().label("cnt"))
        .where(Video.reply_to_id.in_(video_ids), Video.is_public.is_(True))
        .group_by(Video.reply_to_id)
    )
    reply_counts: dict[uuid.UUID, int] = {row.reply_to_id: row.cnt for row in counts_result}

    return [_video_to_response(v, replies_count=reply_counts.get(v.id, 0)) for v in videos]


@router.get("/{slug}", response_model=VideoResponse)
async def get_video(slug: str, db: AsyncSession = Depends(get_db)) -> VideoResponse:
    result = await db.execute(select(Video).where(Video.slug == slug))
    video = result.scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    if not video.is_public:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    # Increment views
    video.views += 1
    await db.commit()

    return _video_to_response(video)


@router.post("/{slug}/stream-token")
async def create_stream_token(
    slug: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """Issue a short-lived stream token for a video the caller owns."""
    result = await db.execute(select(Video).where(Video.slug == slug, Video.user_id == user.id))
    video = result.scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    token = str(uuid.uuid4())
    r = await _get_redis()
    try:
        await r.setex(
            f"stream_token:{token}",
            _STREAM_TOKEN_TTL,
            json.dumps({"slug": slug, "user_id": str(user.id)}),
        )
    finally:
        await r.aclose()

    return {"token": token}


@router.get("/{slug}/stream")
async def stream_video(
    slug: str,
    request: Request,
    st: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """Proxy video through backend — S3 domain may be blocked on mobile carriers."""
    result = await db.execute(
        select(Video).where(Video.slug == slug, Video.status == "ready")
    )
    video = result.scalar_one_or_none()
    _denied = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")
    if video is None:
        raise _denied

    if not video.is_public:
        if st:
            # Preferred path: short-lived Redis stream token
            r = await _get_redis()
            try:
                raw = await r.get(f"stream_token:{st}")
            finally:
                await r.aclose()
            if not raw:
                raise _denied
            token_data = json.loads(raw)
            if token_data["slug"] != slug or uuid.UUID(token_data["user_id"]) != video.user_id:
                raise _denied
        else:
            # Fallback: Authorization header JWT (e.g. desktop dashboard)
            auth_header = request.headers.get("Authorization", "")
            raw_jwt = auth_header.removeprefix("Bearer ").strip() if auth_header.startswith("Bearer ") else None
            if not raw_jwt:
                raise _denied
            try:
                payload = jwt.decode(raw_jwt, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
                user_id = uuid.UUID(payload["sub"])
            except (JWTError, ValueError, KeyError):
                raise _denied
            if user_id != video.user_id:
                raise _denied

    presigned_url = get_presigned_url(video.file_key, expires_in=3600)

    range_header = request.headers.get("range", "")
    forward_headers = {"Range": range_header} if range_header else {}

    async def stream_content(resp: httpx.Response) -> AsyncGenerator[bytes, None]:
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await resp.aclose()

    client = httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=3600.0, write=None, pool=10.0))
    req = client.build_request("GET", presigned_url, headers=forward_headers)
    resp = await client.send(req, stream=True)

    resp_headers: dict[str, str] = {"Accept-Ranges": "bytes"}
    for h in ("Content-Length", "Content-Range", "Content-Type"):
        if h in resp.headers:
            resp_headers[h] = resp.headers[h]

    return StreamingResponse(
        stream_content(resp),
        status_code=resp.status_code,
        media_type=resp.headers.get("Content-Type", "video/mp4"),
        headers=resp_headers,
        background=None,
    )


@router.get("/{slug}/replies", response_model=list[VideoResponse])
async def get_replies(slug: str, db: AsyncSession = Depends(get_db)) -> list[VideoResponse]:
    original_result = await db.execute(
        select(Video).where(Video.slug == slug, Video.is_public.is_(True))
    )
    original = original_result.scalar_one_or_none()
    if original is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    replies_result = await db.execute(
        select(Video, User.email)
        .join(User, Video.user_id == User.id)
        .where(Video.reply_to_id == original.id, Video.is_public.is_(True))
        .order_by(Video.created_at.desc())
    )
    return [
        _video_to_response(video, author_email=email)
        for video, email in replies_result.all()
    ]


@router.patch("/{video_id}", response_model=VideoResponse)
async def update_video(
    video_id: uuid.UUID,
    data: VideoUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VideoResponse:
    result = await db.execute(select(Video).where(Video.id == video_id, Video.user_id == user.id))
    video = result.scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    if data.title is not None:
        video.title = data.title
    if data.is_public is not None:
        video.is_public = data.is_public

    await db.commit()
    await db.refresh(video)
    return _video_to_response(video)


@router.delete("/{video_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_video(
    video_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(select(Video).where(Video.id == video_id, Video.user_id == user.id))
    video = result.scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    delete_from_s3(video.file_key)
    if video.thumbnail_key:
        delete_from_s3(video.thumbnail_key)

    await db.delete(video)
    await db.commit()
