#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createServer, type IncomingMessage } from 'node:http';

import { describeUrl, downloadPublicMedia, EXT_BY_MIME, fileNameFor, requireMediaContent } from './media.js';
import { RestClient } from './rest-client.js';
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

const oauthConfig = oauthConfigFromEnv({
  resourceUrl: 'https://mcp.adaptlypost.com/mcp',
  resourceName: 'AdaptlyPost',
});

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

const PlatformType = z.enum([
  'LINKEDIN',
  'YOUTUBE',
  'INSTAGRAM',
  'FACEBOOK',
  'TIKTOK',
  'PINTEREST',
  'THREADS',
  'BLUESKY',
  'TWITTER',
]);

const ContentType = z.enum(['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL']);

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
});

const InstagramConfigSchema = z.object({
  connectionId: z
    .string()
    .describe('Instagram connection ID from list_accounts'),
  postType: z
    .enum(['FEED', 'REEL', 'STORY'])
    .optional()
    .describe('Instagram post type — FEED, REEL, or STORY'),
});

const FacebookConfigSchema = z.object({
  pageId: z.string().describe('Facebook page ID from list_accounts'),
  postType: z
    .enum(['FEED', 'REEL', 'STORY'])
    .optional()
    .describe('Facebook post type — FEED, REEL, or STORY'),
  videoTitle: z
    .string()
    .max(255)
    .optional()
    .describe('Video title for Facebook (max 255 chars)'),
});

const PinterestConfigSchema = z.object({
  connectionId: z
    .string()
    .describe('Pinterest connection ID from list_accounts'),
  boardId: z.string().describe('Pinterest board ID to pin to (required)'),
  title: z.string().max(100).optional().describe('Pin title (max 100 chars)'),
  link: z.string().optional().describe('Destination URL for the pin'),
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
  pinterestConnectionIds: z.array(z.string()).optional().describe('Pinterest account connection IDs to post from'),
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
      'Instagram per-connection config to set post type (FEED, REEL, STORY)',
    ),
  facebookConfigs: z
    .array(FacebookConfigSchema)
    .optional()
    .describe(
      'Facebook per-page config with post type and video title. pageId must match an entry in pageIds',
    ),
  pinterestConfigs: z
    .array(PinterestConfigSchema)
    .optional()
    .describe(
      'Pinterest per-connection config. Each entry needs connectionId + boardId; there is no API to list boards, so ask the user for the board id',
    ),
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
      'Restrict to these platforms; omit for every platform with analytics. X (TWITTER) has no analytics and is ignored; LinkedIn analytics are pending platform approval and return no data yet',
    ),
};

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

const resultSchema = (description: string) => ({
  result: z.unknown().describe(description),
});

/**
 * Uploads a buffer to R2 via the back-end presigned URL flow.
 * Returns the permanent public URL and storage key.
 */
async function uploadBuffer(
  apiClient: RestClient,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<{ publicUrl: string; key: string }> {
  // 1. Get presigned upload URL from back-end
  const { urls } = (await apiClient.post('/upload-urls', {
    files: [{ fileName, mimeType }],
  })) as {
    urls: { uploadUrl: string; publicUrl: string; key: string }[];
  };

  const { uploadUrl, publicUrl, key } = urls[0];

  // 2. PUT the file to R2 via the presigned URL
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: buffer,
    redirect: 'error',
  });

  if (!uploadRes.ok) {
    throw new Error(
      `Upload to storage failed: ${uploadRes.status} ${uploadRes.statusText}`,
    );
  }

  return { publicUrl, key };
}

/**
 * Downloads a file from a public https URL, checks it is real media, then uploads it to R2.
 */
async function uploadFromUrl(
  apiClient: RestClient,
  sourceUrl: string,
): Promise<{ publicUrl: string; key: string }> {
  const { body, url } = await downloadPublicMedia(sourceUrl);
  const mimeType = requireMediaContent(body, describeUrl(url));
  return uploadBuffer(apiClient, body, fileNameFor(url, mimeType), mimeType);
}

