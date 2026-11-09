# AdaptlyPost agent

Let your AI agent draft, schedule and publish posts on Instagram, TikTok, YouTube, X (Twitter), LinkedIn, Facebook, Pinterest, Threads, Bluesky, Mastodon, Google Business Profile, Tumblr, Telegram and WordPress, all 14 platforms AdaptlyPost supports, and read how those posts performed. 80 MCP tools cover posting, scheduling, bulk and recurring posts, media uploads, RSS feeds, webhooks, AI captions and images, analytics, and an inbox for answering comments, mentions, direct messages and Google reviews.

## Connect in 30 seconds

```bash
claude mcp add --transport http adaptlypost https://mcp.adaptlypost.com/mcp
```

Any other MCP client needs only the URL, `https://mcp.adaptlypost.com/mcp`. The first call opens a browser to sign in with your AdaptlyPost account. Nothing to install and no key to paste. Setup for each client is [below](#setup-by-client).

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

## Setup by client

The server answers an unauthenticated call with a 401 that points at its OAuth metadata, so every client below opens the AdaptlyPost sign-in on its own. One sign-in reaches every workspace you belong to.

### Claude.ai and Claude Desktop

Open Settings > Connectors, add a custom connector with the URL `https://mcp.adaptlypost.com/mcp`, and sign in. A Claude Desktop build without connectors can go through `mcp-remote`, which handles the sign-in itself:

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

### Claude Code

The plugin adds the server and a skill that knows how to use it:

```
/plugin install adaptlypost --marketplace adaptlypost/claude-plugin
```

Or add only the server:

```bash
claude mcp add --transport http adaptlypost https://mcp.adaptlypost.com/mcp
```

Run `/mcp`, pick `adaptlypost` and sign in.

### ChatGPT

Add a custom connector in Settings > Apps & Connectors with the URL `https://mcp.adaptlypost.com/mcp` and sign in.

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "adaptlypost": { "url": "https://mcp.adaptlypost.com/mcp" }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "adaptlypost": { "serverUrl": "https://mcp.adaptlypost.com/mcp" }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "adaptlypost": { "type": "http", "url": "https://mcp.adaptlypost.com/mcp" }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.adaptlypost]
url = "https://mcp.adaptlypost.com/mcp"
```

Then sign in with `codex mcp login adaptlypost`.

### Gemini CLI

```bash
gemini extensions install https://github.com/adaptlypost/agent
```

### Hermes Agent

```bash
hermes plugins install adaptlypost
hermes plugins enable adaptlypost
```

### Headless agents and clients without OAuth

Create an API token on [Settings > API Tokens](https://adaptlypost.com/api-tokens) and send it as a header. Keys start with `adaptly_`.

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

## Example prompts

- "Schedule this announcement on LinkedIn and X for tomorrow at 9am, with a shorter version for X."
- "Turn https://example.com/blog/launch into posts for Instagram, Threads and Bluesky and save them as drafts."
- "Post this video as an Instagram Reel and a TikTok, with a first comment that links to our site."
- "Check this post for problems on every platform before you schedule it."
- "Which platforms failed on yesterday's post? Retry only those."
- "Repeat our weekly tips post every Monday at 10am."
- "Connect our blog's RSS feed so every new article becomes a LinkedIn draft."
- "What were my five best posts last month by engagement, and on which platforms?"
- "Create a connect link my client can use to add their Instagram and Facebook accounts."
- "What's new in my inbox? Show unread comments and messages from today."
- "Draft friendly replies to the unanswered Instagram comments on yesterday's post, and send them once I approve."
- "Reply to every 5-star Google review from this week that has no reply yet."

## Tools

80 tools. Analytics cover Facebook, Instagram, Threads, TikTok, Pinterest, Bluesky, LinkedIn, YouTube, X and Google Business Profile. Google Business Profile reports location impressions only, with no per-post numbers. Mastodon, Telegram, Tumblr and WordPress have no analytics. Connecting an account imports its posts from the last 180 days. The upload box also calls `get_upload_ticket` once per file; that tool is hidden from the model.

### Workspaces and accounts

| Tool | What it does | Changes data |
| --- | --- | --- |
| `list_workspaces` | List the workspaces the sign-in can act in; pass an id as `workspaceId` to any other tool | No |
| `get_me` | What this connection may do in a workspace: role, permission keys and `can { draft, schedule, publish }` | No |
| `list_accounts` | List all connected social media accounts with IDs, platforms and `status` (`active` or `unauthorized`) | No |
| `check_account` | Re-check a Facebook page with Facebook and get its fresh `status` | Yes |
| `remove_account` | Disconnect an account from the workspace; it comes off pending and recurring posts | Yes |
| `create_connect_link` | Create a link a client opens to connect their accounts, optionally private, limited to some platforms, capped or never expiring | Yes |
| `revoke_connect_link` | Revoke a connect link | Yes |

### Posts

| Tool | What it does | Changes data |
| --- | --- | --- |
| `create_post` | Create a post: publish immediately, schedule, or save as draft (a draft can carry a planned date). Takes first comments, per-platform thumbnails and image shapes, Instagram and Facebook story sharing, Instagram collaborators, user tags, AI labels and Reel audio, Facebook text backgrounds and link carousels, LinkedIn reshares, X quotes of the account's own posts, threads of replies with images, Tumblr tags, WordPress titles, categories and tags, the YouTube audio language and Google Business Profile events and offers | Yes |
| `validate_post` | Dry-run `create_post` with the same input: every problem, per account, without creating anything | No |
| `get_post` | Get full details of a single post by ID | No |
| `list_posts` | List posts with filters by status, platform, date range | No |
| `update_post` | Update a scheduled or draft post, or a post that failed on every platform, which becomes a draft again | Yes |
| `delete_post` | Delete a post record; cancels a draft or scheduled post, never removes content already live | Yes |
| `unschedule_post` | Turn a scheduled post back into an undated draft without deleting it | Yes |
| `publish_draft` | Publish a draft post immediately or schedule it. Without a date, a draft with a future planned date is scheduled for it and any other draft publishes now; `publishNow: true` publishes now regardless | Yes |
| `list_post_results` | Check per-platform posting results, success or failure with error details | No |
| `retry_failed_platforms` | Retry publishing on platforms that failed | Yes |
| `bulk_schedule_posts` | Schedule up to 100 posts at once | Yes |
| `validate_bulk_posts` | Dry-run `bulk_schedule_posts`: one validation report per item | No |

### Media

| Tool | What it does | Changes data |
| --- | --- | --- |
| `upload_media` | Upload images, videos or documents from ChatGPT attachments, public URLs or base64 and get `mediaUrls` for a post | Yes |
| `get_upload_urls` | Mint presigned upload URLs for larger files; PUT the bytes, then use `publicUrl` | Yes |
| `open_upload_widget` | Show an upload box in ChatGPT or Claude chat so the user can add files from their device; the box sends back the `mediaUrls`. Where the box can't show (Claude Cowork, Claude Code), it returns an upload link instead; call it again with `uploadId` to get the `mediaUrls` | Yes |

### Platform options

| Tool | What it does | Changes data |
| --- | --- | --- |
| `search_instagram_audio` | Search Instagram music and original sounds to add to a Reel | No |
| `list_pinterest_boards` | List the boards of a Pinterest account; pass a board `id` as `pinterestConfigs[].boardId`, or its name as `boardName` (not both) | No |
| `list_wordpress_categories` | List the categories of a WordPress site; pass their `id`s as `wordpressConfigs[].categoryIds` | No |
| `resolve_linkedin_organization` | Look up a LinkedIn company page by its URL or vanity name and get the `mention` to paste into a LinkedIn post. Only on a server you run yourself for now, see [Run the server yourself](#run-the-server-yourself) | No |

### Recurring posts

| Tool | What it does | Changes data |
| --- | --- | --- |
| `list_recurring_posts` | List recurring posts (daily, weekly, monthly or yearly series made with `recurrence` on `create_post`) by status | No |
| `get_recurring_post` | Get one recurring post with its schedule, status and next occurrence | No |
| `pause_recurring_post` | Pause a recurring post and delete its upcoming scheduled post | Yes |
| `resume_recurring_post` | Resume a paused recurring post from the next occurrence after now | Yes |
| `delete_recurring_post` | Stop a recurring post for good; posts already published are kept | Yes |

### RSS feeds

| Tool | What it does | Changes data |
| --- | --- | --- |
| `list_rss_feeds` | List the RSS and Atom feeds that turn new items into posts, with why a paused one stopped | No |
| `get_rss_feed` | One RSS feed with its settings and status | No |
| `preview_rss_feed` | Fetch a feed without saving it and show the 5 newest items as posts | No |
| `create_rss_feed` | Connect a feed: each new item becomes a draft, a scheduled post or a published post on the target accounts | Yes |
| `update_rss_feed` | Change a feed's targets, mode, template, keywords or interval | Yes |
| `delete_rss_feed` | Stop a feed for good; its posts stay | Yes |
| `list_rss_feed_items` | What a feed did with each item: posted, filtered, skipped or failed | No |
| `pause_rss_feed` | Pause a feed | Yes |
| `resume_rss_feed` | Resume a paused feed | Yes |
| `check_rss_feed` | Check a feed now instead of waiting for its interval | Yes |

### Analytics

| Tool | What it does | Changes data |
| --- | --- | --- |
| `get_analytics_overview` | Views, likes, comments, shares, followers and engagement rate for a date window, with the change against the previous window | No |
| `get_analytics_timeseries` | The same metrics bucketed by day, week or month | No |
| `get_platform_breakdown` | The same metrics split per platform, with the metrics each platform reports | No |
| `list_post_analytics` | Per-post metrics, sortable by any metric, for top-post and "how did this post do" questions | No |
| `list_top_posts` | The best posts in a window by one metric, in one call | No |
| `list_discovered_posts` | Posts found on the connected accounts that were not published through AdaptlyPost | No |
| `get_analytics_sync_status` | When each account last synced and whether one needs reconnecting for analytics | No |
| `trigger_analytics_sync` | Refresh analytics now (once per 15 minutes per workspace) | Yes |

### Inbox

The inbox holds comments on the account's posts (Facebook, Instagram, Threads, YouTube, Bluesky, Mastodon and LinkedIn), mentions (Facebook, Instagram, Threads, Bluesky and Mastodon), direct messages (Facebook, Instagram, Bluesky and Mastodon) and Google Business Profile reviews. TikTok and X have no inbox. It syncs every 10 minutes per account. An account that lacks a platform permission for a channel shows `RECONNECT_REQUIRED` in `get_inbox_summary`, and a write to it answers 403 `inbox_reconnect_required`: reconnect the account in AdaptlyPost.

| Tool | What it does | Changes data |
| --- | --- | --- |
| `get_inbox_summary` | Unread counts per channel, and per account which channels work, need a reconnect or are unsupported | No |
| `refresh_inbox` | Sync the inbox now instead of waiting for the next 10-minute run | Yes |
| `list_inbox_comments` | Comments on the account's posts, newest first, filtered by account, platform, status, date, text or post | No |
| `get_inbox_comment` | One comment with its parent and the replies under it | No |
| `reply_to_inbox_comment` | Post a public reply to a comment from the account | Yes |
| `hide_inbox_comment` | Hide a comment on the platform | Yes |
| `unhide_inbox_comment` | Show a hidden comment again | Yes |
| `like_inbox_comment` | Like a comment (Facebook, Bluesky, Mastodon, LinkedIn) | Yes |
| `unlike_inbox_comment` | Take back a like | Yes |
| `delete_inbox_comment` | Delete a comment where the platform allows it | Yes |
| `update_inbox_comments_status` | Mark comments unread, read or done in AdaptlyPost | Yes |
| `list_inbox_mentions` | Posts and comments that mention the account | No |
| `reply_to_inbox_mention` | Post a public reply to a mention | Yes |
| `update_inbox_mentions_status` | Mark mentions unread, read or done | Yes |
| `list_inbox_conversations` | Direct message conversations, most recent first | No |
| `get_inbox_conversation` | One conversation with its messages | No |
| `send_inbox_message` | Send a direct message; Facebook and Instagram allow it within 24 hours of the person's last message | Yes |
| `update_inbox_conversations_status` | Mark conversations unread, read or done | Yes |
| `list_inbox_reviews` | Google Business Profile reviews, filtered by rating and whether they have a reply | No |
| `reply_to_inbox_review` | Post or replace the location's reply to a review | Yes |
| `delete_inbox_review_reply` | Delete the location's reply to a review | Yes |
| `update_inbox_reviews_status` | Mark reviews unread, read or done | Yes |

### Webhooks

| Tool | What it does | Changes data |
| --- | --- | --- |
| `list_webhooks` | List webhook endpoints and their delivery state | No |
| `get_webhook` | One webhook endpoint | No |
| `create_webhook` | Register an endpoint for the post, account and image events, or for the events you pick, inbox events included; the signing secret is shown only in this response | Yes |
| `update_webhook` | Change an endpoint's URL or events, or turn it off and on | Yes |
| `delete_webhook` | Delete an endpoint | Yes |
| `test_webhook` | Send a signed `webhook.test` event and see how the endpoint answered | Yes |

### AI captions and images

| Tool | What it does | Changes data |
| --- | --- | --- |
| `generate_caption` | Write a caption from a prompt, kept within a platform's character limit; 2 AI credits | Yes |
| `refine_caption` | Rewrite an existing caption from an instruction, or continue a partial one; 2 AI credits | Yes |
| `generate_image` | Start an image generation and get a `jobId`; 2 credits standard, 4 premium | Yes |
| `get_image_job` | Poll an image job until `completed` (with a public `imageUrl`) or `failed` | No |

## Roles, permissions and safety

- Every call runs under a workspace role: Admin, Editor, Contributor or Viewer. An API key carries the role it was created with and never does more than the member who created it; an OAuth sign-in acts with the member's own role in each workspace.
- Admin does everything. Editor creates, schedules and publishes. Contributor creates and edits its own drafts, uploads media and generates captions and images, but cannot schedule, publish, retry, bulk schedule or delete non-drafts. Viewer only reads. Give an agent that should not post on its own a Contributor key, or sign in as a Contributor.
- An action outside the role answers 403 with `code: permission_denied`. The tool tells the agent to save a draft and ask a workspace member to publish, not to retry or look for another key.
- Read-only tools carry `readOnlyHint`, so clients that ask before a write (Claude, ChatGPT, Hermes) ask before creating, scheduling, publishing or deleting anything.
- `generate_caption`, `refine_caption` and `generate_image` spend AdaptlyPost AI credits on every call: 2 credits per caption, 2 or 4 per image.
- Every role can read the inbox. Replying, messaging, hiding, liking, deleting and marking inbox items need Admin or Editor. Replies and messages reach real people, so the agent shows the text and what it answers before it sends.
- Without an API-capable plan every call answers 403 with `code: subscription_required`. A 429 carries `Retry-After`.

## Workspaces

An OAuth sign-in can reach several workspaces, each with its own data and your own role there. `list_workspaces` returns them, and every other tool takes an optional `workspaceId`, which the server sends as the `X-Workspace-Id` header. Without it a tool works in the workspace `list_workspaces` marks current. A `workspaceId` the sign-in cannot reach answers 403 with `code: workspace_access_denied`. An API key belongs to one workspace.

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

- Post to any of the 14 platforms in one call, with per-platform captions, first comments, threads of replies with images, thumbnails and image shapes
- Check a post before creating it, and get every problem back at once
- Schedule for any future time, or bulk schedule up to 100 posts
- See per-platform results with error details, and retry only the platforms that failed
- Save drafts and publish them later
- Repeat a post daily, weekly, monthly or yearly, then pause, resume or stop the series
- Read analytics: views, likes, comments, followers and engagement per window, per platform and per post
- Look up a LinkedIn company page from its URL and mention it in a LinkedIn post
- Read and answer comments, mentions, direct messages and Google reviews from the inbox, and hide, like or delete comments
- Manage webhooks, including which events each one receives, and client connect links
- Write captions and generate images with AdaptlyPost AI, paid from your AI credits

```
You: Schedule a LinkedIn post for tomorrow at 9am about our new feature launch
Agent: Done. Post scheduled for tomorrow at 9:00 AM on your LinkedIn account.
```

## Run the server yourself

The hosted server is the easy path. A server you run yourself over stdio also has `resolve_linkedin_organization`, which the hosted server gets after its next directory review. To run it yourself with [Bun](https://bun.sh):

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

`bun run src/index.ts --http` in `mcp-server/` serves the same tools over Streamable HTTP on port 3100, the way `https://mcp.adaptlypost.com/mcp` runs. Environment variables and local development are in [`mcp-server/README.md`](./mcp-server/README.md).

