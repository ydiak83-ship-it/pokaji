import logging

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"


def send_email(to: str, subject: str, html_body: str) -> None:
    """Send email via Resend HTTP API."""
    if not settings.email_configured:
        logger.warning("Email not configured — skipping send to %s", to)
        return

    try:
        resp = httpx.post(
            RESEND_API_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={
                "from": settings.email_from,
                "to": [to],
                "subject": subject,
                "html": html_body,
            },
            timeout=10,
        )
        resp.raise_for_status()
    except Exception:
        logger.exception("Failed to send email to %s", to)
        raise


def send_verification_email(to: str, token: str) -> None:
    verify_url = f"{settings.app_url}/verify-email?token={token}"
    html = f"""
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
      <h2 style="margin-bottom: 8px;">Подтвердите email</h2>
      <p style="color: #666; margin-bottom: 24px;">
        Нажмите кнопку ниже, чтобы активировать аккаунт Pokaji.
        Ссылка действительна 24 часа.
      </p>
      <a href="{verify_url}"
         style="display: inline-block; background: #6366f1; color: #fff;
                padding: 12px 28px; border-radius: 8px; text-decoration: none;
                font-weight: 600;">
        Подтвердить email
      </a>
      <p style="color: #999; font-size: 12px; margin-top: 24px;">
        Если вы не регистрировались на Pokaji — просто проигнорируйте это письмо.
      </p>
    </div>
    """
    send_email(to, "Подтвердите email — Pokaji", html)