/**
 * Uploads a base64-encoded file directly to R2 after checking it is real media.
 */
async function uploadFromBase64(
  apiClient: RestClient,
  data: string,
  fileName: string,
): Promise<{ publicUrl: string; key: string }> {
  const buffer = Buffer.from(data, 'base64');
  const mimeType = requireMediaContent(buffer, fileName);
  const stem = fileName.replace(/\.[^.]*$/, '') || 'upload';
  return uploadBuffer(apiClient, buffer, `${stem}${EXT_BY_MIME[mimeType]}`, mimeType);
}

// ---------------------------------------------------------------------------
// MCP Server – tool registration
// ---------------------------------------------------------------------------

function createMcpServer(apiClient?: RestClient): McpServer {
  const client = apiClient ?? api;
  const server = new McpServer({
    name: 'adaptlypost',
    version: '1.1.0',
  });

  // ── Account Tools ──────────────────────────────────────────────────────

  server.registerTool(
    'list_accounts',
    {
      title: 'List Connected Accounts',
      description:
        'List the social accounts connected to the token\'s workspace across all nine platforms. Returns { accounts } with id, platform, displayName, username, avatarUrl, and pageId for Facebook pages. Call this before create_post, update_post, or bulk_schedule_posts: they take these ids, never usernames. Put each id in the array for its platform (linkedinConnectionIds, tiktokConnectionIds, and so on); Facebook page accounts go in pageIds. Not for post history or publishing status: use list_posts or list_post_results for those. Takes no arguments.',
      inputSchema: {},
      outputSchema: resultSchema(
        'An object with accounts: one { id, platform, displayName, username, avatarUrl } per connected account, plus pageId for Facebook pages. Use id as the connection id (or in pageIds for Facebook).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async () => {
      try {
        const data = await client.get('/social-accounts');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Media Upload ────────────────────────────────────────────────────────

  server.registerTool(
    'upload_media',
    {
      title: 'Upload Media',
      description:
        'Upload images or videos to AdaptlyPost storage and return public URLs for the mediaUrls of create_post, update_post, or bulk_schedule_posts. Two sources, combinable in one call: urls (public https URLs the server downloads and re-hosts; private, internal and non-https addresses are refused) and files (base64 data, for media attached in the conversation). Omitting both returns an error. Accepts JPEG, PNG, WebP, MP4 and QuickTime, checked by file content; 50 MB per image, 250 MB per URL download. Stored files are public immediately, post or no post, so only upload media the user supplied or asked for. Prefer this over get_upload_urls, which only mints URLs and leaves the PUT to you. Returns uploaded ({ publicUrl, key } per file) and mediaUrls; pass mediaUrls straight into the post.',
      inputSchema: {
        urls: z
          .array(z.string())
          .optional()
          .describe(
            'Public https URLs of images or videos to upload (e.g. ["https://example.com/photo.jpg"])',
          ),
        files: z
          .array(
            z.object({
              data: z
                .string()
                .describe('Base64-encoded file content'),
              fileName: z
                .string()
                .describe('File name with extension (e.g. "photo.jpg")'),
              mimeType: z
                .enum([
                  'image/jpeg',
                  'image/png',
                  'image/webp',
                  'video/mp4',
                  'video/quicktime',
                ])
                .describe('MIME type of the file'),
            }),
          )
          .optional()
          .describe(
            'Direct file uploads as base64. Use this when the user attaches/pastes an image or video in the conversation',
          ),
      },
      outputSchema: resultSchema(
        'An object with uploaded (array of { publicUrl, key } per file) and mediaUrls (the public URLs ready to pass to create_post).',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ urls, files }) => {
      try {
        if (!urls?.length && !files?.length) {
          throw new Error(
            'Provide at least one of: urls (public URLs) or files (base64 data)',
          );
        }

        const results: { publicUrl: string; key: string }[] = [];

        // Upload from URLs
        if (urls?.length) {
          const urlResults = await Promise.all(urls.map((u) => uploadFromUrl(client, u)));
          results.push(...urlResults);
        }

        // Upload from base64 file data
        if (files?.length) {
          const fileResults = await Promise.all(
            files.map((f) => uploadFromBase64(client, f.data, f.fileName)),
          );
          results.push(...fileResults);
        }

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

  server.registerTool(
    'get_upload_urls',
    {
      title: 'Get Media Upload URLs',
      description:
        'Get presigned upload URLs for direct file uploads. Returns uploadUrl (PUT your file here) and publicUrl (use in create_post mediaUrls). This only mints a URL — you MUST PUT the file to uploadUrl and confirm a 2xx response before using publicUrl, otherwise create_post/bulk rejects it with "Media file(s) not found in storage". Prefer the upload_media tool, which performs the upload for you. For each file, provide fileName and mimeType. Supported types: image/jpeg, image/png, image/webp, video/mp4, video/quicktime.',
      inputSchema: {
        files: z
          .array(
            z.object({
              fileName: z.string().describe('File name with extension'),
              mimeType: z
                .enum([
                  'image/jpeg',
                  'image/png',
                  'image/webp',
                  'video/mp4',
                  'video/quicktime',
                ])
                .describe('MIME type of the file'),
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
    async ({ files }) => {
      try {
        const data = await client.post('/upload-urls', { files });
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Post CRUD ──────────────────────────────────────────────────────────

  server.registerTool(
    'create_post',
    {
      title: 'Create Post',
      description:
        'Create one post for one or more platforms: publish now, schedule, or save a draft. Omit scheduledAt to publish immediately; a future scheduledAt sets status SCHEDULED; saveAsDraft stores it as DRAFT and defers validation to publish_draft. Publishing runs asynchronously per platform, so the response ({ postId, queuedPlatforms, isScheduled, scheduledAt }) is not the outcome; read list_post_results, where each platform succeeds or fails on its own. Call list_accounts first: each platform in platforms needs its connection-id array (linkedinConnectionIds, pageIds for Facebook, and so on), one account per platform. TikTok needs tiktokConfigs with privacyLevel; Pinterest needs pinterestConfigs with boardId. mediaUrls must come from upload_media, or the call fails with "Media file(s) not found in storage". Use bulk_schedule_posts for many posts on the same accounts, and update_post or publish_draft for an existing post.',
      inputSchema: {
        text: z
          .string()
          .optional()
          .describe('Default post text shared across platforms'),
        platforms: z
          .array(PlatformType)
          .describe(
            'Target platforms (e.g. ["LINKEDIN", "TWITTER"]). Each one needs its matching connection-id array (pageIds for FACEBOOK) filled with ids from list_accounts',
          ),
        contentType: ContentType.describe(
          'Content type: TEXT, IMAGE, VIDEO, or CAROUSEL. Must match mediaUrls (CAROUSEL needs several)',
        ),
        scheduledAt: z
          .string()
          .optional()
          .describe(
            'Absolute ISO 8601 instant to schedule (e.g. "2026-03-15T10:00:00Z"). Omit to post immediately; a past time also posts immediately',
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
            'Save as DRAFT instead of publishing or scheduling; publish later with publish_draft',
          ),
        mediaUrls: z
          .array(z.string())
          .optional()
          .describe(
            'Media URLs to attach. Use publicUrl values from upload_media or get_upload_urls',
          ),
        thumbnailUrl: z
          .string()
          .optional()
          .describe('Custom thumbnail image URL for video posts'),
        thumbnailTimestampMs: z
          .number()
          .optional()
          .describe(
            'Generate thumbnail from video at this timestamp (milliseconds)',
          ),
        platformTexts: z
          .array(z.object({ platform: PlatformType, text: z.string() }))
          .optional()
          .describe('Per-platform caption overrides'),
        ...connectionIdFields,
        ...platformConfigFields,
      },
      outputSchema: resultSchema(
        'An object with postId, queuedPlatforms (platforms whose publishing job was queued; empty for scheduled posts and drafts), skippedPlatforms, isScheduled, and scheduledAt. Publishing is asynchronous: check list_post_results for outcomes.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async (input) => {
      try {
        const data = await client.post('/social-posts', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_post',
    {
      title: 'Get Post',
      description:
        'Get one post\'s full record by id: text, contentType, status, scheduledAt, timezone, and a platforms array with each target\'s connection, status, errorMessage, and media. Visible only within the token\'s workspace; any other id returns "Post not found or access denied". Use this to inspect content before update_post or publish_draft. Use list_post_results instead when you only need per-platform publishing outcomes and the platformIds for retry_failed_platforms, and list_posts to find ids by status, platform, or date. Post ids come from create_post, bulk_schedule_posts, or list_posts.',
      inputSchema: {
        id: z
          .string()
          .describe('Post ID from create_post, bulk_schedule_posts, or list_posts'),
      },
      outputSchema: resultSchema(
        'The full post record: id, status, contentType, text, scheduledAt, timezone, createdAt, updatedAt, and platforms (one entry per target with id, platform, connectionId or pageId, status, errorMessage, mediaUrls).',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ id }) => {
      try {
        const data = await client.get(`/social-posts/${id}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_posts',
    {
      title: 'List Posts',
      description:
        'List posts in the token\'s workspace, any status, newest first by default. Returns { posts, total, hasMore }; each post carries its status and a platforms array with per-platform status. Filters: statuses, platforms (posts targeting any of them), and startDate/endDate, which bound scheduledAt, or createdAt for posts never scheduled. limit is 1 to 100 (default 20); page with offset while hasMore is true. Use this to find post ids or check what is already queued. Use get_post for one post\'s full record and list_post_results for one post\'s per-platform outcomes and retry ids.',
      inputSchema: {
        statuses: z
          .array(PostStatus)
          .optional()
          .describe('Filter by status (e.g. ["SCHEDULED", "DRAFT"]); omit for all statuses'),
        platforms: z
          .array(PlatformType)
          .optional()
          .describe('Filter to posts targeting any of these platforms'),
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
        limit: z.number().optional().default(20).describe('Max results, 1 to 100'),
        offset: z
          .number()
          .optional()
          .default(0)
          .describe('Posts to skip; increase by limit while hasMore is true'),
      },
      outputSchema: resultSchema(
        'An object with posts (each with id, status, contentType, text, scheduledAt, timezone, and platforms with per-platform status), total (count of all matches), and hasMore.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input) => {
      try {
        const data = await client.get('/social-posts', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'update_post',
    {
      title: 'Update Post',
      description:
        'Update a DRAFT or SCHEDULED post in place; any other status fails with "Cannot edit post in current state", so published posts cannot be changed. Updates are partial: text, contentType, scheduledAt, timezone, and thumbnail fields you omit keep their values. The exception is platforms: sending it rebuilds the post\'s target set from this request alone, so include every connection-id array and platform config you want to keep (TikTok with privacyLevel, Pinterest with boardId); omitting platforms leaves accounts, configs, and media untouched. mediaUrls only take effect together with platforms; use publicUrl values from upload_media. On SCHEDULED posts new media is verified in storage. Returns the updated post record. Use publish_draft to change a draft\'s status, delete_post to cancel, and create_post for a new post.',
      inputSchema: {
        id: z.string().describe('Post ID to update (must be DRAFT or SCHEDULED)'),
        text: z.string().optional().describe('Updated text; omit to keep the current text'),
        platforms: z
          .array(PlatformType)
          .optional()
          .describe(
            'New target platforms. Sending this replaces every target, so also resend the connection-id arrays and platform configs to keep; omit to leave targets unchanged',
          ),
        contentType: ContentType.optional().describe(
          'New content type; must match the media on the post',
        ),
        scheduledAt: z
          .string()
          .optional()
          .describe('New schedule time as an absolute ISO 8601 instant; omit to keep'),
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
        thumbnailUrl: z
          .string()
          .optional()
          .describe('Custom thumbnail image URL for video posts'),
        thumbnailTimestampMs: z
          .number()
          .optional()
          .describe(
            'Generate thumbnail from video at this timestamp (milliseconds)',
          ),
        platformTexts: z
          .array(z.object({ platform: PlatformType, text: z.string() }))
          .optional()
          .describe('Per-platform caption overrides; applied to the targets sent in platforms'),
        ...connectionIdFields,
        ...platformConfigFields,
      },
      outputSchema: resultSchema(
        'The updated post record: id, status (still DRAFT or SCHEDULED), text, contentType, scheduledAt, timezone, and platforms with per-target details.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ id, ...rest }) => {
      try {
        const data = await client.patch(`/social-posts/${id}`, rest);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'delete_post',
    {
      title: 'Delete Post',
      description:
        'Delete a post record from AdaptlyPost by id. Use it to cancel a DRAFT or SCHEDULED post before it goes out; a deleted scheduled post will not publish. Deleting never removes content already on a network: for a COMPLETED or PARTIAL_FAILURE post this only drops AdaptlyPost\'s record, and the live posts stay up until removed on each platform. Prefer update_post to change a post instead of deleting and recreating it. Only posts in the token\'s workspace can be deleted; others return "Post not found or access denied". Returns { deleted: true }. Irreversible.',
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
    async ({ id }) => {
      try {
        const data = await client.delete(`/social-posts/${id}`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Publishing / Results ───────────────────────────────────────────────

  server.registerTool(
    'publish_draft',
    {
      title: 'Publish Draft',
      description:
        'Publish a DRAFT post now or schedule it; SCHEDULED posts are accepted too, to reschedule or push live. Other statuses fail with "Post is not a draft". Without scheduledAt (or with a past one) the post moves to PENDING and a publishing job is queued per platform: content reaches the networks within moments and cannot be recalled. A future scheduledAt sets SCHEDULED and queues nothing yet. Fails if an account was disconnected or a TikTok entry lacks privacyLevel; fix with update_post first. Not for new content, use create_post. Check list_post_results afterwards for per-platform outcomes.',
      inputSchema: {
        id: z.string().describe('Post ID with status DRAFT (or SCHEDULED)'),
        scheduledAt: z
          .string()
          .optional()
          .describe(
            'Absolute ISO 8601 instant (e.g. "2026-03-15T10:00:00Z"). Omit, or pass a past time, to publish now',
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
        destructiveHint: false,
      },
    },
    async ({ id, ...body }) => {
      try {
        const data = await client.post(`/social-posts/${id}/publish`, body);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_post_results',
    {
      title: 'List Post Results',
      description:
        'Get one post\'s per-platform publishing outcomes: { postId, status, results[] } where each result has platformId, platform, accountName, status (PENDING, PUBLISHING, PUBLISHED, or FAILED), platformPostId, errorMessage, and publishedAt. Each platform reports separately, so read every row instead of treating the post as one pass or fail. Call this after create_post, publish_draft, or retry_failed_platforms, since publishing is asynchronous and their responses only confirm queueing; poll until no row is PENDING or PUBLISHING. Take platformId from FAILED rows for retry_failed_platforms. Use get_post when you also need the content and schedule.',
      inputSchema: {
        id: z
          .string()
          .describe('Post ID from create_post, publish_draft, bulk_schedule_posts, or list_posts'),
      },
      outputSchema: resultSchema(
        'An object with postId, the overall post status, and results: one { platformId, platform, accountName, status, platformPostId, errorMessage, publishedAt } per targeted platform.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ id }) => {
      try {
        const data = await client.get(`/social-posts/${id}/results`);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'retry_failed_platforms',
    {
      title: 'Retry Failed Platforms',
      description:
        'Re-queue publishing for a post\'s FAILED platforms. Only rows with status FAILED whose id is in platformIds are reset to PENDING and retried with the same content; other ids are ignored, and with none matching the call fails with "No failed platforms to retry". The post moves to PUBLISHING and the retry is asynchronous, so check list_post_results for the outcome. Get platformIds (not platform names) and each errorMessage from list_post_results first; retry once the cause is fixed (reconnected account, replaced media), not for a platform-side restriction, which will just fail again. Content cannot change on retry.',
      inputSchema: {
        id: z.string().describe('Post ID whose platforms failed'),
        platformIds: z
          .array(z.string())
          .describe(
            'platformId values of FAILED rows from list_post_results (not platform names). At least one',
          ),
      },
      outputSchema: resultSchema(
        'An object with postId, queuedPlatforms (platforms re-queued for publishing), and isScheduled: false. Outcomes arrive asynchronously in list_post_results.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ id, platformIds }) => {
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

  server.registerTool(
    'bulk_schedule_posts',
    {
      title: 'Bulk Schedule Posts',
      description:
        'Schedule up to 100 posts in one call to the same platforms and accounts. Each item supplies its own text, contentType, scheduledAt, and optional media; platforms, connection-id arrays, timezone, and platform configs are shared by every item. Items are processed independently: each is validated and created like create_post, so one bad item fails alone while the rest are scheduled. Returns { totalScheduled, totalFailed, results[] } with a postId or errorMessage per item, in input order; read every row. An item with a past scheduledAt publishes immediately rather than being rejected. Call list_accounts first; TikTok needs tiktokConfigs with privacyLevel and Pinterest needs pinterestConfigs with boardId. Use create_post for a single post or a draft; this tool has no draft mode.',
      inputSchema: {
        platforms: z
          .array(PlatformType)
          .describe(
            'Target platforms shared by every item. Each needs its connection-id array (pageIds for FACEBOOK)',
          ),
        timezone: z
          .string()
          .default('UTC')
          .describe('IANA timezone stored with every post for display; does not shift scheduledAt'),
        posts: z
          .array(
            z.object({
              text: z.string().optional().describe('Post text/caption'),
              contentType: ContentType.describe('TEXT, IMAGE, VIDEO, or CAROUSEL; must match mediaUrls'),
              scheduledAt: z
                .string()
                .describe('Absolute ISO 8601 instant; a past time publishes immediately'),
              mediaUrls: z
                .array(z.string())
                .optional()
                .describe('publicUrl values from upload_media; unstored URLs fail this item'),
              thumbnailUrl: z
                .string()
                .optional()
                .describe('Custom thumbnail image URL'),
              thumbnailTimestampMs: z
                .number()
                .optional()
                .describe('Thumbnail timestamp in ms'),
              platformTexts: z
                .array(z.object({ platform: PlatformType, text: z.string() }))
                .optional()
                .describe('Per-platform caption overrides for this item'),
            }),
          )
          .describe('1 to 100 posts to schedule; each is created independently'),
        ...connectionIdFields,
        ...platformConfigFields,
      },
      outputSchema: resultSchema(
        'An object with totalScheduled, totalFailed, and results: one { postId, success, isScheduled, scheduledAt, errorMessage } per input item, in input order.',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async (input) => {
      try {
        const data = await client.post('/social-posts/bulk', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // ── Analytics ──────────────────────────────────────────────────────────

  server.registerTool(
    'get_analytics_overview',
    {
      title: 'Get Analytics Overview',
      description:
        'Workspace-wide performance for a date window: views, likes, comments, shares, followers, posts published, average views per post and engagement rate, each as { value, previousValue, deltaPercent } against the window of the same length just before it. Use this for "how did we do this month" questions and for follower counts. Metrics are summed over the selected platforms; partialMetrics names metrics some selected platform cannot report, and a metric no platform reports is null. Analytics cover the last 180 days and refresh every few hours (lastSyncedAt says when); if the user just published, call trigger_analytics_sync first. Use get_analytics_timeseries for a trend, get_platform_breakdown to compare platforms, and list_post_analytics for individual posts.',
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
    async (input) => {
      try {
        const data = await client.get('/analytics/overview', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
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
    async (input) => {
      try {
        const data = await client.get('/analytics/timeseries', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_platform_breakdown',
    {
      title: 'Get Platform Breakdown',
      description:
        'The overview metrics split per platform for a date window, for "which platform performs best" comparisons. Returns { platforms }: one row per platform with analytics data, carrying followers, views, likes, comments, shares, postsCount, avgViewsPerPost and engagementRate (each { value, previousValue, deltaPercent }) plus supportedMetrics, the metrics that platform actually reports; compare only metrics both platforms list there. Takes no platform filter. Use get_analytics_overview for the combined total.',
      inputSchema: {
        from: analyticsRangeFields.from,
        to: analyticsRangeFields.to,
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
    async (input) => {
      try {
        const data = await client.get('/analytics/platform-breakdown', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_post_analytics',
    {
      title: 'List Post Analytics',
      description:
        'Per-post metrics for posts published inside the window, sorted by a metric or by publish date, paginated. Use it for "top posts", "which post got the most comments" and "how did post X do". Covers posts published through AdaptlyPost and posts discovered on the connected accounts; discovered posts have postId and postPlatformId set to null, while AdaptlyPost posts carry the postId used by get_post. Returns { posts, total, page, limit, hasMore }; each post has platform, publishedAt, title, thumbnailUrl, permalink, accountName and metrics { views, likes, comments, shares, saves, clicks, impressions, reach, engagementRate }, with null for metrics the platform does not report. Sort by VIEWS with a small limit for a top list; PUBLISHED_AT (default) for a chronological review. Not for publishing status: use list_post_results for that.',
      inputSchema: {
        ...analyticsRangeFields,
        sortBy: AnalyticsSortMetric.optional().describe(
          'Metric to sort by, descending. PUBLISHED_AT (default) lists newest first',
        ),
        page: z.number().optional().default(1).describe('Page number, from 1'),
        limit: z
          .number()
          .optional()
          .default(20)
          .describe('Posts per page, 1 to 100'),
      },
      outputSchema: resultSchema(
        'An object with posts (each { id, postId, postPlatformId, platform, publishedAt, title, thumbnailUrl, permalink, accountName, metrics }), total, page, limit, and hasMore.',
      ),
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async (input) => {
      try {
        const data = await client.get('/analytics/posts', input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_analytics_sync_status',
    {
      title: 'Get Analytics Sync Status',
      description:
        'How fresh the analytics are, per connected account. Returns syncInProgress, lastSyncedAt, historyHorizonAt (the earliest date any account has data for; earlier dates have no data rather than zero activity) and platforms: one row per account with status (IDLE, QUEUED, SYNCING, FAILED), lastSyncedAt, lastErrorMessage, historyHorizonAt and needsAnalyticsReconnect. When needsAnalyticsReconnect is true the account was connected before analytics permissions existed and returns nothing until the user reconnects it (a connect link works); tell them, do not keep querying. Call this when numbers look stale or empty, and after trigger_analytics_sync to see the run finish. Takes no arguments.',
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
    async () => {
      try {
        const data = await client.get('/analytics/sync-status');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'trigger_analytics_sync',
    {
      title: 'Trigger Analytics Sync',
      description:
        'Ask AdaptlyPost to refresh analytics now instead of waiting for the scheduled sync: every connected account is queued and the last 7 days are re-read. Use it when the user just published and wants numbers, or when get_analytics_overview shows an old lastSyncedAt. Allowed once per workspace every 10 minutes; inside the cooldown it returns queued: false with cooldownSecondsRemaining rather than an error, so do not retry in a loop. The sync runs in the background: poll get_analytics_sync_status until syncInProgress is false, then read the metrics again. Takes no arguments and changes no content.',
      inputSchema: {},
      outputSchema: resultSchema(
        'An object with queued (true when a sync was started), message, and cooldownSecondsRemaining (seconds until the next allowed sync, null when queued).',
      ),
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const data = await client.post('/analytics/sync');
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport — stdio (local) or HTTP (deployed, single URL)
// ---------------------------------------------------------------------------

const SSE_ACCEPT = 'application/json, text/event-stream';

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
            'Content-Type, Authorization, mcp-session-id',
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
        await reqServer.connect(transport);
        try {
          let parsedBody: unknown;
          if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const rawBody = Buffer.concat(chunks).toString('utf8');
            try {
              parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
            } catch {
              rpcLabel = 'unparseable';
            }
            rpcLabel = describeRpc(parsedBody) ?? rpcLabel;
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
    await server.connect(transport);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
