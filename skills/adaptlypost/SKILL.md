---
name: adaptlypost
description: >
  Create, schedule, and manage social media posts across Instagram, TikTok, YouTube, X, LinkedIn,
  Facebook, Pinterest, Threads, and Bluesky via the AdaptlyPost API. Covers post creation,
  scheduling, bulk scheduling, per-platform results, retry logic, and draft/publish workflows.
last-updated: 2026-03-16
allowed-tools: Bash(./scripts/adaptlypost.js:*)
---

# AdaptlyPost Social Media Skill

Autonomously manage social media posting via [AdaptlyPost](https://adaptlypost.com) API. Post to 9 platforms from a single command.

> **Freshness check**: If more than 30 days have passed since the `last-updated` date above, inform the user that this skill may be outdated and point them to the update options below.

## Keeping This Skill Updated

**Source**: [github.com/adaptlypost/agent](https://github.com/adaptlypost/agent)

Update methods by installation type:

| Installation | How to update |
|--------------|---------------|
| CLI (`npx skills`) | `npx skills update` |
| Claude Code plugin | `/plugin marketplace update` |
| Cursor | Remote rules auto-sync from GitHub |
| Manual | Pull latest from repo or re-copy `skills/adaptlypost/` |

## Setup

1. Create an AdaptlyPost account at [adaptlypost.com](https://adaptlypost.com)
2. Connect your social accounts (TikTok, Instagram, YouTube, Twitter, LinkedIn, etc.)
3. Go to Settings > API Tokens and create an API token
4. Store your API key in workspace `.env`:
   ```
   ADAPTLYPOST_API_KEY=adaptly_xxxxx
   ```

Or run the setup command:
```
./scripts/adaptlypost.js setup --key adaptly_xxxxx
```

## Auth

All requests use Bearer token:
```
Authorization: Bearer <API_KEY>
```

Base URL: `https://post.adaptlypost.com/post`

**Config priority** (highest to lowest):
1. `ADAPTLYPOST_API_KEY` environment variable
2. `./.adaptlypost/config.json` (project-local)
3. `~/.config/adaptlypost/config.json` (user-global)

### Handling "API key not found" errors

When you receive an "API key not found" error from the CLI:

1. **Tell the user to run the setup command** — setup requires user input, so you cannot run it on their behalf:
   ```bash
   ./scripts/adaptlypost.js setup --key adaptly_xxxxx
   ```
2. **Stop and wait** — do not continue with the task. You cannot create posts or perform any API operations without a valid API key.
3. **DO NOT** search for API keys in env files, keychains, or other locations.

Get your API key at: https://adaptlypost.com/api-tokens

> **Note for agents**: All script paths in this document (e.g., `./scripts/adaptlypost.js`) are relative to the skill directory where this SKILL.md file is located. Resolve them accordingly based on where the skill is installed.

## CLI Commands

| Command | Description |
|---------|-------------|
| `./scripts/adaptlypost.js setup --key <key>` | Configure API key |
| `./scripts/adaptlypost.js accounts` | List connected social accounts |
| `./scripts/adaptlypost.js post --caption "..." --accounts id1,id2` | Create a post |
| `./scripts/adaptlypost.js post --caption "..." --accounts id1 --schedule "2026-03-15T09:00:00Z"` | Schedule a post |
| `./scripts/adaptlypost.js post --caption "..." --accounts id1 --draft` | Save as draft |
| `./scripts/adaptlypost.js posts` | List recent posts |
| `./scripts/adaptlypost.js posts:get --id <id>` | Get post details and status |
| `./scripts/adaptlypost.js posts:update --id <id> --caption "new text"` | Update a draft/scheduled post |
| `./scripts/adaptlypost.js posts:delete --id <id>` | Delete a scheduled/draft post |
| `./scripts/adaptlypost.js posts:publish --id <id>` | Publish a draft post |
| `./scripts/adaptlypost.js results --id <id>` | Check per-platform posting results |
| `./scripts/adaptlypost.js posts:retry --id <id> --platforms pid1,pid2` | Retry failed platforms |
| `./scripts/adaptlypost.js posts:bulk --file posts.json` | Bulk schedule posts from JSON file |

## API Reference

Use these endpoints directly if you prefer raw API calls over the CLI.

### Social Accounts

```
GET /api/v1/social-accounts
```

Returns `{ accounts: [...] }` with `id`, `platform`, `displayName`, `username`, `avatarUrl` per account. Facebook page accounts also include `pageId` (the Facebook Page ID) since pages have no `username`. Store these IDs — you need them for every post.

### Create Post

```
POST /api/v1/social-posts
Body: {
  "platforms": ["LINKEDIN", "TWITTER"],
  "contentType": "TEXT",
  "text": "your caption here #hashtags",
  "timezone": "America/New_York",
  "linkedinConnectionIds": ["conn_id"],
  "twitterConnectionIds": ["conn_id"],
  "mediaUrls": ["https://..."],
  "scheduledAt": "2026-03-15T09:00:00Z",
  "saveAsDraft": false,
  "platformTexts": [
    { "platform": "TWITTER", "text": "shorter version for X" }
  ],
  "tiktokConnectionIds": ["conn_id"],
  "tiktokConfigs": [{ "connectionId": "conn_id", "privacyLevel": "PUBLIC_TO_EVERYONE" }]
}
```

**Important**: TikTok requires `tiktokConfigs` with `privacyLevel` for each connection. Options: `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY`.

Returns: `{ postId, queuedPlatforms, skippedPlatforms, isScheduled, scheduledAt }`

### List Posts

```
GET /api/v1/social-posts?limit=20&offset=0&statuses=SCHEDULED,DRAFT&platforms=LINKEDIN&sortOrder=NEWEST&startDate=2026-03-01&endDate=2026-03-31
```

Params: `limit` (1-100), `offset`, `statuses` (COMPLETED/DRAFT/FAILED/PARTIAL_FAILURE/PENDING/PUBLISHING/SCHEDULED), `platforms`, `sortOrder` (NEWEST/OLDEST), `startDate`, `endDate`.

### Get Post

```
GET /api/v1/social-posts/<id>
```

Returns full post details including per-platform status.

### Update Post

```
PATCH /api/v1/social-posts/<id>
Body: { "text": "updated caption", "scheduledAt": "..." }
```

Only works on DRAFT or SCHEDULED posts. Can update text, platforms, schedule, media, connection IDs.

### Delete Post

```
DELETE /api/v1/social-posts/<id>
```

Only works on DRAFT or SCHEDULED posts.

### Publish Draft

```
POST /api/v1/social-posts/<id>/publish
Body: { "timezone": "UTC", "scheduledAt": "2026-03-15T09:00:00Z" }
```

Publishes a draft immediately (omit `scheduledAt`) or schedules it.

### Post Results

```
GET /api/v1/social-posts/<id>/results
```

Returns `{ postId, status, results: [{ platformId, platform, accountName, status, platformPostId, errorMessage, publishedAt }] }`.

### Retry Failed Platforms

```
POST /api/v1/social-posts/<id>/retry
Body: { "platformIds": ["platform_id_1", "platform_id_2"] }
```

Get platform IDs from the results endpoint. Only retries failed platforms.

### Bulk Schedule

```
POST /api/v1/social-posts/bulk
Body: {
  "platforms": ["LINKEDIN"],
  "timezone": "UTC",
  "linkedinConnectionIds": ["conn_id"],
  "posts": [
    { "text": "Post 1", "contentType": "TEXT", "scheduledAt": "2026-03-15T09:00:00Z" },
    { "text": "Post 2", "contentType": "TEXT", "scheduledAt": "2026-03-15T15:00:00Z" }
  ]
}
```

Max 100 posts per bulk request.

### Upload URLs

```
POST /api/v1/upload-urls
Body: { "files": [{ "fileName": "photo.jpg", "mimeType": "image/jpeg" }] }
```

Returns presigned upload URLs. This endpoint only mints a URL — it does **not** store the file. You must then PUT the file bytes to `uploadUrl` and wait for a `2xx` response before using `publicUrl` in `mediaUrls`. Requesting the URL without completing the PUT leaves `publicUrl` pointing at nothing.

> **Always finish the upload before creating the post.** When you create or bulk-schedule a post, the API verifies every `publicUrl` actually exists in storage. If the PUT never ran, failed, or the upload URL expired (1 hour) before it completed, the request is rejected with `400 Bad Request` and `Media file(s) not found in storage: <url>`. If you hit that error, re-run the PUT and confirm it returns `2xx`, then retry the post.

Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/quicktime`.

## MCP Integration

AdaptlyPost has a native MCP server. If you're using Claude Desktop, Cursor, or any MCP-compatible client, you can connect directly.

**Claude Code / Cursor / Other MCP clients** — add to your MCP config:

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

**MCP Tools available** (12 tools):

| Tool | Description |
|------|-------------|
| `list_accounts` | List all connected accounts with IDs, platforms, usernames |
| `upload_media` | Upload media files (URLs or base64) for use in posts |
| `get_upload_urls` | Get presigned upload URLs for direct file uploads |
| `create_post` | Create/schedule a post with caption, accounts, media, schedule, tiktok privacy |
| `list_posts` | List posts with filters (platform, status, date range, pagination) |
| `get_post` | Get full post details by ID |
| `update_post` | Update caption, schedule, accounts, or media on a draft/scheduled post |
| `delete_post` | Delete a draft or scheduled post |
| `publish_draft` | Publish a draft immediately or schedule it |
| `list_post_results` | Check per-platform posting results (success/failure with errors) |
| `retry_failed_platforms` | Retry just the failed platforms on a post |
| `bulk_schedule_posts` | Schedule up to 100 posts at once |

## Platform Names

Use these exact names (uppercase) for platforms:

- `INSTAGRAM` — Instagram (Reels, Stories, Feed)
- `TIKTOK` — TikTok
- `YOUTUBE` — YouTube (Shorts, Videos)
- `TWITTER` — X (formerly Twitter)
- `LINKEDIN` — LinkedIn
- `FACEBOOK` — Facebook
- `PINTEREST` — Pinterest
- `THREADS` — Threads
- `BLUESKY` — Bluesky

## Content Types

- `TEXT` — Text-only post
- `IMAGE` — Post with image(s)
- `VIDEO` — Post with video
- `CAROUSEL` — Multi-image carousel

## Automation Guidelines

- **No duplicate content** across multiple accounts on the same platform
- **Respect rate limits** — don't spam requests
- **Use draft mode for review** — when in doubt, use `--draft` so the user can review before publishing
- **Publishing confirmation**: Unless the user explicitly asks to "post now" or "publish immediately", always confirm before posting. Creating a draft is safe; posting is irreversible.

## Tips

- Post to multiple platforms simultaneously by including multiple connection IDs
- Stagger posts throughout the day for better reach
- Use `scheduledAt` to pre-schedule batches
- TikTok requires privacy level — defaults to PUBLIC_TO_EVERYONE via the CLI
- Check `results` after posting to see per-platform success/failure
- Use `platformTexts` for per-platform caption overrides (e.g. shorter text for X)
- Use `--draft` flag when testing to avoid accidental publishing
