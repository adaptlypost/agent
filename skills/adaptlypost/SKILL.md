---
name: adaptlypost
description: >
  Create, schedule, and manage social media posts across Instagram, TikTok, YouTube, X, LinkedIn,
  Facebook, Pinterest, Threads, and Bluesky via the AdaptlyPost API. Covers post creation,
  scheduling, bulk scheduling, per-platform results, retry logic, and draft/publish workflows.
last-updated: 2026-09-07
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
| `./scripts/adaptlypost.js setup --key <key>` | Store the API key (`--local` for this project only). The user runs this, not the agent |
| `./scripts/adaptlypost.js accounts` | List connected accounts with their ids. Run first: every post command takes these ids, never usernames |
| `./scripts/adaptlypost.js post --caption "..." --accounts id1,id2 --platforms LINKEDIN,TWITTER` | Publish now, irreversibly. Always pass `--platforms`; without it the CLI assumes LINKEDIN, TWITTER, INSTAGRAM. Optional: `--media-urls`, `--type`, `--timezone`, `--tiktok-privacy`, `--platform-text` |
| `./scripts/adaptlypost.js post --caption "..." --accounts id1 --platforms X --schedule "2026-03-15T09:00:00Z"` | Schedule for a future instant. A past time publishes immediately |
| `./scripts/adaptlypost.js post --caption "..." --accounts id1 --platforms X --draft` | Save as DRAFT for review; nothing is published until `posts:publish` |
| `./scripts/adaptlypost.js posts [--status A,B] [--platform X,Y] [--limit n] [--offset n]` | List posts in the workspace, any status, newest first. Use it to find ids and see what is already queued |
| `./scripts/adaptlypost.js posts:get --id <id>` | One post's full record with per-platform status and errors. Ids outside the workspace return 404 |
| `./scripts/adaptlypost.js posts:update --id <id> --caption "new text" [--schedule ...] [--timezone ...]` | Partial update of a DRAFT or SCHEDULED post; omitted fields keep their values. Any other status fails |
| `./scripts/adaptlypost.js posts:delete --id <id>` | Remove the record; cancels a DRAFT or SCHEDULED post. Never unpublishes content already live |
| `./scripts/adaptlypost.js posts:publish --id <id> [--schedule ...] [--timezone ...]` | Push a DRAFT (or SCHEDULED) post live now, or reschedule it. Irreversible once queued |
| `./scripts/adaptlypost.js results --id <id>` | Per-platform outcomes for one post and the source of `platformId` for retry. Poll while rows are PENDING or PUBLISHING |
| `./scripts/adaptlypost.js posts:retry --id <id> --platforms pid1,pid2` | Re-queue FAILED platforms by `platformId` (not platform names), after fixing the cause |
| `./scripts/adaptlypost.js posts:bulk --file posts.json` | Schedule up to 100 posts, each processed independently. Read every result row |

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

**Important**: TikTok requires `tiktokConfigs` with `privacyLevel` for each connection. Options: `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY`. Pinterest requires `pinterestConfigs` with `boardId`; there is no endpoint to list boards, so ask the user. Only one account per platform is allowed per post.

Omit `scheduledAt` to publish now (a past value does the same); a future value schedules; `saveAsDraft: true` stores a DRAFT and defers validation to publish. `timezone` is stored for display and does not shift `scheduledAt`.

Returns: `{ postId, queuedPlatforms, skippedPlatforms, isScheduled, scheduledAt }`. `queuedPlatforms` confirms queueing, not delivery: publishing runs asynchronously per platform, so check `results` for the outcome.

### List Posts

```
GET /api/v1/social-posts?limit=20&offset=0&statuses=SCHEDULED&statuses=DRAFT&platforms=LINKEDIN&platforms=TWITTER&sortOrder=NEWEST&startDate=2026-03-01&endDate=2026-03-31
```

Params: `limit` (1-100, default 20), `offset`, `statuses` (COMPLETED/DRAFT/FAILED/PARTIAL_FAILURE/PENDING/PUBLISHING/SCHEDULED), `platforms`, `sortOrder` (NEWEST, the default, or OLDEST), `startDate`, `endDate`. Repeat the `statuses` and `platforms` keys for multiple values (e.g. `platforms=LINKEDIN&platforms=TWITTER`). `startDate`/`endDate` bound `scheduledAt`, or `createdAt` for posts that were never scheduled.

Returns `{ posts, total, hasMore }` for every post in the workspace; page with `offset` while `hasMore` is true. Use this to find ids; use Get Post for one record and Post Results for one post's per-platform outcome.

### Get Post

```
GET /api/v1/social-posts/<id>
```

Returns the full post record with a `platforms` array carrying each target's status and `errorMessage`. Ids outside the workspace return 404 `Post not found or access denied`. Use Post Results instead when you only need outcomes and `platformId`s for a retry.

