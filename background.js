// Toolsmith extension - background service worker.
//
// A minimal MCP (Streamable HTTP) client plus the connection
// mechanism. Two ways to authenticate to a Toolsmith server:
//
//   1. OAuth 2.0 (primary): the server implements the MCP OAuth
//      profile - discovery at /.well-known/oauth-authorization-
//      server, dynamic client registration at /oauth/register,
//      authorization code + PKCE (S256) at /oauth/authorize and
//      /oauth/token, refresh tokens, revocation at /oauth/revoke.
//      The Connect button runs this flow via
//      chrome.identity.launchWebAuthFlow; tokens live in
//      chrome.storage.local and are refreshed silently.
//   2. A manually pasted bearer token (fallback, set in options).
//
// All network calls happen here, from the extension context, so
// the chat page never sees credentials and CORS does not apply.

const DEFAULT_SETTINGS = {
  serverUrl: "",
  authMethod: "",
  token: "",
};

let session = { id: null, initialized: false, serverInfo: null };
let rpcId = 0;
let discoveryCache = null;

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function getOAuth() {
  const { oauth } = await chrome.storage.local.get({ oauth: null });
  return oauth;
}

async function setOAuth(oauth) {
  await chrome.storage.local.set({ oauth });
  resetSession();
}

function resetSession() {
  session = { id: null, initialized: false, serverInfo: null };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.serverUrl) {
    resetSession();
    discoveryCache = null;
  }
});

// ---------------------------------------------------------------
// OAuth

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(length) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return base64Url(new Uint8Array(digest));
}

async function discover() {
  if (discoveryCache) return discoveryCache;
  const { serverUrl } = await getSettings();
  if (!serverUrl) throw new Error("URL server belum diatur. Isi alamat server Toolsmith di Pengaturan ekstensi.");
  const origin = new URL(serverUrl).origin;
  const response = await fetch(
    `${origin}/.well-known/oauth-authorization-server`,
  );
  if (!response.ok) {
    throw new Error(
      `Server tidak menyediakan OAuth (discovery HTTP ${response.status}). ` +
        "Gunakan token manual di Pengaturan.",
    );
  }
  discoveryCache = await response.json();
  return discoveryCache;
}

async function registerClient(discovery, redirectUri) {
  const existing = await getOAuth();
  if (existing && existing.clientId && existing.redirectUri === redirectUri) {
    return existing.clientId;
  }
  const response = await fetch(discovery.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Toolsmith Extension",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:tools",
    }),
  });
  if (!response.ok) {
    throw new Error(`Registrasi klien OAuth gagal (HTTP ${response.status})`);
  }
  const data = await response.json();
  await setOAuth({ clientId: data.client_id, redirectUri });
  return data.client_id;
}

async function storeTokenResponse(data, base) {
  await setOAuth({
    ...base,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || base.refreshToken || null,
    expiresAt: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : Date.now() + 3600 * 1000,
  });
}

async function connectOAuth() {
  const { serverUrl } = await getSettings();
  if (!serverUrl) throw new Error("URL server belum diatur. Isi alamat server Toolsmith di Pengaturan ekstensi.");
  const discovery = await discover();
  const redirectUri = chrome.identity.getRedirectURL("oauth");
  const clientId = await registerClient(discovery, redirectUri);

  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);
  const state = randomString(24);

  const authorizeUrl = new URL(discovery.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "mcp:tools");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", serverUrl);

  const redirect = await chrome.identity.launchWebAuthFlow({
    url: authorizeUrl.toString(),
    interactive: true,
  });
  if (!redirect) throw new Error("Alur login dibatalkan.");
  const callback = new URL(redirect);
  if (callback.searchParams.get("state") !== state) {
    throw new Error("State OAuth tidak cocok; login ditolak.");
  }
  const error = callback.searchParams.get("error");
  if (error) throw new Error(`Server menolak otorisasi: ${error}`);
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Server tidak mengembalikan kode otorisasi.");

  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: serverUrl,
    }),
  });
  if (!response.ok) {
    throw new Error(`Pertukaran token gagal (HTTP ${response.status})`);
  }
  const current = (await getOAuth()) || {};
  await storeTokenResponse(await response.json(), {
    ...current,
    clientId,
    redirectUri,
  });
  return { mode: "oauth" };
}

async function refreshOAuth(oauth) {
  const discovery = await discover();
  const { serverUrl } = await getSettings();
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: oauth.clientId,
      resource: serverUrl,
    }),
  });
  if (!response.ok) throw new Error("Refresh token ditolak server.");
  await storeTokenResponse(await response.json(), oauth);
  return (await getOAuth()).accessToken;
}


async function resolveMode() {
  const { authMethod } = await getSettings();
  if (authMethod === "oauth" || authMethod === "bearer") return authMethod;
  const oauth = await getOAuth();
  if (oauth && oauth.accessToken) return "oauth";
  const { token } = await getSettings();
  return token ? "bearer" : null;
}

