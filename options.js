const urlEl = document.getElementById("serverUrl");
const tokenEl = document.getElementById("token");
const bearerBox = document.getElementById("bearerBox");
const saveBtn = document.getElementById("save");
const connectBtn = document.getElementById("connect");
const saveState = document.getElementById("saveState");
const resultEl = document.getElementById("result");
const setupCard = document.getElementById("setupCard");
const connectedCard = document.getElementById("connectedCard");

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || { ok: false, error: "Tidak ada respons" });
    });
  });
}

async function ensureHostPermission(serverUrl) {
  try {
    const parsedUrl = new URL(serverUrl);
    const origin = parsedUrl.protocol + "//" + parsedUrl.hostname + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) await chrome.permissions.request({ origins: [origin] });
  } catch {
    // Connection errors surface later with a clearer message.
  }
}

function chosenMethod() {
  const checked = document.querySelector("input[name='authMethod']:checked");
  return checked ? checked.value : "oauth";
}

let savedServerUrl = "";

function syncMethodUI() {
  const method = chosenMethod();
  bearerBox.hidden = method !== "bearer";
  saveBtn.hidden = method === "oauth";
  connectBtn.hidden = method !== "oauth";
}

document
  .querySelectorAll("input[name='authMethod']")
  .forEach((radio) => radio.addEventListener("change", syncMethodUI));

async function readSettings() {
  return chrome.storage.local.get({
    serverUrl: "",
    authMethod: "",
    token: "",
  });
}

async function showConnected(status) {
  setupCard.hidden = true;
  connectedCard.hidden = false;
  document.getElementById("connUrl").textContent = status.serverUrl;
  const info = status.serverInfo || {};
  document.getElementById("connMeta").textContent =
    `${info.serverInfo ? `${info.serverInfo.name} ${info.serverInfo.version}` : "Toolsmith"}` +
    ` - ${status.toolCount} tool - ${status.mode === "oauth" ? "OAuth" : "Bearer token"}`;
  await renderTools();
}

// Mirrors the auto-run set in content.js: read-only tools run
// automatically; everything else asks for approval first.
const READ_ONLY_TOOLS = new Set([
  "system_info", "hardware_info", "capabilities",
  "window_list", "window_active", "app_list", "screenshot",
  "fs_find", "fs_grep", "read", "find", "grep", "glob",
  "ast_grep", "tunnel_list", "tunnel_status", "wait",
]);

const PERM_VALUES = [
  ["auto", "Otomatis"],
  ["ask", "Tanya"],
  ["deny", "Tolak"],
];
// One level only: each tool carries its own permission. Without
// an explicit choice the built-in default applies - read tools
// Otomatis, write tools Tanya.
const DEFAULT_PERMISSIONS = { tools: {} };

async function loadPermissions() {
  const stored = await chrome.storage.local.get({
    toolPermissions: DEFAULT_PERMISSIONS,
  });
  return JSON.parse(
    JSON.stringify(stored.toolPermissions || DEFAULT_PERMISSIONS),
  );
}

async function savePermissions(perms) {
  await chrome.storage.local.set({ toolPermissions: perms });
}

function effectivePermission(perms, name) {
  if (perms.tools && perms.tools[name]) return perms.tools[name];
  return READ_ONLY_TOOLS.has(name) ? "auto" : "ask";
}

function segControl(current, onPick, small) {
  const wrap = document.createElement("div");
  wrap.className = "seg" + (small ? " small" : "");
  for (const [value, label] of PERM_VALUES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    if (current === value) btn.className = "active";
    btn.addEventListener("click", () => onPick(value));
    wrap.appendChild(btn);
  }
  return wrap;
}

