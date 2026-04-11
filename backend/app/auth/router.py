import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.utils import create_access_token, get_current_user, hash_password, verify_password
from app.config import settings
from app.database import get_db
from app.email import send_verification_email
from app.models import User
from app.schemas import RegisterResponse, TokenResponse, UserCreate, UserLogin, UserResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(
    data: UserCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> RegisterResponse:
    result = await db.execute(select(User).where(User.email == data.email))
    if result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    # Lifetime users skip email verification
    skip_verification = settings.is_lifetime(data.email) or not settings.smtp_configured

    verification_token = None if skip_verification else secrets.token_urlsafe(32)
    token_expires_at = (
        None if skip_verification
        else datetime.now(timezone.utc) + timedelta(hours=24)
    )

    user = User(
        email=data.email,
        password_hash=hash_password(data.password),
        email_verified=skip_verification,
        email_verification_token=verification_token,
        email_verification_token_expires_at=token_expires_at,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    if not skip_verification:
        background_tasks.add_task(send_verification_email, data.email, verification_token)
        return RegisterResponse(
            verified=False,
            message="Письмо с подтверждением отправлено на вашу почту. Проверьте входящие (и папку Спам).",
        )

    # Auto-verified (lifetime user or SMTP not configured)
    token = create_access_token(user.id)
    return RegisterResponse(verified=True, access_token=token)


@router.post("/login", response_model=TokenResponse)
async def login(data: UserLogin, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    result = await db.execute(select(User).where(User.email == data.email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if not user.email_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Подтвердите email перед входом. Проверьте вашу почту.",
        )

    token = create_access_token(user.id)
    return TokenResponse(access_token=token)


@router.get("/verify-email")
async def verify_email(token: str, db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    result = await db.execute(select(User).where(User.email_verification_token == token))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверная или устаревшая ссылка")

    if user.email_verification_token_expires_at is not None:
        expires_at = user.email_verification_token_expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Ссылка истекла. Зарегистрируйтесь заново.",
            )

    user.email_verified = True
    user.email_verification_token = None
    user.email_verification_token_expires_at = None
    await db.commit()

    return {"status": "ok", "message": "Email подтверждён! Теперь вы можете войти."}


@router.get("/me", response_model=UserResponse)
async def me(user: User = Depends(get_current_user)) -> User:
    return user
