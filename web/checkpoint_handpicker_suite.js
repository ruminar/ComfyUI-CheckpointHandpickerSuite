import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXT = "ruminar.checkpoint_handpicker_suite";
const PREVIEW_EVENT = "ruminar.checkpoint_handpicker_suite.preview";
const CYCLER_EVENT = "ruminar.checkpoint_handpicker_suite.cycler";
const TAGGER_EVENT = "ruminar.checkpoint_handpicker_suite.tagger";
const STATUS_CHANGED_EVENT = "ruminar.checkpoint_handpicker_suite.status_changed";

const SELECTOR_CLASS = "CheckpointListSelector";
const CYCLER_CLASS = "CheckpointNameCycler";
const TAGGER_CLASS = "CheckpointStatusTagger";
const PREVIEW_CLASSES = new Set(["EphemeralPreview", "ImageDirPreview"]);

const STATUS_ORDER = ["favorite", "nice", "keep", "delete", "none"];
const STATUS_ICON = { favorite: "💛", nice: "👍", keep: "✔", delete: "🗑", none: "—" };
const STATUS_LABEL = { favorite: "favorite", nice: "nice", keep: "keep", delete: "delete", none: "none" };

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function ensureSize(node, w, h) {
  if (!node.size) return;
  node.size[0] = Math.max(node.size[0], w);
  node.size[1] = Math.max(node.size[1], h);
}

function installMinSize(nodeType, minW, minH) {
  if (nodeType.prototype.__hpsMinSizeInstalled) return;
  nodeType.prototype.__hpsMinSizeInstalled = true;
  const origResize = nodeType.prototype.onResize;
  nodeType.prototype.onResize = function (size) {
    if (size) {
      size[0] = Math.max(size[0], minW);
      size[1] = Math.max(size[1], minH);
    }
    ensureSize(this, minW, minH);
    return origResize ? origResize.apply(this, arguments) : undefined;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    ensureSize(this, minW, minH);
    return r;
  };
}

function setCanvasCursor(cursor) {
  const canvasEl = app.canvas?.canvas;
  if (canvasEl) canvasEl.style.cursor = cursor || "";
}

