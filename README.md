# Toolsmith Extension

Browser extension that connects web AI chats to your own machine through
the [Toolsmith MCP server](https://github.com/arosyihuddin/toolsmith-mcp).
First target: **Google Gemini** (`gemini.google.com`).

Gemini's web chat has no tool calling of its own. This extension bridges
the gap with the pattern chat UIs leave open - the DOM:

1. It injects a **Toolsmith** toggle into Gemini's input menu, next to
   the **+** button.
2. Switching it on fetches the live tool list from your MCP server and
   sends a setup message (a visible "system prompt") that teaches the
   model the usual LLM tool-calling shape: reply with a fenced
   `tool_call` block containing `{"name": "...", "arguments": {...}}`.
3. The extension watches the model's answers. When a tool call appears,
   it runs the tool through the MCP server and types the result back as
   the next user message (`[TOOL RESULT ...]`), so the model continues
   with real data from your machine.

While a chat is on, every message you send gets a short
`[TOOLSMITH MODE]` reminder appended, so the model does not drift out
of tool mode in long conversations. The on/off state is remembered per
chat: refreshing the page keeps it on, no new setup message needed.

## Requirements

- A running **Toolsmith MCP server**
  ([toolsmith-mcp](https://github.com/arosyihuddin/toolsmith-mcp)) -
  on your PC, a server, or anywhere reachable by your browser.
- A Chromium-based browser (Chrome, Brave, Edge, ...).

## Install

### From a release (recommended)

1. Open the
   [releases page](https://github.com/arosyihuddin/toolsmith-extension/releases)
   and download `toolsmith-extension-<version>.zip` from the latest
   release.
2. Extract the zip somewhere permanent (the browser loads the files
   from there every start, so do not delete the folder afterwards).
3. Open `chrome://extensions` and enable **Developer mode**
   (top-right corner).
4. Click **Load unpacked** and select the extracted
   `toolsmith-extension-<version>` folder.
5. The Toolsmith icon appears in the toolbar. Pin it for easy access.

### From source

```sh
git clone https://github.com/arosyihuddin/toolsmith-extension.git
```

Then follow steps 3-5 above, selecting the cloned folder.

### Update

Download the newer zip, extract it over the old folder (or clone/pull),
then click the **reload** icon on the extension's card in
`chrome://extensions`. Your settings and per-chat state are kept.

## Connect

1. Click the extension icon, then **Pengaturan** (options), or open the
   options page from `chrome://extensions`.
2. Fill in your MCP server URL, for example
   `https://your-host.example/mcp` or `http://localhost:48766/mcp`
   for a server running on the same machine. There is no default URL.
3. Choose an auth method:
   - **OAuth** (recommended): click **Connect dengan OAuth**. The
     extension registers itself as an OAuth client on your server
     (dynamic client registration) and opens the server's own login
     page; approve it there and you are connected. Tokens are stored
     only in the extension's local storage and refreshed silently.
   - **Bearer token**: paste a token into the token field and save.
     A fallback for servers without OAuth.
4. When the status shows **Terhubung**, the options page lists every
   tool your server offers.

## Use

1. Open a Gemini chat and click the **Toolsmith** toggle in the input
   menu (after the **+** button below the text field). It turns **On**
   and the setup message is sent; Gemini replies "Siap.".
2. Ask for something that needs your machine, e.g. "cek sisa disk dan
   versi kernel PC saya". Watch it call the tools.
3. Click the toggle again to turn Toolsmith off for that chat.

## Tool permissions

Every tool has its own permission in the options page tool list
(**Read tools** / **Write tools** sections):

- **Otomatis** - runs immediately when the model calls it.
- **Tanya** - an approval card pops up in the Gemini page first.
  The card offers **Tolak** (deny once), **Jalankan** (run once), and
  **Setujui sesi ini** (run this tool automatically for the rest of
  this chat only).
- **Tolak** - the tool is not offered to the model at all, and a call
  is refused if one arrives anyway.

Defaults: read tools are **Otomatis**, write tools are **Tanya**.
Session approvals can be reviewed and revoked per chat in the
**Chat Aktif** tab of the options page.

Auto-loops are capped at 5 consecutive tool rounds; any message you
type yourself resets the budget.

## Layout

- `background.js` - minimal MCP client (Streamable HTTP, session
  handling, JSON or SSE responses) plus the OAuth connect mechanism.
  All network traffic and credentials live here, never in the page.
- `content.js` - Gemini adapter: toggle injection, setup prompt,
  response watching, tool-call parsing, permissions, approval card,
  result injection, per-message mode reminder.
- `popup.*` / `options.*` - connection status, server settings, tool
  permissions, and the armed-chat list.

## Known limits

- Gemini's DOM changes from time to time; the selectors in
  `content.js` have fallbacks but may need adjusting after a redesign.
- One tool call per model reply.
- The setup message and the per-message reminders are visible in the
  chat (there is no hidden system-prompt channel in a consumer chat
  UI).
- Chrome throttles hidden tabs, so an ongoing tool loop slows down
  while the Gemini tab is in the background. It continues, just
  slower.
