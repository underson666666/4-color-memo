import "./styles.css";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";

type ColorName = "default" | "red" | "blue" | "green";
type NewlineMode = "lf" | "crlf";

type TabState = {
  id: string;
  title: string;
  path: string | null;
  html: string;
  isDirty: boolean;
  newline: NewlineMode;
};

type PersistedTab = {
  id: string;
  title: string;
  path: string | null;
  serialized: string;
  is_dirty: boolean;
  newline: NewlineMode;
};

type SessionState = {
  tabs: PersistedTab[];
  active_tab_id: string | null;
};

type FilePayload = {
  content: string;
  newline: NewlineMode;
};

const COLOR_VALUES: Record<ColorName, string> = {
  default: "#202227",
  red: "#ba3b46",
  blue: "#2d6cdf",
  green: "#2a8f5b",
};

const COLOR_LABELS: Record<ColorName, string> = {
  default: "黒",
  red: "赤",
  blue: "青",
  green: "緑",
};

const SHORTCUT_HINTS = [
  "Ctrl+D: 黒",
  "Ctrl+R: 赤",
  "Ctrl+B: 青",
  "Ctrl+G: 緑",
  "Ctrl+Shift+B: 太字",
  "Ctrl+Tab: 次のタブ",
  "Ctrl+Shift+Tab: 前のタブ",
  "Ctrl+S: 保存",
  "Ctrl+Shift+S: 名前を付けて保存",
  "Ctrl+O: 開く",
  "Ctrl+N: 新規タブ",
  "Ctrl+W: タブを閉じる",
  "Ctrl+Z / Ctrl+Y: Undo / Redo",
];

type EditorSnapshot = {
  html: string;
  color: ColorName;
  bold: boolean;
};

type TabHistory = {
  stack: EditorSnapshot[];
  index: number;
};

let tabs: TabState[] = [];
let activeTabId: string | null = null;
let currentTypingColor: ColorName = "default";
let currentTypingBold = false;
const histories = new Map<string, TabHistory>();

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("app root not found");
}

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">4 color memo editor</p>
        <h1>4 Color Text</h1>
      </div>
      <div class="toolbar">
        <button type="button" data-action="new">新規</button>
        <button type="button" data-action="open">開く</button>
        <button type="button" data-action="save">保存</button>
        <button type="button" data-action="saveAs">名前を付けて保存</button>
      </div>
    </header>
    <section class="formatbar">
      <button type="button" class="color-btn" data-color="default">黒</button>
      <button type="button" class="color-btn color-red" data-color="red">赤</button>
      <button type="button" class="color-btn color-blue" data-color="blue">青</button>
      <button type="button" class="color-btn color-green" data-color="green">緑</button>
      <button type="button" class="style-btn" data-style="bold">太字</button>
      <label class="newline-select">
        改行
        <select id="newline-mode">
          <option value="lf">LF</option>
          <option value="crlf">CRLF</option>
        </select>
      </label>
    </section>
    <section class="tabstrip"></section>
    <main class="workspace">
      <div id="editor" class="editor" contenteditable="true" spellcheck="false"></div>
      <aside class="sidebar">
        <h2>ショートカット</h2>
        <ul class="shortcut-list">
          ${SHORTCUT_HINTS.map((hint) => `<li>${hint}</li>`).join("")}
        </ul>
      </aside>
    </main>
    <footer class="statusbar">
      <span id="status-path">未保存ファイル</span>
      <span id="status-style">入力色: 黒 / 太字: OFF</span>
    </footer>
  </div>