function drawRounded(ctx, x, y, w, h, r = 6) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function drawButton(ctx, rect, label, enabled = true, active = false, color = null, opts = {}) {
  ctx.save();
  const bg = color || (active ? "rgba(70,140,110,0.82)" : enabled ? "rgba(80,120,180,0.65)" : "rgba(80,80,80,0.26)");
  ctx.fillStyle = bg;
  ctx.strokeStyle = enabled ? (active ? "rgba(235,255,245,0.95)" : "rgba(200,230,255,0.75)") : "rgba(150,150,150,0.28)";
  ctx.lineWidth = active ? 3 : 1;
  drawRounded(ctx, rect.x, rect.y, rect.w, rect.h, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = opts.textColor || (enabled ? "#fff" : "#888");
  ctx.font = `${active ? "bold " : ""}12px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.restore();
}

function hit(pos, rect) {
  return pos && pos[0] >= rect.x && pos[0] <= rect.x + rect.w && pos[1] >= rect.y && pos[1] <= rect.y + rect.h;
}

function localPos(node, pos) {
  if (!pos) return pos;
  return [pos[0] - (node.pos?.[0] || 0), pos[1] - (node.pos?.[1] || 0)];
}

function candidatePositions(node, pos) {
  if (!pos) return [];
  // LiteGraph/ComfyUI versions differ here: some callbacks pass node-local
  // coordinates, others pass graph/canvas coordinates. Test both so custom
  // drawn controls keep working across frontend versions.
  const graphToLocal = localPos(node, pos);
  return [pos, graphToLocal];
}

function hitAny(node, pos, rect) {
  return candidatePositions(node, pos).some((p) => hit(p, rect));
}

function graphEventToLocal(node, event) {
  let graphPos = null;
  try {
    graphPos = app.canvas?.convertEventToCanvasOffset?.(event);
  } catch {
    graphPos = null;
  }
  if (!graphPos) return null;
  return [graphPos[0] - (node.pos?.[0] || 0), graphPos[1] - (node.pos?.[1] || 0)];
}

let cursorCaptureInstalled = false;
function installCursorCapture() {
  if (cursorCaptureInstalled) return;
  cursorCaptureInstalled = true;
  const canvasEl = app.canvas?.canvas;
  if (!canvasEl) return;
  canvasEl.addEventListener("mousemove", (event) => {
    const graph = app.graph;
    if (!graph) return;
    const nodes = [...(graph._nodes || [])].reverse();
    for (const node of nodes) {
      if (node.flags?.collapsed) continue;
      let cursor = "";
      if (node.type === SELECTOR_CLASS || node.comfyClass === SELECTOR_CLASS) cursor = selectorCursorAt(node, graphEventToLocal(node, event));
      else if (node.type === TAGGER_CLASS || node.comfyClass === TAGGER_CLASS) cursor = taggerCursorAt(node, graphEventToLocal(node, event));
      else if (node.type === CYCLER_CLASS || node.comfyClass === CYCLER_CLASS) cursor = cyclerCursorAt(node, graphEventToLocal(node, event));
      if (cursor) {
        setCanvasCursor(cursor);
        return;
      }
    }
    setCanvasCursor("");
  });
  canvasEl.addEventListener("mouseleave", () => setCanvasCursor(""));
}

// ---------- Preview ----------
function setupPreviewNode(nodeType) {
  installMinSize(nodeType, 340, 300);
  installCursorCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 340, 300);
    return r;
  };

  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    if (this.flags?.collapsed) return;
    const img = this.__hpsPreview;
    const top = 30;
    const margin = 8;
    const w = Math.max(1, this.size[0] - margin * 2);
    const h = Math.max(1, this.size[1] - top - margin);
    ctx.save();
    if (this.__hpsPreviewCaption) {
      ctx.fillStyle = "#ddd";
      ctx.font = "12px sans-serif";
      ctx.fillText(this.__hpsPreviewCaption, margin, top - 6);
    }
    if (img) {
      let dw = w;
      let dh = dw * (img.height / img.width);
      if (dh > h) {
        dh = h;
        dw = dh * (img.width / img.height);
      }
      const x = margin + (w - dw) / 2;
      const y = top + (h - dh) / 2;
      ctx.drawImage(img, x, y, dw, dh);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fillText("no preview", margin, top + 16);
    }
    ctx.restore();
  };
}

api.addEventListener(PREVIEW_EVENT, ({ detail }) => {
  const node = app.graph?.getNodeById(Number(detail.node));
  if (!node) return;
  if (detail.title) node.title = detail.title;
  node.__hpsPreviewCaption = `${detail.count ?? 0} img · ${detail.columns ?? 0}×${detail.rows ?? 0} · ${detail.width ?? 0}×${detail.height ?? 0}`;
  if (!detail.image) {
    node.__hpsPreview = null;
    app.graph.setDirtyCanvas(true, true);
    return;
  }
  const img = new Image();
  img.onload = () => {
    node.__hpsPreview = img;
    app.graph.setDirtyCanvas(true, true);
  };
  img.src = `data:image/${detail.format};base64,${detail.image}`;
});

// ---------- Selector ----------
const SELECTOR_VISIBLE_ROWS = 20;
const ROW_H = 20;

function selectorWidget(node) {
  return getWidget(node, "checkpoint");
}
function hideSelectorWidget(node) {
  const w = selectorWidget(node);
  if (w) {
    w.type = "hidden";
    w.computeSize = () => [0, -4];
  }
}
function selectorRects(node) {
  const margin = 8;
  return {
    refreshAll: { x: margin, y: 8, w: 100, h: 24 },
    listOnly: { x: 114, y: 8, w: 80, h: 24 },
    pushLocalList: { x: 200, y: 8, w: 148, h: 24 },
    up: { x: 360, y: 8, w: 34, h: 24 },
    down: { x: 400, y: 8, w: 34, h: 24 },
    list: { x: margin, y: 104, w: node.size[0] - 16, h: ROW_H * SELECTOR_VISIBLE_ROWS },
  };
}
function selectorItems(node) { return node.__hpsItems || []; }
function selectorSelected(node) { return selectorWidget(node)?.value || node.__hpsSelected || ""; }
function setSelectorSelected(node, value) {
  const w = selectorWidget(node); if (w) w.value = value;
  node.__hpsSelected = value;
  node.title = value ? `Selector : ${value}` : "Checkpoint List Selector";
}
function selectorStatusText(result, prefix = "") {
  const s = result?.summary || {};
  return `${prefix}${s.total ?? 0} total (💛:${s.favorite ?? 0}, 👍:${s.nice ?? 0}, ✔:${s.keep ?? 0}, 🗑:${s.delete ?? 0}, —:${s.none ?? 0})`;
}
function isNodeClass(node, className) {
  return node && (node.type === className || node.comfyClass === className);
}

function getSelectorReviewTargets(node) {
  const outIndex = node.outputs?.findIndex((o) => o.name === "ckpt_name_str") ?? -1;
  if (outIndex < 0) return { taggers: [], previews: [] };
  const output = node.outputs?.[outIndex];
  const links = output?.links || [];
  const taggers = [];
  const previews = [];
  for (const linkId of links) {
    const link = app.graph?.links?.[linkId];
    if (!link) continue;
    const target = app.graph?.getNodeById?.(link.target_id);
    if (!target) continue;
    const input = target.inputs?.[link.target_slot];
    if (input?.name !== "ckpt_name_str") continue;
    if (isNodeClass(target, TAGGER_CLASS)) taggers.push(target);
    if (isNodeClass(target, "ImageDirPreview")) previews.push(target);
  }
  return { taggers, previews };
}

function selectorActionMode(node) {
  const targets = getSelectorReviewTargets(node);
  return (targets.taggers.length || targets.previews.length) ? "sync" : "push";
}

function selectorActionLabel(node) {
  return selectorActionMode(node) === "sync" ? "🎯 Sync Checkpoint" : "🏹 Push to Local List";
}

async function loadSelector(node, mode = "list") {
  node.__hpsLoading = true; app.graph.setDirtyCanvas(true, true);
  try {
    const path = mode === "refresh" ? `/${EXTENSION_PREFIX}/refresh_all` : `/${EXTENSION_PREFIX}/list_checkpoints`;
  } catch {}
}

const EXTENSION_PREFIX = "checkpoint_handpicker_suite";

async function refreshSelector(node, all = false) {
  node.__hpsLoading = true;
  app.graph.setDirtyCanvas(true, true);
  try {
    const response = await api.fetchApi(`/${EXTENSION_PREFIX}/${all ? "refresh_all" : "list_checkpoints"}`, { method: all ? "POST" : "GET" });
    const result = await response.json();
    node.__hpsItems = result.items || [];
    node.__hpsStatus = result.status_text || selectorStatusText(result);
    if (!selectorSelected(node) && node.__hpsItems.length) setSelectorSelected(node, node.__hpsItems[0].ckpt_name_str);
    const selected = selectorSelected(node);
    if (selected && !node.__hpsItems.find((x) => x.ckpt_name_str === selected) && node.__hpsItems.length) {
      setSelectorSelected(node, node.__hpsItems[0].ckpt_name_str);
    }
    const info = await api.fetchApi("/object_info");
    const objectInfo = await info.json();
    const values = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    if (all && Array.isArray(values)) {
      let updated = 0;
      for (const n of app.graph._nodes || []) {
        for (const w of n.widgets || []) {
          if (["ckpt_name", "checkpoint_name", "start_checkpoint", "checkpoint"].includes(w.name)) {
            if (!w.options) w.options = {};
            w.options.values = values;
            updated++;
          }
        }
      }
      console.log(`[CheckpointHandpickerSuite] Updated checkpoint widgets: ${updated}`);
    }
  } catch (e) {
    node.__hpsStatus = String(e);
  } finally {
    node.__hpsLoading = false;
    app.graph.setDirtyCanvas(true, true);
  }
}
async function pushSelectedToLocalList(node) {
  const selected = selectorSelected(node);
  if (!selected) return;
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/cycler/local_list_append`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ckpt_name_str: selected }),
  });
  const result = await response.json();
  node.__hpsStatus = result.ok
    ? `Pushed to Local List:\n${selected}\n\nUpdated Cyclers:\n${result.updated} Cycler(s)`
    : (result.error || "Push failed");
  app.graph.setDirtyCanvas(true, true);
}

