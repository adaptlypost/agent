# @adaptlypost/mcp-server

MCP (Model Context Protocol) server for AdaptlyPost — give AI agents the ability to manage social media posts, schedule content, and check publishing results across 9 platforms.

## Supported Platforms

Instagram, TikTok, YouTube, X (Twitter), LinkedIn, Facebook, Pinterest, Threads, Bluesky

## Quick Start

### One-link setup (hosted)

Connect with a single URL — no local install needed:

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
| `ADAPTLYPOST_API_TOKEN` | Yes | API token from [app.adaptlypost.com/api-tokens](https://app.adaptlypost.com/api-tokens) |
| `ADAPTLYPOST_API_URL` | No | Custom API base URL (defaults to production) |

## Available Tools

| Tool | Description |
|---|---|
| `list_accounts` | List all connected social media accounts with IDs and platforms |
| `create_post` | Create a post — publish immediately, schedule, or save as draft |
| `get_post` | Get full details of a single post by ID |
| `list_posts` | List posts with filters by status, platform, date range |
| `update_post` | Update a scheduled or draft post |
| `delete_post` | Delete a scheduled or draft post |
| `publish_draft` | Publish a draft post immediately or schedule it |
| `list_post_results` | Check per-platform posting results — success/failure with error details |
| `retry_failed_platforms` | Retry publishing on platforms that failed |
| `bulk_schedule_posts` | Schedule multiple posts at once |

## Links

- [AdaptlyPost](https://www.adaptlypost.com)
- [AI Agents page](https://www.adaptlypost.com/features/agents)
- [Agent Skill repo](https://github.com/adaptlypost/agent)
- [API Tokens](https://app.adaptlypost.com/api-tokens)

## License

MIT
