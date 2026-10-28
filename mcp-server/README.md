# @adaptlypost/mcp-server

MCP (Model Context Protocol) server for AdaptlyPost. It lets AI agents manage social media posts, schedule content, check publishing results, read post analytics generate captions and images, and manage RSS feeds, connect links and webhooks across 13 platforms. The server exposes 58 tools.

## Supported Platforms

Instagram, TikTok, YouTube, X (Twitter), LinkedIn, Facebook, Pinterest, Threads, Bluesky, Mastodon, Google Business Profile

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

Analytics cover Facebook, Instagram, Threads, TikTok, Pinterest, Bluesky, LinkedIn, YouTube, X and Google Business Profile. Google Business Profile reports location impressions only, with no per-post numbers. Mastodon, Telegram and Tumblr have no analytics. Connecting an account imports its posts from the last 180 days, and analytics are kept from then on while the account stays connected.

| Tool | Description |
|---|---|
| `list_workspaces` | List the workspaces the sign-in can act in; pass an id as `workspaceId` to any other tool |
| `get_me` | What this connection may do in a workspace: role, permission keys and `can { draft, schedule, publish }` |
| `list_accounts` | List all connected social media accounts with IDs, platforms and `status` (`active` or `unauthorized`) |
| `search_instagram_audio` | Search Instagram music and original sounds to add to a Reel |
| `list_pinterest_boards` | List the boards of a Pinterest account; pass a board `id` as `pinterestConfigs[].boardId`, or its name as `boardName` (not both) |
| `check_account` | Re-check a Facebook page with Facebook and get its fresh `status` |
| `remove_account` | Disconnect an account from the workspace; it comes off pending and recurring posts |
| `create_connect_link` | Create a link a client opens to connect their accounts, optionally private, limited to some platforms, capped or never expiring |
| `revoke_connect_link` | Revoke a connect link |
| `upload_media` | Upload images, videos or documents from ChatGPT attachments, public URLs or base64 and get `mediaUrls` for a post |
| `get_upload_urls` | Mint presigned upload URLs for larger files; PUT the bytes, then use `publicUrl` |
| `open_upload_widget` | Show an upload box in ChatGPT or Claude so the user can add files from their device; the box sends back the `mediaUrls` |
| `get_upload_ticket` | Called by the upload box, once per file; hidden from the model |
| `create_post` | Create a post: publish immediately, schedule, or save as draft (a draft can carry a planned date). Takes first comments, per-platform thumbnails and image shapes, Instagram and Facebook story sharing, Instagram collaborators, user tags, AI labels and Reel audio, Facebook text backgrounds and link carousels, LinkedIn reshares, threads of replies, Tumblr tags and Google Business Profile events and offers |
| `validate_post` | Dry-run `create_post` with the same input: every problem, per account, without creating anything |
| `get_post` | Get full details of a single post by ID |
| `list_posts` | List posts with filters by status, platform, date range |
| `update_post` | Update a scheduled or draft post |
| `delete_post` | Delete a post record; cancels a draft or scheduled post, never removes content already live |
| `unschedule_post` | Turn a scheduled post back into an undated draft without deleting it |
| `publish_draft` | Publish a draft post immediately or schedule it. Without a date, a draft with a future planned date is scheduled for it and any other draft publishes now; `publishNow: true` publishes now regardless |
| `list_post_results` | Check per-platform posting results, success or failure with error details |
| `retry_failed_platforms` | Retry publishing on platforms that failed |
| `bulk_schedule_posts` | Schedule up to 100 posts at once |
| `validate_bulk_posts` | Dry-run `bulk_schedule_posts`: one validation report per item |
| `list_recurring_posts` | List recurring posts (daily, weekly, monthly or yearly series made with `recurrence` on `create_post`) by status |
| `get_recurring_post` | Get one recurring post with its schedule, status and next occurrence |
| `pause_recurring_post` | Pause a recurring post and delete its upcoming scheduled post |
| `resume_recurring_post` | Resume a paused recurring post from the next occurrence after now |
| `delete_recurring_post` | Stop a recurring post for good; posts already published are kept |
| `list_rss_feeds` | List the RSS and Atom feeds that turn new items into posts, with why a paused one stopped |
| `get_rss_feed` | One RSS feed with its settings and status |
| `preview_rss_feed` | Fetch a feed without saving it and show the 5 newest items as posts |
| `create_rss_feed` | Connect a feed: each new item becomes a draft, a scheduled post or a published post on the target accounts |
| `update_rss_feed` | Change a feed's targets, mode, template, keywords or interval |
| `delete_rss_feed` | Stop a feed for good; its posts stay |
| `list_rss_feed_items` | What a feed did with each item: posted, filtered, skipped or failed |
| `pause_rss_feed` | Pause a feed |
| `resume_rss_feed` | Resume a paused feed |
| `check_rss_feed` | Check a feed now instead of waiting for its interval |
| `get_analytics_overview` | Views, likes, comments, shares, followers and engagement rate for a date window, with the change against the previous window |
| `get_analytics_timeseries` | The same metrics bucketed by day, week or month |
| `get_platform_breakdown` | The same metrics split per platform, with the metrics each platform reports |
| `list_post_analytics` | Per-post metrics, sortable by any metric, for top-post and "how did this post do" questions |
| `list_top_posts` | The best posts in a window by one metric, in one call |
| `list_discovered_posts` | Posts found on the connected accounts that were not published through AdaptlyPost |
| `get_analytics_sync_status` | When each account last synced and whether one needs reconnecting for analytics |
| `trigger_analytics_sync` | Refresh analytics now (once per 4 hours per workspace) |
| `list_webhooks` | List webhook endpoints and their delivery state |
| `get_webhook` | One webhook endpoint |
| `create_webhook` | Register an endpoint for every event; the signing secret is shown only in this response |
| `update_webhook` | Change an endpoint's URL or turn it off and on |
| `delete_webhook` | Delete an endpoint |
| `test_webhook` | Send a signed `webhook.test` event and see how the endpoint answered |
| `generate_caption` | Write a caption from a prompt, kept within a platform's character limit; 2 AI credits |
| `refine_caption` | Rewrite an existing caption from an instruction, or continue a partial one; 2 AI credits |
| `generate_image` | Start an image generation and get a `jobId`; 2 credits standard, 4 premium |
| `get_image_job` | Poll an image job until `completed` (with a public `imageUrl`) or `failed` |

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