async function syncSelectedCheckpoint(node) {
  const selected = selectorSelected(node);
  if (!selected) return;
  const targets = getSelectorReviewTargets(node);
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/review/sync_checkpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ckpt_name_str: selected,
      tagger_node_ids: targets.taggers.map((n) => n.id),
      preview_node_ids: targets.previews.map((n) => n.id),
    }),
  });
  const result = await response.json();
  if (result.ok) {
    node.__hpsStatus = `Synced Checkpoint:\n${selected}\n\nSynced Tagger:\n${result.taggers} connected Tagger(s)\n\nSynced Preview:\n${result.previews} connected ImageDir Preview(s)`;
  } else {
    node.__hpsStatus = result.error || "Sync failed";
  }
  app.graph.setDirtyCanvas(true, true);
}

function runSelectorAction(node) {
  if (selectorActionMode(node) === "sync") return syncSelectedCheckpoint(node);
  return pushSelectedToLocalList(node);
}

function maxSelectorScroll(node) {
  return Math.max(0, selectorItems(node).length - SELECTOR_VISIBLE_ROWS);
}

function scrollSelector(node, delta) {
  node.__hpsScroll = Math.max(0, Math.min(maxSelectorScroll(node), (node.__hpsScroll || 0) + delta));
  app.graph.setDirtyCanvas(true, true);
}

