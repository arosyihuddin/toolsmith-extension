const dotEl = document.getElementById("dot");
const stateEl = document.getElementById("state");
const metaEl = document.getElementById("meta");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");

// Ask for access to the configured server's origin when it is
// not one of the hosts built into the manifest (the server URL
// is user-configurable in options).
async function ensureHostPermission(serverUrl) {
  try {
    const parsedUrl = new URL(serverUrl);
    const origin = parsedUrl.protocol + "//" + parsedUrl.hostname + "/*";
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) await chrome.permissions.request({ origins: [origin] });
  } catch {
    // Built-in hosts need no request; failures surface later as
    // connection errors with a clearer message.
  }
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || { ok: false, error: "Tidak ada respons" });
    });
  });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function render(status) {
  dotEl.className = "dot";
  if (status.state === "connected") {
    dotEl.classList.add("connected");
    stateEl.textContent = "Terhubung";
    const info = status.serverInfo || {};
    const server = info.serverInfo
      ? `${info.serverInfo.name} ${info.serverInfo.version}`
      : "Toolsmith";
    metaEl.innerHTML = "";
    const line1 = document.createElement("div");
    line1.className = "mono";
    line1.textContent = hostOf(status.serverUrl);
    const line2 = document.createElement("div");
    line2.textContent =
      `${server} - ${status.toolCount} tool - ` +
      (status.mode === "oauth" ? "OAuth" : "Bearer token");
    metaEl.append(line1, line2);
    connectBtn.hidden = true;
    disconnectBtn.hidden = false;
  } else if (status.state === "error") {
    dotEl.classList.add("error");
    stateEl.textContent = "Gagal terhubung";
    metaEl.textContent = status.error || "";
    connectBtn.hidden = false;
    connectBtn.textContent = "Coba lagi";
    disconnectBtn.hidden = false;
  } else {
    stateEl.textContent = "Belum terhubung";
    metaEl.textContent = "Klik Connect untuk menghubungkan.";
    connectBtn.hidden = false;
    connectBtn.textContent = "Connect";
    disconnectBtn.hidden = true;
  }
}

async function refresh() {
  const { serverUrl } = await chrome.storage.local.get({ serverUrl: "" });
  if (!serverUrl) {
    dotEl.className = "dot";
    stateEl.textContent = "URL server belum diatur";
    metaEl.textContent = "Isi alamat server Toolsmith milikmu di Pengaturan.";
    connectBtn.hidden = true;
    disconnectBtn.hidden = true;
    return;
  }
  render({ state: "busy" });
  dotEl.classList.add("busy");
  stateEl.textContent = "Memeriksa...";
  metaEl.textContent = "";
  render(await send({ type: "toolsmith:status" }));
}

connectBtn.addEventListener("click", async () => {
  const { serverUrl, authMethod } = await chrome.storage.local.get({
    serverUrl: "",
    authMethod: "",
  });
  if (!serverUrl) {
    chrome.runtime.openOptionsPage();
    return;
  }
  await ensureHostPermission(serverUrl);
  if (authMethod === "bearer") {
    await refresh();
    return;
  }
  connectBtn.disabled = true;
  dotEl.className = "dot busy";
  stateEl.textContent = "Membuka login...";
  metaEl.textContent = "Selesaikan otorisasi di jendela yang terbuka.";
  const result = await send({ type: "toolsmith:connect" });
  connectBtn.disabled = false;
  if (!result.ok) {
    dotEl.className = "dot error";
    stateEl.textContent = "Gagal terhubung";
    metaEl.textContent = result.error || "";
    connectBtn.textContent = "Coba lagi";
    return;
  }
  await refresh();
});

disconnectBtn.addEventListener("click", async () => {
  await send({ type: "toolsmith:disconnect" });
  await refresh();
});

document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

refresh();
