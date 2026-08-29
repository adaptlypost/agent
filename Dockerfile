FROM node:22-alpine
RUN npm install -g mcp-remote
ENTRYPOINT ["mcp-remote", "https://mcp.adaptlypost.com/mcp"]
