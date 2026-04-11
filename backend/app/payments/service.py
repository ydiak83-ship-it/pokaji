import uuid

from yookassa import Configuration, Payment

from app.config import settings

PLANS = {
    "pro": {"amount": "390.00", "description": "Pokaji Pro — ежемесячная подписка"},
    "team": {"amount": "990.00", "description": "Pokaji Команда — ежемесячная подписка"},
}

# Configure once at import time — yookassa globals are process-wide
Configuration.account_id = settings.yookassa_shop_id
Configuration.secret_key = settings.yookassa_secret_key


def create_payment(plan: str, user_id: uuid.UUID) -> dict[str, str]:
    """Create a YooKassa payment. Returns payment URL and payment ID."""

    if plan not in PLANS:
        raise ValueError(f"Unknown plan: {plan}")

    plan_info = PLANS[plan]

    payment = Payment.create(
        {
            "amount": {"value": plan_info["amount"], "currency": "RUB"},
            "confirmation": {
                "type": "redirect",
                "return_url": f"{settings.app_url}/dashboard?payment=success",
            },
            "capture": True,
            "description": plan_info["description"],
            "metadata": {"user_id": str(user_id), "plan": plan},
        },
        idempotency_key=str(uuid.uuid4()),
    )

    return {
        "payment_id": payment.id,
        "confirmation_url": payment.confirmation.confirmation_url,
    }


def check_payment(payment_id: str) -> dict[str, str]:
    """Check payment status. Returns status and metadata."""
    payment = Payment.find_one(payment_id)

    return {
        "status": payment.status,
        "user_id": payment.metadata.get("user_id", ""),
        "plan": payment.metadata.get("plan", ""),
    }
