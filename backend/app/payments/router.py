import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.utils import get_current_user
from app.config import settings
from app.database import get_db
from app.models import User
from app.payments.service import check_payment, create_payment

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/payments", tags=["payments"])


class CreatePaymentRequest(BaseModel):
    plan: str  # "pro" or "team"


class CreatePaymentResponse(BaseModel):
    payment_id: str
    confirmation_url: str


@router.post("/create", response_model=CreatePaymentResponse)
async def create_payment_endpoint(
    data: CreatePaymentRequest,
    user: User = Depends(get_current_user),
) -> CreatePaymentResponse:
    if settings.is_free_mvp:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if data.plan not in ("pro", "team"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Plan must be 'pro' or 'team'")

    try:
        result = create_payment(data.plan, user.id)
    except Exception as e:
        logger.exception("Payment creation failed for user %s", user.id)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Не удалось создать платёж. Попробуйте позже.") from e

    return CreatePaymentResponse(**result)


@router.post("/webhook")
async def payment_webhook(request: Request, db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """Handle YooKassa webhook notifications.

    We do NOT trust the request body on its own — YooKassa doesn't sign webhooks
    with HMAC. Instead we treat the body as a hint containing the payment_id
    and verify the real payment status via the authorized YooKassa API. An
    attacker can POST a fake body but cannot forge a succeeded payment because
    check_payment() reads from YooKassa directly with our shop secret.
    """
    if settings.is_free_mvp:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    body = await request.json()

    event_type = body.get("event")
    if event_type != "payment.succeeded":
        return {"status": "ignored"}

    payment_object = body.get("object", {})
    payment_id = payment_object.get("id")

    if not payment_id or not isinstance(payment_id, str):
        return {"status": "no payment id"}

    try:
        payment_info = check_payment(payment_id)
    except Exception:
        logger.exception("Failed to fetch payment %s from YooKassa", payment_id)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Upstream error")

    # Authoritative status comes from YooKassa, not the webhook body
    if payment_info["status"] != "succeeded":
        return {"status": "not succeeded"}

    user_id = payment_info["user_id"]
    plan = payment_info["plan"]

    if not user_id or not plan:
        return {"status": "missing metadata"}

    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()

    if user is None:
        return {"status": "user not found"}

    # Idempotency — never process the same payment_id twice
    if user.last_processed_payment_id == payment_id:
        return {"status": "already processed"}

    # Extend from current expiry if it is in the future, otherwise start fresh
    now = datetime.now(timezone.utc)
    current_expires = user.plan_expires_at
    if current_expires is not None and current_expires.tzinfo is None:
        current_expires = current_expires.replace(tzinfo=timezone.utc)
    base = current_expires if current_expires and current_expires > now else now

    user.plan = plan
    user.plan_expires_at = base + timedelta(days=30)
    user.last_processed_payment_id = payment_id
    await db.commit()

    return {"status": "ok"}
