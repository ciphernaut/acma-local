"""Main FastAPI application for ACMA MCP server."""

from contextlib import asynccontextmanager
from typing import Any

import structlog
import uvicorn
from fastapi import FastAPI, WebSocket, Request
from fastapi.middleware.cors import CORSMiddleware

from acma_mcp.config import settings
from acma_mcp.database.connection import DatabaseManager
from acma_mcp.tools.registry import ToolRegistry
from acma_mcp.transports.websocket import WebSocketHandler

from mcp.server.fastmcp import FastMCP

logger = structlog.get_logger()

# Initialize FastMCP for standard MCP support
mcp_server = FastMCP("ACMA MCP Server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle."""
    # Startup
    logger.info("Starting ACMA MCP server")

    # Initialize database
    db_manager = DatabaseManager(settings.database_path)
    await db_manager.initialize()
    app.state.db = db_manager

    # Initialize tool registry
    tool_registry = ToolRegistry(db_manager)
    await tool_registry.initialize()
    app.state.tools = tool_registry

    # Initialize WebSocket handler
    ws_handler = WebSocketHandler(tool_registry)
    app.state.ws_handler = ws_handler

    # Register tools from registry to FastMCP
    tools = await tool_registry.list_tools()
    for tool_def in tools:
        name = tool_def["name"]
        description = tool_def["description"]
        
        # Define a tool in FastMCP that calls our registry
        async def call_registry_tool(t_name=name, **kwargs):
            return await tool_registry.execute_tool(t_name, kwargs)
            
        mcp_server.add_tool(
            fn=call_registry_tool,
            name=name,
            description=description
        )

    logger.info("ACMA MCP server started successfully")

    yield

    # Shutdown
    logger.info("Shutting down ACMA MCP server")
    await db_manager.close()
    logger.info("ACMA MCP server stopped")


# Create FastAPI application
app = FastAPI(
    title="ACMA MCP Server",
    description="Model Context Protocol server for ACMA radio licensing data",
    version="0.1.0",
    lifespan=lifespan,
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root() -> dict[str, str]:
    """Root endpoint with server info."""
    return {"name": "ACMA MCP Server", "version": "0.1.0", "status": "running"}


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "healthy"}


# Mount FastMCP SSE endpoints
# FastMCP provides an 'sse_app' which is a standard Starlette/FastAPI app
app.mount("/mcp", mcp_server.sse_app())


@app.get("/tools")
async def list_tools() -> dict[str, Any]:
    """List available MCP tools."""
    if not hasattr(app.state, "tools"):
        return {"tools": []}

    tools = await app.state.tools.list_tools()
    return {"tools": tools}


@app.post("/tools/{tool_name}")
async def execute_tool(tool_name: str, parameters: dict[str, Any]) -> dict[str, Any]:
    """Execute an MCP tool via HTTP POST."""
    if not hasattr(app.state, "tools"):
        return {"error": "Tool registry not initialized"}

    try:
        result = await app.state.tools.execute_tool(tool_name, parameters)
        return {"result": result}
    except Exception as e:
        logger.error("Tool execution failed", tool=tool_name, error=str(e))
        return {"error": str(e)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for MCP communication."""
    if not hasattr(app.state, "ws_handler"):
        await websocket.close(code=1011, reason="Server not fully initialized")
        return

    await app.state.ws_handler.handle_connection(websocket)


def main():
    """Main entry point for running the server."""
    uvicorn.run(
        "acma_mcp.server:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        reload=False,
    )


if __name__ == "__main__":
    main()
