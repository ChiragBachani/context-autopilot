# Dockerfile for Glama MCP introspection (glama.ai).
# The server is a zero-dependency stdio MCP server published to npm.
# Glama starts this container and sends an initialize + tools/list request.
FROM node:22-alpine

# Install the published package globally so `ctxlayer-mcp` is on PATH.
RUN npm install -g context-autopilot

# Glama speaks JSON-RPC over stdio to this process.
ENTRYPOINT ["ctxlayer-mcp"]
