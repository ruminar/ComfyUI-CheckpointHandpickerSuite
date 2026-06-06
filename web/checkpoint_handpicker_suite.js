import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// v8c: v8b/v8a conservative rebuild with ListSelector/Cycler/Tagger UI-state fixes.
const EXT = "ruminar.checkpoint_handpicker_suite";
const PREVIEW_EVENT = "ruminar.checkpoint_handpicker_suite.preview";
const CYCLER_EVENT = "ruminar.checkpoint_handpicker_suite.cycler";
const TAGGER_EVENT = "ruminar.checkpoint_handpicker_suite.tagger";
const STATUS_CHANGED_EVENT = "ruminar.checkpoint_handpicker_suite.status_changed";

const SELECTOR_CLASS = "CheckpointListSelector";
const CYCLER_CLASS = "CheckpointNameCycler";
const TAGGER_CLASS = "CheckpointStatusTagger";
const PREVIEW_CLASSES = new Set(["EphemeralPreview", "ImageDirPreview"]);

const HPS_TAB_ID = (globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function hpsExecutionStore() {
  globalThis.__hpsExecutionState = globalThis.__hpsExecutionState || {};
  return globalThis.__hpsExecutionState;
}

function getExecutionState() {
  return hpsExecutionStore()[HPS_TAB_ID] || null;
}

function setExecutionState(detail) {
  if (!detail?.ckpt_name_str) return;
  const status = detail.status || "none";
  hpsExecutionStore()[HPS_TAB_ID] = {
    ckpt_name_str: detail.ckpt_name_str,
    status,
    status_icon: detail.status_icon || STATUS_ICON[status] || "",
    cycler_node_id: detail.node ?? null,
    source: detail.source || "",
    mode: detail.mode || "",
    updated_at: Date.now(),
  };
}

function titleDisplayForCheckpoint(ckptName, status = "none") {
  if (!ckptName) return "";
  const icon = STATUS_ICON[status] || "";
  return status && status !== "none" ? `${icon} ${ckptName}` : ckptName;
}

function setPreviewTitleFromCheckpoint(node, ckptName, status = "none") {
  if (!node || !ckptName) return;
  node.title = `Preview : ${titleDisplayForCheckpoint(ckptName, status)}`;
}

function patchCheckpointTitle(node, prefix, ckptName, status = "none") {
  if (!node || !ckptName) return;
  const oldTitle = String(node.title || "");
  const idx = oldTitle.indexOf(ckptName);
  const suffix = idx >= 0 ? oldTitle.slice(idx + ckptName.length) : "";
  node.title = `${prefix} : ${titleDisplayForCheckpoint(ckptName, status)}${suffix}`;
}

const STATUS_ORDER = ["favorite", "nice", "keep", "delete", "none"];
const STATUS_ICON = { favorite: "💛", nice: "👍", keep: "✔", delete: "🗑", none: "—" };
const STATUS_LABEL = { favorite: "favorite", nice: "nice", keep: "keep", delete: "delete", none: "none" };

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

let lastCheckpointValues = null;

function getNodeTypeName(node) {
  return String(node?.type ?? node?.comfyClass ?? node?.constructor?.type ?? "");
}

function getNodeDataName(nodeData) {
  return String(nodeData?.name ?? "");
}

function findWidget(node, name) {
  return (node?.widgets ?? []).find((widget) => widget?.name === name);
}

function findComboWidget(node, name) {
  const widget = findWidget(node, name);
  if (!widget) return null;
  if (Array.isArray(widget?.options?.values) || widget?.type === "combo") return widget;
  return null;
}

function findCheckpointWidget(node) {
  return findComboWidget(node, "ckpt_name")
    || findComboWidget(node, "checkpoint")
    || findComboWidget(node, "checkpoint_name");
}

function findStartCheckpointWidget(node) {
  return findComboWidget(node, "start_checkpoint");
}

function outputNames(node) {
  return (node?.outputs ?? []).map((output) => String(output?.name ?? "").toLowerCase());
}

function hasSelectorOutputs(node) {
  const names = outputNames(node);
  return names.includes("ckpt_name") && names.includes("ckpt_name_str");
}

function hasLoaderOutputs(node) {
  const names = outputNames(node);
  return names.includes("model") && names.includes("clip") && names.includes("vae");
}

function isCheckpointSelectorLikeNode(node) {
  if (!node) return false;
  const typeName = getNodeTypeName(node);
  if (typeName.includes("CheckpointNameSelector")) return true;
  if (typeName === "CheckpointLoaderSimple") return true;
  if (hasSelectorOutputs(node) && Boolean(findCheckpointWidget(node))) return true;
  if (hasLoaderOutputs(node) && Boolean(findCheckpointWidget(node))) return true;
  return false;
}

function chooseCheckpointReplacement(oldValues, newValues, currentValue) {
  if (!Array.isArray(newValues) || newValues.length === 0) return "";
  if (newValues.includes(currentValue)) return currentValue;

  const oldIndex = Array.isArray(oldValues) ? oldValues.indexOf(currentValue) : -1;
  if (oldIndex >= 0) {
    for (let index = oldIndex + 1; index < oldValues.length; index++) {
      const candidate = oldValues[index];
      if (newValues.includes(candidate)) return candidate;
    }
    for (let index = oldIndex - 1; index >= 0; index--) {
      const candidate = oldValues[index];
      if (newValues.includes(candidate)) return candidate;
    }
    return newValues[Math.min(oldIndex, newValues.length - 1)] ?? newValues[0];
  }
  return newValues[0];
}

function arraysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isCheckpointSlotName(name) {
  const text = String(name ?? "").toLowerCase();
  return text.includes("ckpt") || text.includes("checkpoint");
}

function patchCheckpointSlotTypes(node, checkpoints) {
  const values = [...(checkpoints || [])];

  for (const output of node?.outputs ?? []) {
    if (!isCheckpointSlotName(output?.name)) continue;

    output.type = [...values];

    const links = Array.isArray(output.links) ? output.links : [];
    for (const linkId of links) {
      const link = app.graph?.links?.[linkId];
      if (!link) continue;
      const targetNode = app.graph?.getNodeById?.(link.target_id);
      const targetInput = targetNode?.inputs?.[link.target_slot];
      if (targetInput && isCheckpointSlotName(targetInput.name)) {
        targetInput.type = [...values];
      }
    }
  }

  for (const input of node?.inputs ?? []) {
    if (isCheckpointSlotName(input?.name)) {
      input.type = [...values];
    }
  }
}

function updateCheckpointComboWidget(node, widget, checkpoints) {
  if (!widget || !Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { changed: false, valueChanged: false, oldValue: widget?.value, newValue: widget?.value };
  }

  if (!widget.options) widget.options = {};
  const oldValues = Array.isArray(widget.options.values) ? [...widget.options.values] : [];
  const oldValue = widget.value;
  const newValues = [...checkpoints];
  const newValue = chooseCheckpointReplacement(oldValues, newValues, oldValue);

  widget.options.values = newValues;
  widget.value = newValue;

  const valuesChanged = !arraysEqual(oldValues, newValues);
  const valueChanged = oldValue !== newValue;

  if (valueChanged && typeof widget.callback === "function") {
    try {
      widget.callback(widget.value);
    } catch (error) {
      console.warn("[CheckpointHandpickerSuite] checkpoint widget callback failed", error);
    }
  }

  if (valuesChanged || valueChanged) {
    node?.setDirtyCanvas?.(true, true);
  }

  return { changed: valuesChanged || valueChanged, valueChanged, oldValue, newValue };
}

function applyCheckpointListToWidgetNode(node, checkpoints) {
  if (!isCheckpointSelectorLikeNode(node)) {
    return { matched: false, changed: false, valueChanged: false };
  }
  const widget = findCheckpointWidget(node);
  if (!widget) {
    patchCheckpointSlotTypes(node, checkpoints);
    return { matched: true, changed: false, valueChanged: false, reason: "checkpoint widget not found" };
  }
  const result = updateCheckpointComboWidget(node, widget, checkpoints);
  patchCheckpointSlotTypes(node, checkpoints);
  return { matched: true, ...result };
}

function applyCheckpointListToCyclerNode(node, checkpoints) {
  if (!isNodeClass(node, CYCLER_CLASS)) {
    return { matched: false, changed: false, valueChanged: false };
  }
  const widget = findStartCheckpointWidget(node);
  if (!widget) {
    patchCheckpointSlotTypes(node, checkpoints);
    node?.setDirtyCanvas?.(true, true);
    return { matched: true, changed: false, valueChanged: false, reason: "start_checkpoint widget not found" };
  }
  const result = updateCheckpointComboWidget(node, widget, checkpoints);
  patchCheckpointSlotTypes(node, checkpoints);
  return { matched: true, ...result };
}

function applyCheckpointValuesToGraph(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { widgetMatched: 0, widgetChanged: 0, valueChanged: 0, cyclerMatched: 0, cyclerChanged: 0, cyclerValueChanged: 0 };
  }

  let widgetMatched = 0;
  let widgetChanged = 0;
  let valueChanged = 0;
  let cyclerMatched = 0;
  let cyclerChanged = 0;
  let cyclerValueChanged = 0;

  for (const node of app.graph?._nodes ?? []) {
    const widgetResult = applyCheckpointListToWidgetNode(node, checkpoints);
    if (widgetResult.matched) {
      widgetMatched += 1;
      if (widgetResult.changed) widgetChanged += 1;
      if (widgetResult.valueChanged) {
        valueChanged += 1;
        console.log(
          `[CheckpointHandpickerSuite] ${getNodeTypeName(node)} #${node.id}: `
          + `${widgetResult.oldValue} -> ${widgetResult.newValue}`
        );
      }
    }

    const cyclerResult = applyCheckpointListToCyclerNode(node, checkpoints);
    if (cyclerResult.matched) {
      cyclerMatched += 1;
      if (cyclerResult.changed) cyclerChanged += 1;
      if (cyclerResult.valueChanged) cyclerValueChanged += 1;
    }
  }

  app.graph?.setDirtyCanvas?.(true, true);
  return { widgetMatched, widgetChanged, valueChanged, cyclerMatched, cyclerChanged, cyclerValueChanged };
}

