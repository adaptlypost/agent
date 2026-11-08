# @adaptlypost/mcp-server

MCP (Model Context Protocol) server for AdaptlyPost. It lets AI agents manage social media posts, schedule content, check publishing results, read post analytics generate captions and images, and manage RSS feeds, connect links and webhooks across 14 platforms. The server exposes 59 tools.

## Supported Platforms

Instagram, TikTok, YouTube, X (Twitter), LinkedIn, Facebook, Pinterest, Threads, Bluesky, Mastodon, Google Business Profile, Tumblr, Telegram, WordPress

## Quick Start

### Hosted server

Point any MCP client at the URL and sign in when the browser opens. No API key to paste. The server answers unauthenticated requests with a 401 and a `WWW-Authenticate` header, so Claude Code, claude.ai, ChatGPT and Cursor open the sign-in page on their own.

One-liner for Claude Code:

```bash
claude mcp add --transport http adaptlypost https://mcp.adaptlypost.com/mcp
```

Full config for Cursor, Claude Desktop connectors and other clients:

```json
{
  "mcpServers": {
    "adaptlypost": {
      "type": "http",
      "url": "https://mcp.adaptlypost.com/mcp"
    }
  }
}
```

Claude Desktop without the connectors UI goes through `mcp-remote`, which handles the sign-in itself:

```json
{
  "mcpServers": {
    "adaptlypost": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.adaptlypost.com/mcp"]
    }
  }
}
```

API key alternative, for headless agents and clients without OAuth. Create a token at [adaptlypost.com/api-tokens](https://adaptlypost.com/api-tokens) and pick its role. Keys start with `adaptly_`.

```json
{
  "mcpServers": {
    "adaptlypost": {
      "type": "http",
      "url": "https://mcp.adaptlypost.com/mcp",
      "headers": {
        "Authorization": "Bearer adaptly_your_key"
      }
    }
  }
}
```

### Agent Skill (Claude Code, Cursor, Windsurf, Codex)

```bash
npx skills add adaptlypost/agent
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADAPTLYPOST_API_TOKEN` | Yes (stdio mode) | API token from [adaptlypost.com/api-tokens](https://adaptlypost.com/api-tokens) |
| `ADAPTLYPOST_API_URL` | No | Custom API base URL (defaults to production) |

## Roles and permissions

Every call runs under a workspace role: Admin, Editor, Contributor or Viewer. An API key carries the role it was created with and never does more than the member who created it; a sign-in over OAuth reaches every workspace the member belongs to, each under the member's own role there. Contributor keys create and edit their own drafts, upload media, generate captions and images, and read posts and analytics, but cannot schedule, publish, retry, bulk schedule or delete non-drafts.

An operation the role does not cover comes back from the API as 403 with `code: permission_denied`, `requiredPermission` and `role`; the tool returns that as an error that says to save a draft and ask a workspace member to publish, not to retry or look for another key. A key whose creator left the workspace answers 401 with `code: token_issuer_lost_access`. Every call answers 403 with `code: subscription_required` while the organization's plan does not include API access. A 429 carries `Retry-After`; the tool error says how long to wait and not to retry in a loop.

## Workspaces

An OAuth sign-in can reach several workspaces, each with its own accounts, posts and role. `list_workspaces` returns them, and every other tool takes an optional `workspaceId` that the server forwards as the `X-Workspace-Id` header. Without it a tool acts in the workspace `list_workspaces` marks `current`. A `workspaceId` the sign-in cannot reach returns 403 with `code: workspace_access_denied`. An API key belongs to one workspace, so `list_workspaces` shows only that one.

## Available Tools

The full tool list, grouped by area and marked read-only or not, is in the [repository README](../README.md#tools).

## AI captions and images

The four AI tools need the `ai.generate` permission, which Admin, Editor and Contributor hold and Viewer does not. Each generation spends the member's AI credits unless they connected their own AI provider key in AdaptlyPost, and credits are refunded when generation fails. With no credits left a caption call fails and an image job ends as `failed` with the reason in `error`.

Captions come back in the response. Images do not: `generate_image` queues the work and returns a `jobId` at once. Poll `get_image_job` every few seconds until `status` is `completed` or `failed`, usually 10 to 40 seconds, or subscribe to the `image.completed` and `image.failed` webhooks. A completed job's `imageUrl` is public and goes straight into `mediaUrls` on `create_post`.

## Links

- [AdaptlyPost](https://www.adaptlypost.com)
- [AI Agents page](https://www.adaptlypost.com/features/agents)
- [Agent Skill repo](https://github.com/adaptlypost/agent)
- [API Tokens](https://adaptlypost.com/api-tokens)

## License

MIT
