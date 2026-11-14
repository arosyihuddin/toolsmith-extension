// Toolsmith extension - chat content script (Gemini + Meta AI).
//
// Injects a "Toolsmith" toggle button next to the chat composer.
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

const RESULT_CHAR_CAP = 6000;

const state = {
  armed: false,
  busy: false,
  autoRounds: 0,
  lastProcessedText: "",
  injecting: false,
  button: null,
  baselinePending: false,
  pendingArmAdoption: false,
};

// ----------------------------------------------------------------
// Site adapters. Everything site-specific - how to find the
// composer, the send button and the responses, and where the
// toggle lives - sits behind the SITE object; the rest of this
// file (setup prompt, tool-call parsing, permissions, arming) is
// shared machinery.
//
// Gemini: Quill contenteditable composer, <model-response> items.
// Meta AI: logged-in composer is a <textarea
// data-testid="composer-input"> (with a contenteditable twin);
// logged-out it is a plain <input>. Responses are
// [data-testid="assistant-message"].
// Ptero: <textarea id="chat-input">, .chat-msg.assistant items;
// an SPA, so conversations key on the generated title, not URL.
// Because the Meta editor is an <input>, its value is set through
// the native value setter (React-style controlled input), and
// newlines in injected text are flattened by the element itself.

function climb(el, pred, max) {
  let node = el;
  for (let i = 0; node && i < (max || 8); i++) {
    if (pred(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function isComposerCard(el) {
  return String((el && el.className) || "").includes("rounded-32");
}

const SITES = {
  gemini: {
    id: "gemini",
    label: "Gemini",
    settleMs: 600,
    userSelector: "user-query, .user-query",
    navKey() {
      return location.pathname;
    },
    conversationKey() {
      return location.host + location.pathname;
    },
    findEditor() {
      return (
        document.querySelector("rich-textarea div[contenteditable='true']") ||
        document.querySelector("div.ql-editor[contenteditable='true']") ||
        document.querySelector("div[contenteditable='true'][role='textbox']") ||
        document.querySelector("div[contenteditable='true']")
      );
    },
    findSendButton() {
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
    },
    isGenerating() {
      return Boolean(
        document.querySelector(
          "button[aria-label='Stop response'], button[aria-label='Stop generating'], " +
            "button[aria-label='Berhenti merespons'], .stop-icon, mat-icon[data-mat-icon-name='stop']",
        ),
      );
    },
    responseEls() {
      return document.querySelectorAll(
        "model-response, .model-response, [data-response-index]",
      );
    },
    mountToggle(createButton) {
      const menu = document.querySelector(
        ".simplified-input-menu-container",
      );
      if (!menu) return false;
      const button = createButton();
      button.classList.add("toolsmith-toggle-inline");
      const anchor = menu.querySelector("span");
      if (anchor && anchor.parentElement === menu) {
        anchor.after(button);
      } else {
        menu.appendChild(button);
      }
      state.button = button;
      return true;
    },
    fallbackHost(editor) {
      let host = editor;
      for (let i = 0; i < 5 && host.parentElement; i++) host = host.parentElement;
      return host;
    },
  },
  metaai: {
    id: "metaai",
    label: "Meta AI",
    settleMs: 1600,
    userSelector: "[class*='bg-accent-surface']",
    navKey() {
      return location.pathname;
    },
    conversationKey() {
      return location.host + location.pathname;
    },
    findEditor() {
      // Logged-in composer: a <textarea data-testid="composer-input">
      // with a contenteditable twin carrying the same testid -
      // prefer whichever is actually visible, textarea first.
      const visible = (el) =>
        el && el.getClientRects && el.getClientRects().length > 0;
      const tagged = [
        ...document.querySelectorAll("[data-testid='composer-input']"),
      ].filter(visible);
      const editor =
        tagged.find((el) => el.tagName === "TEXTAREA") || tagged[0];
      if (editor) return editor;
      // Logged-out composer: a plain text <input>. Only text-like
      // inputs count - the composer card also holds the hidden
      // attachment <input type="file">, and setting its value
      // throws.
      const usable = (input) =>
        input &&
        !["file", "hidden", "checkbox", "radio", "submit", "button"].includes(
          (input.getAttribute("type") || "text").toLowerCase(),
        );
      const byLabel = document.querySelector(
        "input[aria-label='Tanya Meta AI'], input[aria-label='Ask Meta AI']",
      );
      if (usable(byLabel)) return byLabel;
      const inSlot = document.querySelector(
        "[data-slot*='composer-input'] input",
      );
      if (usable(inSlot)) return inSlot;
      const byPlaceholder = document.querySelector(
        "input[placeholder*='Meta AI'], input[placeholder*='tindak lanjut'], " +
          "input[placeholder*='follow-up']",
      );
      if (usable(byPlaceholder)) return byPlaceholder;
      const send = this.findSendButton();
      const card = send && climb(send, isComposerCard);
      if (card) {
        const input = [...card.querySelectorAll("input")].find(usable);
        if (input) return input;
      }
      return null;
    },
    findSendButton() {
      return (
        document.querySelector("[data-testid='composer-send-button']") ||
        document.querySelector(
          "button[aria-label='Kirim'], button[aria-label='Send']",
        )
      );
    },
    isGenerating() {
      // No verified stop-button signal on this site yet; look for
      // one inside the composer card only (a page-wide "Batal" also
      // exists in unrelated menus). The watcher's longer settle
      // time is the main streaming guard here.
      const editor = this.findEditor();
      const card = editor && climb(editor, isComposerCard);
      if (!card) return false;
      return Boolean(
        card.querySelector(
          "button[aria-label='Batal'], button[aria-label='Berhenti'], " +
            "button[aria-label='Stop'], button[aria-label='Stop generating']",
        ),
      );
    },
    responseEls() {
      return document.querySelectorAll("[data-testid='assistant-message']");
    },
    mountToggle(createButton) {
      // Beside the "+" (attachment) button, like on Gemini. The
      // button may be wrapped in single-child divs; climb to the
      // wrapper that sits directly in the toolbar row and insert
      // right after it.
      const attach = document.querySelector(
        "[data-testid='composer-add-attachment-button']",
      );
      if (attach) {
        let anchor = attach;
        while (
          anchor.parentElement &&
          anchor.parentElement.children.length === 1
        ) {
          anchor = anchor.parentElement;
        }
        const button = createButton();
        button.classList.add("toolsmith-toggle-inline");
        anchor.after(button);
        state.button = button;
        return true;
      }
      const send = this.findSendButton();
      const row =
        send && send.parentElement && send.parentElement.parentElement;
      if (!row || row.tagName !== "DIV") return false;
      const button = createButton();
      button.classList.add("toolsmith-toggle-inline");
      row.appendChild(button);
      state.button = button;
      return true;
    },
    fallbackHost(editor) {
      return climb(editor, isComposerCard) || editor;
    },
  },
  ptero: {
    id: "ptero",
    label: "Ptero",
    settleMs: 1200,
    userSelector: ".chat-msg.user",
    navKey() {
      return document.title;
    },
    conversationKey() {
      // Ptero is an SPA: the URL never changes, conversations are
      // identified by their generated title ("<title> | Ptero ...").
      const match = document.title.match(/^(.*?)\s*\|\s*Ptero/);
      const title = match ? match[1].trim() : "";
      if (!title) return location.host + "/";
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return location.host + "/t/" + (slug || "chat");
    },
    findEditor() {
      return (
        document.querySelector("#chat-input") ||
        document.querySelector("textarea.chat-input")
      );
    },
    findSendButton() {
      return (
        document.querySelector("#chat-send-btn") ||
        document.querySelector("button.chat-send-btn")
      );
    },
    isGenerating() {
      // The send button keeps its id while generating; it gains
      // an is-stop class and a "Stop generating" title instead.
      // (Never key on a "thinking" class: every finished message
      // keeps a collapsed .chat-thinking trace in the DOM, which
      // would read as generating forever.)
      const send = document.querySelector(
        "#chat-send-btn, button.chat-send-btn",
      );
      if (!send) return true;
      return (
        send.classList.contains("is-stop") ||
        /stop/i.test(
          (send.getAttribute("title") || "") +
            " " +
            (send.getAttribute("aria-label") || ""),
        )
      );
    },
    responseEls() {
      const msgs = document.querySelectorAll(
        "#chat-messages .chat-msg.assistant",
      );
      // The whole content container, NOT .chat-msg-text: a reply
      // that is only a code block renders the block as a sibling
      // of the (then empty) text element, and reading the text
      // element alone sees an empty response.
      return [...msgs].map(
        (m) =>
          m.querySelector(".chat-msg-content") ||
          m.querySelector(".chat-msg-text") ||
          m,
      );
    },
    mountToggle(createButton) {
      // Ahmad wants the toggle beside the speaker (voice mode)
      // button. Ptero docks that button cluster over the input
      // area's bottom-right corner (an absolute/relative mix),
      // where an in-flow toggle gets crushed to ~30px and
      // painted over - so dock the toggle absolutely too, just
      // left of the voice button (see .toolsmith-ptero-docked).
      const area = document.querySelector("#chat-input-area");
      if (!area) return false;
      if (area.querySelector("#chat-voice-mode-btn")) {
        const button = createButton();
        button.classList.add(
          "toolsmith-toggle-inline",
          "toolsmith-ptero-docked",
        );
        area.appendChild(button);
        state.button = button;
        return true;
      }
      const anchor =
        area.querySelector("#chat-mic-btn") ||
        area.querySelector("button[aria-haspopup]") ||
        [...area.querySelectorAll("button")].find(
          (b) => b.id !== "chat-send-btn",
        );
      if (!anchor) return false;
      let host = anchor;
      while (
        host.parentElement &&
        host.parentElement !== area &&
        host.parentElement.children.length === 1
      ) {
        host = host.parentElement;
      }
      const button = createButton();
      button.classList.add("toolsmith-toggle-inline");
      host.after(button);
      state.button = button;
      return true;
    },
    fallbackHost(editor) {
      return (
        climb(editor, (n) =>
          String((n && n.className) || "").includes("chat-input-wrap"),
        ) || editor
      );
    },
  },
};

const SITE = location.hostname.includes("meta.ai")
  ? SITES.metaai
  : location.hostname.includes("ptero.pro")
    ? SITES.ptero
    : SITES.gemini;

// ----------------------------------------------------------------
// Shared DOM helpers (delegating to the active site adapter).

function findEditor() {
  return SITE.findEditor();
}

function findSendButton() {
  return SITE.findSendButton();
}

function isGenerating() {
  return SITE.isGenerating();
}

function modelResponses() {
  return SITE.responseEls();
}

function lastModelResponseEl() {
  const all = modelResponses();
  return all.length ? all[all.length - 1] : null;
}

function lastModelResponseText() {
  const el = lastModelResponseEl();
  return el ? (el.innerText || "").trim() : "";
}

function editorText(editor) {
  if (!editor) return "";
  if (
    editor instanceof HTMLInputElement ||
    editor instanceof HTMLTextAreaElement
  ) {
    return editor.value || "";
  }
  return editor.innerText || "";
}

// React-style controlled inputs ignore direct .value writes; go
// through the prototype setter and notify with an input event.
function setNativeValue(input, text) {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(input, text);
  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text,
    }),
  );
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setEditorText(text) {
  const editor = findEditor();
  if (!editor) return false;
  editor.focus();
  if (
    editor instanceof HTMLInputElement ||
    editor instanceof HTMLTextAreaElement
  ) {
    if (editor instanceof HTMLInputElement) {
      const type = (editor.getAttribute("type") || "text").toLowerCase();
      if (type === "file" || type === "hidden") return false;
    }
    setNativeValue(editor, text);
    return true;
  }
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

// ----------------------------------------------------------------
// Per-message mode anchor. As a conversation grows, Gemini drifts
// out of Toolsmith mode and starts claiming it is inactive - so
// while armed, every outgoing user message gets a short
// [TOOLSMITH MODE] reminder appended just before it is sent, and
// tool results carry the tag too.

const MODE_TAG = "[TOOLSMITH MODE]";
const MODE_REMINDER =
  "\n\n" + MODE_TAG + ' Mode Toolsmith AKTIF di sesi ini. Jika perlu memakai tool, balas HANYA dengan blok ```tool_call {"name": "...", "arguments": {...}} ``` (satu panggilan per balasan), lalu tunggu hasilnya. Jangan pernah menyatakan mode ini tidak aktif.';

function appendToEditor(suffix) {
  const editor = findEditor();
  if (!editor) return false;
  editor.focus();
  if (
    editor instanceof HTMLInputElement ||
    editor instanceof HTMLTextAreaElement
  ) {
    setNativeValue(editor, editorText(editor) + suffix);
    try {
      editor.setSelectionRange(editor.value.length, editor.value.length);
    } catch {}
    return editorText(editor).includes(MODE_TAG);
  }
  const selection = window.getSelection();
  if (selection) {
    selection.selectAllChildren(editor);
    selection.collapseToEnd();
  }
  const ok = document.execCommand("insertText", false, suffix);
  if (!ok || !editor.innerText.includes(MODE_TAG)) {
    editor.textContent = (editor.innerText || "") + suffix;
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: suffix }),
    );
  }
  return true;
}