async function checkpointValuesFromObjectInfoFallback() {
  try {
    const info = await api.fetchApi("/object_info", { cache: "no-store" });
    if (!info.ok) return [];
    const objectInfo = await info.json();
    const loaderValues = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    if (Array.isArray(loaderValues)) return loaderValues;
    const cyclerValues = objectInfo?.CheckpointNameCycler?.input?.required?.start_checkpoint?.[0];
    if (Array.isArray(cyclerValues)) return cyclerValues;
  } catch (error) {
    console.warn("[CheckpointHandpickerSuite] object_info fallback failed", error);
  }
  return [];
}

async function checkpointValuesFromRefreshPayload(result) {
  if (Array.isArray(result?.checkpoint_values) && result.checkpoint_values.length) {
    return result.checkpoint_values;
  }
  const fallback = await checkpointValuesFromObjectInfoFallback();
  if (fallback.length) return fallback;
  if (Array.isArray(result?.items)) return result.items.map((item) => item.ckpt_name_str).filter(Boolean);
  return [];
}

function installCheckpointRefreshFuturePatch(nodeType, nodeData) {
  const name = getNodeDataName(nodeData);
  if (
    name !== CYCLER_CLASS
    && name !== "CheckpointLoaderSimple"
    && !name.includes("CheckpointNameSelector")
    && !name.includes("CheckpointListSelector")
  ) {
    return;
  }

  if (nodeType.prototype.__hpsCheckpointRefreshFuturePatchInstalled) return;
  nodeType.prototype.__hpsCheckpointRefreshFuturePatchInstalled = true;

  const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function (...args) {
    const result = originalOnNodeCreated?.apply(this, args);
    if (lastCheckpointValues) {
      setTimeout(() => {
        applyCheckpointListToWidgetNode(this, lastCheckpointValues);
        applyCheckpointListToCyclerNode(this, lastCheckpointValues);
        app.graph?.setDirtyCanvas?.(true, true);
      }, 0);
    }
    return result;
  };
}