function selectorScrollbar(node) {
  const items = selectorItems(node);
  if (items.length <= SELECTOR_VISIBLE_ROWS) return null;
  const r = selectorRects(node).list;
  const scroll = Math.max(0, Math.min(node.__hpsScroll || 0, maxSelectorScroll(node)));
  const thumbH = Math.max(24, r.h * (SELECTOR_VISIBLE_ROWS / items.length));
  const range = Math.max(1, maxSelectorScroll(node));
  const y = r.y + (r.h - thumbH) * (scroll / range);
  return {
    track: { x: r.x + r.w - 16, y: r.y, w: 16, h: r.h },
    thumb: { x: r.x + r.w - 12, y, w: 8, h: thumbH },
  };
}

function setSelectorScrollFromScrollbarY(node, localY, thumbH, dragOffset = thumbH / 2) {
  const r = selectorRects(node).list;
  const maxScroll = maxSelectorScroll(node);
  const usable = Math.max(1, r.h - thumbH);
  const y = Math.max(r.y, Math.min(r.y + usable, localY - dragOffset));
  node.__hpsScroll = Math.round(((y - r.y) / usable) * maxScroll);
  app.graph.setDirtyCanvas(true, true);
}

function selectorLocalFromEventOrPos(node, event, pos) {
  const fromEvent = event ? graphEventToLocal(node, event) : null;
  if (fromEvent) return fromEvent;
  return candidatePositions(node, pos)?.[0] || null;
}

let selectorWheelCaptureInstalled = false;
function installSelectorWheelCapture() {
  if (selectorWheelCaptureInstalled) return;
  selectorWheelCaptureInstalled = true;
  const canvasEl = app.canvas?.canvas;
  if (!canvasEl) return;
  canvasEl.addEventListener("wheel", (event) => {
    const canvas = app.canvas;
    const graph = app.graph;
    if (!canvas || !graph) return;
    let graphPos = null;
    try {
      graphPos = canvas.convertEventToCanvasOffset?.(event);
    } catch {
      graphPos = null;
    }
    if (!graphPos) return;
    const nodes = [...(graph._nodes || [])].reverse();
    for (const node of nodes) {
      if (!(node.type === SELECTOR_CLASS || node.comfyClass === SELECTOR_CLASS)) continue;
      if (node.flags?.collapsed) continue;
      const local = [graphPos[0] - (node.pos?.[0] || 0), graphPos[1] - (node.pos?.[1] || 0)];
      if (!hit(local, selectorRects(node).list)) continue;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      scrollSelector(node, event.deltaY > 0 ? 3 : -3);
      return;
    }
  }, { passive: false, capture: true });
}

