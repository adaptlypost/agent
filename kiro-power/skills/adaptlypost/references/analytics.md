# Reading analytics

Pass the same `workspaceId` you use for posts when the user has several workspaces.

## Which tool

| Question | Tool |
|----------|------|
| How did we do this month? Follower count? | `get_analytics_overview` |
| Is it going up or down? When did it jump? | `get_analytics_timeseries` (`granularity` `DAILY`, `WEEKLY` or `MONTHLY`) |
| Which network works best? | `get_platform_breakdown` |
| Top posts | `list_top_posts` (`sortBy`, default `VIEWS`; `limit` up to 50) |
| How one post did, or every post in a window | `list_post_analytics` |
| What an account posted outside AdaptlyPost | `list_discovered_posts` |
| Numbers look stale or empty | `get_analytics_sync_status` |
| The user just published and wants numbers | `trigger_analytics_sync`, then poll `get_analytics_sync_status` |

Every window tool takes `from` and `to` (ISO 8601, `to` not earlier than `from`).
`get_analytics_overview`, `get_analytics_timeseries`, `list_post_analytics`, `list_top_posts` and
`list_discovered_posts` also take a `platforms` filter, and every window tool takes `connectionIds` to
narrow it to some accounts. `list_post_analytics` sorts by `VIEWS`, `LIKES`, `COMMENTS`, `SHARES`, `SAVES`, `CLICKS`,
`IMPRESSIONS`, `ENGAGEMENT_RATE` or `PUBLISHED_AT` (the default) and pages with `page` and `limit`.

## Rules that change the answer

- **Window.** `from` and `to` select posts published inside the window. The comparison is the window of the
  same length just before it. Say which dates you used.
- **Coverage.** Connecting an account imports its posts from the 180 days before, and analytics are kept
  from then on while it stays connected. Dates before `historyHorizonAt` have no data, which is not the
  same as zero activity. A post's numbers refresh for 180 days after it is published, then hold.
- **Freshness.** Metrics refresh every few hours; `lastSyncedAt` says when. `trigger_analytics_sync` is
  allowed once per workspace every 15 minutes, and skips a YouTube channel read in the last 12 hours.
  Inside the cooldown it returns `queued: false` with `cooldownSecondsRemaining`; do not retry in a loop. Poll `get_analytics_sync_status` until
  `syncInProgress` is false, then read the metrics again.
- **Networks.** Facebook, Instagram, Threads, TikTok, Pinterest, Bluesky, YouTube, X, LinkedIn and Google
  Business Profile report analytics; Google Business Profile reports only how often each location was seen,
  with no per-post numbers. Mastodon, Telegram, Tumblr and WordPress report nothing. A network missing from
  `get_platform_breakdown` has no data for the window.
- **Partial metrics.** `partialMetrics` names metrics some selected network cannot report, and a metric no
  selected network reports is `null`. Compare networks only on metrics both list in `supportedMetrics`.
- **Account-wide activity.** `accountActivityConnectionIds` in the overview and in each breakdown row lists
  accounts, such as LinkedIn personal profiles and Google Business locations, counted by their account-wide
  activity on each day of the window instead of the posts published in it. They have no rows in
  `list_post_analytics`, so say so when the user asks for their top posts.
- **Reconnect.** When `needsAnalyticsReconnect` is true for an account, it was connected before analytics
  permissions existed and returns nothing until the user reconnects it in AdaptlyPost. Tell them once; do
  not keep querying.
- **Discovered posts.** `list_post_analytics` also lists posts made outside AdaptlyPost on the connected
  accounts. Those have `postId: null`. Posts made through AdaptlyPost carry the `postId` that `get_post`
  takes.
- **Permissions.** Contributors and Viewers can read analytics. `trigger_analytics_sync` needs Editor or
  Admin; a `permission_denied` there is final, so report the numbers as of `lastSyncedAt`.

## Reporting

Lead with the number that changed most and what probably caused it, using `list_post_analytics` to name the
posts behind a spike. Give both values and the direction for anything that moved more than 10%. Skip flat
metrics.
