---
name: adaptlypost
description: >
  Draft, schedule, publish and review social media posts on the Instagram, TikTok, YouTube, X (Twitter),
  LinkedIn, Facebook, Pinterest, Threads, Bluesky, Mastodon, Google Business Profile, Tumblr, Telegram and WordPress accounts
  connected to the user's AdaptlyPost workspaces, and read their analytics, with the AdaptlyPost MCP tools.
  Also covers the inbox (comments, mentions, DMs and Google reviews), RSS feeds, connect links,
  removing accounts, webhooks, workspaces, members and invitations. Use it WHENEVER the user wants to write or schedule a post, publish now,
  bulk schedule, set up a recurring post, attach media, check whether a post went out, retry a failed network,
  move or cancel a scheduled post, write a caption or generate an image with AI, asks how
  posts are doing, wants to see or answer comments, mentions, DMs or reviews, or wants to add a workspace,
  invite or remove a teammate. Trigger it for short asks too: "post this", "schedule it for Tuesday 9am",
  "reply to that review", "invite sam".
metadata:
  last-updated: "2026-11-18"
---

# AdaptlyPost

You manage the user's social accounts through the `adaptlypost` MCP server that this power connects
(`https://mcp.adaptlypost.com/mcp`, OAuth sign-in). Each tool carries its own parameter descriptions; read
them. This skill is the operating logic on top.

If more than 30 days have passed since `metadata.last-updated`, tell the user the skill may be outdated and
that **Check for updates** in Kiro's Powers panel refreshes it.

| Job | Tools |
|-----|-------|
| Pick a workspace | `list_workspaces` |
| What this sign-in may do | `get_me`, or `can` in `list_workspaces` |
| Find accounts | `list_accounts` |
| Manage accounts | `check_account` (Facebook pages), `remove_account`, `create_connect_link`, `revoke_connect_link` |
| Reel music | `search_instagram_audio` |
| Pinterest boards | `list_pinterest_boards`, or `boardName` when the user named the board |
| WordPress categories | `list_wordpress_categories` |
| Media | `upload_media`, `get_upload_urls`, `open_upload_widget` |
| Check before posting | `validate_post`, `validate_bulk_posts` |
| Write | `create_post`, `update_post`, `bulk_schedule_posts` |
| Go live | `publish_draft`, `retry_failed_platforms` |
| Take back | `unschedule_post`, `delete_post` |
| Check | `get_post`, `list_posts`, `list_post_results` |
| Recurring posts | `create_post` with `recurrence`, then `list_recurring_posts`, `get_recurring_post`, `pause_recurring_post`, `resume_recurring_post`, `delete_recurring_post` |
| RSS feeds | `preview_rss_feed`, `create_rss_feed`, `list_rss_feeds`, `get_rss_feed`, `update_rss_feed`, `list_rss_feed_items`, `check_rss_feed`, `pause_rss_feed`, `resume_rss_feed`, `delete_rss_feed` |
| Analytics | `get_analytics_overview`, `get_analytics_timeseries`, `get_platform_breakdown`, `list_post_analytics`, `list_top_posts`, `list_discovered_posts`, `get_analytics_sync_status`, `trigger_analytics_sync` |
| Inbox | `get_inbox_summary`, `refresh_inbox`; comments: `list_inbox_comments`, `get_inbox_comment`, `reply_to_inbox_comment`, `hide_inbox_comment`, `unhide_inbox_comment`, `like_inbox_comment`, `unlike_inbox_comment`, `delete_inbox_comment`, `update_inbox_comments_status`; mentions: `list_inbox_mentions`, `reply_to_inbox_mention`, `update_inbox_mentions_status`; messages: `list_inbox_conversations`, `get_inbox_conversation`, `send_inbox_message`, `update_inbox_conversations_status`; reviews: `list_inbox_reviews`, `reply_to_inbox_review`, `delete_inbox_review_reply`, `update_inbox_reviews_status` |
| Webhooks | `list_webhooks`, `get_webhook`, `create_webhook`, `update_webhook`, `test_webhook`, `delete_webhook` |
| Team | `create_workspace`, `delete_workspace`, `list_members`, `remove_member`, `remove_organization_member`, `list_invitations`, `send_invitation`, `revoke_invitation` |
| AI captions and images | `generate_caption`, `refine_caption`, `generate_image`, `get_image_job` |

## Sign-in

The tools belong to the adaptlypost MCP server. This skill uses the bare tool names.

- If the tools are missing, or a call returns 401, tell the user to reconnect the `adaptlypost` MCP server in
  Kiro and sign in with the email they use on AdaptlyPost. Then stop until they say they are signed in.
