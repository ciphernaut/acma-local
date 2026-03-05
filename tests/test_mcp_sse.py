import asyncio
import subprocess
import time
import httpx
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client
import sys
import os

# Add project root to path
sys.path.append(os.getcwd())

async def run_test():
    server_process = None
    try:
        # Start the server on a random port for testing
        port = 8006
        print(f"Starting server on port {port}...")
        server_process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "acma_mcp.server:app", "--host", "127.0.0.1", "--port", str(port)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        
        # Wait for server to start
        max_retries = 10
        server_ready = False
        for i in range(max_retries):
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.get(f"http://127.0.0.1:{port}/health")
                    if response.status_code == 200:
                        server_ready = True
                        break
            except Exception:
                pass
            print(f"Waiting for server... ({i+1}/{max_retries})")
            await asyncio.sleep(1)
        
        if not server_ready:
            print("Server failed to start")
            stdout, stderr = server_process.communicate(timeout=1)
            print(f"STDOUT: {stdout}")
            print(f"STDERR: {stderr}")
            return

        print("Server is ready. Connecting via SSE...")
        
        url = f"http://127.0.0.1:{port}/mcp/sse"
        async with sse_client(url=url) as streams:
            # Pass streams as keyword arguments to avoid positional mismatch issues
            async with ClientSession(read_stream=streams[0], write_stream=streams[1]) as session:
                print("Initializing session...")
                await session.initialize()
                
                print("Listing tools...")
                tools = await session.list_tools()
                print(f"Found {len(tools.tools)} tools")
                
                # Check for a specific tool
                tool_names = [t.name for t in tools.tools]
                assert "search_licences" in tool_names
                
                print("Calling search_licences...")
                result = await session.call_tool("search_licences", {"licencee": "Telstra", "limit": 1})
                print(f"Tool call successful: {result.content[0].text[:100]}...")
                
                print("\nTest passed successfully!")

    except Exception as e:
        print(f"Test failed: {e}")
        import traceback
        traceback.print_exc()
        if server_process:
             stdout, stderr = server_process.communicate(timeout=1)
             print(f"STDOUT: {stdout}")
             print(f"STDERR: {stderr}")
    finally:
        if server_process:
            print("Stopping server...")
            server_process.terminate()
            server_process.wait()

if __name__ == "__main__":
    asyncio.run(run_test())
