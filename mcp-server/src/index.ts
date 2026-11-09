#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
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
import { apiResponses } from './api-schemas.js';
import { ApiError, RestClient } from './rest-client.js';
import {
  decodeFileName,
  MCP_APP_MIME_TYPE,
  openUploadTicket,
  sealUploadTicket,
  UPLOAD_FILE_NAME_HEADER,
  UPLOAD_TICKET_HEADER,
  UPLOAD_WIDGET_URI,
  uploadLinkExpiredHtml,
  uploadTicketsEnabled,
  uploadWidgetHtml,
} from './upload-widget.js';
import {
  claimUploadLink,
  createUploadLink,
  parkLinkUpload,
  reserveLinkUpload,
  UPLOAD_LINK_HEADER,
  UPLOAD_LINK_PATH,
  uploadLinkOpen,
  uploadLinkUrl,
  type ParkedFile,
} from './upload-links.js';
import { withoutSchemaDialect } from './schema-dialect.js';
import {
  oauthConfigFromEnv,
  handleProtectedResourceMetadata,
  sendUnauthorized,
  looksLikeJwt,
  verifyOauthJwt,
} from './oauth.js';

const SERVER_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

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
  'WORDPRESS',
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
  'CAROUSEL takes 2 or more items in mediaUrls, up to 4 on TWITTER, BLUESKY and MASTODON, 5 on PINTEREST, 10 on INSTAGRAM, FACEBOOK, THREADS and TELEGRAM, 20 on LINKEDIN and WORDPRESS, 30 on TUMBLR and 35 on TIKTOK (JPEG or WebP photos only). INSTAGRAM and THREADS accept images and videos in the same carousel; every other platform takes images only, and YOUTUBE has no carousel. Give a platform with a lower limit its own items through platformMedia';

const GOOGLE_BUSINESS_RULE =
  'GOOGLE_BUSINESS takes TEXT or IMAGE with one JPEG or PNG image up to 5 MB, and text up to 1500 characters';

const TELEGRAM_RULE =
  'TELEGRAM takes text up to 4096 characters, up to 10 images (JPEG, PNG or WebP, 10 MB each) or one MP4 or MOV video (50 MB); a caption over 1024 characters goes out as its own message after the media';

const WORDPRESS_RULE =
  'WORDPRESS publishes the text as the body of a blog post, up to 100,000 characters: blank lines start new paragraphs and bare links become clickable. It takes up to 20 JPEG, PNG, WebP or GIF images (20 MB each) or one MP4 or MOV video (500 MB); the first image is the featured image and the other images or the video follow the text';

const LINKEDIN_MENTION_RULE =
  'On LinkedIn, mention a company page with @[Page Name](urn:li:organization:<id>), using the page name exactly as LinkedIn shows it';

const ALT_TEXT_RULE =
  'Alt text per image, in the same order as mediaUrls (use "" to skip an image). Sent to X, Bluesky, Mastodon, Tumblr, WordPress, LinkedIn, Facebook, Instagram and Threads; Pinterest uses the first one (cut to 500). TikTok, YouTube, Google Business Profile and videos ignore it';

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

const WebhookEvent = z.enum([
  'post.published',
  'post.partially_failed',
  'post.failed',
  'post.scheduled',
  'account.unauthorized',
  'image.completed',
  'image.failed',
  'comment.created',
  'comment.replied',
  'mention.created',
  'message.received',
  'review.created',
]);

const InboxStatus = z.enum(['UNREAD', 'READ', 'DONE']);

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
  title: z
    .string()
    .max(90)
    .optional()
    .describe(
      'On a photo post, the title shown above the description. On a video, sent as the caption only when caption is empty',
    ),
  caption: z
    .string()
    .max(4000)
    .optional()
    .describe(
      "TikTok-specific caption: up to 2200 characters on a video, 4000 on a photo or photo carousel post (where it is the description). Falls back to title, then to the post text. A video sent with sendAsDraft can reach the TikTok inbox without it, because TikTok's inbox upload takes no caption",
    ),
  privacyLevel: z
    .enum([
      'PUBLIC_TO_EVERYONE',
      'MUTUAL_FOLLOW_FRIENDS',
      'FOLLOWER_OF_CREATOR',
      'SELF_ONLY',
    ])
    .describe(
      'Who can see the TikTok post: everyone, mutual followers, followers of the creator, or only the creator (SELF_ONLY)',
    ),
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
    .describe('Title of the YouTube video'),
  tags: z
    .array(z.string())
    .max(20)
    .optional()
    .describe('Keyword tags stored on the YouTube video'),
  privacyStatus: z
    .enum(['public', 'private', 'unlisted'])
    .optional()
    .describe('Who can watch the video: public is everyone, unlisted is anyone with the link, private is only the channel'),
  license: z
    .enum(['youtube', 'creativeCommon'])
    .optional()
    .describe('youtube is the standard YouTube license; creativeCommon publishes the video under Creative Commons Attribution so others may reuse it'),
  notifySubscribers: z.boolean().optional().describe('Notify channel subscribers about the upload'),
  allowEmbedding: z.boolean().optional().describe('Allow embedding the video on other sites'),
  madeForKids: z.boolean().optional().describe('Mark the video as made for kids (COPPA)'),
  categoryId: z
    .string()
    .optional()
    .describe('Numeric YouTube video category id, as a string, such as "22" for People & Blogs'),
  playlistId: z
    .string()
    .optional()
    .describe('Id of a playlist on this YouTube channel; the uploaded video is added to it'),
  defaultAudioLanguage: z
    .string()
    .max(35)
    .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
    .nullable()
    .optional()
    .describe(
      'Language spoken in the video\'s original audio, as a BCP-47 tag such as en, pt-BR or es-419, so YouTube does not treat it as another language. null clears a saved value. It does not turn off YouTube\'s automatic dubbing',
    ),
  aiGenerated: z
    .boolean()
    .optional()
    .describe(
      'Disclose altered or synthetic content, such as an AI voice, an AI avatar or realistic footage that was generated or edited. YouTube shows its "Altered or synthetic content" label on the video. Omit it or send false for no label',
    ),
  scheduleOnYouTube: z
    .boolean()
    .optional()
    .describe(
      'Upload the video as soon as the post is scheduled, as a private video that YouTube publishes itself at scheduledAt, so the user can set up a Test & Compare (thumbnail and title A/B test) in YouTube Studio before it goes public. privacyStatus must be public or omitted (400 YOUTUBE_SCHEDULE_REQUIRES_PUBLIC), and a recurring post is refused (400 YOUTUBE_SCHEDULE_NOT_RECURRING). With a scheduledAt less than 15 minutes ahead the video uploads at scheduledAt as usual. Once the video is on YouTube (youtubeScheduledVideoId is set on the platform), the post cannot be updated, unscheduled or published early (409 SCHEDULED_ON_YOUTUBE); to change it, delete it and schedule it again. Deleting it before scheduledAt also deletes the video from YouTube',
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
    .describe('Volume of the added audio, where 100 is full volume. Defaults to 100'),
  videoVolume: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Volume of the video's own sound, where 100 is full volume. Defaults to 100"),
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
      'Instagram usernames invited as collaborators (Instagram Collab). A leading @ is stripped and duplicates are dropped. Works on feed images, carousels and reels; a story or a trial reel with collaborators is refused with 400. Each collaborator gets an invite in Instagram and must accept it before the post shows on their profile',
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
          .describe('Horizontal position of the tag as a fraction of the image width, where 0 is the left edge'),
        y: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Vertical position of the tag as a fraction of the image height, where 0 is the top edge'),
      }),
    )
    .max(20)
    .optional()
    .describe(
      'Public Instagram accounts tagged in the media. Works on a single image, a single video (published as a Reel) or a single story; a carousel or several stories with tags is refused with 400. On a feed image every tag needs x and y; on a story they are optional, and on a video they are ignored because the person is tagged on the video as a whole. A leading @ is stripped and a repeated username keeps its first entry. If Instagram refuses a tag because the account is private or does not exist, the post goes out without its tags and instagramUntaggedUsernames in get_post lists the refused usernames',
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
    .describe('Title shown on the Facebook video'),
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
  aiGenerated: z
    .boolean()
    .optional()
    .describe(
      'Disclose that the post was made or edited with AI. Facebook shows its "AI info" label on the post. Works on every contentType VIDEO post, whatever its postType: Facebook publishes every video as a reel, and a video story carries the label too. Photos, carousels and text posts are rejected with a 400. Omit it or send false for no label',
    ),
});

const LinkedInConfigSchema = z.object({
  connectionId: z.string().describe('LinkedIn connection ID from list_accounts'),
  documentTitle: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Title LinkedIn shows on a DOCUMENT post. Defaults to the file name; ignored for other content types',
    ),
  reshareOf: z
    .string()
    .max(500)
    .optional()
    .describe(
      'Reshare this LinkedIn post from the account, with the post text as the commentary. Takes a urn:li:share: or urn:li:ugcPost: URN, such as the platformPostId from list_post_results, or a LinkedIn post link of the form https://www.linkedin.com/feed/update/<urn>, which is also the link inside a post\'s Embed code. urn:li:activity: links are refused because LinkedIn cannot reshare them through its API. Media on the post is not attached on this account',
    ),
});

const TwitterConfigSchema = z.object({
  connectionId: z.string().describe('X connection ID from list_accounts'),
  quoteOf: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Quote one of this account's own X posts, with the post text as the commentary. Takes a post link such as https://x.com/<handle>/status/<id> or the post's numeric id, such as the platformPostId from list_post_results. X only lets an account quote posts it wrote or posts that mention it: a link naming another handle is refused with 400, and any other post fails when it publishes. Needs text, and media on the post is not attached on this account. Costs the same as any X post",
    ),
});

const TumblrConfigSchema = z.object({
  connectionId: z.string().describe('Tumblr blog account id from list_accounts'),
  tags: z
    .array(z.string().max(140).regex(/^[^,]+$/))
    .max(30)
    .optional()
    .describe(
      'Tags shown on the Tumblr post. A leading # is stripped and duplicates are dropped, ignoring case',
    ),
  title: z.string().max(4096).optional().describe('Shown as a heading above the media and the text'),
  sourceUrl: z.string().max(2048).optional().describe('Shown as the source link of the post'),
});

const WordPressConfigSchema = z.object({
  connectionId: z.string().describe('WordPress site account id from list_accounts'),
  title: z
    .string()
    .max(300)
    .optional()
    .describe('Post title. Defaults to the first line of the text, cut to 100 characters'),
  excerpt: z.string().max(1000).optional().describe('Summary WordPress shows in post lists and feeds'),
  categoryIds: z
    .array(z.number().int().min(1))
    .max(50)
    .optional()
    .describe(
      "Category ids from list_wordpress_categories for this site. Omitted, WordPress files the post under the site's default category",
    ),
  tags: z
    .array(z.string().max(100))
    .max(50)
    .optional()
    .describe(
      'WordPress tag names. A tag the site does not have yet is created when the WordPress user may manage tags, and skipped otherwise',
    ),
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
  title: z.string().max(100).optional().describe('Title shown on the pin'),
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
  callToActionUrl: z
    .string()
    .url()
    .optional()
    .describe('Page the button opens. Ignored when callToActionType is CALL'),
  eventTitle: z.string().optional().describe('Title of the event or offer'),
  eventStart: GoogleBusinessEventDate.optional().describe(
    "Start of the event or offer in the business's local time with no offset, as a date or a date and time (e.g. \"2026-10-01T18:00\"). Google reads event times in the location's time zone",
  ),
  eventEnd: GoogleBusinessEventDate.optional().describe(
    "End of the event or offer in the business's local time with no offset, as a date or a date and time (e.g. \"2026-10-01T21:00\")",
  ),
  offerCouponCode: z.string().optional().describe('OFFER only: coupon code'),
  offerRedeemUrl: z.string().url().optional().describe('OFFER only: where the offer is redeemed'),
  offerTerms: z.string().optional().describe('OFFER only: terms and conditions'),
});

