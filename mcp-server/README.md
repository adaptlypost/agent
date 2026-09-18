# @adaptlypost/mcp-server

MCP (Model Context Protocol) server for AdaptlyPost. It lets AI agents manage social media posts, schedule content, check publishing results and read post analytics across 9 platforms.

## Supported Platforms

Instagram, TikTok, YouTube, X (Twitter), LinkedIn, Facebook, Pinterest, Threads, Bluesky

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

API key alternative, for headless agents and clients without OAuth. Create a token at [adaptlypost.com/api-tokens](https://adaptlypost.com/api-tokens). Keys start with `adaptly_`.

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

## Available Tools

Analytics cover Facebook, Instagram, Threads, TikTok, Pinterest, Bluesky and YouTube for the last 180 days. X has no analytics API worth the price, and LinkedIn analytics are waiting on LinkedIn's approval.

| Tool | Description |
|---|---|
| `list_accounts` | List all connected social media accounts with IDs, platforms and `status` |
| `check_account` | Ask the platform now whether a Facebook page's token still works |
| `create_post` | Create a post — publish immediately, schedule, or save as draft |
| `get_post` | Get full details of a single post by ID |
| `list_posts` | List posts with filters by status, platform, date range |
| `update_post` | Update a scheduled or draft post |
| `delete_post` | Delete a scheduled or draft post |
| `publish_draft` | Publish a draft post immediately or schedule it |
| `list_post_results` | Check per-platform posting results — success/failure with error details |
| `retry_failed_platforms` | Retry publishing on platforms that failed |
| `bulk_schedule_posts` | Schedule multiple posts at once |
| `get_analytics_overview` | Views, likes, comments, shares, followers and engagement rate for a date window, with the change against the previous window |
| `get_analytics_timeseries` | The same metrics bucketed by day, week or month |
| `get_platform_breakdown` | The same metrics split per platform, with the metrics each platform reports |
| `list_post_analytics` | Per-post metrics, sortable by any metric, for top-post and "how did this post do" questions |
| `get_analytics_sync_status` | When each account last synced and whether one needs reconnecting for analytics |
| `trigger_analytics_sync` | Refresh analytics now (once per 10 minutes per workspace) |

## Links

- [AdaptlyPost](https://www.adaptlypost.com)
- [AI Agents page](https://www.adaptlypost.com/features/agents)
- [Agent Skill repo](https://github.com/adaptlypost/agent)
- [API Tokens](https://adaptlypost.com/api-tokens)

## License

MIT
