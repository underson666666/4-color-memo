import "./styles.css";

import { invoke } from "@tauri-apps/api/core";
import { basename, dirname, isAbsolute, join } from "@tauri-apps/api/path";
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

type BinaryFilePayload = {
  bytes: number[];
  mime_type: string;
};

type TextSegment = {
  text: string;
  color: ColorName;
  bold: boolean;
};

type TextBlock = {
  kind: "text";
  segments: TextSegment[];
};

type ImageBlock = {
  kind: "image";
  src: string;
};

type DocBlock = TextBlock | ImageBlock;

type EditorSnapshot = {
  html: string;
  color: ColorName;
  bold: boolean;
};

type TabHistory = {
  stack: EditorSnapshot[];
  index: number;
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
  "Ctrl+V: 画像貼り付け",
  "Ctrl+Tab: 次のタブ",
  "Ctrl+Shift+Tab: 前のタブ",
  "Ctrl+S: 保存",
  "Ctrl+Shift+S: 名前を付けて保存",
  "Ctrl+O: 開く",
  "Ctrl+N: 新規タブ",
  "Ctrl+W: タブを閉じる",
  "Ctrl+Z / Ctrl+Y: Undo / Redo",
];

const IMAGE_LOADING_TEXT = "画像を読み込み中...";
const IMAGE_MISSING_TEXT = "画像が見つかりません";
const IMAGE_ANCHOR_CLASS = "image-anchor";

let tabs: TabState[] = [];
let activeTabId: string | null = null;
let currentTypingColor: ColorName = "default";
let currentTypingBold = false;
let selectedImageBlock: HTMLDivElement | null = null;
let imageHydrationRequestId = 0;
const histories = new Map<string, TabHistory>();
const imageUrlCache = new Map<string, string>();

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

function createEmptyTextBlock(): TextBlock {
  return {
    kind: "text",
    segments: [],
  };
}

function cloneDocBlocks(blocks: DocBlock[]): DocBlock[] {
  return blocks.map((block) =>
    block.kind === "image"
      ? { ...block }
      : {
          kind: "text",
          segments: block.segments.map((segment) => ({ ...segment })),
        },
  );
}

function trimTrailingEmptyTextBlocks(blocks: DocBlock[]): DocBlock[] {
  const trimmed = cloneDocBlocks(blocks);
  while (trimmed.length > 1) {
    const last = trimmed.at(-1);
    if (last?.kind === "text" && last.segments.length === 0) {
      trimmed.pop();
      continue;
    }
    break;
  }
  return trimmed;
}

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
  clearSelectedImageBlock();
  editor.focus();
  documentWithExec.execCommand?.("styleWithCSS", false, "true");
  documentWithExec.execCommand?.(command, false, value);
}

function appendTextSegment(target: TextSegment[], text: string, style: { color: ColorName; bold: boolean }): void {
  if (!text) {
    return;
  }

  const previous = target.at(-1);
  if (
    previous &&
    previous.color === style.color &&
    previous.bold === style.bold
  ) {
    previous.text += text;
    return;
  }

  target.push({
    text,
    color: style.color,
    bold: style.bold,
  });
}