function isNodeClass(node, className) {
  return node && (node.type === className || node.comfyClass === className);
}

function tabPayload(payload = {}) {
  return { ...payload, tab_id: HPS_TAB_ID };
}

function isForThisTab(detail) {
  return detail?.scope === "global" || detail?.tab_id === HPS_TAB_ID;
}

function nodeFromEvent(detail, className) {
  if (!isForThisTab(detail)) return null;
  const node = app.graph?.getNodeById(Number(detail?.node));
  if (!isNodeClass(node, className)) return null;
  return node;
}

function ensureHiddenWidgetValue(node, name, value) {
  let w = getWidget(node, name);
  if (!w && typeof node?.addWidget === "function") {
    try {
      w = node.addWidget("text", name, value ?? "", () => {}, {});
      w.serialize = true;
    } catch (error) {
      console.warn("[CheckpointHandpickerSuite] failed to add hidden widget", name, error);
    }
  }
  if (!w) return false;
  if (value !== undefined) w.value = value;

  w.type = "hidden";
  w.hidden = true;
  w.disabled = true;
  w.serialize = true;
  w.options = { ...(w.options || {}), hidden: true };
  w.computeSize = () => [0, -4];
  w.draw = () => {};
  return true;
}

const CYCLER_FILTER_STATUSES = ["favorite", "nice", "keep", "delete", "none"];

function normalizeCyclerFilterStatuses(value) {
  let raw = value;
  if (Array.isArray(raw)) {
    // already usable
  } else {
    const text = String(raw ?? "").trim();
    if (!text) return [];
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text.split(",").map((x) => x.trim());
    }
  }
  if (typeof raw === "string") raw = [raw];
  if (!Array.isArray(raw)) return [];
  const set = new Set(raw.map((x) => String(x).trim()).filter((x) => CYCLER_FILTER_STATUSES.includes(x)));
  return CYCLER_FILTER_STATUSES.filter((x) => set.has(x));
}

function serializeCyclerFilterStatuses(statuses) {
  return JSON.stringify(normalizeCyclerFilterStatuses(statuses));
}

function statusIconDisplay(statuses) {
  const normalized = normalizeCyclerFilterStatuses(statuses);
  return normalized.length ? normalized.map((status) => STATUS_ICON[status] || status).join("") : "all";
}

function applyCyclerStatePayload(node, detail) {
  if (!node || !detail) return;
  if (detail.active_filter !== undefined) {
    node.__hpsFilterStatuses = normalizeCyclerFilterStatuses(detail.active_filter);
  }
  if (detail.use_local_list !== undefined) {
    node.__hpsUseLocalList = !!detail.use_local_list;
  }
  if (detail.settings_revision !== undefined) {
    node.__hpsSettingsRevision = parseSavedInt(detail.settings_revision, node.__hpsSettingsRevision ?? 0);
  }
  if (detail.ckpt_name_str) {
    node.__hpsCyclerCkptName = detail.ckpt_name_str;
    node.__hpsCyclerStatusValue = detail.status || "none";
    setExecutionState(detail);
  }
  if (detail.status_text !== undefined) {
    node.__hpsCyclerStatus = detail.status_text;
  }
  if (detail.title) {
    node.title = detail.title;
  }
  syncCyclerSettingsWidgets(node);
}

function parseSavedBool(value, fallback) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function parseSavedInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function bumpCyclerSettingsRevision(node) {
  node.__hpsSettingsRevision = Math.max(0, parseSavedInt(node.__hpsSettingsRevision, 0)) + 1;
  return node.__hpsSettingsRevision;
}

function validCyclerMode(value) {
  return ["fixed", "increment", "randomize", "shuffle_once"].includes(String(value || "")) ? String(value) : "increment";
}