function selectorCursorAt(node, local) {
  if (!local) return "";
  const r = selectorRects(node);
  if (hit(local, r.refreshAll) || hit(local, r.listOnly) || hit(local, r.pushLocalList)) return node.__hpsLoading ? "wait" : "pointer";
  if ((selectorItems(node).length > SELECTOR_VISIBLE_ROWS) && (hit(local, r.up) || hit(local, r.down))) return "pointer";
  const sb = selectorScrollbar(node);
  if (node.__hpsScrollbarDragging) return "grabbing";
  if (sb && hit(local, sb.thumb)) return "grab";
  if (sb && hit(local, sb.track)) return "pointer";
  if (hit(local, r.list)) {
    const row = Math.floor((local[1] - r.list.y) / ROW_H);
    const idx = (node.__hpsScroll || 0) + row;
    return selectorItems(node)[idx] ? "pointer" : "";
  }
  return "";
}

function setupSelectorNode(nodeType) {
  installMinSize(nodeType, 560, 520);
  installCursorCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 560, 520);
    installSelectorWheelCapture();
    hideSelectorWidget(this);
    this.__hpsItems = [];
    this.__hpsScroll = 0;
    setTimeout(() => refreshSelector(this, false), 0);
    return r;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    hideSelectorWidget(this);
    const r = selectorRects(this);
    drawButton(ctx, r.refreshAll, "🔄 Refresh All", !this.__hpsLoading);
    drawButton(ctx, r.listOnly, "📋 List Only", !this.__hpsLoading);
    drawButton(ctx, r.pushLocalList, selectorActionLabel(this), !this.__hpsLoading);
    drawButton(ctx, r.up, "▲", selectorItems(this).length > SELECTOR_VISIBLE_ROWS);
    drawButton(ctx, r.down, "▼", selectorItems(this).length > SELECTOR_VISIBLE_ROWS);
    ctx.fillStyle = "#ddd";
    ctx.font = "12px sans-serif";
    const statusLines = String(this.__hpsStatus || "").split("\n").slice(0, 4);
    statusLines.forEach((line, i) => ctx.fillText(line, 8, 50 + i * 14));
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(r.list.x, r.list.y, r.list.w, r.list.h);
    ctx.strokeStyle = "rgba(180,220,255,0.35)";
    ctx.strokeRect(r.list.x, r.list.y, r.list.w, r.list.h);
    const items = selectorItems(this);
    const scroll = Math.max(0, Math.min(this.__hpsScroll || 0, Math.max(0, items.length - SELECTOR_VISIBLE_ROWS)));
    this.__hpsScroll = scroll;
    const selected = selectorSelected(this);
    for (let row = 0; row < SELECTOR_VISIBLE_ROWS; row++) {
      const idx = scroll + row;
      const item = items[idx];
      if (!item) continue;
      const y = r.list.y + row * ROW_H;
      if (item.ckpt_name_str === selected) {
        ctx.fillStyle = "rgba(80,120,180,0.65)";
        ctx.fillRect(r.list.x + 1, y + 1, r.list.w - 2, ROW_H - 2);
      }
      ctx.fillStyle = "#e6e6e6";
      ctx.font = "12px monospace";
      ctx.fillText(item.label || item.ckpt_name_str, r.list.x + 8, y + 14, r.list.w - 24);
    }
    const sb = selectorScrollbar(this);
    if (sb) {
      ctx.fillStyle = "rgba(220,220,220,0.18)";
      ctx.fillRect(sb.track.x + 6, sb.track.y, 4, sb.track.h);
      ctx.fillStyle = "rgba(230,230,230,0.55)";
      ctx.fillRect(sb.thumb.x, sb.thumb.y, sb.thumb.w, sb.thumb.h);
    }
  };
  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (e, pos) {
    const r = selectorRects(this);
    if (hitAny(this, pos, r.refreshAll)) { refreshSelector(this, true); return true; }
    if (hitAny(this, pos, r.listOnly)) { refreshSelector(this, false); return true; }
    if (hitAny(this, pos, r.pushLocalList)) { runSelectorAction(this); return true; }
    if (hitAny(this, pos, r.up)) { scrollSelector(this, -SELECTOR_VISIBLE_ROWS); return true; }
    if (hitAny(this, pos, r.down)) { scrollSelector(this, SELECTOR_VISIBLE_ROWS); return true; }
    const sb = selectorScrollbar(this);
    const sbHitPos = sb ? candidatePositions(this, pos).find((p) => hit(p, sb.track)) : null;
    if (sb && sbHitPos) {
      if (hit(sbHitPos, sb.thumb)) {
        this.__hpsScrollbarDragging = true;
        this.__hpsScrollbarDragOffset = sbHitPos[1] - sb.thumb.y;
      } else {
        setSelectorScrollFromScrollbarY(this, sbHitPos[1], sb.thumb.h);
      }
      return true;
    }
    const listHitPos = candidatePositions(this, pos).find((p) => hit(p, r.list));
    if (listHitPos) {
      const row = Math.floor((listHitPos[1] - r.list.y) / ROW_H);
      const idx = (this.__hpsScroll || 0) + row;
      const item = selectorItems(this)[idx];
      if (item) {
        setSelectorSelected(this, item.ckpt_name_str);
        app.graph.setDirtyCanvas(true, true);
      }
      return true;
    }
    return origMouseDown ? origMouseDown.apply(this, arguments) : false;
  };
  const origMouseMove = nodeType.prototype.onMouseMove;
  nodeType.prototype.onMouseMove = function (e, pos) {
    if (this.__hpsScrollbarDragging) {
      const sb = selectorScrollbar(this);
      const local = selectorLocalFromEventOrPos(this, e, pos);
      if (sb && local) setSelectorScrollFromScrollbarY(this, local[1], sb.thumb.h, this.__hpsScrollbarDragOffset || sb.thumb.h / 2);
      return true;
    }
    return origMouseMove ? origMouseMove.apply(this, arguments) : false;
  };
  const origMouseUp = nodeType.prototype.onMouseUp;
  nodeType.prototype.onMouseUp = function () {
    if (this.__hpsScrollbarDragging) {
      this.__hpsScrollbarDragging = false;
      this.__hpsScrollbarDragOffset = 0;
      app.graph.setDirtyCanvas(true, true);
      return true;
    }
    return origMouseUp ? origMouseUp.apply(this, arguments) : false;
  };
  const origConnectionsChange = nodeType.prototype.onConnectionsChange;
  nodeType.prototype.onConnectionsChange = function () {
    app.graph.setDirtyCanvas(true, true);
    return origConnectionsChange ? origConnectionsChange.apply(this, arguments) : undefined;
  };
  const origWheel = nodeType.prototype.onMouseWheel;
  nodeType.prototype.onMouseWheel = function (e, pos) {
    const r = selectorRects(this).list;
    if (hitAny(this, pos, r)) {
      e?.preventDefault?.(); e?.stopPropagation?.();
      scrollSelector(this, e.deltaY > 0 ? 3 : -3);
      return true;
    }
    return origWheel ? origWheel.apply(this, arguments) : false;
  };
}

