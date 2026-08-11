@echo off
rem browser-mcp.bat — launch the live_browser MCP server (WS hub on 127.0.0.1:8644)
rem Clears PYTHONPATH: this machine's env points at the Hermes venv, which ships a
rem 3.11-built pydantic_core that breaks Python 3.14 imports (fastmcp/websockets).
set PYTHONPATH=
py -3.14 -u "%~dp0browser-mcp.py" %*
