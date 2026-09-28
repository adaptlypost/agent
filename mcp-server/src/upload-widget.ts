import { createHash } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';

export const UPLOAD_WIDGET_URI = 'ui://adaptlypost/upload-v1.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const UPLOAD_TICKET_HEADER = 'x-upload-ticket';
export const UPLOAD_FILE_NAME_HEADER = 'x-file-name';

const TICKET_TTL_SECONDS = 5 * 60;

export type UploadTicket = { token: string; workspaceId?: string };

function ticketKey(): Uint8Array | undefined {
  const secret = process.env.UPLOAD_TICKET_SECRET;
  return secret ? createHash('sha256').update(secret).digest() : undefined;
}

export function uploadTicketsEnabled(): boolean {
  return ticketKey() !== undefined;
}

export async function sealUploadTicket(
  ticket: UploadTicket,
): Promise<{ ticket: string; expiresAt: string }> {
  const key = ticketKey();
  if (!key) throw new Error('Uploading from a device is not available on this server.');
  const expiresAt = new Date(Date.now() + TICKET_TTL_SECONDS * 1000);
  const sealed = await new EncryptJWT({ t: ticket.token, w: ticket.workspaceId })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .encrypt(key);
  return { ticket: sealed, expiresAt: expiresAt.toISOString() };
}

export async function openUploadTicket(sealed: string): Promise<UploadTicket | undefined> {
  const key = ticketKey();
  if (!key || !sealed) return undefined;
  try {
    const { payload } = await jwtDecrypt(sealed, key);
    if (typeof payload.t !== 'string') return undefined;
    return {
      token: payload.t,
      workspaceId: typeof payload.w === 'string' ? payload.w : undefined,
    };
  } catch {
    return undefined;
  }
}

export function decodeFileName(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  try {
    const name = decodeURIComponent(raw ?? '').replace(/[\\/]/g, '').trim();
    return name.slice(0, 120) || 'upload';
  } catch {
    return 'upload';
  }
}

const ACCEPT = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
  '.ppt',
  '.pptx',
  '.doc',
  '.docx',
].join(',');