function validChangeEvery(value) {
  const n = Number.parseInt(String(value ?? "1"), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function getCyclerRuntimeControls(node) {
  return {
    mode: validCyclerMode(getWidget(node, "mode")?.value),
    change_every: validChangeEvery(getWidget(node, "change_every")?.value),
    start_checkpoint: String(getWidget(node, "start_checkpoint")?.value ?? ""),
  };
}

function setWidgetValueIfDifferent(node, name, value) {
  const widget = getWidget(node, name);
  if (!widget) return false;
  if (String(widget.value ?? "") === String(value ?? "")) return false;
  widget.value = value;
  return true;
}

function ensureHiddenTabIdWidget(node) {
  return ensureHiddenWidgetValue(node, "hps_tab_id", HPS_TAB_ID);
}

function restoreCyclerSettingsFromWidgets(node) {
  const filterWidget = getWidget(node, "hps_filter_statuses");
  const filterText = String(filterWidget?.value ?? "").trim();
  if (filterText) {
    node.__hpsFilterStatuses = normalizeCyclerFilterStatuses(filterText);
  } else if (!Array.isArray(node.__hpsFilterStatuses)) {
    node.__hpsFilterStatuses = [];
  }

  const useLocalWidget = getWidget(node, "hps_use_local_list");
  node.__hpsUseLocalList = parseSavedBool(useLocalWidget?.value, node.__hpsUseLocalList ?? true);

  const revisionWidget = getWidget(node, "hps_settings_revision");
  node.__hpsSettingsRevision = parseSavedInt(revisionWidget?.value, node.__hpsSettingsRevision ?? 0);

  ensureHiddenWidgetValue(node, "hps_filter_statuses", serializeCyclerFilterStatuses(node.__hpsFilterStatuses));
  ensureHiddenWidgetValue(node, "hps_use_local_list", node.__hpsUseLocalList ? "true" : "false");
  ensureHiddenWidgetValue(node, "hps_settings_revision", String(node.__hpsSettingsRevision ?? 0));
}

function syncCyclerSettingsWidgets(node) {
  ensureHiddenWidgetValue(node, "hps_filter_statuses", serializeCyclerFilterStatuses(node.__hpsFilterStatuses || []));
  ensureHiddenWidgetValue(node, "hps_use_local_list", node.__hpsUseLocalList ? "true" : "false");
  ensureHiddenWidgetValue(node, "hps_settings_revision", String(node.__hpsSettingsRevision ?? 0));
}

function scheduleHideTabIdWidget(node) {
  ensureHiddenTabIdWidget(node);
  setTimeout(() => {
    if (ensureHiddenTabIdWidget(node)) app.graph?.setDirtyCanvas?.(true, true);
  }, 0);
  setTimeout(() => {
    if (ensureHiddenTabIdWidget(node)) app.graph?.setDirtyCanvas?.(true, true);
  }, 100);
}

function installTabIdSupport(nodeType) {
  if (nodeType.prototype.__hpsTabIdInstalled) return;
  nodeType.prototype.__hpsTabIdInstalled = true;
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    scheduleHideTabIdWidget(this);
    return r;
  };
  const origAdded = nodeType.prototype.onAdded;
  nodeType.prototype.onAdded = function () {
    const r = origAdded ? origAdded.apply(this, arguments) : undefined;
    scheduleHideTabIdWidget(this);
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    scheduleHideTabIdWidget(this);
    return r;
  };
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

function hpsNodeCollapsed(node) {
  return Boolean(node?.flags?.collapsed);
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

// ---------- Backend state restore ----------
async function restoreNodeStateFromBackend(node, nodeClass) {
  if (!node || !nodeClass) return;
  try {
    const query = new URLSearchParams({ node_id: String(node.id), node_class: nodeClass, tab_id: HPS_TAB_ID });
    const response = await api.fetchApi(`/${EXTENSION_PREFIX}/node_state?${query.toString()}`, { cache: "no-store" });
    if (!response.ok) return;
    const result = await response.json();
    if (!result?.ok) return;

    if (nodeClass === "EphemeralPreview") {
      if (result.ckpt_name_str) {
        node.__hpsPreviewCkptName = result.ckpt_name_str;
        node.__hpsPreviewStatus = result.status || "none";
        setPreviewTitleFromCheckpoint(node, result.ckpt_name_str, result.status || "none");
      }
    } else if (nodeClass === TAGGER_CLASS) {
      if (result.ckpt_name_str) {
        node.__hpsTaggerPath = result.ckpt_name_str;
        node.__hpsTaggerStatus = result.status || "none";
        node.__hpsTaggerMessage = node.__hpsTaggerStatus === "none"
          ? "Current: — none"
          : `Current: ${STATUS_ICON[node.__hpsTaggerStatus]} ${STATUS_LABEL[node.__hpsTaggerStatus]}`;
        node.title = node.__hpsTaggerStatus === "none"
          ? `Tagger : ${result.ckpt_name_str}`
          : `Tagger : ${STATUS_ICON[node.__hpsTaggerStatus]} ${result.ckpt_name_str}`;
      }
    } else if (nodeClass === CYCLER_CLASS) {
      applyCyclerStatePayload(node, result);
    }
    app.graph?.setDirtyCanvas?.(true, true);
  } catch (error) {
    // Older Python side versions did not expose node_state. Ignore quietly.
  }
}

// ---------- Preview ----------
function setupPreviewNode(nodeType) {
  installMinSize(nodeType, 340, 300);
  installTabIdSupport(nodeType);
  installCursorCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 340, 300);
    if (isNodeClass(this, "EphemeralPreview")) setTimeout(() => restoreNodeStateFromBackend(this, "EphemeralPreview"), 0);
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    if (isNodeClass(this, "EphemeralPreview")) setTimeout(() => restoreNodeStateFromBackend(this, "EphemeralPreview"), 0);
    return r;
  };

  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    ensureHiddenTabIdWidget(this);
    if (this.flags?.collapsed) return;
    const img = this.__hpsPreview;
    const isImageDir = isNodeClass(this, "ImageDirPreview");
    const top = isImageDir ? 72 : 30;
    const margin = 8;
    const messageX = Math.min(140, Math.max(margin, this.size[0] - 80));
    const captionY = isImageDir ? 36 : 20;
    const messageW = Math.max(1, this.size[0] - messageX - margin);
    const w = Math.max(1, this.size[0] - margin * 2);
    const h = Math.max(1, this.size[1] - top - margin);
    ctx.save();
    if (this.__hpsPreviewCaption) {
      const st = this.__hpsPreviewState || {};
      const isWarning = st.status && !["ready", "loading"].includes(st.status);
      if (isImageDir) {
        ctx.fillStyle = isWarning ? "rgba(255,180,80,0.18)" : "rgba(0,0,0,0.18)";
        ctx.fillRect(messageX - 4, captionY - 13, messageW + 4, 18);
      }
      ctx.fillStyle = isWarning ? "#FFD28A" : "#ddd";
      ctx.font = "12px sans-serif";
      ctx.fillText(this.__hpsPreviewCaption, messageX, captionY, messageW);
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
      const st = this.__hpsPreviewState || {};
      const isLoading = st.status === "loading" || !!st.progress;
      if (!isLoading) {
        const text = this.__hpsPreviewCaption || "no preview";
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, this.size[0] / 2, top + h / 2, Math.max(1, w - 16));
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
      }
    }
    ctx.restore();
  };
}

