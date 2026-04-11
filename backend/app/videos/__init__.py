import httpx

# Populated by app lifespan — shared across all requests
http_client: httpx.AsyncClient | None = None