const RecurrenceSchema = z.object({
  frequency: RecurrenceFrequency.describe(
    'How often the post repeats. YEARLY repeats on the same date; a series started on February 29 posts on February 28 in other years',
  ),
  interval: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('Repeat every N periods of frequency, so 2 with WEEKLY is every other week (default 1)'),
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
      'Total number of posts the series publishes. Cannot be combined with endsOn; omit both to repeat until the user pauses or deletes the series',
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
  wordpressConnectionIds: z
    .array(z.string())
    .optional()
    .describe(
      `WordPress sites to post to, by the account id from list_accounts. ${WORDPRESS_RULE}. A site without an entry in wordpressConfigs uses the first line of the text as the title. WordPress has no first comments, threads, thumbnails, image shapes or analytics`,
    ),
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
      'Facebook per-page config: post type, shareToStory, video title, text background, a grid or link carousel for several images, and the AI info label. pageId must match an entry in pageIds',
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
  wordpressConfigs: z
    .array(WordPressConfigSchema)
    .optional()
    .describe(
      'WordPress per-site config: title, excerpt, categories and tags. connectionId must match an entry in wordpressConnectionIds',
    ),
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
      'Video frame timestamp (ms) to use as the thumbnail on every platform that takes one: YOUTUBE, FACEBOOK, INSTAGRAM, LINKEDIN, PINTEREST, TELEGRAM and TIKTOK. A thumbnailUrl sent with it wins everywhere except TIKTOK, which takes only a frame, and platformThumbnails overrides both',
    ),
};

const platformTextsField = z
  .array(
    z.object({
      platform: PlatformType.describe('The platform that gets this text instead of the post text; one entry per platform'),
      text: z.string().describe(LINKEDIN_MENTION_RULE),
    }),
  )
  .optional();