// ---------- Tagger ----------
const TAGGER_STATUSES = ["favorite", "nice", "keep", "delete"];
function currentTaggerPath(node) {
  return node.__hpsTaggerPath || getWidget(node, "ckpt_name_str")?.value || "";
}
function taggerButtons(node) {
  const buttonW = 72;
  const gap = 6;
  const rightMargin = 12;
  const totalW = TAGGER_STATUSES.length * buttonW + (TAGGER_STATUSES.length - 1) * gap;
  const startX = Math.max(120, (node.size?.[0] || 450) - rightMargin - totalW);
  return TAGGER_STATUSES.map((status, i) => ({
    status,
    x: startX + i * (buttonW + gap),
    y: 5,
    w: buttonW,
    h: 24,
  }));
}

function taggerDeleteEnabled(node) {
  const current = node.__hpsTaggerStatus || "none";
  return current === "none" || current === "delete";
}
async function setTaggerStatus(node, status) {
  const ckpt = currentTaggerPath(node);
  if (!ckpt) return;
  if (status === "delete" && !taggerDeleteEnabled(node)) return;
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/tagger/set_status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ckpt_name_str: ckpt, status }),
  });
  const result = await response.json();
  if (result.ok) {
    node.__hpsTaggerStatus = result.status;
    node.__hpsTaggerMessage = result.status === "none" ? "Current: — none" : `Current: ${STATUS_ICON[result.status]} ${STATUS_LABEL[result.status]}`;
    node.title = result.status === "none" ? `Tagger : ${ckpt}` : `Tagger : ${STATUS_ICON[result.status]} ${ckpt}`;
  } else {
    node.__hpsTaggerMessage = result.error || "Failed";
  }
  app.graph.setDirtyCanvas(true, true);
}
function taggerCursorAt(node, local) {
  if (!local) return "";
  for (const b of taggerButtons(node)) {
    if (!hit(local, b)) continue;
    if (b.status === "delete" && !taggerDeleteEnabled(node)) return "not-allowed";
    return "pointer";
  }
  return "";
}