function escapeMarkup(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeMarkup(text)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function segmentToSpan(text: string, segment: TextSegment): string {
  let styles = `color: ${COLOR_VALUES[segment.color]};`;
  if (segment.bold) {
    styles += " font-weight: 700;";
  }
  return `<span style="${styles}">${escapeMarkup(text)}</span>`;
}

function serializeTextSegmentsToMarkup(segments: TextSegment[]): string {
  return segments
    .map((segment) => {
      let output = escapeMarkup(segment.text);
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

function serializeBlocksToMarkup(blocks: DocBlock[], newline: NewlineMode): string {
  const lineBreak = newline === "crlf" ? "\r\n" : "\n";
  return trimTrailingEmptyTextBlocks(blocks)
    .map((block) => {
      if (block.kind === "image") {
        return `<image>${escapeMarkup(block.src)}</image>`;
      }
      return serializeTextSegmentsToMarkup(block.segments);
    })
    .join(lineBreak);
}

function deserializeMarkup(markup: string): { blocks: DocBlock[]; newline: NewlineMode } {
  const newline = markup.includes("\r\n") ? "crlf" : "lf";
  const normalized = markup.replaceAll("\r\n", "\n");
  const stack: Array<{ color: ColorName; bold: boolean }> = [{ color: "default", bold: false }];
  const blocks: DocBlock[] = [];
  let currentSegments: TextSegment[] = [];
  let justPushedImage = false;
  let cursor = 0;

  const flushCurrentTextBlock = (forceEmpty = false): void => {
    if (currentSegments.length > 0 || forceEmpty) {
      blocks.push({
        kind: "text",
        segments: currentSegments,
      });
      currentSegments = [];
      justPushedImage = false;
    }
  };

  const handleLineBreak = (): void => {
    if (currentSegments.length > 0) {
      flushCurrentTextBlock();
      return;
    }
    if (justPushedImage) {
      justPushedImage = false;
      return;
    }
    blocks.push(createEmptyTextBlock());
  };

  const pushTextChunk = (text: string, style: { color: ColorName; bold: boolean }): void => {
    const chunks = text.split("\n");
    chunks.forEach((chunk, index) => {
      if (chunk) {
        appendTextSegment(currentSegments, chunk, style);
        justPushedImage = false;
      }
      if (index < chunks.length - 1) {
        handleLineBreak();
      }
    });
  };

  const pushImageBlock = (src: string): void => {
    if (currentSegments.length > 0) {
      flushCurrentTextBlock();
    }
    blocks.push({
      kind: "image",
      src,
    });
    justPushedImage = true;
  };

  while (cursor < normalized.length) {
    const tagStart = normalized.indexOf("<", cursor);
    if (tagStart === -1) {
      pushTextChunk(decodeEntities(normalized.slice(cursor)), stack.at(-1)!);
      break;
    }

    if (tagStart > cursor) {
      pushTextChunk(decodeEntities(normalized.slice(cursor, tagStart)), stack.at(-1)!);
    }

    const tagEnd = normalized.indexOf(">", tagStart);
    if (tagEnd === -1) {
      pushTextChunk(decodeEntities(normalized.slice(tagStart)), stack.at(-1)!);
      break;
    }

    const tag = normalized.slice(tagStart + 1, tagEnd).trim().toLowerCase();
    const currentStyle = stack.at(-1)!;

    if (tag === "image") {
      const closeTag = normalized.indexOf("</image>", tagEnd + 1);
      if (closeTag === -1) {
        pushTextChunk(decodeEntities(normalized.slice(tagStart)), currentStyle);
        break;
      }
      const rawPath = normalized.slice(tagEnd + 1, closeTag);
      pushImageBlock(decodeEntities(rawPath).trim());
      cursor = closeTag + "</image>".length;
      continue;
    }

    if (tag === "red" || tag === "blue" || tag === "green" || tag === "bold") {
      const next = { ...currentStyle };
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
      pushTextChunk(decodeEntities(normalized.slice(tagStart, tagEnd + 1)), currentStyle);
    }

    cursor = tagEnd + 1;
  }

  if (currentSegments.length > 0) {
    flushCurrentTextBlock();
  }

  const trimmedBlocks = trimTrailingEmptyTextBlocks(blocks);
  return {
    blocks: trimmedBlocks.length > 0 ? trimmedBlocks : [createEmptyTextBlock()],
    newline,
  };
}

function isImageBlockElement(element: Element | null): element is HTMLDivElement {
  return element instanceof HTMLDivElement && element.dataset.docKind === "image";
}

function collectTextSegmentsFromNode(node: Node, target: TextSegment[], style: { color: ColorName; bold: boolean }): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent ?? "";
    if (value.length === 0) {
      return;
    }
    appendTextSegment(target, value, style);
    return;
  }

  if (!(node instanceof HTMLElement)) {
    return;
  }

  if (isImageBlockElement(node) || node.tagName === "BR") {
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

  for (const child of node.childNodes) {
    collectTextSegmentsFromNode(child, target, nextStyle);
  }
}

function parseTopLevelTextBlock(node: Node): TextBlock {
  const segments: TextSegment[] = [];

  if (node.nodeType === Node.TEXT_NODE) {
    appendTextSegment(segments, node.textContent ?? "", { color: "default", bold: false });
    return {
      kind: "text",
      segments,
    };
  }

  if (!(node instanceof HTMLElement)) {
    return createEmptyTextBlock();
  }

  if (node.classList.contains(IMAGE_ANCHOR_CLASS) && (node.textContent ?? "").trim().length === 0) {
    return createEmptyTextBlock();
  }

  if (node.tagName === "BR") {
    return createEmptyTextBlock();
  }

  for (const child of node.childNodes) {
    collectTextSegmentsFromNode(child, segments, { color: "default", bold: false });
  }

  return {
    kind: "text",
    segments,
  };
}

function editorHtmlToDocBlocks(html: string): DocBlock[] {
  const container = document.createElement("div");
  container.innerHTML = html;

  const blocks: DocBlock[] = [];
  for (const child of container.childNodes) {
    if (child instanceof HTMLElement && isImageBlockElement(child)) {
      blocks.push({
        kind: "image",
        src: child.dataset.imagePath ?? "",
      });
      continue;
    }

    if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim().length === 0) {
      continue;
    }

    if (
      child instanceof HTMLElement &&
      child.classList.contains(IMAGE_ANCHOR_CLASS) &&
      (child.textContent ?? "").trim().length === 0
    ) {
      continue;
    }

    blocks.push(parseTopLevelTextBlock(child));
  }

  const trimmedBlocks = trimTrailingEmptyTextBlocks(blocks);
  return trimmedBlocks.length > 0 ? trimmedBlocks : [createEmptyTextBlock()];
}

function createImageBlockHtml(imagePath: string): string {
  const escapedPath = escapeAttribute(imagePath);
  const label = escapeMarkup(imagePath);
  return `
    <div class="editor-image-block" data-doc-kind="image" data-image-path="${escapedPath}" data-load-state="loading" contenteditable="false" tabindex="0">
      <div class="editor-image-frame">
        <img class="memo-image" alt="貼り付け画像" hidden />
        <div class="editor-image-placeholder">${IMAGE_LOADING_TEXT}</div>
      </div>
      <p class="editor-image-caption">${label}</p>
    </div>
  `;
}

function docBlocksToEditorHtml(blocks: DocBlock[]): string {
  const renderBlocks = trimTrailingEmptyTextBlocks(blocks);
  const sourceBlocks = renderBlocks.length > 0 ? renderBlocks : [createEmptyTextBlock()];
  return sourceBlocks
    .map((block) => {
      if (block.kind === "image") {
        return createImageBlockHtml(block.src);
      }
      const line = block.segments.length === 0
        ? "<br>"
        : block.segments.map((segment) => segmentToSpan(segment.text, segment)).join("");
      return `<div>${line}</div>`;
    })
    .join("");
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

function createImageBlockElement(imagePath: string): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "editor-image-block";
  wrapper.dataset.docKind = "image";
  wrapper.dataset.imagePath = imagePath;
  wrapper.dataset.loadState = "loading";
  wrapper.contentEditable = "false";
  wrapper.tabIndex = 0;

  const frame = document.createElement("div");
  frame.className = "editor-image-frame";

  const img = document.createElement("img");
  img.className = "memo-image";
  img.alt = "貼り付け画像";
  img.hidden = true;

  const placeholder = document.createElement("div");
  placeholder.className = "editor-image-placeholder";
  placeholder.textContent = IMAGE_LOADING_TEXT;

  const caption = document.createElement("p");
  caption.className = "editor-image-caption";
  caption.textContent = imagePath;

  frame.append(img, placeholder);
  wrapper.append(frame, caption);
  return wrapper;
}

function createEmptyEditorTextBlock(className?: string): HTMLDivElement {
  const line = document.createElement("div");
  if (className) {
    line.className = className;
  }
  line.innerHTML = "<br>";
  return line;
}

function normalizeImageAnchorBlocks(): void {
  editor.querySelectorAll<HTMLDivElement>(`.${IMAGE_ANCHOR_CLASS}`).forEach((block) => {
    if ((block.textContent ?? "").trim().length > 0) {
      block.classList.remove(IMAGE_ANCHOR_CLASS);
    }
  });
}

function setImageBlockLoading(block: HTMLDivElement, imagePath: string): void {
  block.dataset.loadState = "loading";
  block.dataset.imagePath = imagePath;

  const img = block.querySelector<HTMLImageElement>(".memo-image");
  const placeholder = block.querySelector<HTMLDivElement>(".editor-image-placeholder");
  const caption = block.querySelector<HTMLParagraphElement>(".editor-image-caption");

  if (img) {
    img.hidden = true;
    img.removeAttribute("src");
  }
  if (placeholder) {
    placeholder.hidden = false;
    placeholder.textContent = IMAGE_LOADING_TEXT;
  }
  if (caption) {
    caption.textContent = imagePath;
  }
}

function setImageBlockLoaded(block: HTMLDivElement, src: string, imagePath: string): void {
  block.dataset.loadState = "loaded";
  block.dataset.imagePath = imagePath;

  const img = block.querySelector<HTMLImageElement>(".memo-image");
  const placeholder = block.querySelector<HTMLDivElement>(".editor-image-placeholder");
  const caption = block.querySelector<HTMLParagraphElement>(".editor-image-caption");

  if (img) {
    img.src = src;
    img.hidden = false;
  }
  if (placeholder) {
    placeholder.hidden = true;
  }
  if (caption) {
    caption.textContent = imagePath;
  }
}

function setImageBlockMissing(block: HTMLDivElement, imagePath: string): void {
  block.dataset.loadState = "missing";
  block.dataset.imagePath = imagePath;

  const img = block.querySelector<HTMLImageElement>(".memo-image");
  const placeholder = block.querySelector<HTMLDivElement>(".editor-image-placeholder");
  const caption = block.querySelector<HTMLParagraphElement>(".editor-image-caption");

  if (img) {
    img.hidden = true;
    img.removeAttribute("src");
  }
  if (placeholder) {
    placeholder.hidden = false;
    placeholder.textContent = IMAGE_MISSING_TEXT;
  }
  if (caption) {
    caption.textContent = imagePath;
  }
}

function clearSelectedImageBlock(): void {
  if (!selectedImageBlock) {
    return;
  }
  selectedImageBlock.classList.remove("selected");
  selectedImageBlock = null;
}

function selectImageBlock(block: HTMLDivElement): void {
  if (selectedImageBlock === block) {
    block.focus();
    return;
  }
  clearSelectedImageBlock();
  selectedImageBlock = block;
  selectedImageBlock.classList.add("selected");
  selectedImageBlock.focus();
}

function normalizeEditorHtml(html: string): string {
  return html.trim() ? html : "<div><br></div>";
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

function cacheImageObjectUrl(path: string, url: string): void {
  const existing = imageUrlCache.get(path);
  if (existing && existing !== url) {
    URL.revokeObjectURL(existing);
  }
  imageUrlCache.set(path, url);
}

async function getCachedImageObjectUrl(path: string): Promise<string> {
  const cached = imageUrlCache.get(path);
  if (cached) {
    return cached;
  }

  const payload = await invoke<BinaryFilePayload>("read_binary_file", { path });
  const blob = new Blob([new Uint8Array(payload.bytes)], {
    type: payload.mime_type || "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  cacheImageObjectUrl(path, url);
  return url;
}

async function resolveImageAbsolutePath(documentPath: string | null, imagePath: string): Promise<string | null> {
  if (!imagePath) {
    return null;
  }
  if (await isAbsolute(imagePath)) {
    return imagePath;
  }
  if (!documentPath) {
    return null;
  }
  const documentDir = await dirname(documentPath);
  return join(documentDir, imagePath);
}

async function hydrateEditorImages(): Promise<void> {
  const active = getActiveTab();
  if (!active) {
    return;
  }

  const requestId = ++imageHydrationRequestId;
  const imageBlocks = Array.from(editor.querySelectorAll<HTMLDivElement>(".editor-image-block"));
  for (const block of imageBlocks) {
    const imagePath = block.dataset.imagePath ?? "";
    setImageBlockLoading(block, imagePath);
  }

  for (const block of imageBlocks) {
    if (requestId !== imageHydrationRequestId) {
      return;
    }

    const imagePath = block.dataset.imagePath ?? "";
    const absolutePath = await resolveImageAbsolutePath(active.path, imagePath);
    if (!absolutePath) {
      setImageBlockMissing(block, imagePath);
      continue;
    }

    try {
      const objectUrl = await getCachedImageObjectUrl(absolutePath);
      if (requestId !== imageHydrationRequestId) {
        return;
      }
      setImageBlockLoaded(block, objectUrl, imagePath);
    } catch {
      if (requestId !== imageHydrationRequestId) {
        return;
      }
      setImageBlockMissing(block, imagePath);
    }
  }
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
  clearSelectedImageBlock();
  editor.innerHTML = snapshot.html;
  currentTypingColor = snapshot.color;
  currentTypingBold = snapshot.bold;
  const active = getActiveTab();
  if (active) {
    active.html = snapshot.html;
  }
  renderStatus();
  void hydrateEditorImages();
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
      serialized: serializeBlocksToMarkup(
        editorHtmlToDocBlocks(tab.id === activeTabId ? editor.innerHTML : tab.html),
        tab.newline,
      ),
      is_dirty: tab.isDirty,
      newline: tab.newline,
    })),
    active_tab_id: activeTabId,
  };

  await invoke("save_session_state", { session: payload });
}

function setActiveTab(id: string, options?: { preserveCurrent?: boolean }): void {
  const current = getActiveTab();
  if (options?.preserveCurrent !== false && current) {
    current.html = normalizeEditorHtml(editor.innerHTML);
  }

  clearSelectedImageBlock();
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
  void hydrateEditorImages();
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
    const restoredHtml = docBlocksToEditorHtml(restored.blocks);
    histories.set(tab.id, {
      stack: [{ html: restoredHtml, color: "default", bold: false }],
      index: 0,
    });
    return {
      id: tab.id,
      title: tab.title,
      path: tab.path,
      html: restoredHtml,
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
  void hydrateEditorImages();
}

async function getDocumentFolderName(documentPath: string): Promise<string> {
  const documentName = await basename(documentPath);
  return documentName.toLowerCase().endsWith(".4cm")
    ? documentName.slice(0, -4)
    : documentName;
}

async function buildImageStoragePaths(documentPath: string, fileName: string): Promise<{ relativePath: string; absolutePath: string }> {
  const documentDir = await dirname(documentPath);
  const documentFolder = await getDocumentFolderName(documentPath);
  const assetDirectory = await join("assets", documentFolder);
  return {
    relativePath: `${assetDirectory}/${fileName}`.replaceAll("\\", "/"),
    absolutePath: await join(documentDir, assetDirectory, fileName),
  };
}

async function remapImageBlocksForSave(blocks: DocBlock[], sourceDocumentPath: string | null, targetDocumentPath: string): Promise<DocBlock[]> {
  if (!sourceDocumentPath || sourceDocumentPath === targetDocumentPath) {
    return cloneDocBlocks(blocks);
  }

  const targetDocumentDir = await dirname(targetDocumentPath);
  const targetDocumentFolder = await getDocumentFolderName(targetDocumentPath);
  const targetAssetDirectory = await join("assets", targetDocumentFolder);
  const remapped = new Map<string, string>();

  const output: DocBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "text") {
      output.push({
        kind: "text",
        segments: block.segments.map((segment) => ({ ...segment })),
      });
      continue;
    }

    const existing = remapped.get(block.src);
    if (existing) {
      output.push({ kind: "image", src: existing });
      continue;
    }

    const fileName = await basename(block.src);
    const targetRelativePath = `${targetAssetDirectory}/${fileName}`.replaceAll("\\", "/");
    const targetAbsolutePath = await join(targetDocumentDir, targetAssetDirectory, fileName);
    const sourceAbsolutePath = await resolveImageAbsolutePath(sourceDocumentPath, block.src);

    let nextSource = targetRelativePath;
    if (sourceAbsolutePath) {
      try {
        await invoke("copy_binary_file", {
          source: sourceAbsolutePath,
          target: targetAbsolutePath,
        });
      } catch {
        nextSource = sourceAbsolutePath;
      }
    } else {
      nextSource = block.src;
    }

    remapped.set(block.src, nextSource);
    output.push({
      kind: "image",
      src: nextSource,
    });
  }

  return output;
}