## FAQ

**Do I need an API key?**
No. Point your client at `https://mcp.adaptlypost.com/mcp` and sign in with the email you use on AdaptlyPost. Keys are for headless agents and clients without OAuth.

**Will the agent post without asking me?**
Every tool that creates, schedules, publishes or deletes is marked as a write, so clients that confirm writes ask first. For a hard limit, use a Contributor role: it can only save drafts.

**Which platforms can I post to?**
Instagram, TikTok, YouTube, X (Twitter), LinkedIn, Facebook, Pinterest, Threads, Bluesky, Mastodon, Google Business Profile, Tumblr, Telegram and WordPress.

**Can it answer comments and messages?**
Yes. The inbox tools read and answer comments on Facebook, Instagram, Threads, YouTube, Bluesky, Mastodon and LinkedIn, mentions on Facebook, Instagram, Threads, Bluesky and Mastodon, direct messages on Facebook, Instagram, Bluesky and Mastodon, and Google Business Profile reviews. They can also hide, like and delete comments where the platform allows it. Webhooks can send `comment.created`, `comment.replied`, `mention.created`, `message.received` and `review.created` when you list them in `events`.

**Why does a channel say `RECONNECT_REQUIRED`?**
The account was connected before AdaptlyPost asked for that permission, its token expired, or the platform has not approved the permission yet (Messenger and Instagram direct messages and Threads mentions depend on Meta's review). Reconnect the account in AdaptlyPost; retrying the call will not help.

**Can it upload my own photos and videos?**
Yes. `upload_media` takes public URLs, base64 or ChatGPT attachments; `open_upload_widget` shows an upload box in ChatGPT and Claude, or gives an upload link where a box can't show.

**What's the difference between this repo and adaptlypost/claude-plugin?**
The plugin is the Claude Code and Hermes package: OAuth only, with a skill that drives these MCP tools. This repo has the server's source, the API-key skill for `npx skills add` and the Gemini extension.

## Links

- [AdaptlyPost](https://adaptlypost.com)
- [AI agents](https://adaptlypost.com/features/agents)
- [API tokens](https://adaptlypost.com/api-tokens)
- [Claude Code and Hermes plugin](https://github.com/adaptlypost/claude-plugin)
- Privacy policy: [adaptlypost.com/privacy](https://adaptlypost.com/privacy)

## License

MIT