api.addEventListener(PREVIEW_EVENT, ({ detail }) => {
  if (!isForThisTab(detail)) return;
  const node = app.graph?.getNodeById(Number(detail?.node));
  if (!node || !PREVIEW_CLASSES.has(node.type || node.comfyClass)) return;
  if (detail.node_class && !isNodeClass(node, detail.node_class)) return;

  const isEphemeral = isNodeClass(node, "EphemeralPreview");
  if (isEphemeral && detail.image) {
    const execution = getExecutionState();
    const ckptName = detail.ckpt_name_str || execution?.ckpt_name_str || "";
    if (ckptName) {
      node.__hpsPreviewCkptName = ckptName;
      node.__hpsPreviewStatus = detail.status || execution?.status || "none";
      node.__hpsPreviewStatusIcon = detail.status_icon || execution?.status_icon || STATUS_ICON[node.__hpsPreviewStatus] || "";
      if (detail.title) node.title = detail.title;
      else setPreviewTitleFromCheckpoint(node, node.__hpsPreviewCkptName, node.__hpsPreviewStatus);
    } else {
      node.title = "Ephemeral Preview";
    }
  } else if (detail.title) {
    node.title = detail.title;
  }

  node.__hpsPreviewState = { ...(node.__hpsPreviewState || {}), ...detail };
  const caption = detail.progress_message || detail.message || `${detail.count ?? 0} img · ${detail.columns ?? 0}×${detail.rows ?? 0} · ${detail.width ?? 0}×${detail.height ?? 0}`;
  node.__hpsPreviewCaption = caption;
  if (!detail.image) {
    if (!detail.progress) node.__hpsPreview = null;
    app.graph.setDirtyCanvas(true, true);
    return;
  }
  const img = new Image();
  img.onload = () => {
    node.__hpsPreview = img;
    node.__hpsPreviewCaption = detail.progress_message || detail.message || node.__hpsPreviewCaption;
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

function stringValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function firstWidgetValue(node, preferredSlot = null, seen = new Set()) {
  if (!node || seen.has(node.id)) return "";
  seen.add(node.id);

  const widgets = node.widgets || [];
  const preferredNames = new Set(["text", "string", "value", "search_directory", "directory", "path"]);

  if (preferredSlot != null && widgets[preferredSlot]) {
    const v = stringValue(widgets[preferredSlot].value).trim();
    if (v) return v;
  }

  for (const w of widgets) {
    const name = String(w?.name || "").toLowerCase();
    if (name === "hps_tab_id" || w?.hidden) continue;
    if (!preferredNames.has(name)) continue;
    const v = stringValue(w.value).trim();
    if (v) return v;
  }

  for (const w of widgets) {
    const name = String(w?.name || "").toLowerCase();
    if (name === "hps_tab_id" || w?.hidden) continue;
    const v = stringValue(w.value).trim();
    if (v) return v;
  }

  for (const v of node.widgets_values || []) {
    const s = stringValue(v).trim();
    if (s) return s;
  }

  const props = node.properties || {};
  for (const key of ["value", "text", "string", "search_directory", "directory", "path"]) {
    const s = stringValue(props[key]).trim();
    if (s) return s;
  }

  const type = String(node.type || node.comfyClass || "").toLowerCase();
  if (type.includes("reroute") || type.includes("relay")) {
    return linkedInputValue(node, node.inputs?.[0]?.name || "", seen);
  }

  return "";
}

function linkedInputValue(node, inputName, seen = new Set()) {
  const index = node.inputs?.findIndex((i) => i.name === inputName) ?? -1;
  if (index < 0) return "";
  const linkId = node.inputs?.[index]?.link;
  if (linkId == null) return "";
  const link = app.graph?.links?.[linkId];
  const source = link ? app.graph?.getNodeById?.(link.origin_id) : null;
  if (!source) return "";
  return firstWidgetValue(source, link?.origin_slot, seen);
}

function imageDirSearchDirectory(node) {
  const direct = stringValue(getWidget(node, "search_directory")?.value).trim();
  if (direct) return direct;
  const linked = linkedInputValue(node, "search_directory").trim();
  if (linked) return linked;
  return "";
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function imageDirMaxPreviewImages(node) {
  return clampInt(getWidget(node, "max_preview_images")?.value, 1, 80, 12);
}

function markImageDirPreviewLoading(node, ckptName) {
  if (!isNodeClass(node, "ImageDirPreview")) return;
  const maxPreviewImages = imageDirMaxPreviewImages(node);
  const message = "Searching preview images...";
  node.__hpsPreviewState = {
    ...(node.__hpsPreviewState || {}),
    node_class: "ImageDirPreview",
    ckpt_name_str: ckptName,
    status: "loading",
    message,
    progress_message: message,
    progress_value: 0,
    progress_total: maxPreviewImages,
    max_preview_images: maxPreviewImages,
  };
  node.__hpsPreviewCaption = message;
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

    if (!selectorSelected(node) && node.__hpsItems.length) {
      setSelectorSelected(node, node.__hpsItems[0].ckpt_name_str);
    }
    const selected = selectorSelected(node);
    if (selected && !node.__hpsItems.find((x) => x.ckpt_name_str === selected) && node.__hpsItems.length) {
      setSelectorSelected(node, node.__hpsItems[0].ckpt_name_str);
    }

    if (all) {
      const checkpointValues = await checkpointValuesFromRefreshPayload(result);
      lastCheckpointValues = checkpointValues;
      const stats = applyCheckpointValuesToGraph(checkpointValues);
      node.__hpsStatus = `${node.__hpsStatus || "Refresh All"}\nUpdated ${stats.widgetChanged}/${stats.widgetMatched} checkpoint widgets, ${stats.cyclerMatched} cycler(s), ${checkpointValues.length} checkpoint choices`;
      console.log("[CheckpointHandpickerSuite] Refresh All widget sync", stats, {
        checkpointCount: checkpointValues.length,
        patchedClasses: result.patched_classes || [],
      });
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
    body: JSON.stringify(tabPayload({
      ckpt_name_str: selected,
      target_node_ids: (app.graph?._nodes || [])
        .filter((n) => isNodeClass(n, CYCLER_CLASS))
        .map((n) => n.id),
    })),
  });
  const result = await response.json();
  if (result.ok && Array.isArray(result.states)) {
    for (const state of result.states) {
      const cycler = app.graph?.getNodeById?.(Number(state.node_id));
      if (cycler && isNodeClass(cycler, CYCLER_CLASS)) applyCyclerStatePayload(cycler, state);
    }
  }
  console.info(`[INFO] [CheckpointHandpickerSuite] Push Local List: ${selected} -> ${result.updated ?? 0} Cycler(s)`);
  node.__hpsStatus = result.ok
    ? `pushed : ${selected} (${result.updated} Cycler)`
    : (result.error || "Push failed");
  app.graph.setDirtyCanvas(true, true);
}

async function syncSelectedCheckpoint(node) {
  const selected = selectorSelected(node);
  if (!selected) return;
  const targets = getSelectorReviewTargets(node);
  for (const preview of targets.previews) {
    markImageDirPreviewLoading(preview, selected);
  }
  if (targets.previews.length) {
    app.graph.setDirtyCanvas(true, true);
    await nextAnimationFrame();
  }
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/review/sync_checkpoint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tabPayload({
      ckpt_name_str: selected,
      tagger_node_ids: targets.taggers.map((n) => n.id),
      preview_node_ids: targets.previews.map((n) => n.id),
      preview_targets: targets.previews.map((n) => ({
        node_id: n.id,
        search_directory: imageDirSearchDirectory(n),
        max_preview_images: imageDirMaxPreviewImages(n),
      })),
    })),
  });
  const result = await response.json();
  node.__hpsStatus = result.ok
    ? `synced : ${selected} (${targets.taggers.length} tagger, ${targets.previews.length} preview)`
    : (result.error || "Sync failed");
  app.graph.setDirtyCanvas(true, true);
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
    list: r,
    track: { x: r.x + r.w - 16, y: r.y, w: 16, h: r.h },
    thumb: { x: r.x + r.w - 12, y, w: 8, h: thumbH },
    thumbH,
    maxScroll: maxSelectorScroll(node),
    scroll,
  };
}