`;

const editor = document.querySelector<HTMLDivElement>("#editor")!;
const tabstrip = document.querySelector<HTMLElement>(".tabstrip")!;
const newlineSelect = document.querySelector<HTMLSelectElement>("#newline-mode")!;
const statusPath = document.querySelector<HTMLSpanElement>("#status-path")!;
const statusStyle = document.querySelector<HTMLSpanElement>("#status-style")!;

const documentWithExec = document as Document & {
  execCommand?: (commandId: string, showUI?: boolean, value?: string) => boolean;
};

function createTab(title = "無題"): TabState {
  return {
    id: crypto.randomUUID(),
    title,
    path: null,
    html: "<div><br></div>",
    isDirty: false,
    newline: "crlf",
  };
}

function getActiveTab(): TabState | undefined {
  return tabs.find((tab) => tab.id === activeTabId);
}

function getSelectionIsCollapsed(): boolean {
  const selection = window.getSelection();
  return selection ? selection.isCollapsed : true;
}

function execEditorCommand(command: string, value?: string): void {
  editor.focus();
  documentWithExec.execCommand?.("styleWithCSS", false, "true");
  documentWithExec.execCommand?.(command, false, value);
}

function getPlainTextFromNode(node: Node, lines: string[], style: { color: ColorName; bold: boolean }): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent ?? "";
    if (value.length === 0) {
      return;
    }
    appendStyledText(lines, decodeEntities(value), style);
    return;
  }

  if (!(node instanceof HTMLElement)) {
    return;
  }

  if (node.tagName === "BR") {
    appendStyledText(lines, "\n", style);
    return;
  }

  const nextStyle = { ...style };
  const tag = node.tagName.toLowerCase();

  if (tag === "b" || tag === "strong") {
    nextStyle.bold = true;
  }

  if (tag === "font") {
    const color = node.getAttribute("color");
    if (color) {
      nextStyle.color = toColorName(color);
    }
  }

  const inlineColor = node.style.color;
  if (inlineColor) {
    nextStyle.color = toColorName(inlineColor);
  }

  if (node.style.fontWeight && node.style.fontWeight !== "normal") {
    nextStyle.bold = true;
  }

  if (node.childNodes.length === 0 && (tag === "div" || tag === "p")) {
    appendStyledText(lines, "\n", style);
    return;
  }

  let emittedBlock = false;
  for (const child of node.childNodes) {
    getPlainTextFromNode(child, lines, nextStyle);
    emittedBlock = true;
  }

  if ((tag === "div" || tag === "p") && emittedBlock) {
    appendStyledText(lines, "\n", style);
  }
}

type Segment = {
  text: string;
  color: ColorName;
  bold: boolean;
};

function appendStyledText(target: string[], text: string, style: { color: ColorName; bold: boolean }): void {
  target.push(JSON.stringify({ text, color: style.color, bold: style.bold }));
}

function serializeEditorHtmlToSegments(html: string): Segment[] {
  const container = document.createElement("div");
  container.innerHTML = html;
  const raw: string[] = [];
  for (const child of container.childNodes) {
    getPlainTextFromNode(child, raw, { color: "default", bold: false });
  }

  const parsed = raw
    .map((item) => JSON.parse(item) as Segment)
    .filter((segment) => segment.text.length > 0);

  const merged: Segment[] = [];
  for (const segment of parsed) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.color === segment.color &&
      previous.bold === segment.bold
    ) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }

  while (merged.at(-1)?.text.endsWith("\n")) {
    const last = merged.at(-1);
    if (!last) {
      break;
    }
    if (last.text === "\n") {
      merged.pop();
    } else {
      last.text = last.text.slice(0, -1);
    }
  }

  return merged;
}

function escapeMarkup(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function decodeEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function serializeSegmentsToMarkup(segments: Segment[], newline: NewlineMode): string {
  const lineBreak = newline === "crlf" ? "\r\n" : "\n";
  return segments
    .map((segment) => {
      const text = escapeMarkup(segment.text).replaceAll("\n", lineBreak);
      let output = text;
      if (segment.bold) {
        output = `<bold>${output}</bold>`;
      }
      if (segment.color !== "default") {
        output = `<${segment.color}>${output}</${segment.color}>`;
      }
      return output;
    })
    .join("");
}

function deserializeMarkup(markup: string): { html: string; newline: NewlineMode } {
  const newline = markup.includes("\r\n") ? "crlf" : "lf";
  const normalized = markup.replaceAll("\r\n", "\n");
  const stack: Array<{ color: ColorName; bold: boolean }> = [{ color: "default", bold: false }];
  const segments: Segment[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const tagStart = normalized.indexOf("<", cursor);
    if (tagStart === -1) {
      pushSegment(segments, decodeEntities(normalized.slice(cursor)), stack.at(-1)!);
      break;
    }

    if (tagStart > cursor) {
      pushSegment(segments, decodeEntities(normalized.slice(cursor, tagStart)), stack.at(-1)!);
    }

    const tagEnd = normalized.indexOf(">", tagStart);
    if (tagEnd === -1) {
      pushSegment(segments, decodeEntities(normalized.slice(tagStart)), stack.at(-1)!);
      break;
    }

    const tag = normalized.slice(tagStart + 1, tagEnd).trim().toLowerCase();
    const current = stack.at(-1)!;

    if (tag === "red" || tag === "blue" || tag === "green" || tag === "bold") {
      const next = { ...current };
      if (tag === "bold") {
        next.bold = true;
      } else {
        next.color = tag;
      }
      stack.push(next);
    } else if (tag === "/red" || tag === "/blue" || tag === "/green" || tag === "/bold") {
      if (stack.length > 1) {
        stack.pop();
      }
    } else {
      pushSegment(segments, decodeEntities(normalized.slice(tagStart, tagEnd + 1)), current);
    }

    cursor = tagEnd + 1;
  }

  return {
    html: segmentsToEditorHtml(segments),
    newline,
  };
}

function pushSegment(segments: Segment[], text: string, style: { color: ColorName; bold: boolean }): void {
  if (!text) {
    return;
  }
  const previous = segments.at(-1);
  if (
    previous &&
    previous.color === style.color &&
    previous.bold === style.bold
  ) {
    previous.text += text;
  } else {
    segments.push({
      text,
      color: style.color,
      bold: style.bold,
    });
  }
}

function segmentsToEditorHtml(segments: Segment[]): string {
  if (segments.length === 0) {
    return "<div><br></div>";
  }

  const lines: string[] = [];
  let currentLine = "";

  for (const segment of segments) {
    const chunks = segment.text.split("\n");
    chunks.forEach((chunk, index) => {
      if (chunk) {
        currentLine += segmentToSpan(chunk, segment);
      }
      if (index < chunks.length - 1) {
        lines.push(currentLine || "<br>");
        currentLine = "";
      }
    });
  }

  lines.push(currentLine || "<br>");
  return lines.map((line) => `<div>${line}</div>`).join("");
}

function segmentToSpan(text: string, segment: Segment): string {
  let styles = `color: ${COLOR_VALUES[segment.color]};`;
  if (segment.bold) {
    styles += " font-weight: 700;";
  }
  return `<span style="${styles}">${escapeMarkup(text)}</span>`;
}

function toColorName(input: string): ColorName {
  const value = input.replaceAll(" ", "").toLowerCase();
  if (value.includes("186,59,70") || value === "#ba3b46" || value === "rgb(186,59,70)") {
    return "red";
  }
  if (value.includes("45,108,223") || value === "#2d6cdf" || value === "rgb(45,108,223)") {
    return "blue";
  }
  if (value.includes("42,143,91") || value === "#2a8f5b" || value === "rgb(42,143,91)") {
    return "green";
  }
  return "default";
}

function renderTabs(): void {
  tabstrip.innerHTML = tabs
    .map((tab) => {
      const activeClass = tab.id === activeTabId ? " active" : "";
      const dirty = tab.isDirty ? " *" : "";
      return `
        <button type="button" class="tab${activeClass}" data-tab-id="${tab.id}">
          ${escapeMarkup(tab.title + dirty)}
        </button>
      `;
    })
    .join("");
}

function setActiveTab(id: string, options?: { preserveCurrent?: boolean }): void {
  const current = getActiveTab();
  if (options?.preserveCurrent !== false && current) {
    current.html = normalizeEditorHtml(editor.innerHTML);
  }

  activeTabId = id;
  const next = getActiveTab();
  if (!next) {
    return;
  }

  editor.innerHTML = next.html;
  newlineSelect.value = next.newline;
  renderTabs();
  renderStatus();
  editor.focus();
}

function moveTabFocus(direction: 1 | -1): void {
  if (tabs.length <= 1 || !activeTabId) {
    return;
  }

  const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  if (currentIndex === -1) {
    return;
  }

  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
  setActiveTab(tabs[nextIndex].id);
}

function normalizeEditorHtml(html: string): string {
  return html.trim() ? html : "<div><br></div>";
}

function renderStatus(): void {
  const active = getActiveTab();
  if (!active) {
    return;
  }
  statusPath.textContent = active.path ?? "未保存ファイル";
  statusStyle.textContent = `入力色: ${COLOR_LABELS[currentTypingColor]} / 太字: ${
    currentTypingBold ? "ON" : "OFF"
  }`;

  document.querySelectorAll<HTMLButtonElement>(".color-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.color === currentTypingColor);
  });
  document.querySelectorAll<HTMLButtonElement>(".style-btn").forEach((button) => {
    button.classList.toggle("active", currentTypingBold);
  });
}

function ensureHistory(tabId: string): TabHistory {
  const existing = histories.get(tabId);
  if (existing) {
    return existing;
  }
  const initial: EditorSnapshot = {
    html: "<div><br></div>",
    color: "default",
    bold: false,
  };
  const history = { stack: [initial], index: 0 };
  histories.set(tabId, history);
  return history;
}

function pushHistory(tabId: string, snapshot: EditorSnapshot): void {
  const history = ensureHistory(tabId);
  const current = history.stack[history.index];
  if (
    current &&
    current.html === snapshot.html &&
    current.color === snapshot.color &&
    current.bold === snapshot.bold
  ) {
    return;
  }

  history.stack = history.stack.slice(0, history.index + 1);
  history.stack.push(snapshot);
  if (history.stack.length > 200) {
    history.stack.shift();
  } else {
    history.index += 1;
  }
  history.index = history.stack.length - 1;
}

function applySnapshot(snapshot: EditorSnapshot): void {
  editor.innerHTML = snapshot.html;
  currentTypingColor = snapshot.color;
  currentTypingBold = snapshot.bold;
  const active = getActiveTab();
  if (active) {
    active.html = snapshot.html;
  }
  renderStatus();
}

function markDirty(): void {
  const active = getActiveTab();
  if (!active) {
    return;
  }
  active.html = normalizeEditorHtml(editor.innerHTML);
  active.isDirty = true;
  active.title = active.path ? active.path.split(/[\\/]/).at(-1) ?? active.title : active.title;
  pushHistory(active.id, {
    html: active.html,
    color: currentTypingColor,
    bold: currentTypingBold,
  });
  renderTabs();
  renderStatus();
  void persistSession();
}

async function persistSession(): Promise<void> {
  const active = getActiveTab();
  if (active) {
    active.html = normalizeEditorHtml(editor.innerHTML);
    active.newline = newlineSelect.value as NewlineMode;
  }

  const payload: SessionState = {
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      path: tab.path,
      serialized: serializeSegmentsToMarkup(serializeEditorHtmlToSegments(tab.id === activeTabId ? editor.innerHTML : tab.html), tab.newline),
      is_dirty: tab.isDirty,
      newline: tab.newline,
    })),
    active_tab_id: activeTabId,
  };

  await invoke("save_session_state", { session: payload });
}

async function restoreSession(): Promise<void> {
  const session = await invoke<SessionState | null>("load_session_state");
  if (!session || session.tabs.length === 0) {
    const initial = createTab();
    tabs = [initial];
    activeTabId = initial.id;
    histories.set(initial.id, {
      stack: [{ html: initial.html, color: "default", bold: false }],
      index: 0,
    });
    editor.innerHTML = initial.html;
    newlineSelect.value = initial.newline;
    renderTabs();
    renderStatus();
    return;
  }

  tabs = session.tabs.map((tab) => {
    const restored = deserializeMarkup(tab.serialized);
    histories.set(tab.id, {
      stack: [{ html: restored.html, color: "default", bold: false }],
      index: 0,
    });
    return {
      id: tab.id,
      title: tab.title,
      path: tab.path,
      html: restored.html,
      isDirty: tab.is_dirty,
      newline: tab.newline ?? restored.newline,
    };
  });
  activeTabId = session.active_tab_id && tabs.some((tab) => tab.id === session.active_tab_id)
    ? session.active_tab_id
    : tabs[0]?.id ?? null;

  const active = getActiveTab();
  if (active) {
    editor.innerHTML = active.html;
    newlineSelect.value = active.newline;
  }
  renderTabs();
  renderStatus();
}

async function saveCurrentTab(forceSaveAs: boolean): Promise<boolean> {
  const active = getActiveTab();
  if (!active) {
    return false;
  }

  active.html = normalizeEditorHtml(editor.innerHTML);
  active.newline = newlineSelect.value as NewlineMode;

  let targetPath = active.path;
  if (forceSaveAs || !targetPath) {
    const result = await save({
      title: "4cm ファイルを保存",
      defaultPath: active.path ?? `${active.title.replace(/\s+/g, "_") || "memo"}.4cm`,
      filters: [{ name: "4 Color Memo", extensions: ["4cm"] }],
    });
    if (!result) {
      return false;
    }
    targetPath = result;
  }

  const content = serializeSegmentsToMarkup(
    serializeEditorHtmlToSegments(active.html),
    active.newline,
  );
  await invoke("write_document", { path: targetPath, content });

  active.path = targetPath;
  active.title = targetPath.split(/[\\/]/).at(-1) ?? active.title;
  active.isDirty = false;
  renderTabs();
  renderStatus();
  await persistSession();
  return true;
}

async function openDocument(): Promise<void> {
  const path = await open({
    title: "4cm ファイルを開く",
    multiple: false,
    filters: [{ name: "4 Color Memo", extensions: ["4cm"] }],
  });

  if (!path || Array.isArray(path)) {
    return;
  }

  const payload = await invoke<FilePayload>("read_document", { path });
  const restored = deserializeMarkup(payload.content);
  const tab: TabState = {
    id: crypto.randomUUID(),
    title: path.split(/[\\/]/).at(-1) ?? "memo.4cm",
    path,
    html: restored.html,
    isDirty: false,
    newline: payload.newline ?? restored.newline,
  };
  tabs.push(tab);
  histories.set(tab.id, {
    stack: [{ html: tab.html, color: "default", bold: false }],
    index: 0,
  });
  setActiveTab(tab.id);
  await persistSession();
}

async function closeTab(tabId: string): Promise<boolean> {
  const closingIndex = tabs.findIndex((item) => item.id === tabId);
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) {
    return true;
  }

  if (tab.isDirty) {
    setActiveTab(tabId);
    const shouldSave = await confirm("保存されていない変更があります。保存しますか？", {
      title: "4 Color Text",
      kind: "warning",
      okLabel: "はい",
      cancelLabel: "いいえ",
    });
    if (shouldSave) {
      const saved = await saveCurrentTab(false);
      if (!saved) {
        return false;
      }
    }
  }

  tabs = tabs.filter((item) => item.id !== tabId);
  histories.delete(tabId);
  if (tabs.length === 0) {
    const replacement = createTab();
    tabs.push(replacement);
    histories.set(replacement.id, {
      stack: [{ html: replacement.html, color: "default", bold: false }],
      index: 0,
    });
  }

  const nextIndex = Math.max(0, Math.min(closingIndex, tabs.length - 1));
  const nextTabId = tabs[nextIndex]?.id ?? null;
  activeTabId = null;
  if (nextTabId) {
    setActiveTab(nextTabId, { preserveCurrent: false });
  }
  renderTabs();
  await persistSession();
  return true;
}

function applyColor(color: ColorName): void {
  const collapsed = getSelectionIsCollapsed();
  currentTypingColor = color;
  execEditorCommand("foreColor", COLOR_VALUES[color]);
  if (!collapsed) {
    markDirty();
  }
  renderStatus();
}

function toggleBold(): void {
  currentTypingBold = !currentTypingBold;
  execEditorCommand("bold");
  if (!getSelectionIsCollapsed()) {
    markDirty();
  }
  renderStatus();
}

function undo(): void {
  const active = getActiveTab();
  if (!active) {
    return;
  }
  const history = histories.get(active.id);
  if (!history || history.index <= 0) {
    return;
  }
  history.index -= 1;
  applySnapshot(history.stack[history.index]);
  active.isDirty = true;
  renderTabs();
}

function redo(): void {
  const active = getActiveTab();
  if (!active) {
    return;
  }
  const history = histories.get(active.id);
  if (!history || history.index >= history.stack.length - 1) {
    return;
  }
  history.index += 1;
  applySnapshot(history.stack[history.index]);
  active.isDirty = true;
  renderTabs();
}

function createNewTab(): void {
  const tab = createTab();
  tabs.push(tab);
  histories.set(tab.id, {
    stack: [{ html: tab.html, color: "default", bold: false }],
    index: 0,
  });
  setActiveTab(tab.id);
  void persistSession();
}

async function beforeWindowClose(): Promise<boolean> {
  for (const tab of [...tabs]) {
    if (tab.isDirty) {
      setActiveTab(tab.id);
      const shouldSave = await confirm(`「${tab.title}」は未保存です。保存しますか？`, {
        title: "4 Color Text",
        kind: "warning",
        okLabel: "はい",
        cancelLabel: "いいえ",
      });
      if (shouldSave) {
        const saved = await saveCurrentTab(false);
        if (!saved) {
          return false;
        }
      }
    }
  }
  await persistSession();
  return true;
}

document.querySelectorAll<HTMLButtonElement>(".toolbar button").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (action === "new") {
      createNewTab();
    } else if (action === "open") {
      void openDocument();
    } else if (action === "save") {
      void saveCurrentTab(false);
    } else if (action === "saveAs") {
      void saveCurrentTab(true);
    }
  });
});

document.querySelectorAll<HTMLButtonElement>(".color-btn").forEach((button) => {
  button.addEventListener("click", () => {
    applyColor(button.dataset.color as ColorName);
  });
});

document.querySelector<HTMLButtonElement>(".style-btn")?.addEventListener("click", () => {
  toggleBold();
});

tabstrip.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const tabId = target.dataset.tabId;
  if (tabId) {
    setActiveTab(tabId);
  }
});

newlineSelect.addEventListener("change", () => {
  const active = getActiveTab();
  if (!active) {
    return;
  }
  active.newline = newlineSelect.value as NewlineMode;
  active.isDirty = true;
  renderTabs();
  void persistSession();
});

editor.addEventListener("input", () => {
  markDirty();
});

function handleShortcut(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey)) {
    return;
  }

  const key = event.key.toLowerCase();

  if (key === "s") {
    event.preventDefault();
    void saveCurrentTab(event.shiftKey);
    return;
  }
  if (key === "tab") {
    event.preventDefault();
    moveTabFocus(event.shiftKey ? -1 : 1);
    return;
  }
  if (key === "o") {
    event.preventDefault();
    void openDocument();
    return;
  }
  if (key === "n") {
    event.preventDefault();
    createNewTab();
    return;
  }
  if (key === "w") {
    event.preventDefault();
    if (activeTabId) {
      void closeTab(activeTabId);
    }
    return;
  }
  if (key === "z") {
    event.preventDefault();
    undo();
    return;
  }
  if (key === "y") {
    event.preventDefault();
    redo();
    return;
  }
  if (key === "d") {
    event.preventDefault();
    applyColor("default");
    return;
  }
  if (key === "r") {
    event.preventDefault();
    applyColor("red");
    return;
  }
  if (key === "g") {
    event.preventDefault();
    applyColor("green");
    return;
  }
  if (key === "b" && event.shiftKey) {
    event.preventDefault();
    toggleBold();
    return;
  }
  if (key === "b") {
    event.preventDefault();
    applyColor("blue");
  }
}

document.addEventListener("keydown", (event) => {
  handleShortcut(event);
});

async function bootstrap(): Promise<void> {
  await getCurrentWindow().listen("app-close-requested", async () => {
    const ready = await beforeWindowClose();
    if (ready) {
      await invoke("exit_app");
      return;
    }
    await invoke("cancel_window_close");
  });

  await restoreSession();
}

void bootstrap();