function maybeAppendReminder() {
  if (!state.armed || state.injecting) return;
  const editor = findEditor();
  if (!editor) return;
  const text = editorText(editor).trim();
  if (!text || text.includes(MODE_TAG)) return;
  appendToEditor(MODE_REMINDER);
}


function watchOutgoingMessages() {
  // A manual send refills the auto-round budget. Hooking the send
  // action itself works on every site, unlike watching for
  // user-message bubbles, whose markup differs per site (on
  // Meta AI's logged-in UI the bubble observer never fires, so
  // the budget never refilled there and the loop stalled after
  // 5 rounds).
  const noteManualSend = () => {
    if (!state.injecting) state.autoRounds = 0;
  };
  document.addEventListener(
    "click",
    (event) => {
      const button = findSendButton();
      if (button && (event.target === button || button.contains(event.target))) {
        noteManualSend();
        maybeAppendReminder();
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const editor = findEditor();
      if (editor && (event.target === editor || editor.contains(event.target))) {
        noteManualSend();
        maybeAppendReminder();
      }
    },
    true,
  );
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
    "Cara kerjanya: blok JSON yang kamu tulis dibaca oleh program jembatan (ekstensi browser) di perangkat pengguna, diteruskan ke server Toolsmith sungguhan, dan hasil eksekusi aslinya ditempel kembali ke chat ini sebagai pesan pengguna berawalan [TOOL RESULT ...]. Kamu tidak mengeksekusi apa pun sendiri dan tidak sedang diminta berpura-pura memiliki tool bawaan platform ini - kamu hanya menulis blok permintaannya, seperti menulis perintah untuk dijalankan pihak lain.",
    "Tool dalam daftar di bawah memang tidak terekspos sebagai tool bawaan chat ini; jalur blok teks inilah cara memanggilnya. Jika ragu, buktikan saja: panggil system_info dan hasil asli dari mesin pengguna akan kembali sebagai pesan berikutnya.",
    "",
    "ATURAN:",
    "- Untuk memanggil tool, balas HANYA dengan satu blok seperti ini, tanpa teks lain:",
    "```tool_call",
    '{"name": "nama_tool", "arguments": {}}',
    "```",
    "- Satu panggilan per balasan. Setelah memanggil, kamu akan menerima pesan yang diawali [TOOL RESULT ...] berisi hasil ASLI dari mesin tersebut. Jangan pernah mengarang hasil tool.",
    "- Jika tidak butuh tool, jawab seperti biasa tanpa blok tersebut.",
    "- Di dalam nilai string JSON, hindari tanda kutip ganda mentah (misalnya string \"\"\"...\"\"\" di Python atau atribut HTML berkutip ganda di dalam skrip); pakai kutip tunggal di dalam skrip agar JSON-nya tetap valid.",
    "- Balas pesan penyiapan ini hanya dengan kata: Siap.",
    "",
    "TOOL YANG TERSEDIA:",
    ...lines,
  ].join("\n");
}

