# AdaptlyPost agent

[![smithery badge](https://smithery.ai/badge/tarasshyn/adaptlypost)](https://smithery.ai/servers/tarasshyn/adaptlypost)

Let your AI agent draft, schedule and publish posts on Instagram, TikTok, YouTube, X (Twitter), LinkedIn, Facebook, Pinterest, Threads, Bluesky, Mastodon, Google Business Profile, Tumblr, Telegram and WordPress, all 14 platforms AdaptlyPost supports, and read how those posts performed.

## What this repo is

This repo holds every AdaptlyPost agent integration except the Claude Code and Hermes Agent plugin:

| Path | What it is |
| --- | --- |
| [`skills/adaptlypost/`](./skills/adaptlypost) | The agent skill for `npx skills add`. It drives the AdaptlyPost REST API through `scripts/adaptlypost.js` with an API key. |
| [`mcp-server/`](./mcp-server) | Source of the MCP server that runs at `https://mcp.adaptlypost.com/mcp`. A push to `main` that touches it builds a new image. |
| `gemini-extension.json`, `GEMINI.md` | The Gemini CLI extension. It connects to the hosted MCP server and signs in with OAuth. |
| `Dockerfile`, `glama.json` | Runs the MCP server over stdio, for Glama and anyone who wants it in a container. |
| `lhm.plugin.json` | The LobeHub marketplace listing for the hosted MCP server. |

The Claude Code and Hermes Agent plugin lives in [adaptlypost/claude-plugin](https://github.com/adaptlypost/claude-plugin). It signs in with OAuth and never asks for an API key, which the Claude plugin directory and the Hermes catalog both require, so it ships its own MCP-only skill instead of the script skill here.

## Pick your install

| You use | Install | Sign-in |
| --- | --- | --- |
| Claude Code | `/plugin install adaptlypost --marketplace adaptlypost/claude-plugin` | OAuth |
| Hermes Agent | `hermes plugins install adaptlypost` | OAuth |
| Gemini CLI | `gemini extensions install https://github.com/adaptlypost/agent` | OAuth |
| Claude Desktop, Cursor, ChatGPT or any MCP client | Add `https://mcp.adaptlypost.com/mcp` as a remote server | OAuth, or an API key header |
| Cursor, Codex, Windsurf, Claude Code or any agent with skills | `npx skills add adaptlypost/agent` | API key |

## The skill

```bash
npx skills add adaptlypost/agent
```

Or copy `skills/adaptlypost/` into your project's skills folder. Cursor can also read it as a remote rule from `https://raw.githubusercontent.com/adaptlypost/agent/main/skills/adaptlypost/SKILL.md`.

### Setup

1. Create an account at [adaptlypost.com](https://adaptlypost.com) and connect your social accounts.
2. Create an API token at [Settings > API Tokens](https://adaptlypost.com/api-tokens) and pick its role.
3. Run:
   ```bash
   ./scripts/adaptlypost.js setup --key adaptly_xxxxx
   ```

### Roles

A token is issued under a workspace role and never does more than the member who created it. Admin does everything. Editor creates, schedules and publishes. Contributor creates and edits its own drafts and uploads media but cannot schedule or publish. Viewer reads. Pick Contributor for an agent that should not post on its own.

An operation outside the role answers 403 with `code: permission_denied`. The skill tells the agent to stop, save a draft where that applies, and ask a workspace member to publish, instead of retrying or hunting for another key.

### What the agent can do

- Post to any of the 14 platforms in one call, with per-platform captions, first comments, thumbnails and image shapes
- Check a post before creating it, and get every problem back at once
- Schedule for any future time, or bulk schedule up to 100 posts
- See per-platform results with error details, and retry only the platforms that failed
- Save drafts and publish them later
- Repeat a post daily, weekly, monthly or yearly, then pause, resume or stop the series
- Read analytics: views, likes, comments, followers and engagement per window, per platform and per post
- Manage webhooks and client connect links
- Write captions and generate images with AdaptlyPost AI, paid from your AI credits

```
You: Schedule a LinkedIn post for tomorrow at 9am about our new feature launch
Agent: Done. Post scheduled for tomorrow at 9:00 AM on your LinkedIn account.
```

## The MCP server

AdaptlyPost runs this server at `https://mcp.adaptlypost.com/mcp`. An OAuth-capable client needs only the URL and signs in in the browser; that sign-in reaches every workspace you belong to. A client without OAuth sends an API key:

```json
{
  "mcpServers": {
    "adaptlypost": {
      "type": "http",
      "url": "https://mcp.adaptlypost.com/mcp",
      "headers": { "Authorization": "Bearer adaptly_your_key" }
    }
  }
}
```

To run it yourself over stdio with [Bun](https://bun.sh):

```json
{
  "mcpServers": {
    "adaptlypost": {
      "command": "bun",
      "args": ["run", "/path/to/agent/mcp-server/src/index.ts"],
      "env": { "ADAPTLYPOST_API_TOKEN": "adaptly_your_key" }
    }
  }
}
```

Or in Docker:

```bash
docker build -t adaptlypost-mcp .
docker run -i -e ADAPTLYPOST_API_TOKEN=adaptly_your_key adaptlypost-mcp
```

The tools, their inputs and the local options are in [`mcp-server/README.md`](./mcp-server/README.md).

## Links

- [AdaptlyPost](https://adaptlypost.com)
- [AI agents](https://adaptlypost.com/features/agents)
- [API tokens](https://adaptlypost.com/api-tokens)
- [Claude Code and Hermes plugin](https://github.com/adaptlypost/claude-plugin)
- Privacy policy: [adaptlypost.com/privacy](https://adaptlypost.com/privacy)

## License

MIT