async function saveCurrentTab(forceSaveAs: boolean): Promise<boolean> {
  const active = getActiveTab();
  if (!active) {
    return false;
  }

  active.html = normalizeEditorHtml(editor.innerHTML);
  active.newline = newlineSelect.value as NewlineMode;

  const previousPath = active.path;
  let targetPath = previousPath;
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

  const blocks = editorHtmlToDocBlocks(active.html);
  const blocksForSave = await remapImageBlocksForSave(blocks, previousPath, targetPath);
  const content = serializeBlocksToMarkup(blocksForSave, active.newline);
  await invoke("write_document", { path: targetPath, content });

  active.path = targetPath;
  active.title = await basename(targetPath);
  active.isDirty = false;

  if (previousPath !== targetPath) {
    active.html = docBlocksToEditorHtml(blocksForSave);
    if (active.id === activeTabId) {
      clearSelectedImageBlock();
      editor.innerHTML = active.html;
      void hydrateEditorImages();
    }
  } else {
    active.html = normalizeEditorHtml(editor.innerHTML);
  }

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
    title: await basename(path),
    path,
    html: docBlocksToEditorHtml(restored.blocks),
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
  clearSelectedImageBlock();
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

function findClosestEditorBlock(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current && current !== editor) {
    if (current instanceof HTMLElement && current.parentElement === editor) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

function getCurrentEditorBlock(): HTMLElement | null {
  const selection = window.getSelection();
  return findClosestEditorBlock(selection?.anchorNode ?? null);
}

function isEffectivelyEmptyTextBlock(block: HTMLElement): boolean {
  if (isImageBlockElement(block)) {
    return false;
  }
  return (block.textContent ?? "").trim().length === 0;
}

function placeCaretAtTextBlock(block: HTMLElement): void {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function insertImageBlockAtSelection(imagePath: string, previewUrl: string): void {
  const imageBlock = createImageBlockElement(imagePath);
  setImageBlockLoaded(imageBlock, previewUrl, imagePath);
  const trailingBlock = createEmptyEditorTextBlock(IMAGE_ANCHOR_CLASS);
  const currentBlock = getCurrentEditorBlock();

  clearSelectedImageBlock();

  if (!currentBlock) {
    if (editor.innerHTML.trim() === "" || editor.innerHTML === "<div><br></div>") {
      editor.innerHTML = "";
    }
    editor.append(imageBlock, trailingBlock);
    placeCaretAtTextBlock(trailingBlock);
    return;
  }

  if (isImageBlockElement(currentBlock)) {
    currentBlock.after(imageBlock, trailingBlock);
    placeCaretAtTextBlock(trailingBlock);
    return;
  }

  if (isEffectivelyEmptyTextBlock(currentBlock)) {
    currentBlock.replaceWith(imageBlock, trailingBlock);
    placeCaretAtTextBlock(trailingBlock);
    return;
  }

  currentBlock.after(imageBlock, trailingBlock);
  placeCaretAtTextBlock(trailingBlock);
}

function findNearestTextBlock(start: Element | null, direction: "next" | "previous"): HTMLDivElement | null {
  let current = start;
  while (current) {
    if (current instanceof HTMLDivElement && !isImageBlockElement(current)) {
      return current;
    }
    current = direction === "next" ? current.nextElementSibling : current.previousElementSibling;
  }
  return null;
}

function removeSelectedImageBlock(): void {
  const block = selectedImageBlock;
  if (!block) {
    return;
  }

  const nextTextBlock = findNearestTextBlock(block.nextElementSibling, "next");
  const previousTextBlock = findNearestTextBlock(block.previousElementSibling, "previous");

  clearSelectedImageBlock();
  block.remove();

  let focusTarget = nextTextBlock ?? previousTextBlock;
  if (!focusTarget) {
    focusTarget = createEmptyEditorTextBlock();
    editor.append(focusTarget);
  }

  placeCaretAtTextBlock(focusTarget);
  markDirty();
}

function buildImageFileName(mimeType: string): string {
  const extension = (() => {
    switch (mimeType) {
      case "image/jpeg":
        return "jpg";
      case "image/gif":
        return "gif";
      case "image/webp":
        return "webp";
      case "image/bmp":
        return "bmp";
      default:
        return "png";
    }
  })();

  return `img-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
}

async function ensureImagePasteTarget(): Promise<TabState | null> {
  const active = getActiveTab();
  if (!active) {
    return null;
  }
  if (active.path) {
    return active;
  }

  const saved = await saveCurrentTab(false);
  if (!saved) {
    return null;
  }
  return getActiveTab() ?? null;
}

async function handleEditorPaste(event: ClipboardEvent): Promise<void> {
  const items = Array.from(event.clipboardData?.items ?? []);
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  if (!imageItem) {
    return;
  }

  const file = imageItem.getAsFile();
  if (!file) {
    return;
  }

  event.preventDefault();

  const active = await ensureImagePasteTarget();
  if (!active?.path) {
    return;
  }

  const fileName = buildImageFileName(file.type);
  const storage = await buildImageStoragePaths(active.path, fileName);
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));

  await invoke("write_binary_file", {
    path: storage.absolutePath,
    bytes,
  });

  const previewUrl = URL.createObjectURL(file);
  cacheImageObjectUrl(storage.absolutePath, previewUrl);
  insertImageBlockAtSelection(storage.relativePath, previewUrl);
  markDirty();
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
  normalizeImageAnchorBlocks();
  clearSelectedImageBlock();
  markDirty();
});

editor.addEventListener("paste", (event) => {
  void handleEditorPaste(event);
});

editor.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const imageBlock = target.closest<HTMLDivElement>(".editor-image-block");
  if (imageBlock) {
    event.preventDefault();
    selectImageBlock(imageBlock);
    return;
  }
  clearSelectedImageBlock();
});

document.addEventListener("mousedown", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) {
    clearSelectedImageBlock();
    return;
  }
  if (!editor.contains(target)) {
    clearSelectedImageBlock();
  }
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
  if (
    selectedImageBlock &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === "Delete" || event.key === "Backspace")
  ) {
    event.preventDefault();
    removeSelectedImageBlock();
    return;
  }
  handleShortcut(event);
});

window.addEventListener("beforeunload", () => {
  for (const objectUrl of imageUrlCache.values()) {
    URL.revokeObjectURL(objectUrl);
  }
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