function setupTaggerNode(nodeType) {
  installMinSize(nodeType, 450, 100);
  installCursorCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 450, 100);
    return r;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    ctx.save();
    const current = this.__hpsTaggerStatus || "none";
    for (const b of taggerButtons(this)) {
      const enabled = b.status !== "delete" || taggerDeleteEnabled(this);
      const buttonColor = b.status === "delete" && enabled ? "rgba(105,90,90,0.65)" : null;
      drawButton(
        ctx,
        b,
        `${STATUS_ICON[b.status]} ${STATUS_LABEL[b.status]}`,
        enabled,
        current === b.status,
        buttonColor,
        { textColor: enabled ? undefined : "#888" }
      );
    }
    const p = currentTaggerPath(this);
    ctx.fillStyle = "#ddd";
    ctx.font = "12px sans-serif";
    ctx.fillText(p ? p : "Execute once to bind current checkpoint.", 8, 54);
    const msg = this.__hpsTaggerMessage || (current === "none" ? "Current: — none" : `Current: ${STATUS_ICON[current]} ${STATUS_LABEL[current]}`);
    ctx.fillStyle = current === "none" ? "#888" : "#ddd";
    ctx.fillText(msg, 8, 72);
    if (this.size[1] >= 110 && current !== "none" && current !== "delete") {
      ctx.fillStyle = "#aaa";
      ctx.fillText("Delete is available only from none.", 8, 90);
    }
    ctx.restore();
  };
  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (e, pos) {
    for (const b of taggerButtons(this)) {
      if (hitAny(this, pos, b)) {
        if (b.status === "delete" && !taggerDeleteEnabled(this)) return true;
        setTaggerStatus(this, b.status);
        return true;
      }
    }
    return origMouseDown ? origMouseDown.apply(this, arguments) : false;
  };
}
api.addEventListener(TAGGER_EVENT, ({ detail }) => {
  const node = app.graph?.getNodeById(Number(detail.node));
  if (!node) return;
  node.__hpsTaggerPath = detail.ckpt_name_str;
  node.__hpsTaggerStatus = detail.status;
  node.__hpsTaggerMessage = detail.status === "none" ? "Current: — none" : `Current: ${STATUS_ICON[detail.status]} ${STATUS_LABEL[detail.status]}`;
  if (detail.title) node.title = detail.title;
  app.graph.setDirtyCanvas(true, true);
});
api.addEventListener(STATUS_CHANGED_EVENT, ({ detail }) => {
  for (const node of app.graph?._nodes || []) {
    if (node.type === SELECTOR_CLASS || node.comfyClass === SELECTOR_CLASS) {
      refreshSelector(node, false);
    }
    if ((node.type === TAGGER_CLASS || node.comfyClass === TAGGER_CLASS) && node.__hpsTaggerPath === detail.ckpt_name_str) {
      node.__hpsTaggerStatus = detail.status;
      node.__hpsTaggerMessage = detail.status === "none" ? "Current: — none" : `Current: ${STATUS_ICON[detail.status]} ${STATUS_LABEL[detail.status]}`;
      app.graph.setDirtyCanvas(true, true);
    }
  }
});