async function renderTools() {
  const listEl = document.getElementById("toolList");
  listEl.innerHTML = "";
  const listed = await send({ type: "toolsmith:listTools" });
  if (!listed.ok) {
    listEl.textContent = "Gagal memuat tool: " + listed.error;
    return;
  }
  const perms = await loadPermissions();
  const groups = [
    {
      key: "read",
      title: "Read tools",
      tools: listed.tools.filter((t) => READ_ONLY_TOOLS.has(t.name)),
    },
    {
      key: "write",
      title: "Write tools",
      tools: listed.tools.filter((t) => !READ_ONLY_TOOLS.has(t.name)),
    },
  ];
  for (const group of groups) {
    if (!group.tools.length) continue;
    const head = document.createElement("div");
    head.className = "tgroup";
    head.textContent = group.title;
    listEl.appendChild(head);
    for (const tool of group.tools) {
      const row = document.createElement("div");
      row.className = "tool";
      const main = document.createElement("div");
      main.className = "tmain";
      const name = document.createElement("div");
      name.className = "tname";
      name.textContent = tool.name;
      const desc = document.createElement("div");
      desc.className = "tdesc";
      desc.textContent = (tool.description || "").split("\n")[0].slice(0, 110);
      main.append(name, desc);
      row.append(
        main,
        segControl(
          effectivePermission(perms, tool.name),
          async (value) => {
            (perms.tools ||= {})[tool.name] = value;
            await savePermissions(perms);
            renderTools();
          },
          true,
        ),
      );
      listEl.appendChild(row);
    }
  }
}

async function showSetup() {
  connectedCard.hidden = true;
  setupCard.hidden = false;
  const settings = await readSettings();
  urlEl.value = settings.serverUrl || "";
  tokenEl.value = settings.token || "";
  const method = settings.authMethod || "oauth";
  const radio = document.querySelector(
    `input[name='authMethod'][value='${method}']`,
  );
  if (radio) radio.checked = true;
  savedServerUrl = settings.serverUrl || "";
  syncMethodUI();
}

saveBtn.addEventListener("click", async () => {
  const method = chosenMethod();
  await chrome.storage.local.set({
    serverUrl: urlEl.value.trim(),
    authMethod: method,
    token: tokenEl.value.trim(),
  });
  await ensureHostPermission(urlEl.value.trim());
  savedServerUrl = urlEl.value.trim();
  syncMethodUI();
  if (method === "oauth") {
    saveState.textContent = "Tersimpan. Klik Connect dengan OAuth untuk login.";
    return;
  }
  saveState.textContent = "Tersimpan. Memeriksa koneksi...";
  const status = await send({ type: "toolsmith:status" });
  if (status.state === "connected") {
    await showConnected(status);
  } else {
    saveState.textContent =
      status.state === "error"
        ? `Belum terhubung: ${status.error}`
        : "Belum terhubung. Periksa URL dan token.";
  }
});

connectBtn.addEventListener("click", async () => {
  const serverUrl = urlEl.value.trim();
  if (!serverUrl) {
    resultEl.textContent = "Isi URL MCP Server dulu.";
    return;
  }
  await chrome.storage.local.set({ serverUrl, authMethod: "oauth" });
  await ensureHostPermission(serverUrl);
  connectBtn.disabled = true;
  resultEl.textContent = "Membuka halaman login Toolsmith...";
  const result = await send({ type: "toolsmith:connect" });
  connectBtn.disabled = false;
  if (!result.ok) {
    resultEl.textContent = `Gagal: ${result.error || "tidak dikenal"}`;
    return;
  }
  resultEl.textContent = "";
  const status = await send({ type: "toolsmith:status" });
  if (status.state === "connected") await showConnected(status);
});

document.getElementById("edit").addEventListener("click", showSetup);

document.getElementById("disconnect").addEventListener("click", async () => {
  await send({ type: "toolsmith:disconnect" });
  await showSetup();
  saveState.textContent = "Koneksi diputus.";
});

(async () => {
  const status = await send({ type: "toolsmith:status" });
  if (status.state === "connected") await showConnected(status);
  else await showSetup();
})();


// Settings tabs: Koneksi (setup/connected states) and Chat Aktif.
const tabBtnConnection = document.getElementById("tabBtnConnection");
const tabBtnChats = document.getElementById("tabBtnChats");
const tabConnection = document.getElementById("tabConnection");
const tabChats = document.getElementById("tabChats");

