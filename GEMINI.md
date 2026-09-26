# AdaptlyPost

AdaptlyPost is social posts across LinkedIn, X, Instagram, Facebook, TikTok, YouTube, Pinterest, Threads, Bluesky, Mastodon and Google Business Profile. This extension connects Gemini CLI to a AdaptlyPost workspace
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

## Notes

- Every tool acts on the workspace the signed-in account belongs to, with that account's
  own workspace role: Admin, Editor, Contributor or Viewer. A Contributor can draft and
  upload media but cannot schedule or publish; a Viewer only reads.
- A 403 with `code: permission_denied` is final. Do not retry it and do not look for
  another key. For scheduling or publishing, save the post as a draft
  (`saveAsDraft: true`) and tell the user a workspace member has to publish it.
- Ask before anything that writes. Deletes cannot be undone.
- Read the tool descriptions for the filters each one accepts rather than guessing
  parameter names.

https://adaptlypost.com