// ----------------------------------------------------------------
// Tool-call parsing and execution

// Models often emit file-writing tool calls whose string values
// contain literal line breaks (a heredoc body, say) instead of the
// \n escapes strict JSON requires, so JSON.parse rejects the whole
// block. Repair pass: escape control characters that appear inside
// string literals; everything else stays byte-identical.
function repairJsonControlChars(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      out += ch;
      inString = false;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch < " ") {
      out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

// Models also emit invalid JSON escapes inside string values
// (a regex \d, a Windows path, a stray backslash in a heredoc
// script). Doubling a backslash that does not start a valid
// escape keeps the literal text the model meant. String-aware,
// like the control-char pass; only runs after both plainer
// parses have failed.
function repairInvalidEscapes(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1] || "";
      if ('"\\/bfnrtu'.includes(next)) {
        out += ch;
        escaped = true;
      } else {
        out += "\\\\";
      }
      continue;
    }
    out += ch;
    if (ch === '"') inString = false;
  }
  return out;
}

function parseToolCallJson(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(repairJsonControlChars(candidate));
    } catch {
      try {
        return JSON.parse(
          repairInvalidEscapes(repairJsonControlChars(candidate)),
        );
      } catch {
        return null;
      }
    }
  }
}

function asToolCall(candidate) {
  const parsed = parseToolCallJson(candidate);
  if (parsed && typeof parsed.name === "string") {
    return {
      name: parsed.name,
      arguments:
        parsed.arguments && typeof parsed.arguments === "object"
          ? parsed.arguments
          : {},
    };
  }
  return null;
}

