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

async function renderTools() {
  const listEl = document.getElementById("toolList");
  listEl.innerHTML = "";
  const listed = await send({ type: "toolsmith:listTools" });
  if (!listed.ok) {
    listEl.textContent = "Gagal memuat tool: " + listed.error;
    return;
  }
  const groups = [
    { title: "Hanya baca — jalan otomatis", tools: listed.tools.filter((t) => READ_ONLY_TOOLS.has(t.name)) },
    { title: "Bisa mengubah — minta persetujuan dulu", tools: listed.tools.filter((t) => !READ_ONLY_TOOLS.has(t.name)) },
  ];
  for (const group of groups) {
    if (!group.tools.length) continue;
    const heading = document.createElement("div");
    heading.className = "tgroup";
    heading.textContent = group.title;
    listEl.appendChild(heading);
    for (const tool of group.tools) {
      const row = document.createElement("div");
      row.className = "tool";
      const name = document.createElement("div");
      name.className = "tname";
      name.textContent = tool.name;
      const desc = document.createElement("div");
      desc.className = "tdesc";
      desc.textContent = (tool.description || "").split("\n")[0].slice(0, 110);
      row.append(name, desc);
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
