import ipaddress
import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.utils import get_current_user
from app.database import get_db
from app.models import User
from app.payments.service import check_payment, create_payment

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/payments", tags=["payments"])

# YooKassa outbound IP ranges — https://yookassa.ru/developers/using-api/webhooks
_YOOKASSA_NETWORKS: frozenset[ipaddress.IPv4Network] = frozenset({
    ipaddress.ip_network("185.71.76.0/27"),
    ipaddress.ip_network("185.71.77.0/27"),
    ipaddress.ip_network("77.75.153.0/25"),
    ipaddress.ip_network("77.75.156.11/32"),
    ipaddress.ip_network("77.75.156.35/32"),
})


def _is_yookassa_ip(ip_str: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip_str)
        return any(addr in net for net in _YOOKASSA_NETWORKS)
    except ValueError:
        return False


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
    """Handle YooKassa webhook notifications."""
    real_ip = request.headers.get("X-Real-IP") or (request.client.host if request.client else "")
    if not _is_yookassa_ip(real_ip):
        logger.warning("Webhook from unexpected IP: %s", real_ip)
        return {"status": "ignored"}

    body = await request.json()

    event_type = body.get("event")
    if event_type != "payment.succeeded":
        return {"status": "ignored"}

    payment_object = body.get("object", {})
    payment_id = payment_object.get("id")

    if not payment_id:
        return {"status": "no payment id"}

    payment_info = check_payment(payment_id)

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

    user.plan = plan
    user.plan_expires_at = datetime.now(timezone.utc) + timedelta(days=30)
    await db.commit()

    return {"status": "ok"}
