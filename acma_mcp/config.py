"""Configuration management for ACMA MCP server."""

import os

from pydantic import BaseModel, Field


class Settings(BaseModel):
    """Application settings with environment variable support."""

    # Database
    database_path: str = Field(
        default="./data/acma_licences.db", description="SQLite database path"
    )

    # Server
    host: str = Field(default="0.0.0.0", description="Server host")
    port: int = Field(default=8000, description="HTTP/WebSocket port")
    grpc_port: int = Field(default=50051, description="gRPC port")

    # Caching
    redis_url: str | None = Field(default=None, description="Redis connection URL")
    cache_ttl_default: int = Field(
        default=300, description="Default cache TTL in seconds"
    )

    # Performance
    max_memory_mb: int = Field(default=1024, description="Maximum memory usage in MB")
    connection_pool_size: int = Field(
        default=20, description="Database connection pool size"
    )

    # ETL
    etl_schedule: str = Field(
        default="0 2 * * 0", description="Cron schedule for ETL (weekly Sunday 2AM)"
    )
    data_source_path: str = Field(
        default="./data/acma", description="ACMA data source path"
    )

    # Logging
    log_level: str = Field(default="INFO", description="Logging level")
    log_file: str | None = Field(default=None, description="Log file path")

    # Security
    rate_limit_per_minute: int = Field(
        default=100, description="Rate limit per client per minute"
    )

    def __init__(self, **data):
        """Initialize settings from environment variables."""
        # Override with environment variables if present
        env_overrides = {}
        field_types = {
            "port": int,
            "grpc_port": int,
            "cache_ttl_default": int,
            "max_memory_mb": int,
            "connection_pool_size": int,
            "rate_limit_per_minute": int,
        }

        for field_name in self.__fields__:
            env_value = os.getenv(field_name.upper())
            if env_value is not None:
                # Type conversion based on field name
                if field_name in field_types:
                    env_overrides[field_name] = field_types[field_name](env_value)
                else:
                    env_overrides[field_name] = env_value

        # Merge provided data with environment overrides
        merged_data = {**data, **env_overrides}
        super().__init__(**merged_data)


# Global settings instance
settings = Settings()