function setSelectorScrollFromScrollbarY(node, localY, thumbH, dragOffset = thumbH / 2) {
  const r = selectorRects(node).list;
  const maxScroll = maxSelectorScroll(node);
  const usable = Math.max(1, r.h - thumbH);
  const y = Math.max(r.y, Math.min(r.y + usable, localY - dragOffset));
  node.__hpsScroll = Math.round(((y - r.y) / usable) * maxScroll);
  app.graph?.setDirtyCanvas?.(true, true);
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

  // Capture before LiteGraph consumes the wheel event for canvas zoom/pan.
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

      const local = [
        graphPos[0] - (node.pos?.[0] || 0),
        graphPos[1] - (node.pos?.[1] || 0),
      ];
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
  if (hit(local, r.refreshAll) || hit(local, r.listOnly) || hit(local, r.pushLocalList) || hit(local, r.up) || hit(local, r.down)) return "pointer";
  const sb = selectorScrollbar(node);
  if (sb && hit(local, sb.track)) return "pointer";
  const list = selectorItems(node);
  const base = node.__hpsScroll || 0;
  for (let i = 0; i < Math.min(SELECTOR_VISIBLE_ROWS, list.length - base); i++) {
    const row = { x: r.list.x, y: r.list.y + i * ROW_H, w: r.list.w, h: ROW_H };
    if (hit(local, row)) return "pointer";
  }
  return "";
}

function drawSelectorRows(ctx, node) {
  const r = selectorRects(node);
  const items = selectorItems(node);
  const selected = selectorSelected(node);
  const base = node.__hpsScroll || 0;
  ctx.save();
  ctx.font = "12px sans-serif";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(r.list.x, r.list.y, r.list.w, r.list.h);
  for (let i = 0; i < SELECTOR_VISIBLE_ROWS; i++) {
    const item = items[base + i];
    const y = r.list.y + i * ROW_H;
    if (!item) continue;
    const ckpt = item.ckpt_name_str || "";
    const status = item.status || "none";
    const active = ckpt === selected;
    ctx.fillStyle = active ? "rgba(75,125,190,0.58)" : (i % 2 ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.06)");
    ctx.fillRect(r.list.x + 1, y + 1, r.list.w - 2, ROW_H - 2);
    ctx.fillStyle = active ? "#fff" : "#ddd";
    ctx.fillText(`${STATUS_ICON[status] || "—"} ${ckpt}`, r.list.x + 6, y + ROW_H / 2, r.list.w - 20);
  }
  const sb = selectorScrollbar(node);
  if (sb) {
    ctx.fillStyle = "rgba(220,220,220,0.18)";
    ctx.fillRect(sb.track.x + 6, sb.track.y, 4, sb.track.h);
    ctx.fillStyle = node.__hpsScrollbarDragging ? "rgba(255,255,255,0.70)" : "rgba(230,230,230,0.55)";
    ctx.fillRect(sb.thumb.x, sb.thumb.y, sb.thumb.w, sb.thumb.h);
  }
  ctx.restore();
}