export function uploadWidgetHtml(uploadEndpoint: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload to AdaptlyPost</title>
<style>
  :root {
    --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb;
    --accent: #4f46e5; --accent-soft: #eef2ff; --ok: #059669; --err: #dc2626;
  }
  :root[data-theme="dark"] {
    --bg: #1f2023; --fg: #f3f4f6; --muted: #9ca3af; --line: #374151;
    --accent: #818cf8; --accent-soft: #272a3f; --ok: #34d399; --err: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px; background: var(--bg); color: var(--fg);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .drop {
    border: 2px dashed var(--line); border-radius: 12px; padding: 24px 16px;
    text-align: center; transition: border-color .15s, background .15s;
  }
  .drop.over { border-color: var(--accent); background: var(--accent-soft); }
  .drop strong { display: block; font-size: 15px; margin-bottom: 4px; }
  .drop p { margin: 0 0 14px; color: var(--muted); }
  button {
    font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 9px 16px;
    background: var(--accent); color: #fff; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; margin: 12px 0 0; padding: 0; }
  li {
    display: grid; grid-template-columns: 44px 1fr; gap: 10px; align-items: center;
    padding: 8px 0; border-top: 1px solid var(--line);
  }
  .thumb {
    width: 44px; height: 44px; border-radius: 6px; background: var(--accent-soft);
    object-fit: cover; display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; color: var(--accent); text-transform: uppercase;
  }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { font-size: 12px; color: var(--muted); }
  .meta.ok { color: var(--ok); }
  .meta.err { color: var(--err); }
  .bar { height: 4px; border-radius: 2px; background: var(--line); margin-top: 4px; overflow: hidden; }
  .bar > span { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s; }
  .note { margin: 10px 2px 0; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
  <div class="drop" id="drop">
    <strong>Add photos, videos or documents</strong>
    <p>Drop files here or choose them from your device.</p>
    <button type="button" id="choose">Choose files</button>
    <input type="file" id="input" multiple accept="${ACCEPT}" hidden>
  </div>
  <ul id="list"></ul>
  <p class="note">JPEG, PNG, WebP, MP4, MOV, PDF, PowerPoint or Word. Uploaded files are stored at public links so they can be posted.</p>
<script>
(() => {
  const ENDPOINT = ${JSON.stringify(uploadEndpoint)};
  const MAX_BYTES = 250 * 1024 * 1024;
  const PROTOCOL_VERSION = '2026-01-26';
  const drop = document.getElementById('drop');
  const input = document.getElementById('input');
  const choose = document.getElementById('choose');
  const list = document.getElementById('list');
  let workspaceId;
  let nextId = 1;
  const pending = new Map();

  function send(message) {
    window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*');
  }

  function request(method, params, timeoutMs) {
    const id = nextId++;
    send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, timeoutMs || 15000);
      pending.set(id, { resolve, reject, timer });
    });
  }

  function notify(method, params) {
    send({ method, params: params || {} });
  }

  function readArguments(args) {
    if (args && typeof args.workspaceId === 'string') workspaceId = args.workspaceId;
  }

  function applyTheme(context) {
    if (context && context.theme) document.documentElement.dataset.theme = context.theme;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || 'Request failed'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-input') readArguments(message.params && message.params.arguments);
    if (message.method === 'ui/notifications/host-context-changed') applyTheme(message.params);
  });

  async function connect() {
    try {
      const result = await request('ui/initialize', {
        appInfo: { name: 'adaptlypost-upload', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: PROTOCOL_VERSION,
      });
      applyTheme(result && result.hostContext);
      notify('ui/notifications/initialized');
    } catch {
      const openai = window.openai;
      if (openai) {
        readArguments(openai.toolInput);
        applyTheme({ theme: openai.theme });
      }
    }
  }

  function reportSize() {
    notify('ui/notifications/size-changed', {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    });
  }

  async function callTool(name, args) {
    try {
      return await request('tools/call', { name, arguments: args }, 30000);
    } catch (error) {
      if (window.openai && window.openai.callTool) return window.openai.callTool(name, args);
      throw error;
    }
  }

  async function ticket() {
    const result = await callTool('get_upload_ticket', workspaceId ? { workspaceId } : {});
    const sealed = result && result._meta && result._meta.uploadTicket;
    if (!sealed) {
      const text = result && result.content && result.content[0] && result.content[0].text;
      throw new Error(text || 'Could not start the upload.');
    }
    return sealed;
  }

  function row(file) {
    const item = document.createElement('li');
    let thumb;
    if (file.type.startsWith('image/')) {
      thumb = document.createElement('img');
      thumb.src = URL.createObjectURL(file);
      thumb.alt = '';
      thumb.onerror = () => thumb.replaceWith(badge(file));
    } else {
      thumb = badge(file);
    }
    thumb.classList.add('thumb');
    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = file.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'Waiting';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('span');
    bar.appendChild(fill);
    text.append(name, meta, bar);
    item.append(thumb, text);
    list.appendChild(item);
    return {
      progress(fraction) { fill.style.width = Math.round(fraction * 100) + '%'; meta.textContent = 'Uploading ' + Math.round(fraction * 100) + '%'; },
      done() { fill.style.width = '100%'; meta.className = 'meta ok'; meta.textContent = 'Uploaded'; },
      fail(reason) { bar.remove(); meta.className = 'meta err'; meta.textContent = reason; },
    };
  }

  function badge(file) {
    const box = document.createElement('div');
    box.className = 'thumb';
    box.textContent = (file.name.split('.').pop() || 'file').slice(0, 4);
    return box;
  }

  function put(file, sealed, view) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT);
      xhr.setRequestHeader('X-Upload-Ticket', sealed);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) view.progress(event.loaded / event.total); };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && body.publicUrl) resolve(body);
        else reject(new Error(body.error || 'Upload failed (' + xhr.status + ')'));
      };
      xhr.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
      xhr.send(file);
    });
  }

  async function tell(uploaded) {
    const lines = uploaded.map((u) => '- ' + u.fileName + ': ' + u.publicUrl);
    const text = 'I uploaded ' + (uploaded.length === 1 ? 'a file' : uploaded.length + ' files') +
      ' to AdaptlyPost. Use these media URLs:\\n' + lines.join('\\n');
    const mediaUrls = uploaded.map((u) => u.publicUrl);
    request('ui/update-model-context', {
      content: [{ type: 'text', text }],
      structuredContent: { mediaUrls },
    }).catch(() => {});
    try {
      const result = await request('ui/message', { role: 'user', content: [{ type: 'text', text }] });
      if (result && result.isError) throw new Error('message rejected');
    } catch {
      if (window.openai && window.openai.sendFollowUpMessage) window.openai.sendFollowUpMessage({ prompt: text });
    }
  }

  async function upload(files) {
    if (!files.length) return;
    choose.disabled = true;
    const uploaded = [];
    for (const file of files) {
      const view = row(file);
      reportSize();
      if (file.size > MAX_BYTES) { view.fail('Over the 250 MB limit'); continue; }
      try {
        const result = await put(file, await ticket(), view);
        view.done();
        uploaded.push({ fileName: file.name, publicUrl: result.publicUrl });
      } catch (error) {
        view.fail(error.message);
      }
      reportSize();
    }
    choose.disabled = false;
    if (uploaded.length) await tell(uploaded);
  }

  choose.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { upload(Array.from(input.files || [])); input.value = ''; });
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    upload(Array.from((event.dataTransfer && event.dataTransfer.files) || []));
  });

  if (window.ResizeObserver) new ResizeObserver(reportSize).observe(document.body);
  connect().then(reportSize);
})();
</script>
</body>
</html>`;
}
