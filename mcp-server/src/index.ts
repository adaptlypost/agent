#!/usr/bin/env bun

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

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
  'MASTODON',
]);

const ContentType = z.enum(['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL', 'DOCUMENT']);

const BulkContentType = z.enum(['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL']);

const UploadMimeType = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
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

const RecurrenceFrequency = z.enum(['DAILY', 'WEEKLY', 'MONTHLY']);

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
});

const InstagramConfigSchema = z.object({
  connectionId: z
    .string()
    .describe('Instagram connection ID from list_accounts'),
  postType: z
    .enum(['FEED', 'REEL', 'STORY'])
    .optional()
    .describe(
      'Where the post goes: FEED works with every content type, REEL needs contentType VIDEO, STORY needs IMAGE or VIDEO. Any other combination is refused with 400',
    ),
  trialGraduation: z
    .enum(['MANUAL', 'SS_PERFORMANCE'])
    .optional()
    .describe(
      "Publish a video reel as a trial reel: Instagram shows it to non-followers first and keeps it off followers' feeds and the profile grid until it is shared. MANUAL means the account owner shares it from the Instagram app; SS_PERFORMANCE means Instagram shares it if it performs well. Only for a single video posted as a reel or feed video, never a story, image or carousel (400 otherwise). Needs a professional account Instagram has enabled for trial reels; otherwise that platform fails with a message saying so",
    ),
});

const FacebookConfigSchema = z.object({
  pageId: z.string().describe('Facebook page ID from list_accounts'),
  postType: z
    .enum(['FEED', 'REEL', 'STORY'])
    .optional()
    .describe(
      'Where the post goes: FEED works with every content type, REEL needs contentType VIDEO, STORY needs IMAGE or VIDEO. Any other combination is refused with 400',
    ),
  videoTitle: z
    .string()
    .max(255)
    .optional()
    .describe('Video title for Facebook (max 255 chars)'),
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
});

const PinterestConfigSchema = z.object({
  connectionId: z
    .string()
    .describe('Pinterest connection ID from list_accounts'),
  boardId: z.string().describe('Pinterest board ID to pin to (required)'),
  title: z.string().max(100).optional().describe('Pin title (max 100 chars)'),
  link: z.string().optional().describe('Destination URL for the pin'),
});