// The bearer token for MCP calls, per the auth method the user
// picked in options: OAuth access token (refreshed silently when
// expired) or the manually pasted token.
async function currentBearer() {
  const mode = await resolveMode();
  if (mode === "oauth") {
    const oauth = await getOAuth();
    if (!oauth || !oauth.accessToken) return "";
    if (oauth.expiresAt && Date.now() < oauth.expiresAt - 60_000) {
      return oauth.accessToken;
    }
    if (oauth.refreshToken) {
      try {
        return await refreshOAuth(oauth);
      } catch {
        // Caller sees an auth failure; the user reconnects.
      }
    }
    return oauth.accessToken;
  }
  if (mode === "bearer") {
    const { token } = await getSettings();
    return token || "";
  }
  return "";
}
async function disconnect() {
  const mode = await resolveMode();
  if (mode === "oauth") {
    const oauth = await getOAuth();
    if (oauth && (oauth.accessToken || oauth.refreshToken)) {
      try {
        const discovery = await discover();
        await fetch(discovery.revocation_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: oauth.refreshToken || oauth.accessToken,
            client_id: oauth.clientId || "",
          }),
        });
      } catch {
        // Revocation is best-effort; local cleanup still proceeds.
      }
    }
    const current = (await getOAuth()) || {};
    await setOAuth(
      current.clientId
        ? { clientId: current.clientId, redirectUri: current.redirectUri }
        : null,
    );
  } else if (mode === "bearer") {
    await chrome.storage.local.set({ token: "" });
  }
  resetSession();
}

// ---------------------------------------------------------------
// MCP client

async function parseRpcResponse(response, requestId) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    let found = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg.id === requestId) found = msg;
      } catch {
        // Keep scanning; SSE streams can carry notifications too.
      }
    }
    return found;
  }
  return response.json();
}

async function rpc(method, params, { notification = false } = {}) {
  const { serverUrl } = await getSettings();
  if (!serverUrl) throw new Error("URL server belum diatur. Isi alamat server Toolsmith di Pengaturan ekstensi.");
  const id = notification ? undefined : ++rpcId;
  const body = { jsonrpc: "2.0", method, params };
  if (!notification) body.id = id;

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const bearer = await currentBearer();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (session.id) headers["Mcp-Session-Id"] = session.id;

  const response = await fetch(serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const newSession = response.headers.get("Mcp-Session-Id");
  if (newSession) session.id = newSession;

  if (notification) return null;
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const message = await parseRpcResponse(response, id);
  if (!message) throw new Error("Empty MCP response");
  if (message.error) {
    throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
  }
  return message.result;
}

async function ensureInitialized() {
  if (session.initialized) return session.serverInfo;
  const result = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "toolsmith-extension", version: "0.2.0" },
  });
  session.serverInfo = result;
  session.initialized = true;
  try {
    await rpc("notifications/initialized", {}, { notification: true });
  } catch {
    // Some servers do not accept the notification; harmless.
  }
  return result;
}

async function withSession(fn) {
  await ensureInitialized();
  try {
    return await fn();
  } catch (err) {
    if (/session|400|401/i.test(String(err && err.message))) {
      resetSession();
      await ensureInitialized();
      return fn();
    }
    throw err;
  }
}

function toolResultToText(result) {
  if (!result) return "";
  const parts = [];
  for (const item of result.content || []) {
    if (item.type === "text") parts.push(item.text);
    else parts.push(`[${item.type} content]`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------
// Message router

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "toolsmith:connect") {
        const result = await connectOAuth();
        const tools = await withSession(() => rpc("tools/list", {}));
        sendResponse({
          ok: true,
          mode: result.mode,
          serverInfo: session.serverInfo,
          toolCount: (tools.tools || []).length,
        });
      } else if (message.type === "toolsmith:disconnect") {
        await disconnect();
        sendResponse({ ok: true });
      } else if (message.type === "toolsmith:status") {
        const { serverUrl } = await getSettings();
        const mode = await resolveMode();
        if (!mode) {
          sendResponse({ ok: true, state: "disconnected", serverUrl });
          return;
        }
        try {
          const tools = await withSession(() => rpc("tools/list", {}));
          sendResponse({
            ok: true,
            state: "connected",
            mode,
            serverUrl,
            serverInfo: session.serverInfo,
            toolCount: (tools.tools || []).length,
          });
        } catch (err) {
          sendResponse({
            ok: true,
            state: "error",
            mode,
            serverUrl,
            error: String((err && err.message) || err),
          });
        }
      } else if (message.type === "toolsmith:listTools") {
        const tools = await withSession(() => rpc("tools/list", {}));
        sendResponse({ ok: true, tools: tools.tools || [] });
      } else if (message.type === "toolsmith:callTool") {
        const result = await withSession(() =>
          rpc("tools/call", {
            name: message.name,
            arguments: message.arguments || {},
          }),
        );
        sendResponse({
          ok: true,
          isError: Boolean(result && result.isError),
          text: toolResultToText(result),
        });
      } else {
        sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true; // Async response.
});
