from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://pokaji:pokaji@localhost:5432/pokaji"
    redis_url: str = "redis://localhost:6379/0"

    jwt_secret: str = "change-me-to-random-string"
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

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
