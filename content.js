// Toolsmith extension - Gemini content script.
//
// Injects a "Toolsmith" toggle button next to the Gemini composer.
// Toggling it on starts a tools session:
//   1. Fetch the live tool list from the Toolsmith MCP server
//      (via the background worker).
//   2. Send a setup message (the "system prompt") teaching the
//      model the tool-calling convention used by LLM function
//      calling: a fenced ```tool_call block with
//      {"name": ..., "arguments": {...}}.
//   3. Watch model responses; when one contains a tool call, run
//      it (with an approval card for tools that can change the
//      system) and type the result back as the next user message,
//      so the model continues with real data.
//
// NOTE: Gemini's DOM changes often. All selectors below have
// fallbacks, but they may need adjusting after a Gemini redesign.

const READ_ONLY_TOOLS = new Set([
  "system_info", "hardware_info", "capabilities",
  "window_list", "window_active", "app_list", "screenshot",
  "fs_find", "fs_grep", "read", "find", "grep", "glob",
  "ast_grep", "tunnel_list", "tunnel_status", "wait",
]);

const MAX_AUTO_ROUNDS = 5;
const RESULT_CHAR_CAP = 6000;

const state = {
  armed: false,
  busy: false,
  autoRounds: 0,
  lastProcessedText: "",
  injecting: false,
  button: null,
};

// ----------------------------------------------------------------
// Gemini DOM helpers (selectors verified against gemini.google.com
// as of late 2025; multiple fallbacks on purpose).

function findEditor() {
  return (
    document.querySelector("rich-textarea div[contenteditable='true']") ||
    document.querySelector("div.ql-editor[contenteditable='true']") ||
    document.querySelector("div[contenteditable='true'][role='textbox']") ||
    document.querySelector("div[contenteditable='true']")
  );
}

function findSendButton() {
  const byIcon = document.querySelector(
    "mat-icon[data-mat-icon-name='send']",
  );
  if (byIcon) {
    const button = byIcon.closest("button");
    if (button) return button;
  }
  return document.querySelector(
    "button[aria-label='Send message'], button[aria-label='Kirim pesan'], " +
      "button[aria-label*='Send message'], button[aria-label*='Kirim pesan']",
  );
}

function isGenerating() {
  return Boolean(
    document.querySelector(
      "button[aria-label='Stop response'], button[aria-label='Stop generating'], " +
        "button[aria-label='Berhenti merespons'], .stop-icon, mat-icon[data-mat-icon-name='stop']",
    ),
  );
}

function modelResponses() {
  return document.querySelectorAll(
    "model-response, .model-response, [data-response-index]",
  );
}

function lastModelResponseEl() {
  const all = modelResponses();
  return all.length ? all[all.length - 1] : null;
}

function lastModelResponseText() {
  const el = lastModelResponseEl();
  return el ? (el.innerText || "").trim() : "";
}

function setEditorText(text) {
  const editor = findEditor();
  if (!editor) return false;
  editor.focus();
  // Gemini's editor is a rich contenteditable (Quill-based);
  // execCommand('insertText') is what it understands best. Clear
  // first by selecting everything.
  document.execCommand("selectAll", false, null);
  const ok = document.execCommand("insertText", false, text);
  if (!ok || !editor.innerText.includes(text.slice(0, 24))) {
    editor.textContent = text;
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
    );
  }
  return true;
}

function sendCurrentEditor() {
  const button = findSendButton();
  if (button && !button.disabled) {
    button.click();
    return true;
  }
  const editor = findEditor();
  if (editor) {
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, bubbles: true,
      }),
    );
    return true;
  }
  return false;
}

async function injectUserMessage(text) {
  state.injecting = true;
  try {
    if (!setEditorText(text)) throw new Error("Composer not found");
    await sleep(250);
    if (!sendCurrentEditor()) throw new Error("Send button not found");
  } finally {
    // Give the page time to register the outgoing message before
    // the response watcher treats anything as user input.
    setTimeout(() => (state.injecting = false), 1500);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------------
// Background bridge

function bgMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: "No response" });
      }
    });
  });
}

// ----------------------------------------------------------------
// Setup ("system prompt")

function summarizeSchema(schema) {
  if (!schema || !schema.properties) return "{}";
  const required = new Set(schema.required || []);
  const parts = Object.entries(schema.properties).map(([key, def]) => {
    const type = (def && def.type) || "any";
    return `${key}${required.has(key) ? "" : "?"}: ${type}`;
  });
  return `{ ${parts.join(", ")} }`;
}