// ---------- Cycler ----------
const CYCLER_FILTER_STATUSES = ["favorite", "nice", "keep", "delete", "none"];
function cyclerRects(node) {
  const filterY = 35;
  const filter = [{ status: "all", x: 8, y: filterY, w: 54, h: 24 }];
  CYCLER_FILTER_STATUSES.forEach((status, i) => filter.push({ status, x: 68 + i * 48, y: filterY, w: 42, h: 24 }));
  return {
    localListToggle: { x: 8, y: 4, w: 122, h: 24 },
    clearLocalList: { x: 136, y: 4, w: 122, h: 24 },
    filter,
    statusBox: { x: 8, y: 140, w: node.size[0] - 16, h: Math.max(80, node.size[1] - 150) },
  };
}
function cyclerActiveFilter(node) {
  return node.__hpsFilterStatuses || [];
}
async function pushCyclerFlags(node) {
  await api.fetchApi(`/${EXTENSION_PREFIX}/cycler/set_flags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: node.id, use_local_list: !!node.__hpsUseLocalList }),
  });
}
async function pushCyclerFilter(node) {
  await api.fetchApi(`/${EXTENSION_PREFIX}/cycler/set_filter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: node.id, statuses: cyclerActiveFilter(node) }),
  });
}
async function clearLocalList(node) {
  await api.fetchApi(`/${EXTENSION_PREFIX}/cycler/clear_local_list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: node.id }),
  });
}
function cyclerCursorAt(node, local) {
  if (!local) return "";
  const r = cyclerRects(node);
  if (hit(local, r.localListToggle) || hit(local, r.clearLocalList)) return "pointer";
  for (const b of r.filter) {
    if (hit(local, b)) return "pointer";
  }
  return "";
}

function setupCyclerNode(nodeType) {
  installMinSize(nodeType, 560, 260);
  installCursorCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 560, 260);
    this.__hpsUseLocalList = true;
    this.__hpsFilterStatuses = [];
    setTimeout(() => { pushCyclerFlags(this); pushCyclerFilter(this); }, 0);
    return r;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    const r = cyclerRects(this);
    drawButton(ctx, r.localListToggle, this.__hpsUseLocalList ? "☑ Use Local List" : "☐ Use Local List", true, this.__hpsUseLocalList);
    drawButton(ctx, r.clearLocalList, "Clear Local List", true, false);
    const active = cyclerActiveFilter(this);
    for (const b of r.filter) {
      if (b.status === "all") drawButton(ctx, b, "All", true, active.length === 0);
      else drawButton(ctx, b, STATUS_ICON[b.status], true, active.includes(b.status));
    }
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(r.statusBox.x, r.statusBox.y, r.statusBox.w, r.statusBox.h);
    ctx.fillStyle = "#ddd";
    ctx.font = "12px monospace";
    const lines = (this.__hpsCyclerStatus || "Current: (not executed yet)").split("\n");
    lines.forEach((line, i) => ctx.fillText(line, r.statusBox.x + 8, r.statusBox.y + 18 + i * 14));
    ctx.restore();
  };
  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (e, pos) {
    const r = cyclerRects(this);
    if (hitAny(this, pos, r.localListToggle)) {
      this.__hpsUseLocalList = !this.__hpsUseLocalList;
      pushCyclerFlags(this);
      app.graph.setDirtyCanvas(true, true);
      return true;
    }
    if (hitAny(this, pos, r.clearLocalList)) {
      clearLocalList(this);
      return true;
    }
    for (const b of r.filter) {
      if (!hitAny(this, pos, b)) continue;
      if (b.status === "all") {
        this.__hpsFilterStatuses = [];
      } else {
        const set = new Set(this.__hpsFilterStatuses || []);
        if (set.has(b.status)) set.delete(b.status); else set.add(b.status);
        this.__hpsFilterStatuses = CYCLER_FILTER_STATUSES.filter((x) => set.has(x));
      }
      pushCyclerFilter(this);
      app.graph.setDirtyCanvas(true, true);
      return true;
    }
    return origMouseDown ? origMouseDown.apply(this, arguments) : false;
  };
}
api.addEventListener(CYCLER_EVENT, ({ detail }) => {
  const node = app.graph?.getNodeById(Number(detail.node));
  if (!node) return;
  if (detail.title) node.title = detail.title;
  node.__hpsCyclerStatus = detail.status_text;
  app.graph.setDirtyCanvas(true, true);
});

app.registerExtension({
  name: EXT,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (PREVIEW_CLASSES.has(nodeData.name)) return setupPreviewNode(nodeType);
    if (nodeData.name === SELECTOR_CLASS) return setupSelectorNode(nodeType);
    if (nodeData.name === TAGGER_CLASS) return setupTaggerNode(nodeType);
    if (nodeData.name === CYCLER_CLASS) return setupCyclerNode(nodeType);
  },
});
