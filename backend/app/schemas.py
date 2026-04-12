import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr


class UserCreate(BaseModel):
    email: EmailStr
    password: str


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    plan: str
    plan_expires_at: datetime | None = None
    videos_this_period: int
    created_at: datetime

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class RegisterResponse(BaseModel):
    verified: bool
    message: str = ""
    access_token: str | None = None  # set only when verified=True (lifetime / no SMTP)


class VideoResponse(BaseModel):
    id: uuid.UUID
    title: str
    slug: str
    duration: float
    views: int
    status: str
    is_public: bool
    thumbnail_url: str | None = None
    video_url: str | None = None
    created_at: datetime
    replies_count: int = 0
    author_email: str | None = None  # populated for replies

    model_config = {"from_attributes": True}


class VideoUpdate(BaseModel):
    title: str | None = None
    is_public: bool | None = None