// Try a whole text as a tool call, then the widest {...} span in
// it - the span fallback strips a stuck-on language label or
// prose around the JSON.
function asToolCallIn(text) {
  const direct = asToolCall((text || "").trim());
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return asToolCall(text.slice(start, end + 1));
  }
  return null;
}

// Last-resort recovery for calls whose string values contain
// raw double quotes - Python triple-quoted strings inside a
// bash heredoc are the classic case, and they defeat every
// JSON pass because the string appears to end early. The call
// shape is known, so rebuild it directly: a string value ends
// at the first quote whose continuation is structural (a
// following "key": property, or the closing braces at the
// very end of the text).
function recoverToolCall(text) {
  const nameMatch = text.match(/"name"\s*:\s*"([A-Za-z0-9_.-]+)"/);
  if (!nameMatch) return null;
  const argsKeyIdx = text.indexOf('"arguments"', nameMatch.index);
  if (argsKeyIdx < 0) return null;
  const argsStart = text.indexOf("{", argsKeyIdx);
  if (argsStart < 0) return null;
  const args = {};
  let i = argsStart + 1;
  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  while (i < text.length) {
    skipWs();
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] === "}") {
      const rest = text.slice(i + 1).trim();
      if (rest === "" || rest === "}") {
        return { name: nameMatch[1], arguments: args };
      }
      return null;
    }
    const keyMatch = text.slice(i).match(/^"([^"]+)"\s*:\s*/);
    if (!keyMatch) return null;
    const key = keyMatch[1];
    i += keyMatch[0].length;
    if (text[i] === '"') {
      let end = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] !== '"') continue;
        const after = text.slice(j + 1);
        if (
          /^\s*,\s*"[A-Za-z0-9_.-]+"\s*:/.test(after) ||
          /^\s*\}\s*\}\s*$/.test(after) ||
          /^\s*\}\s*$/.test(after)
        ) {
          end = j;
          break;
        }
      }
      if (end < 0) return null;
      args[key] = text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    // Non-string value: take a balanced slice and let the
    // normal parser judge it.
    let depth = 0;
    let j = i;
    let inStr = false;
    let esc = false;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
    }
    const rawValue = text.slice(i, j).trim();
    const parsed = parseToolCallJson(rawValue);
    if (parsed === null && rawValue !== "null") return null;
    args[key] = parsed;
    i = j;
  }
  return null;
}

