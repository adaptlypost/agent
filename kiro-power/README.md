# AdaptlyPost power for Kiro

Draft, schedule and publish social media posts, answer your inbox and read post analytics from Kiro.

## Install

1. Open the Powers panel in Kiro.
2. Choose **Add Custom Power**, then **Import power from GitHub**.
3. Enter `https://github.com/adaptlypost/agent/tree/main/kiro-power` and choose **Install**.

The first tool call opens a browser to sign in with your AdaptlyPost account. There is no API key to set up.

You need a AdaptlyPost account: [adaptlypost.com](https://adaptlypost.com).

## What is in this folder

| Path | What it is |
| --- | --- |
| `plugin.json` | The power's manifest and activation keywords. |
| `mcp.json` | The hosted MCP server at `https://mcp.adaptlypost.com/mcp`. |
| `skills/adaptlypost/` | How the agent should use the tools. |