const postExtrasFields = {
  firstComments: z
    .array(
      z.object({
        platform: FirstCommentPlatform.describe('The platform whose published post gets this comment'),
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
        platform: ThreadReplyPlatform.describe('The platform whose published post these replies follow'),
        texts: z
          .array(z.string().max(25000))
          .max(25)
          .describe('The replies in order, each trimmed. The limit per reply depends on the platform, see threadReplies'),
        mediaUrls: z
          .array(z.array(z.string()).max(4))
          .max(25)
          .optional()
          .describe(
            'Parallel to texts: the JPEG, PNG, GIF or WEBP image URLs of each reply, from upload_media, and [] for a reply without images',
          ),
      }),
    )
    .optional()
    .describe(
      "Turns the post into a thread: the post opens it and each text is published as a reply to the one before, from the same account, one entry per platform. A reply can carry up to 4 images (JPEG, PNG, GIF or WEBP) through mediaUrls, adapted to the platform like the post's own images; a reply with images may leave its text empty. Available on TWITTER (280 characters per reply, or the account's own limit on X Premium), THREADS (500), BLUESKY (300) and MASTODON (500, or the instance's limit), up to 25 replies. A platform the post does not go to, a reply with neither text nor images, a too long reply, more than 25 replies, more than 4 images or a video on a reply, a second entry for one platform and a platform that also has a first comment are refused with 400. An entry with an empty texts array removes the thread. Replies start about 10 seconds after the platform publishes, 2 seconds apart. A failed run is retried up to 3 times and resumes after the last reply that went out; on X it is not retried, and a lifetime-deal account pays for each reply like any X post. A thread that fails never fails the post: read threadStatus, threadReplyIds and threadError on the platform in get_post. On an update, sending the array replaces every thread and omitting it keeps the stored ones",
    ),
  platformThumbnails: z
    .array(
      z.object({
        platform: ThumbnailPlatform.describe('The platform that uses this thumbnail instead of the post-level one'),
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
      'A different thumbnail for one platform of a VIDEO post, one entry per platform. A platform without an entry uses the post-level thumbnailUrl and thumbnailTimestampMs. YOUTUBE, FACEBOOK, INSTAGRAM, LINKEDIN, PINTEREST and TELEGRAM take an image (thumbnailUrl) or a frame (thumbnailTimestampMs), the image winning when both are sent; TIKTOK takes only a frame. Posts that are not videos, Facebook and Instagram stories, a second entry for one platform and an entry the platform cannot use are refused with 400. On an update, sending the array replaces every override and omitting it keeps the stored ones',
    ),
  platformMedia: z
    .array(
      z.object({
        platform: PlatformType.describe('The platform that publishes this media instead of the post mediaUrls'),
        mediaUrls: z
          .array(z.string())
          .min(1)
          .describe(
            "This platform's media, publicUrl values from upload_media or get_upload_urls. Public https URLs only, no data URIs",
          ),
        mediaAltTexts: z
          .array(z.string().max(1000))
          .optional()
          .describe(
            'Alt text per item, in the same order as this entry\'s mediaUrls (use "" to skip one)',
          ),
      }),
    )
    .optional()
    .describe(
      "Different media for one platform, for when the post media does not fit it (a video too long for TikTok, a carousel with more images than X takes), one entry per platform. A platform without an entry uses the post mediaUrls. The entry must match the post contentType: one video for VIDEO, one image for IMAGE, one document for DOCUMENT, two or more items for CAROUSEL; TEXT posts take none. Each entry is checked against its own platform's limits only, and the post mediaUrls is no longer checked against that platform. An entry for a platform the post does not go to, an empty mediaUrls, a data URI, a second entry for one platform and media of another type are refused with 400. An overridden platform does not use the post-level thumbnailUrl or thumbnailTimestampMs; give it its own through platformThumbnails. On an update, sending the array replaces every override, [] clears them all and omitting it keeps the stored ones; it takes effect even without platforms. get_post shows an override as mediaOverrideUrls and mediaOverrideAltTexts on that platform",
    ),
  platformAspectRatios: z
    .array(
      z.object({
        platform: AspectRatioPlatform.describe('The platform whose images are reframed to aspectRatio'),
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

const twitterConfigsField = {
  twitterConfigs: z
    .array(TwitterConfigSchema)
    .optional()
    .describe(
      "X per-connection config: quoteOf quotes one of the account's own posts with the text as commentary. connectionId must match an entry in twitterConnectionIds",
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
    `What the post carries; it must match mediaUrls. ${CAROUSEL_RULE}. ${GOOGLE_BUSINESS_RULE}. ${TELEGRAM_RULE}. ${WORDPRESS_RULE}. ${DOCUMENT_POST_RULE}`,
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
  ...twitterConfigsField,
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
          `What the post carries; it must match mediaUrls. DOCUMENT posts cannot be bulk scheduled; use create_post. ${CAROUSEL_RULE}. ${GOOGLE_BUSINESS_RULE}. ${TELEGRAM_RULE}. ${WORDPRESS_RULE}`,
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
        wordpressConfigs: z
          .array(WordPressConfigSchema)
          .optional()
          .describe('WordPress config for this item only, such as its own title or categories; replaces the batch-level wordpressConfigs'),
      }),
    )
    .min(1)
    .max(100)
    .describe('The posts to schedule; each is created independently'),
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
      'Restrict to these platforms; omit for every platform with analytics. MASTODON, TELEGRAM, TUMBLR and WORDPRESS have no analytics and are ignored. GOOGLE_BUSINESS reports location impressions only, with no per-post numbers',
    ),
  connectionIds: z
    .array(z.string())
    .optional()
    .describe('Restrict to these accounts, by the account id from list_accounts; omit for every account'),
};

const ANALYTICS_COVERAGE =
  'Analytics cover Facebook, Instagram, Threads, TikTok, Pinterest, Bluesky, LinkedIn, YouTube, X and Google Business Profile (location impressions only, no per-post numbers); Mastodon, Telegram, Tumblr and WordPress have none. Connecting an account imports its posts from the last 180 days, and analytics are kept from then on while the account stays connected, so any date range in that history can be queried.';

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

const resultSchema = (schema: ZodTypeAny, description: string) => ({
  result: schema.describe(description),
});

const UPLOAD_MEDIA_RESULT = z.object({
  uploaded: z.array(z.object({ publicUrl: z.string(), key: z.string() })),
  mediaUrls: z.array(z.string()),
});

const UPLOAD_WIDGET_RESULT = z.object({
  status: z.enum(['waiting_for_upload', 'upload_link', 'waiting', 'saving', 'ready', 'failed', 'expired']),
  uploadUrl: z.string().optional(),
  uploadId: z.string().optional(),
  acceptsUntil: z.string().optional(),
  files: z.array(z.object({ fileName: z.string(), publicUrl: z.string() }).passthrough()).optional(),
  mediaUrls: z.array(z.string()).optional(),
  failed: z.array(z.object({ fileName: z.string(), error: z.string() })).optional(),
  savingCount: z.number().optional(),
});

const UPLOAD_TICKET_RESULT = z.object({
  expiresAt: z.string(),
  uploadUrl: z.string(),
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

const optionalAttachmentString = () => z.preprocess((value) => value ?? undefined, z.string().optional());

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

const SERVER_DESCRIPTION =
  'Schedule, publish and manage social media posts on Facebook, Instagram, Threads, X, LinkedIn, TikTok, YouTube, Pinterest, Bluesky, Mastodon, Tumblr, Telegram, WordPress and Google Business Profile from the user\'s connected accounts. Upload media, draft, validate, schedule and bulk-schedule posts, run recurring posts and RSS feeds, read and answer comments, mentions, direct messages and Google reviews, read post and account analytics, write captions and images with AI, and manage webhooks.';

const SERVER_INSTRUCTIONS = [
  'Tools act as the signed-in member, or the API key\'s creator, with that member\'s workspace role: Admin, Editor, Contributor or Viewer.',
  'A sign-in can reach several workspaces, each with its own accounts, posts and role. Call list_workspaces when the user names a workspace, brand, client or organization, or when expected accounts or posts are missing, then pass that id as workspaceId on every call about it. Without workspaceId, tools act in the workspace list_workspaces marks current.',
  '403 permission_denied: the role forbids this action. Tell the user; do not retry. For a schedule or publish, offer to save the post as a draft for an Admin or Editor to approve, only if the user agrees; keep their scheduledAt, which saveAsDraft stores as the planned date publish_draft uses.',
  '403 workspace_access_denied: this sign-in cannot reach that workspaceId; pick one from list_workspaces. 403 subscription_required: the plan does not include this; tell the user and stop. 401 token_issuer_lost_access: tell the user to reconnect AdaptlyPost or have a member create a new API key. 401 oauth_account_not_found: relay the message and ask the user to reconnect with their AdaptlyPost email. 429: wait for Retry-After; do not loop.',
  'A Contributor can create and edit its own drafts, date them with scheduledAt, upload media, use AI and read posts and analytics, but cannot schedule, publish, retry, bulk schedule, delete non-drafts, sync analytics, manage webhooks or touch others\' posts. Only an Admin removes accounts or creates connect links. A Viewer only reads. get_me says what this connection may do.',
  'Inbox: every role reads; replying, messaging, hiding, liking, deleting and marking need Admin or Editor. Show the user the exact text and the item it answers, and get their yes, before any reply or message; confirm hides and deletes the same way. 403 inbox_reconnect_required: tell the user to reconnect that account; do not retry.',
  'generate_caption, refine_caption and generate_image spend AI credits per call; generate only what the user asked for.',
].join('\n');

const LINK_CLAIM_WAIT_MS = 25_000;

async function uploadLinkResult(uploadId: string, client: RestClient) {
  const state = await claimUploadLink(uploadId, (file) => storeFile(client, file), LINK_CLAIM_WAIT_MS);
  if (!state) {
    return toolError(
      new Error('This upload link is no longer tracked. Call open_upload_widget without uploadId for a new link.'),
    );
  }
  const advice = {
    waiting: 'Nothing has been uploaded through this link yet. Ask the user whether they finished uploading.',
    saving: `${state.savingCount} file(s) are still being saved. Call again in a few seconds.`,
    ready: 'Pass mediaUrls to create_post, update_post or bulk_schedule_posts. Tell the user about any file listed in failed.',
    failed: 'No file could be saved. Tell the user the reason listed in failed for each file.',
    expired: 'The link expired before anything was uploaded. Call open_upload_widget without uploadId for a new link.',
  }[state.status];
  return {
    content: [{ type: 'text' as const, text: `${advice}\n${JSON.stringify(state, null, 2)}` }],
    structuredContent: { result: state },
  };
}

type Caller = { uploadSurface: 'widget' | 'link' | 'widget_or_link' };

// Cowork and Claude Code never render MCP Apps: anthropics/claude-code#103924
const ANTHROPIC_CLIENTS_WITH_MCP_APPS = new Set(['ClaudeAI']);

function callerOf(headers: Record<string, string | string[] | undefined> | undefined): Caller {
  const raw = headers?.['x-anthropic-client'];
  const anthropicClient = Array.isArray(raw) ? raw[0] : raw;
  if (!anthropicClient) return { uploadSurface: 'widget_or_link' };
  return { uploadSurface: ANTHROPIC_CLIENTS_WITH_MCP_APPS.has(anthropicClient) ? 'widget' : 'link' };
}

type ServerTransport = 'stdio' | 'http';

function createMcpServer(transport: ServerTransport, apiClient?: RestClient): McpServer {
  const baseClient = apiClient ?? api;
  const server = new McpServer(
    {
      name: 'adaptlypost',
      title: 'AdaptlyPost',
      version: SERVER_VERSION,
      description: SERVER_DESCRIPTION,
      websiteUrl: 'https://adaptlypost.com/features/agents',
      icons: [
        {
          src: 'https://raw.githubusercontent.com/adaptlypost/agent/main/assets/icon.svg',
          mimeType: 'image/svg+xml',
          sizes: ['any'],
        },
      ],
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
      caller: Caller,
    ) => Promise<CallToolResult>,
  ) => {
    const inputSchema: ZodRawShape = { ...config.inputSchema, ...workspaceIdField };
    return server.registerTool(name, { ...config, inputSchema }, async (args, extra) => {
      const { workspaceId, ...rest } = args as { workspaceId?: string };
      return handler(
        rest as z.objectOutputType<Args, ZodTypeAny>,
        baseClient.forWorkspace(workspaceId),
        callerOf(extra.requestInfo?.headers),
      );
    });
  };

  const stdioOnlyTool = <Args extends ZodRawShape>(...args: Parameters<typeof tool<Args>>): void => {
    if (transport === 'stdio') tool<Args>(...args);
  };

  server.registerTool(
    'list_workspaces',
    {
      title: 'List Workspaces',
      description:
        'List the workspaces this sign-in can act in, across every organization the user belongs to. Returns { workspaces } with id, name, organization { id, name }, role { key, name }, permissions (the permission keys held there), isDefault, current and can { draft, schedule, publish }. Call this when the user names a workspace, brand, client or organization, or when accounts or posts they expect are missing: then pass the matching id as workspaceId to every other tool. Without workspaceId, tools act in the workspace marked current. An API key belongs to one workspace, so it lists only that one. Takes no arguments.',
      inputSchema: {},
      outputSchema: resultSchema(
        apiResponses.listWorkspaces,
        'An object with workspaces: one { id, name, organization, role, permissions, isDefault, current, can } per workspace. Pass id as workspaceId to other tools.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.getMe,
        'An object with tokenType (api_token or oauth), tokenId, tokenName, workspace { id }, organizationId, role { key, name }, issuerRole, permissions, can { draft, schedule, publish }, summary and expiresAt (null for a key that never expires).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        'List the social accounts connected to the workspace (the current one unless workspaceId names another) across all fourteen platforms. Returns { accounts } with id, platform, displayName, username, avatarUrl, status, pageId for Facebook pages, and supportsInstagramAudio for Instagram (true when the account can add audio to Reels, see search_instagram_audio). For a Pinterest account, list_pinterest_boards returns the boards it can pin to; for a WordPress site, list_wordpress_categories returns its categories. For a Google Business Profile location displayName is the location title and username is empty; its id goes in googleBusinessConnectionIds. status is active or unauthorized; an unauthorized account (unauthorizedReason carries the platform\'s message) is refused with 400 by create_post until the user reconnects it in AdaptlyPost, so leave it out and tell the user. Call this before create_post, update_post, or bulk_schedule_posts: they take these ids, never usernames. Pass the ids as accountIds, or put each id in the array for its platform (linkedinConnectionIds, tumblrConnectionIds, telegramConnectionIds, wordpressConnectionIds, and so on); Facebook page accounts go in pageIds. check_account re-checks a Facebook page with Facebook, and remove_account disconnects an account. Not for post history or publishing status: use list_posts or list_post_results for those. Takes only the optional workspaceId.',
      inputSchema: {},
      outputSchema: resultSchema(
        apiResponses.listSocialAccounts,
        'An object with accounts: one { id, platform, displayName, username, avatarUrl, status } per connected account, plus unauthorizedReason when status is unauthorized, pageId for Facebook pages and supportsInstagramAudio for Instagram. Use id as the connection id (or in pageIds for Facebook).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
          .describe('Keywords to search for. Leave out for trending audio'),
      },
      outputSchema: resultSchema(
        apiResponses.searchInstagramAudio,
        'An object with audio: one { audioId, audioType, title, displayArtist, igUsername, durationMs, coverArtworkUrl, profilePictureUrl, previewUrl, instagramUrl, isAdsEligible } per match. Pass audioId as instagramConfigs[].audio.audioId.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.getPinterestBoards,
        'An object with boards: one { id, name, description, privacy, pinCount } per board. Pass id as pinterestConfigs[].boardId, or name as boardName.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
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

  stdioOnlyTool(
    'resolve_linkedin_organization',
    {
      title: 'Look Up LinkedIn Company Page',
      description:
        "Look up a LinkedIn company page so a LinkedIn post can mention (tag) it. Takes the page URL (https://www.linkedin.com/company/acme/), its vanity name (acme, the part after linkedin.com/company/) or @acme. LinkedIn only matches the exact vanity name, so this is not a search: 'acm' or a company name with spaces finds nothing, and you should ask the user for the page URL when you do not know the vanity name. Returns { organization } with id, name, vanityName, urn and mention. Paste mention as it is into the LinkedIn text of create_post, update_post or bulk_schedule_posts; when the post also goes to other platforms, put it in platformTexts for LINKEDIN, because other platforms show the mention syntax as raw text. Fails with linkedin_organization_not_found (404) when no page has that vanity name, linkedin_organization_query_invalid (400) when the query is neither a page URL nor a vanity name, and linkedin_organization_lookup_unavailable (400) when no LinkedIn account of the workspace could run the lookup: tell the user to connect or reconnect a LinkedIn account in AdaptlyPost, ideally a company page they administer. Nothing is posted.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(300)
          .describe('The company page URL, its vanity name, or @vanity, e.g. "https://www.linkedin.com/company/acme/" or "acme"'),
      },
      outputSchema: resultSchema(
        apiResponses.lookupLinkedInOrganization,
        'An object with organization: { id, name, vanityName, urn, mention }. Paste mention into the LinkedIn post text.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ query }, client) => {
      try {
        const data = await client.get('/linkedin-organizations/lookup', { query });
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  tool(
    'list_wordpress_categories',
    {
      title: 'List WordPress Categories',
      description:
        "List the categories of a connected WordPress site, sorted by name. Returns { categories } with id, name and parentId (null for a top-level category). Call it when the user names categories for a WordPress post, match the names to ids, and pass those ids as wordpressConfigs[].categoryIds in create_post, update_post or bulk_schedule_posts. Categories belong to one site, so call it once per WordPress account. A post sent without categoryIds goes to the site's default category. Fails with 404 when accountId is not a WordPress account in the workspace, and with an error carrying the reason when the site refuses the request or cannot be reached, which may mean the user must reconnect the site in AdaptlyPost. Nothing is posted.",
      inputSchema: {
        accountId: z
          .string()
          .describe('The WordPress account id from list_accounts'),
      },
      outputSchema: resultSchema(
        apiResponses.getWordPressCategories,
        'An object with categories: one { id, name, parentId } per category. Pass id in wordpressConfigs[].categoryIds.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ accountId }, client) => {
      try {
        const data = await client.get(
          `/social-accounts/${encodeURIComponent(accountId)}/wordpress-categories`,
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
        apiResponses.checkSocialAccount,
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
      outputSchema: resultSchema(
        apiResponses.removeSocialAccount,
        'An object with id, platform, displayName, pageId for Facebook, and removed: true.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
        idempotentHint: true,
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
        name: z.string().max(80).optional().describe('Label shown in the dashboard list of links'),
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
        apiResponses.createConnectLink,
        'An object with url (the link to send), token (pass it to revoke_connect_link), expiresAt (null when it never expires), name, visibility, allowedPlatforms and maxAccounts.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
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
      outputSchema: resultSchema(
        apiResponses.revokeConnectLink,
        'An object with success: true once the link is revoked.',
      ),
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
              mime_type: optionalAttachmentString().describe(
                'MIME type ChatGPT reports for the file. Informational only: the stored type is detected from the file content',
              ),
              file_name: optionalAttachmentString().describe(
                'Name of the attached file, with its extension. The stored file is named after it; when omitted, the last segment of download_url is used instead, and a PPT, PPTX, DOC or DOCX file whose URL has no extension is then refused',
              ),
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
        UPLOAD_MEDIA_RESULT,
        'An object with uploaded (array of { publicUrl, key } per file) and mediaUrls (the public URLs ready to pass to create_post).',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
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
        'Get presigned upload URLs for direct file uploads. Returns uploadUrl (PUT your file here) and publicUrl (use in create_post mediaUrls). This only mints a URL. You MUST PUT the file to uploadUrl and confirm a 2xx response before using publicUrl, otherwise create_post/bulk rejects it with "Media file(s) not found in storage". If the PUT cannot reach uploadUrl, for example a sandbox network proxy answers 403 or the storage host is not on its allowlist, do not retry it, do not stop, and never put the files in a public repo or file-sharing link: call open_upload_widget and have the user add the files through the upload box or upload link it returns. If the files are ones you made, hand them to the user as downloads first. Prefer upload_media for public URLs and for inline files under 30 MB; use this for larger files you hold yourself. For each file, provide fileName and the mimeType that matches it. GIFs post only to Facebook, X, Bluesky, Mastodon, LinkedIn, Tumblr and WordPress, and the document types are for LinkedIn DOCUMENT posts. Keep the extension in fileName, since the post reads the file type from it. A publicUrl may be reused across any number of posts; the file is kept until the last post referencing it has published.',
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
          .describe('Files to get upload URLs for, one entry per file you will PUT'),
      },
      outputSchema: resultSchema(
        apiResponses.getUploadUrls,
        'An object with urls: one { uploadUrl, publicUrl, key } entry per requested file.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
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
        "Let the user add photos, videos or documents from their phone or computer. Use it when the user wants to post a file that has no public URL, such as a photo on their phone, a file attached in the chat that upload_media cannot read (in ChatGPT, pass attached files to upload_media as attachments instead), or a file you built in a sandbox whose network blocks the get_upload_urls uploadUrl. Never suggest putting the files in a public GitHub repo or a file-sharing link instead. In apps that show MCP Apps widgets, such as ChatGPT and Claude chat, it shows an upload box in the chat, and when the upload finishes the box sends a message listing the public media URLs. In apps that cannot show the box, such as Claude Cowork and Claude Code, it returns status upload_link with uploadUrl, a page the user opens in their browser to upload, and uploadId: give the user the link, wait until they say they finished, then call this tool again with that uploadId to get the media URLs. Pass the media URLs as mediaUrls to create_post, update_post or bulk_schedule_posts. Nothing is uploaded until the user picks files. Accepts JPEG, PNG, WebP, GIF, MP4, QuickTime, PDF, PPT, PPTX, DOC and DOCX, up to 250 MB per file, 50 MB per image and 100 MB per document. Uploaded files are stored at public URLs.",
      inputSchema: {
        uploadId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'uploadId from an earlier call that returned an upload link. Returns the files the user uploaded through that link instead of opening a new upload.',
          ),
      },
      outputSchema: resultSchema(
        UPLOAD_WIDGET_RESULT,
        'Without uploadId: status waiting_for_upload when the upload box is shown (the media URLs arrive later in a message from the box), or status upload_link with uploadUrl, uploadId and acceptsUntil. With uploadId: status (waiting, saving, ready, failed or expired), files ({ fileName, publicUrl } each), mediaUrls, failed ({ fileName, error } each), savingCount and acceptsUntil.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      _meta: {
        ui: { resourceUri: UPLOAD_WIDGET_URI },
        'ui/resourceUri': UPLOAD_WIDGET_URI,
        'openai/outputTemplate': UPLOAD_WIDGET_URI,
        'openai/toolInvocation/invoking': 'Opening the upload box',
        'openai/toolInvocation/invoked': 'Upload box ready',
      },
    },
    async ({ uploadId }, client, caller) => {
      if (!uploadTicketsEnabled() || !isHttpMode) {
        return toolError(
          new Error(
            'Uploading from a device is not available on this server. Ask the user for a public URL and use upload_media.',
          ),
        );
      }
      if (uploadId) return uploadLinkResult(uploadId, client);
      if (caller.uploadSurface === 'widget') {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'The upload box is showing. Wait for the user to upload; the box sends the media URLs in a message when it finishes.',
            },
          ],
          structuredContent: { result: { status: 'waiting_for_upload' } },
        };
      }
      const link = createUploadLink();
      const uploadUrl = uploadLinkUrl(PUBLIC_ORIGIN, link.id);
      const text = caller.uploadSurface === 'link'
        ? `This app cannot show an upload box. Give the user this link to upload their files from their browser: ${uploadUrl} It accepts files until ${link.acceptsUntil}. When the user says they finished, call open_upload_widget with uploadId "${link.id}" to get the media URLs.`
        : `The upload box is showing if this app supports it, and it sends the media URLs in a message when the user finishes. If the user cannot see the box, give them this link instead: ${uploadUrl} When they say they finished, call open_upload_widget with uploadId "${link.id}" to get the media URLs.`;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: {
          result: { status: 'upload_link', uploadUrl, uploadId: link.id, acceptsUntil: link.acceptsUntil },
        },
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
      outputSchema: resultSchema(
        UPLOAD_TICKET_RESULT,
        'An object with expiresAt and uploadUrl for the upload box.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        'Create one post on the user\'s own connected social accounts. saveAsDraft saves a DRAFT and publishes nothing; a scheduledAt sent with it becomes the draft\'s planned date, which publish_draft later schedules. Without saveAsDraft, a future scheduledAt schedules the post; otherwise it publishes now. Before publishing or scheduling, show the user the final text, media, accounts and time (or repeat schedule) and get their confirmation; a draft needs no confirmation. Account ids come from list_accounts (pass them as accountIds, or as platforms plus the per-platform arrays) and mediaUrls from upload_media. Platform-specific options (TikTok privacy, Pinterest board, LinkedIn document or reshare, Google Business event or offer, Tumblr tags, WordPress title, excerpt, categories and tags, YouTube audio language and scheduling on YouTube, Instagram user tags, Facebook link carousel, first comments, threads of replies, different media for one platform, recurrence) are described on each field. To find every problem before creating anything, call validate_post with the same input first. Publishing runs per platform in the background, so the response ({ postId, queuedPlatforms, isScheduled, scheduledAt }) is not the outcome; check list_post_results. Each call creates a separate post, so after an error or timeout check list_posts before trying again. Use update_post or publish_draft for an existing post and bulk_schedule_posts for many posts.',
      inputSchema: createPostShape,
      outputSchema: resultSchema(
        apiResponses.createPost,
        'An object with postId, queuedPlatforms (platforms whose publishing job was queued; empty for scheduled posts and drafts), skippedPlatforms, isScheduled, and scheduledAt, plus recurringPostId when recurrence was sent. Publishing is asynchronous: check list_post_results for outcomes.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
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
        apiResponses.validatePost,
        'A validation report: valid, outcome (DRAFT, SCHEDULED or PUBLISH_NOW), scheduledAt, requiredPermissions, issues (each { code, severity ERROR or WARNING, message, platform, connectionId }), accounts (each { platform, connectionId, accountName, status READY, WARNING or BLOCKED, issues }), and notChecked (each { code, message }).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.getPost,
        'The full post record: id, status, contentType, text, scheduledAt, timezone, mediaUrls, createdAt, updatedAt, recurringPostId and occurrenceAt (set when the post is an occurrence of a recurring post; occurrenceAt is its slot in the series and stays the same when the post is rescheduled), and platforms (one entry per target with id, platform, connectionId or pageId, status, errorMessage, platformPostId, postUrl once published, mediaUrls, previewUrls, and the per-platform settings: firstComment with firstCommentStatus PENDING, PUBLISHED or FAILED, firstCommentId, firstCommentError and firstCommentPublishedAt; threadReplies with threadReplyMediaUrls (the image URLs of each reply), threadStatus, threadReplyIds, threadError and threadPublishedAt; thumbnailUrl and thumbnailTimestampMs overrides; mediaOverrideUrls and mediaOverrideAltTexts (the platform\'s own media from platformMedia, empty when it uses the post media; mediaUrls is what that platform publishes); mediaAspectRatio and mediaAspectRatioFit; instagramCollaborators, instagramUserTags, instagramUntaggedUsernames (tags Instagram refused), instagramAiGenerated, instagramUsername and instagramAudioId, instagramAudioTitle, instagramAudioArtist, instagramAudioVolume, instagramVideoVolume; facebookTextFormatPresetId, facebookImageLayout, facebookCarouselCards and facebookAiGenerated; youtubeAiGenerated, youtubeDefaultAudioLanguage, youtubeScheduleOnYouTube and youtubeScheduledVideoId (the YouTube video id once a scheduleOnYouTube video is uploaded early); linkedinDocumentTitle and linkedinReshareOf; twitterKeepLinks and twitterQuoteOf; tumblrTags, tumblrTitle and tumblrSourceUrl; wordpressTitle, wordpressExcerpt, wordpressCategoryIds and wordpressTags; googleBusinessTopicType, googleBusinessCallToActionType, googleBusinessCallToActionUrl, googleBusinessEventTitle, googleBusinessEventStart, googleBusinessEventEnd and googleBusinessOffer fields). postUrl links to the published post on every platform; Instagram and Facebook stories expire after 24 hours, so for them it links to the profile or page. A shareToStory story is its own entry with postType STORY. previewUrls holds one permanent preview image per media item, a still frame for videos; after publishing, mediaUrls may become platform CDN links that expire within days, so show previewUrls instead.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        'List posts in the workspace (the current one unless workspaceId names another), any status, newest first by default. Returns { posts, total, hasMore }; each post carries its status and a platforms array with per-platform status. Filters: statuses, platforms (posts targeting any of them), and startDate/endDate, which bound scheduledAt, or createdAt for posts never scheduled. Page with offset while hasMore is true. Use this to find post ids or check what is already queued. Use get_post for one post\'s full record and list_post_results for one post\'s per-platform outcomes and retry ids.',
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
        sortOrder: PostSortOrder.optional().describe('Date order of the list; newest first unless OLDEST is sent'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Posts per page'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe('Posts to skip; increase by limit while hasMore is true'),
      },
      outputSchema: resultSchema(
        apiResponses.listPosts,
        'An object with posts (each with id, status, contentType, text, scheduledAt, timezone, recurringPostId and occurrenceAt for occurrences of a recurring post, and platforms with per-platform status), total (count of all matches), and hasMore.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        'Update a DRAFT, SCHEDULED or FAILED post in place. A post that failed on every platform becomes a DRAFT again with its platforms back to pending; publish or schedule it afterwards with publish_draft. Any other status, including a post that published on some platforms and failed on others, fails with "Cannot edit post in current state", so published posts cannot be changed. Updates are partial: text, contentType, scheduledAt, timezone, thumbnail fields, firstComments, platformThumbnails and platformMedia you omit keep their values; sending firstComments, platformThumbnails or platformMedia replaces every stored entry, and platformMedia [] clears every media override. The exception is platforms: sending it rebuilds the post\'s target set from this request alone, so include every connection-id array and platform config you want to keep (TikTok with privacyLevel, Pinterest with its boardId or boardName); omitting platforms leaves accounts, configs, and media untouched. mediaUrls only take effect together with platforms, while platformMedia takes effect without it; use publicUrl values from upload_media. On SCHEDULED posts new media is verified in storage. A post with a YouTube video already waiting on YouTube (youtubeScheduledVideoId set and not yet published) fails with 409 SCHEDULED_ON_YOUTUBE; delete it and schedule it again to change it. Returns the updated post record. Use publish_draft to change a draft\'s status, unschedule_post to take a scheduled post off the calendar, delete_post to cancel, and create_post for a new post.',
      inputSchema: {
        id: z.string().describe('Post ID to update (DRAFT, SCHEDULED, or FAILED on every platform)'),
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
          .nullable()
          .optional()
          .describe(
            'New schedule time as an absolute ISO 8601 instant; omit to keep. On a DRAFT it sets the planned date and the post stays a draft; null takes the planned date off a DRAFT (or a FAILED post, which becomes a draft) and moves it off the calendar. On a SCHEDULED post null fails with 400 (use unschedule_post), and moving it more than a minute into the past fails with 400; use publish_draft to publish now',
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
        ...twitterConfigsField,
      },
      outputSchema: resultSchema(
        apiResponses.updatePost,
        'The updated post record: id, status (DRAFT or SCHEDULED; a FAILED post comes back as DRAFT), text, contentType, scheduledAt, timezone, and platforms with per-target details.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
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
        'Delete a post record from AdaptlyPost by id. Use it to cancel a DRAFT or SCHEDULED post before it goes out; a deleted scheduled post will not publish. Deleting never removes content already on a network: for a COMPLETED or PARTIAL_FAILURE post this only drops AdaptlyPost\'s record, and the live posts stay up until removed on each platform. Prefer update_post to change a post instead of deleting and recreating it. A post in PUBLISHING fails with 409; wait for list_post_results to settle. Deleting a post before scheduledAt also deletes a video it already uploaded to YouTube with scheduleOnYouTube; when YouTube refuses, the delete fails with 502 SCHEDULED_VIDEO_DELETE_FAILED and the post stays, so try again, after reconnecting the channel if it was disconnected. Only posts in the workspace (the current one unless workspaceId names another) can be deleted; others return "Post not found or access denied". Returns { deleted: true }. Irreversible.',
      inputSchema: {
        id: z.string().describe('Post ID to delete, from list_posts or create_post'),
      },
      outputSchema: resultSchema(
        apiResponses.deletePost,
        'An object with deleted: true once the post record is removed from AdaptlyPost.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
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
        'Take a DRAFT or SCHEDULED post off the calendar without deleting it: the post becomes an undated DRAFT (status DRAFT, scheduledAt null) and nothing publishes. Use it when the user wants to hold a scheduled post back; schedule it again later with publish_draft and a scheduledAt, and use delete_post only to drop it entirely. Any other status (PENDING, PUBLISHING, COMPLETED, FAILED, PARTIAL_FAILURE) fails with 400 because the post is already going out or out. A post whose YouTube video already waits on YouTube (scheduleOnYouTube) fails with 409 SCHEDULED_ON_YOUTUBE; delete it instead. Ids outside the workspace (the current one unless workspaceId names another) return 404. Safe to repeat on a post that is already an undated draft. Returns the post record.',
      inputSchema: {
        id: z.string().describe('Post ID with status DRAFT or SCHEDULED, from list_posts or create_post'),
      },
      outputSchema: resultSchema(
        apiResponses.unschedulePost,
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
        'Publish a DRAFT post now or schedule it; SCHEDULED posts are accepted too, to reschedule or push live. Other statuses fail with "Post is not a draft". A future scheduledAt sets SCHEDULED for that time and queues nothing yet; a past one publishes now. Without scheduledAt, a draft whose planned date (the scheduledAt it was saved with) is still in the future is SCHEDULED for that date, and any other post (an undated draft, a planned date already past, a SCHEDULED post) publishes now. publishNow: true publishes now even when the draft has a planned date; sending it with scheduledAt fails with 400. Read the draft with get_post first and tell the user which of these will happen. Publishing now clears the stored scheduledAt, moves the post to PENDING and queues a publishing job per platform: content reaches the networks within moments and cannot be recalled. Fails if an account was disconnected or a TikTok entry lacks privacyLevel; fix with update_post first. A post whose YouTube video already waits on YouTube (scheduleOnYouTube) fails with 409 SCHEDULED_ON_YOUTUBE, since YouTube publishes it at scheduledAt. Not for new content, use create_post. Returns { postId, queuedPlatforms, isScheduled, scheduledAt }: queuedPlatforms lists the platforms whose publishing job was queued and is empty when the post was scheduled for later, so it confirms queueing, not publishing. Check list_post_results afterwards for per-platform outcomes.',
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
            'IANA timezone stored with the post for display (e.g. "America/New_York"); it does not shift scheduledAt. Omitting it stores UTC, replacing the timezone the draft was saved with, so resend the draft\'s timezone from get_post to keep it',
          ),
      },
      outputSchema: resultSchema(
        apiResponses.publishDraft,
        'An object with postId, queuedPlatforms (platforms whose publishing job was queued; empty when scheduled for later), isScheduled, and scheduledAt.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
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
        apiResponses.getPostResults,
        'An object with postId, the overall post status, and results: one { platformId, platform, accountName, status, platformPostId, errorMessage, tiktokDraftFallback, publishedAt } per targeted platform.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.retryFailedPlatforms,
        'An object with postId, queuedPlatforms (platforms re-queued for publishing), and isScheduled: false. Outcomes arrive asynchronously in list_post_results.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
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
        'Schedule up to 100 posts in one call to the same platforms and accounts. Each item supplies its own text, contentType, scheduledAt, and optional media; platforms, connection-id arrays, timezone, and platform configs are shared by every item, though an item may carry its own tiktokConfigs, youtubeConfigs, instagramConfigs, facebookConfigs, pinterestConfigs, googleBusinessConfigs, tumblrConfigs or wordpressConfigs to replace the shared ones, plus its own firstComments, threadReplies, platformThumbnails, platformMedia and platformAspectRatios. twitterKeepLinks, twitterConfigs and linkedinConfigs are not available in bulk. Call validate_bulk_posts with the same input first to see the problems of every item without creating anything. Items are processed independently: each is validated and created like create_post, so one bad item fails alone while the rest are scheduled. Returns { totalScheduled, totalFailed, results[] } with a postId or errorMessage per item, in input order; read every row. An item with a past scheduledAt publishes immediately rather than being rejected. Call list_accounts first; TikTok needs tiktokConfigs with privacyLevel, and Pinterest takes pinterestConfigs with a boardId from list_pinterest_boards or a boardName, not both; an item whose boardName matches no board or several fails alone. Use create_post for a single post or a draft; this tool has no draft mode. These posts publish publicly to the user\'s social accounts: show the user every item\'s text, media and time plus the accounts, and get their confirmation before calling. Each call creates new posts, so calling again after an error or timeout can publish duplicates; check list_posts first.',
      inputSchema: bulkPostsShape,
      outputSchema: resultSchema(
        apiResponses.bulkSchedulePosts,
        'An object with totalScheduled, totalFailed, and results: one { postId, success, isScheduled, scheduledAt, errorMessage } per input item, in input order.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
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
        apiResponses.validateBulkPosts,
        'An object with valid (true when every item is valid), totalValid, totalInvalid, and results: one { index, report } per item, where report has the validate_post shape.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
        'List the recurring posts (series) in the workspace (the current one unless workspaceId names another), created by passing recurrence to create_post. Returns { recurringPosts, total, hasMore }; each series has id, status (ACTIVE, PAUSED or ENDED), pauseReason when paused, frequency, interval, weekdays, startsAt, timezone, endsOn or maxOccurrences, nextOccurrenceAt, occurrenceCount, and the content and platforms every occurrence copies. Only the next occurrence of an ACTIVE series exists as a SCHEDULED post, created about 24 hours ahead; list_posts shows it with recurringPostId set. A series pauses itself after 3 failed posts in a row, when the subscription lapses, when its creator loses workspace access, when one of its accounts is disconnected, or when a platform rejects the content; pauseReason and lastError say which. Page with offset while hasMore is true. Editing a series or skipping one date is only possible in the AdaptlyPost app.',
      inputSchema: {
        statuses: z
          .array(RecurringPostStatus)
          .optional()
          .describe('Filter by status (e.g. ["ACTIVE", "PAUSED"]); omit for all statuses'),
        limit: z.number().int().min(1).max(100).optional().default(20).describe('Recurring posts per page'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe('Recurring posts to skip; increase by limit while hasMore is true'),
      },
      outputSchema: resultSchema(
        apiResponses.listRecurringPosts,
        'An object with recurringPosts (each with id, status, pauseReason, lastError, frequency, interval, weekdays, startsAt, timezone, endsOn, maxOccurrences, nextOccurrenceAt, occurrenceCount, contentType, text, mediaUrls, platformTypes, and platforms), total (count of all matches), and hasMore.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.getRecurringPost,
        'The recurring post: id, userId, status, pauseReason, lastError, frequency, interval, weekdays, startsAt, timezone, endsOn, maxOccurrences, nextOccurrenceAt, occurrenceCount, contentType, text, mediaUrls, mediaAltTexts, thumbnailUrl, platformTypes, platforms, createdAt, and updatedAt.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.pauseRecurringPost,
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
        apiResponses.resumeRecurringPost,
        'The resumed recurring post: id, status (ACTIVE, or ENDED when no slot is left), nextOccurrenceAt, the schedule, occurrenceCount, and the content and platforms.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
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
        apiResponses.deleteRecurringPost,
        'An object with deleted: true once the recurring post is removed.',
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
    platform: RssFeedPlatform.describe('Platform of the account in connectionId'),
    connectionId: z.string().describe('Account id from list_accounts'),
    pageId: z.string().optional().describe('Facebook page id from list_accounts. Required for FACEBOOK'),
  });

  const rssFeedSettingsFields = {
    name: z.string().max(120).optional().describe("Name shown for the feed in AdaptlyPost. Defaults to the feed's title"),
    targets: z
      .array(rssFeedTarget)
      .min(1)
      .max(20)
      .describe(
        'Accounts every new item is posted to, one entry per account',
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
      .describe('Minutes between finding an item and its post going out. Required when postMode is SCHEDULE'),
    contentMode: RssFeedContentMode.describe(
      'TEMPLATE fills template; AI writes one caption per platform from the article, appends the link, spends 1 AI credit per platform per item and needs ai.generate',
    ),
    template: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Post text with {title}, {link}, {description}, {author} and {feed} (default "{title}\\n\\n{link}"). The description, then the title, is shortened to fit each platform; the link is never cut',
      ),
    aiInstructions: z
      .string()
      .max(1000)
      .optional()
      .describe('Extra instructions for AI captions, such as tone or hashtags. Used when contentMode is AI'),
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
      .describe('Post only items whose title or summary contains one of these'),
    excludeKeywords: z
      .array(z.string())
      .max(50)
      .optional()
      .describe('Skip items whose title or summary contains one of these'),
    maxPostsPerCheck: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('New items posted per check (default 3). New items are posted oldest first; the rest wait for the next check'),
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
      .describe('Minutes between checks of the feed (default 60)'),
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
      outputSchema: resultSchema(
        apiResponses.listRssFeeds,
        `An object with rssFeeds: one record per feed. ${RSS_FEED_RECORD}`,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
      outputSchema: resultSchema(
        apiResponses.getRssFeed,
        RSS_FEED_RECORD,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.previewRssFeed,
        'An object with url, title, siteUrl and items: one { title, link, summary, publishedAt, imageUrl, text } per item, where text is the item rendered with template.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
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
      outputSchema: resultSchema(
        apiResponses.createRssFeed,
        `The new feed. ${RSS_FEED_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
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
      outputSchema: resultSchema(
        apiResponses.updateRssFeed,
        `The updated feed. ${RSS_FEED_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
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
      outputSchema: resultSchema(
        apiResponses.deleteRssFeed,
        'An object with deleted: true once the feed is removed.',
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
        limit: z.number().int().min(1).max(100).optional().describe('Items to return, newest first (default 20)'),
      },
      outputSchema: resultSchema(
        apiResponses.listRssFeedItems,
        'An object with items: one { id, createdAt, title, link, publishedAt, status, postId, error } per item.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
      outputSchema: resultSchema(
        apiResponses.pauseRssFeed,
        `The paused feed. ${RSS_FEED_RECORD}`,
      ),
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
      outputSchema: resultSchema(
        apiResponses.resumeRssFeed,
        `The resumed feed. ${RSS_FEED_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
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
      outputSchema: resultSchema(
        apiResponses.checkRssFeedNow,
        `The feed with its new nextCheckAt. ${RSS_FEED_RECORD}`,
      ),
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
        apiResponses.getAnalyticsOverview,
        'An object with views, likes, comments, shares, followers, postsCount, avgViewsPerPost and engagementRate (each { value, previousValue, deltaPercent }), partialMetrics, accountActivityConnectionIds (accounts such as LinkedIn personal profiles and Google Business locations counted by their account-wide activity on each day of the window instead of the posts published in it; they have no rows in list_post_analytics), and lastSyncedAt.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.getAnalyticsTimeseries,
        'An object with points: one { date, views, likes, comments, shares, followers, postsCount, engagementRate } per bucket, in date order.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.getAnalyticsPlatformBreakdown,
        'An object with platforms: one { platform, followers, views, likes, comments, shares, postsCount, avgViewsPerPost, engagementRate, supportedMetrics, accountActivityConnectionIds } per platform, where accountActivityConnectionIds lists the accounts counted by their account-wide daily activity instead of the posts published in the window.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        page: z.number().int().min(1).optional().default(1).describe('Page of results to return; move to the next one while hasMore is true'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe('Posts per page'),
      },
      outputSchema: resultSchema(
        apiResponses.listPostAnalytics,
        'An object with posts (each { id, postId, postPlatformId, platform, publishedAt, title, thumbnailUrl, permalink, connectionId, accountName, metrics }), total, page, limit, and hasMore.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        limit: z.number().int().min(1).max(50).optional().describe('How many top posts to return (default 10)'),
      },
      outputSchema: resultSchema(
        apiResponses.listTopPosts,
        'An object with posts: one { id, postId, postPlatformId, platform, publishedAt, title, thumbnailUrl, permalink, connectionId, accountName, metrics } per post, best first.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        limit: z.number().int().min(1).max(1000).optional().describe('Posts to return (default 200)'),
      },
      outputSchema: resultSchema(
        apiResponses.listDiscoveredPosts,
        'An object with posts: one { id, platform, publishedAt, text, thumbnailUrl, permalink, connectionId, accountName } per post.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        apiResponses.getAnalyticsSyncStatus,
        'An object with accountGroupId, syncInProgress, lastSyncedAt, historyHorizonAt, and platforms: one { platform, connectionId, accountName, status, lastSyncedAt, lastErrorMessage, historyHorizonAt, lastDiscoveryAt, needsAnalyticsReconnect } per connected account.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        'Ask AdaptlyPost to refresh analytics now instead of waiting for the scheduled sync: every connected account is queued and the last 7 days are re-read. Use it when the user just published and wants numbers, or when get_analytics_overview shows an old lastSyncedAt. Allowed once per workspace every 15 minutes, and a YouTube channel read in the last 12 hours is skipped; inside the cooldown, or when no connected account has analytics, it returns queued: false with cooldownSecondsRemaining rather than an error, so do not retry in a loop. The sync runs in the background: poll get_analytics_sync_status until syncInProgress is false, then read the metrics again. Takes only the optional workspaceId and changes no content.',
      inputSchema: {},
      outputSchema: resultSchema(
        apiResponses.triggerAnalyticsSync,
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

  // ── Inbox ──────────────────────────────────────────────────────────────

  const respond = async (run: () => Promise<unknown>) => {
    try {
      return toolResult(await run());
    } catch (error) {
      return toolError(error);
    }
  };

  const inboxPath = (collection: string, id: string, suffix = '') =>
    `/inbox/${collection}/${encodeURIComponent(id)}${suffix}`;

  const INBOX_SYNC =
    'The inbox syncs every 10 minutes per account; refresh_inbox asks for a sync now.';

  const INBOX_READ_RULE = 'Needs the inbox.read permission, which every role holds.';

  const INBOX_REPLY_RULE =
    'Needs the inbox.reply permission, which Admin and Editor hold (403 permission_denied otherwise), and an active plan.';

  const INBOX_RECONNECT_RULE =
    'A 403 with code inbox_reconnect_required means the account lacks the platform permission for this channel or action (some channels still wait on platform review) or its token expired: tell the user to reconnect the account in AdaptlyPost and do not retry.';

  const INBOX_REFUSALS =
    '404 inbox_item_not_found means the id is unknown in this workspace. 429 inbox_rate_limited means the platform rate limited the call: wait a while before trying again. 503 inbox_platform_error means the platform failed: try again later.';

  const INBOX_CONFIRM =
    'This sends text to a real person from the account: show the user the exact text and the item it answers, and get their yes before calling.';

  const INBOX_COMMENT_RECORD =
    'An InboxComment: id, accountId, platform, accountName, postId (the AdaptlyPost post id, null when the post was not published through AdaptlyPost), platformPostId, postText, postPermalink, platformCommentId, parentPlatformCommentId (null for a top-level comment), isReply, author { id, name, username, avatarUrl }, text, permalink, likeCount, createdAt, status (UNREAD, READ or DONE), isHidden, isOwn, replied (the account has a reply under it, sent from AdaptlyPost or the platform app), repliedAt, likedByAccount and capabilities { canReply, canHide, canDelete, canLike }.';

  const INBOX_MENTION_RECORD =
    'An InboxMention: id, accountId, platform, accountName, platformMentionId, author { id, name, username, avatarUrl }, text, permalink, thumbnailUrl, createdAt, status, replied, repliedAt, capabilities { canReply } and replies (each { id, text, permalink, createdAt }).';

  const INBOX_CONVERSATION_RECORD =
    'An InboxConversation: id, accountId, platform, accountName, participant { id, name, username, avatarUrl }, lastMessageText, lastMessageAt, lastMessageIsOwn, status, repliedAt, replyWindowEndsAt (the end of the 24-hour Facebook and Instagram reply window, else null), maxMessageLength and capabilities { canReply }.';

  const INBOX_REVIEW_RECORD =
    'An InboxReview: id, accountId, platform (GOOGLE_BUSINESS), accountName, platformReviewId, reviewer { name, avatarUrl, isAnonymous }, rating (1 to 5), text, reply ({ text, updatedAt } or null), createdAt, updatedAt, status, repliedAt, maxReplyLength and capabilities { canReply }.';

  const inboxIdField = (what: string, source: string) => ({
    id: z.string().min(1).describe(`The ${what} id, from ${source}`),
  });

  const inboxReplyTextField = (limits: string) => ({
    text: z.string().min(1).max(10000).describe(`The text to send. ${limits}`),
  });

  const inboxListFields = {
    accountIds: z
      .array(z.string())
      .max(50)
      .optional()
      .describe('Only these accounts, by the id from list_accounts. Omit for every account'),
    platforms: z.array(PlatformType).optional().describe('Only these platforms'),
    statuses: z
      .array(InboxStatus)
      .optional()
      .describe('Only items with these inbox statuses. Omit for every status'),
    since: z
      .string()
      .optional()
      .describe(
        'ISO 8601 date-time. Only items created on the platform at or after it; for conversations, only those with a message at or after it. Omit for items of any date',
      ),
    search: z.string().max(200).optional().describe('Free text to search the items for'),
    limit: z.number().int().min(1).max(100).optional().describe('Items per page (default 25)'),
    cursor: z
      .string()
      .optional()
      .describe('nextCursor from the previous page. Omit for the first page; nextCursor is null on the last page'),
  };

  const inboxStatusFields = (what: string, source: string) => ({
    ids: z.array(z.string()).min(1).max(100).describe(`Ids of the ${what}s to mark, from ${source}`),
    status: InboxStatus.describe('Inbox status to give every listed item'),
  });

  const COMMENT_REPLY_LIMITS =
    'The limit is the platform\'s comment limit: LinkedIn 1250 characters, Threads 500, Bluesky 300, Mastodon 500, YouTube 10000, Facebook 8000, Instagram 2200. Empty or too long text answers 400 inbox_reply_invalid, whose message names the limit';

  tool(
    'get_inbox_summary',
    {
      title: 'Get Inbox Summary',
      description: `Unread counts for the workspace inbox and what each connected account can do in it. The inbox holds comments on the account's posts (Facebook, Instagram, Threads, YouTube, Bluesky, Mastodon and LinkedIn), mentions (Facebook, Instagram, Threads, Bluesky and Mastodon), direct messages (Facebook, Instagram, Bluesky and Mastodon) and Google Business Profile reviews; TikTok and X have no inbox. Each account lists comments, mentions, messages and reviews as AVAILABLE, RECONNECT_REQUIRED (the account lacks the platform permission, some of which still wait on platform review, or its token expired: tell the user to reconnect it in AdaptlyPost) or UNSUPPORTED. Call it first when the user asks what is new or why a channel is empty. ${INBOX_SYNC} ${INBOX_READ_RULE} Takes only the optional workspaceId.`,
      inputSchema: {},
      outputSchema: resultSchema(
        apiResponses.getInboxSummary,
        'An object with unread { comments, mentions, conversations, reviews } and accounts: one { accountId, platform, accountName, avatarUrl, needsReconnect, lastSyncedAt, lastErrorCode, comments, mentions, messages, reviews } per account, each channel AVAILABLE, RECONNECT_REQUIRED or UNSUPPORTED.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (_args, client) => respond(() => client.get('/inbox/summary')),
  );

  tool(
    'refresh_inbox',
    {
      title: 'Refresh Inbox',
      description: `Queue an inbox sync for every connected account now instead of waiting for the next 10-minute run. It returns at once with { queued: true }; new items show up in the list tools a minute or so later, so do not poll in a tight loop. Nothing is sent to anyone. ${INBOX_READ_RULE} Takes only the optional workspaceId.`,
      inputSchema: {},
      outputSchema: resultSchema(
        apiResponses.refreshInbox,
        'An object with queued: true.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (_args, client) => respond(() => client.post('/inbox/refresh')),
  );

  tool(
    'list_inbox_comments',
    {
      title: 'List Inbox Comments',
      description: `List comments on the account's posts, newest first, on Facebook, Instagram, Threads, YouTube, Bluesky, Mastodon and LinkedIn. Filter by account, platform, status, date, text, an AdaptlyPost post (postId from list_posts) or the platform's own post id. Page with cursor while hasMore is true. Each comment's capabilities say whether it can be replied to, hidden, deleted or liked. ${INBOX_SYNC} ${INBOX_READ_RULE}`,
      inputSchema: {
        ...inboxListFields,
        postId: z.string().optional().describe('Only comments on this AdaptlyPost post, by its id from list_posts or get_post'),
        platformPostId: z.string().optional().describe("Only comments on this post, by the platform's own post id"),
      },
      outputSchema: resultSchema(
        apiResponses.listInboxComments,
        `An object with comments, total, hasMore and nextCursor (null on the last page). Each comment is ${INBOX_COMMENT_RECORD}`,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input, client) => respond(() => client.get('/inbox/comments', input)),
  );

  tool(
    'get_inbox_comment',
    {
      title: 'Get Inbox Comment',
      description: `Get one inbox comment with its parent comment (when it is a reply) and the replies under it, to read a conversation before answering. 404 inbox_item_not_found when the id is unknown in this workspace. ${INBOX_READ_RULE}`,
      inputSchema: inboxIdField('comment', 'list_inbox_comments'),
      outputSchema: resultSchema(
        apiResponses.getInboxComment,
        `An object with comment, parent (null for a top-level comment) and replies. Each is ${INBOX_COMMENT_RECORD}`,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => respond(() => client.get(inboxPath('comments', id))),
  );

  tool(
    'reply_to_inbox_comment',
    {
      title: 'Reply To Comment',
      description: `Post a public reply to a comment, from the account the comment was left on. Works where the comment's capabilities.canReply is true, on Facebook, Instagram, Threads, YouTube, Bluesky, Mastodon and LinkedIn. ${INBOX_CONFIRM} Each call posts a new reply, so after an error or timeout read get_inbox_comment before trying again. ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: {
        ...inboxIdField('comment', 'list_inbox_comments'),
        ...inboxReplyTextField(COMMENT_REPLY_LIMITS),
      },
      outputSchema: resultSchema(
        apiResponses.replyToInboxComment,
        `The new reply. ${INBOX_COMMENT_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ id, text }, client) => respond(() => client.post(inboxPath('comments', id, '/reply'), { text })),
  );

  tool(
    'hide_inbox_comment',
    {
      title: 'Hide Comment',
      description: `Hide a comment on the platform so other people no longer see it, where capabilities.canHide is true. Confirm with the user first, naming the comment. A comment that cannot be hidden answers 400 inbox_action_unsupported; stop there. unhide_inbox_comment reverses it. ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: inboxIdField('comment', 'list_inbox_comments'),
      outputSchema: resultSchema(
        apiResponses.hideInboxComment,
        `The comment with isHidden: true. ${INBOX_COMMENT_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => respond(() => client.post(inboxPath('comments', id, '/hide'))),
  );

  tool(
    'unhide_inbox_comment',
    {
      title: 'Unhide Comment',
      description: `Show a hidden comment on the platform again, where capabilities.canHide is true. A comment that cannot be unhidden answers 400 inbox_action_unsupported; stop there. ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: inboxIdField('comment', 'list_inbox_comments'),
      outputSchema: resultSchema(
        apiResponses.unhideInboxComment,
        `The comment with isHidden: false. ${INBOX_COMMENT_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => respond(() => client.post(inboxPath('comments', id, '/unhide'))),
  );

  tool(
    'like_inbox_comment',
    {
      title: 'Like Comment',
      description: `Like a comment from the account, on Facebook, Bluesky, Mastodon (a favourite) and LinkedIn. Instagram, YouTube and Threads do not allow it, and a comment whose capabilities.canLike is false answers 400 inbox_action_unsupported; stop there. The like is public. ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: inboxIdField('comment', 'list_inbox_comments'),
      outputSchema: resultSchema(
        apiResponses.likeInboxComment,
        `The comment with likedByAccount: true. ${INBOX_COMMENT_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => respond(() => client.post(inboxPath('comments', id, '/like'))),
  );

  tool(
    'unlike_inbox_comment',
    {
      title: 'Unlike Comment',
      description: `Take back the account's like on a comment, on Facebook, Bluesky, Mastodon and LinkedIn. A comment whose capabilities.canLike is false answers 400 inbox_action_unsupported; stop there. ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: inboxIdField('comment', 'list_inbox_comments'),
      outputSchema: resultSchema(
        apiResponses.unlikeInboxComment,
        `The comment with likedByAccount: false. ${INBOX_COMMENT_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => respond(() => client.delete(inboxPath('comments', id, '/like'))),
  );

  tool(
    'delete_inbox_comment',
    {
      title: 'Delete Comment',
      description: `Delete a comment on the platform and from the inbox, where capabilities.canDelete is true. Facebook and LinkedIn allow any comment on the Page's or organization's posts, Instagram any comment on the account's media, and YouTube, Threads, Bluesky and Mastodon only the account's own comments and replies. Anything else answers 400 inbox_action_unsupported; stop there. It cannot be undone, so confirm with the user first, quoting the comment. ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: inboxIdField('comment', 'list_inbox_comments'),
      outputSchema: resultSchema(
        apiResponses.deleteInboxComment,
        'An object with deleted: true.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => respond(() => client.delete(inboxPath('comments', id))),
  );

  tool(
    'update_inbox_comments_status',
    {
      title: 'Mark Inbox Comments',
      description: `Mark up to 100 comments UNREAD, READ or DONE in the AdaptlyPost inbox. Only AdaptlyPost changes; nothing is sent to the platform. ${INBOX_REPLY_RULE}`,
      inputSchema: inboxStatusFields('comment', 'list_inbox_comments'),
      outputSchema: resultSchema(
        apiResponses.updateInboxCommentsStatus,
        `An object with comments (the updated comments) and unreadCount. ${INBOX_COMMENT_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input, client) => respond(() => client.post('/inbox/comments/status', input)),
  );

  tool(
    'list_inbox_mentions',
    {
      title: 'List Inbox Mentions',
      description: `List posts and comments that mention the account, newest first, on Facebook, Instagram, Threads, Bluesky and Mastodon. Page with cursor while hasMore is true. An account whose mentions show RECONNECT_REQUIRED in get_inbox_summary returns none until the user reconnects it in AdaptlyPost. ${INBOX_SYNC} ${INBOX_READ_RULE}`,
      inputSchema: inboxListFields,
      outputSchema: resultSchema(
        apiResponses.listInboxMentions,
        `An object with mentions, total, hasMore and nextCursor (null on the last page). Each mention is ${INBOX_MENTION_RECORD}`,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input, client) => respond(() => client.get('/inbox/mentions', input)),
  );

  tool(
    'reply_to_inbox_mention',
    {
      title: 'Reply To Mention',
      description: `Post a public reply to a mention, from the account that was mentioned, where capabilities.canReply is true. ${INBOX_CONFIRM} Each call posts a new reply, so after an error or timeout check the mention's replies in list_inbox_mentions before trying again. ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: {
        ...inboxIdField('mention', 'list_inbox_mentions'),
        ...inboxReplyTextField(
          'The limit is the platform\'s reply limit: Threads 500 characters, Bluesky 300, Mastodon 500, Facebook 8000, Instagram 2200. Empty or too long text answers 400 inbox_reply_invalid, whose message names the limit',
        ),
      },
      outputSchema: resultSchema(
        apiResponses.replyToInboxMention,
        `The mention with the new reply in replies. ${INBOX_MENTION_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ id, text }, client) => respond(() => client.post(inboxPath('mentions', id, '/reply'), { text })),
  );

  tool(
    'update_inbox_mentions_status',
    {
      title: 'Mark Inbox Mentions',
      description: `Mark up to 100 mentions UNREAD, READ or DONE in the AdaptlyPost inbox. Only AdaptlyPost changes; nothing is sent to the platform. ${INBOX_REPLY_RULE}`,
      inputSchema: inboxStatusFields('mention', 'list_inbox_mentions'),
      outputSchema: resultSchema(
        apiResponses.updateInboxMentionsStatus,
        `An object with mentions (the updated mentions) and unreadCount. ${INBOX_MENTION_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input, client) => respond(() => client.post('/inbox/mentions/status', input)),
  );

  tool(
    'list_inbox_conversations',
    {
      title: 'List Inbox Conversations',
      description: `List direct message conversations, most recent message first, on Facebook (Messenger), Instagram, Bluesky and Mastodon. Returns { conversations, total, hasMore, nextCursor }; each conversation has the account, the other participant, the last message text and time, its inbox status, replyWindowEndsAt and capabilities.canReply, but not the messages themselves, which get_inbox_conversation returns. Page with cursor while hasMore is true. An account whose messages show RECONNECT_REQUIRED in get_inbox_summary returns none until the user reconnects it in AdaptlyPost. ${INBOX_SYNC} ${INBOX_READ_RULE}`,
      inputSchema: inboxListFields,
      outputSchema: resultSchema(
        apiResponses.listInboxConversations,
        `An object with conversations, total, hasMore and nextCursor (null on the last page). Each conversation is ${INBOX_CONVERSATION_RECORD}`,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input, client) => respond(() => client.get('/inbox/conversations', input)),
  );

  tool(
    'get_inbox_conversation',
    {
      title: 'Get Inbox Conversation',
      description: `Get one direct message conversation with its messages, to read the thread before answering. 404 inbox_item_not_found when the id is unknown in this workspace. ${INBOX_READ_RULE}`,
      inputSchema: inboxIdField('conversation', 'list_inbox_conversations'),
      outputSchema: resultSchema(
        apiResponses.getInboxConversation,
        `An object with conversation and messages: one { id, isOwn, text, hasAttachments, createdAt } per message. ${INBOX_CONVERSATION_RECORD}`,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => respond(() => client.get(inboxPath('conversations', id))),
  );

  tool(
    'send_inbox_message',
    {
      title: 'Send Direct Message',
      description: `Send a direct message in a conversation, from the account, where capabilities.canReply is true. Facebook and Instagram only allow a reply within 24 hours of the person's last message (replyWindowEndsAt); after that the call answers 400 inbox_messaging_window_closed, so stop and tell the user. ${INBOX_CONFIRM} Each call sends a new message, so after an error or timeout read get_inbox_conversation before trying again. ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: {
        ...inboxIdField('conversation', 'list_inbox_conversations'),
        ...inboxReplyTextField(
          "Up to the conversation's maxMessageLength. Empty or too long text answers 400 inbox_reply_invalid, whose message names the limit",
        ),
      },
      outputSchema: resultSchema(
        apiResponses.sendInboxMessage,
        `An object with conversation and message ({ id, isOwn, text, hasAttachments, createdAt }). ${INBOX_CONVERSATION_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ id, text }, client) =>
      respond(() => client.post(inboxPath('conversations', id, '/messages'), { text })),
  );

  tool(
    'update_inbox_conversations_status',
    {
      title: 'Mark Inbox Conversations',
      description: `Mark up to 100 conversations UNREAD, READ or DONE in the AdaptlyPost inbox. Only AdaptlyPost changes; nothing is sent to the platform. ${INBOX_REPLY_RULE}`,
      inputSchema: inboxStatusFields('conversation', 'list_inbox_conversations'),
      outputSchema: resultSchema(
        apiResponses.updateInboxConversationsStatus,
        `An object with conversations (the updated conversations) and unreadCount. ${INBOX_CONVERSATION_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input, client) => respond(() => client.post('/inbox/conversations/status', input)),
  );

  tool(
    'list_inbox_reviews',
    {
      title: 'List Inbox Reviews',
      description: `List Google Business Profile reviews of the connected locations, newest first. Returns { reviews, total, hasMore, nextCursor }; each review has the location, reviewer name, star rating, text, the location's current reply (or null), its inbox status and capabilities.canReply. Filter by rating and by whether the review already has a reply, plus the usual inbox filters. Page with cursor while hasMore is true. ${INBOX_SYNC} ${INBOX_READ_RULE}`,
      inputSchema: {
        ...inboxListFields,
        ratings: z
          .array(z.number().int().min(1).max(5))
          .optional()
          .describe('Only reviews with these star ratings'),
        replied: z
          .boolean()
          .optional()
          .describe('true for reviews that already have a reply, false for those without one'),
      },
      outputSchema: resultSchema(
        apiResponses.listInboxReviews,
        `An object with reviews, total, hasMore and nextCursor (null on the last page). Each review is ${INBOX_REVIEW_RECORD}`,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input, client) => respond(() => client.get('/inbox/reviews', input)),
  );

  tool(
    'reply_to_inbox_review',
    {
      title: 'Reply To Review',
      description: `Post the location's public reply to a Google review. Google allows one reply per review, so this replaces any reply already there; show the user the old reply too when there is one. ${INBOX_CONFIRM} ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: {
        ...inboxIdField('review', 'list_inbox_reviews'),
        ...inboxReplyTextField(
          'Up to 4096 bytes in UTF-8 (maxReplyLength on the review). Empty or too long text answers 400 inbox_reply_invalid',
        ),
      },
      outputSchema: resultSchema(
        apiResponses.replyToInboxReview,
        `The review with its new reply. ${INBOX_REVIEW_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id, text }, client) => respond(() => client.put(inboxPath('reviews', id, '/reply'), { text })),
  );

  tool(
    'delete_inbox_review_reply',
    {
      title: 'Delete Review Reply',
      description: `Delete the location's reply to a Google review; the review itself stays. It cannot be undone, so confirm with the user first, quoting the reply. ${INBOX_RECONNECT_RULE} ${INBOX_REFUSALS} ${INBOX_REPLY_RULE}`,
      inputSchema: inboxIdField('review', 'list_inbox_reviews'),
      outputSchema: resultSchema(
        apiResponses.deleteInboxReviewReply,
        `The review with reply: null. ${INBOX_REVIEW_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id }, client) => respond(() => client.delete(inboxPath('reviews', id, '/reply'))),
  );

  tool(
    'update_inbox_reviews_status',
    {
      title: 'Mark Inbox Reviews',
      description: `Mark up to 100 reviews UNREAD, READ or DONE in the AdaptlyPost inbox. Only AdaptlyPost changes; nothing is sent to Google. ${INBOX_REPLY_RULE}`,
      inputSchema: inboxStatusFields('review', 'list_inbox_reviews'),
      outputSchema: resultSchema(
        apiResponses.updateInboxReviewsStatus,
        `An object with reviews (the updated reviews) and unreadCount. ${INBOX_REVIEW_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (input, client) => respond(() => client.post('/inbox/reviews/status', input)),
  );

  // ── Webhooks ───────────────────────────────────────────────────────────

  const webhookIdField = { id: z.string().describe('Webhook id from list_webhooks or create_webhook') };

  const WEBHOOK_RECORD =
    'The webhook: id, url, active, events (empty means the default post, account and image events), createdAt, updatedAt, lastSuccessAt, lastFailureAt and disabledAt (set when it was turned off after 20 failed deliveries in a row).';

  const webhookEventsField = z
    .array(WebhookEvent)
    .optional()
    .describe(
      'Events this endpoint receives. Omit it or send [] for the default set: post.published, post.partially_failed, post.failed, post.scheduled, account.unauthorized, image.completed and image.failed. The inbox events comment.created (a new comment from someone else), comment.replied (the account replied, from AdaptlyPost or the platform app), mention.created, message.received and review.created (a new Google review) reach only an endpoint that lists them. A non-empty list means only the listed events. Inbox events arrive within about 10 minutes, after the next inbox sync, and the first sync of an account fires none for its history',
    );

  tool(
    'list_webhooks',
    {
      title: 'List Webhooks',
      description:
        'List the webhook endpoints registered for the workspace (the current one unless workspaceId names another), with whether each is active and when it last succeeded or failed. Needs the webhooks.read permission, which Admin, Editor and Viewer hold. Takes only the optional workspaceId.',
      inputSchema: {},
      outputSchema: resultSchema(
        apiResponses.listWebhooks,
        `An object with webhooks: one record per endpoint. ${WEBHOOK_RECORD}`,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
      outputSchema: resultSchema(
        apiResponses.getWebhook,
        WEBHOOK_RECORD,
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
        "Register a URL that receives workspace events as HTTP POSTs. Without events it gets the default set: post.published, post.partially_failed, post.failed, post.scheduled, account.unauthorized, image.completed and image.failed. To also get inbox events (comment.created, comment.replied, mention.created, message.received, review.created), list every event wanted in events, since a non-empty list means only those. Each delivery carries the x-adaptly-signature, x-adaptly-timestamp, x-adaptly-event and x-adaptly-webhook-id headers; the signature is sha256=HMAC_SHA256(secret, \"{timestamp}.{rawBody}\"). Failed deliveries are retried up to 5 times with exponential backoff, and an endpoint is turned off after 20 failed deliveries in a row. The response is the only time the signing secret is shown, so give it to the user to store. Fails with 400 for an invalid URL or the webhook limit, and 409 when the URL is already registered. Needs the webhooks.manage permission, which Admin and Editor hold.",
      inputSchema: {
        url: z.string().url().describe('Publicly reachable http(s) endpoint that receives the events'),
        events: webhookEventsField,
      },
      outputSchema: resultSchema(
        apiResponses.createWebhook,
        `The new webhook plus secret, the signing secret shown only this once. ${WEBHOOK_RECORD}`,
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
        'Change a webhook endpoint\'s URL or the events it receives, or turn it off or back on with active. Sending events replaces the list, and [] goes back to the default set. Turning on an endpoint that was turned off after failed deliveries starts sending again. Events that happen while an endpoint is off, or that a new events list leaves out, are never delivered later, and after a URL change the old URL receives nothing more, so confirm the change with the user first. Fails with 409 when the new URL is already registered. Needs the webhooks.manage permission.',
      inputSchema: {
        ...webhookIdField,
        url: z.string().url().optional().describe('New http(s) endpoint URL'),
        active: z.boolean().optional().describe('false stops deliveries, true resumes them'),
        events: webhookEventsField,
      },
      outputSchema: resultSchema(
        apiResponses.updateWebhook,
        `The updated webhook. ${WEBHOOK_RECORD}`,
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true,
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
      outputSchema: resultSchema(
        apiResponses.deleteWebhook,
        'An object with deleted: true once the webhook is removed.',
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
        apiResponses.testWebhook,
        'An object with success, statusCode (the HTTP status the endpoint answered) and error when the delivery failed.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
        idempotentHint: false,
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
            'What the caption should say or be about, including tone, audience, hashtags or a call to action',
          ),
        platform: CaptionPlatform.optional().describe(
          "Platform the caption is for; generation targets that platform's character limit; check the returned text before posting. Omit for a general caption",
        ),
      },
      outputSchema: resultSchema(
        apiResponses.generateCaption,
        'An object with caption: the generated text.',
      ),
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
          .describe('How the caption should change'),
        originalText: z
          .string()
          .min(1)
          .max(10000)
          .describe('The caption to rewrite'),
        partialText: z
          .string()
          .max(10000)
          .optional()
          .describe('A partly written caption to continue from'),
        platform: CaptionPlatform.optional().describe(
          "Platform the caption is for; generation targets that platform's character limit; check the returned text before posting",
        ),
      },
      outputSchema: resultSchema(
        apiResponses.refineCaption,
        'An object with caption: the rewritten text.',
      ),
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
          .describe('What the image should show, including style and composition'),
        aspectRatio: ImageAspectRatio.optional().describe(
          'Image shape (default 1:1). Pick one that suits the target platform, e.g. 9:16 for stories and reels, 4:5 for Instagram feed, 16:9 for YouTube and X',
        ),
        model: ImageModel.optional().describe(
          'standard (default, 2 credits) or premium (higher fidelity, 4 credits)',
        ),
        quality: ImageQuality.optional().describe('Rendering quality of the image'),
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
          .describe('Image URLs the user provided, such as publicUrl values from upload_media, to guide the style or subject'),
      },
      outputSchema: resultSchema(
        apiResponses.generateImage,
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
        apiResponses.getImageJob,
        'An object with jobId, sessionId, status (queued, processing, generating, completed or failed), imageUrl (null until completed), imageId, and error (null unless failed).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
  client?: RestClient;
  linkId?: string;
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

const LINK_EXPIRED_MESSAGE = 'This upload link expired. Ask the assistant for a new one.';

async function handleUploadSessionStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ticket = await openUploadTicket(String(req.headers[UPLOAD_TICKET_HEADER] ?? ''));
  const linkId = ticket ? undefined : String(req.headers[UPLOAD_LINK_HEADER] ?? '') || undefined;
  if (!ticket && !(linkId && uploadLinkOpen(linkId))) {
    req.resume();
    sendJson(res, 401, { error: linkId ? LINK_EXPIRED_MESSAGE : 'This upload box expired. Ask for a new one.' });
    return;
  }

  try {
    const parsed = UploadUrlRequest.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new Error('The upload request is malformed.');
    const { fileName, fileSize, head } = parsed.data;
    const mimeType = requireStreamedMedia(Buffer.from(head, 'base64'), fileName, fileSize);
    if (linkId) reserveLinkUpload(linkId, fileSize);
    const dir = await mkdtemp(join(tmpdir(), 'upload-'));
    const path = join(dir, 'file');
    await writeFile(path, '');
    const id = randomUUID();
    uploadSessions.set(id, {
      client: ticket ? new RestClient(API_BASE_URL, ticket.token).forWorkspace(ticket.workspaceId) : undefined,
      linkId,
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

async function storeFile(client: RestClient, file: Omit<ParkedFile, 'dir'>): Promise<Uploaded> {
  const mimeType = requireStreamedMedia(await readFileHead(file.path), file.fileName, file.size);
  if (mimeType !== file.mimeType) throw new Error(`${file.fileName} is not the file that was announced.`);
  const { uploadUrl, publicUrl, key } = await mintUploadUrl(
    client,
    fileNameFor(file.fileName, mimeType),
    mimeType,
    file.size,
  );
  await putStream(uploadUrl, { mimeType, contentLength: file.size, body: createReadStream(file.path) });
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
  if (!session.client) {
    const { fileName, mimeType, size, dir, path } = session;
    if (session.linkId && parkLinkUpload(session.linkId, { fileName, mimeType, size, dir, path })) {
      console.error(`upload-link parked bytes=${size}`);
      sendJson(res, 200, { held: true });
    } else {
      void rm(dir, { recursive: true, force: true });
      sendJson(res, 410, { error: LINK_EXPIRED_MESSAGE });
    }
    return;
  }
  const work = storeFile(session.client, session);
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

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'X-Frame-Options': 'DENY',
  });
  res.end(html);
}

function routeUploadLink(req: IncomingMessage, res: ServerResponse): void {
  const [, , id = '', extra] = (req.url ?? '').split('?')[0].split('/');
  req.resume();
  if (req.method !== 'GET' || extra !== undefined) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (uploadLinkOpen(id)) sendHtml(res, 200, uploadWidgetHtml(PUBLIC_ORIGIN, id));
  else sendHtml(res, 410, uploadLinkExpiredHtml());
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
            'Content-Type, Authorization, mcp-session-id, X-Upload-Ticket, X-Upload-Link, X-File-Name',
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

      if (req.url?.startsWith(`${UPLOAD_LINK_PATH}/`)) {
        routeUploadLink(req, res);
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
        const reqServer = createMcpServer('http', reqApi);
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
    const server = createMcpServer('stdio');
    const transport = new StdioServerTransport();
    await server.connect(withoutSchemaDialect(transport));
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
