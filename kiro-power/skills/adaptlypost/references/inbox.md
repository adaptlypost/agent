# Working the inbox

Pass the same `workspaceId` you use for posts when the user has several workspaces.

## What is in it

| Channel | Platforms | Tools |
|---------|-----------|-------|
| Comments on the account's posts | Facebook, Instagram, Threads, YouTube, Bluesky, Mastodon, LinkedIn | `list_inbox_comments`, `get_inbox_comment`, `reply_to_inbox_comment`, `hide_inbox_comment`, `unhide_inbox_comment`, `like_inbox_comment`, `unlike_inbox_comment`, `delete_inbox_comment`, `update_inbox_comments_status` |
| Mentions | Facebook, Instagram, Threads, Bluesky, Mastodon | `list_inbox_mentions`, `reply_to_inbox_mention`, `update_inbox_mentions_status` |
| Direct messages | Facebook (Messenger), Instagram, Bluesky, Mastodon | `list_inbox_conversations`, `get_inbox_conversation`, `send_inbox_message`, `update_inbox_conversations_status` |
| Reviews | Google Business Profile | `list_inbox_reviews`, `reply_to_inbox_review`, `delete_inbox_review_reply`, `update_inbox_reviews_status` |

TikTok and X have no inbox. The inbox syncs every 10 minutes per account; `refresh_inbox` asks for a sync
now, and new items show up a minute or so later. Do not poll it in a loop.

## Start here

1. `get_inbox_summary` gives the unread counts and, per account, whether each channel is `AVAILABLE`,
   `RECONNECT_REQUIRED` or `UNSUPPORTED`.
2. `RECONNECT_REQUIRED` means the account lacks the platform permission for that channel or its token
   expired. Some channels (Messenger and Instagram direct messages, Threads mentions) depend on
   permissions the platform is still reviewing. Tell the user to reconnect the account in AdaptlyPost;
   that channel stays empty until they do.
3. List the channel the user asked about, usually with `statuses: ["UNREAD"]`. Every list is newest first
   and takes `accountIds`, `platforms`, `statuses`, `since`, `search`, `limit` (up to 100) and `cursor`.
   Page with `cursor` set to the last `nextCursor` while `hasMore` is true. Comments also filter by
   `postId` (an AdaptlyPost post id) or `platformPostId`; reviews by `ratings` and `replied`.

## Answering

- Read before you write. `get_inbox_comment` returns the comment with its parent and replies;
  `get_inbox_conversation` returns the messages. Check `replied` so you do not answer twice.
- Show the user the exact text, the account it goes out from and the item it answers (author and a quote),
  and wait for a yes. A "yes" covers that one reply. For a batch, show every reply in a table and get one
  explicit yes for the table.
- Never send replies or messages from a scheduled task or any run with nobody to confirm. Draft them for
  the user instead.
- Each reply or message call sends a new one. After an error or a timeout, read the item again before
  trying once more.
- Limits: comment and mention replies follow the platform's comment limit (LinkedIn 1,250 characters,
  Threads 500, Bluesky 300, Mastodon 500, YouTube 10,000, Facebook 8,000, Instagram 2,200). A message is
  up to the conversation's `maxMessageLength`. A review reply is up to 4,096 bytes and replaces the one
  reply Google keeps per review, so show the old reply when there is one.
- Facebook and Instagram take a direct message only within 24 hours of the person's last message
  (`replyWindowEndsAt`). After that the call answers `inbox_messaging_window_closed`; tell the user.

## Moderating

Check the comment's `capabilities` first.

| Platform | Delete | Like |
|----------|--------|------|
| Facebook | Any comment on the Page's posts | Yes |
| Instagram | Any comment on the account's media | No |
| YouTube | The channel's own comments only | No |
| Threads | The account's own replies only | No |
| Bluesky | The account's own replies only | Yes |
| Mastodon | The account's own replies only | Yes (a favourite) |
| LinkedIn | Any comment on the organization's posts | Yes |

Hiding works where `canHide` is true and `unhide_inbox_comment` reverses it. Deleting a comment or a
review reply cannot be undone. Confirm hides and deletes with the user, quoting the item.

`update_inbox_*_status` marks items `UNREAD`, `READ` or `DONE` in AdaptlyPost only. Nothing reaches the
platform, so it needs no confirmation, but only mark what the user asked for.

## Refusals

| `code` | Status | What to do |
|--------|--------|------------|
| `inbox_item_not_found` | 404 | The id is unknown in this workspace. Stop |
| `inbox_action_unsupported` | 400 | The platform or this item does not allow it. Stop |
| `inbox_reconnect_required` | 403 | Tell the user to reconnect the account in AdaptlyPost. Do not retry |
| `inbox_reply_invalid` | 400 | The text is empty or too long; the message names the limit. Fix the text |
| `inbox_messaging_window_closed` | 400 | The 24-hour window passed. Stop and tell the user |
| `inbox_rate_limited` | 429 | Wait a while before trying again |
| `inbox_platform_error` | 503 | The platform failed. Try again later |

Every role can read the inbox. Replying, messaging, hiding, liking, deleting and marking need Admin or
Editor; a `permission_denied` there is final.

## Webhooks

To hear about new items without polling, a webhook can list `comment.created`, `comment.replied`,
`mention.created`, `message.received` and `review.created` in `events`. They fire after the inbox sync
finds the item, so within about 10 minutes, and the first sync of an account fires none for its history.
