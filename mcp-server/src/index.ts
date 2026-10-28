#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DOCUMENT_MIME_TYPES,
  EXT_BY_MIME,
  fileNameFor,
  formatBytes,
  MAX_INLINE_UPLOAD_BYTES,
  openPublicMedia,
  putStream,
  requireMediaContent,
  requireStreamedMedia,
  SNIFF_BYTES,
  splitHead,
} from './media.js';
import { ApiError, RestClient } from './rest-client.js';
import {
  decodeFileName,
  MCP_APP_MIME_TYPE,
  openUploadTicket,
  sealUploadTicket,
  UPLOAD_FILE_NAME_HEADER,
  UPLOAD_TICKET_HEADER,
  UPLOAD_WIDGET_URI,
  uploadTicketsEnabled,
  uploadWidgetHtml,
} from './upload-widget.js';
import { withoutSchemaDialect } from './schema-dialect.js';
import {
  oauthConfigFromEnv,
  handleProtectedResourceMetadata,
  sendUnauthorized,
  looksLikeJwt,
  verifyOauthJwt,
} from './oauth.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const isHttpMode = process.argv.includes('--http');
const HTTP_PORT = parseInt(process.env.PORT ?? '3100', 10);

const API_BASE_URL =
  process.env.ADAPTLYPOST_API_URL ?? 'https://post.adaptlypost.com/post/api/v1';
const API_TOKEN = process.env.ADAPTLYPOST_API_TOKEN ?? '';

if (!API_TOKEN && !isHttpMode) {
  console.error(
    'Error: ADAPTLYPOST_API_TOKEN environment variable is required.\n' +
      'Create one at https://app.adaptlypost.com/api-tokens',
  );
  process.exit(1);
}

const api = new RestClient(API_BASE_URL, API_TOKEN);

const PUBLIC_ORIGIN = process.env.MCP_PUBLIC_ORIGIN ?? 'https://mcp.adaptlypost.com';
const UPLOAD_ENDPOINT = `${PUBLIC_ORIGIN}/upload`;
const STORAGE_UPLOAD_ORIGIN =
  process.env.MCP_STORAGE_UPLOAD_ORIGIN ??
  'https://115277785c6cd0d18a87bc78d295c5a5.eu.r2.cloudflarestorage.com';

const oauthConfig = oauthConfigFromEnv({
  resourceUrl: 'https://mcp.adaptlypost.com/mcp',
  resourceName: 'AdaptlyPost',
});

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

const CaptionPlatform = z.enum([
  'LINKEDIN',
  'YOUTUBE',
  'INSTAGRAM',
  'FACEBOOK',
  'TIKTOK',
  'PINTEREST',
  'THREADS',
  'BLUESKY',
  'TWITTER',
  'MASTODON',
  'GOOGLE_BUSINESS',
  'TUMBLR',
]);

const PlatformType = z.enum([...CaptionPlatform.options, 'TELEGRAM']);

const FirstCommentPlatform = z.enum([
  'LINKEDIN',
  'TWITTER',
  'THREADS',
  'BLUESKY',
  'MASTODON',
  'YOUTUBE',
  'FACEBOOK',
  'INSTAGRAM',
]);

const ThreadReplyPlatform = z.enum(['TWITTER', 'THREADS', 'BLUESKY', 'MASTODON']);

const ThumbnailPlatform = z.enum(['YOUTUBE', 'FACEBOOK', 'LINKEDIN', 'TELEGRAM', 'INSTAGRAM', 'PINTEREST', 'TIKTOK']);

const RssFeedPlatform = z.enum([
  'FACEBOOK',
  'INSTAGRAM',
  'THREADS',
  'TWITTER',
  'BLUESKY',
  'LINKEDIN',
  'MASTODON',
  'TELEGRAM',
  'GOOGLE_BUSINESS',
]);

const RssFeedPostMode = z.enum(['DRAFT', 'SCHEDULE', 'PUBLISH']);

const RssFeedContentMode = z.enum(['TEMPLATE', 'AI']);

const AspectRatioPlatform = z.enum(['INSTAGRAM', 'TIKTOK']);

const MediaAspectRatio = z.enum(['SQUARE', 'PORTRAIT', 'VERTICAL', 'LANDSCAPE']);

const MediaAspectRatioFit = z.enum(['CROP', 'PAD']);

const ContentType = z.enum(['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL', 'DOCUMENT']);

const BulkContentType = z.enum(['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL']);

const UploadMimeType = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  ...DOCUMENT_MIME_TYPES,
]);

const ImageAspectRatio = z.enum(['1:1', '16:9', '9:16', '3:2', '2:3', '4:5', '5:4', '21:9', '9:21']);

const ImageModel = z.enum(['standard', 'premium']);

const ImageQuality = z.enum(['LOW', 'MEDIUM', 'HIGH']);

const AI_PERMISSION_RULE =
  'Needs the ai.generate permission, which Admin, Editor and Contributor hold and Viewer does not (403 permission_denied).';

const CAPTION_CREDIT_RULE =
  'Each call spends 2 of the member\'s AI credits (the member who signed in or created the key), refunded if generation fails, unless the member has their own AI provider key connected in AdaptlyPost. With no credits left the call fails: explain that generation is unavailable with the current credit balance and do not retry automatically.';

const DOCUMENT_POST_RULE =
  'DOCUMENT publishes one PDF, PPT, PPTX, DOC or DOCX file (max 100 MB, 300 pages) as a LinkedIn document post and is LinkedIn only: put exactly that one file in mediaUrls, target only LINKEDIN, and set the title with linkedinConfigs';

const CAROUSEL_RULE =
  'CAROUSEL takes 2 or more items in mediaUrls, up to 4 on TWITTER, BLUESKY and MASTODON, 5 on PINTEREST, 10 on INSTAGRAM, FACEBOOK, THREADS and TELEGRAM, 20 on LINKEDIN, 30 on TUMBLR and 35 on TIKTOK (JPEG or WebP photos only). INSTAGRAM and THREADS accept images and videos in the same carousel; every other platform takes images only, and YOUTUBE has no carousel';

const GOOGLE_BUSINESS_RULE =
  'GOOGLE_BUSINESS takes TEXT or IMAGE with one JPEG or PNG image up to 5 MB, and text up to 1500 characters';

const TELEGRAM_RULE =
  'TELEGRAM takes text up to 4096 characters, up to 10 images (JPEG, PNG or WebP, 10 MB each) or one MP4 or MOV video (50 MB); a caption over 1024 characters goes out as its own message after the media';

const LINKEDIN_MENTION_RULE =
  'On LinkedIn, mention a company page with @[Page Name](urn:li:organization:<id>), using the page name exactly as LinkedIn shows it';

const ALT_TEXT_RULE =
  'Alt text per image, in the same order as mediaUrls (max 1000 characters each; use "" to skip an image). Sent to X, Bluesky, Mastodon, Tumblr, LinkedIn, Facebook, Instagram and Threads; Pinterest uses the first one (cut to 500). TikTok, YouTube, Google Business Profile and videos ignore it';

const PostStatus = z.enum([
  'COMPLETED',
  'DRAFT',
  'FAILED',
  'PARTIAL_FAILURE',
  'PENDING',
  'PUBLISHING',
  'SCHEDULED',
]);

const PostSortOrder = z.enum(['NEWEST', 'OLDEST']);

const RecurrenceFrequency = z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

const Weekday = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
]);

const RecurringPostStatus = z.enum(['ACTIVE', 'PAUSED', 'ENDED']);

const AnalyticsGranularity = z.enum(['DAILY', 'WEEKLY', 'MONTHLY']);

const AnalyticsSortMetric = z.enum([
  'VIEWS',
  'LIKES',
  'COMMENTS',
  'SHARES',
  'SAVES',
  'CLICKS',
  'IMPRESSIONS',
  'ENGAGEMENT_RATE',
  'PUBLISHED_AT',
]);

// ---------------------------------------------------------------------------
// Platform config schemas
// ---------------------------------------------------------------------------

const TikTokConfigSchema = z.object({
  connectionId: z.string().describe('TikTok connection ID from list_accounts'),
  title: z.string().max(90).optional().describe('Video title (max 90 chars)'),
  caption: z
    .string()
    .max(2200)
    .optional()
    .describe('TikTok-specific caption (max 2200 chars)'),
  privacyLevel: z
    .enum([
      'PUBLIC_TO_EVERYONE',
      'MUTUAL_FOLLOW_FRIENDS',
      'FOLLOWER_OF_CREATOR',
      'SELF_ONLY',
    ])
    .describe('TikTok privacy level'),
  allowComments: z.boolean().optional().describe('Allow comments on the TikTok post'),
  allowDuet: z.boolean().optional().describe('Allow other users to Duet this video'),
  allowStitch: z.boolean().optional().describe('Allow other users to Stitch this video'),
  sendAsDraft: z
    .boolean()
    .optional()
    .describe(
      'Save as TikTok draft so the user can add trending sounds before publishing',
    ),
  aiGenerated: z
    .boolean()
    .optional()
    .describe('Label content as AI-generated'),
  brandedContent: z.boolean().optional().describe('Disclose as branded content (paid partnership)'),
  brandedContentOwnBrand: z.boolean().optional().describe('Disclose as promoting your own brand'),
  autoAddMusic: z
    .boolean()
    .optional()
    .describe('Let TikTok auto-add music to the video'),
});

const YouTubeConfigSchema = z.object({
  connectionId: z
    .string()
    .describe('YouTube connection ID from list_accounts'),
  postType: z
    .enum(['VIDEO', 'SHORTS'])
    .optional()
    .describe('VIDEO for long-form, SHORTS for YouTube Shorts'),
  videoTitle: z
    .string()
    .max(100)
    .optional()
    .describe('YouTube video title (max 100 chars)'),
  tags: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Video tags (max 20)'),
  privacyStatus: z
    .enum(['public', 'private', 'unlisted'])
    .optional()
    .describe('Video privacy status'),
  license: z
    .enum(['youtube', 'creativeCommon'])
    .optional()
    .describe('Video license type'),
  notifySubscribers: z.boolean().optional().describe('Notify channel subscribers about the upload'),
  allowEmbedding: z.boolean().optional().describe('Allow embedding the video on other sites'),
  madeForKids: z.boolean().optional().describe('Mark the video as made for kids (COPPA)'),
  categoryId: z.string().optional().describe('YouTube category ID'),
  playlistId: z.string().optional().describe('Add video to this playlist'),
  aiGenerated: z
    .boolean()
    .optional()
    .describe(
      'Disclose altered or synthetic content, such as an AI voice, an AI avatar or realistic footage that was generated or edited. YouTube shows its "Altered or synthetic content" label on the video. Omit it or send false for no label',
    ),
});

const InstagramAudioSchema = z.object({
  audioId: z.string().min(1).max(64).describe('audioId from search_instagram_audio'),
  title: z.string().max(255).optional().describe('Track title, stored for display only'),
  artist: z.string().max(255).optional().describe('Artist or creator, stored for display only'),
  audioVolume: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Volume of the added audio, 1 to 100. Defaults to 100'),
  videoVolume: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Volume of the video's own sound, 1 to 100. Defaults to 100"),
});

const InstagramConfigSchema = z.object({
  connectionId: z
    .string()
    .describe('Instagram connection ID from list_accounts'),
  postType: z
    .enum(['FEED', 'REEL', 'STORY'])
    .optional()
    .describe(
      'Where the post goes: FEED works with every content type, REEL needs contentType VIDEO, STORY needs IMAGE, VIDEO or CAROUSEL (a CAROUSEL story publishes each media item as its own story, in order). Any other combination is refused with 400',
    ),
  shareToStory: z
    .boolean()
    .optional()
    .describe(
      'Also publish the same media as a story on this account, next to the FEED or REEL post. The story shows as its own entry in platforms with postType STORY, so it succeeds, fails and retries on its own. It skips the caption, first comment, cover, collaborators, trial and audio, needs IMAGE, VIDEO or CAROUSEL, and a video must fit the story length limit (60 seconds). Ignored when postType is STORY',
    ),
  collaborators: z
    .array(z.string().regex(/^@?[A-Za-z0-9._]{1,30}$/))
    .max(3)
    .optional()
    .describe(
      'Instagram usernames invited as collaborators (Instagram Collab), up to 3. A leading @ is stripped and duplicates are dropped. Works on feed images, carousels and reels; a story or a trial reel with collaborators is refused with 400. Each collaborator gets an invite in Instagram and must accept it before the post shows on their profile',
    ),
  audio: InstagramAudioSchema.optional().describe(
    "Music or an original sound from Instagram's audio library, added to the Reel when it is published. Needs contentType VIDEO and a postType other than STORY, and only works for accounts with supportsInstagramAudio: true in list_accounts (connected through Facebook). Find ids with search_instagram_audio",
  ),
  trialGraduation: z
    .enum(['MANUAL', 'SS_PERFORMANCE'])
    .optional()
    .describe(
      "Publish a video reel as a trial reel: Instagram shows it to non-followers first and keeps it off followers' feeds and the profile grid until it is shared. MANUAL means the account owner shares it from the Instagram app; SS_PERFORMANCE means Instagram shares it if it performs well. Only for a single video posted as a reel or feed video, never a story, image or carousel (400 otherwise). Needs a professional account Instagram has enabled for trial reels; otherwise that platform fails with a message saying so",
    ),
  userTags: z
    .array(
      z.object({
        username: z
          .string()
          .regex(/^@?[A-Za-z0-9._]{1,30}$/)
          .describe('The public Instagram username to tag'),
        x: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Horizontal position of the tag on the image, from 0 (left edge) to 1 (right edge)'),
        y: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Vertical position of the tag on the image, from 0 (top edge) to 1 (bottom edge)'),
      }),
    )
    .max(20)
    .optional()
    .describe(
      'Public Instagram accounts tagged in the media, up to 20. Works on a single image, a single video (published as a Reel) or a single story; a carousel or several stories with tags is refused with 400. On a feed image every tag needs x and y; on a story they are optional, and on a video they are ignored because the person is tagged on the video as a whole. A leading @ is stripped and a repeated username keeps its first entry. If Instagram refuses a tag because the account is private or does not exist, the post goes out without its tags and instagramUntaggedUsernames in get_post lists the refused usernames',
    ),
  aiGenerated: z
    .boolean()
    .optional()
    .describe(
      'Disclose that the post was made or edited with AI. Instagram shows its "AI info" label on the post. Works on images, carousels, reels and stories, and a story made with shareToStory carries the label too. Omit it or send false for no label',
    ),
});

const FacebookConfigSchema = z.object({
  pageId: z.string().describe('Facebook page ID from list_accounts'),
  postType: z
    .enum(['FEED', 'REEL', 'STORY'])
    .optional()
    .describe(
      'Where the post goes: FEED works with every content type, REEL needs contentType VIDEO, STORY needs IMAGE, VIDEO or CAROUSEL (a CAROUSEL story publishes each media item as its own story, in order). Any other combination is refused with 400',
    ),
  shareToStory: z
    .boolean()
    .optional()
    .describe(
      'Also publish the same media as a story on this page, next to the FEED or REEL post. The story shows as its own entry in platforms with postType STORY, so it succeeds, fails and retries on its own. It skips the caption, video title and text background, needs IMAGE, VIDEO or CAROUSEL, and a video must fit the story length limit (60 seconds). Ignored when postType is STORY',
    ),
  videoTitle: z
    .string()
    .max(255)
    .optional()
    .describe('Video title for Facebook (max 255 chars)'),
  textFormatPresetId: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional()
    .describe(
      "Facebook's id for a colored text background (for example 106018623298955 is solid purple, 249307305544279 is a red to blue gradient). Only for contentType TEXT posts with no media and text up to 130 characters; anything else is refused with 400. Links in the text show without a preview. If Facebook refuses the background, the post goes out as plain text",
    ),
  imageLayout: z
    .enum(['GRID', 'CAROUSEL'])
    .optional()
    .describe(
      'How a post with several images shows on Facebook. GRID is a photo grid. CAROUSEL is a swipeable carousel where each image is a card with its own link, and needs 2 to 5 images, no videos, postType FEED and one carouselCards entry per image; anything else is refused with 400',
    ),
  carouselCards: z
    .array(
      z.object({
        link: z.string().max(2048).describe('The http or https URL the card opens'),
        title: z
          .string()
          .max(100)
          .optional()
          .describe("The card's headline. Without it Facebook uses the linked page's title"),
        description: z
          .string()
          .max(200)
          .optional()
          .describe('The line under the headline, such as a price or the domain. Without it Facebook uses the linked page'),
      }),
    )
    .max(5)
    .optional()
    .describe(
      'One card per image, in the same order as the media, used when imageLayout is CAROUSEL. Facebook only shows your image, title and description on a card whose link points to a website the Page owns; for any other link the post fails with the error Facebook returns',
    ),
});

