# Toolsmith Extension

Browser extension that connects web AI chats to your own machine through
the [Toolsmith MCP](../toolsmith-mcp) server. First target:
**Google Gemini** (`gemini.google.com`).

Gemini's web chat has no tool calling of its own. This extension
bridges the gap with the pattern chat UIs leave open - the DOM:

1. It injects a **Toolsmith: Off/On** button above the chat
   composer.
2. Switching it on fetches the live tool list from your MCP server
   and sends a setup message (a "system prompt") that teaches the
   model the usual LLM tool-calling shape: reply with a fenced
   `tool_call` block containing
   `{"name": "...", "arguments": {...}}`.
3. The extension watches the model's answers. When a tool call
   appears, it runs the tool through the MCP server and types the
   result back as the next user message (`[TOOL RESULT ...]`), so
   the model continues with real data from your machine.

Read-only tools (system info, file search/read, etc.) run
automatically. Anything that can change the system (bash, write,
edit, ...) first pops an approval card in the page. Auto-loops are
capped at 5 consecutive tool rounds; any message you type yourself
resets the budget.

## Install (developer mode)

1. Open `chrome://extensions` (or Brave/Edge equivalent).
2. Enable **Developer mode**.
3. **Load unpacked** and select this folder.
4. Click the extension icon → **Connect**. The extension
   registers itself as an OAuth client on your server (dynamic
   client registration) and opens the server's own login page;
   approve it and you are connected. Access tokens are stored
   only in the extension's local storage and refreshed silently.

A manually pasted bearer token remains available under
**Pengaturan** (options) as a fallback for servers without
OAuth. There is no default server URL: set yours in the options.

## Use

1. Open a **new** Gemini chat.
2. Click **Toolsmith: Off** above the composer. The button turns
   **On** and a setup message is sent; Gemini replies "Siap."
3. Ask for something that needs your PC, e.g. "cek sisa disk dan
   versi kernel PC saya". Watch it call the tools.

## Layout

- `background.js` - minimal MCP client (Streamable HTTP, session
  handling, JSON or SSE responses) plus the OAuth connect
  mechanism. All network traffic and credentials live here,
  never in the page.
- `content.js` - Gemini adapter: button injection, setup prompt,
  response watching, tool-call parsing, approval card, result
  injection.
- `popup.*` / `options.*` - connection status and server settings.

## Known limits (MVP)

- Gemini's DOM changes from time to time; the selectors in
  `content.js` have fallbacks but may need adjusting after a
  redesign.
- One tool call per model reply.
- The setup message is visible in the chat (there is no hidden
  system-prompt channel in a consumer chat UI).
