import secrets
import string
import subprocess
import tempfile
from pathlib import Path

import boto3
from botocore.config import Config as BotoConfig

from app.config import settings


def generate_slug(length: int = 8) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def get_s3_client():  # noqa: ANN201
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=BotoConfig(signature_version="s3v4"),
    )


def upload_to_s3(file_path: Path, s3_key: str, content_type: str = "video/mp4") -> None:
    client = get_s3_client()
    client.upload_file(
        str(file_path),
        settings.s3_bucket,
        s3_key,
        ExtraArgs={"ContentType": content_type},
    )


def get_presigned_url(s3_key: str, expires_in: int = 3600) -> str:
    client = get_s3_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": s3_key},
        ExpiresIn=expires_in,
    )


def delete_from_s3(s3_key: str) -> None:
    client = get_s3_client()
    client.delete_object(Bucket=settings.s3_bucket, Key=s3_key)


def transcode_video(input_path: Path, output_path: Path) -> float:
    """Transcode WebM to MP4 H.264 720p. Returns duration in seconds."""
    cmd = [
        "ffmpeg", "-y",
        "-i", str(input_path),
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "28",
        "-vf", "scale=-2:720",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)  # noqa: S603

    duration_cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(output_path),
    ]
    result = subprocess.run(duration_cmd, check=True, capture_output=True, text=True)  # noqa: S603
    return float(result.stdout.strip())


def generate_thumbnail(video_path: Path, output_path: Path) -> None:
    """Extract a frame at 1 second as thumbnail."""
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-ss", "1",
        "-vframes", "1",
        "-vf", "scale=640:-2",
        "-q:v", "5",
        str(output_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)  # noqa: S603


def process_uploaded_video(input_path: Path, user_id: str, video_id: str) -> tuple[str, str, float]:
    """Full pipeline: transcode + thumbnail + upload to S3. Returns (file_key, thumb_key, duration)."""
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp = Path(tmp_dir)
        mp4_path = tmp / "video.mp4"
        thumb_path = tmp / "thumb.jpg"

        duration = transcode_video(input_path, mp4_path)
        generate_thumbnail(mp4_path, thumb_path)

        file_key = f"videos/{user_id}/{video_id}/video.mp4"
        thumb_key = f"videos/{user_id}/{video_id}/thumb.jpg"

        upload_to_s3(mp4_path, file_key, content_type="video/mp4")
        upload_to_s3(thumb_path, thumb_key, content_type="image/jpeg")

    return file_key, thumb_key, duration
