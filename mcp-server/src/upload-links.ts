import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';

const UPLOAD_WINDOW_MS = 30 * 60 * 1000;
const RETENTION_MS = 3 * 60 * 60 * 1000;
const MAX_FILES_PER_LINK = 50;
const MAX_BYTES_PER_LINK = 2 * 1024 * 1024 * 1024;

export const UPLOAD_LINK_PATH = '/u';
export const UPLOAD_LINK_HEADER = 'x-upload-link';

export type ParkedFile = { fileName: string; mimeType: string; size: number; dir: string; path: string };
type StoredFile = { fileName: string; publicUrl: string };
type FailedFile = { fileName: string; error: string };
type Store = (file: ParkedFile) => Promise<{ publicUrl: string }>;

type UploadLink = {
  acceptsUntil: number;
  reservedFiles: number;
  reservedBytes: number;
  parked: ParkedFile[];
  saving: Promise<void> | undefined;
  files: StoredFile[];
  failed: FailedFile[];
};

export type UploadLinkStatus = {
  status: 'waiting' | 'saving' | 'ready' | 'failed' | 'expired';
  files: StoredFile[];
  mediaUrls: string[];
  failed: FailedFile[];
  savingCount: number;
  acceptsUntil: string;
};

const links = new Map<string, UploadLink>();

function discard(id: string): void {
  const link = links.get(id);
  if (!link) return;
  links.delete(id);
  for (const file of link.parked) void rm(file.dir, { recursive: true, force: true });
}

export function createUploadLink(): { id: string; acceptsUntil: string } {
  const id = randomBytes(24).toString('base64url');
  const acceptsUntil = Date.now() + UPLOAD_WINDOW_MS;
  links.set(id, {
    acceptsUntil,
    reservedFiles: 0,
    reservedBytes: 0,
    parked: [],
    saving: undefined,
    files: [],
    failed: [],
  });
  setTimeout(() => discard(id), RETENTION_MS).unref();
  return { id, acceptsUntil: new Date(acceptsUntil).toISOString() };
}

export function uploadLinkOpen(id: string): boolean {
  const link = links.get(id);
  return !!link && Date.now() < link.acceptsUntil;
}

export function reserveLinkUpload(id: string, size: number): void {
  const link = links.get(id);
  if (!link || Date.now() >= link.acceptsUntil) {
    throw new Error('This upload link expired. Ask the assistant for a new one.');
  }
  if (link.reservedFiles >= MAX_FILES_PER_LINK) {
    throw new Error(`One upload link takes at most ${MAX_FILES_PER_LINK} files. Ask the assistant for a new one.`);
  }
  if (link.reservedBytes + size > MAX_BYTES_PER_LINK) {
    throw new Error('These files are over the 2 GB this upload link takes. Ask the assistant for a new one.');
  }
  link.reservedFiles += 1;
  link.reservedBytes += size;
}

export function parkLinkUpload(id: string, file: ParkedFile): boolean {
  const link = links.get(id);
  if (!link) return false;
  link.parked.push(file);
  return true;
}

async function saveParked(link: UploadLink, store: Store): Promise<void> {
  while (link.parked.length) {
    const file = link.parked.shift()!;
    try {
      const { publicUrl } = await store(file);
      link.files.push({ fileName: file.fileName, publicUrl });
    } catch (error) {
      link.failed.push({ fileName: file.fileName, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await rm(file.dir, { recursive: true, force: true });
    }
  }
}

function statusOf(link: UploadLink): UploadLinkStatus {
  const savingCount = link.parked.length + (link.saving ? 1 : 0);
  const status = savingCount > 0
    ? 'saving'
    : link.files.length > 0
      ? 'ready'
      : link.failed.length > 0
        ? 'failed'
        : Date.now() >= link.acceptsUntil
        ? 'expired'
        : 'waiting';
  return {
    status,
    files: [...link.files],
    mediaUrls: link.files.map((file) => file.publicUrl),
    failed: [...link.failed],
    savingCount,
    acceptsUntil: new Date(link.acceptsUntil).toISOString(),
  };
}

export async function claimUploadLink(
  id: string,
  store: Store,
  waitMs: number,
): Promise<UploadLinkStatus | undefined> {
  const link = links.get(id);
  if (!link) return undefined;
  if (!link.saving && link.parked.length) {
    link.saving = saveParked(link, store).finally(() => {
      link.saving = undefined;
    });
  }
  if (link.saving) {
    await Promise.race([link.saving, new Promise((resolve) => setTimeout(resolve, waitMs).unref())]);
  }
  return statusOf(link);
}

export function uploadLinkUrl(origin: string, id: string): string {
  return `${origin}${UPLOAD_LINK_PATH}/${id}`;
}