const LinkedInConfigSchema = z.object({
  connectionId: z.string().describe('LinkedIn connection ID from list_accounts'),
  documentTitle: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Title LinkedIn shows on a DOCUMENT post (max 100 chars). Defaults to the file name; ignored for other content types',
    ),
  reshareOf: z
    .string()
    .max(500)
    .optional()
    .describe(
      'Reshare this LinkedIn post from the account, with the post text as the commentary. Takes a urn:li:share: or urn:li:ugcPost: URN, such as the platformPostId from list_post_results, or a LinkedIn post link of the form https://www.linkedin.com/feed/update/<urn>, which is also the link inside a post\'s Embed code. urn:li:activity: links are refused because LinkedIn cannot reshare them through its API. Media on the post is not attached on this account',
    ),
});

const TumblrConfigSchema = z.object({
  connectionId: z.string().describe('Tumblr blog account id from list_accounts'),
  tags: z
    .array(z.string())
    .max(30)
    .optional()
    .describe('Tumblr tags, without commas, up to 30. A leading # is stripped and duplicates are dropped, ignoring case'),
  title: z.string().max(4096).optional().describe('Shown as a heading above the media and the text'),
  sourceUrl: z.string().max(2048).optional().describe('Shown as the source link of the post'),
});

const PinterestConfigSchema = z.object({
  connectionId: z
    .string()
    .describe('Pinterest connection ID from list_accounts'),
  boardId: z
    .string()
    .optional()
    .describe(
      'Board id from list_pinterest_boards. Leave out boardId and boardName to pin to a public board named AdaptlyPost, created on the account the first time it is needed',
    ),
  boardName: z
    .string()
    .min(1)
    .max(180)
    .optional()
    .describe(
      "The board's name, instead of boardId; never send both. Matched against this account's boards, exact first, then case-insensitive. A name no board has, or one several boards share, fails with 400 and never falls back to another board",
    ),
  title: z.string().max(100).optional().describe('Pin title (max 100 chars)'),
  link: z.string().optional().describe('Destination URL for the pin'),
});

const GoogleBusinessEventDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/);

const GoogleBusinessConfigSchema = z.object({
  connectionId: z.string().describe('Google Business Profile account id from list_accounts'),
  topicType: z
    .enum(['STANDARD', 'EVENT', 'OFFER'])
    .describe('STANDARD is an update. EVENT and OFFER need eventTitle, eventStart and eventEnd'),
  callToActionType: z
    .enum(['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'])
    .optional()
    .describe(
      'Button shown on the post. Every type except CALL needs callToActionUrl; CALL dials the phone number on the Business Profile',
    ),
  callToActionUrl: z.string().url().optional().describe('Ignored when callToActionType is CALL'),
  eventTitle: z.string().optional().describe('Title of the event or offer'),
  eventStart: GoogleBusinessEventDate.optional().describe(
    "YYYY-MM-DD or YYYY-MM-DDTHH:mm in the business's local time, with no offset (e.g. \"2026-10-01T18:00\"). Google reads event times in the location's time zone",
  ),
  eventEnd: GoogleBusinessEventDate.optional().describe(
    "YYYY-MM-DD or YYYY-MM-DDTHH:mm in the business's local time, with no offset (e.g. \"2026-10-01T21:00\")",
  ),
  offerCouponCode: z.string().optional().describe('OFFER only: coupon code'),
  offerRedeemUrl: z.string().url().optional().describe('OFFER only: where the offer is redeemed'),
  offerTerms: z.string().optional().describe('OFFER only: terms and conditions'),
});

const RecurrenceSchema = z.object({
  frequency: RecurrenceFrequency.describe(
    'How often the post repeats: DAILY, WEEKLY, MONTHLY or YEARLY. YEARLY repeats on the same date; a series started on February 29 posts on February 28 in other years',
  ),
  interval: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('Repeat every N days, weeks, months or years, 1 to 30 (default 1)'),
  weekdays: z
    .array(Weekday)
    .max(7)
    .optional()
    .describe(
      'WEEKLY only: the weekdays it goes out on (e.g. ["MONDAY", "THURSDAY"]). The weekday of scheduledAt is always included',
    ),
  endsOn: z
    .string()
    .optional()
    .describe(
      'Last day an occurrence may go out on, as YYYY-MM-DD (inclusive). Must be on or after the day of the first post. Cannot be combined with maxOccurrences',
    ),
  maxOccurrences: z
    .number()
    .int()
    .min(2)
    .max(365)
    .optional()
    .describe(
      'Total number of posts the series publishes, 2 to 365. Cannot be combined with endsOn; omit both to repeat until the user pauses or deletes the series',
    ),
});

// ---------------------------------------------------------------------------
// Shared field groups (reused across create, update, bulk)
// ---------------------------------------------------------------------------

const connectionIdFields = {
  linkedinConnectionIds: z.array(z.string()).optional().describe('LinkedIn account connection IDs to post from'),
  twitterConnectionIds: z.array(z.string()).optional().describe('X (Twitter) account connection IDs to post from'),
  instagramConnectionIds: z.array(z.string()).optional().describe('Instagram account connection IDs to post from'),
  youtubeConnectionIds: z.array(z.string()).optional().describe('YouTube channel connection IDs to post from'),
  tiktokConnectionIds: z.array(z.string()).optional().describe('TikTok account connection IDs to post from'),
  threadsConnectionIds: z.array(z.string()).optional().describe('Threads account connection IDs to post from'),
  blueskyConnectionIds: z.array(z.string()).optional().describe('Bluesky account connection IDs to post from'),
  mastodonConnectionIds: z.array(z.string()).optional().describe('Mastodon account connection IDs to post from'),
  pinterestConnectionIds: z.array(z.string()).optional().describe('Pinterest account connection IDs to post from'),
  tumblrConnectionIds: z
    .array(z.string())
    .optional()
    .describe(
      'Tumblr blogs to post to, by the account id from list_accounts. TUMBLR takes text up to 32768 characters, up to 30 JPEG, PNG or GIF images (10 MB each) or one MP4 video (500 MB, up to 10 minutes), and alt text; it has no first comments, threads, per-platform thumbnails, image shapes or analytics',
    ),
  telegramConnectionIds: z
    .array(z.string())
    .optional()
    .describe(`Telegram channels and groups to post to, by the account id from list_accounts. ${TELEGRAM_RULE}`),
  googleBusinessConnectionIds: z
    .array(z.string())
    .optional()
    .describe(
      'Google Business Profile locations to post to, by the account id from list_accounts. A location without an entry in googleBusinessConfigs gets a STANDARD update',
    ),
  pageIds: z
    .array(z.string())
    .optional()
    .describe(
      'Facebook page account ids from list_accounts (the account id; its pageId value is also accepted). Facebook has no connection-id array',
    ),
};

const platformConfigFields = {
  tiktokConfigs: z
    .array(TikTokConfigSchema)
    .optional()
    .describe(
      'TikTok per-connection config. Each entry needs connectionId + privacyLevel at minimum',
    ),
  youtubeConfigs: z
    .array(YouTubeConfigSchema)
    .optional()
    .describe(
      'YouTube per-connection config with video title, tags, privacy, etc.',
    ),
  instagramConfigs: z
    .array(InstagramConfigSchema)
    .optional()
    .describe(
      'Instagram per-connection config: post type (FEED, REEL, STORY), shareToStory, collaborators, user tags, the AI info label, Reel audio, and trial reels',
    ),
  facebookConfigs: z
    .array(FacebookConfigSchema)
    .optional()
    .describe(
      'Facebook per-page config: post type, shareToStory, video title, text background, and a grid or link carousel for several images. pageId must match an entry in pageIds',
    ),
  pinterestConfigs: z
    .array(PinterestConfigSchema)
    .optional()
    .describe(
      'Pinterest per-connection config: the board to pin to, a pin title and a destination link. Get boardId from list_pinterest_boards for that connectionId, or pass the board name as boardName instead (not both); a board belongs to one Pinterest account. A boardName that matches no board or several fails with 400. Without either the pin goes to a board named AdaptlyPost',
    ),
  googleBusinessConfigs: z
    .array(GoogleBusinessConfigSchema)
    .optional()
    .describe(
      `Google Business Profile per-location config: update, event or offer, plus a button. connectionId must match an entry in googleBusinessConnectionIds. ${GOOGLE_BUSINESS_RULE}`,
    ),
  tumblrConfigs: z
    .array(TumblrConfigSchema)
    .optional()
    .describe('Tumblr per-blog config: tags, a title and a source link. connectionId must match an entry in tumblrConnectionIds'),
};

const postThumbnailFields = {
  thumbnailUrl: z
    .string()
    .optional()
    .describe(
      'Video thumbnail as an https URL or an image data URI, used on every platform that takes one unless platformThumbnails overrides it',
    ),
  thumbnailTimestampMs: z
    .number()
    .optional()
    .describe(
      'Video frame timestamp (ms) to use as the thumbnail, used by INSTAGRAM, PINTEREST and TIKTOK unless platformThumbnails overrides it',
    ),
};

const platformTextsField = z
  .array(
    z.object({
      platform: PlatformType,
      text: z.string().describe(LINKEDIN_MENTION_RULE),
    }),
  )
  .optional();

const postExtrasFields = {
  firstComments: z
    .array(
      z.object({
        platform: FirstCommentPlatform,
        text: z
          .string()
          .min(1)
          .max(10000)
          .describe("The comment's text, trimmed. The limit depends on the platform, see firstComments"),
      }),
    )
    .optional()
    .describe(
      'A comment posted from the same account right after the post goes out on a platform, one entry per platform. Available on LINKEDIN (1250 characters), TWITTER (280, as a reply), THREADS (500, as a reply), BLUESKY (300, as a reply), MASTODON (500, as a reply), YOUTUBE (10000), FACEBOOK (8000) and INSTAGRAM (2200). A platform the post does not go to, an empty or too long comment, a second entry for one platform, a platform that also has threadReplies, a private or made for kids YouTube video and Facebook or Instagram stories are refused with 400. The comment is posted about 10 seconds after the platform publishes (60 on YouTube) and retried up to 3 times; on X it is not retried, and a lifetime-deal account pays for it like any X post. A Facebook Page or Instagram account connected before first comments came to them must be reconnected once; until then its comment fails and firstCommentError says to reconnect. A comment that fails never fails the post: read firstCommentStatus and firstCommentError on the platform in get_post. On an update, sending the array replaces every first comment and omitting it keeps the stored ones',
    ),
  threadReplies: z
    .array(
      z.object({
        platform: ThreadReplyPlatform,
        texts: z
          .array(z.string())
          .max(25)
          .describe('The replies in order, each trimmed. The limit per reply depends on the platform, see threadReplies'),
      }),
    )
    .optional()
    .describe(
      "Turns the post into a thread: the post opens it and each text is published as a reply to the one before, from the same account, one entry per platform. Available on TWITTER (280 characters per reply, or the account's own limit on X Premium), THREADS (500), BLUESKY (300) and MASTODON (500, or the instance's limit), up to 25 replies. A platform the post does not go to, an empty or too long reply, more than 25 replies, a second entry for one platform and a platform that also has a first comment are refused with 400. An entry with an empty texts array removes the thread. Replies start about 10 seconds after the platform publishes, 2 seconds apart. A failed run is retried up to 3 times and resumes after the last reply that went out; on X it is not retried, and a lifetime-deal account pays for each reply like any X post. A thread that fails never fails the post: read threadStatus, threadReplyIds and threadError on the platform in get_post. On an update, sending the array replaces every thread and omitting it keeps the stored ones",
    ),
  platformThumbnails: z
    .array(
      z.object({
        platform: ThumbnailPlatform,
        thumbnailUrl: z
          .string()
          .optional()
          .describe("The image to use as this platform's thumbnail, an https URL or an image data URI"),
        thumbnailTimestampMs: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("The video frame (ms from the start) to use as this platform's thumbnail"),
      }),
    )
    .optional()
    .describe(
      'A different thumbnail for one platform of a VIDEO post, one entry per platform. A platform without an entry uses the post-level thumbnailUrl and thumbnailTimestampMs. YOUTUBE, FACEBOOK, LINKEDIN and TELEGRAM take an image (thumbnailUrl); INSTAGRAM and PINTEREST take an image or a frame (thumbnailTimestampMs), the image winning when both are sent; TIKTOK takes only a frame. Posts that are not videos, Facebook and Instagram stories, a second entry for one platform and an entry the platform cannot use are refused with 400. On an update, sending the array replaces every override and omitting it keeps the stored ones',
    ),
  platformAspectRatios: z
    .array(
      z.object({
        platform: AspectRatioPlatform,
        aspectRatio: MediaAspectRatio.describe(
          'SQUARE is 1:1, PORTRAIT 4:5, VERTICAL 9:16 and LANDSCAPE 1.91:1',
        ),
        fit: MediaAspectRatioFit.optional().describe(
          'How an image of another shape reaches the ratio. CROP (the default) cuts it from the center; PAD keeps the whole image and fills the rest with a blurred copy of it',
        ),
      }),
    )
    .optional()
    .describe(
      'Reframe every image of an IMAGE or CAROUSEL post to one shape on a platform, one entry per platform. INSTAGRAM takes SQUARE, PORTRAIT or LANDSCAPE (Instagram refuses 9:16 feed and carousel images); TIKTOK takes all four. Video posts, Instagram stories and a second entry for the same platform are refused with 400. Omit a platform to keep its images as uploaded. On an update it applies to the mediaUrls sent in the same request',
    ),
};

const twitterKeepLinksField = {
  twitterKeepLinks: z
    .boolean()
    .optional()
    .describe(
      'Keep links in the X text clickable. X charges over 10 times more for a post with a link, so by default every link in X text is broken (example.com becomes example. com). Only AppSumo lifetime deals can turn this on, and a kept link costs 20 credits instead of 2. true on any other plan is refused with 400; it is ignored when the X text has no link',
    ),
};

const linkedinConfigsField = {
  linkedinConfigs: z
    .array(LinkedInConfigSchema)
    .optional()
    .describe(
      'LinkedIn per-connection config: documentTitle names a DOCUMENT post, reshareOf reshares another LinkedIn post with the text as commentary. connectionId must match an entry in linkedinConnectionIds',
    ),
};

const createPostShape = {
  text: z
    .string()
    .optional()
    .describe(`Default post text shared across platforms. ${LINKEDIN_MENTION_RULE}`),
  accountIds: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      "Account ids (or Facebook pageIds) from list_accounts to post to. AdaptlyPost adds each account's platform to platforms and its id to the matching connection-id array, so you can send these instead of platforms and the per-platform arrays, or alongside them. An id not connected to the workspace fails with 400",
    ),
  platforms: z
    .array(PlatformType)
    .min(1)
    .optional()
    .describe(
      'Target platforms (e.g. ["LINKEDIN", "TWITTER"]). Each one needs its matching connection-id array (pageIds for FACEBOOK, googleBusinessConnectionIds for GOOGLE_BUSINESS) filled with ids from list_accounts. Optional when accountIds is sent',
    ),
  contentType: ContentType.describe(
    `Content type: TEXT, IMAGE, VIDEO, CAROUSEL, or DOCUMENT. Must match mediaUrls. ${CAROUSEL_RULE}. ${GOOGLE_BUSINESS_RULE}. ${TELEGRAM_RULE}. ${DOCUMENT_POST_RULE}`,
  ),
  scheduledAt: z
    .string()
    .optional()
    .describe(
      'Absolute ISO 8601 instant to schedule (e.g. "2026-03-15T10:00:00Z"). Omit to post immediately; a past time also posts immediately. With saveAsDraft it is the draft\'s planned date instead: nothing is scheduled, and publish_draft without a date later schedules the draft for it',
    ),
  timezone: z
    .string()
    .default('UTC')
    .describe(
      'IANA timezone stored with the post for display (e.g. "America/New_York"); it does not shift scheduledAt',
    ),
  saveAsDraft: z
    .boolean()
    .optional()
    .describe(
      'Save as DRAFT instead of publishing or scheduling; publish later with publish_draft. A scheduledAt sent with it is stored as the draft\'s planned date, and publish_draft schedules the draft for that date',
    ),
  recurrence: RecurrenceSchema.optional().describe(
    'Repeat the post on a schedule the user asked for, and confirm that schedule with them first. Needs a future scheduledAt, which becomes the first post and sets the time of day in timezone. Cannot be combined with saveAsDraft or TIKTOK. Missed slots, for example while paused, are skipped and never published late. The user can pause or stop the series at any time with pause_recurring_post or delete_recurring_post; list_recurring_posts shows it',
  ),
  mediaUrls: z
    .array(z.string())
    .optional()
    .describe(
      'Media URLs to attach. Use publicUrl values from upload_media or get_upload_urls; the same publicUrl may be reused across posts. Do not reuse mediaUrls read back from a published post, which may be expiring platform links',
    ),
  mediaAltTexts: z
    .array(z.string().max(1000))
    .optional()
    .describe(ALT_TEXT_RULE),
  ...postThumbnailFields,
  platformTexts: platformTextsField.describe('Per-platform caption overrides'),
  ...postExtrasFields,
  ...twitterKeepLinksField,
  ...connectionIdFields,
  ...platformConfigFields,
  ...linkedinConfigsField,
};

