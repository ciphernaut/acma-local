# Configuring LM Studio with ACMA MCP

LM Studio can connect to the ACMA MCP server using the standard **SSE (Server-Sent Events)** transport. This allows LM Studio to access the radio licensing tools while the server is running as a network service.

## Configuration Steps

1.  **Start the ACMA MCP Server**:
    Ensure your server is running and accessible at `http://localhost:8000`.
    ```bash
    acma-mcp serve
    ```

2.  **Open LM Studio Configuration**:
    - Go to the **Settings** (gear icon) in LM Studio.
    - Locate the **MCP** section.
    - Click **Edit mcp.json** (or open `~/.lmstudio/mcp.json` in your editor).

3.  **Add the ACMA MCP Server**:
    Add the following configuration block to your `mcp.json` file:

    ```json
    {
      "mcpServers": {
        "acma-mcp": {
          "url": "http://localhost:8000/mcp/sse"
        }
      }
    }
    ```

    > [!NOTE]
    > LM Studio currently supports SSE transports for network-based MCP servers. The ACMA MCP server implements this standard at the `/sse` endpoint.

4.  **Save and Restart**:
    Save the `mcp.json` file. LM Studio should automatically detect the new server and list the ACMA tools in the chat interface.

## Troubleshooting

- **Connection Refused**: Ensure the server is running on port 8000 and that no firewalls are blocking the connection.
- **Tools Not Appearing**: Check the LM Studio console logs for any MCP initialization errors. Ensure you are using LM Studio version 0.3.17 or later.