### Update Post

```
PATCH /api/v1/social-posts/<id>
Body: { "text": "updated caption", "scheduledAt": "..." }
```

Only works on DRAFT or SCHEDULED posts; any other status returns 400 `Cannot edit post in current state`. Updates are partial: `text`, `contentType`, `scheduledAt`, `timezone`, and thumbnail fields you omit keep their values. `platforms` is the exception: sending it rebuilds the post's targets from that request alone, so resend every `*ConnectionIds` array and platform config you want to keep. `mediaUrls` only take effect together with `platforms`. Returns the updated post.

### Delete Post

```
DELETE /api/v1/social-posts/<id>
```

Removes the record; a deleted SCHEDULED post will not publish. It never removes content already on a network, so deleting a COMPLETED post only drops AdaptlyPost's record. Prefer Update Post over delete-and-recreate. Returns `{ deleted: true }`.

### Publish Draft

```
POST /api/v1/social-posts/<id>/publish
Body: { "timezone": "UTC", "scheduledAt": "2026-03-15T09:00:00Z" }
```

Accepts a DRAFT (or a SCHEDULED post, to reschedule or push live); any other status returns 400 `Post is not a draft`. Omit `scheduledAt` (or pass a past time) and the post moves to PENDING with a publishing job queued per platform, which cannot be recalled. A future `scheduledAt` sets SCHEDULED and queues nothing yet. Fails if an account on the draft was disconnected or a TikTok entry lacks `privacyLevel`; fix with Update Post first. Returns `{ postId, queuedPlatforms, isScheduled, scheduledAt }`; check Post Results afterwards.

### Post Results

```
GET /api/v1/social-posts/<id>/results
```

Returns `{ postId, status, results: [{ platformId, platform, accountName, status, platformPostId, errorMessage, publishedAt }] }`. Each platform reports on its own (PENDING, PUBLISHING, PUBLISHED, or FAILED), so read every row and poll until none are PENDING or PUBLISHING. Take `platformId` from FAILED rows for a retry.

### Retry Failed Platforms

```
POST /api/v1/social-posts/<id>/retry
Body: { "platformIds": ["platform_id_1", "platform_id_2"] }
```

Get `platformId` values (not platform names) from the results endpoint. Only rows with status FAILED are reset and re-queued with the same content; other ids are ignored, and if none qualify the API returns 400 `No failed platforms to retry`. The retry is asynchronous, so check results again afterwards. Retry only after the cause is fixed; a platform restriction will just fail again.

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

Max 100 posts per bulk request. Every item shares `platforms`, `timezone`, the connection-id arrays, and platform configs; each item brings its own `text`, `contentType`, `scheduledAt`, and media. Items are processed independently, so one bad item fails alone. Returns `{ totalScheduled, totalFailed, results: [{ postId, success, isScheduled, scheduledAt, errorMessage }] }` in input order; read every row. A past `scheduledAt` publishes that item immediately. There is no draft mode; use Create Post for a draft.

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
| `list_accounts` | List connected accounts with ids and platforms. Call first; posts take these ids, never usernames |
| `upload_media` | Upload media (URLs or base64, combinable) and get `mediaUrls` for a post. Prefer over `get_upload_urls` |
| `get_upload_urls` | Mint presigned upload URLs only; you must PUT the file yourself before using `publicUrl` |
| `create_post` | Create one post: publish now, schedule, or draft. Async per platform; check `list_post_results` |
| `list_posts` | List posts in the workspace with filters and pagination; find ids and see what is queued |
| `get_post` | One post's full record with per-platform status; 404 outside the workspace |
| `update_post` | Partial update of a DRAFT or SCHEDULED post; sending `platforms` rebuilds all targets |
| `delete_post` | Remove a post record; cancels a DRAFT or SCHEDULED post, never unpublishes live content |
| `publish_draft` | Push a DRAFT (or SCHEDULED) post live now or reschedule it; irreversible once queued |
| `list_post_results` | Per-platform outcomes for one post; source of `platformId` for retry |
| `retry_failed_platforms` | Re-queue only FAILED platforms by `platformId`, after fixing the cause |
| `bulk_schedule_posts` | Schedule up to 100 posts, each processed independently; no draft mode |

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
- Check `results` after posting to see per-platform success/failure. `post`, `posts:publish`, and `posts:retry` only confirm queueing; the outcome arrives asynchronously
- `posts:update` changes caption, schedule, and timezone only. To change accounts or media, call `PATCH` directly with `platforms`, the connection-id arrays, and `mediaUrls` together
- Pinterest needs `pinterestConfigs` with `boardId`, which the CLI does not set; use the API body directly for Pinterest posts
- Use `platformTexts` for per-platform caption overrides (e.g. shorter text for X)
- Use `--draft` flag when testing to avoid accidental publishing