const bulkPostsShape = {
  platforms: z
    .array(PlatformType)
    .describe(
      'Target platforms shared by every item. Each needs its connection-id array (pageIds for FACEBOOK, googleBusinessConnectionIds for GOOGLE_BUSINESS)',
    ),
  timezone: z
    .string()
    .default('UTC')
    .describe('IANA timezone stored with every post for display; does not shift scheduledAt'),
  posts: z
    .array(
      z.object({
        text: z.string().optional().describe(`Post text/caption. ${LINKEDIN_MENTION_RULE}`),
        contentType: BulkContentType.describe(
          `TEXT, IMAGE, VIDEO, or CAROUSEL; must match mediaUrls. DOCUMENT posts cannot be bulk scheduled; use create_post. ${CAROUSEL_RULE}. ${GOOGLE_BUSINESS_RULE}. ${TELEGRAM_RULE}`,
        ),
        scheduledAt: z
          .string()
          .describe('Absolute ISO 8601 instant; a past time publishes immediately'),
        mediaUrls: z
          .array(z.string())
          .optional()
          .describe('publicUrl values from upload_media; unstored URLs fail this item'),
        mediaAltTexts: z
          .array(z.string().max(1000))
          .optional()
          .describe(ALT_TEXT_RULE),
        ...postThumbnailFields,
        platformTexts: platformTextsField.describe('Per-platform caption overrides for this item'),
        ...postExtrasFields,
        tiktokConfigs: z
          .array(TikTokConfigSchema)
          .optional()
          .describe('TikTok config for this item only; replaces the batch-level tiktokConfigs'),
        youtubeConfigs: z
          .array(YouTubeConfigSchema)
          .optional()
          .describe('YouTube config for this item only, such as its own videoTitle; replaces the batch-level youtubeConfigs'),
        instagramConfigs: z
          .array(InstagramConfigSchema)
          .optional()
          .describe('Instagram config for this item only; replaces the batch-level instagramConfigs'),
        facebookConfigs: z
          .array(FacebookConfigSchema)
          .optional()
          .describe('Facebook config for this item only; replaces the batch-level facebookConfigs'),
        pinterestConfigs: z
          .array(PinterestConfigSchema)
          .optional()
          .describe('Pinterest config for this item only, such as its own board, title or link; replaces the batch-level pinterestConfigs'),
        googleBusinessConfigs: z
          .array(GoogleBusinessConfigSchema)
          .optional()
          .describe('Google Business Profile config for this item only, such as its own event or offer; replaces the batch-level googleBusinessConfigs'),
        tumblrConfigs: z
          .array(TumblrConfigSchema)
          .optional()
          .describe('Tumblr config for this item only, such as its own tags; replaces the batch-level tumblrConfigs'),
      }),
    )
    .min(1)
    .max(100)
    .describe('1 to 100 posts to schedule; each is created independently'),
  ...connectionIdFields,
  ...platformConfigFields,
};

// ---------------------------------------------------------------------------
// Analytics field groups
// ---------------------------------------------------------------------------

const analyticsRangeFields = {
  from: z
    .string()
    .describe(
      'Start of the reporting window as an ISO 8601 date or instant (e.g. "2026-08-01"). Metrics cover posts published between from and to; the comparison window is the same length immediately before from',
    ),
  to: z
    .string()
    .describe('End of the reporting window (ISO 8601). Must not be earlier than from'),
  platforms: z
    .array(PlatformType)
    .optional()
    .describe(
      'Restrict to these platforms; omit for every platform with analytics. MASTODON, TELEGRAM and TUMBLR have no analytics and are ignored. GOOGLE_BUSINESS reports location impressions only, with no per-post numbers',
    ),
  connectionIds: z
    .array(z.string())
    .optional()
    .describe('Restrict to these accounts, by the account id from list_accounts; omit for every account'),
};

const ANALYTICS_COVERAGE =
  'Analytics cover Facebook, Instagram, Threads, TikTok, Pinterest, Bluesky, LinkedIn, YouTube, X and Google Business Profile (location impressions only, no per-post numbers); Mastodon, Telegram and Tumblr have none. Connecting an account imports its posts from the last 180 days, and analytics are kept from then on while the account stays connected, so any date range in that history can be queried.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { result: data },
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

const workspaceIdField = {
  workspaceId: z
    .string()
    .optional()
    .describe(
      'Workspace to act in: an id from list_workspaces. Omit to act in the workspace list_workspaces marks current. Use the same workspaceId for every call about the same workspace, since ids from one workspace (accounts, posts, uploads) do not exist in another',
    ),
};

const resultSchema = (description: string) => ({
  result: z.unknown().describe(description),
});

type Uploaded = { publicUrl: string; key: string };

async function mintUploadUrl(
  apiClient: RestClient,
  fileName: string,
  mimeType: string,
  fileSize?: number,
): Promise<{ uploadUrl: string } & Uploaded> {
  const { urls } = (await apiClient.post('/upload-urls', {
    files: [{ fileName, mimeType, fileSize }],
  })) as { urls: ({ uploadUrl: string } & Uploaded)[] };
  return urls[0];
}

async function uploadFromUrl(
  apiClient: RestClient,
  sourceUrl: string,
  fileName?: string,
): Promise<Uploaded & { bytes: number }> {
  const media = await openPublicMedia(sourceUrl, fileName);
  try {
    const { uploadUrl, publicUrl, key } = await mintUploadUrl(
      apiClient,
      fileNameFor(media.name, media.mimeType),
      media.mimeType,
    );
    await putStream(uploadUrl, media);
    return { publicUrl, key, bytes: media.contentLength };
  } finally {
    await media.dispose();
  }
}

type ChatAttachment = {
  download_url: string;
  file_id: string;
  mime_type?: string | null;
  file_name?: string | null;
};

async function uploadFromAttachment(apiClient: RestClient, attachment: ChatAttachment): Promise<Uploaded> {
  const startedAt = Date.now();
  const host = URL.canParse(attachment.download_url) ? new URL(attachment.download_url).hostname : 'invalid';
  try {
    const uploaded = await uploadFromUrl(apiClient, attachment.download_url, attachment.file_name ?? undefined);
    console.error(`attachment upload ok host=${host} bytes=${uploaded.bytes} ms=${Date.now() - startedAt}`);
    return uploaded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`attachment upload failed host=${host} ms=${Date.now() - startedAt} error=${message}`);
    throw error;
  }
}

async function uploadFromBase64(
  apiClient: RestClient,
  data: string,
  fileName: string,
): Promise<Uploaded> {
  const buffer = Buffer.from(data, 'base64');
  const mimeType = requireMediaContent(buffer, fileName);
  const stem = fileName.replace(/\.[^.]*$/, '') || 'upload';
  const { uploadUrl, publicUrl, key } = await mintUploadUrl(
    apiClient,
    `${stem}${EXT_BY_MIME[mimeType]}`,
    mimeType,
  );
  await putStream(uploadUrl, { mimeType, contentLength: buffer.length, body: Readable.from([buffer]) });
  return { publicUrl, key };
}

