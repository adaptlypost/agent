import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REVEAL_WINDOW_MS = 30 * 60 * 1000;

export const WEBHOOK_SECRET_PATH = '/webhook-secret';

type ParkedSecret = { secret: string; webhookUrl: string; expiresAt: number };

const parked = new Map<string, ParkedSecret>();

export function parkWebhookSecret(
  origin: string,
  secret: string,
  webhookUrl: string,
): { secretRevealUrl: string; secretRevealExpiresAt: string } {
  const id = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + REVEAL_WINDOW_MS;
  parked.set(id, { secret, webhookUrl, expiresAt });
  setTimeout(() => parked.delete(id), REVEAL_WINDOW_MS).unref();
  return {
    secretRevealUrl: `${origin}${WEBHOOK_SECRET_PATH}/${id}`,
    secretRevealExpiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function saveWebhookSecretFile(webhookId: string, secret: string): Promise<string> {
  const dir = join(homedir(), '.adaptlypost', 'webhook-secrets');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${webhookId.replace(/[^\w-]/g, '_')}.txt`);
  await writeFile(path, `${secret}\n`, { mode: 0o600 });
  return path;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body {
    max-width: 560px; margin: 0 auto; padding: 32px 16px; color: #111827; background: #ffffff;
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { margin: 0 0 12px; color: #6b7280; }
  code { display: block; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; background: #f9fafb; color: #111827; word-break: break-all; font-size: 14px; }
  button { padding: 8px 16px; border: 0; border-radius: 8px; background: #111827; color: #ffffff; font: inherit; cursor: pointer; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function sendPage(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex',
    'X-Frame-Options': 'DENY',
  });
  res.end(html);
}

const GONE_HTML = page(
  'Link expired',
  `  <h1>This link expired</h1>
  <p>The signing secret is shown once and only for 30 minutes. Delete the webhook and create it again to get a new secret.</p>`,
);

export function routeWebhookSecret(req: IncomingMessage, res: ServerResponse): void {
  const [, , id = '', extra] = (req.url ?? '').split('?')[0].split('/');
  req.resume();
  const entry = parked.get(id);
  if (extra !== undefined || (req.method !== 'GET' && req.method !== 'POST')) {
    sendPage(res, 404, page('Not found', '  <h1>Not found</h1>'));
    return;
  }
  if (!entry || Date.now() >= entry.expiresAt) {
    sendPage(res, 410, GONE_HTML);
    return;
  }
  const webhookUrl = escapeHtml(entry.webhookUrl);
  if (req.method === 'GET') {
    sendPage(
      res,
      200,
      page(
        'Webhook signing secret',
        `  <h1>Webhook signing secret</h1>
  <p>For the AdaptlyPost webhook that posts to ${webhookUrl}. The secret shows once: after you reveal it, this link stops working.</p>
  <form method="post"><button type="submit">Reveal secret</button></form>`,
      ),
    );
    return;
  }
  parked.delete(id);
  sendPage(
    res,
    200,
    page(
      'Webhook signing secret',
      `  <h1>Webhook signing secret</h1>
  <p>For the AdaptlyPost webhook that posts to ${webhookUrl}. Store it now in your endpoint's secret store; this page will not show it again.</p>
  <code>${escapeHtml(entry.secret)}</code>
  <p style="margin-top:12px">Check each delivery with sha256=HMAC_SHA256(secret, "{x-adaptly-timestamp}.{rawBody}") against the x-adaptly-signature header.</p>`,
    ),
  );
}