function setupSelectorNode(nodeType) {
  installMinSize(nodeType, 520, 540);
  installTabIdSupport(nodeType);
  installCursorCapture();
  installSelectorWheelCapture();

  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 520, 540);
    hideSelectorWidget(this);
    setTimeout(() => refreshSelector(this, false), 0);
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    hideSelectorWidget(this);
    return r;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    ensureHiddenTabIdWidget(this);
    hideSelectorWidget(this);
    if (hpsNodeCollapsed(this)) return;
    const r = selectorRects(this);
    drawButton(ctx, r.refreshAll, "🔄 Refresh All", !this.__hpsLoading);
    drawButton(ctx, r.listOnly, "List", !this.__hpsLoading);
    drawButton(ctx, r.pushLocalList, selectorActionLabel(this), !this.__hpsLoading);
    drawButton(ctx, r.up, "▲", true);
    drawButton(ctx, r.down, "▼", true);

    ctx.save();
    ctx.fillStyle = "#ccc";
    ctx.font = "12px sans-serif";
    const status = this.__hpsStatus || "not loaded";
    status.split("\n").slice(0, 3).forEach((line, i) => ctx.fillText(line, 8, 50 + i * 14));
    ctx.restore();

    drawSelectorRows(ctx, this);
  };

  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (event, pos, canvas) {
    if (hpsNodeCollapsed(this)) return origMouseDown ? origMouseDown.apply(this, arguments) : false;

    const r = selectorRects(this);
    if (hitAny(this, pos, r.refreshAll)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      refreshSelector(this, true);
      return true;
    }
    if (hitAny(this, pos, r.listOnly)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      refreshSelector(this, false);
      return true;
    }
    if (hitAny(this, pos, r.pushLocalList)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (selectorActionMode(this) === "sync") syncSelectedCheckpoint(this);
      else pushSelectedToLocalList(this);
      return true;
    }
    if (hitAny(this, pos, r.up)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      scrollSelector(this, -SELECTOR_VISIBLE_ROWS);
      return true;
    }
    if (hitAny(this, pos, r.down)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      scrollSelector(this, SELECTOR_VISIBLE_ROWS);
      return true;
    }

    const sb = selectorScrollbar(this);
    if (sb) {
      const hitPositions = candidatePositions(this, pos);
      const thumbHitPos = hitPositions.find((p) => hit(p, sb.thumb));
      const trackHitPos = hitPositions.find((p) => hit(p, sb.track));

      if (thumbHitPos) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        this.__hpsScrollbarDragging = true;
        this.__hpsScrollbarDragOffset = thumbHitPos[1] - sb.thumb.y;
        this.__hpsScrollbarStartY = thumbHitPos[1];
        this.__hpsScrollbarStartScroll = sb.scroll;
        app.graph?.setDirtyCanvas?.(true, true);
        return true;
      }

      if (trackHitPos) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (trackHitPos[1] < sb.thumb.y) {
          scrollSelector(this, -SELECTOR_VISIBLE_ROWS);
        } else {
          scrollSelector(this, SELECTOR_VISIBLE_ROWS);
        }
        return true;
      }
    }

    const positions = candidatePositions(this, pos);
    for (const p of positions) {
      if (!hit(p, r.list)) continue;
      const row = Math.floor((p[1] - r.list.y) / ROW_H);
      const item = selectorItems(this)[(this.__hpsScroll || 0) + row];
      if (item) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        setSelectorSelected(this, item.ckpt_name_str);
        app.graph.setDirtyCanvas(true, true);
        return true;
      }
    }
    return origMouseDown ? origMouseDown.apply(this, arguments) : false;
  };

  const origMouseMove = nodeType.prototype.onMouseMove;
  nodeType.prototype.onMouseMove = function (event, pos, canvas) {
    if (this.__hpsScrollbarDragging && event?.buttons === 0) {
      this.__hpsScrollbarDragging = false;
      app.graph?.setDirtyCanvas?.(true, true);
      return true;
    }

    if (this.__hpsScrollbarDragging) {
      event?.preventDefault?.();
      event?.stopPropagation?.();

      const sb = selectorScrollbar(this);
      if (!sb) {
        this.__hpsScrollbarDragging = false;
        app.graph?.setDirtyCanvas?.(true, true);
        return true;
      }

      const local = selectorLocalFromEventOrPos(this, event, pos);
      if (!local) return true;

      setSelectorScrollFromScrollbarY(this, local[1], sb.thumbH, this.__hpsScrollbarDragOffset ?? sb.thumbH / 2);
      return true;
    }

    return origMouseMove ? origMouseMove.apply(this, arguments) : false;
  };

  const origMouseUp = nodeType.prototype.onMouseUp;
  nodeType.prototype.onMouseUp = function (event, pos, canvas) {
    if (this.__hpsScrollbarDragging) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      this.__hpsScrollbarDragging = false;
      app.graph?.setDirtyCanvas?.(true, true);
      return true;
    }

    return origMouseUp ? origMouseUp.apply(this, arguments) : false;
  };

  const origMouseWheel = nodeType.prototype.onMouseWheel;
  nodeType.prototype.onMouseWheel = function (event, pos, canvas) {
    const r = selectorRects(this);
    if (candidatePositions(this, pos).some((p) => hit(p, r.list))) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      scrollSelector(this, event.deltaY > 0 ? 3 : -3);
      return true;
    }
    return origMouseWheel ? origMouseWheel.apply(this, arguments) : false;
  };
}

