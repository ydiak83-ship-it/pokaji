import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.utils import get_current_user
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

FREE_VIDEO_LIMIT = 25
FREE_MAX_DURATION_SEC = 300  # 5 minutes


def _video_to_response(video: Video) -> VideoResponse:
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
    )


@router.post("/upload", response_model=VideoResponse, status_code=status.HTTP_201_CREATED)
async def upload_video(
    file: UploadFile,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VideoResponse:
    # Check free tier limits
    if user.plan == "free":
        result = await db.execute(select(Video).where(Video.user_id == user.id))
        count = len(result.scalars().all())
        if count >= FREE_VIDEO_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Free plan limited to {FREE_VIDEO_LIMIT} videos. Upgrade to Pro.",
            )

    video_id = uuid.uuid4()
    slug = generate_slug()

    # Save uploaded file to temp
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        content = await file.read()
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
    if user.plan == "free" and duration > FREE_MAX_DURATION_SEC:
        delete_from_s3(file_key)
        delete_from_s3(thumb_key)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Free plan limited to {FREE_MAX_DURATION_SEC // 60} minute videos.",
        )

    video = Video(
        id=video_id,
        user_id=user.id,
        slug=slug,
        file_key=file_key,
        thumbnail_key=thumb_key,
        duration=duration,
        status="ready",
    )
    db.add(video)
    await db.commit()
    await db.refresh(video)

    return _video_to_response(video)


@router.get("", response_model=list[VideoResponse])
async def list_videos(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[VideoResponse]:
    result = await db.execute(
        select(Video).where(Video.user_id == user.id).order_by(Video.created_at.desc())
    )
    return [_video_to_response(v) for v in result.scalars().all()]


@router.get("/{slug}", response_model=VideoResponse)
async def get_video(slug: str, db: AsyncSession = Depends(get_db)) -> VideoResponse:
    result = await db.execute(select(Video).where(Video.slug == slug))
    video = result.scalar_one_or_none()
    if video is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Video not found")

    # Increment views
    video.views += 1
    await db.commit()

    return _video_to_response(video)


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