function extractToolCall(text, el) {
  // Strategy 1: raw fenced block (model wrote it unrendered).
  const fenced = text.match(/```tool_call\s*([\s\S]*?)```/);
  if (fenced) {
    const call = asToolCallIn(fenced[1]);
    if (call) return call;
    return { parseError: fenced[1].trim().slice(0, 500) };
  }
  // Strategy 2: a rendered code block inside the response whose
  // content is the tool-call JSON.
  if (el) {
    const blocks = [...el.querySelectorAll("pre, code")];
    for (const code of blocks) {
      const call = asToolCallIn(code.textContent || "");
      if (call) return call;
    }
    // Some renderers (Ptero) keep the block's exact source in a
    // copy button's data-clipboard attribute, URL-encoded - the
    // most faithful copy of what the model wrote.
    for (const holder of el.querySelectorAll("[data-clipboard]")) {
      let decoded = "";
      try {
        decoded = decodeURIComponent(
          holder.getAttribute("data-clipboard") || "",
        );
      } catch {
        decoded = "";
      }
      const call = decoded && asToolCallIn(decoded);
      if (call) return call;
    }
    // A long code box may be split into several elements; try
    // their concatenation, then the whole response text.
    if (blocks.length > 1) {
      const joined = blocks.map((b) => b.textContent || "").join("");
      const call = asToolCallIn(joined);
      if (call) return call;
    }
    const fromText = asToolCallIn(text);
    if (fromText) return fromText;
  }
  // Strategy 3: a bare JSON object in the text (inline rendering),
  // scanned with string awareness so braces inside string values
  // do not corrupt the object boundary. Every "name" occurrence is
  // tried, not just the first - prose can carry a decoy example.
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const nameIdx = text.indexOf('"name"', searchFrom);
    if (nameIdx < 0) break;
    const start = text.lastIndexOf("{", nameIdx);
    if (start < 0 || text.slice(start + 1, nameIdx).trim() !== "") {
      searchFrom = nameIdx + 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    const call = asToolCall(text.slice(start, end + 1));
    if (call) return call;
    searchFrom = nameIdx + 1;
  }
  // Strategy 4: shape recovery (see recoverToolCall) on the
  // code blocks, then on the whole response text.
  if (el) {
    for (const code of el.querySelectorAll("pre, code")) {
      const recovered = recoverToolCall(code.textContent || "");
      if (recovered) return recovered;
    }
  }
  const recoveredText = recoverToolCall(text);
  if (recoveredText) return recoveredText;
  // The response clearly meant to be a call - a code block
  // carries a "name" payload, or the rendered fence label
  // survived - but nothing parsed. Report a parseError so the
  // model gets the format complaint and re-emits a cleaner
  // call, instead of the loop stalling silently.
  if (el) {
    for (const code of el.querySelectorAll("pre, code")) {
      const content = code.textContent || "";
      if (content.includes('"name"')) {
        return { parseError: content.trim().slice(0, 500) };
      }
    }
  }
  if (text.trimStart().startsWith("tool_call") && text.includes('"name"')) {
    return { parseError: text.trim().slice(0, 500) };
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
        <button class="toolsmith-session">Setujui sesi ini</button>
        <button class="toolsmith-approve">Jalankan</button>
      </div>`;
    card.querySelector(".toolsmith-approval-tool").textContent = call.name;
    card.querySelector(".toolsmith-approval-args").textContent = JSON.stringify(
      call.arguments, null, 2,
    );
    card.querySelector(".toolsmith-approve").addEventListener("click", () => {
      card.remove();
      resolve("once");
    });
    card.querySelector(".toolsmith-session").addEventListener("click", () => {
      card.remove();
      resolve("session");
    });
    card.querySelector(".toolsmith-deny").addEventListener("click", () => {
      card.remove();
      resolve("deny");
    });
    document.body.appendChild(card);
  });
}

async function executeToolCall(call) {
  const perms = await loadPermissions();
  const permission = effectivePermission(perms, call.name);
  if (permission === "deny") {
    return {
      text: `Tool ${call.name} ditolak oleh pengaturan izin ekstensi.`,
      isError: true,
    };
  }
  if (permission === "ask") {
    const record = await readArmRecord();
    const sessionApproved =
      record && (record.approvedTools || []).includes(call.name);
    if (!sessionApproved) {
      const decision = await askApproval(call);
      if (decision === "deny") {
        return { text: "Ditolak oleh pengguna.", isError: true };
      }
      if (decision === "session") {
        await rememberToolApproval(call.name);
      }
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
    const nameIdx = text.indexOf('"name"');
    console.info("[toolsmith] extraction failed", {
      textLen: text.length,
      codeBlocks: el
        ? [...el.querySelectorAll("pre, code")].map(
            (b) => (b.textContent || "").length,
          )
        : [],
      nameAt: nameIdx,
      around:
        nameIdx >= 0
          ? text.slice(Math.max(0, nameIdx - 60), nameIdx + 140)
          : "",
      head: text.slice(0, 120),
    });
    setButton("limit", "Toolsmith: format tidak terbaca");
    setTimeout(() => state.armed && setButton("on", "Toolsmith: On"), 4000);
  }
  if (!call) return;
  // No round cap (Ahmad's decision, 2026-11-14): the chain
  // runs until the model stops by itself or the user disarms.
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
    await injectUserMessage(`${header}\n${body}\n\nLanjutkan. ${MODE_TAG} masih aktif: jika perlu tool lagi, balas hanya dengan blok tool_call berikutnya; jika tugas selesai, jawab normal.`);
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
    // A code block's header can render before its body (Meta AI
    // shows the bare "tool_call" label first); wait for the rest
    // instead of processing - and marking - a stub.
    if (text.trim() === "tool_call") return;
    if (state.baselinePending) {
      state.lastProcessedText = text;
      state.baselinePending = false;
      return;
    }
    // Give streaming a beat to fully settle.
    await sleep(SITE.settleMs);
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
        const el = node.matches && node.matches(SITE.userSelector)
          ? node
          : node.querySelector && node.querySelector(SITE.userSelector);
        if (el && !state.injecting) state.autoRounds = 0;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ----------------------------------------------------------------
// Per-conversation arm persistence
//
// Gemini keeps the conversation - including the setup prompt - on
// its side, so reloading the page must restore the armed state for
// THIS conversation without sending the setup prompt again. The
// flag lives in chrome.storage.local keyed by conversation path
// and records the server the conversation was armed against.

const ARM_STORE_KEY = "armedChats";

function conversationKey() {
  return SITE.conversationKey();
}

// A real conversation has its own path (/app/<id> on Gemini,
// /prompt/<id> on Meta AI; Ptero uses a title slug). The bare new-chat path (/app, /) is
// shared by every future new chat, so an arm record keyed by it
// leaks "On" into all of them - records only ever belong to real
// conversation paths. Keys carry the host so the sites never
// collide; records written before the host prefix existed are
// bare Gemini paths and get migrated by pruneGenericArmRecords.
function isConversationPath(path) {
  return path.split("/").filter(Boolean).length >= 2;
}

function isConversationKey(key) {
  const path = key.startsWith("/") ? key : key.slice(key.indexOf("/"));
  return isConversationPath(path);
}

async function pruneGenericArmRecords() {
  const data = await chrome.storage.local.get(ARM_STORE_KEY);
  const all = data[ARM_STORE_KEY] || {};
  let changed = false;
  // Migrate pre-host-prefix keys (bare Gemini paths).
  for (const key of Object.keys(all)) {
    if (key.startsWith("/")) {
      all["gemini.google.com" + key] = all[key];
      delete all[key];
      changed = true;
    }
  }
  const keys = Object.keys(all);
  const kept = keys.filter(isConversationKey);
  if (kept.length !== keys.length) changed = true;
  if (changed) {
    await chrome.storage.local.set({
      [ARM_STORE_KEY]: Object.fromEntries(kept.map((k) => [k, all[k]])),
    });
  }
}


async function readRecordFor(key) {
  if (!isConversationKey(key)) return null;
  const data = await chrome.storage.local.get(ARM_STORE_KEY);
  return (data[ARM_STORE_KEY] || {})[key] || null;
}

async function readArmRecord() {
  return readRecordFor(conversationKey());
}

async function writeRecordFor(key, record) {
  const data = await chrome.storage.local.get(ARM_STORE_KEY);
  const all = data[ARM_STORE_KEY] || {};
  if (record) all[key] = record;
  else delete all[key];
  for (const k of Object.keys(all)) {
    if (!isConversationKey(k)) delete all[k];
  }
  // Keep the store bounded: only the 300 most recently armed chats.
  const entries = Object.entries(all).sort(
    (a, b) => (b[1].armedAt || 0) - (a[1].armedAt || 0),
  );
  await chrome.storage.local.set({
    [ARM_STORE_KEY]: Object.fromEntries(entries.slice(0, 300)),
  });
}

async function writeArmRecord(record) {
  if (record && !isConversationKey(conversationKey())) {
    // Armed from the new-chat page: the session works in-page,
    // but there is no conversation to persist against yet. The
    // navigation watcher adopts the real key when it appears.
    state.pendingArmAdoption = true;
    return;
  }
  if (!record) state.pendingArmAdoption = false;
  await writeRecordFor(conversationKey(), record);
}


// Tool permissions (set in the options page): every tool resolves
// to "auto", "ask" or "deny" - its own stored permission, else
// the built-in default (read tools "auto", write tools "ask").
// "deny" tools are
// also left out of the setup prompt entirely.
const DEFAULT_PERMISSIONS = { tools: {} };

async function loadPermissions() {
  const stored = await chrome.storage.local.get({
    toolPermissions: DEFAULT_PERMISSIONS,
  });
  return stored.toolPermissions || DEFAULT_PERMISSIONS;
}

function effectivePermission(perms, name) {
  if (perms.tools && perms.tools[name]) return perms.tools[name];
  return READ_ONLY_TOOLS.has(name) ? "auto" : "ask";
}

async function rememberToolApproval(name) {
  const record = await readArmRecord();
  if (!record) return;
  const approved = new Set(record.approvedTools || []);
  approved.add(name);
  await writeArmRecord({ ...record, approvedTools: [...approved] });
}

async function restoreArmedState() {
  const record = await readArmRecord();
  if (!record) return;
  const status = await bgMessage({ type: "toolsmith:status" });
  if (!status.ok || !status.serverUrl || status.serverUrl !== record.serverUrl) return;
  state.armed = true;
  state.autoRounds = 0;
  // Responses already on screen predate the restore; the watcher
  // takes the first one it sees as a baseline and never executes it.
  state.baselinePending = true;
  setButton("on", "Toolsmith: On");
}

// Deleting the record elsewhere (e.g. from the popup list) disarms
// this chat live, without waiting for a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes[ARM_STORE_KEY]) return;
  // On the new-chat path there is no record of ours to lose; a
  // store change must not kill a just-armed, not-yet-adopted
  // session.
  if (!isConversationKey(conversationKey())) return;
  const mine = (changes[ARM_STORE_KEY].newValue || {})[conversationKey()];
  if (!mine && state.armed) {
    state.armed = false;
    setButton("off", "Toolsmith: Off");
  }
});

// A cheap identity check for the visible conversation, used to
// tell an in-place identity change (Ptero settling a generated
// title after the first exchange) apart from a switch to a
// different conversation (where the first message differs).
function conversationFingerprint() {
  const firstUser = document.querySelector(SITE.userSelector);
  const text = firstUser
    ? firstUser.innerText || ""
    : lastModelResponseText();
  return text.trim().slice(0, 80);
}

function watchNavigation() {
  let lastNav = SITE.navKey();
  let lastKey = conversationKey();
  let lastFingerprint = conversationFingerprint();
  setInterval(async () => {
    const nav = SITE.navKey();
    if (nav === lastNav) return;
    lastNav = nav;
    const newKey = conversationKey();
    const fingerprint = conversationFingerprint();
    const adoptPending =
      state.armed &&
      state.pendingArmAdoption &&
      isConversationKey(newKey);
    const oldRecord =
      state.armed && !adoptPending ? await readRecordFor(lastKey) : null;
    const sameConversation = Boolean(
      oldRecord && fingerprint && fingerprint === lastFingerprint,
    );
    state.armed = false;
    state.autoRounds = 0;
    state.lastProcessedText = "";
    state.baselinePending = false;
    state.pendingArmAdoption = false;
    setButton("off", "Toolsmith: Off");
    if (adoptPending) {
      const status = await bgMessage({ type: "toolsmith:status" });
      if (status.ok && status.serverUrl) {
        await writeArmRecord({
          serverUrl: status.serverUrl,
          armedAt: Date.now(),
        });
      }
    } else if (sameConversation && isConversationKey(newKey)) {
      // The conversation's identity changed in place: carry the
      // arm record (and its session approvals) to the new key.
      const existing = await readRecordFor(newKey);
      if (!existing) {
        await writeRecordFor(newKey, oldRecord);
        await writeRecordFor(lastKey, null);
      }
    }
    lastKey = newKey;
    lastFingerprint = fingerprint;
    await pruneGenericArmRecords();
    await restoreArmedState();
  }, 1000);
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
    await writeArmRecord(null);
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
    const perms = await loadPermissions();
    const offered = listed.tools.filter(
      (tool) => effectivePermission(perms, tool.name) !== "deny",
    );
    await injectUserMessage(`${MODE_TAG}\n\n${buildSetupPrompt(offered)}`);
  } catch (err) {
    setButton("off", "Toolsmith: gagal");
    alert(`Toolsmith: tidak menemukan kotak pesan ${SITE.label}.\n${err.message}`);
    return;
  }
  state.armed = true;
  state.autoRounds = 0;
  state.lastProcessedText = "";
  setButton("on", "Toolsmith: On");
  const status = await bgMessage({ type: "toolsmith:status" });
  if (status.ok && status.serverUrl) {
    await writeArmRecord({ serverUrl: status.serverUrl, armedAt: Date.now() });
  }
}

function createToggleButton() {
  const button = document.createElement("button");
  button.className = "toolsmith-toggle toolsmith-site-" + SITE.id;
  button.type = "button";
  button.dataset.mode = state.armed ? "on" : "off";
  button.textContent = state.armed ? "Toolsmith: On" : "Toolsmith: Off";
  button.addEventListener("click", toggleToolsmith);
  return button;
}

function mountButton() {
  if (state.button && document.contains(state.button)) return;
  if (SITE.mountToggle(createToggleButton)) return;
  const editor = findEditor();
  if (!editor) return;
  // Fallback: a small bar above the composer wrapper.
  const host = SITE.fallbackHost(editor);
  if (!host || !host.parentElement) return;
  const bar = document.createElement("div");
  bar.className = "toolsmith-bar";
  const button = createToggleButton();
  bar.appendChild(button);
  host.parentElement.insertBefore(bar, host);
  state.button = button;
}


function boot() {
  mountButton();
  setInterval(mountButton, 2000); // The page re-renders; re-mount if lost.
  watchResponses();
  watchOutgoingMessages();
  watchUserMessages();
  watchNavigation();
  pruneGenericArmRecords();
  restoreArmedState();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
