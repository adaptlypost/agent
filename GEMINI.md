# AdaptlyPost

AdaptlyPost schedules and publishes social posts across Instagram, TikTok, YouTube, X, LinkedIn, Facebook, Pinterest, Threads, Bluesky, Mastodon, Google Business Profile, Tumblr, Telegram and WordPress. This extension connects Gemini CLI to an AdaptlyPost workspace
over MCP.

## Signing in

The server is at `https://mcp.adaptlypost.com/mcp`. It answers an unauthenticated call with a 401 and
points at its OAuth metadata, so Gemini CLI opens a browser the first time a tool
runs. Sign in with the AdaptlyPost account that owns the workspace. Nothing needs to be
configured by hand, and no API token is stored in this extension.

## What to ask for

- "list the accounts I have connected"
- "draft a post for LinkedIn and X about our new release, schedule it for tomorrow 09:00"
- "how did last month compare to the one before on engagement?"
- "show the unread comments and messages in my inbox"

## Notes

- A sign-in can reach several workspaces. `list_workspaces` lists them, and every other tool
  takes an optional `workspaceId`. In each workspace a tool acts with the account's own role
  there: Admin, Editor, Contributor or Viewer. A Contributor can draft and
  upload media but cannot schedule or publish; a Viewer only reads.
- A 403 with `code: permission_denied` is final. Do not retry it and do not look for
  another key. For scheduling or publishing, save the post as a draft
  (`saveAsDraft: true`, keeping `scheduledAt` as its planned date) and tell the user a
  workspace member has to publish it. `publish_draft` without a date schedules such a
  draft for its planned date when that is still in the future.
- Ask before anything that writes. Deletes cannot be undone.
- Inbox replies, direct messages and review replies reach real people. Show the exact text and
  the item it answers, and wait for a yes before sending. A 403 with
  `code: inbox_reconnect_required` means the account must be reconnected in AdaptlyPost;
  do not retry it.
- Read the tool descriptions for the filters each one accepts rather than guessing
  parameter names.

https://adaptlypost.com
