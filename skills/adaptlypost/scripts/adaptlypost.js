#!/usr/bin/env node
/**
 * AdaptlyPost Agent Skill CLI
 * A zero-dependency Node.js script for managing social media via AdaptlyPost API.
 *
 * MIT Licensed — https://github.com/adaptlypost/agent
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const API_BASE = "https://post.adaptlypost.com/post";
const CONFIG_DIR = path.join(os.homedir(), ".config", "adaptlypost");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LOCAL_CONFIG = path.join(process.cwd(), ".adaptlypost", "config.json");

// ── Config ──────────────────────────────────────────────────────────────────

function getApiKey() {
  if (process.env.ADAPTLYPOST_API_KEY) return process.env.ADAPTLYPOST_API_KEY;
  if (fs.existsSync(LOCAL_CONFIG)) {
    try {
      return JSON.parse(fs.readFileSync(LOCAL_CONFIG, "utf8")).apiKey;
    } catch {}
  }
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).apiKey;
    } catch {}
  }
  return null;
}

function saveApiKey(key, global = true) {
  const dir = global ? CONFIG_DIR : path.join(process.cwd(), ".adaptlypost");
  const file = global ? CONFIG_FILE : LOCAL_CONFIG;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ apiKey: key }, null, 2));
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function request(method, endpoint, body = null) {
  const apiKey = getApiKey();
  if (!apiKey) {
    error(
      "No API key found. Run: ./scripts/adaptlypost.js setup --key adaptly_xxxxx",
    );
    error("Get your API key at: https://adaptlypost.com/api-tokens");
    process.exit(1);
  }
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    error(`API error (${res.status}): ${JSON.stringify(data)}`);
    process.exit(1);
  }
  return data;
}

// ── Output ──────────────────────────────────────────────────────────────────

function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

function error(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
}

function info(msg) {
  console.error(`\x1b[36mInfo:\x1b[0m ${msg}`);
}

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        parsed[key] = true;
      } else {
        parsed[key] = next;
        i++;
      }
    }
  }
  return parsed;
}

// ── Commands ────────────────────────────────────────────────────────────────

const COMMANDS = {
  setup: async (args) => {
    const parsed = parseArgs(args);
    const key = parsed.key || parsed["api-key"];
    if (!key) {
      error("Usage: ./scripts/adaptlypost.js setup --key adaptly_xxxxx");
      error("Get your API key at: https://adaptlypost.com/api-tokens");
      process.exit(1);
    }
    const global = !parsed.local;
    saveApiKey(key, global);
    info(`API key saved ${global ? "globally" : "locally"}.`);
    output({ status: "configured", location: global ? "global" : "local" });
  },

  accounts: async () => {
    const data = await request("GET", "/api/v1/social-accounts");
    output(data);
  },

  post: async (args) => {
    const parsed = parseArgs(args);
    if (!parsed.caption && !parsed.text) {
      error(
        'Usage: ./scripts/adaptlypost.js post --caption "..." --accounts id1,id2 --platforms LINKEDIN,TWITTER',
      );
      process.exit(1);
    }

    const accounts = parsed.accounts ? parsed.accounts.split(",") : [];
    const platforms = parsed.platforms
      ? parsed.platforms.split(",")
      : guessPlafformsFromAccounts(accounts);

    const body = {
      text: parsed.caption || parsed.text,
      platforms,
      contentType: parsed.type || "TEXT",
      timezone: parsed.timezone || "UTC",
    };

    // Map account IDs to connection ID arrays
    if (accounts.length > 0) {
      body.linkedinConnectionIds = [];
      body.twitterConnectionIds = [];
      body.instagramConnectionIds = [];
      body.youtubeConnectionIds = [];
      body.tiktokConnectionIds = [];
      body.threadsConnectionIds = [];
      body.blueskyConnectionIds = [];
      body.pinterestConnectionIds = [];
      body.pageIds = [];

      // When --accounts is used, we pass them to all platform connection arrays
      // The backend will ignore IDs that don't belong to that platform
      for (const id of accounts) {
        body.linkedinConnectionIds.push(id);
        body.twitterConnectionIds.push(id);
        body.instagramConnectionIds.push(id);
        body.youtubeConnectionIds.push(id);
        body.tiktokConnectionIds.push(id);
        body.threadsConnectionIds.push(id);
        body.blueskyConnectionIds.push(id);
        body.pinterestConnectionIds.push(id);
        body.pageIds.push(id);
      }
    }

    if (parsed["media-urls"]) {
      body.mediaUrls = parsed["media-urls"].split(",");
      if (!parsed.type) body.contentType = "IMAGE";
    }

    if (parsed.schedule) {
      body.scheduledAt = parsed.schedule;
    }

    if (parsed.draft) {
      body.saveAsDraft = true;
    }

    // TikTok privacy
    if (platforms.includes("TIKTOK")) {
      const tiktokIds = body.tiktokConnectionIds || [];
      if (tiktokIds.length > 0) {
        body.tiktokConfigs = tiktokIds.map((connectionId) => ({
          connectionId,
          privacyLevel: parsed["tiktok-privacy"] || "PUBLIC_TO_EVERYONE",
        }));
      }
    }

    if (parsed["platform-text"]) {
      try {
        body.platformTexts = JSON.parse(parsed["platform-text"]);
      } catch {
        error("Invalid JSON in --platform-text");
        process.exit(1);
      }
    }

    const data = await request("POST", "/api/v1/social-posts", body);
    output(data);
  },

  posts: async (args) => {
    const parsed = parseArgs(args);
    const params = new URLSearchParams();
    if (parsed.limit) params.set("limit", parsed.limit);
    if (parsed.offset) params.set("offset", parsed.offset);
    if (parsed.status)
      parsed.status.split(",").forEach((s) => params.append("statuses", s));
    if (parsed.platform)
      parsed.platform.split(",").forEach((p) => params.append("platforms", p));
    const qs = params.toString();
    const data = await request(
      "GET",
      `/api/v1/social-posts${qs ? `?${qs}` : ""}`,
    );
    output(data);
  },

  "posts:get": async (args) => {
    const parsed = parseArgs(args);
    if (!parsed.id) {
      error("Usage: ./scripts/adaptlypost.js posts:get --id <post_id>");
      process.exit(1);
    }
    const data = await request("GET", `/api/v1/social-posts/${parsed.id}`);
    output(data);
  },

  "posts:update": async (args) => {
    const parsed = parseArgs(args);
    if (!parsed.id) {
      error(
        'Usage: ./scripts/adaptlypost.js posts:update --id <post_id> --caption "new text"',
      );
      process.exit(1);
    }
    const body = {};
    if (parsed.caption || parsed.text)
      body.text = parsed.caption || parsed.text;
    if (parsed.schedule) body.scheduledAt = parsed.schedule;
    if (parsed.timezone) body.timezone = parsed.timezone;

    const data = await request(
      "PATCH",
      `/api/v1/social-posts/${parsed.id}`,
      body,
    );
    output(data);
  },

  "posts:delete": async (args) => {
    const parsed = parseArgs(args);
    if (!parsed.id) {
      error("Usage: ./scripts/adaptlypost.js posts:delete --id <post_id>");
      process.exit(1);
    }
    const data = await request("DELETE", `/api/v1/social-posts/${parsed.id}`);
    output(data);
  },

  "posts:publish": async (args) => {
    const parsed = parseArgs(args);
    if (!parsed.id) {
      error("Usage: ./scripts/adaptlypost.js posts:publish --id <post_id>");
      process.exit(1);
    }
    const body = { timezone: parsed.timezone || "UTC" };
    if (parsed.schedule) body.scheduledAt = parsed.schedule;

    const data = await request(
      "POST",
      `/api/v1/social-posts/${parsed.id}/publish`,
      body,
    );
    output(data);
  },

  results: async (args) => {
    const parsed = parseArgs(args);
    if (!parsed.id) {
      error("Usage: ./scripts/adaptlypost.js results --id <post_id>");
      process.exit(1);
    }
    const data = await request(
      "GET",
      `/api/v1/social-posts/${parsed.id}/results`,
    );
    output(data);
  },

  "posts:retry": async (args) => {
    const parsed = parseArgs(args);
    if (!parsed.id || !parsed.platforms) {
      error(
        "Usage: ./scripts/adaptlypost.js posts:retry --id <post_id> --platforms pid1,pid2",
      );
      process.exit(1);
    }
    const data = await request(
      "POST",
      `/api/v1/social-posts/${parsed.id}/retry`,
      {
        platformIds: parsed.platforms.split(","),
      },
    );
    output(data);
  },

  "posts:bulk": async (args) => {
    const parsed = parseArgs(args);
    if (!parsed.file) {
      error("Usage: ./scripts/adaptlypost.js posts:bulk --file posts.json");
      error(
        "JSON format: { platforms, timezone, posts: [{ text, contentType, scheduledAt }], ...connectionIds }",
      );
      process.exit(1);
    }
    const filePath = path.resolve(parsed.file);
    if (!fs.existsSync(filePath)) {
      error(`File not found: ${filePath}`);
      process.exit(1);
    }
    const body = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const data = await request("POST", "/api/v1/social-posts/bulk", body);
    output(data);
  },

  help: async () => {
    output({
      name: "AdaptlyPost Agent Skill",
      version: "1.0.0",
      commands: Object.keys(COMMANDS).filter((c) => c !== "help"),
      docs: "https://adaptlypost.com/features/agents",
      api_tokens: "https://adaptlypost.com/api-tokens",
    });
  },
};

function guessPlafformsFromAccounts() {
  // Default to common platforms — the backend ignores connection IDs
  // that don't match the platform, so this is safe
  return ["LINKEDIN", "TWITTER", "INSTAGRAM"];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2] || "help";
  const args = process.argv.slice(3);

  if (!COMMANDS[command]) {
    error(`Unknown command: ${command}`);
    error(`Available: ${Object.keys(COMMANDS).join(", ")}`);
    process.exit(1);
  }

  try {
    await COMMANDS[command](args);
  } catch (err) {
    error(err.message);
    process.exit(1);
  }
}

main();
