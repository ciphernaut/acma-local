"""Tool registry for managing MCP tools."""

from collections.abc import Callable
from typing import Any

import structlog

from acma_mcp.database.connection import DatabaseManager

from jsonschema import validate, ValidationError

logger = structlog.get_logger()


class ToolRegistry:
    """Registry for managing MCP tools."""

    def __init__(self, db_manager: DatabaseManager):
        """Initialize tool registry.

        Args:
            db_manager: Database manager instance
        """
        self.db_manager = db_manager
        self._tools: dict[str, Callable] = {}
        self._tool_schemas: dict[str, dict[str, Any]] = {}

    async def initialize(self) -> None:
        """Initialize the tool registry with all available tools."""
        # Import and register all tools
        from acma_mcp.tools.client_tools import register_client_tools
        from acma_mcp.tools.device_tools import register_device_tools
        from acma_mcp.tools.licence_tools import register_licence_tools
        from acma_mcp.tools.spectrum_tools import register_spectrum_tools
        from acma_mcp.tools.discovery_tools import register_discovery_tools

        register_licence_tools(self)
        register_client_tools(self)
        register_device_tools(self)
        register_spectrum_tools(self)
        register_discovery_tools(self)

        logger.info("Tool registry initialized", tool_count=len(self._tools))

    def register_tool(self, name: str, func: Callable, schema: dict[str, Any]) -> None:
        """Register a tool with the registry.

        Args:
            name: Tool name
            func: Tool function
            schema: Tool schema for validation
        """
        self._tools[name] = func
        self._tool_schemas[name] = schema
        logger.debug("Tool registered", name=name)

    async def list_tools(self) -> list[dict[str, Any]]:
        """List all available tools with their schemas."""
        tools = []
        for name, schema in self._tool_schemas.items():
            tools.append(
                {
                    "name": name,
                    "description": schema.get("description", ""),
                    "inputSchema": schema.get("inputSchema", {}),
                }
            )
        return tools

    async def execute_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        """Execute a tool with given arguments.

        Args:
            name: Tool name
            arguments: Tool arguments

        Returns:
            Tool execution result

        Raises:
            ValueError: If tool not found or validation fails
            Exception: If tool execution fails
        """
        if name not in self._tools:
            raise ValueError(f"Tool '{name}' not found")

        schema = self._tool_schemas[name].get("inputSchema")
        if schema:
            try:
                validate(instance=arguments, schema=schema)
            except ValidationError as e:
                logger.error("Tool validation failed", name=name, error=str(e))
                raise ValueError(f"Invalid arguments for tool '{name}': {e.message}")

        tool_func = self._tools[name]
        logger.info("Executing tool", name=name, arguments=arguments)

        try:
            result = await tool_func(self.db_manager, **arguments)
            logger.info("Tool executed successfully", name=name)
            return result
        except Exception as e:
            logger.error("Tool execution failed", name=name, error=str(e))
            raise
