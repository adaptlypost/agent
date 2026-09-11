import { lookup, type LookupAddress, type LookupOptions } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * MB;
const MAX_DOWNLOAD_BYTES = 250 * MB;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip']);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  const box = ascii(bytes, 4, 8);
  if (box === 'ftyp') return ascii(bytes, 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (QUICKTIME_ATOMS.has(box)) return 'video/quicktime';
  return undefined;
}

function formatBytes(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

export function requireMediaContent(bytes: Uint8Array, source: string): string {
  const mimeType = sniffMimeType(bytes);
  if (!mimeType) {
    throw new Error(
      `${source} is not a JPEG, PNG, WebP, MP4 or QuickTime file. Its content was checked, not just its name.`,
    );
  }
  if (mimeType.startsWith('image/') && bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`${source} is over the ${formatBytes(MAX_IMAGE_BYTES)} image limit.`);
  }
  return mimeType;
}

const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return BLOCKED_ADDRESSES.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') throw new Error(`Only https:// media URLs are accepted: ${raw}`);
  if (url.username || url.password) throw new Error('Media URLs must not carry credentials.');
  if (url.port && url.port !== '443') throw new Error(`Media URLs must use the standard HTTPS port: ${raw}`);

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if ((!isIP(host) && !host.includes('.')) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error(`Media URLs must point at a public host, not ${host}.`);
  }
  if (isIP(host) && isBlockedAddress(host)) {
    throw new Error(`Media URLs must point at a public address, not ${host}.`);
  }
  return url;
}

export function describeUrl(url: URL): string {
  return `${url.hostname}${url.pathname}`;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function publicOnlyLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) {
      return callback(
        Object.assign(new Error(`${hostname} resolves to a private or reserved address, so it was not fetched.`), {
          code: 'EADDRNOTAVAIL',
        }),
        '',
      );
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function httpsGet(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'GET', lookup: publicOnlyLookup, signal, headers: { Accept: 'image/*,video/*' } },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

async function readBounded(res: IncomingMessage, source: string): Promise<Buffer> {
  const declared = Number(res.headers['content-length']);
  if (declared > MAX_DOWNLOAD_BYTES) {
    res.destroy();
    throw new Error(`${source} is ${formatBytes(declared)}, over the ${formatBytes(MAX_DOWNLOAD_BYTES)} download limit.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      res.destroy();
      throw new Error(`${source} is over the ${formatBytes(MAX_DOWNLOAD_BYTES)} download limit.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function downloadPublicMedia(sourceUrl: string): Promise<{ body: Buffer; url: URL }> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let url = parsePublicUrl(sourceUrl);

  for (let redirects = 0; ; redirects++) {
    const res = await httpsGet(url, signal);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;

    if (status >= 300 && status < 400 && location) {
      res.resume();
      if (redirects >= MAX_REDIRECTS) throw new Error(`${describeUrl(url)} redirected too many times.`);
      url = parsePublicUrl(new URL(location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`Failed to download ${describeUrl(url)}: HTTP ${status}`);
    }
    return { body: await readBounded(res, describeUrl(url)), url };
  }
}

export function fileNameFor(url: URL, mimeType: string): string {
  const lastSegment = url.pathname.split('/').pop() ?? '';
  const stem = lastSegment.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-').slice(0, 80);
  return `${stem || 'upload'}${EXT_BY_MIME[mimeType]}`;
}
