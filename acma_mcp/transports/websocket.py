"""WebSocket transport handler for ACMA MCP server."""

import json
from datetime import datetime
from typing import Any

import structlog
from fastapi import WebSocket, WebSocketDisconnect

from acma_mcp.tools.registry import ToolRegistry

logger = structlog.get_logger()


class WebSocketHandler:
    """WebSocket-based MCP transport handler."""

    def __init__(self, tool_registry: ToolRegistry):
        """Initialize WebSocket handler.

        Args:
            tool_registry: Tool registry instance
        """
        self.tool_registry = tool_registry

    async def handle_connection(self, websocket: WebSocket) -> None:
        """Handle incoming WebSocket connections."""
        await websocket.accept()
        client_id = f"ws_{id(websocket)}"

        logger.info("WebSocket client connected", client_id=client_id)

        try:
            while True:
                # Receive message from client
                message = await websocket.receive_text()

                try:
                    data = json.loads(message)
                    response = await self.process_mcp_message(data, client_id)
                    await websocket.send_text(json.dumps(response))

                except json.JSONDecodeError as e:
                    error_response = {
                        "id": None,
                        "error": {
                            "code": -32700,
                            "message": "Parse error",
                            "data": str(e),
                        },
                        "timestamp": datetime.utcnow().isoformat(),
                    }
                    await websocket.send_text(json.dumps(error_response))

                except Exception as e:
                    logger.error(
                        "Error processing WebSocket message",
                        client_id=client_id,
                        error=str(e),
                    )
                    error_response = {
                        "id": None,
                        "error": {
                            "code": -32603,
                            "message": "Internal error",
                            "data": str(e),
                        },
                        "timestamp": datetime.utcnow().isoformat(),
                    }
                    await websocket.send_text(json.dumps(error_response))

        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected", client_id=client_id)
        except Exception as e:
            logger.error(
                "WebSocket connection error", client_id=client_id, error=str(e)
            )

    async def process_mcp_message(
        self, message: dict[str, Any], client_id: str
    ) -> dict[str, Any]:
        """Process MCP protocol messages.

        Args:
            message: MCP message dictionary
            client_id: Client identifier for logging

        Returns:
            MCP response dictionary
        """
        message_id = message.get("id")
        method = message.get("method")
        params = message.get("parameters", {})

        logger.info(
            "Processing MCP message",
            client_id=client_id,
            method=method,
            message_id=message_id,
        )

        # Handle different MCP methods
        if method == "tools/list":
            tools = await self.tool_registry.list_tools()
            return {
                "id": message_id,
                "result": {"tools": tools},
                "timestamp": datetime.utcnow().isoformat(),
            }

        elif method == "tools/call":
            tool_name = params.get("name")
            arguments = params.get("arguments", {})

            if not tool_name:
                return {
                    "id": message_id,
                    "error": {
                        "code": -32602,
                        "message": "Invalid params: tool name required",
                    },
                    "timestamp": datetime.utcnow().isoformat(),
                }

            try:
                result = await self.tool_registry.execute_tool(tool_name, arguments)
                return {
                    "id": message_id,
                    "result": {"content": [{"type": "text", "text": str(result)}]},
                    "timestamp": datetime.utcnow().isoformat(),
                }
            except Exception as e:
                logger.error(
                    "Tool execution failed",
                    client_id=client_id,
                    tool=tool_name,
                    error=str(e),
                )
                return {
                    "id": message_id,
                    "error": {
                        "code": -32603,
                        "message": "Tool execution failed",
                        "data": str(e),
                    },
                    "timestamp": datetime.utcnow().isoformat(),
                }

        elif method == "initialize":
            # MCP initialization handshake
            return {
                "id": message_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "acma-mcp-server", "version": "0.1.0"},
                },
                "timestamp": datetime.utcnow().isoformat(),
            }

        else:
            return {
                "id": message_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
                "timestamp": datetime.utcnow().isoformat(),
            }
