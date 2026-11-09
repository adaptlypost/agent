import type { IncomingMessage, ServerResponse } from "node:http";

export type SetupPageConfig = {
  key: string;
  title: string;
  description: string;
  mcpUrl: string;
  websiteUrl: string;
  repoUrl: string;
  iconUrl: string;
  apiTokensUrl: string;
  apiKeyExample: string;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const code = (value: string) => `<pre><code>${escapeHtml(value)}</code></pre>`;

export const isSetupPageRequest = (req: IncomingMessage) =>
  (req.method === "GET" || req.method === "HEAD") &&
  !req.headers.authorization &&
  !(req.headers.accept ?? "").includes("text/event-stream");

const renderSetupPage = (c: SetupPageConfig) => {
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const sections: Array<[string, string]> = [
    [
      "Claude.ai and Claude Desktop",
      `<p>Open Settings &gt; Connectors, add a custom connector with the URL <code>${c.mcpUrl}</code>, and sign in.</p>`,
    ],
    ["Claude Code", code(`claude mcp add --transport http ${c.key} ${c.mcpUrl}`)],
    [
      "ChatGPT",
      `<p>Add a custom connector in Settings &gt; Apps &amp; Connectors with the URL <code>${c.mcpUrl}</code> and sign in.</p>`,
    ],
    ["Cursor", `<p><code>~/.cursor/mcp.json</code></p>${code(json({ mcpServers: { [c.key]: { url: c.mcpUrl } } }))}`],
    [
      "Windsurf",
      `<p><code>~/.codeium/windsurf/mcp_config.json</code></p>${code(json({ mcpServers: { [c.key]: { serverUrl: c.mcpUrl } } }))}`,
    ],
    ["VS Code", code(json({ servers: { [c.key]: { type: "http", url: c.mcpUrl } } }))],
    [
      "Codex",
      `<p><code>~/.codex/config.toml</code>, then <code>codex mcp login ${c.key}</code></p>${code(`[mcp_servers.${c.key}]\nurl = "${c.mcpUrl}"`)}`,
    ],
    [
      "Headless agents and clients without OAuth",
      `<p>Create an API token at <a href="${c.apiTokensUrl}">${c.apiTokensUrl}</a> and send it as a bearer header.</p>${code(
        json({
          mcpServers: {
            [c.key]: { type: "http", url: c.mcpUrl, headers: { Authorization: `Bearer ${c.apiKeyExample}` } },
          },
        }),
      )}`,
    ],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(c.title)} MCP server</title>
<meta name="description" content="${escapeHtml(c.description)}">
<link rel="icon" href="${c.iconUrl}" type="image/svg+xml">
<style>
:root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5c5c5c; --bg: #fff; --card: #f4f4f5; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #a1a1aa; --bg: #111113; --card: #1c1c1f; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 40px 16px 64px; }
header { display: flex; gap: 16px; align-items: center; }
header img { width: 56px; height: 56px; }
h1 { font-size: 28px; margin: 0; }
h2 { font-size: 18px; margin: 32px 0 8px; }
p { margin: 8px 0; }
.muted { color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
pre { background: var(--card); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
.url { background: var(--card); padding: 12px 14px; border-radius: 8px; font-size: 17px; word-break: break-all; }
a { color: inherit; }
</style>
</head>
<body>
<main>
<header><img src="${c.iconUrl}" alt=""><h1>${escapeHtml(c.title)} MCP server</h1></header>
<p>${escapeHtml(c.description)}</p>
<h2>Server URL</h2>
<p class="url"><code>${c.mcpUrl}</code></p>
<p class="muted">Streamable HTTP. Most clients need only this URL: the first call opens a browser to sign in with your ${escapeHtml(c.title)} account, so there is nothing to install and no key to paste.</p>
${sections.map(([heading, body]) => `<h2>${escapeHtml(heading)}</h2>\n${body}`).join("\n")}
<h2>More</h2>
<p>Every tool, example prompts and setup for more clients: <a href="${c.repoUrl}#readme">${c.repoUrl}</a>. Product: <a href="${c.websiteUrl}">${c.websiteUrl}</a>.</p>
</main>
</body>
</html>
`;
};

export const sendSetupPage = (config: SetupPageConfig, req: IncomingMessage, res: ServerResponse) => {
  const html = renderSetupPage(config);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "public, max-age=300",
  });
  res.end(req.method === "HEAD" ? undefined : html);
};
