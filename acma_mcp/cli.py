"""Command line interface for ACMA MCP server."""

import click
import uvicorn

from acma_mcp.config import settings


@click.group()
def cli():
    """ACMA MCP Server - Model Context Protocol server for ACMA radio licensing data."""
    pass


@cli.command()
@click.option("--host", default=None, help="Server host")
@click.option("--port", default=None, type=int, help="Server port")
@click.option("--reload", is_flag=True, help="Enable auto-reload for development")
def serve(host, port, reload):
    """Start the ACMA MCP server."""

    # Use CLI options or fall back to config
    server_host = host or settings.host
    server_port = port or settings.port

    click.echo(f"Starting ACMA MCP server on {server_host}:{server_port}")

    uvicorn.run(
        "acma_mcp.server:app",
        host=server_host,
        port=server_port,
        log_level=settings.log_level.lower(),
        reload=reload,
    )


@cli.command()
def version():
    """Show version information."""
    from acma_mcp import __version__

    click.echo(f"ACMA MCP Server v{__version__}")


def main():
    """Main entry point."""
    cli()


if __name__ == "__main__":
    main()
