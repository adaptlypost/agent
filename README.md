# AdaptlyPost Agent

Give your AI agent the ability to post to 9 social media platforms from a single command.

**Supports:** Instagram, TikTok, YouTube, X (Twitter), LinkedIn, Facebook, Pinterest, Threads, Bluesky

## Install

```bash
npx skills add adaptlypost/agent
```

Works with Claude Code, Cursor, Windsurf, Codex, and any agent that supports skills.

### Other installation methods

**Manual**: Copy the `skills/adaptlypost/` folder into your project's skills directory.

**Cursor remote rules**: Point to `https://raw.githubusercontent.com/adaptlypost/agent/main/skills/adaptlypost/SKILL.md`

## Setup

1. Create an account at [adaptlypost.com](https://adaptlypost.com)
2. Connect your social media accounts
3. Create an API token at [Settings > API Tokens](https://adaptlypost.com/api-tokens)
4. Run:
   ```bash
   ./scripts/adaptlypost.js setup --key adaptly_xxxxx
   ```

## What it does

Once installed, your AI agent can:

- **Post** to 9 platforms simultaneously with per-platform caption overrides
- **Schedule** posts for any future time
- **Bulk schedule** up to 100 posts at once
- **Check results** per-platform success/failure with error details
- **Retry** just the failed platforms
- **Draft & publish** workflow — save drafts, review, publish later

## Example

```
You: Schedule a LinkedIn post for tomorrow at 9am about our new feature launch
Agent: Done. Post scheduled for tomorrow at 9:00 AM on your LinkedIn account.
```

## Alternative: MCP

For deeper integration with Claude Desktop, Cursor, or other MCP-compatible clients, use the AdaptlyPost MCP server:

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

[MCP setup docs](https://adaptlypost.com/features/agents)

## Links

- [AdaptlyPost](https://adaptlypost.com)
- [AI Agents page](https://adaptlypost.com/features/agents)
- [API Tokens](https://adaptlypost.com/api-tokens)
- [MCP Server](https://github.com/adaptlypost/mcp-server)

## License

MIT