function buildSetupPrompt(tools) {
  const lines = tools.map(
    (t) =>
      `- ${t.name}: ${(t.description || "").split("\n")[0].slice(0, 140)} | arguments ${summarizeSchema(t.inputSchema)}`,
  );
  return [
    "[TOOLSMITH MODE]",
    "Kamu terhubung ke mesin pengguna melalui Toolsmith dan bisa memanggil tool untuk bekerja langsung di mesin tersebut. Mesinnya bisa berupa PC, laptop, server, atau perangkat lain yang menjalankan server Toolsmith.",
    "",
    "ATURAN:",
    "- Untuk memanggil tool, balas HANYA dengan satu blok seperti ini, tanpa teks lain:",
    "```tool_call",
    '{"name": "nama_tool", "arguments": {}}',
    "```",
    "- Satu panggilan per balasan. Setelah memanggil, kamu akan menerima pesan yang diawali [TOOL RESULT ...] berisi hasil ASLI dari mesin tersebut. Jangan pernah mengarang hasil tool.",
    "- Jika tidak butuh tool, jawab seperti biasa tanpa blok tersebut.",
    "- Balas pesan penyiapan ini hanya dengan kata: Siap.",
    "",
    "TOOL YANG TERSEDIA:",
    ...lines,
  ].join("\n");
}

// ----------------------------------------------------------------
// Tool-call parsing and execution

function asToolCall(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed.name === "string") {
      return {
        name: parsed.name,
        arguments:
          parsed.arguments && typeof parsed.arguments === "object"
            ? parsed.arguments
            : {},
      };
    }
  } catch {
    // Not this candidate.
  }
  return null;
}

function extractToolCall(text, el) {
  // Strategy 1: raw fenced block (model wrote it unrendered).
  const fenced = text.match(/```tool_call\s*([\s\S]*?)```/);
  if (fenced) {
    const call = asToolCall(fenced[1].trim());
    if (call) return call;
    return { parseError: fenced[1].trim().slice(0, 500) };
  }
  // Strategy 2: a rendered code block inside the response whose
  // content is the tool-call JSON.
  if (el) {
    for (const code of el.querySelectorAll("pre, code")) {
      const call = asToolCall((code.textContent || "").trim());
      if (call) return call;
    }
  }
  // Strategy 3: a bare JSON object in the text (inline rendering).
  const start = text.indexOf('{"name"');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          const call = asToolCall(text.slice(start, i + 1));
          if (call) return call;
          break;
        }
      }
    }
  }
  return null;
}

function askApproval(call) {
  return new Promise((resolve) => {
    const card = document.createElement("div");
    card.className = "toolsmith-approval";
    card.innerHTML = `
      <div class="toolsmith-approval-title">Toolsmith: jalankan tool ini?</div>
      <div class="toolsmith-approval-tool"></div>
      <pre class="toolsmith-approval-args"></pre>
      <div class="toolsmith-approval-actions">
        <button class="toolsmith-deny">Tolak</button>
        <button class="toolsmith-approve">Jalankan</button>
      </div>`;
    card.querySelector(".toolsmith-approval-tool").textContent = call.name;
    card.querySelector(".toolsmith-approval-args").textContent = JSON.stringify(
      call.arguments, null, 2,
    );
    card.querySelector(".toolsmith-approve").addEventListener("click", () => {
      card.remove();
      resolve(true);
    });
    card.querySelector(".toolsmith-deny").addEventListener("click", () => {
      card.remove();
      resolve(false);
    });
    document.body.appendChild(card);
  });
}

async function executeToolCall(call) {
  if (!READ_ONLY_TOOLS.has(call.name)) {
    const approved = await askApproval(call);
    if (!approved) {
      return { text: "Ditolak oleh pengguna.", isError: true };
    }
  }
  const response = await bgMessage({
    type: "toolsmith:callTool",
    name: call.name,
    arguments: call.arguments,
  });
  if (!response.ok) {
    return { text: `Error dari ekstensi: ${response.error}`, isError: true };
  }
  let text = response.text || "(tanpa keluaran)";
  if (text.length > RESULT_CHAR_CAP) {
    text = text.slice(0, RESULT_CHAR_CAP) + "\n...[dipotong]";
  }
  return { text, isError: response.isError };
}

