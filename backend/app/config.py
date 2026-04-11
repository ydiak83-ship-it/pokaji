from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://pokaji:pokaji@localhost:5432/pokaji"
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

    # SMTP for email verification
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""

    model_config = {"env_file": ".env", "extra": "ignore"}

    def is_lifetime(self, email: str) -> bool:
        if not self.lifetime_emails:
            return False
        return email.lower() in {e.strip().lower() for e in self.lifetime_emails.split(",")}

    @property
    def smtp_configured(self) -> bool:
        return bool(self.smtp_host and self.smtp_user and self.smtp_password)


settings = Settings()
