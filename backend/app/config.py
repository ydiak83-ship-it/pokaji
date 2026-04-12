from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    redis_url: str = "redis://localhost:6379/0"

    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 10080  # 7 days

    s3_endpoint: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_bucket: str = "pokaji-videos"
    s3_region: str = "ru-1"

    app_url: str = "http://localhost:3000"
    api_url: str = "http://localhost:8000"
    upload_max_size_mb: int = 500

    yookassa_shop_id: str = ""
    yookassa_secret_key: str = ""

    # Comma-separated emails with lifetime unlimited Pro access (e.g. "owner@example.com")
    lifetime_emails: str = ""

    # MVP mode: hides all paid UI and makes payment endpoints return 404.
    # Default true so the app ships as a single free tier without needing an
    # env var. Flip to false (via IS_FREE_MVP=false in .env) to re-enable
    # the pricing page, upgrade CTAs and YooKassa integration on redeploy.
    is_free_mvp: bool = True

    # Email sending via Resend HTTP API (VPS blocks SMTP port 587)
    resend_api_key: str = ""
    email_from: str = ""

    model_config = {"env_file": ".env", "extra": "ignore"}

    def is_lifetime(self, email: str) -> bool:
        if not self.lifetime_emails:
            return False
        return email.lower() in {e.strip().lower() for e in self.lifetime_emails.split(",")}

    @property
    def email_configured(self) -> bool:
        return bool(self.resend_api_key and self.email_from)


settings = Settings()