const RecurrenceSchema = z.object({
  frequency: RecurrenceFrequency.describe('How often the post repeats: DAILY, WEEKLY, or MONTHLY'),
  interval: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe('Repeat every N days, weeks or months, 1 to 30 (default 1)'),
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
      'Total number of posts the series publishes, 2 to 365. Cannot be combined with endsOn; omit both to repeat until paused or deleted',
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
      'Instagram per-connection config to set post type (FEED, REEL, STORY) and publish a reel as a trial reel',
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

const linkedinConfigsField = {
  linkedinConfigs: z
    .array(LinkedInConfigSchema)
    .optional()
    .describe(
      'LinkedIn per-connection config: documentTitle names a DOCUMENT post. connectionId must match an entry in linkedinConnectionIds',
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
      'Restrict to these platforms; omit for every platform with analytics. X (TWITTER) and MASTODON have no analytics and are ignored; LinkedIn analytics are pending platform approval and return no data yet',
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
): Promise<{ uploadUrl: string } & Uploaded> {
  const { urls } = (await apiClient.post('/upload-urls', {
    files: [{ fileName, mimeType }],
  })) as { urls: ({ uploadUrl: string } & Uploaded)[] };
  return urls[0];
}

async function uploadFromUrl(apiClient: RestClient, sourceUrl: string): Promise<Uploaded> {
  const media = await openPublicMedia(sourceUrl);
  const { uploadUrl, publicUrl, key } = await mintUploadUrl(
    apiClient,
    fileNameFor(media.url, media.mimeType),
    media.mimeType,
  );
  await putStream(uploadUrl, media);
  return { publicUrl, key };
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
  'A Contributor can create and edit their own drafts, upload media, generate captions and images, and read posts and analytics; it cannot schedule, publish, retry, bulk schedule, delete non-drafts, trigger an analytics sync or touch other members\' posts. A Viewer only reads.',
  'A 403 with code permission_denied means the member\'s role does not allow this action. Tell the user and do not retry. For a schedule or publish, offer to save the post as a draft for an Admin or Editor to publish, and only do that if the user agrees.',
  'A 401 with code token_issuer_lost_access means this connection lost access to the workspace. Tell the user to reconnect AdaptlyPost, or to have a workspace member create a new API key in AdaptlyPost settings.',
  'A 403 with code subscription_required means the organization\'s current AdaptlyPost plan does not include this. Tell the user and stop; do not retry.',
  'A 401 with code oauth_account_not_found means the user signed in with an email that has no AdaptlyPost account. Relay the message, which names that email, and ask them to disconnect and reconnect with the email they use on AdaptlyPost.',
  'A 429 means the rate limit was hit. Wait for the Retry-After time before the next call and do not loop.',
  'generate_caption, refine_caption and generate_image spend AI credits on every call, so generate only what the user asked for. generate_image returns a jobId, not an image: poll get_image_job until status is completed or failed.',
].join('\n');

function createMcpServer(apiClient?: RestClient): McpServer {
  const baseClient = apiClient ?? api;
  const server = new McpServer(
    {
      name: 'adaptlypost',
      version: '1.1.0',
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

  // ── Account Tools ──────────────────────────────────────────────────────

  tool(
    'list_accounts',
    {
      title: 'List Connected Accounts',
      description:
        'List the social accounts connected to the workspace (the current one unless workspaceId names another) across all ten platforms. Returns { accounts } with id, platform, displayName, username, avatarUrl, status, and pageId for Facebook pages. status is active or unauthorized; an unauthorized account (unauthorizedReason carries the platform\'s message) is refused with 400 by create_post until the user reconnects it in AdaptlyPost, so leave it out and tell the user. Call this before create_post, update_post, or bulk_schedule_posts: they take these ids, never usernames. Put each id in the array for its platform (linkedinConnectionIds, tiktokConnectionIds, and so on); Facebook page accounts go in pageIds. Not for post history or publishing status: use list_posts or list_post_results for those. Takes only the optional workspaceId.',
      inputSchema: {},
      outputSchema: resultSchema(
        'An object with accounts: one { id, platform, displayName, username, avatarUrl, status } per connected account, plus unauthorizedReason when status is unauthorized and pageId for Facebook pages. Use id as the connection id (or in pageIds for Facebook).',
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

  // ── Media Upload ────────────────────────────────────────────────────────

  tool(
    'upload_media',
    {
      title: 'Upload Media',
      description:
        'Upload images, videos or documents to AdaptlyPost storage and return public URLs for the mediaUrls of create_post, update_post, or bulk_schedule_posts. Two sources, combinable in one call: urls (public https URLs the server streams straight into storage; private, internal and non-https addresses are refused, and the source must send a Content-Length) and files (base64 data, for media attached in the conversation; 30 MB decoded per call in total). Omitting both returns an error. Accepts JPEG, PNG, WebP, MP4 and QuickTime, plus PDF, PPT, PPTX, DOC and DOCX for LinkedIn DOCUMENT posts, checked by file content (and, for Office files, the extension, so keep it in the name or URL); 50 MB per image, 100 MB per document, 250 MB per URL download. Stored files are public immediately, post or no post, so only upload media the user supplied or asked for. For inline files over 30 MB use get_upload_urls and PUT the bytes yourself. Returns uploaded ({ publicUrl, key } per file) and mediaUrls; pass mediaUrls straight into the post. One publicUrl may be reused across any number of posts; the file is kept until the last post referencing it has published, so upload once and reuse rather than re-uploading per post.',
      inputSchema: {
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
            'Direct file uploads as base64, 30 MB decoded per call in total. Use this when the user attaches/pastes an image, video or document in the conversation',
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
    },
    async ({ urls, files }, client) => {
      try {
        if (!urls?.length && !files?.length) {
          throw new Error(
            'Provide at least one of: urls (public URLs) or files (base64 data)',
          );
        }

        if (files?.length) requireInlineBudget(files);

        const results: Uploaded[] = [];
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
        'Get presigned upload URLs for direct file uploads. Returns uploadUrl (PUT your file here) and publicUrl (use in create_post mediaUrls). This only mints a URL. You MUST PUT the file to uploadUrl and confirm a 2xx response before using publicUrl, otherwise create_post/bulk rejects it with "Media file(s) not found in storage". Prefer upload_media for public URLs and for inline files under 30 MB; use this for larger files you hold yourself. For each file, provide fileName and mimeType. Supported types: image/jpeg, image/png, image/webp, video/mp4, video/quicktime, and for LinkedIn DOCUMENT posts application/pdf, application/vnd.ms-powerpoint, application/vnd.openxmlformats-officedocument.presentationml.presentation, application/msword and application/vnd.openxmlformats-officedocument.wordprocessingml.document; keep the extension in fileName, since the post reads the file type from it. A publicUrl may be reused across any number of posts; the file is kept until the last post referencing it has published.',
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
      csp: { connectDomains: [PUBLIC_ORIGIN], resourceDomains: [] },
      prefersBorder: true,
    },
    'openai/widgetCSP': { connect_domains: [PUBLIC_ORIGIN], resource_domains: [] },
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
          text: uploadWidgetHtml(UPLOAD_ENDPOINT),
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
        "Show an upload box in the chat so the user can add photos, videos or documents from their phone or computer. Use it when the user wants to post a file that has no public URL, such as a photo on their phone or a file attached in the chat that upload_media cannot read. Nothing is uploaded until the user picks files in the box. When the upload finishes, the box sends a message listing the public media URLs; pass them as mediaUrls to create_post, update_post or bulk_schedule_posts. Accepts JPEG, PNG, WebP, MP4, QuickTime, PDF, PPT, PPTX, DOC and DOCX, up to 250 MB per file, 50 MB per image and 100 MB per document. Uploaded files are stored at public URLs. The box only appears in apps that show MCP Apps widgets, such as ChatGPT and Claude; elsewhere ask the user for a public URL and use upload_media.",
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
        openWorldHint: true,
        destructiveHint: true,
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
        'Create one post for one or more platforms: publish now, schedule, or save a draft. Omit scheduledAt to publish immediately; a future scheduledAt sets status SCHEDULED; saveAsDraft stores it as DRAFT and defers validation to publish_draft. Publishing runs asynchronously per platform, so the response ({ postId, queuedPlatforms, isScheduled, scheduledAt }) is not the outcome; read list_post_results, where each platform succeeds or fails on its own. Call list_accounts first: each platform in platforms needs its connection-id array (linkedinConnectionIds, pageIds for Facebook, and so on), one account per platform. TikTok needs tiktokConfigs with privacyLevel; Pinterest needs pinterestConfigs with boardId. For a LinkedIn document (PDF, slides or Word file) use contentType DOCUMENT with the one file in mediaUrls and only LINKEDIN in platforms. mediaUrls must come from upload_media, or the call fails with "Media file(s) not found in storage". Pass recurrence with a future scheduledAt to repeat the post daily, weekly or monthly; the response then adds recurringPostId and postId is the first occurrence. Use bulk_schedule_posts for many posts on the same accounts, and update_post or publish_draft for an existing post. This publishes publicly to the user\'s social accounts: unless saveAsDraft is set, show the user the final text, media, accounts and time or repeat schedule, and get their confirmation before calling. Each call creates a new post, so calling again after an error or timeout can publish a duplicate; check list_posts first.',
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
          `Content type: TEXT, IMAGE, VIDEO, CAROUSEL, or DOCUMENT. Must match mediaUrls (CAROUSEL needs several). ${DOCUMENT_POST_RULE}`,
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
        recurrence: RecurrenceSchema.optional().describe(
          'Repeat the post on a schedule. Needs a future scheduledAt, which becomes the first post and sets the time of day in timezone. Cannot be combined with saveAsDraft or TIKTOK. Missed slots, for example while paused, are skipped and never published late. X and LinkedIn reject identical text, so use spintax such as {Hi|Hello} to vary each post. Manage the series with list_recurring_posts, pause_recurring_post, resume_recurring_post and delete_recurring_post',
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
          .describe(
            'Alt text per image, in the same order as mediaUrls (max 1000 characters each; use "" to skip an image). Sent to X, Bluesky, Mastodon, LinkedIn, Facebook, Instagram and Threads; Pinterest uses the first one (cut to 500). TikTok, YouTube and videos ignore it',
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
        ...linkedinConfigsField,
      },
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
        'The full post record: id, status, contentType, text, scheduledAt, timezone, mediaUrls, createdAt, updatedAt, recurringPostId and occurrenceAt (set when the post is an occurrence of a recurring post; occurrenceAt is its slot in the series and stays the same when the post is rescheduled), and platforms (one entry per target with id, platform, connectionId or pageId, status, errorMessage, platformPostId, postUrl once published, mediaUrls, previewUrls). previewUrls holds one permanent preview image per media item, a still frame for videos; after publishing, mediaUrls may become platform CDN links that expire within days, so show previewUrls instead.',
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
        'Update a DRAFT or SCHEDULED post in place; any other status fails with "Cannot edit post in current state", so published posts cannot be changed. Updates are partial: text, contentType, scheduledAt, timezone, and thumbnail fields you omit keep their values. The exception is platforms: sending it rebuilds the post\'s target set from this request alone, so include every connection-id array and platform config you want to keep (TikTok with privacyLevel, Pinterest with boardId); omitting platforms leaves accounts, configs, and media untouched. mediaUrls only take effect together with platforms; use publicUrl values from upload_media. On SCHEDULED posts new media is verified in storage. Returns the updated post record. Use publish_draft to change a draft\'s status, unschedule_post to take a scheduled post off the calendar, delete_post to cancel, and create_post for a new post.',
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
          `New content type; must match the media on the post. ${DOCUMENT_POST_RULE}`,
        ),
        scheduledAt: z
          .string()
          .optional()
          .describe(
            'New schedule time as an absolute ISO 8601 instant; omit to keep. Moving a SCHEDULED post more than a minute into the past fails with 400; use publish_draft to publish now',
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
          .describe(
            'Alt text per image, in the same order as mediaUrls (max 1000 characters each; use "" to skip an image). Sent to X, Bluesky, Mastodon, LinkedIn, Facebook, Instagram and Threads; Pinterest uses the first one (cut to 500). TikTok, YouTube and videos ignore it. Applied only when platforms is also sent',
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
        'Take a DRAFT or SCHEDULED post off the calendar without deleting it: the post becomes an undated DRAFT (status DRAFT, scheduledAt null) and nothing publishes. Use it when the user wants to hold a scheduled post back; reschedule it later with update_post or publish_draft, and use delete_post only to drop it entirely. Any other status (PENDING, PUBLISHING, COMPLETED, FAILED, PARTIAL_FAILURE) fails with 400 because the post is already going out or out. Ids outside the workspace (the current one unless workspaceId names another) return 404. Safe to repeat on a post that is already an undated draft. Returns the post record.',
      inputSchema: {
        id: z.string().describe('Post ID with status DRAFT or SCHEDULED, from list_posts or create_post'),
      },
      outputSchema: resultSchema(
        'The post record as an undated draft: id, status DRAFT, scheduledAt null, text, contentType, timezone, and platforms with per-target details.',
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
        'Schedule up to 100 posts in one call to the same platforms and accounts. Each item supplies its own text, contentType, scheduledAt, and optional media; platforms, connection-id arrays, timezone, and platform configs are shared by every item, though an item may carry its own tiktokConfigs, youtubeConfigs, instagramConfigs, facebookConfigs or pinterestConfigs to replace the shared ones. Items are processed independently: each is validated and created like create_post, so one bad item fails alone while the rest are scheduled. Returns { totalScheduled, totalFailed, results[] } with a postId or errorMessage per item, in input order; read every row. An item with a past scheduledAt publishes immediately rather than being rejected. Call list_accounts first; TikTok needs tiktokConfigs with privacyLevel and Pinterest needs pinterestConfigs with boardId. Use create_post for a single post or a draft; this tool has no draft mode. These posts publish publicly to the user\'s social accounts: show the user every item\'s text, media and time plus the accounts, and get their confirmation before calling. Each call creates new posts, so calling again after an error or timeout can publish duplicates; check list_posts first.',
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
              contentType: BulkContentType.describe(
                'TEXT, IMAGE, VIDEO, or CAROUSEL; must match mediaUrls. DOCUMENT posts cannot be bulk scheduled; use create_post',
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
                .describe(
                  'Alt text per image, in the same order as mediaUrls (max 1000 characters each; use "" to skip an image). Sent to X, Bluesky, Mastodon, LinkedIn, Facebook, Instagram and Threads; Pinterest uses the first one (cut to 500). TikTok, YouTube and videos ignore it',
                ),
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
                .describe('Pinterest config for this item only, such as its own title or link; replaces the batch-level pinterestConfigs'),
            }),
          )
          .min(1)
          .max(100)
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

  // ── Analytics ──────────────────────────────────────────────────────────

  tool(
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
        'Per-post metrics for posts published inside the window, sorted by a metric or by publish date, paginated. Use it for "top posts", "which post got the most comments" and "how did post X do". Covers posts published through AdaptlyPost and posts discovered on the connected accounts; discovered posts have postId and postPlatformId set to null, while AdaptlyPost posts carry the postId used by get_post. Returns { posts, total, page, limit, hasMore }; each post has platform, publishedAt, title, thumbnailUrl, permalink, accountName and metrics { views, likes, comments, shares, saves, clicks, impressions, reach, engagementRate }, with null for metrics the platform does not report. Sort by VIEWS with a small limit for a top list; PUBLISHED_AT (default) for a chronological review. Not for publishing status: use list_post_results for that.',
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
        'An object with posts (each { id, postId, postPlatformId, platform, publishedAt, title, thumbnailUrl, permalink, accountName, metrics }), total, page, limit, and hasMore.',
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
        'Ask AdaptlyPost to refresh analytics now instead of waiting for the scheduled sync: every connected account is queued and the last 7 days are re-read. Use it when the user just published and wants numbers, or when get_analytics_overview shows an old lastSyncedAt. Allowed once per workspace every 10 minutes; inside the cooldown it returns queued: false with cooldownSecondsRemaining rather than an error, so do not retry in a loop. The sync runs in the background: poll get_analytics_sync_status until syncInProgress is false, then read the metrics again. Takes only the optional workspaceId and changes no content.',
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
        platform: PlatformType.optional().describe(
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
        platform: PlatformType.optional().describe(
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
        `Start generating an image from a prompt with AdaptlyPost AI. This is asynchronous: it returns { jobId, sessionId, status } right away with status queued, not the image. Poll get_image_job with the jobId every few seconds until status is completed or failed (usually 10 to 40 seconds), or wait for the image.completed or image.failed webhook if the workspace has one. A completed job carries imageUrl, a public URL you can pass straight into mediaUrls of create_post, so there is no need to run it through upload_media. The image is also saved to the member's AI image studio in AdaptlyPost; reuse sessionId to group related images. ${AI_PERMISSION_RULE} Charges the member's AI credits when generation starts (2 for standard, 4 for premium) unless the member has their own image provider key connected in AdaptlyPost, and refunds them if generation fails. With no credits left the job ends as failed and its error says so: explain that generation is unavailable with the current credit balance and do not retry automatically.`,
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
          .describe('Up to 5 public image URLs that steer the style or subject of the result'),
      },
      outputSchema: resultSchema(
        'An object with jobId (pass it to get_image_job), sessionId, and status (queued).',
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