// ---------- Tagger ----------
function currentTaggerPath(node) {
  return node.__hpsTaggerPath || linkedInputValue(node, "ckpt_name_str") || "";
}
function taggerButtons(node) {
  // Keep the controls below LiteGraph input pins/labels.
  return STATUS_ORDER.map((status, i) => ({
    status,
    x: 128 + i * 84,
    y: 8,
    w: 78,
    h: 26,
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
    body: JSON.stringify(tabPayload({ ckpt_name_str: ckpt, status })),
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
  installMinSize(nodeType, 450, 130);
  installTabIdSupport(nodeType);
  installCursorCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 450, 130);
    setTimeout(() => restoreNodeStateFromBackend(this, TAGGER_CLASS), 0);
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    setTimeout(() => restoreNodeStateFromBackend(this, TAGGER_CLASS), 0);
    return r;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    ensureHiddenTabIdWidget(this);
    if (hpsNodeCollapsed(this)) return;
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
    ctx.fillText(p ? p : "Execute once to bind current checkpoint.", 8, 78);
    const msg = this.__hpsTaggerMessage || (current === "none" ? "Current: — none" : `Current: ${STATUS_ICON[current]} ${STATUS_LABEL[current]}`);
    ctx.fillStyle = current === "none" ? "#888" : "#ddd";
    ctx.fillText(msg, 8, 96);
    if (this.size[1] >= 124 && current !== "none" && current !== "delete") {
      ctx.fillStyle = "#aaa";
      ctx.fillText("Delete is available only from none.", 8, 114);
    }
    ctx.restore();
  };
  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (e, pos) {
    if (hpsNodeCollapsed(this)) return origMouseDown ? origMouseDown.apply(this, arguments) : false;
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
  const node = nodeFromEvent(detail, TAGGER_CLASS);
  if (!node) return;
  node.__hpsTaggerPath = detail.ckpt_name_str;
  node.__hpsTaggerStatus = detail.status;
  node.__hpsTaggerMessage = detail.status === "none" ? "Current: — none" : `Current: ${STATUS_ICON[detail.status]} ${STATUS_LABEL[detail.status]}`;
  if (detail.title) node.title = detail.title;
  app.graph.setDirtyCanvas(true, true);
});

let selectorGlobalRefreshTimer = null;
function scheduleSelectorGlobalRefresh() {
  clearTimeout(selectorGlobalRefreshTimer);
  selectorGlobalRefreshTimer = setTimeout(() => {
    for (const node of app.graph?._nodes || []) {
      if (isNodeClass(node, SELECTOR_CLASS)) refreshSelector(node, false);
    }
  }, 400);
}

api.addEventListener(STATUS_CHANGED_EVENT, ({ detail }) => {
  if (!isForThisTab(detail)) return;
  for (const node of app.graph?._nodes || []) {
    if (isNodeClass(node, SELECTOR_CLASS)) {
      for (const item of selectorItems(node)) {
        if (item.ckpt_name_str === detail.ckpt_name_str) item.status = detail.status || "none";
      }
    }
    if (PREVIEW_CLASSES.has(node.type || node.comfyClass) && node.__hpsPreviewCkptName === detail.ckpt_name_str) {
      node.__hpsPreviewStatus = detail.status || "none";
      setPreviewTitleFromCheckpoint(node, detail.ckpt_name_str, detail.status || "none");
    }
    if (isNodeClass(node, TAGGER_CLASS) && currentTaggerPath(node) === detail.ckpt_name_str) {
      node.__hpsTaggerStatus = detail.status || "none";
      node.__hpsTaggerMessage = node.__hpsTaggerStatus === "none" ? "Current: — none" : `Current: ${STATUS_ICON[node.__hpsTaggerStatus]} ${STATUS_LABEL[node.__hpsTaggerStatus]}`;
      patchCheckpointTitle(node, "Tagger", detail.ckpt_name_str, node.__hpsTaggerStatus);
    }
    if (isNodeClass(node, CYCLER_CLASS) && node.__hpsCyclerCkptName === detail.ckpt_name_str) {
      patchCheckpointTitle(node, "Cycler", detail.ckpt_name_str, detail.status || "none");
    }
  }
  scheduleSelectorGlobalRefresh();
  app.graph.setDirtyCanvas(true, true);
});

// ---------- Cycler ----------
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
  syncCyclerSettingsWidgets(node);
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/cycler/set_flags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tabPayload({
      node_id: node.id,
      use_local_list: !!node.__hpsUseLocalList,
      settings_revision: node.__hpsSettingsRevision ?? 0,
      ...getCyclerRuntimeControls(node),
    })),
  });
  const result = await response.json();
  if (result?.ok) applyCyclerStatePayload(node, result);
}
async function pushCyclerFilter(node) {
  syncCyclerSettingsWidgets(node);
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/cycler/set_filter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tabPayload({
      node_id: node.id,
      statuses: cyclerActiveFilter(node),
      settings_revision: node.__hpsSettingsRevision ?? 0,
      ...getCyclerRuntimeControls(node),
    })),
  });
  const result = await response.json();
  if (result?.ok) applyCyclerStatePayload(node, result);
}
async function clearLocalList(node) {
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/cycler/clear_local_list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tabPayload({ node_id: node.id })),
  });
  const result = await response.json();
  if (result?.ok && result.state) applyCyclerStatePayload(node, result.state);
  console.info(`[INFO] [CheckpointHandpickerSuite] Clear Local List: ${result?.cleared ?? 0} item(s)`);
  app.graph?.setDirtyCanvas?.(true, true);
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
  installTabIdSupport(nodeType);
  installCursorCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 560, 260);
    restoreCyclerSettingsFromWidgets(this);
    setTimeout(() => restoreNodeStateFromBackend(this, CYCLER_CLASS), 0);
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    restoreCyclerSettingsFromWidgets(this);
    setTimeout(() => restoreNodeStateFromBackend(this, CYCLER_CLASS), 0);
    return r;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    ensureHiddenTabIdWidget(this);
    restoreCyclerSettingsFromWidgets(this);
    if (hpsNodeCollapsed(this)) return;
    const r = cyclerRects(this);
    const active = cyclerActiveFilter(this);
    ctx.save();

    drawButton(ctx, r.localListToggle, this.__hpsUseLocalList === false ? "Local List OFF" : "Local List ON", true, this.__hpsUseLocalList !== false);
    drawButton(ctx, r.clearLocalList, "Clear Local List", true, false, "rgba(105,90,90,0.65)");
    for (const b of r.filter) {
      const isAll = b.status === "all";
      const on = isAll ? active.length === 0 : active.includes(b.status);
      drawButton(ctx, b, isAll ? "all" : STATUS_ICON[b.status], true, on);
    }

    ctx.fillStyle = "#aaa";
    ctx.font = "12px sans-serif";
    ctx.fillText(`filter: ${statusIconDisplay(active)}`, 8, 78);
    ctx.fillText(`settings revision: ${this.__hpsSettingsRevision ?? 0}`, 8, 96);

    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(r.statusBox.x, r.statusBox.y, r.statusBox.w, r.statusBox.h);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.strokeRect(r.statusBox.x, r.statusBox.y, r.statusBox.w, r.statusBox.h);
    ctx.fillStyle = "#ddd";
    ctx.font = "12px monospace";
    const lines = (this.__hpsCyclerStatus || "Current: (not executed yet)").split("\n");
    lines.forEach((line, i) => ctx.fillText(line, r.statusBox.x + 8, r.statusBox.y + 18 + i * 14));
    ctx.restore();
  };
  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (e, pos) {
    if (hpsNodeCollapsed(this)) return origMouseDown ? origMouseDown.apply(this, arguments) : false;
    const r = cyclerRects(this);
    if (hitAny(this, pos, r.localListToggle)) {
      this.__hpsUseLocalList = !this.__hpsUseLocalList;
      bumpCyclerSettingsRevision(this);
      syncCyclerSettingsWidgets(this);
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
      bumpCyclerSettingsRevision(this);
      syncCyclerSettingsWidgets(this);
      pushCyclerFilter(this);
      app.graph.setDirtyCanvas(true, true);
      return true;
    }
    return origMouseDown ? origMouseDown.apply(this, arguments) : false;
  };
}
api.addEventListener(CYCLER_EVENT, ({ detail }) => {
  const node = nodeFromEvent(detail, CYCLER_CLASS);
  if (!node) return;
  applyCyclerStatePayload(node, detail);
  app.graph.setDirtyCanvas(true, true);
});

app.registerExtension({
  name: EXT,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    installCheckpointRefreshFuturePatch(nodeType, nodeData);
    if (PREVIEW_CLASSES.has(nodeData.name)) return setupPreviewNode(nodeType);
    if (nodeData.name === SELECTOR_CLASS) return setupSelectorNode(nodeType);
    if (nodeData.name === TAGGER_CLASS) return setupTaggerNode(nodeType);
    if (nodeData.name === CYCLER_CLASS) return setupCyclerNode(nodeType);
  },
});