function decodedBase64Length(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function requireInlineBudget(files: { data: string; fileName: string }[]): void {
  const total = files.reduce((sum, f) => sum + decodedBase64Length(f.data), 0);
  if (total > MAX_INLINE_UPLOAD_BYTES) {
    throw new Error(
      `Inline files total ${formatBytes(total)}, over the ${formatBytes(MAX_INLINE_UPLOAD_BYTES)} limit per call. Use get_upload_urls and PUT the file directly, or pass a public URL in urls.`,
    );
  }
}

// ---------------------------------------------------------------------------
// MCP Server – tool registration
// ---------------------------------------------------------------------------

const SERVER_INSTRUCTIONS = [
  'Every tool acts as the signed-in member, or the member who created the API key, under that member\'s workspace role: Admin, Editor, Contributor or Viewer.',
  'A sign-in can reach several workspaces, each with its own accounts, posts and role. Call list_workspaces when the user names a workspace, brand, client or organization, or when accounts or posts they expect are missing, then pass that id as workspaceId on every call about it. Without workspaceId, tools act in the workspace list_workspaces marks current. The role, and so what a tool may do, can differ per workspace.',
  'A 403 with code workspace_access_denied means the workspaceId is not one this sign-in can reach. Call list_workspaces and pick an id from it.',
  'A Contributor can create and edit their own drafts, upload media, generate captions and images, and read posts and analytics; it cannot schedule, publish, retry, bulk schedule, delete non-drafts, trigger an analytics sync, manage webhooks or touch other members\' posts. Only an Admin can remove accounts or create connect links. A Viewer only reads. get_me says what this connection may do in a workspace.',
  'A 403 with code permission_denied means the member\'s role does not allow this action. Tell the user and do not retry. For a schedule or publish, offer to save the post as a draft for an Admin or Editor to publish, and only do that if the user agrees.',
  'A 401 with code token_issuer_lost_access means this connection lost access to the workspace. Tell the user to reconnect AdaptlyPost, or to have a workspace member create a new API key in AdaptlyPost settings.',
  'A 403 with code subscription_required means the organization\'s current AdaptlyPost plan does not include this. Tell the user and stop; do not retry.',
  'A 401 with code oauth_account_not_found means the user signed in with an email that has no AdaptlyPost account. Relay the message, which names that email, and ask them to disconnect and reconnect with the email they use on AdaptlyPost.',
  'A 429 means the rate limit was hit. Wait for the Retry-After time before the next call and do not loop.',
  'generate_caption, refine_caption and generate_image spend AI credits on every call, so generate only what the user asked for. generate_image returns a jobId, not an image: poll get_image_job until status is completed or failed.',
  'validate_post and validate_bulk_posts take the same input as create_post and bulk_schedule_posts and report every problem without creating anything. Use them before a large or unusual post.',
].join('\n');

function createMcpServer(apiClient?: RestClient): McpServer {
  const baseClient = apiClient ?? api;
  const server = new McpServer(
    {
      name: 'adaptlypost',
      version: '1.2.0',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const tool = <Args extends ZodRawShape>(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: Args;
      outputSchema: ZodRawShape;
      annotations: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    handler: (
      args: z.objectOutputType<Args, ZodTypeAny>,
      client: RestClient,
    ) => Promise<CallToolResult>,
  ) => {
    const inputSchema: ZodRawShape = { ...config.inputSchema, ...workspaceIdField };
    return server.registerTool(name, { ...config, inputSchema }, async (args) => {
      const { workspaceId, ...rest } = args as { workspaceId?: string };
      return handler(
        rest as z.objectOutputType<Args, ZodTypeAny>,
        baseClient.forWorkspace(workspaceId),
      );
    });
  };

  server.registerTool(
    'list_workspaces',
    {
      title: 'List Workspaces',
      description:
        'List the workspaces this sign-in can act in, across every organization the user belongs to. Returns { workspaces } with id, name, organization { id, name }, role { key, name }, permissions (the permission keys held there), isDefault, current and can { draft, schedule, publish }. Call this when the user names a workspace, brand, client or organization, or when accounts or posts they expect are missing: then pass the matching id as workspaceId to every other tool. Without workspaceId, tools act in the workspace marked current. An API key belongs to one workspace, so it lists only that one. Takes no arguments.',
      inputSchema: {},
      outputSchema: resultSchema(
        'An object with workspaces: one { id, name, organization, role, permissions, isDefault, current, can } per workspace. Pass id as workspaceId to other tools.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async () => {
      try {
        const data = await baseClient.get('/workspaces');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_me',
    {
      title: 'Get My Access',
      description:
        "Describe this connection in the workspace (the current one unless workspaceId names another): whether it is an API key or a sign-in, its role, the permission keys it holds, can { draft, schedule, publish } and a one-sentence summary of what it may do. An API key never holds more than the member who created it (issuerRole). Call this before an action the role may not allow, instead of trying and reading a 403. Takes only the optional workspaceId.",
      inputSchema: {},
      outputSchema: resultSchema(
        'An object with tokenType (api_token or oauth), tokenId, tokenName, workspace { id }, organizationId, role { key, name }, issuerRole, permissions, can { draft, schedule, publish }, summary and expiresAt (null for a key that never expires).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (_args, client) => {
      try {
        const data = await client.get('/me');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Account Tools ──────────────────────────────────────────────────────

  tool(
    'list_accounts',
    {
      title: 'List Connected Accounts',
      description:
        'List the social accounts connected to the workspace (the current one unless workspaceId names another) across all thirteen platforms. Returns { accounts } with id, platform, displayName, username, avatarUrl, status, pageId for Facebook pages, and supportsInstagramAudio for Instagram (true when the account can add audio to Reels, see search_instagram_audio). For a Pinterest account, list_pinterest_boards returns the boards it can pin to. For a Google Business Profile location displayName is the location title and username is empty; its id goes in googleBusinessConnectionIds. status is active or unauthorized; an unauthorized account (unauthorizedReason carries the platform\'s message) is refused with 400 by create_post until the user reconnects it in AdaptlyPost, so leave it out and tell the user. Call this before create_post, update_post, or bulk_schedule_posts: they take these ids, never usernames. Pass the ids as accountIds, or put each id in the array for its platform (linkedinConnectionIds, tumblrConnectionIds, telegramConnectionIds, and so on); Facebook page accounts go in pageIds. check_account re-checks a Facebook page with Facebook, and remove_account disconnects an account. Not for post history or publishing status: use list_posts or list_post_results for those. Takes only the optional workspaceId.',
      inputSchema: {},
      outputSchema: resultSchema(
        'An object with accounts: one { id, platform, displayName, username, avatarUrl, status } per connected account, plus unauthorizedReason when status is unauthorized, pageId for Facebook pages and supportsInstagramAudio for Instagram. Use id as the connection id (or in pageIds for Facebook).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (_args, client) => {
      try {
        const data = await client.get('/social-accounts');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'search_instagram_audio',
    {
      title: 'Search Instagram Audio',
      description:
        "Search Instagram music and original sounds to add to a Reel. Returns { audio } with audioId, audioType, title, displayArtist (music), igUsername (original sounds), durationMs, coverArtworkUrl, profilePictureUrl, previewUrl (a temporary audio file, expires after about 1.5 days), instagramUrl and isAdsEligible. Leave out searchQuery to get what is trending. Only audio Meta has cleared for third-party publishing comes back, which can differ from what the Instagram app shows. Only works for Instagram accounts with supportsInstagramAudio: true in list_accounts; otherwise, or when Instagram rejects the search, it fails with 400. Pass the chosen audioId, with its title and artist, in instagramConfigs[].audio of create_post, update_post or bulk_schedule_posts. Nothing is posted.",
      inputSchema: {
        accountId: z
          .string()
          .describe('The Instagram account id from list_accounts'),
        audioType: z
          .enum(['music', 'original_sound'])
          .describe('music for licensed tracks, original_sound for sounds from other Instagram posts'),
        searchQuery: z
          .string()
          .max(100)
          .optional()
          .describe('Keyword filter (max 100 characters). Leave out for trending audio'),
      },
      outputSchema: resultSchema(
        'An object with audio: one { audioId, audioType, title, displayArtist, igUsername, durationMs, coverArtworkUrl, profilePictureUrl, previewUrl, instagramUrl, isAdsEligible } per match. Pass audioId as instagramConfigs[].audio.audioId.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ accountId, ...query }, client) => {
      try {
        const data = await client.get(
          `/social-accounts/${encodeURIComponent(accountId)}/instagram-audio`,
          query,
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'list_pinterest_boards',
    {
      title: 'List Pinterest Boards',
      description:
        "List the boards of a connected Pinterest account, secret boards included. Returns { boards } with id, name, description, privacy (PUBLIC, PROTECTED or SECRET) and pinCount. Call it before posting to Pinterest, ask the user which board to pin to unless they already named one, and pass that board's id as pinterestConfigs[].boardId in create_post, update_post or bulk_schedule_posts. When the user named a board you may pass that name as boardName instead, never both; a name that matches no board, or several, fails with 400 and nothing falls back. A board belongs to one Pinterest account, so call it once per Pinterest account. A post sent without boardId or boardName goes to a public board named AdaptlyPost, which is created on first use. Fails with 404 when accountId is not a Pinterest account in the workspace, and with 400 when Pinterest refuses the request, which usually means the user must reconnect the account in AdaptlyPost. Nothing is posted.",
      inputSchema: {
        accountId: z
          .string()
          .describe('The Pinterest account id from list_accounts'),
      },
      outputSchema: resultSchema(
        'An object with boards: one { id, name, description, privacy, pinCount } per board. Pass id as pinterestConfigs[].boardId, or name as boardName.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ accountId }, client) => {
      try {
        const data = await client.get(
          `/social-accounts/${encodeURIComponent(accountId)}/pinterest-boards`,
        );
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'check_account',
    {
      title: 'Check Account',
      description:
        "Re-check a Facebook page with Facebook now, using its stored token, and return its fresh status. A rejected token marks the page unauthorized (unauthorizedReason carries Facebook's message); a working token clears an earlier unauthorized mark. Facebook pages only: any other account fails with 400. Pages are also checked automatically twice a day. Use it after the user reconnects or fixes a page, or when a Facebook post failed with a token error. Needs the accounts.manage permission, which Admin holds. Nothing is posted.",
      inputSchema: {
        accountId: z.string().describe('The Facebook account id from list_accounts, or its pageId'),
      },
      outputSchema: resultSchema(
        'An object with id, platform, displayName, pageId, status (active or unauthorized), unauthorizedReason when unauthorized, and checkedAt.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ accountId }, client) => {
      try {
        const data = await client.post(`/social-accounts/${encodeURIComponent(accountId)}/check`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'remove_account',
    {
      title: 'Remove Account',
      description:
        'Disconnect a social account from the workspace, the same way the Connectors page does: its stored tokens are deleted, it is taken off every pending and recurring post, and it stops counting toward the plan. Works for accounts in any status, so an unauthorized account can be cleaned up without reconnecting it. For Facebook only the named page goes; the other pages of the same login stay connected. Posts already published stay on the network. Confirm with the user first, naming the account. Bringing it back means connecting it again in AdaptlyPost (create_connect_link can send a link). Needs the accounts.manage permission, which Admin holds.',
      inputSchema: {
        accountId: z.string().describe('The account id from list_accounts, or the Facebook pageId'),
      },
      outputSchema: resultSchema('An object with id, platform, displayName, pageId for Facebook, and removed: true.'),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    async ({ accountId }, client) => {
      try {
        const data = await client.delete(`/social-accounts/${encodeURIComponent(accountId)}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'create_connect_link',
    {
      title: 'Create Connect Link',
      description:
        "Create a link someone else, such as a client, opens to connect their social accounts to this workspace without an AdaptlyPost login. With no options it is a quick link: it lasts 7 days, offers every platform, shows the client every account in the workspace and connects any number of accounts. visibility PRIVATE shows the client only the accounts they connected through the link; allowedPlatforms limits the platforms offered; maxAccounts makes the link stop working once that many accounts are connected through it; expiresAt or neverExpires changes when it stops working. Returns the url to send. Connected accounts then show up in list_accounts. Revoke it with revoke_connect_link. Needs the accounts.manage permission, which Admin holds.",
      inputSchema: {
        name: z.string().max(80).optional().describe('Label shown in the dashboard list of links (max 80 characters)'),
        visibility: z
          .enum(['PUBLIC', 'PRIVATE'])
          .optional()
          .describe('PRIVATE shows the client only the accounts they connected through this link. Defaults to PUBLIC'),
        allowedPlatforms: z
          .array(PlatformType)
          .optional()
          .describe('Platforms the client can pick. Omit or send [] for every platform'),
        maxAccounts: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Accounts the link can connect in total. Reconnecting an account it already connected does not count again'),
        expiresAt: z
          .string()
          .optional()
          .describe(
            'When the link stops working, as an ISO 8601 date-time with a Z or ±hh:mm offset (e.g. "2026-11-30T23:59:59Z"). At least 1 hour and at most 365 days from now. Defaults to 7 days from now. Leave it out when neverExpires is true',
          ),
        neverExpires: z
          .boolean()
          .optional()
          .describe('true keeps the link working until it is revoked or reaches maxAccounts. Cannot be combined with expiresAt'),
      },
      outputSchema: resultSchema(
        'An object with url (the link to send), token (pass it to revoke_connect_link), expiresAt (null when it never expires), name, visibility, allowedPlatforms and maxAccounts.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/connect-links', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'revoke_connect_link',
    {
      title: 'Revoke Connect Link',
      description:
        'Revoke a connect link so it stops working at once. Accounts already connected through it stay connected; remove them with remove_account. Needs the accounts.manage permission, which Admin holds. Returns { success: true }.',
      inputSchema: {
        token: z.string().describe('The token returned by create_connect_link'),
      },
      outputSchema: resultSchema('An object with success: true once the link is revoked.'),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ token }, client) => {
      try {
        const data = await client.delete(`/connect-links/${encodeURIComponent(token)}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Media Upload ────────────────────────────────────────────────────────

  tool(
    'upload_media',
    {
      title: 'Upload Media',
      description:
        'Upload images, videos or documents to AdaptlyPost storage and return public URLs for the mediaUrls of create_post, update_post, or bulk_schedule_posts. Three sources, combinable in one call: attachments (files the user attached in a ChatGPT conversation, which ChatGPT passes as file references; use this for every file attached in ChatGPT, whatever its size), urls (public https URLs the server streams straight into storage; private, internal and non-https addresses are refused) and files (base64 data, for small media attached in other apps; 30 MB decoded per call in total). Omitting all three returns an error. Accepts JPEG, PNG, WebP, GIF, MP4 and QuickTime, plus PDF, PPT, PPTX, DOC and DOCX for LinkedIn DOCUMENT posts, checked by file content (and, for Office files, the extension, so keep it in the name or URL); 50 MB per image, 100 MB per document, 250 MB per attachment or URL download. Stored files are public immediately, post or no post, so only upload media the user supplied or asked for. For base64 files over 30 MB use get_upload_urls and PUT the bytes yourself. Returns uploaded ({ publicUrl, key } per file) and mediaUrls; pass mediaUrls straight into the post. One publicUrl may be reused across any number of posts; the file is kept until the last post referencing it has published, so upload once and reuse rather than re-uploading per post.',
      inputSchema: {
        attachments: z
          .array(
            z.object({
              download_url: z.string().describe('Temporary download URL of the attached file'),
              file_id: z.string().describe('ChatGPT file id of the attached file'),
              mime_type: z.string().nullish().describe('MIME type of the attached file'),
              file_name: z.string().nullish().describe('Name of the attached file, with its extension'),
            }).passthrough(),
          )
          .optional()
          .describe(
            'Files the user attached in the ChatGPT conversation: images, videos or documents, up to 250 MB each. ChatGPT fills in each file reference; put every attached file the user wants to post here',
          ),
        urls: z
          .array(z.string())
          .optional()
          .describe(
            'Public https URLs of images, videos or documents to upload (e.g. ["https://example.com/photo.jpg", "https://example.com/deck.pdf"])',
          ),
        files: z
          .array(
            z.object({
              data: z
                .string()
                .describe('Base64-encoded file content'),
              fileName: z
                .string()
                .describe('File name with extension (e.g. "photo.jpg" or "deck.pptx")'),
              mimeType: UploadMimeType.describe('MIME type of the file'),
            }),
          )
          .optional()
          .describe(
            'Direct file uploads as base64, 30 MB decoded per call in total. Use this for small media attached in apps other than ChatGPT; in ChatGPT use attachments',
          ),
      },
      outputSchema: resultSchema(
        'An object with uploaded (array of { publicUrl, key } per file) and mediaUrls (the public URLs ready to pass to create_post).',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
      _meta: { 'openai/fileParams': ['attachments'] },
    },
    async ({ attachments, urls, files }, client) => {
      try {
        if (!attachments?.length && !urls?.length && !files?.length) {
          throw new Error(
            'Provide at least one of: attachments (files attached in ChatGPT), urls (public URLs) or files (base64 data)',
          );
        }

        if (files?.length) requireInlineBudget(files);

        const results: Uploaded[] = [];
        for (const a of attachments ?? []) results.push(await uploadFromAttachment(client, a));
        for (const u of urls ?? []) results.push(await uploadFromUrl(client, u));
        for (const f of files ?? []) results.push(await uploadFromBase64(client, f.data, f.fileName));

        return toolResult({
          uploaded: results.map((r) => ({
            publicUrl: r.publicUrl,
            key: r.key,
          })),
          mediaUrls: results.map((r) => r.publicUrl),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_upload_urls',
    {
      title: 'Get Media Upload URLs',
      description:
        'Get presigned upload URLs for direct file uploads. Returns uploadUrl (PUT your file here) and publicUrl (use in create_post mediaUrls). This only mints a URL. You MUST PUT the file to uploadUrl and confirm a 2xx response before using publicUrl, otherwise create_post/bulk rejects it with "Media file(s) not found in storage". If the PUT cannot reach uploadUrl, for example a sandbox network proxy answers 403 or the storage host is not on its allowlist, do not retry it and do not stop: hand the files to the user as downloads, call open_upload_widget, and ask the user to add them in the upload box, which returns the mediaUrls. Prefer upload_media for public URLs and for inline files under 30 MB; use this for larger files you hold yourself. For each file, provide fileName and mimeType. Supported types: image/jpeg, image/png, image/webp, image/gif (Facebook, X, Bluesky, Mastodon, LinkedIn and Tumblr only), video/mp4, video/quicktime, and for LinkedIn DOCUMENT posts application/pdf, application/vnd.ms-powerpoint, application/vnd.openxmlformats-officedocument.presentationml.presentation, application/msword and application/vnd.openxmlformats-officedocument.wordprocessingml.document; keep the extension in fileName, since the post reads the file type from it. A publicUrl may be reused across any number of posts; the file is kept until the last post referencing it has published.',
      inputSchema: {
        files: z
          .array(
            z.object({
              fileName: z.string().describe('File name with extension'),
              mimeType: UploadMimeType.describe('MIME type of the file'),
            }),
          )
          .min(1)
          .max(20)
          .describe('Files to get upload URLs for'),
      },
      outputSchema: resultSchema(
        'An object with urls: one { uploadUrl, publicUrl, key } entry per requested file.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ files }, client) => {
      try {
        const data = await client.post('/upload-urls', { files });
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const uploadWidgetMeta = {
    ui: {
      csp: { connectDomains: [PUBLIC_ORIGIN, STORAGE_UPLOAD_ORIGIN], resourceDomains: [] },
      prefersBorder: true,
    },
    'openai/widgetCSP': {
      connect_domains: [PUBLIC_ORIGIN, STORAGE_UPLOAD_ORIGIN],
      resource_domains: [],
    },
    'openai/widgetPrefersBorder': true,
    'openai/widgetDomain': 'https://adaptlypost.com',
    'openai/widgetDescription':
      "An upload box where the user adds photos, videos and documents from their own device.",
  };

  server.registerResource(
    'upload_widget',
    UPLOAD_WIDGET_URI,
    {
      title: 'AdaptlyPost upload box',
      description: 'Upload box shown by open_upload_widget.',
      mimeType: MCP_APP_MIME_TYPE,
      _meta: uploadWidgetMeta,
    },
    async () => ({
      contents: [
        {
          uri: UPLOAD_WIDGET_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: uploadWidgetHtml(PUBLIC_ORIGIN),
          _meta: uploadWidgetMeta,
        },
      ],
    }),
  );

  tool(
    'open_upload_widget',
    {
      title: 'Upload From Device',
      description:
        "Show an upload box in the chat so the user can add photos, videos or documents from their phone or computer. Use it when the user wants to post a file that has no public URL, such as a photo on their phone, a file attached in the chat that upload_media cannot read (in ChatGPT, pass attached files to upload_media as attachments instead), or a file you built in a sandbox whose network blocks the get_upload_urls uploadUrl. Nothing is uploaded until the user picks files in the box. When the upload finishes, the box sends a message listing the public media URLs; pass them as mediaUrls to create_post, update_post or bulk_schedule_posts. Accepts JPEG, PNG, WebP, GIF, MP4, QuickTime, PDF, PPT, PPTX, DOC and DOCX, up to 250 MB per file, 50 MB per image and 100 MB per document. Uploaded files are stored at public URLs. The box only appears in apps that show MCP Apps widgets, such as ChatGPT and Claude; elsewhere ask the user for a public URL and use upload_media.",
      inputSchema: {},
      outputSchema: resultSchema(
        'An object with status waiting_for_upload. The media URLs arrive later, in a message the upload box sends when the user finishes.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: { resourceUri: UPLOAD_WIDGET_URI },
        'ui/resourceUri': UPLOAD_WIDGET_URI,
        'openai/outputTemplate': UPLOAD_WIDGET_URI,
        'openai/toolInvocation/invoking': 'Opening the upload box',
        'openai/toolInvocation/invoked': 'Upload box ready',
      },
    },
    async () => {
      if (!uploadTicketsEnabled()) {
        return toolError(
          new Error(
            'Uploading from a device is not available on this server. Ask the user for a public URL and use upload_media.',
          ),
        );
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: 'The upload box is showing. Wait for the user to upload; the box sends the media URLs in a message when it finishes.',
          },
        ],
        structuredContent: { result: { status: 'waiting_for_upload' } },
      };
    },
  );

  tool(
    'get_upload_ticket',
    {
      title: 'Get Upload Ticket',
      description:
        'Called by the upload box that open_upload_widget shows, once per file, to authorize storing that file in AdaptlyPost media storage. Returns a ticket valid for 5 minutes. Do not call this yourself; call open_upload_widget instead.',
      inputSchema: {},
      outputSchema: resultSchema('An object with expiresAt and uploadUrl for the upload box.'),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: { visibility: ['app'] },
        'openai/widgetAccessible': true,
        'openai/visibility': 'private',
      },
    },
    async (_args, client) => {
      try {
        const { ticket, expiresAt } = await sealUploadTicket(client.credentials());
        return {
          content: [{ type: 'text' as const, text: `Upload ticket issued, valid until ${expiresAt}.` }],
          structuredContent: { result: { expiresAt, uploadUrl: UPLOAD_ENDPOINT } },
          _meta: { uploadTicket: ticket },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Post CRUD ──────────────────────────────────────────────────────────

  tool(
    'create_post',
    {
      title: 'Create Post',
      description:
        'Create one post on the user\'s own connected social accounts. saveAsDraft saves a DRAFT and publishes nothing; a scheduledAt sent with it becomes the draft\'s planned date, which publish_draft later schedules. Without saveAsDraft, a future scheduledAt schedules the post; otherwise it publishes now. Before publishing or scheduling, show the user the final text, media, accounts and time (or repeat schedule) and get their confirmation; a draft needs no confirmation. Account ids come from list_accounts (pass them as accountIds, or as platforms plus the per-platform arrays) and mediaUrls from upload_media. Platform-specific options (TikTok privacy, Pinterest board, LinkedIn document or reshare, Google Business event or offer, Tumblr tags, Instagram user tags, Facebook link carousel, first comments, threads of replies, recurrence) are described on each field. To find every problem before creating anything, call validate_post with the same input first. Publishing runs per platform in the background, so the response ({ postId, queuedPlatforms, isScheduled, scheduledAt }) is not the outcome; check list_post_results. Each call creates a separate post, so after an error or timeout check list_posts before trying again. Use update_post or publish_draft for an existing post and bulk_schedule_posts for many posts.',
      inputSchema: createPostShape,
      outputSchema: resultSchema(
        'An object with postId, queuedPlatforms (platforms whose publishing job was queued; empty for scheduled posts and drafts), skippedPlatforms, isScheduled, and scheduledAt, plus recurringPostId when recurrence was sent. Publishing is asynchronous: check list_post_results for outcomes.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/social-posts', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'validate_post',
    {
      title: 'Validate Post',
      description:
        'Dry-run create_post: takes exactly the same input and runs every check creating the post would run, plus the ones that usually fail only at publish time (TikTok creator limits, YouTube upload quota, expired tokens, Pinterest boards, X credits), without creating a post, uploading media or writing anything. Nothing is published, so no confirmation is needed. Always returns a report: valid is false when any issue has severity ERROR. Issues tied to one account are listed under that account in accounts (status READY, WARNING or BLOCKED); the rest are in issues, each with a stable code, severity and message. outcome says what creating the post would do (DRAFT, SCHEDULED or PUBLISH_NOW), and requiredPermissions names the permissions it would need; a missing one shows up as a PERMISSION_DENIED issue. notChecked lists what only the platform decides at publish time, so valid: true is not a guarantee. Fix every ERROR, then call create_post with the same input. Needs the posts.draft permission.',
      inputSchema: createPostShape,
      outputSchema: resultSchema(
        'A validation report: valid, outcome (DRAFT, SCHEDULED or PUBLISH_NOW), scheduledAt, requiredPermissions, issues (each { code, severity ERROR or WARNING, message, platform, connectionId }), accounts (each { platform, connectionId, accountName, status READY, WARNING or BLOCKED, issues }), and notChecked (each { code, message }).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/social-posts/validate', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_post',
    {
      title: 'Get Post',
      description:
        'Get one post\'s full record by id: text, contentType, status, scheduledAt, timezone, and a platforms array with each target\'s connection, status, errorMessage, and media. Visible only within the workspace (the current one unless workspaceId names another); any other id returns "Post not found or access denied". Use this to inspect content before update_post or publish_draft. Use list_post_results instead when you only need per-platform publishing outcomes and the platformIds for retry_failed_platforms, and list_posts to find ids by status, platform, or date. Post ids come from create_post, bulk_schedule_posts, or list_posts.',
      inputSchema: {
        id: z
          .string()
          .describe('Post ID from create_post, bulk_schedule_posts, or list_posts'),
      },
      outputSchema: resultSchema(
        'The full post record: id, status, contentType, text, scheduledAt, timezone, mediaUrls, createdAt, updatedAt, recurringPostId and occurrenceAt (set when the post is an occurrence of a recurring post; occurrenceAt is its slot in the series and stays the same when the post is rescheduled), and platforms (one entry per target with id, platform, connectionId or pageId, status, errorMessage, platformPostId, postUrl once published, mediaUrls, previewUrls, and the per-platform settings: firstComment with firstCommentStatus PENDING, PUBLISHED or FAILED, firstCommentError and firstCommentPublishedAt; threadReplies with threadStatus, threadReplyIds, threadError and threadPublishedAt; thumbnailUrl and thumbnailTimestampMs overrides; mediaAspectRatio and mediaAspectRatioFit; instagramCollaborators, instagramUserTags, instagramUntaggedUsernames (tags Instagram refused), instagramAiGenerated, instagramUsername and instagramAudioId, instagramAudioTitle, instagramAudioArtist, instagramAudioVolume, instagramVideoVolume; facebookTextFormatPresetId, facebookImageLayout and facebookCarouselCards; youtubeAiGenerated; linkedinDocumentTitle and linkedinReshareOf; twitterKeepLinks; tumblrTags, tumblrTitle and tumblrSourceUrl; googleBusinessTopicType, googleBusinessCallToActionType, googleBusinessCallToActionUrl, googleBusinessEventTitle, googleBusinessEventStart, googleBusinessEventEnd and googleBusinessOffer fields). postUrl links to the published post on every platform; Instagram and Facebook stories expire after 24 hours, so for them it links to the profile or page. A shareToStory story is its own entry with postType STORY. previewUrls holds one permanent preview image per media item, a still frame for videos; after publishing, mediaUrls may become platform CDN links that expire within days, so show previewUrls instead.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.get(`/social-posts/${id}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'list_posts',
    {
      title: 'List Posts',
      description:
        'List posts in the workspace (the current one unless workspaceId names another), any status, newest first by default. Returns { posts, total, hasMore }; each post carries its status and a platforms array with per-platform status. Filters: statuses, platforms (posts targeting any of them), and startDate/endDate, which bound scheduledAt, or createdAt for posts never scheduled. limit is 1 to 100 (default 20); page with offset while hasMore is true. Use this to find post ids or check what is already queued. Use get_post for one post\'s full record and list_post_results for one post\'s per-platform outcomes and retry ids.',
      inputSchema: {
        statuses: z
          .array(PostStatus)
          .optional()
          .describe('Filter by status (e.g. ["SCHEDULED", "DRAFT"]); omit for all statuses'),
        platforms: z
          .array(PlatformType)
          .optional()
          .describe(
            'Filter to posts targeting any of these platforms',
          ),
        startDate: z
          .string()
          .optional()
          .describe(
            'Lower bound (ISO 8601, e.g. "2026-03-01") on scheduledAt, or createdAt for posts never scheduled',
          ),
        endDate: z
          .string()
          .optional()
          .describe(
            'Upper bound (ISO 8601, e.g. "2026-03-31") on scheduledAt, or createdAt for posts never scheduled',
          ),
        sortOrder: PostSortOrder.optional().describe('NEWEST (default) or OLDEST'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Max results, 1 to 100'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe('Posts to skip; increase by limit while hasMore is true'),
      },
      outputSchema: resultSchema(
        'An object with posts (each with id, status, contentType, text, scheduledAt, timezone, recurringPostId and occurrenceAt for occurrences of a recurring post, and platforms with per-platform status), total (count of all matches), and hasMore.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.get('/social-posts', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'update_post',
    {
      title: 'Update Post',
      description:
        'Update a DRAFT or SCHEDULED post in place; any other status fails with "Cannot edit post in current state", so published posts cannot be changed. Updates are partial: text, contentType, scheduledAt, timezone, thumbnail fields, firstComments and platformThumbnails you omit keep their values; sending firstComments or platformThumbnails replaces every stored entry. The exception is platforms: sending it rebuilds the post\'s target set from this request alone, so include every connection-id array and platform config you want to keep (TikTok with privacyLevel, Pinterest with its boardId or boardName); omitting platforms leaves accounts, configs, and media untouched. mediaUrls only take effect together with platforms; use publicUrl values from upload_media. On SCHEDULED posts new media is verified in storage. Returns the updated post record. Use publish_draft to change a draft\'s status, unschedule_post to take a scheduled post off the calendar, delete_post to cancel, and create_post for a new post.',
      inputSchema: {
        id: z.string().describe('Post ID to update (must be DRAFT or SCHEDULED)'),
        text: z
          .string()
          .optional()
          .describe(`Updated text; omit to keep the current text. ${LINKEDIN_MENTION_RULE}`),
        platforms: z
          .array(PlatformType)
          .optional()
          .describe(
            'New target platforms. Sending this replaces every target, so also resend the connection-id arrays and platform configs to keep; omit to leave targets unchanged',
          ),
        contentType: ContentType.optional().describe(
          `New content type; must match the media on the post. ${CAROUSEL_RULE}. ${GOOGLE_BUSINESS_RULE}. ${DOCUMENT_POST_RULE}`,
        ),
        scheduledAt: z
          .string()
          .optional()
          .describe(
            'New schedule time as an absolute ISO 8601 instant; omit to keep. On a DRAFT it sets the planned date and the post stays a draft. Moving a SCHEDULED post more than a minute into the past fails with 400; use publish_draft to publish now',
          ),
        timezone: z
          .string()
          .optional()
          .describe('IANA timezone stored for display; does not shift scheduledAt'),
        mediaUrls: z
          .array(z.string())
          .optional()
          .describe(
            'Replacement media URLs, applied only when platforms is also sent. Use publicUrl values from upload_media or get_upload_urls',
          ),
        mediaAltTexts: z
          .array(z.string().max(1000))
          .optional()
          .describe(`${ALT_TEXT_RULE}. Applied only when platforms is also sent`),
        ...postThumbnailFields,
        platformTexts: platformTextsField.describe(
          'Per-platform caption overrides; applied to the targets sent in platforms',
        ),
        ...postExtrasFields,
        ...twitterKeepLinksField,
        ...connectionIdFields,
        ...platformConfigFields,
        ...linkedinConfigsField,
      },
      outputSchema: resultSchema(
        'The updated post record: id, status (still DRAFT or SCHEDULED), text, contentType, scheduledAt, timezone, and platforms with per-target details.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    async ({ id, ...rest }, client) => {
      try {
        const data = await client.patch(`/social-posts/${id}`, rest);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'delete_post',
    {
      title: 'Delete Post',
      description:
        'Delete a post record from AdaptlyPost by id. Use it to cancel a DRAFT or SCHEDULED post before it goes out; a deleted scheduled post will not publish. Deleting never removes content already on a network: for a COMPLETED or PARTIAL_FAILURE post this only drops AdaptlyPost\'s record, and the live posts stay up until removed on each platform. Prefer update_post to change a post instead of deleting and recreating it. A post in PUBLISHING fails with 409; wait for list_post_results to settle. Only posts in the workspace (the current one unless workspaceId names another) can be deleted; others return "Post not found or access denied". Returns { deleted: true }. Irreversible.',
      inputSchema: {
        id: z.string().describe('Post ID to delete, from list_posts or create_post'),
      },
      outputSchema: resultSchema(
        'An object with deleted: true once the post record is removed from AdaptlyPost.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.delete(`/social-posts/${id}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'unschedule_post',
    {
      title: 'Unschedule Post',
      description:
        'Take a DRAFT or SCHEDULED post off the calendar without deleting it: the post becomes an undated DRAFT (status DRAFT, scheduledAt null) and nothing publishes. Use it when the user wants to hold a scheduled post back; schedule it again later with publish_draft and a scheduledAt, and use delete_post only to drop it entirely. Any other status (PENDING, PUBLISHING, COMPLETED, FAILED, PARTIAL_FAILURE) fails with 400 because the post is already going out or out. Ids outside the workspace (the current one unless workspaceId names another) return 404. Safe to repeat on a post that is already an undated draft. Returns the post record.',
      inputSchema: {
        id: z.string().describe('Post ID with status DRAFT or SCHEDULED, from list_posts or create_post'),
      },
      outputSchema: resultSchema(
        'The post record as an undated draft: id, status DRAFT, scheduledAt null, text, contentType, timezone, and platforms with per-target details.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.post(`/social-posts/${id}/unschedule`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Publishing / Results ───────────────────────────────────────────────

  tool(
    'publish_draft',
    {
      title: 'Publish Draft',
      description:
        'Publish a DRAFT post now or schedule it; SCHEDULED posts are accepted too, to reschedule or push live. Other statuses fail with "Post is not a draft". A future scheduledAt sets SCHEDULED for that time and queues nothing yet; a past one publishes now. Without scheduledAt, a draft whose planned date (the scheduledAt it was saved with) is still in the future is SCHEDULED for that date, and any other post (an undated draft, a planned date already past, a SCHEDULED post) publishes now. publishNow: true publishes now even when the draft has a planned date; sending it with scheduledAt fails with 400. Read the draft with get_post first and tell the user which of these will happen. Publishing now clears the stored scheduledAt, moves the post to PENDING and queues a publishing job per platform: content reaches the networks within moments and cannot be recalled. Fails if an account was disconnected or a TikTok entry lacks privacyLevel; fix with update_post first. Not for new content, use create_post. Check list_post_results afterwards for per-platform outcomes.',
      inputSchema: {
        id: z.string().describe('Post ID with status DRAFT (or SCHEDULED)'),
        scheduledAt: z
          .string()
          .optional()
          .describe(
            'Absolute ISO 8601 instant (e.g. "2026-03-15T10:00:00Z"). A future time schedules for that time instead of the draft\'s planned date; a past time publishes now. Omit to schedule for the planned date when it is still in the future, and to publish now otherwise',
          ),
        publishNow: z
          .boolean()
          .optional()
          .describe(
            'Publish now even when the draft has a planned date in the future. Sending it with scheduledAt fails with 400',
          ),
        timezone: z
          .string()
          .default('UTC')
          .describe(
            'IANA timezone stored with the post for display (e.g. "America/New_York"); it does not shift scheduledAt',
          ),
      },
      outputSchema: resultSchema(
        'An object with postId, queuedPlatforms (platforms whose publishing job was queued; empty when scheduled for later), isScheduled, and scheduledAt.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    async ({ id, ...body }, client) => {
      try {
        const data = await client.post(`/social-posts/${id}/publish`, body);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'list_post_results',
    {
      title: 'List Post Results',
      description:
        'Get one post\'s per-platform publishing outcomes: { postId, status, results[] } where each result has platformId, platform, accountName, status (PENDING, PUBLISHING, PUBLISHED, or FAILED), platformPostId, errorMessage, publishedAt, and tiktokDraftFallback (true when TikTok\'s daily cap sent the content to the TikTok inbox as a draft instead of publishing it; tell the user to finish it in the TikTok app). Each platform reports separately, so read every row instead of treating the post as one pass or fail. Call this after create_post, publish_draft, or retry_failed_platforms, since publishing is asynchronous and their responses only confirm queueing; poll until no row is PENDING or PUBLISHING. Take platformId from FAILED rows for retry_failed_platforms. Use get_post when you also need the content and schedule.',
      inputSchema: {
        id: z
          .string()
          .describe('Post ID from create_post, publish_draft, bulk_schedule_posts, or list_posts'),
      },
      outputSchema: resultSchema(
        'An object with postId, the overall post status, and results: one { platformId, platform, accountName, status, platformPostId, errorMessage, tiktokDraftFallback, publishedAt } per targeted platform.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.get(`/social-posts/${id}/results`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'retry_failed_platforms',
    {
      title: 'Retry Failed Platforms',
      description:
        'Re-queue publishing for a post\'s FAILED platforms. platformIds takes platformId values from list_post_results, platform names such as "BLUESKY" (every failed row of that platform), or can be omitted to retry every failed row. Only rows with status FAILED are reset to PENDING and retried with the same content. A value matching neither a row id nor a platform of the post fails with "Unknown retry target"; with nothing failed among the matches the call fails with "No failed platforms to retry". The post moves to PUBLISHING and the retry is asynchronous, so check list_post_results for the outcome. Read each errorMessage first and retry once the cause is fixed (reconnected account, replaced media), not for a platform-side restriction, which will just fail again. Content cannot change on retry.',
      inputSchema: {
        id: z.string().describe('Post ID whose platforms failed'),
        platformIds: z
          .array(z.string())
          .optional()
          .describe(
            'platformId values from list_post_results or platform names such as "BLUESKY". Omit to retry every FAILED row',
          ),
      },
      outputSchema: resultSchema(
        'An object with postId, queuedPlatforms (platforms re-queued for publishing), and isScheduled: false. Outcomes arrive asynchronously in list_post_results.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    async ({ id, platformIds }, client) => {
      try {
        const data = await client.post(`/social-posts/${id}/retry`, {
          platformIds,
        });
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Bulk Scheduling ────────────────────────────────────────────────────

  tool(
    'bulk_schedule_posts',
    {
      title: 'Bulk Schedule Posts',
      description:
        'Schedule up to 100 posts in one call to the same platforms and accounts. Each item supplies its own text, contentType, scheduledAt, and optional media; platforms, connection-id arrays, timezone, and platform configs are shared by every item, though an item may carry its own tiktokConfigs, youtubeConfigs, instagramConfigs, facebookConfigs, pinterestConfigs, googleBusinessConfigs or tumblrConfigs to replace the shared ones, plus its own firstComments, threadReplies, platformThumbnails and platformAspectRatios. twitterKeepLinks and linkedinConfigs are not available in bulk. Call validate_bulk_posts with the same input first to see the problems of every item without creating anything. Items are processed independently: each is validated and created like create_post, so one bad item fails alone while the rest are scheduled. Returns { totalScheduled, totalFailed, results[] } with a postId or errorMessage per item, in input order; read every row. An item with a past scheduledAt publishes immediately rather than being rejected. Call list_accounts first; TikTok needs tiktokConfigs with privacyLevel, and Pinterest takes pinterestConfigs with a boardId from list_pinterest_boards or a boardName, not both; an item whose boardName matches no board or several fails alone. Use create_post for a single post or a draft; this tool has no draft mode. These posts publish publicly to the user\'s social accounts: show the user every item\'s text, media and time plus the accounts, and get their confirmation before calling. Each call creates new posts, so calling again after an error or timeout can publish duplicates; check list_posts first.',
      inputSchema: bulkPostsShape,
      outputSchema: resultSchema(
        'An object with totalScheduled, totalFailed, and results: one { postId, success, isScheduled, scheduledAt, errorMessage } per input item, in input order.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/social-posts/bulk', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'validate_bulk_posts',
    {
      title: 'Validate Bulk Posts',
      description:
        'Dry-run bulk_schedule_posts: takes exactly the same input and returns one validation report per item, in input order, without creating, uploading or writing anything. Nothing is published, so no confirmation is needed. Each report has valid, outcome, requiredPermissions, issues, accounts and notChecked, as in validate_post. Fix the items with ERROR issues, then call bulk_schedule_posts. Needs the posts.draft permission.',
      inputSchema: bulkPostsShape,
      outputSchema: resultSchema(
        'An object with valid (true when every item is valid), totalValid, totalInvalid, and results: one { index, report } per item, where report has the validate_post shape.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/social-posts/bulk/validate', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Recurring Posts ────────────────────────────────────────────────────

  tool(
    'list_recurring_posts',
    {
      title: 'List Recurring Posts',
      description:
        'List the recurring posts (series) in the workspace (the current one unless workspaceId names another), created by passing recurrence to create_post. Returns { recurringPosts, total, hasMore }; each series has id, status (ACTIVE, PAUSED or ENDED), pauseReason when paused, frequency, interval, weekdays, startsAt, timezone, endsOn or maxOccurrences, nextOccurrenceAt, occurrenceCount, and the content and platforms every occurrence copies. Only the next occurrence of an ACTIVE series exists as a SCHEDULED post, created about 24 hours ahead; list_posts shows it with recurringPostId set. A series pauses itself after 3 failed posts in a row, when the subscription lapses, when its creator loses workspace access, when one of its accounts is disconnected, or when a platform rejects the content; pauseReason and lastError say which. limit is 1 to 100 (default 20); page with offset while hasMore is true. Editing a series or skipping one date is only possible in the AdaptlyPost app.',
      inputSchema: {
        statuses: z
          .array(RecurringPostStatus)
          .optional()
          .describe('Filter by status (e.g. ["ACTIVE", "PAUSED"]); omit for all statuses'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Max results, 1 to 100'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe('Recurring posts to skip; increase by limit while hasMore is true'),
      },
      outputSchema: resultSchema(
        'An object with recurringPosts (each with id, status, pauseReason, lastError, frequency, interval, weekdays, startsAt, timezone, endsOn, maxOccurrences, nextOccurrenceAt, occurrenceCount, contentType, text, mediaUrls, platformTypes, and platforms), total (count of all matches), and hasMore.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.get('/recurring-posts', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_recurring_post',
    {
      title: 'Get Recurring Post',
      description:
        'Get one recurring post (series) by id: status, pauseReason and lastError when paused, the schedule (frequency, interval, weekdays, startsAt, timezone, endsOn, maxOccurrences), nextOccurrenceAt (the next slot not yet created as a post; absent once ENDED), occurrenceCount (posts created so far), and the content and platforms each occurrence copies. Ids outside the workspace (the current one unless workspaceId names another) return "Recurring post not found". Ids come from list_recurring_posts, the recurringPostId returned by create_post, or the recurringPostId on a post from get_post or list_posts.',
      inputSchema: {
        id: z
          .string()
          .describe('Recurring post ID from list_recurring_posts, create_post, or a post\'s recurringPostId'),
      },
      outputSchema: resultSchema(
        'The recurring post: id, userId, status, pauseReason, lastError, frequency, interval, weekdays, startsAt, timezone, endsOn, maxOccurrences, nextOccurrenceAt, occurrenceCount, contentType, text, mediaUrls, mediaAltTexts, thumbnailUrl, platformTypes, platforms, createdAt, and updatedAt.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.get(`/recurring-posts/${id}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'pause_recurring_post',
    {
      title: 'Pause Recurring Post',
      description:
        'Pause a recurring post: it stops creating occurrences and deletes its upcoming SCHEDULED post, preventing future scheduled occurrences until resume_recurring_post; an occurrence already publishing may still complete. Posts already published are kept. Slots that pass while paused are skipped, never published later. Use it when the user wants to hold the series; use delete_recurring_post to stop it for good. Deleting only the upcoming post with delete_post skips that one date and the series continues. Ids outside the workspace (the current one unless workspaceId names another) return "Recurring post not found". Returns the recurring post with status PAUSED and pauseReason USER.',
      inputSchema: {
        id: z.string().describe('Recurring post ID to pause, from list_recurring_posts'),
      },
      outputSchema: resultSchema(
        'The paused recurring post: id, status PAUSED, pauseReason USER, the schedule, occurrenceCount, and the content and platforms.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.post(`/recurring-posts/${id}/pause`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'resume_recurring_post',
    {
      title: 'Resume Recurring Post',
      description:
        'Resume a PAUSED recurring post. It continues from the next occurrence after now; slots missed while paused are not published. The next occurrence is created as a SCHEDULED post about 24 hours before it goes out and then publishes to the networks, so confirm with the user first. If the series has no slot left (endsOn passed or maxOccurrences reached) it comes back ENDED instead. When pauseReason is CONNECTION_REMOVED, ACCESS_LOST, SUBSCRIPTION_INACTIVE or INVALID_CONTENT, fix the cause first or the series pauses again. Ids outside the workspace (the current one unless workspaceId names another) return "Recurring post not found". Returns the recurring post with its new status and nextOccurrenceAt.',
      inputSchema: {
        id: z.string().describe('Recurring post ID to resume, from list_recurring_posts'),
      },
      outputSchema: resultSchema(
        'The resumed recurring post: id, status (ACTIVE, or ENDED when no slot is left), nextOccurrenceAt, the schedule, occurrenceCount, and the content and platforms.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.post(`/recurring-posts/${id}/resume`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'delete_recurring_post',
    {
      title: 'Delete Recurring Post',
      description:
        'Delete a recurring post: the series stops for good and its upcoming SCHEDULED post is deleted. Posts that already went out are kept. Prefer pause_recurring_post when the user may want the series back. To skip a single date, delete that occurrence with delete_post instead; the series continues. Ids outside the workspace (the current one unless workspaceId names another) return "Recurring post not found". Returns { deleted: true }. Irreversible.',
      inputSchema: {
        id: z.string().describe('Recurring post ID to delete, from list_recurring_posts'),
      },
      outputSchema: resultSchema(
        'An object with deleted: true once the recurring post is removed.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.delete(`/recurring-posts/${id}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── RSS Feeds ──────────────────────────────────────────────────────────

  const rssFeedIdField = { id: z.string().describe('RSS feed id from list_rss_feeds or create_rss_feed') };

  const rssFeedTarget = z.object({
    platform: RssFeedPlatform,
    connectionId: z.string().describe('Account id from list_accounts'),
    pageId: z.string().optional().describe('Facebook page id from list_accounts. Required for FACEBOOK'),
  });

  const rssFeedSettingsFields = {
    name: z.string().max(120).optional().describe("Name of the feed (max 120 characters). Defaults to the feed's title"),
    targets: z
      .array(rssFeedTarget)
      .min(1)
      .max(20)
      .describe(
        'Accounts every new item is posted to, 1 to 20. Feeds post to FACEBOOK, INSTAGRAM, THREADS, TWITTER, BLUESKY, LINKEDIN, MASTODON, TELEGRAM and GOOGLE_BUSINESS',
      ),
    postMode: RssFeedPostMode.describe(
      'DRAFT creates a draft and needs posts.draft; SCHEDULE schedules the post publishDelayMinutes after the item is found and needs posts.schedule; PUBLISH publishes it right away and needs posts.publish',
    ),
    publishDelayMinutes: z
      .number()
      .int()
      .min(5)
      .max(10080)
      .optional()
      .describe('Minutes between finding an item and its post going out, 5 to 10080. Required when postMode is SCHEDULE'),
    contentMode: RssFeedContentMode.describe(
      'TEMPLATE fills template; AI writes one caption per platform from the article, appends the link, spends 1 AI credit per platform per item and needs ai.generate',
    ),
    template: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Post text with {title}, {link}, {description}, {author} and {feed} (max 2000 characters, default "{title}\\n\\n{link}"). The description, then the title, is shortened to fit each platform; the link is never cut',
      ),
    aiInstructions: z.string().max(1000).optional().describe('Extra instructions for AI captions (max 1000 characters)'),
    includeImage: z
      .boolean()
      .optional()
      .describe("Attach the item's image, or the article's preview image (default true)"),
    twitterKeepLinks: z
      .boolean()
      .optional()
      .describe(
        'Keep links in X posts clickable (default false). Lifetime-deal plans only; each X post with a link then costs more credits. Without it, links on X go out as plain text',
      ),
    includeKeywords: z
      .array(z.string())
      .max(50)
      .optional()
      .describe('Post only items whose title or summary contains one of these (up to 50)'),
    excludeKeywords: z
      .array(z.string())
      .max(50)
      .optional()
      .describe('Skip items whose title or summary contains one of these (up to 50)'),
    maxPostsPerCheck: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('New items posted per check, 1 to 10 (default 3). New items are posted oldest first; the rest wait for the next check'),
    checkIntervalMinutes: z
      .union([
        z.literal(15),
        z.literal(30),
        z.literal(60),
        z.literal(180),
        z.literal(360),
        z.literal(720),
        z.literal(1440),
      ])
      .optional()
      .describe('Minutes between checks: 15, 30, 60 (default), 180, 360, 720 or 1440'),
  };

  const RSS_FEED_RECORD =
    'The RSS feed: id, userId (the member it posts as, whoever last saved it), name, url, siteUrl, status (ACTIVE or PAUSED), pauseReason, lastError, postMode, publishDelayMinutes, contentMode, template, aiInstructions, includeImage, twitterKeepLinks, includeKeywords, excludeKeywords, maxPostsPerCheck, checkIntervalMinutes, targets, nextCheckAt, lastCheckedAt, lastPostedAt, createdAt and updatedAt.';

  tool(
    'list_rss_feeds',
    {
      title: 'List RSS Feeds',
      description:
        'List the RSS and Atom feeds connected to the workspace (the current one unless workspaceId names another), newest first; a workspace holds at most 20. Each new item of a feed becomes a post on its targets. A feed pauses itself after 5 failed fetches in a row (FETCH_FAILURES), 3 items in a row that failed to post (CONSECUTIVE_FAILURES), when its owner loses the permission its post mode needs (ACCESS_LOST), when the plan no longer covers publishing (SUBSCRIPTION_INACTIVE) or when every target account was disconnected (CONNECTION_REMOVED); pauseReason and lastError say which. Needs the posts.read permission. Takes only the optional workspaceId.',
      inputSchema: {},
      outputSchema: resultSchema(`An object with rssFeeds: one record per feed. ${RSS_FEED_RECORD}`),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (_args, client) => {
      try {
        const data = await client.get('/rss-feeds');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_rss_feed',
    {
      title: 'Get RSS Feed',
      description:
        'Get one RSS feed by id: its settings, targets, status, pauseReason and lastError, and when it was last checked and last posted. Use list_rss_feed_items to see what it did with each item. Ids outside the workspace return 404. Needs the posts.read permission.',
      inputSchema: rssFeedIdField,
      outputSchema: resultSchema(RSS_FEED_RECORD),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.get(`/rss-feeds/${encodeURIComponent(id)}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'preview_rss_feed',
    {
      title: 'Preview RSS Feed',
      description:
        'Fetch an RSS or Atom feed without saving it and return its 5 newest items, each with text rendered from template, so the user can see what the posts would say before create_rss_feed. Fails with 400 when the URL is not a feed and 503 when it cannot be reached. Nothing is saved or posted. Needs the posts.draft permission.',
      inputSchema: {
        url: z.string().url().describe('Public http(s) URL of an RSS or Atom feed'),
        template: rssFeedSettingsFields.template,
      },
      outputSchema: resultSchema(
        'An object with url, title, siteUrl and items: one { title, link, summary, publishedAt, imageUrl, text } per item, where text is the item rendered with template.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/rss-feeds/preview', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'create_rss_feed',
    {
      title: 'Create RSS Feed',
      description:
        "Connect an RSS or Atom feed so each new item becomes a post on the target accounts. The feed is fetched and every item already in it is recorded, so only items that appear later are posted; postLatestItem also posts the newest one on the first check. The feed is then checked every checkIntervalMinutes and posts as the member who saved it, as a draft, a scheduled post or straight away (postMode). With postMode SCHEDULE or PUBLISH, posts go out on the user's accounts without further confirmation, so confirm the feed, the accounts, the mode and the text with the user first. Try preview_rss_feed first to show what the posts will say. Fails with 400 for invalid settings, a URL that is not a feed, a feed already connected or the 20-feed workspace limit, and 503 when the feed cannot be reached. Needs posts.draft, plus the permission of the post mode.",
      inputSchema: {
        url: z.string().url().describe('Public http(s) URL of an RSS or Atom feed'),
        postLatestItem: z
          .boolean()
          .optional()
          .describe('Also post the newest item on the first check (default false)'),
        ...rssFeedSettingsFields,
      },
      outputSchema: resultSchema(`The new feed. ${RSS_FEED_RECORD}`),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/rss-feeds', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'update_rss_feed',
    {
      title: 'Update RSS Feed',
      description:
        "Change an RSS feed's settings; only the fields sent change, and the URL cannot change. The feed then posts as the member making the change, so they need the permission of the resulting post mode, plus posts.others when someone else set the feed up. Switching postMode to SCHEDULE or PUBLISH means later items go out without further confirmation, so confirm with the user first. Ids outside the workspace return 404. Needs the posts.draft permission.",
      inputSchema: {
        ...rssFeedIdField,
        ...rssFeedSettingsFields,
        targets: rssFeedSettingsFields.targets.optional(),
        postMode: rssFeedSettingsFields.postMode.optional(),
        contentMode: rssFeedSettingsFields.contentMode.optional(),
      },
      outputSchema: resultSchema(`The updated feed. ${RSS_FEED_RECORD}`),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    async ({ id, ...body }, client) => {
      try {
        const data = await client.patch(`/rss-feeds/${encodeURIComponent(id)}`, body);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'delete_rss_feed',
    {
      title: 'Delete RSS Feed',
      description:
        'Delete an RSS feed: it stops being checked for good. Posts it already created stay. Prefer pause_rss_feed when the user may want it back. Ids outside the workspace return 404. Needs the posts.draft permission. Returns { deleted: true }. Irreversible.',
      inputSchema: rssFeedIdField,
      outputSchema: resultSchema('An object with deleted: true once the feed is removed.'),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.delete(`/rss-feeds/${encodeURIComponent(id)}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'list_rss_feed_items',
    {
      title: 'List RSS Feed Items',
      description:
        "List the items an RSS feed has seen, newest first, leaving out the ones already in the feed when it was added. Each item has a status: PROCESSING, POSTED (postId links it to its post, for get_post), FILTERED (keyword rules), SKIPPED (published more than 14 days before the feed was added) or FAILED (error says why). Use it to answer why an article was or was not posted. Needs the posts.read permission.",
      inputSchema: {
        ...rssFeedIdField,
        limit: z.number().int().min(1).max(100).optional().describe('Max items, 1 to 100 (default 20)'),
      },
      outputSchema: resultSchema(
        'An object with items: one { id, createdAt, title, link, publishedAt, status, postId, error } per item.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ id, ...query }, client) => {
      try {
        const data = await client.get(`/rss-feeds/${encodeURIComponent(id)}/items`, query);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'pause_rss_feed',
    {
      title: 'Pause RSS Feed',
      description:
        'Pause an RSS feed: it stops being checked until resume_rss_feed. Posts it already created stay, scheduled ones included; cancel those with delete_post. Ids outside the workspace return 404. Needs the posts.draft permission. Returns the feed with status PAUSED and pauseReason USER.',
      inputSchema: rssFeedIdField,
      outputSchema: resultSchema(`The paused feed. ${RSS_FEED_RECORD}`),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.post(`/rss-feeds/${encodeURIComponent(id)}/pause`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'resume_rss_feed',
    {
      title: 'Resume RSS Feed',
      description:
        "Resume a paused RSS feed: the pause reason is cleared and the feed is checked within a minute, posting new items according to its post mode, so confirm with the user first. It then posts as the member resuming it, who needs the permission of its post mode. When pauseReason is ACCESS_LOST, SUBSCRIPTION_INACTIVE or CONNECTION_REMOVED, fix the cause first or the feed pauses again. Ids outside the workspace return 404. Needs the posts.draft permission.",
      inputSchema: rssFeedIdField,
      outputSchema: resultSchema(`The resumed feed. ${RSS_FEED_RECORD}`),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.post(`/rss-feeds/${encodeURIComponent(id)}/resume`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'check_rss_feed',
    {
      title: 'Check RSS Feed Now',
      description:
        "Move an RSS feed's next check to now; the feed is fetched within a minute and any new items are posted according to its post mode. Use it when the user just published an article and does not want to wait for the interval. Read list_rss_feed_items a minute later to see the result. Ids outside the workspace return 404. Needs the posts.draft permission.",
      inputSchema: rssFeedIdField,
      outputSchema: resultSchema(`The feed with its new nextCheckAt. ${RSS_FEED_RECORD}`),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.post(`/rss-feeds/${encodeURIComponent(id)}/check`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Analytics ──────────────────────────────────────────────────────────

  tool(
    'get_analytics_overview',
    {
      title: 'Get Analytics Overview',
      description:
        `Workspace-wide performance for a date window: views, likes, comments, shares, followers, posts published, average views per post and engagement rate, each as { value, previousValue, deltaPercent } against the window of the same length just before it. Use this for "how did we do this month" questions and for follower counts. Metrics are summed over the selected platforms; partialMetrics names metrics some selected platform cannot report, and a metric no platform reports is null. ${ANALYTICS_COVERAGE} Analytics refresh every few hours (lastSyncedAt says when); if the user just published, call trigger_analytics_sync first. Use get_analytics_timeseries for a trend, get_platform_breakdown to compare platforms, and list_post_analytics for individual posts.`,
      inputSchema: analyticsRangeFields,
      outputSchema: resultSchema(
        'An object with views, likes, comments, shares, followers, postsCount, avgViewsPerPost and engagementRate (each { value, previousValue, deltaPercent }), partialMetrics, and lastSyncedAt.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.get('/analytics/overview', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_analytics_timeseries',
    {
      title: 'Get Analytics Timeseries',
      description:
        'Views, likes, comments, shares, followers, posts published and engagement rate bucketed by day (default), week or month across the window, for trend questions such as "how are views moving" or "when did followers jump". Returns { points } with one { date, ...metrics } per bucket; followers is the latest count at the end of the bucket, the other counters sum posts published inside it, and a metric no selected platform reports is null. Use get_analytics_overview for totals and list_post_analytics to see which posts drove a spike.',
      inputSchema: {
        ...analyticsRangeFields,
        granularity: AnalyticsGranularity.optional().describe(
          'DAILY (default), WEEKLY, or MONTHLY buckets',
        ),
      },
      outputSchema: resultSchema(
        'An object with points: one { date, views, likes, comments, shares, followers, postsCount, engagementRate } per bucket, in date order.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.get('/analytics/timeseries', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_platform_breakdown',
    {
      title: 'Get Platform Breakdown',
      description:
        'The overview metrics split per platform for a date window, for "which platform performs best" comparisons. Returns { platforms }: one row per platform with analytics data, carrying followers, views, likes, comments, shares, postsCount, avgViewsPerPost and engagementRate (each { value, previousValue, deltaPercent }) plus supportedMetrics, the metrics that platform actually reports; compare only metrics both platforms list there. Google Business Profile reports location impressions only. Takes no platform filter; connectionIds narrows it to some accounts. Use get_analytics_overview for the combined total.',
      inputSchema: {
        from: analyticsRangeFields.from,
        to: analyticsRangeFields.to,
        connectionIds: analyticsRangeFields.connectionIds,
      },
      outputSchema: resultSchema(
        'An object with platforms: one { platform, followers, views, likes, comments, shares, postsCount, avgViewsPerPost, engagementRate, supportedMetrics } per platform.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.get('/analytics/platform-breakdown', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'list_post_analytics',
    {
      title: 'List Post Analytics',
      description:
        'Per-post metrics for posts published inside the window, sorted by a metric or by publish date, paginated. Use it for "top posts", "which post got the most comments" and "how did post X do". Covers posts published through AdaptlyPost and posts discovered on the connected accounts; Google Business Profile posts are listed with null metrics, since that platform reports only location impressions; discovered posts have postId and postPlatformId set to null, while AdaptlyPost posts carry the postId used by get_post. Returns { posts, total, page, limit, hasMore }; each post has platform, publishedAt, title, thumbnailUrl, permalink, connectionId, accountName and metrics { views, likes, comments, shares, saves, clicks, impressions, reach, engagementRate, plus engagedViews, averageViewDurationSeconds and averageViewPercentage on YouTube }, with null for metrics the platform does not report. Sort by a metric for a ranked list (list_top_posts returns the top few in one call); PUBLISHED_AT (default) for a chronological review. Not for publishing status: use list_post_results for that.',
      inputSchema: {
        ...analyticsRangeFields,
        sortBy: AnalyticsSortMetric.optional().describe(
          'Metric to sort by, descending. PUBLISHED_AT (default) lists newest first',
        ),
        page: z.number().int().min(1).optional().default(1).describe('Page number, from 1'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe('Posts per page, 1 to 100'),
      },
      outputSchema: resultSchema(
        'An object with posts (each { id, postId, postPlatformId, platform, publishedAt, title, thumbnailUrl, permalink, connectionId, accountName, metrics }), total, page, limit, and hasMore.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.get('/analytics/posts', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'list_top_posts',
    {
      title: 'List Top Posts',
      description:
        'The best-performing posts published inside the window, ranked by one metric (VIEWS by default), in one call: the same rows as list_post_analytics without pagination. Use it for "what were our top 5 posts this month". Covers posts published through AdaptlyPost and posts discovered on the connected accounts (postId null). connectionIds narrows it to some accounts. Needs the analytics.read permission.',
      inputSchema: {
        ...analyticsRangeFields,
        sortBy: AnalyticsSortMetric.optional().describe('Metric to rank by, descending (default VIEWS)'),
        limit: z.number().int().min(1).max(50).optional().describe('Posts to return, 1 to 50 (default 10)'),
      },
      outputSchema: resultSchema(
        'An object with posts: one { id, postId, postPlatformId, platform, publishedAt, title, thumbnailUrl, permalink, connectionId, accountName, metrics } per post, best first.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.get('/analytics/top-posts', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'list_discovered_posts',
    {
      title: 'List Discovered Posts',
      description:
        "Posts found on the connected accounts that were not published through AdaptlyPost (published natively or with another tool), inside the window: text, thumbnail, permalink, account and publish time. They are read-only; their metrics are in list_post_analytics. Use it to show what an account posted outside AdaptlyPost or to fill in the calendar. Needs the analytics.read permission.",
      inputSchema: {
        ...analyticsRangeFields,
        limit: z.number().int().min(1).max(1000).optional().describe('Posts to return, 1 to 1000 (default 200)'),
      },
      outputSchema: resultSchema(
        'An object with posts: one { id, platform, publishedAt, text, thumbnailUrl, permalink, connectionId, accountName } per post.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.get('/analytics/discovered-posts', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_analytics_sync_status',
    {
      title: 'Get Analytics Sync Status',
      description:
        'How fresh the analytics are, per connected account. Returns syncInProgress, lastSyncedAt, historyHorizonAt (the earliest date any account has data for; earlier dates have no data rather than zero activity) and platforms: one row per account with status (IDLE, QUEUED, SYNCING, FAILED), lastSyncedAt, lastErrorMessage, historyHorizonAt and needsAnalyticsReconnect. When needsAnalyticsReconnect is true the account was connected before analytics permissions existed and returns nothing until the user reconnects it (a connect link works); tell them, do not keep querying. Call this when numbers look stale or empty, and after trigger_analytics_sync to see the run finish. Takes only the optional workspaceId.',
      inputSchema: {},
      outputSchema: resultSchema(
        'An object with accountGroupId, syncInProgress, lastSyncedAt, historyHorizonAt, and platforms: one { platform, connectionId, accountName, status, lastSyncedAt, lastErrorMessage, historyHorizonAt, lastDiscoveryAt, needsAnalyticsReconnect } per connected account.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (_args, client) => {
      try {
        const data = await client.get('/analytics/sync-status');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'trigger_analytics_sync',
    {
      title: 'Trigger Analytics Sync',
      description:
        'Ask AdaptlyPost to refresh analytics now instead of waiting for the scheduled sync: every connected account is queued and the last 7 days are re-read. Use it when the user just published and wants numbers, or when get_analytics_overview shows an old lastSyncedAt. Allowed once per workspace every 4 hours; inside the cooldown it returns queued: false with cooldownSecondsRemaining rather than an error, so do not retry in a loop. The sync runs in the background: poll get_analytics_sync_status until syncInProgress is false, then read the metrics again. Takes only the optional workspaceId and changes no content.',
      inputSchema: {},
      outputSchema: resultSchema(
        'An object with queued (true when a sync was started), message, and cooldownSecondsRemaining (seconds until the next allowed sync, null when queued).',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (_args, client) => {
      try {
        const data = await client.post('/analytics/sync');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Webhooks ───────────────────────────────────────────────────────────

  const webhookIdField = { id: z.string().describe('Webhook id from list_webhooks or create_webhook') };

  const WEBHOOK_RECORD =
    'The webhook: id, url, active, createdAt, updatedAt, lastSuccessAt, lastFailureAt and disabledAt (set when it was turned off after 20 failed deliveries in a row).';

  tool(
    'list_webhooks',
    {
      title: 'List Webhooks',
      description:
        'List the webhook endpoints registered for the workspace (the current one unless workspaceId names another), with whether each is active and when it last succeeded or failed. Needs the webhooks.read permission, which Admin, Editor and Viewer hold. Takes only the optional workspaceId.',
      inputSchema: {},
      outputSchema: resultSchema(`An object with webhooks: one record per endpoint. ${WEBHOOK_RECORD}`),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (_args, client) => {
      try {
        const data = await client.get('/webhooks');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_webhook',
    {
      title: 'Get Webhook',
      description:
        'Get one webhook endpoint by id. Ids outside the workspace return 404. Needs the webhooks.read permission.',
      inputSchema: webhookIdField,
      outputSchema: resultSchema(WEBHOOK_RECORD),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.get(`/webhooks/${encodeURIComponent(id)}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'create_webhook',
    {
      title: 'Create Webhook',
      description:
        "Register a URL that receives every workspace event as an HTTP POST: post.published, post.partially_failed, post.failed, post.scheduled, account.unauthorized, image.completed and image.failed. Each delivery carries the x-adaptly-signature, x-adaptly-timestamp, x-adaptly-event and x-adaptly-webhook-id headers; the signature is sha256=HMAC_SHA256(secret, \"{timestamp}.{rawBody}\"). Failed deliveries are retried up to 5 times with exponential backoff, and an endpoint is turned off after 20 failed deliveries in a row. The response is the only time the signing secret is shown, so give it to the user to store. Fails with 400 for an invalid URL or the webhook limit, and 409 when the URL is already registered. Needs the webhooks.manage permission, which Admin and Editor hold.",
      inputSchema: {
        url: z.string().url().describe('Publicly reachable http(s) endpoint that receives every event'),
      },
      outputSchema: resultSchema(`The new webhook plus secret, the signing secret shown only this once. ${WEBHOOK_RECORD}`),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/webhooks', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'update_webhook',
    {
      title: 'Update Webhook',
      description:
        'Change a webhook endpoint\'s URL, or turn it off or back on with active. Turning on an endpoint that was turned off after failed deliveries starts sending again. Fails with 409 when the new URL is already registered. Needs the webhooks.manage permission.',
      inputSchema: {
        ...webhookIdField,
        url: z.string().url().optional().describe('New http(s) endpoint URL'),
        active: z.boolean().optional().describe('false stops deliveries, true resumes them'),
      },
      outputSchema: resultSchema(`The updated webhook. ${WEBHOOK_RECORD}`),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id, ...body }, client) => {
      try {
        const data = await client.patch(`/webhooks/${encodeURIComponent(id)}`, body);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'delete_webhook',
    {
      title: 'Delete Webhook',
      description:
        'Delete a webhook endpoint; it receives nothing more. Use update_webhook with active: false to pause it instead. Needs the webhooks.manage permission. Returns { deleted: true }. Irreversible.',
      inputSchema: webhookIdField,
      outputSchema: resultSchema('An object with deleted: true once the webhook is removed.'),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.delete(`/webhooks/${encodeURIComponent(id)}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'test_webhook',
    {
      title: 'Test Webhook',
      description:
        'Send one signed webhook.test event to the endpoint now and report how it answered, to check the URL and the signature check work. Needs the webhooks.manage permission.',
      inputSchema: webhookIdField,
      outputSchema: resultSchema(
        'An object with success, statusCode (the HTTP status the endpoint answered) and error when the delivery failed.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ id }, client) => {
      try {
        const data = await client.post(`/webhooks/${encodeURIComponent(id)}/test`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── AI Generation ──────────────────────────────────────────────────────

  tool(
    'generate_caption',
    {
      title: 'Generate Caption',
      description:
        `Write a new social media caption from a prompt with AdaptlyPost AI. Returns { caption }, text only; nothing is saved or posted, so pass the caption to create_post, update_post or bulk_schedule_posts yourself. Pass platform and generation targets that platform's character limit; check the returned text before posting. ${AI_PERMISSION_RULE} ${CAPTION_CREDIT_RULE} To rework a caption you already have, use refine_caption instead.`,
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(2000)
          .describe(
            'What the caption should say or be about, including tone, audience, hashtags or a call to action (max 2000 characters)',
          ),
        platform: CaptionPlatform.optional().describe(
          "Platform the caption is for; generation targets that platform's character limit; check the returned text before posting. Omit for a general caption",
        ),
      },
      outputSchema: resultSchema('An object with caption: the generated text.'),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/ai/captions', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'refine_caption',
    {
      title: 'Refine Caption',
      description:
        `Rewrite an existing caption following an instruction, such as "shorter", "more playful" or "add a question at the end". Returns { caption }, the rewritten text; nothing is saved or posted. Send partialText to continue from a partly written caption. Pass platform to target that platform's character limit; check the returned text before posting. ${AI_PERMISSION_RULE} ${CAPTION_CREDIT_RULE} Costs the same as generate_caption.`,
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(2000)
          .describe('How the caption should change (max 2000 characters)'),
        originalText: z
          .string()
          .min(1)
          .max(10000)
          .describe('The caption to rewrite (max 10000 characters)'),
        partialText: z
          .string()
          .max(10000)
          .optional()
          .describe('A partly written caption to continue from (max 10000 characters)'),
        platform: CaptionPlatform.optional().describe(
          "Platform the caption is for; generation targets that platform's character limit; check the returned text before posting",
        ),
      },
      outputSchema: resultSchema('An object with caption: the rewritten text.'),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/ai/captions/refine', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'generate_image',
    {
      title: 'Generate Image',
      description:
        `Create an image from the user's prompt with AdaptlyPost AI and save it to the user's own AI image studio in AdaptlyPost. Nothing is posted. It returns { jobId, sessionId, status } right away with status queued; poll get_image_job with the jobId every few seconds until status is completed or failed (usually 10 to 40 seconds). A completed job carries imageUrl, which can go straight into mediaUrls of create_post. Reuse sessionId to keep related images together. ${AI_PERMISSION_RULE} Uses the member's AdaptlyPost AI credits (2 for standard, 4 for premium, none when the member connected their own image provider key) and refunds them if the job fails. With no credits left the job fails with an error saying so; tell the user and do not retry.`,
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(2000)
          .describe('What the image should show, including style and composition (max 2000 characters)'),
        aspectRatio: ImageAspectRatio.optional().describe(
          'Image shape (default 1:1). Pick one that suits the target platform, e.g. 9:16 for stories and reels, 4:5 for Instagram feed, 16:9 for YouTube and X',
        ),
        model: ImageModel.optional().describe(
          'standard (default, 2 credits) or premium (higher fidelity, 4 credits)',
        ),
        quality: ImageQuality.optional().describe('LOW, MEDIUM or HIGH rendering quality'),
        sessionId: z
          .string()
          .uuid()
          .optional()
          .describe(
            'Image studio session to add the image to, as returned by an earlier generate_image. Omit to start a new session',
          ),
        referenceImages: z
          .array(z.string())
          .max(5)
          .optional()
          .describe('Up to 5 image URLs the user provided, such as publicUrl values from upload_media, to guide the style or subject'),
      },
      outputSchema: resultSchema(
        'An object with jobId (pass it to get_image_job), sessionId, and status (queued).',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input, client) => {
      try {
        const data = await client.post('/ai/images', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'get_image_job',
    {
      title: 'Get Image Job',
      description:
        `Read the state of an image started with generate_image. Returns { jobId, sessionId, status, imageUrl, imageId, error }; status moves from queued through processing and generating to completed or failed. When completed, imageUrl is a public URL ready for mediaUrls in create_post. When failed, error says why, for example no credits left; a failed job is final, so do not poll it again. Poll every few seconds while status is queued, processing or generating, and stop after a couple of minutes. Only jobs started by the same member are visible. ${AI_PERMISSION_RULE} Reading a job spends no credits.`,
      inputSchema: {
        jobId: z.string().min(1).describe('jobId returned by generate_image'),
      },
      outputSchema: resultSchema(
        'An object with jobId, sessionId, status (queued, processing, generating, completed or failed), imageUrl (null until completed), imageId, and error (null unless failed).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ jobId }, client) => {
      try {
        const data = await client.get(`/ai/images/${encodeURIComponent(jobId)}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio (local) or HTTP (deployed, single URL)
// ---------------------------------------------------------------------------

const SSE_ACCEPT = 'application/json, text/event-stream';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  return body.length ? JSON.parse(body.toString('utf8')) : undefined;
}

function sendBodyTooLarge(res: ServerResponse): void {
  res.writeHead(413, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: `Request body is over ${MAX_BODY_BYTES / (1024 * 1024)} MB. For large media use get_upload_urls or pass a public URL to upload_media.`,
      },
      id: null,
    }),
  );
}

type JsonRpcRequest = { id?: string | number | null; method?: string };

function isDiscoverRequest(body: unknown): body is JsonRpcRequest {
  return !!body && typeof body === 'object' && (body as JsonRpcRequest).method === 'server/discover';
}

function sendMethodNotFound(res: ServerResponse, id: JsonRpcRequest['id']): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: 'Method not found' } });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleWidgetUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const size = Number(req.headers['content-length']);
  const fileName = decodeFileName(req.headers[UPLOAD_FILE_NAME_HEADER]);
  const ticket = await openUploadTicket(String(req.headers[UPLOAD_TICKET_HEADER] ?? ''));
  const finish = (status: number, body: unknown) => {
    console.error(`upload status=${status} bytes=${size} ms=${Date.now() - startedAt}`);
    sendJson(res, status, body);
  };

  if (!ticket) {
    req.resume();
    finish(401, { error: 'This upload box expired. Ask for a new one.' });
    return;
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    req.resume();
    finish(411, { error: 'The upload is missing its Content-Length.' });
    return;
  }

  try {
    const { head, body } = await splitHead(req, SNIFF_BYTES);
    const mimeType = requireStreamedMedia(head, fileName, size);
    const client = new RestClient(API_BASE_URL, ticket.token).forWorkspace(ticket.workspaceId);
    const stem = fileName.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-').slice(0, 80) || 'upload';
    const { uploadUrl, publicUrl, key } = await mintUploadUrl(
      client,
      `${stem}${EXT_BY_MIME[mimeType]}`,
      mimeType,
    );
    await putStream(uploadUrl, { mimeType, contentLength: size, body });
    finish(200, { publicUrl, key, mimeType, fileName });
  } catch (error) {
    req.resume();
    const status = error instanceof ApiError ? error.status : 400;
    finish(status, { error: error instanceof Error ? error.message : String(error) });
  }
}

const UploadUrlRequest = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().positive(),
  head: z.string().max(64),
});

async function handleUploadUrlRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ticket = await openUploadTicket(String(req.headers[UPLOAD_TICKET_HEADER] ?? ''));
  if (!ticket) {
    req.resume();
    sendJson(res, 401, { error: 'This upload box expired. Ask for a new one.' });
    return;
  }

  let fileSize: number | undefined;
  try {
    const parsed = UploadUrlRequest.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new Error('The upload request is malformed.');
    const { fileName, head } = parsed.data;
    fileSize = parsed.data.fileSize;
    const mimeType = requireStreamedMedia(Buffer.from(head, 'base64'), fileName, fileSize);
    const client = new RestClient(API_BASE_URL, ticket.token).forWorkspace(ticket.workspaceId);
    const { uploadUrl, publicUrl, key } = await mintUploadUrl(
      client,
      fileNameFor(fileName, mimeType),
      mimeType,
      fileSize,
    );
    console.error(`upload-url status=200 bytes=${fileSize}`);
    sendJson(res, 200, { uploadUrl, publicUrl, key, mimeType });
  } catch (error) {
    req.resume();
    const status = error instanceof ApiError ? error.status : 400;
    console.error(`upload-url status=${status} bytes=${fileSize ?? '-'}`);
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
}

const FileImportRequest = z.object({
  downloadUrl: z.string().url(),
  fileId: z.string().max(200).optional(),
  fileName: z.string().trim().min(1).max(255),
});

type FileImport =
  | { status: 'pending' }
  | { status: 'done'; publicUrl: string }
  | { status: 'failed'; error: string };

const FILE_IMPORT_TTL_MS = 30 * 60 * 1000;
const FILE_IMPORT_PATH = '/import-file';
const fileImports = new Map<string, FileImport>();

function trackFileImport(work: Promise<Uploaded>): string {
  const id = randomUUID();
  fileImports.set(id, { status: 'pending' });
  setTimeout(() => fileImports.delete(id), FILE_IMPORT_TTL_MS).unref();
  work.then(
    ({ publicUrl }) => fileImports.set(id, { status: 'done', publicUrl }),
    (error) =>
      fileImports.set(id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  return id;
}

async function handleFileImportStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ticket = await openUploadTicket(String(req.headers[UPLOAD_TICKET_HEADER] ?? ''));
  if (!ticket) {
    req.resume();
    sendJson(res, 401, { error: 'This upload box expired. Ask for a new one.' });
    return;
  }

  try {
    const parsed = FileImportRequest.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new Error('The upload request is malformed.');
    const { downloadUrl, fileId, fileName } = parsed.data;
    const client = new RestClient(API_BASE_URL, ticket.token).forWorkspace(ticket.workspaceId);
    const importId = trackFileImport(
      uploadFromAttachment(client, { download_url: downloadUrl, file_id: fileId ?? '', file_name: fileName }),
    );
    sendJson(res, 202, { importId });
  } catch (error) {
    req.resume();
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function handleFileImportStatus(importId: string, res: ServerResponse): void {
  const state = fileImports.get(importId);
  if (!state) {
    sendJson(res, 404, { error: 'This upload is no longer tracked. Upload the file again.' });
    return;
  }
  sendJson(res, 200, state);
}

const UPLOAD_SESSION_PATH = '/upload-session';
const UPLOAD_CHUNK_BYTES = 10 * 1024 * 1024;
const UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000;

type UploadSession = {
  client: RestClient;
  fileName: string;
  mimeType: string;
  size: number;
  dir: string;
  path: string;
  received: number;
  nextIndex: number;
  writing: boolean;
  startedAt: number;
  expiry: NodeJS.Timeout;
};

const uploadSessions = new Map<string, UploadSession>();

function discardUploadSession(id: string): void {
  const session = uploadSessions.get(id);
  if (!session) return;
  uploadSessions.delete(id);
  clearTimeout(session.expiry);
  void rm(session.dir, { recursive: true, force: true });
}

async function handleUploadSessionStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ticket = await openUploadTicket(String(req.headers[UPLOAD_TICKET_HEADER] ?? ''));
  if (!ticket) {
    req.resume();
    sendJson(res, 401, { error: 'This upload box expired. Ask for a new one.' });
    return;
  }

  try {
    const parsed = UploadUrlRequest.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new Error('The upload request is malformed.');
    const { fileName, fileSize, head } = parsed.data;
    const mimeType = requireStreamedMedia(Buffer.from(head, 'base64'), fileName, fileSize);
    const dir = await mkdtemp(join(tmpdir(), 'upload-'));
    const path = join(dir, 'file');
    await writeFile(path, '');
    const id = randomUUID();
    uploadSessions.set(id, {
      client: new RestClient(API_BASE_URL, ticket.token).forWorkspace(ticket.workspaceId),
      fileName,
      mimeType,
      size: fileSize,
      dir,
      path,
      received: 0,
      nextIndex: 0,
      writing: false,
      startedAt: Date.now(),
      expiry: setTimeout(() => discardUploadSession(id), UPLOAD_SESSION_TTL_MS).unref(),
    });
    console.error(`upload-session start bytes=${fileSize}`);
    sendJson(res, 201, { sessionId: id, chunkBytes: UPLOAD_CHUNK_BYTES });
  } catch (error) {
    req.resume();
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleUploadChunk(
  session: UploadSession,
  index: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (index < session.nextIndex) {
    req.resume();
    sendJson(res, 200, { received: session.received });
    return;
  }
  if (index > session.nextIndex || session.writing) {
    req.resume();
    sendJson(res, 409, { error: 'Upload parts arrived out of order.', nextIndex: session.nextIndex });
    return;
  }

  session.writing = true;
  let count = 0;
  async function* limited() {
    for await (const piece of req as AsyncIterable<Buffer>) {
      count += piece.length;
      if (count > UPLOAD_CHUNK_BYTES || session.received + count > session.size) {
        throw new Error('This upload part is larger than announced.');
      }
      yield piece;
    }
  }

  try {
    await pipeline(limited(), createWriteStream(session.path, { flags: 'r+', start: session.received }));
    session.received += count;
    session.nextIndex += 1;
    sendJson(res, 200, { received: session.received });
  } catch (error) {
    req.resume();
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    session.writing = false;
  }
}

async function readFileHead(path: string): Promise<Buffer> {
  const file = await open(path);
  try {
    const head = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await file.read(head, 0, SNIFF_BYTES, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function storeUploadSession(session: UploadSession): Promise<Uploaded> {
  const mimeType = requireStreamedMedia(await readFileHead(session.path), session.fileName, session.size);
  if (mimeType !== session.mimeType) throw new Error(`${session.fileName} is not the file that was announced.`);
  const { uploadUrl, publicUrl, key } = await mintUploadUrl(
    session.client,
    fileNameFor(session.fileName, mimeType),
    mimeType,
    session.size,
  );
  await putStream(uploadUrl, { mimeType, contentLength: session.size, body: createReadStream(session.path) });
  return { publicUrl, key };
}

function handleUploadComplete(id: string, session: UploadSession, req: IncomingMessage, res: ServerResponse): void {
  req.resume();
  if (session.writing || session.received !== session.size) {
    sendJson(res, 409, {
      error: `The upload is incomplete: ${formatBytes(session.received)} of ${formatBytes(session.size)} arrived.`,
    });
    return;
  }

  uploadSessions.delete(id);
  clearTimeout(session.expiry);
  const work = storeUploadSession(session);
  work.then(
    () => console.error(`upload-session stored bytes=${session.size} ms=${Date.now() - session.startedAt}`),
    (error) =>
      console.error(
        `upload-session failed bytes=${session.size} error=${error instanceof Error ? error.message : String(error)}`,
      ),
  );
  const importId = trackFileImport(work.finally(() => rm(session.dir, { recursive: true, force: true })));
  sendJson(res, 202, { importId });
}

async function routeUploadSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [, , id, action, index] = (req.url ?? '').split('?')[0].split('/');
  const session = id ? uploadSessions.get(id) : undefined;
  if (!session) {
    req.resume();
    sendJson(res, 404, { error: 'This upload expired. Upload the file again.' });
    return;
  }
  if (action === 'chunks' && /^\d+$/.test(index ?? '')) {
    await handleUploadChunk(session, Number(index), req, res);
    return;
  }
  if (action === 'complete' && index === undefined) {
    handleUploadComplete(id, session, req, res);
    return;
  }
  req.resume();
  sendJson(res, 404, { error: 'Not found' });
}

// The MCP SDK 406s unless Accept lists both types. `@hono/node-server` v1 rebuilds the
// request from rawHeaders, so headers.accept alone is not enough.
const forceStreamableAccept = (req: IncomingMessage) => {
  req.headers.accept = SSE_ACCEPT;

  const raw = req.rawHeaders;
  const index = raw.findIndex((entry, i) => i % 2 === 0 && entry.toLowerCase() === 'accept');

  if (index === -1) raw.push('Accept', SSE_ACCEPT);
  else raw[index + 1] = SSE_ACCEPT;
};

function describeRpc(body: unknown): string | undefined {
  const one = (msg: unknown): string | undefined => {
    if (!msg || typeof msg !== 'object') return undefined;
    const { method, params } = msg as {
      method?: string;
      params?: { name?: string };
    };
    if (!method) return 'response';
    return method === 'tools/call' && params?.name
      ? `tools/call:${params.name}`
      : method;
  };
  if (Array.isArray(body)) return body.map(one).join(',');
  return one(body);
}

async function main() {
  if (isHttpMode) {
    const httpServer = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, Authorization, mcp-session-id, X-Upload-Ticket, X-File-Name',
        });
        res.end();
        return;
      }

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.url === '/.well-known/glama.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            $schema: 'https://glama.ai/mcp/schemas/connector.json',
            maintainers: [{ email: 'taras.shinkarenko@gmail.com' }],
          })
        );
        return;
      }

      if (req.url === '/.well-known/openai-apps-challenge') {
        const challenge = process.env.OPENAI_APPS_CHALLENGE;
        if (challenge) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(challenge);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
        return;
      }

      if (req.url === '/upload' && req.method === 'POST') {
        await handleWidgetUpload(req, res);
        return;
      }

      if (req.url === '/upload-url' && req.method === 'POST') {
        await handleUploadUrlRequest(req, res);
        return;
      }

      if (req.url === FILE_IMPORT_PATH && req.method === 'POST') {
        await handleFileImportStart(req, res);
        return;
      }

      if (req.url?.startsWith(`${FILE_IMPORT_PATH}/`) && req.method === 'GET') {
        handleFileImportStatus(req.url.slice(FILE_IMPORT_PATH.length + 1), res);
        return;
      }

      if (req.url === UPLOAD_SESSION_PATH && req.method === 'POST') {
        await handleUploadSessionStart(req, res);
        return;
      }

      if (req.url?.startsWith(`${UPLOAD_SESSION_PATH}/`) && req.method === 'POST') {
        await routeUploadSession(req, res);
        return;
      }

      if (handleProtectedResourceMetadata(oauthConfig, req, res)) {
        return;
      }

      if (req.url === '/mcp') {
        const startedAt = Date.now();
        let rpcLabel = '-';
        res.on('close', () => {
          console.error(
            `mcp ${req.method} rpc=${rpcLabel} status=${res.statusCode} ms=${Date.now() - startedAt} finished=${res.writableEnded}`,
          );
        });

        // Extract Bearer token from the incoming request
        const authHeader = req.headers.authorization ?? '';
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

        if (!bearerToken && oauthConfig.oauthRequired) {
          sendUnauthorized(oauthConfig, res, 'Authentication required');
          return;
        }

        if (bearerToken && looksLikeJwt(bearerToken)) {
          const verdict = await verifyOauthJwt(oauthConfig, bearerToken);
          if (!verdict.valid) {
            sendUnauthorized(oauthConfig, res, verdict.error);
            return;
          }
        }

        const token = bearerToken || API_TOKEN;
        const reqApi = new RestClient(API_BASE_URL, token);

        const wantsSse = (req.headers.accept ?? '').includes('text/event-stream');
        if (!wantsSse) forceStreamableAccept(req);

        // Stateless mode requires a fresh transport per request
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: !wantsSse,
        });
        const reqServer = createMcpServer(reqApi);
        await reqServer.connect(withoutSchemaDialect(transport));
        try {
          let parsedBody: unknown;
          if (req.method === 'POST') {
            try {
              parsedBody = await readJsonBody(req);
            } catch (error) {
              if (error instanceof BodyTooLarge) {
                rpcLabel = 'too-large';
                sendBodyTooLarge(res);
                req.destroy();
                return;
              }
              rpcLabel = 'unparseable';
            }
            rpcLabel = describeRpc(parsedBody) ?? rpcLabel;
            if (isDiscoverRequest(parsedBody)) {
              sendMethodNotFound(res, parsedBody.id);
              return;
            }
          }
          await transport.handleRequest(req, res, parsedBody);
        } catch (err) {
          console.error('MCP handleRequest error:', err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        }
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    httpServer.listen(HTTP_PORT, () => {
      console.error(
        `AdaptlyPost MCP server (HTTP) listening on port ${HTTP_PORT}`,
      );
      console.error(`Connect with: https://your-domain/mcp`);
    });
  } else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(withoutSchemaDialect(transport));
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
