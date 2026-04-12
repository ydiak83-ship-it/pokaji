import json
import logging
import re
import tempfile
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import RedirectResponse, StreamingResponse
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.utils import enforce_plan_expiry, get_current_user
from app.config import settings
from app.database import get_db
from app.models import User, Video
from app.schemas import VideoResponse, VideoUpdate
from app.videos.service import (
    delete_from_s3,
    download_from_s3,
    generate_presigned_put_url,
    generate_slug,
    get_presigned_url,
    process_uploaded_video,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/videos", tags=["videos"])

_STREAM_TOKEN_TTL = 3600  # seconds

# Populated by app lifespan (app/main.py) — shared across requests
http_client: httpx.AsyncClient | None = None
redis_client: aioredis.Redis | None = None

FREE_VIDEO_LIMIT = 25
FREE_MAX_DURATION_SEC = 600  # 10 minutes


def _mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    if not domain:
        return email
    masked = local[0] + "***" + local[-1] if len(local) > 2 else local
    return f"{masked}@{domain}"


def _video_to_response(
    video: Video,
    replies_count: int = 0,
    author_email: str | None = None,
) -> VideoResponse:
    # Return a stable proxy URL instead of the raw presigned S3 URL — the
    # presigned URL contains X-Amz-Signature, and embedding it in public HTML
    # (og:image, <video poster>) would leak the signed token via Referer
    # headers or page-source inspection
    thumbnail_url = (
        f"{settings.api_url}/api/videos/{video.slug}/thumbnail"
        if video.thumbnail_key
        else None
    )
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
        author_email=_mask_email(author_email) if author_email else None,
    )


@router.post("/upload", response_model=VideoResponse, status_code=status.HTTP_201_CREATED)
async def upload_video(
    file: UploadFile,
    reply_to_slug: str | None = Form(None),
    title: str | None = Form(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VideoResponse:
    # Enforce plan expiry before checking limits
    await enforce_plan_expiry(user, db)

    # Reset monthly counter if 30 days passed — commit immediately so it survives
    # even if the heavy transcoding below fails
    now = datetime.now(timezone.utc)
    period_started = user.period_started_at
    if period_started.tzinfo is None:
        period_started = period_started.replace(tzinfo=timezone.utc)
    if now - period_started > timedelta(days=30):
        user.videos_this_period = 0
        user.period_started_at = now
        await db.commit()

    lifetime = settings.is_lifetime(user.email)

    # Check free tier limits — counts all created videos, deletions don't reset it
    if not lifetime and user.plan == "free" and user.videos_this_period >= FREE_VIDEO_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Бесплатный тариф: лимит {FREE_VIDEO_LIMIT} видео в месяц исчерпан. Обновите до Pro.",
        )

    video_id = uuid.uuid4()
    slug = generate_slug()

    # Stream uploaded file to disk — avoids loading up to 500 MB into RAM
    max_bytes = settings.upload_max_size_mb * 1024 * 1024
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        received = 0
        while True:
            chunk = await file.read(1024 * 1024)  # 1 MB
            if not chunk:
                break
            received += len(chunk)
            if received > max_bytes:
                Path(tmp.name).unlink(missing_ok=True)
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"Файл слишком большой. Максимум {settings.upload_max_size_mb} МБ.",
                )
            tmp.write(chunk)
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
        title=title or "Untitled",
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


class InitUploadResponse(BaseModel):
    video_id: str
    upload_url: str
    upload_key: str


class FinalizeUploadRequest(BaseModel):
    video_id: uuid.UUID
    upload_key: str
    reply_to_slug: str | None = None
    title: str | None = None


@router.post("/init-upload", response_model=InitUploadResponse)
async def init_upload(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InitUploadResponse:
    """Issue a presigned PUT URL so the client can upload directly to S3,
    bypassing Cloudflare Tunnel's 100 MB request limit."""
    await enforce_plan_expiry(user, db)

    now = datetime.now(timezone.utc)
    period_started = user.period_started_at
    if period_started.tzinfo is None:
        period_started = period_started.replace(tzinfo=timezone.utc)
    if now - period_started > timedelta(days=30):
        user.videos_this_period = 0
        user.period_started_at = now
        await db.commit()

    lifetime = settings.is_lifetime(user.email)
    if not lifetime and user.plan == "free" and user.videos_this_period >= FREE_VIDEO_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Бесплатный тариф: лимит {FREE_VIDEO_LIMIT} видео в месяц исчерпан. Обновите до Pro.",
        )

    video_id = uuid.uuid4()
    upload_key = f"uploads/{user.id}/{video_id}.webm"
    upload_url = generate_presigned_put_url(upload_key, content_type="video/webm")

    return InitUploadResponse(
        video_id=str(video_id),
        upload_url=upload_url,
        upload_key=upload_key,
    )