function showTab(which) {
  const chats = which === "chats";
  tabConnection.hidden = chats;
  tabChats.hidden = !chats;
  tabBtnConnection.classList.toggle("active", !chats);
  tabBtnChats.classList.toggle("active", chats);
}

tabBtnConnection.addEventListener("click", () => showTab("connection"));
tabBtnChats.addEventListener("click", () => showTab("chats"));

// Armed conversations (stored by the content script): list them,
// open them, or forget them - forgetting also disarms a chat that
// is currently open, via the storage change listener there.
const armedListEl = document.getElementById("armedList");
const armedEmptyEl = document.getElementById("armedEmpty");

async function renderArmedChats() {
  const data = await chrome.storage.local.get("armedChats");
  const entries = Object.entries(data.armedChats || {}).sort(
    (a, b) => (b[1].armedAt || 0) - (a[1].armedAt || 0),
  );
  armedListEl.innerHTML = "";
  armedEmptyEl.hidden = entries.length > 0;
  const badge = document.getElementById("armedCount");
  badge.hidden = entries.length === 0;
  badge.textContent = String(entries.length);
  for (const [path, rec] of entries) {
    const li = document.createElement("li");
    li.className = "armed-item";
    const main = document.createElement("div");
    main.className = "armed-main";
    const title = document.createElement("div");
    title.className = "armed-title";
    title.textContent = path.split("/").filter(Boolean).pop() || path;
    title.title = path;
    const sub = document.createElement("div");
    sub.className = "armed-sub";
    let host = rec.serverUrl || "";
    try { host = new URL(rec.serverUrl).host; } catch {}
    const when = rec.armedAt
      ? new Date(rec.armedAt).toLocaleDateString("id-ID", { day: "numeric", month: "short" })
      : "";
    sub.textContent = [host, when].filter(Boolean).join(" · ");
    main.append(title, sub);
    const openBtn = document.createElement("button");
    openBtn.className = "icon-btn";
    openBtn.textContent = "↗";
    openBtn.title = "Buka chat";
    openBtn.addEventListener("click", () =>
      chrome.tabs.create({ url: "https://gemini.google.com" + path }),
    );
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "×";
    delBtn.title = "Hapus - Toolsmith mati untuk chat ini";
    delBtn.addEventListener("click", async () => {
      const fresh = await chrome.storage.local.get("armedChats");
      const map = fresh.armedChats || {};
      delete map[path];
      await chrome.storage.local.set({ armedChats: map });
      renderArmedChats();
    });
    const approved = rec.approvedTools || [];
    if (approved.length) {
      const toolsDiv = document.createElement("div");
      toolsDiv.className = "armed-tools";
      const label = document.createElement("span");
      label.className = "armed-tools-label";
      label.textContent = "Disetujui sesi ini:";
      toolsDiv.appendChild(label);
      const updateRecord = async (fn) => {
        const fresh = await chrome.storage.local.get("armedChats");
        const map = fresh.armedChats || {};
        if (map[path]) {
          fn(map[path]);
          await chrome.storage.local.set({ armedChats: map });
        }
        renderArmedChats();
      };
      for (const name of approved) {
        const chip = document.createElement("span");
        chip.className = "tool-chip";
        const nm = document.createElement("span");
        nm.textContent = name;
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "×";
        x.title = "Cabut persetujuan sesi untuk " + name;
        x.addEventListener("click", () =>
          updateRecord((r) => {
            r.approvedTools = (r.approvedTools || []).filter(
              (t) => t !== name,
            );
          }),
        );
        chip.append(nm, x);
        toolsDiv.appendChild(chip);
      }
      if (approved.length > 1) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "armed-reset";
        reset.textContent = "Reset semua";
        reset.addEventListener("click", () =>
          updateRecord((r) => {
            r.approvedTools = [];
          }),
        );
        toolsDiv.appendChild(reset);
      }
      main.appendChild(toolsDiv);
    }
    li.append(main, openBtn, delBtn);
    armedListEl.appendChild(li);
  }
}

renderArmedChats();