async function handleModelResponse(text, el) {
  const call = extractToolCall(text, el);
  if (!call && /tool_call|"name"\s*:/.test(text)) {
    console.info("[toolsmith] response looked like a tool call but no valid call could be extracted");
    setButton("limit", "Toolsmith: format tidak terbaca");
    setTimeout(() => state.armed && setButton("on", "Toolsmith: On"), 4000);
  }
  if (!call) return;
  if (state.autoRounds >= MAX_AUTO_ROUNDS) {
    setButton("limit", "Toolsmith: batas putaran");
    return;
  }
  state.autoRounds += 1;
  state.busy = true;
  try {
    let header;
    let body;
    if (call.parseError) {
      header = "[TOOL RESULT error]";
      body = "Blok tool_call tidak valid JSON. Perbaiki formatnya dan coba lagi.";
    } else {
      setButton("busy", `Toolsmith: ${call.name}...`);
      const result = await executeToolCall(call);
      header = `[TOOL RESULT ${call.name}${result.isError ? " - error" : ""}]`;
      body = result.text;
    }
    await injectUserMessage(`${header}\n${body}\n\nLanjutkan.`);
  } finally {
    state.busy = false;
    if (state.armed) setButton("on", "Toolsmith: On");
  }
}

// ----------------------------------------------------------------
// Response watcher

function watchResponses() {
  setInterval(async () => {
    if (!state.armed || state.busy || state.injecting) return;
    if (isGenerating()) return;
    const text = lastModelResponseText();
    if (!text || text === state.lastProcessedText) return;
    // Give streaming a beat to fully settle.
    await sleep(600);
    if (isGenerating()) return;
    const settled = lastModelResponseText();
    if (settled !== text) return;
    state.lastProcessedText = settled;
    await handleModelResponse(settled, lastModelResponseEl());
  }, 900);
}

// A manual user message resets the auto-loop budget.
function watchUserMessages() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node.matches && node.matches("user-query, .user-query")
          ? node
          : node.querySelector && node.querySelector("user-query, .user-query");
        if (el && !state.injecting) state.autoRounds = 0;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ----------------------------------------------------------------
// Toggle button

function setButton(mode, label) {
  if (!state.button) return;
  state.button.dataset.mode = mode;
  state.button.textContent = label;
}

async function toggleToolsmith() {
  if (state.armed) {
    state.armed = false;
    setButton("off", "Toolsmith: Off");
    return;
  }
  setButton("arming", "Toolsmith: menghubungkan...");
  const listed = await bgMessage({ type: "toolsmith:listTools" });
  if (!listed.ok) {
    setButton("off", "Toolsmith: gagal");
    alert(`Toolsmith: tidak bisa terhubung ke server MCP.\n${listed.error}\n\nPeriksa URL dan token di opsi ekstensi.`);
    return;
  }
  try {
    await injectUserMessage(buildSetupPrompt(listed.tools));
  } catch (err) {
    setButton("off", "Toolsmith: gagal");
    alert(`Toolsmith: tidak menemukan kotak pesan Gemini.\n${err.message}`);
    return;
  }
  state.armed = true;
  state.autoRounds = 0;
  state.lastProcessedText = "";
  setButton("on", "Toolsmith: On");
}

function createToggleButton() {
  const button = document.createElement("button");
  button.className = "toolsmith-toggle";
  button.type = "button";
  button.dataset.mode = state.armed ? "on" : "off";
  button.textContent = state.armed ? "Toolsmith: On" : "Toolsmith: Off";
  button.addEventListener("click", toggleToolsmith);
  return button;
}

function mountButton() {
  if (state.button && document.contains(state.button)) return;
  const menu = document.querySelector(
    ".simplified-input-menu-container",
  );
  if (menu) {
    const button = createToggleButton();
    button.classList.add("toolsmith-toggle-inline");
    const anchor = menu.querySelector("span");
    if (anchor && anchor.parentElement === menu) {
      anchor.after(button);
    } else {
      menu.appendChild(button);
    }
    state.button = button;
    return;
  }
  const editor = findEditor();
  if (!editor) return;
  // Fallback: a small bar above the composer wrapper.
  let host = editor;
  for (let i = 0; i < 5 && host.parentElement; i++) host = host.parentElement;
  const bar = document.createElement("div");
  bar.className = "toolsmith-bar";
  const button = createToggleButton();
  bar.appendChild(button);
  host.parentElement.insertBefore(bar, host);
  state.button = button;
}

function boot() {
  mountButton();
  setInterval(mountButton, 2000); // Gemini re-renders; re-mount if lost.
  watchResponses();
  watchUserMessages();
  watchNavigation();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