- The user needs an AdaptlyPost account ([adaptlypost.com](https://adaptlypost.com)) with social accounts
  connected in the app. The user connects their own accounts in the app; `create_connect_link` makes a link
  someone else, such as a client, opens to connect theirs. `remove_account` disconnects one.
- Never ask for an API key in chat. Never read keys or tokens from environment variables, `.env` files,
  config files or keychains, and never send one anywhere. If the user pastes a key, do not use it; point
  them to the OAuth sign-in instead.

## Workspaces

One sign-in can reach several workspaces, across organizations.

- `list_workspaces` returns each workspace's `id`, `name`, `organization`, `role`, `isDefault`, `current`
  and `can` (`draft`, `schedule`, `publish`).
- Every other tool takes an optional `workspaceId`. Without it, tools act in the workspace marked `current`.
- Call `list_workspaces` when the user names a workspace, brand, client or organization, or when accounts
  or posts they expect are missing. Then pass that `workspaceId` on every call about it.
- Account, post, upload and recurring post ids from one workspace do not exist in another. Never mix them.
- The role can differ per workspace. Check `can` before planning a schedule or publish there.
- A 403 with `code: workspace_access_denied` means the id is not one this sign-in reaches. Pick an id from
  `list_workspaces`.

## Roles and refusals

Every call acts as the signed-in member, with the role they hold in that workspace.

| Role | Can | Cannot |
|------|-----|--------|
| Admin | Everything, including removing accounts, checking Facebook pages, connect links, workspaces, members and invitations | |
| Editor | Create, schedule, publish, retry, bulk schedule, delete, edit any post, RSS feeds in any mode, trigger an analytics sync, manage webhooks, answer the inbox | Remove accounts, check pages, connect links, manage workspaces, members or invitations |
| Contributor | Create and edit its own drafts, draft-mode RSS feeds, upload media, generate captions and images, read posts, analytics and the inbox | Schedule, publish, retry, bulk schedule, delete non-drafts, trigger an analytics sync, webhooks, touch other members' posts or feeds, reply to or change anything in the inbox |
| Viewer | Read accounts, posts, RSS feeds, webhooks, analytics, members and the inbox | Any write, AI generation |

| Response | Meaning | What to do |
|----------|---------|------------|
| 403 `permission_denied` | The role cannot do this. The body names `requiredPermission` and `role` | Final. Do not retry. For a refused schedule or publish, save with `saveAsDraft: true` (keep `scheduledAt` as the draft's planned date) and tell the user a member with publish rights has to publish it. Otherwise relay the body's `message` |
| 401 `token_issuer_lost_access` | The account behind this access is no longer in the workspace | Stop. Tell the user; signing in again through Kiro with a current member fixes it |
| 403 `subscription_required` | The organization's plan does not include API access or has lapsed, and every tool fails the same way. From `create_workspace` or `send_invitation` it can also mean the plan has no room for another workspace or no team seat left; the error names the limit | Tell the user to renew or upgrade the plan. Retrying will not help |
| 401 `oauth_account_not_found` | The user signed in with an email that has no AdaptlyPost account | Relay the message, which names that email. Ask them to reconnect the `adaptlypost` MCP server in Kiro and sign in with the email they use on AdaptlyPost |
| 403 `workspace_access_denied` | Wrong `workspaceId` | Pick one from `list_workspaces` |
| 403 `inbox_reconnect_required` | The account lacks the platform permission for that inbox channel or action, or its token expired | Tell the user to reconnect the account in AdaptlyPost. Do not retry |
| 429 | Too many calls in a short time | Wait the number of seconds the error gives (`Retry-After`) before the next call. Do not loop |

## The core loop

1. **Accounts.** Call `list_accounts` once per workspace per session. Posts take account ids, never
   usernames. The simplest form is `accountIds`, which works out each account's platform. Otherwise
   Facebook pages go in `pageIds` and every other network has its own `<platform>ConnectionIds` array
   (`linkedinConnectionIds`, `tumblrConnectionIds`, `telegramConnectionIds`, `wordpressConnectionIds`, and so on).
   Skip accounts whose `status` is `unauthorized` and tell the user to reconnect them in the app.
2. **Draft.** Keep to each network's length in characters: X 280, Bluesky 300, Threads 500, Mastodon 500,
   Pinterest 500, Google Business Profile 1,500, Instagram 2,200, TikTok 2,200 (4,000 on a photo post), LinkedIn 3,000, Telegram 4,096,
   YouTube 5,000, Facebook 63,206, WordPress 100,000. Use
   `platformTexts` when one network needs a shorter or different version. For anything unusual (several
   networks, media, stories, carousels), call `validate_post` with the same input first: it lists every
   problem per account and creates nothing. Save with `create_post` and `saveAsDraft: true`; a draft is
   safe and gives you a post id. When the user named a time, send it as `scheduledAt` too: the post stays a
   draft, nothing is scheduled, and the time is kept as its planned date.
3. **Show and ask.** Show the whole post: every account, the workspace if there are several, the time with
   its timezone, each network's visibility settings (TikTok privacy, YouTube privacy) and every caption,
   including per-platform text, alt text, first comments, thread replies, Instagram collaborators, tags and Reel audio, any
   story that goes out alongside the post, and a Google Business Profile post's type and button. Wait for "yes". A "yes" covers that one post, not the next.
4. **Go live.** `publish_draft` with a future `scheduledAt` schedules for that time. Without `scheduledAt`,
   a draft whose planned date is still in the future is scheduled for that date, and any other draft
   (undated, or its planned date already past) publishes now. `publishNow: true` publishes now even when
   the draft has a planned date; sending it with `scheduledAt` fails with 400. Tell the user which one will
   happen before you call it. Content published now reaches the networks within moments and cannot be
   recalled.
5. **Verify.** Publishing is asynchronous. Call `list_post_results` and report each network separately
   until no row is PENDING or PUBLISHING. One network can fail while the others succeed. A TikTok row with
   `tiktokDraftFallback: true` went to the TikTok inbox as a draft because of TikTok's daily cap; tell the
   user to finish it in the TikTok app.
6. **Fix failures.** Read each `errorMessage` first. Call `retry_failed_platforms` only after the cause is
   fixed (a reconnected account, replaced media); a platform-side restriction fails again.

If the user already approved a new post word for word, you can call `create_post` directly with
`scheduledAt` (or without it to publish now) instead of drafting first. Unless the user said "post now" or
"publish now", confirm before anything goes live.

## Safety rules

- **Unattended runs save drafts.** From a scheduled task, a headless run or anything else with nobody to
  confirm, use `saveAsDraft: true` unless the user set up that exact recurring workflow in advance.
- **Uploaded media is public at once**, even if no post uses it. Only upload files the user named. Never
  upload hidden files, keys, credentials or `.env` files, and upload a document only when the user asked
  to post that document. See [references/media.md](references/media.md).
- **A file you cannot send yourself** (pasted in the chat, on the user's device, or blocked by a sandbox
  proxy) goes through `open_upload_widget`, never a public repo, gist or file-sharing link. See
  [references/media.md](references/media.md).
- **Confirm deletes and retries** for each post id. A retry republishes immediately.
- **Confirm every inbox reply and message.** Show the exact text, the account it goes out from and the
  comment, mention, message or review it answers, and wait for a yes. Confirm hiding or deleting a comment
  and deleting a review reply the same way. Never send inbox replies from an unattended run. See
  [references/inbox.md](references/inbox.md).
- **Confirm recurring posts like any other.** Show the frequency, the first date and when it ends. A
  recurring post keeps publishing with nobody watching, so confirm before resuming one too.
- **Connect links are secrets.** Create one with `create_connect_link` only when the user asks, give the
  `url` to the user alone, and never paste it into files. Suggest `revoke_connect_link`, or `maxAccounts`
  up front, so it stops working once used. For a developer who shows their own connect buttons, pass
  `returnUrl` (https, or http on localhost) and hand back `startUrls`, one per platform. The client comes
  back to `returnUrl` with `status`, `platform`, one `accountId` per connected account, and on an error
  `error` and `message`.
- **Confirm team changes.** Before `delete_workspace`, `remove_member`, `remove_organization_member` or
  `revoke_invitation`, show what will go (the workspace and what it holds, the member and the workspaces
  they lose, the invited email) and wait for a yes. Confirm the email, workspaces and roles before
  `send_invitation`.
- **Confirm `remove_account`** naming the account. It takes the account off every pending and recurring
  post, and bringing it back means connecting it again.
- **RSS feeds post with nobody watching.** Confirm the feed, the accounts, `postMode` and the text before
  `create_rss_feed`, before switching a feed to `SCHEDULE` or `PUBLISH`, and before `resume_rss_feed`.
  Show `preview_rss_feed` first. `DRAFT` mode is the safe default.
- **Webhook secrets** never reach you. `create_webhook` returns `secretRevealUrl`, a one-time link valid for
  30 minutes. Give it to the user to open in their browser; do not open or fetch it yourself.
- **No duplicate content** across several accounts on the same network, and do not flood the tools with
  repeated calls.

## Network requirements that fail posts

- **TikTok** needs `tiktokConfigs` with `privacyLevel` for every connection (`PUBLIC_TO_EVERYONE`,
  `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY`). Ask the user; do not assume public.
  TikTok cannot be part of a recurring post.
- **Pinterest boards**: when the user named a board, pass that name as `boardName` in `pinterestConfigs`
  and skip the lookup. AdaptlyPost finds it among that Pinterest account's boards (exact match first, then
  case-insensitive) and never falls back to another board: a name that matches no board, or several, fails
  with a 400 that says so (a shared name lists the matching ids). Otherwise call `list_pinterest_boards`
  with the Pinterest account's id, ask the user which board to pin to, and pass its `id` as `boardId`.
  Send `boardId` or `boardName`, never both in one config (400). A board belongs to one Pinterest account,
  so each config's board must be on its `connectionId`. With neither, the pin goes to a public board
  named "AdaptlyPost", created on the account the first time it is needed; leave both out only when the
  user is happy with that board. A 400 from `list_pinterest_boards` usually means the user has to
  reconnect the Pinterest account in the app.
- **Instagram, TikTok and YouTube** need media. Instagram and Facebook take `postType` `FEED`, `REEL` or
  `STORY` in `instagramConfigs` and `facebookConfigs`; `REEL` needs a video and `STORY` an image, video or
  carousel (each item becomes its own story). `shareToStory: true` on a `FEED` or `REEL` post also posts
  the same media as a story; the story is its own row in the results, skips the caption and takes videos up
  to 60 seconds. YouTube takes `postType` `VIDEO` or `SHORTS`, `videoTitle` and `privacyStatus` in
  `youtubeConfigs`. When the video is not in English, set `youtubeConfigs.defaultAudioLanguage` to the
  spoken language as a tag such as `pt-BR` or `es-419`, so YouTube does not treat it as English; `null`
  clears a saved value. It does not turn off YouTube's automatic dubbing.
- **YouTube scheduled on YouTube**: `youtubeConfigs.scheduleOnYouTube: true` uploads the video as soon as
  the post is scheduled, as a private video that YouTube itself makes public at `scheduledAt`. Offer it when
  the user wants to run a Test & Compare (thumbnail or title A/B test) in YouTube Studio before launch.
  `privacyStatus` has to be `public` or left out (else 400 `YOUTUBE_SCHEDULE_REQUIRES_PUBLIC`), and a
  recurring post cannot use it (400 `YOUTUBE_SCHEDULE_NOT_RECURRING`). When `scheduledAt` is under 15
  minutes away the video simply uploads at `scheduledAt`. `get_post` shows `youtubeScheduleOnYouTube` on
  the platform, and `youtubeScheduledVideoId` once the video is on YouTube.
- **Instagram collaborators**: `instagramConfigs.collaborators`, up to 3 usernames, on feed images,
  carousels and reels (not stories or trial reels). Each one has to accept the invite in Instagram.
- **Instagram Reel audio**: find a track with `search_instagram_audio` (leave out `searchQuery` for
  trending), then pass its `audioId` in `instagramConfigs.audio`, with optional `audioVolume` and
  `videoVolume` from 1 to 100. Only video reels, and only accounts with `supportsInstagramAudio: true`
  in `list_accounts` (connected through Facebook). Let the user pick the track; don't choose for them.
- **Instagram user tags**: `instagramConfigs.userTags`, up to 20 public usernames on a single image, a
  single video or a single story (not carousels). On a feed image each tag needs `x` and `y` from 0 to 1.
  A private or unknown account is dropped and listed in `instagramUntaggedUsernames` in `get_post`.
- **AI labels**: `instagramConfigs.aiGenerated` shows Instagram's "AI info" label;
  `youtubeConfigs.aiGenerated` shows YouTube's "Altered or synthetic content" label;
  `tiktokConfigs.aiGenerated` labels TikTok videos; `facebookConfigs.aiGenerated` shows Facebook's "AI info"
  label on every `VIDEO` post, whatever its `postType` (Facebook publishes every video as a reel, and a video
  story carries the label too), and photos, carousels and text posts are refused with 400. Set them when the
  user made the media with AI.
- **Instagram trial reels**: `instagramConfigs.trialGraduation` (`MANUAL` or `SS_PERFORMANCE`) works only for
  a single video posted as a reel or feed video, on an account Instagram has enabled for trial reels.
- **LinkedIn documents** (PDF, PPT, PPTX, DOC, DOCX): `contentType: DOCUMENT`, exactly one file in
  `mediaUrls`, only `LINKEDIN` in `platforms`, optional `linkedinConfigs.documentTitle`. Bulk scheduling
  does not take documents.
- **LinkedIn reshares**: `linkedinConfigs.reshareOf` takes a `urn:li:share:` or `urn:li:ugcPost:` URN (the
  `platformPostId` of an earlier LinkedIn post) or a `linkedin.com/feed/update/<urn>` link, and posts the
  text as commentary on it. `urn:li:activity:` links fail. Not available in bulk.
- **X quote posts**: `twitterConfigs.quoteOf` takes an `x.com/<handle>/status/<id>` link or the post's
  numeric id (the `platformPostId` of an earlier X post) and posts the text as a quote of it. X only lets an
  account quote its own posts or posts that mention it, so a link naming another handle fails. Needs text,
  drops media on that account, and costs the same as any X post. Not available in bulk.
- **Facebook text backgrounds**: `facebookConfigs.textFormatPresetId` (for example `106018623298955`, solid
  purple) on a `TEXT` post with no media and at most 130 characters. If Facebook refuses it, the post goes
  out as plain text.
- **Facebook link carousels**: `facebookConfigs.imageLayout: CAROUSEL` with 2 to 5 images, `postType`
  `FEED` and one `carouselCards` entry (`link`, optional `title` and `description`) per image. Facebook
  shows the card text only for links to a website the Page owns. `GRID` is the plain photo grid.
- **Tumblr** posts go in `tumblrConnectionIds`; `tumblrConfigs` adds up to 30 `tags`, a `title` and a
  `sourceUrl`.
- **WordPress** sites go in `wordpressConnectionIds`. The text becomes the body of a blog post, up to
  100,000 characters: blank lines start paragraphs and bare links become clickable. Up to 20
  images (20 MB each) or one MP4 or MOV video (500 MB); the first image is the featured image and the rest
  follow the text. `wordpressConfigs` sets `title` (without one, the first line of the text cut to 100
  characters), `excerpt`, `categoryIds`, `tags` and `status`. When the user names categories, call
  `list_wordpress_categories` with the site's account id and pass the matching ids; without them WordPress
  uses the site's default category. A tag the site lacks is created when the WordPress user may manage
  tags. `status` decides what the site holds at the post's time: `PUBLISH` (the default) publishes it live,
  `DRAFT` leaves a WordPress draft the user finishes and publishes or schedules in WordPress, and `PENDING`
  submits it for review. Use `DRAFT` when the user wants to edit the post in WordPress first. It is not
  `saveAsDraft`: the post still has to be published or scheduled in AdaptlyPost to reach the site. For
  `DRAFT` and `PENDING` the platform's `postUrl` opens the post in the WordPress editor, and AdaptlyPost
  marks the platform published once WordPress holds it in that status. No first comments, threads or
  analytics.
- **Telegram** channels and groups go in `telegramConnectionIds`. Text up to 4,096 characters, up to 10
  images (10 MB each) or one MP4 or MOV video (50 MB); a caption over 1,024 characters goes out as its
  own message after the media.
- **Google Business Profile** posts go in `googleBusinessConnectionIds`. Text or one JPEG or PNG image up to
  5 MB, no video or carousel. `googleBusinessConfigs` sets `topicType`: `STANDARD` (the default),
  `EVENT` or `OFFER`; events and offers need `eventTitle`, `eventStart` and `eventEnd` as `YYYY-MM-DD` or
  `YYYY-MM-DDTHH:mm` in the business's local time. An optional button is `callToActionType` (`BOOK`,
  `ORDER`, `SHOP`, `LEARN_MORE`, `SIGN_UP`, `CALL`) with `callToActionUrl` for all but `CALL`. Offers can
  add `offerCouponCode`, `offerRedeemUrl` and `offerTerms`.
- **X links**: links in X text are broken on purpose (`example.com` becomes `example. com`) because X
  charges far more for posts with links. `twitterKeepLinks: true` keeps them clickable only on AppSumo
  lifetime deals, for 20 credits instead of 2; any other plan gets a 400. Don't set it unless asked.
- **Carousels** use `contentType: CAROUSEL` with 2 or more media URLs: up to 4 on Bluesky and Mastodon,
  5 on Pinterest, 10 on Instagram, Facebook, Threads and Telegram, 20 on X, LinkedIn and WordPress, 30 on Tumblr and 35 on
  TikTok. Only Instagram
  and Threads mix images and videos. Give a network with a lower limit its own items with
  `platformMedia` (below).
- **Alt text**: `mediaAltTexts` in the same order as `mediaUrls`, one per image. Write it for every image
  unless the user says not to.

## Per-network extras

Each of these is a list with one entry per platform, and works on `create_post`, `update_post` and each
`bulk_schedule_posts` item. On `update_post`, sending the list replaces every entry; leaving it out keeps
the stored ones.

- **First comments** (`firstComments: [{ platform, text, delayMinutes? }]`) go up under the post from the same account
  within about a minute of it publishing (about two minutes on YouTube). LinkedIn (1,250 characters), X (280),
  Threads (500), Bluesky (300), Mastodon (500), YouTube (10,000), Facebook (8,000) and Instagram (2,200) only,
  not on stories or private or made-for-kids YouTube videos. `delayMinutes` (an integer from 0 to 10080, 7 days)
  is how many minutes after the platform publishes to post the comment, and the comment then goes out within
  about a minute of that time. Omitted or 0 means no delay. Once the post is published the delay cannot be
  changed; deleting the post cancels a comment that has not gone out yet. A Facebook Page or Instagram account
  connected before first comments came to them needs one reconnect. A failed comment never fails the post:
  read `firstCommentStatus` and `firstCommentError` in `get_post`, where `firstCommentDelayMinutes` echoes the
  delay and `firstCommentDueAt`, set once the platform publishes, says when a `PENDING` comment is due. It goes
  out within about a minute of that time.
- **Threads of replies** (`threadReplies: [{ platform, texts, mediaUrls? }]`) turn the post into a thread on X,
  Threads, Bluesky and Mastodon, up to 25 replies, each within that network's post length. `mediaUrls` gives
  each reply up to 4 JPEG, PNG, GIF or WEBP images from `upload_media`, one list per reply in `texts` order
  (`[]` for a reply without images); a reply with images may leave its text empty. A network cannot have
  both a thread and a first comment. A failed thread never fails the post: read `threadStatus` and
  `threadError` in `get_post`.
- **Thumbnail per network** (`platformThumbnails: [{ platform, thumbnailUrl?, thumbnailTimestampMs? }]`)
  for video posts. YouTube, Facebook, Instagram, LinkedIn, Pinterest and Telegram take an image or a frame
  (the image wins when both are sent), TikTok only a frame. Networks without an entry use the post's
  `thumbnailUrl` and `thumbnailTimestampMs`, which work on every one of these networks.
- **Image shape** (`platformAspectRatios: [{ platform, aspectRatio, fit? }]`) for image and carousel
  posts on Instagram (`SQUARE`, `PORTRAIT`, `LANDSCAPE`) and TikTok (those plus `VERTICAL`). `fit` is
  `CROP` (default) or `PAD`, which keeps the whole image on a blurred background.
- **Media per network** (`platformMedia: [{ platform, mediaUrls, mediaAltTexts? }]`) gives one network
  different media, for when the post media does not fit it (a video too long for TikTok, a carousel with
  more images than X takes). Networks without an entry use the post `mediaUrls`. `mediaUrls` is required
  and non-empty, public https URLs from upload (no data URIs); `mediaAltTexts` is alt text per item in the
  same order, up to 1,000 characters each, `""` to skip one. The entry must match the post `contentType`:
  one video for `VIDEO`, one image for `IMAGE`, one document for `DOCUMENT`, two or more items for
  `CAROUSEL`; `TEXT` posts take none. Each entry is checked against its own network's limits only, and the
  post `mediaUrls` is no longer checked against that network. An entry for a network the post does not go
  to, a data URI, a second entry for one network and media of another type are refused with 400. A network
  with its own media does not use the post-level `thumbnailUrl` or `thumbnailTimestampMs`; give it its own
  through `platformThumbnails`. On `update_post`, `[]` clears every override, and the list takes effect
  even without `platforms`. `get_post` shows an override as `mediaOverrideUrls` and
  `mediaOverrideAltTexts` on that platform.

LinkedIn text can mention a company page as `@[Page Name](urn:li:organization:<id>)`, with the page name
exactly as LinkedIn shows it.

Platform names are uppercase: `INSTAGRAM`, `TIKTOK`, `YOUTUBE`, `TWITTER` (X), `LINKEDIN`, `FACEBOOK`,
`PINTEREST`, `THREADS`, `BLUESKY`, `MASTODON`, `GOOGLE_BUSINESS`, `TUMBLR`, `TELEGRAM`, `WORDPRESS`. Content types: `TEXT`, `IMAGE`, `VIDEO`, `CAROUSEL`,
`DOCUMENT`.

## Changing the plan

- **Edit** a DRAFT or SCHEDULED post with `update_post`. A post that failed on every platform can be edited
  too and becomes a draft again, ready for `publish_draft`; a post that published anywhere cannot be edited. Omitted fields
  keep their values. Sending `platforms` replaces every target, so resend every connection array and
  config you want to keep. `mediaUrls` and `mediaAltTexts` only take effect together with `platforms`;
  `platformMedia` takes effect without it.
- **Move** a scheduled post with `update_post` and a new `scheduledAt`. Moving it more than a minute into
  the past fails; use `publish_draft` with `publishNow: true` to publish now. On a draft, a new
  `scheduledAt` only changes its planned date; the post stays a draft until `publish_draft`.
- **Hold back** a scheduled post with `unschedule_post`. It becomes an undated draft and nothing is lost.
  Schedule it again with `publish_draft` and a `scheduledAt`.
- **Delete** with `delete_post` only when the user wants the post gone. Deleting a published post removes
  AdaptlyPost's record only; the live posts stay on the networks. A post that is PUBLISHING cannot be
  deleted (409); wait until `list_post_results` settles.
- **Scheduled on YouTube**: once a platform has `youtubeScheduledVideoId` and has not published yet,
  `update_post`, `unschedule_post` and `publish_draft` answer 409 `SCHEDULED_ON_YOUTUBE`. To change the
  post, delete it and schedule it again; deleting it before `scheduledAt` removes the YouTube video too. A
  502 `SCHEDULED_VIDEO_DELETE_FAILED` means YouTube refused and the post is still there, so try again
  (have the user reconnect the channel first if it was disconnected).
- **Bulk**: `bulk_schedule_posts` takes up to 100 posts that share the same platforms, accounts and
  configs; an item can carry its own `tiktokConfigs`, `instagramConfigs`, `facebookConfigs`,
  `youtubeConfigs`, `pinterestConfigs`, `googleBusinessConfigs`, `tumblrConfigs` or `wordpressConfigs` to replace the shared
  ones, plus its own `firstComments`, `threadReplies`, `platformThumbnails`, `platformMedia` and
  `platformAspectRatios`.
  Run `validate_bulk_posts` with the same input first and fix every item it flags. It has no draft mode,
  so show the whole batch as a table (time, network, text, media) and get one explicit "yes" first. Read
  every result row; one bad item fails alone.
- **Find posts** with `list_posts` (filter by `statuses`, `platforms`, `startDate`, `endDate`; page with
  `offset` while `hasMore` is true). Use `get_post` for one full record.

## Recurring posts

Pass `recurrence` to `create_post` to repeat a post daily, weekly, monthly or yearly. It needs a future
`scheduledAt`, cannot be a draft and cannot include TikTok. Read
[references/recurring.md](references/recurring.md) before creating, pausing, resuming or deleting a
series.

## RSS feeds

A feed turns each new item of an RSS or Atom feed into a post on its target accounts (Facebook,
Instagram, Threads, X, Bluesky, LinkedIn, Mastodon, Telegram and Google Business Profile), as a draft, a
scheduled post or straight away (`postMode`). Text comes from a `template` with `{title}`, `{link}`,
`{description}`, `{author}` and `{feed}`, or from AI (`contentMode: AI`, 1 credit per network per item).
Items already in the feed when it is added are never posted unless `postLatestItem` is true. A workspace
holds 20 feeds. When the user asks why an article did or did not go out, read `list_rss_feed_items`. A
paused feed's `pauseReason` says why; fix that before `resume_rss_feed`.

## Webhooks

`create_webhook` registers a URL that receives the default events (`post.published`,
`post.partially_failed`, `post.failed`, `post.scheduled`, `account.unauthorized`, `image.completed`,
`image.failed`), signed with a secret the user collects once from the `secretRevealUrl` the response returns. Pass `events` to choose: the inbox
events `comment.created`, `comment.replied`, `mention.created`, `message.received` and `review.created`
reach only a webhook that lists them, and a non-empty list means only those events, so list the post
events too when the user still wants them. `update_webhook` changes `events`; `[]` goes back to the
default set. Inbox events arrive within about 10 minutes. `test_webhook` sends a signed test event. An endpoint is turned off
after 20 failed deliveries in a row; `update_webhook` with `active: true` turns it back on.

## Team

Creating or deleting a workspace, removing someone and managing invitations need Admin in the workspace
the call acts in. `create_workspace`, `delete_workspace` and `remove_organization_member` also need the
signed-in member to be an organization owner or admin; otherwise they fail with `permission_denied`.

- **New client.** `create_workspace` with a `name` (unique in the organization), then pass the returned
  `id` as `workspaceId` to `create_connect_link` or `send_invitation`. Every organization owner and admin
  becomes its admin. `connectionLimit` caps the social accounts it may connect.
- **Delete** a workspace only when the user asks. It takes its posts, feeds, inbox items, API keys and
  connect links with it. The default workspace, the last one and one that still has connected accounts
  cannot be deleted; disconnect the accounts with `remove_account` first.
- **Members.** `list_members` gives each member's `userId`, workspace `role` and `organizationRoles`.
  `remove_member` takes them out of this workspace and revokes their API keys and connect links there; they
  stay in the organization, and their last workspace cannot be removed. `remove_organization_member` takes
  them out of every workspace. Nobody can remove themselves, the owner cannot be removed, and only the
  owner removes an organization admin.
- **Invitations.** `send_invitation` takes `email`, `workspaces` (at least one `{ workspaceId, role }`, role
  `admin`, `editor`, `contributor` or `viewer`), `organizationRole` (`org-member` by default, `org-admin`
  only from the owner) and an optional `creditAllowance`. The invitation is emailed and lasts 7 days. A
  member who is not an organization admin can only invite `org-member`, to workspaces they manage, with a
  role no higher than their own. `list_invitations` and `revoke_invitation` cover the invitations that
  include the workspace the call acts in.

## Times

Ask the user's timezone once per session unless they already gave it. Convert every requested time to an
absolute ISO 8601 instant for `scheduledAt`; the `timezone` field is stored for display and does not shift
the time. A time in the past publishes immediately, so check before sending.

## AI captions and images

Use the AI tools when the user asks for a caption or an image, or says "write something about X" without
giving text. For a caption the user already wrote, just use their text.

- **Captions.** `generate_caption` writes one from a `prompt`; `refine_caption` rewrites `originalText`
  from an instruction ("shorter", "add a question"). Pass `platform` to keep it within that network's
  length. Both return `{ caption }` and save nothing. Show it, then put it in a draft as usual.
- **Images.** `generate_image` does not return the image. It returns a `jobId` right away. Call
  `get_image_job` every few seconds until `status` is `completed` or `failed`, usually 10 to 40 seconds,
  and stop after a couple of minutes. A completed job's `imageUrl` is public and goes straight into
  `mediaUrls`; no `upload_media` needed. Pick `aspectRatio` for the target network (9:16 for stories and
  reels, 4:5 for the Instagram feed). Reuse `sessionId` to keep related images together.
- **Credits.** Each caption costs 2 of the member's AI credits, a standard image 2 and a premium image 4,
  refunded when generation fails. A member who connected their own AI provider key in the app pays no
  credits. With no credits left a caption call fails and an image job ends `failed` with the reason in
  `error`: tell the user to top up or upgrade, or, for a team member, to ask the organization owner or an
  admin for a larger AI credit allowance. Do not retry.
- Generate only what the user asked for. Offer one or two variations, not a loop of them.
- All four need the `ai.generate` permission: Admin, Editor and Contributor have it, Viewer does not.

## Inbox

The inbox holds comments on the account's posts (Facebook, Instagram, Threads, YouTube, Bluesky, Mastodon,
LinkedIn), mentions (Facebook, Instagram, Threads, Bluesky, Mastodon), direct messages (Facebook,
Instagram, Bluesky, Mastodon) and Google Business Profile reviews. TikTok and X have none. Start with
`get_inbox_summary`, read the item before answering it, and confirm every reply. Read
[references/inbox.md](references/inbox.md) before replying, messaging, hiding, liking or deleting.

## Analytics

Read [references/analytics.md](references/analytics.md) before answering performance questions. Analytics
cover posts published inside the window and refresh every few hours. Facebook, Instagram, Threads, TikTok,
Pinterest, Bluesky, YouTube, X, LinkedIn and Google Business Profile report numbers; Mastodon, Telegram,
Tumblr and WordPress report nothing. Say which window your numbers cover. `list_post_results` is publishing status, not performance.

## Output style

- Drafts: one block per network with its text, then media, accounts and time.
- Status: a small table, network by network, with the error message for any failure and what to do.
- Reports: the headline number and one recommendation first, then detail.
- Link published posts with their `postUrl` from `get_post`. Show media from `previewUrls`, not
  `mediaUrls`; platform links expire within days.
