#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createServer, type IncomingMessage } from 'node:http';

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
  pageIds: z.array(z.string()).optional().describe('Facebook page IDs'),
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
      'Facebook per-page config with post type and video title',
    ),
  pinterestConfigs: z
    .array(PinterestConfigSchema)
    .optional()
    .describe(
      'Pinterest per-connection config. boardId is required for Pinterest posts',
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

function guessMimeType(url: string): string {
  const ext = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
  };
  return (ext && map[ext]) || 'application/octet-stream';
}

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
  });

  if (!uploadRes.ok) {
    throw new Error(
      `Upload to storage failed: ${uploadRes.status} ${uploadRes.statusText}`,
    );
  }

  return { publicUrl, key };
}

/**
 * Downloads a file from a public URL, then uploads it to R2.
 */
async function uploadFromUrl(
  apiClient: RestClient,
  sourceUrl: string,
): Promise<{ publicUrl: string; key: string }> {
  const res = await fetch(sourceUrl);
  if (!res.ok) {
    throw new Error(
      `Failed to download ${sourceUrl}: ${res.status} ${res.statusText}`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const fileName =
    sourceUrl.split(/[?#]/)[0].split('/').pop() || 'upload';
  const mimeType =
    res.headers.get('content-type') || guessMimeType(sourceUrl);

  return uploadBuffer(apiClient, buffer, fileName, mimeType);
}

/**
 * Uploads a base64-encoded file directly to R2.
 */
async function uploadFromBase64(
  apiClient: RestClient,
  data: string,
  fileName: string,
  mimeType: string,
): Promise<{ publicUrl: string; key: string }> {
  const buffer = Buffer.from(data, 'base64');
  return uploadBuffer(apiClient, buffer, fileName, mimeType);
}

// ---------------------------------------------------------------------------
// MCP Server – tool registration
// ---------------------------------------------------------------------------

function createMcpServer(apiClient?: RestClient): McpServer {
  const client = apiClient ?? api;
  const server = new McpServer({
    name: 'adaptlypost',
    version: '1.0.0',
  });

  // ── Account Tools ──────────────────────────────────────────────────────

  server.registerTool(
    'list_accounts',
    {
      title: 'List Connected Accounts',
      description:
        'List all connected social media accounts across all platforms (LinkedIn, YouTube, Instagram, Facebook, TikTok, Pinterest, Threads, Bluesky, Twitter). Returns connection IDs needed for creating posts. Facebook page accounts also include a pageId (the Facebook Page ID) since pages have no username.',
      inputSchema: {},
      outputSchema: resultSchema(
        'The connected social accounts with their platform, connection ID, username, and pageId for Facebook pages as returned by the AdaptlyPost API.',
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
        'Upload media files for use in posts. Supports two modes:\n' +
        '1. URLs: pass public image/video URLs — the server downloads and re-uploads them.\n' +
        '2. Files: pass base64-encoded file data directly (e.g. when the user attaches an image in the conversation).\n' +
        'Returns mediaUrls ready to pass into create_post. The user does NOT need to see the returned URLs — just pass them to create_post.',
      inputSchema: {
        urls: z
          .array(z.string())
          .optional()
          .describe(
            'Public URLs of images or videos to upload (e.g. ["https://example.com/photo.jpg"])',
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
        openWorldHint: false,
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
            files.map((f) => uploadFromBase64(client, f.data, f.fileName, f.mimeType)),
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
        'Create and schedule a post to one or more platforms. Pass connection IDs from list_accounts to target specific accounts. Omit scheduledAt to post immediately, or set saveAsDraft to save without publishing. For platform-specific options (YouTube titles, TikTok privacy, Pinterest boards, Instagram post type), use the corresponding platform configs.',
      inputSchema: {
        text: z
          .string()
          .optional()
          .describe('Default post text shared across platforms'),
        platforms: z
          .array(PlatformType)
          .describe('Target platforms (e.g. ["LINKEDIN", "TWITTER"])'),
        contentType: ContentType.describe(
          'Content type: TEXT, IMAGE, VIDEO, or CAROUSEL',
        ),
        scheduledAt: z
          .string()
          .optional()
          .describe(
            'ISO 8601 datetime to schedule (e.g. "2026-03-15T10:00:00Z"). Omit to post immediately',
          ),
        timezone: z
          .string()
          .default('UTC')
          .describe('IANA timezone (e.g. "America/New_York")'),
        saveAsDraft: z
          .boolean()
          .optional()
          .describe('Save as draft instead of publishing'),
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
        'The created post record including its id, status, and scheduled time as returned by the AdaptlyPost API.',
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
        'Get full details of a single post by ID, including per-platform publishing status and error messages.',
      inputSchema: {
        id: z.string().describe('Post ID'),
      },
      outputSchema: resultSchema(
        'The full post record including its id, status, per-platform publishing status, and error messages as returned by the AdaptlyPost API.',
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
        'List posts with optional filters by status, platform, or date range. Supports pagination.',
      inputSchema: {
        statuses: z
          .array(PostStatus)
          .optional()
          .describe('Filter by status (e.g. ["SCHEDULED", "DRAFT"])'),
        platforms: z
          .array(PlatformType)
          .optional()
          .describe('Filter by platform'),
        startDate: z.string().optional().describe('Start date (ISO 8601)'),
        endDate: z.string().optional().describe('End date (ISO 8601)'),
        sortOrder: PostSortOrder.optional().describe('NEWEST or OLDEST'),
        limit: z.number().optional().default(20).describe('Max results'),
        offset: z.number().optional().default(0).describe('Pagination offset'),
      },
      outputSchema: resultSchema(
        'The matching posts with their ids, statuses, platforms, and schedule times as returned by the AdaptlyPost API.',
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
        "Update a scheduled or draft post's caption, schedule, accounts, media, or platform configs. Cannot update published posts.",
      inputSchema: {
        id: z.string().describe('Post ID to update'),
        text: z.string().optional().describe('Updated text'),
        platforms: z.array(PlatformType).optional().describe('Updated target platforms'),
        contentType: ContentType.optional(),
        scheduledAt: z
          .string()
          .optional()
          .describe('Updated schedule time (ISO 8601)'),
        timezone: z.string().optional().describe('IANA timezone for the schedule time'),
        mediaUrls: z
          .array(z.string())
          .optional()
          .describe(
            'Updated media URLs. Use publicUrl values from upload_media or get_upload_urls',
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
          .optional(),
        ...connectionIdFields,
        ...platformConfigFields,
      },
      outputSchema: resultSchema(
        'The updated post record including its id, status, and scheduled time as returned by the AdaptlyPost API.',
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
        "Delete a scheduled or draft post. Can't delete published posts.",
      inputSchema: {
        id: z.string().describe('Post ID to delete'),
      },
      outputSchema: resultSchema(
        'The deletion confirmation for the post as returned by the AdaptlyPost API.',
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
        'Publish a draft post immediately or schedule it for later.',
      inputSchema: {
        id: z.string().describe('Draft post ID'),
        scheduledAt: z
          .string()
          .optional()
          .describe('Schedule time (ISO 8601). Omit to publish now'),
        timezone: z.string().default('UTC').describe('IANA timezone'),
      },
      outputSchema: resultSchema(
        'The published or scheduled post record with its updated status as returned by the AdaptlyPost API.',
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
        'Check per-platform posting results — success/failure status with error details for each platform a post was sent to.',
      inputSchema: {
        id: z.string().describe('Post ID to check results for'),
      },
      outputSchema: resultSchema(
        'The per-platform posting results with success/failure status and error details as returned by the AdaptlyPost API.',
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
        'Retry publishing on platforms that failed. Get platform IDs from list_post_results.',
      inputSchema: {
        id: z.string().describe('Post ID'),
        platformIds: z
          .array(z.string())
          .describe('Failed platform IDs to retry'),
      },
      outputSchema: resultSchema(
        'The retry outcome for the requested platform IDs as returned by the AdaptlyPost API.',
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
        'Schedule multiple posts at once. Each post gets its own text, content type, schedule time, and optional media. All posts share the same target platforms and connection IDs.',
      inputSchema: {
        platforms: z.array(PlatformType).describe('Target platforms'),
        timezone: z.string().default('UTC').describe('IANA timezone'),
        posts: z
          .array(
            z.object({
              text: z.string().optional().describe('Post text/caption'),
              contentType: ContentType,
              scheduledAt: z.string().describe('ISO 8601 schedule time'),
              mediaUrls: z.array(z.string()).optional().describe('Image or video URLs to attach'),
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
                .optional(),
            }),
          )
          .describe('Array of posts to schedule'),
        ...connectionIdFields,
        ...platformConfigFields,
      },
      outputSchema: resultSchema(
        'The created scheduled post records with their ids, statuses, and schedule times as returned by the AdaptlyPost API.',
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