_UPLOAD_KEY_RE = re.compile(r"^uploads/[0-9a-f-]{36}/[0-9a-f-]{36}\.webm$")


@router.post("/finalize-upload", response_model=VideoResponse, status_code=status.HTTP_201_CREATED)
async def finalize_upload(
    data: FinalizeUploadRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VideoResponse:
    """After direct S3 upload, download the webm, transcode, and create the DB record."""
    # Strict regex: no path traversal, no other users' prefixes
    if not _UPLOAD_KEY_RE.match(data.upload_key):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid upload key")
    expected_prefix = f"uploads/{user.id}/"
    if not data.upload_key.startswith(expected_prefix):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid upload key")
    # The video_id in the JSON body must match the key (prevents key/id mismatch)
    if data.upload_key != f"uploads/{user.id}/{data.video_id}.webm":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid upload key")

    await enforce_plan_expiry(user, db)
    lifetime = settings.is_lifetime(user.email)

    if not lifetime and user.plan == "free" and user.videos_this_period >= FREE_VIDEO_LIMIT:
        try:
            delete_from_s3(data.upload_key)
        except Exception:
            logger.warning("Failed to delete abandoned upload %s", data.upload_key, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Бесплатный тариф: лимит {FREE_VIDEO_LIMIT} видео в месяц исчерпан.",
        )

    with tempfile.TemporaryDirectory() as tmp_dir:
        webm_path = Path(tmp_dir) / "upload.webm"
        try:
            download_from_s3(data.upload_key, webm_path)
        except Exception as err:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Файл не найден в хранилище. Попробуйте загрузить заново.",
            ) from err

        try:
            file_key, thumb_key, duration = process_uploaded_video(
                webm_path, str(user.id), str(data.video_id)
            )
        except Exception as err:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Ошибка обработки видео",
            ) from err

    # Clean up the temporary webm
    try:
        delete_from_s3(data.upload_key)
    except Exception:
        logger.warning("Failed to delete temporary upload %s", data.upload_key, exc_info=True)

    # Duration limit for free users — clean up and reject
    if not lifetime and user.plan == "free" and duration > FREE_MAX_DURATION_SEC:
        delete_from_s3(file_key)
        delete_from_s3(thumb_key)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Free plan limited to {FREE_MAX_DURATION_SEC // 60} minute videos.",
        )

    reply_to_id = None
    if data.reply_to_slug:
        reply_result = await db.execute(
            select(Video).where(Video.slug == data.reply_to_slug, Video.is_public.is_(True))
        )
        original = reply_result.scalar_one_or_none()
        if original:
            reply_to_id = original.id

    slug = generate_slug()
    video = Video(
        id=data.video_id,
        user_id=user.id,
        slug=slug,
        title=data.title or "Untitled",
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

    if redis_client is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Redis unavailable")

    token = str(uuid.uuid4())
    await redis_client.setex(
        f"stream_token:{token}",
        _STREAM_TOKEN_TTL,
        json.dumps({"slug": slug, "user_id": str(user.id)}),
    )
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
            if redis_client is None:
                raise _denied
            raw = await redis_client.get(f"stream_token:{st}")
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

    if http_client is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service starting")
    req = http_client.build_request("GET", presigned_url, headers=forward_headers)
    resp = await http_client.send(req, stream=True)

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


@router.get("/{slug}/thumbnail")
async def get_thumbnail(slug: str, db: AsyncSession = Depends(get_db)) -> RedirectResponse:
    """Redirect to the presigned S3 thumbnail URL.

    The redirect keeps the signed URL out of public HTML (og:image, poster
    attributes) so it can't leak via Referer headers or page inspection.
    """
    result = await db.execute(select(Video).where(Video.slug == slug))
    video = result.scalar_one_or_none()
    if video is None or not video.thumbnail_key:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Thumbnail not found")
    presigned_url = get_presigned_url(video.thumbnail_key, expires_in=300)
    return RedirectResponse(url=presigned_url, status_code=status.HTTP_302_FOUND)


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
