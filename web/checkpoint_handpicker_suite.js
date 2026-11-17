import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// v9m: DirectLink active button style, one-time confirmation dialog, and ckpt_name_str-only Tagger wiring cleanup.
// v9l: UI polish, DirectLink green highlight, Tagger layout fix, and Cycler Tagger activation repair.
// v9k: DirectLink mode and output-side delete script folder.
// v9d: Selector thumbnail popup follows row hover or current selection inside node.
// v8g: restore-safe Cycler runtime controls, global shuffle deck, and UI regression fixes.
const EXT = "ruminar.checkpoint_handpicker_suite";
const PREVIEW_EVENT = "ruminar.checkpoint_handpicker_suite.preview";
const CYCLER_EVENT = "ruminar.checkpoint_handpicker_suite.cycler";
const TAGGER_EVENT = "ruminar.checkpoint_handpicker_suite.tagger";
const STATUS_CHANGED_EVENT = "ruminar.checkpoint_handpicker_suite.status_changed";
const TAG_TRANSFER_EVENT = "ruminar.checkpoint_handpicker_suite.tag_transfer";

const SELECTOR_CLASS = "CheckpointListSelector";
const CYCLER_CLASS = "CheckpointNameCycler";
const TAGGER_CLASS = "CheckpointStatusTagger";
const TAG_TRANSFER_CLASS = "CheckpointTagExportImport";
const TAG_TRANSFER_DIRECTORY_WIDGET = "tag_transfer_directory";
const TAG_TRANSFER_DIRECTORY_PLACEHOLDER = "Default: output/CheckpointHandpickerSuite/";
const PREVIEW_CLASSES = new Set(["EphemeralPreview", "ImageDirPreview"]);

const HPS_TAB_STORAGE_KEY = `${EXT}.tab_id`;
const HPS_TAB_ALIASES_STORAGE_KEY = `${EXT}.tab_id_aliases`;

function createHpsTabId() {
  return globalThis.crypto?.randomUUID?.() || `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadHpsTabId() {
  try {
    const saved = sessionStorage.getItem(HPS_TAB_STORAGE_KEY);
    if (saved && /^[0-9A-Za-z_.:-]{1,128}$/.test(saved)) return { value: saved, restored: true };
    const created = createHpsTabId();
    return { value: created, restored: false };
  } catch {
    return { value: createHpsTabId(), restored: false };
  }
}

function persistHpsTabId() {
  try { sessionStorage.setItem(HPS_TAB_STORAGE_KEY, HPS_TAB_ID); } catch {}
}

function loadHpsTabAliases() {
  try {
    const values = JSON.parse(sessionStorage.getItem(HPS_TAB_ALIASES_STORAGE_KEY) || "[]");
    return Array.isArray(values)
      ? values.filter((value) => /^[0-9A-Za-z_.:-]{1,128}$/.test(String(value || "")))
      : [];
  } catch {
    return [];
  }
}

function persistHpsTabAliases() {
  try {
    const aliases = [...HPS_ACCEPTED_TAB_IDS].filter((value) => value !== HPS_TAB_ID).slice(-16);
    sessionStorage.setItem(HPS_TAB_ALIASES_STORAGE_KEY, JSON.stringify(aliases));
  } catch {}
}

// sessionStorage belongs to one browser tab and survives a page reload.
// This keeps events from a prompt that continues running after reload
// associated with that same tab, without making another browser tab share it.
const hpsLoadedTabId = loadHpsTabId();
let HPS_TAB_ID = hpsLoadedTabId.value;
let hpsTabIdRestoredFromSession = hpsLoadedTabId.restored;
const HPS_ACCEPTED_TAB_IDS = new Set([HPS_TAB_ID, ...loadHpsTabAliases()]);
if (!hpsTabIdRestoredFromSession) persistHpsTabId();

function adoptWorkflowTabId(value) {
  if (hpsTabIdRestoredFromSession || !value || !/^[0-9A-Za-z_.:-]{1,128}$/.test(value)) return;
  // On the first load after upgrading, prefer the ID that is already
  // serialized in this workflow. Every prompt already in its queue carries
  // that ID, so making it this tab's persistent ID preserves the whole queue.
  HPS_ACCEPTED_TAB_IDS.delete(HPS_TAB_ID);
  HPS_TAB_ID = value;
  HPS_ACCEPTED_TAB_IDS.add(value);
  hpsTabIdRestoredFromSession = true;
  persistHpsTabId();
  persistHpsTabAliases();
}

function rememberWorkflowTabId(node) {
  const value = String(getWidget(node, "hps_tab_id")?.value ?? "").trim();
  if (!value || !/^[0-9A-Za-z_.:-]{1,128}$/.test(value)) return;
  adoptWorkflowTabId(value);
  if (value === HPS_TAB_ID) return;
  // A prompt queued before this script gained session persistence still
  // carries the workflow's previous hidden ID. Accept only IDs present in
  // this loaded workflow; never accept arbitrary events from another tab.
  HPS_ACCEPTED_TAB_IDS.add(value);
  persistHpsTabAliases();
}

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

const STATUS_ORDER = ["god", "favorite", "nice", "keep", "delete", "none"];
const TAGGER_STATUS_ORDER = ["god", "favorite", "nice", "keep", "delete"];
const STATUS_ICON = { god: "👑", favorite: "💛", nice: "👍", keep: "✔", delete: "🗑", none: "—" };
const STATUS_LABEL = { god: "god!", favorite: "favorite", nice: "nice", keep: "keep", delete: "delete", none: "none" };
const STATUS_CURRENT_LABEL = { god: "god!", favorite: "favorite", nice: "nice", keep: "keep", delete: "Marked for deletion", none: "none" };

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function findGraphNodeById(id) {
  if (id == null || id === "") return null;
  const graph = app.graph;
  if (!graph?.getNodeById) return null;
  // Nodes 2.0 / recent frontends treat node ids as branded strings inside
  // the frontend, while serialized workflows and API payloads may still
  // carry numbers. Try the raw id first, then the string/number forms,
  // instead of forcing every id through Number(), which fails outright
  // when the graph keys nodes by string id.
  for (const candidate of [id, String(id), Number(id)]) {
    try {
      const node = graph.getNodeById(candidate);
      if (node) return node;
    } catch {}
  }
  return null;
}

function stopHpsWidgetEventPropagation(element) {
  // "wheel" is deliberately not stopped here: over a Vue node the wheel
  // must still reach the graph canvas so zooming keeps working, which is
  // what wheel over the Cycler/Tagger/Preview area relied on. Elements
  // that scroll themselves opt in via keepWheelForNativeScroll() below.
  // Keyboard events are not stopped either: after clicking a widget
  // button the button keeps focus, and stopping keydown there breaks
  // the frontend's own shortcuts (Ctrl+S stopped saving the workflow
  // and fell through to the browser's save-page dialog). The frontend
  // itself ignores shortcuts that come from text inputs, so only
  // pointer events need to be contained here.
  for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"]) {
    element.addEventListener(eventName, (event) => event.stopPropagation());
  }
}

function keepWheelForNativeScroll(element) {
  // For genuinely scrollable DOM areas (Selector list, long status
  // text): mark the element so the wheel forwarder leaves events over
  // it alone while it can still scroll in that direction, and stop
  // propagation so the graph canvas does not also react.
  element.dataset.hpsNativeScroll = "true";
  element.addEventListener("wheel", (event) => event.stopPropagation());
}

function forwardWheelToGraphCanvas(event) {
  if (event.__hpsWheelForwarded) return;
  const graphCanvas = app.canvas;
  const canvasEl = graphCanvas?.canvas;
  if (!canvasEl && typeof graphCanvas?.processMouseWheel !== "function") return;
  try { event.__hpsWheelForwarded = true; } catch { /* read-only event */ }
  event.preventDefault();
  event.stopPropagation();
  // The frontend's own Vue widgets forward wheel by calling
  // processMouseWheel directly (see the frontend's multilineTextarea
  // helper), which works no matter how the canvas element's own wheel
  // listener is registered in this frontend version. Fall back to a
  // synthetic event on the canvas element if the method is missing.
  if (typeof graphCanvas?.processMouseWheel === "function") {
    graphCanvas.processMouseWheel(event);
    return;
  }
  const forwarded = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: event.clientX,
    clientY: event.clientY,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
  });
  Object.defineProperty(forwarded, "__hpsWheelForwarded", { value: true });
  canvasEl.dispatchEvent(forwarded);
}

const hpsWheelForwardRoots = new Set();
let hpsWindowWheelInstalled = false;

function handleHpsWheelCapture(event) {
  if (event.__hpsWheelForwarded) return;
  const target = event.target;
  if (!target || target.nodeType !== 1) return;
  let insideRoot = false;
  for (const root of hpsWheelForwardRoots) {
    if (root === target || root.contains?.(target)) { insideRoot = true; break; }
  }
  if (!insideRoot) return;
  // A marked scrollable area keeps the wheel while it can still
  // scroll in the wheeled direction; at its edge the wheel falls
  // through to the canvas, matching normal scroll chaining.
  const scrollEl = target.closest?.("[data-hps-native-scroll]");
  if (scrollEl && scrollEl.dataset?.hpsNativeScroll === "true") {
    const maxScrollTop = scrollEl.scrollHeight - scrollEl.clientHeight;
    const canScroll = (event.deltaY < 0 && scrollEl.scrollTop > 0)
      || (event.deltaY > 0 && scrollEl.scrollTop < maxScrollTop);
    if (canScroll) {
      // Nodes 2.0 consumes wheel events after this window capture phase,
      // before the browser performs the element's native scrolling. Apply
      // the scroll here and consume the event so the list always moves.
      const lineHeight = 16;
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * lineHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * scrollEl.clientHeight
          : event.deltaY;
      event.preventDefault();
      event.stopImmediatePropagation();
      scrollEl.scrollTop += delta;
      return;
    }
  }
  forwardWheelToGraphCanvas(event);
}

function installWheelForwarding(element) {
  if (!element || element.__hpsWheelForwarderInstalled) return;
  element.__hpsWheelForwarderInstalled = true;
  hpsWheelForwardRoots.add(element);
  // Capture phase is required: in Nodes 2.0 the wheel is intercepted
  // around the DOM widget before a bubble-phase listener on the widget
  // root ever runs (a bubble-phase forwarder on the root did not work
  // in practice). A window-level capture listener runs before every
  // element handler, and the root-level capture listener below is a
  // fallback for the same widget.
  element.addEventListener("wheel", handleHpsWheelCapture, { passive: false, capture: true });
  if (!hpsWindowWheelInstalled) {
    hpsWindowWheelInstalled = true;
    window.addEventListener("wheel", handleHpsWheelCapture, { passive: false, capture: true });
  }
}

function addVueOnlyDomWidget(node, name, type, element, height, reclaimMode = "") {
  if (!node || typeof node.addDOMWidget !== "function" || node.widgets?.some((widget) => widget.name === name)) return null;
  installWheelForwarding(element);
  try {
    const widget = node.addDOMWidget(name, type, element, {
      serialize: false,
      hideOnZoom: false,
      surfaces: { canvas: "never", vueNode: "shown", panel: "shown" },
    });
    widget.computeSize = (width) => [width, typeof height === "function" ? height(width) : height];
    const mode = reclaimMode === true ? "both" : String(reclaimMode || "");
    if (mode) scheduleVueLayoutReclaim(node, element, mode);
    return widget;
  } catch (error) {
    console.warn(`[CheckpointHandpickerSuite] failed to create Nodes 2.0 widget: ${name}`, error);
    return null;
  }
}

function moveVueWidgetToFront(node, name) {
  const widgets = node?.widgets;
  if (!Array.isArray(widgets)) return;
  const index = widgets.findIndex((widget) => widget.name === name);
  if (index > 0) {
    const [widget] = widgets.splice(index, 1);
    widgets.unshift(widget);
  }
}

// In the canvas renderer the custom UI starts right below the title,
// using the free space beside the input/output pins (see
// selectorRects: the buttons sit at the top and "the right edge
// belongs to ComfyUI output pins"). The Vue renderer instead stacks a
// slots block (one row per pin) above the widget stack, which pushes
// the whole UI down by that height and shrinks the list, and a node
// taller than its content leaves dead space under the widget. Shift
// the Vue-only widget up over the slots band and stretch it over the
// bottom dead space so both renderers show the same layout. All
// measurements use offset* (layout pixels), which the canvas zoom
// transform does not affect. Best-effort: any mismatch in the
// frontend's DOM structure leaves the default layout untouched.
function reclaimVueWidgetLayout(node, element, mode = "both") {
  try {
    const nodeEl = element.closest?.("[data-node-id]");
    if (!nodeEl) return;
    const bodyEl = nodeEl.querySelector?.('[data-testid^="node-body-"]');
    if (!bodyEl) return;
    const host = element.parentElement;
    if (!host || host === bodyEl) return;
    const relTop = (el) => {
      let y = 0;
      let n = el;
      while (n && n !== nodeEl) { y += n.offsetTop || 0; n = n.offsetParent; }
      return n === nodeEl ? y : null;
    };
    const hostTop = relTop(host);
    const bodyTop = relTop(bodyEl);
    if (hostTop == null || bodyTop == null) return;
    const slotsEl = bodyEl.firstElementChild;
    const slotsH = slotsEl ? slotsEl.offsetHeight || 0 : 0;
    // "shift" is only safe when this widget is the first in the stack
    // (nothing visible above it except the slots band). The shift is
    // capped at the slots band height plus the body gap.
    let shift = 0;
    if (mode === "shift" || mode === "both") {
      shift = (hostTop - bodyTop) - 8;
      if (shift < 0) shift = 0;
      const maxShift = slotsH + 12;
      if (shift > maxShift) shift = maxShift;
    }
    let extra = 0;
    if (mode === "fill" || mode === "both") {
      const hostBottom = hostTop + (host.offsetHeight || 0);
      const bodyBottom = bodyTop + (bodyEl.offsetHeight || 0);
      extra = bodyBottom - hostBottom - 12; // body bottom padding
      if (extra < 0) extra = 0;
      if (extra > 600) extra = 600;
    }
    element.style.marginTop = shift ? `-${shift}px` : "";
    // The Vue host stretches DOM widget elements with flex: 1, which
    // would ignore an explicit height; opt out so the calc() height
    // (host height + reclaimed space) is honoured.
    element.style.flex = (shift || extra) ? "0 0 auto" : "";
    element.style.height = (shift || extra) ? `calc(100% + ${shift + extra}px)` : "";
    // A shifted-up band overlaps the slots area: let clicks fall
    // through the root's empty parts to the pins underneath, and only
    // capture events on the actual content sections.
    if (shift) {
      element.style.pointerEvents = "none";
      for (const child of element.children) child.style.pointerEvents = "auto";
      // The shifted content leaves a gap before the following
      // framework widgets (Cycler: start_checkpoint and everything
      // after it sat too low by roughly the shift amount). The Vue
      // widget stack is a CSS grid, so following widgets do not flow
      // up on their own: translate their grid rows up by the measured
      // gap instead. Transforms do not affect offsetTop, so repeated
      // measurements stay stable, and the freed space lands under the
      // last row, where a fill-mode widget (Cycler status) absorbs it.
      const gridEl = host.closest?.('[data-testid="node-widgets"]');
      const rowEl = host.closest?.("[data-widget-name]");
      const lastChild = element.lastElementChild;
      if (gridEl && rowEl && lastChild) {
        const contentBottom = relTop(lastChild) + (lastChild.offsetHeight || 0);
        const rows = [...gridEl.querySelectorAll("[data-widget-name]")];
        const index = rows.indexOf(rowEl);
        if (index >= 0 && index < rows.length - 1) {
          const nextTop = relTop(rows[index + 1]);
          if (contentBottom != null && nextTop != null) {
            let pull = nextTop - contentBottom - 6;
            if (pull < 4) pull = 0;
            if (pull > 64) pull = 64;
            for (let i = index + 1; i < rows.length; i++) {
              rows[i].style.transform = pull ? `translateY(${-pull}px)` : "";
            }
          }
        }
      }
    } else {
      element.style.pointerEvents = "";
      for (const child of element.children) child.style.pointerEvents = "";
    }
  } catch { /* layout reclaim is best-effort */ }
}

function refreshVueLayoutReclaim(node) {
  // Vue re-renders widget rows on state changes, which drops the
  // inline styles the reclaim applied; re-run it after UI syncs.
  if (!Array.isArray(node?.__hpsLayoutReclaimers) || !node.__hpsLayoutReclaimers.length) return;
  requestAnimationFrame(() => {
    for (const reclaim of node.__hpsLayoutReclaimers || []) reclaim();
  });
}

function scheduleVueLayoutReclaim(node, element, mode = "both") {
  const run = () => reclaimVueWidgetLayout(node, element, mode);
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 150);
  setTimeout(run, 500);
  setTimeout(run, 1200);
  if (!Array.isArray(node.__hpsLayoutReclaimers)) node.__hpsLayoutReclaimers = [];
  node.__hpsLayoutReclaimers.push(run);
  if (!node.__hpsLayoutReclaimHooked) {
    node.__hpsLayoutReclaimHooked = true;
    const prevOnResize = node.onResize;
    node.onResize = function (size) {
      prevOnResize?.call(this, size);
      setTimeout(() => {
        for (const reclaim of node.__hpsLayoutReclaimers || []) reclaim();
      }, 50);
    };
  }
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
  return detail?.scope === "global" || HPS_ACCEPTED_TAB_IDS.has(String(detail?.tab_id || ""));
}

function nodeFromEvent(detail, className) {
  if (!isForThisTab(detail)) return null;
  const node = findGraphNodeById(detail?.node);
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

const CYCLER_FILTER_STATUSES = ["god", "favorite", "nice", "keep", "delete", "none"];

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

function selectorStatusIcon(status) {
  return status && status !== "none" ? (STATUS_ICON[status] || "") : " ";
}

function taggerCurrentMessage(status) {
  const s = CYCLER_FILTER_STATUSES.includes(status) ? status : "none";
  return `Current: ${STATUS_ICON[s] || "—"} ${STATUS_CURRENT_LABEL[s] || STATUS_LABEL[s] || s}`;
}

function checkpointValuesFromWidget(widget) {
  const values = widget?.options?.values;
  return Array.isArray(values) ? values.filter((value) => typeof value === "string" && value) : [];
}

function ensureStartCheckpointWidgetValid(node, checkpointValues = null) {
  const widget = getWidget(node, "start_checkpoint");
  if (!widget) return false;
  const values = Array.isArray(checkpointValues) && checkpointValues.length ? checkpointValues : checkpointValuesFromWidget(widget);
  if (!values.length) return false;
  if (values.includes(widget.value)) return false;
  widget.value = values[0];
  node?.setDirtyCanvas?.(true, true);
  return true;
}

function applyCyclerStatePayload(node, detail) {
  if (!node || !detail) return;
  const controls = detail.runtime_controls || {};
  const runtimeControlsInitialized = detail.runtime_controls_initialized !== false;

  // On ComfyUI restart the backend state is empty and may return default
  // runtime_controls. Do not let those defaults overwrite workflow-saved widget
  // values. First seed the backend from the widgets, then subsequent initialized
  // payloads can become authoritative.
  if (runtimeControlsInitialized) {
    if (detail.active_filter !== undefined || controls.active_filter !== undefined) {
      node.__hpsFilterStatuses = normalizeCyclerFilterStatuses(detail.active_filter ?? controls.active_filter);
    }
    if (detail.use_local_list !== undefined || controls.use_local_list !== undefined) {
      node.__hpsUseLocalList = !!(detail.use_local_list ?? controls.use_local_list);
    }
    if (detail.settings_revision !== undefined || controls.settings_revision !== undefined) {
      node.__hpsSettingsRevision = parseSavedInt(detail.settings_revision ?? controls.settings_revision, node.__hpsSettingsRevision ?? 0);
    }
    if (detail.runtime_controls) {
      node.__hpsApplyingRuntimePayload = true;
      try {
        if (controls.mode !== undefined) setWidgetValueIfDifferent(node, "mode", controls.mode);
        if (controls.change_every !== undefined) setWidgetValueIfDifferent(node, "change_every", controls.change_every);
        if (controls.start_checkpoint !== undefined && controls.start_checkpoint !== "") setWidgetValueIfDifferent(node, "start_checkpoint", controls.start_checkpoint);
        ensureStartCheckpointWidgetValid(node);
      } finally {
        node.__hpsApplyingRuntimePayload = false;
      }
    }
  }
  if (detail.ckpt_name_str) {
    node.__hpsCyclerCkptName = detail.ckpt_name_str;
    node.__hpsCyclerStatusValue = detail.status || "none";
    setExecutionState(detail);
  }
  if (detail.filter_matches !== undefined) {
    node.__hpsFilterMatches = Number(detail.filter_matches) || 0;
  }
  if (Array.isArray(detail.local_list_items)) {
    node.__hpsLocalListItems = [...detail.local_list_items];
  }
  if (detail.local_list_count !== undefined) {
    node.__hpsLocalListCount = Number(detail.local_list_count) || 0;
  }
  if (detail.status_text !== undefined) {
    node.__hpsCyclerStatus = detail.status_text;
  }
  if (detail.title) {
    node.title = detail.title;
  }
  syncCyclerSettingsWidgets(node);
  syncVueCyclerUI(node);
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
  ensureStartCheckpointWidgetValid(node);
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
  ensureStartCheckpointWidgetValid(node);
}

function syncCyclerSettingsWidgets(node) {
  ensureHiddenWidgetValue(node, "hps_filter_statuses", serializeCyclerFilterStatuses(node.__hpsFilterStatuses || []));
  ensureHiddenWidgetValue(node, "hps_use_local_list", node.__hpsUseLocalList ? "true" : "false");
  ensureHiddenWidgetValue(node, "hps_settings_revision", String(node.__hpsSettingsRevision ?? 0));
}

function scheduleHideTabIdWidget(node) {
  // Capture the value restored with this workflow before replacing it with
  // the stable ID for future prompts. It lets a just-reloaded page receive
  // the remaining events of an already queued prompt.
  rememberWorkflowTabId(node);
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
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2, Math.max(1, rect.w - 8));
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

function hpsLocalInsideNode(node, local) {
  return Boolean(local)
    && local[0] >= 0
    && local[1] >= 0
    && local[0] <= (node.size?.[0] || 0)
    && local[1] <= (node.size?.[1] || 0);
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
    const allNodes = graph._nodes || [];
    for (const node of allNodes) {
      if (!(node.type === SELECTOR_CLASS || node.comfyClass === SELECTOR_CLASS)) continue;
      if (node.flags?.collapsed) {
        clearSelectorThumbnailHover(node);
        continue;
      }
      const local = graphEventToLocal(node, event);
      if (!hpsLocalInsideNode(node, local)) clearSelectorThumbnailHover(node);
    }

    const nodes = [...allNodes].reverse();
    for (const node of nodes) {
      if (node.flags?.collapsed) continue;
      let cursor = "";
      if (node.type === SELECTOR_CLASS || node.comfyClass === SELECTOR_CLASS) cursor = selectorCursorAt(node, graphEventToLocal(node, event));
      else if (node.type === TAGGER_CLASS || node.comfyClass === TAGGER_CLASS) cursor = taggerCursorAt(node, graphEventToLocal(node, event));
      else if (node.type === TAG_TRANSFER_CLASS || node.comfyClass === TAG_TRANSFER_CLASS) cursor = tagTransferCursorAt(node, graphEventToLocal(node, event));
      else if (node.type === CYCLER_CLASS || node.comfyClass === CYCLER_CLASS) cursor = cyclerCursorAt(node, graphEventToLocal(node, event));
      if (cursor) {
        setCanvasCursor(cursor);
        return;
      }
    }
    setCanvasCursor("");
  });
  canvasEl.addEventListener("mouseleave", () => {
    for (const node of app.graph?._nodes || []) {
      if (node.type === SELECTOR_CLASS || node.comfyClass === SELECTOR_CLASS) clearSelectorThumbnailHover(node);
    }
    setCanvasCursor("");
  });
}

// ---------- Backend state restore ----------
function nodeStateHasData(result, nodeClass) {
  if (!result?.ok) return false;
  if (nodeClass === CYCLER_CLASS) {
    return !!result.runtime_controls_initialized
      || !!result.ckpt_name_str
      || !!result.last_execution_snapshot?.ckpt_name;
  }
  return !!result.ckpt_name_str;
}

async function restoreNodeStateFromBackend(node, nodeClass) {
  if (!node || !nodeClass) return;
  try {
    let result = null;
    for (const tabId of HPS_ACCEPTED_TAB_IDS) {
      const query = new URLSearchParams({ node_id: String(node.id), node_class: nodeClass, tab_id: tabId });
      const response = await api.fetchApi(`/${EXTENSION_PREFIX}/node_state?${query.toString()}`, { cache: "no-store" });
      if (!response.ok) continue;
      const candidate = await response.json();
      if (!result) result = candidate;
      if (nodeStateHasData(candidate, nodeClass)) {
        result = candidate;
        break;
      }
    }
    if (!result?.ok) return;

    if (nodeClass === "EphemeralPreview") {
      if (result.ckpt_name_str) {
        node.__hpsPreviewCkptName = result.ckpt_name_str;
        node.__hpsPreviewStatus = result.status || "none";
        setPreviewTitleFromCheckpoint(node, result.ckpt_name_str, result.status || "none");
      }
    } else if (nodeClass === TAGGER_CLASS) {
      if (isTaggerDirectLinkBlocked(node)) {
        clearTaggerTarget(node);
      } else if (result.ckpt_name_str) {
        node.__hpsTaggerPath = result.ckpt_name_str;
        node.__hpsTaggerStatus = result.status || "none";
        node.__hpsTaggerMessage = taggerCurrentMessage(node.__hpsTaggerStatus);
        node.title = node.__hpsTaggerStatus === "none"
          ? `Tagger : ${result.ckpt_name_str}`
          : `Tagger : ${STATUS_ICON[node.__hpsTaggerStatus]} ${result.ckpt_name_str}`;
      }
    } else if (nodeClass === CYCLER_CLASS) {
      if (result.runtime_controls_initialized === false) {
        restoreCyclerSettingsFromWidgets(node);
        ensureStartCheckpointWidgetValid(node);
        syncCyclerSettingsWidgets(node);
        schedulePushCyclerRuntimeControls(node);
      } else {
        applyCyclerStatePayload(node, result);
      }
    }
    // Canvas redraws pick state up on the next frame, but the Nodes 2.0
    // DOM widgets only change when they are explicitly synced.
    syncVuePreviewUI(node);
    syncVueTaggerUI(node);
    syncVueCyclerUI(node);
    app.graph?.setDirtyCanvas?.(true, true);
  } catch (error) {
    // Older Python side versions did not expose node_state. Ignore quietly.
  }
}



// ---------- Preview ----------
let hpsContextMenuEl = null;
let hpsContextMenuHideInstalled = false;
let imageDirHoverCaptureInstalled = false;

function ensureHpsContextMenu() {
  if (hpsContextMenuEl) return hpsContextMenuEl;
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.zIndex = "99999";
  el.style.minWidth = "220px";
  el.style.background = "rgba(22,22,22,0.98)";
  el.style.border = "1px solid rgba(255,255,255,0.18)";
  el.style.borderRadius = "8px";
  el.style.boxShadow = "0 10px 28px rgba(0,0,0,0.45)";
  el.style.padding = "6px";
  el.style.display = "none";
  el.style.font = "12px sans-serif";
  el.style.color = "#eee";
  document.body.appendChild(el);
  hpsContextMenuEl = el;
  return el;
}

function hideHpsContextMenu() {
  const el = ensureHpsContextMenu();
  el.style.display = "none";
  el.innerHTML = "";
}

function installHpsContextMenuHide() {
  if (hpsContextMenuHideInstalled) return;
  hpsContextMenuHideInstalled = true;
  document.addEventListener("mousedown", (event) => {
    if (hpsContextMenuEl?.contains?.(event.target)) return;
    hideHpsContextMenu();
  }, true);
  document.addEventListener("scroll", () => hideHpsContextMenu(), true);
  window.addEventListener("blur", () => hideHpsContextMenu());
}

function showHpsContextMenu(items, clientX, clientY) {
  installHpsContextMenuHide();
  const el = ensureHpsContextMenu();
  el.innerHTML = "";
  const menuItems = Array.isArray(items) ? items : [];
  for (const item of menuItems) {
    const row = document.createElement("div");
    row.textContent = String(item?.label || "");
    row.style.padding = "7px 10px";
    row.style.borderRadius = "6px";
    row.style.whiteSpace = "nowrap";
    row.style.userSelect = "none";
    const enabled = item?.enabled !== false && typeof item?.onClick === "function";
    if (enabled) {
      row.style.cursor = "pointer";
      row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,0.10)"; });
      row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideHpsContextMenu();
        item.onClick();
      });
    } else {
      row.style.color = "#999";
      row.style.cursor = "default";
    }
    el.appendChild(row);
  }
  el.style.left = `${Math.max(4, Number(clientX || 0))}px`;
  el.style.top = `${Math.max(4, Number(clientY || 0))}px`;
  el.style.display = "block";
  const rect = el.getBoundingClientRect();
  const maxX = Math.max(4, window.innerWidth - rect.width - 4);
  const maxY = Math.max(4, window.innerHeight - rect.height - 4);
  el.style.left = `${Math.min(Math.max(4, Number(clientX || 0)), maxX)}px`;
  el.style.top = `${Math.min(Math.max(4, Number(clientY || 0)), maxY)}px`;
}

function previewGeometry(node) {
  const isImageDir = isNodeClass(node, "ImageDirPreview");
  const top = isImageDir ? 72 : 30;
  const margin = 8;
  const w = Math.max(1, (node.size?.[0] || 340) - margin * 2);
  const h = Math.max(1, (node.size?.[1] || 300) - top - margin);
  return { isImageDir, top, margin, w, h };
}

function previewDrawBox(node) {
  const img = node?.__hpsPreview;
  if (!img) return null;
  const g = previewGeometry(node);
  let dw = g.w;
  let dh = dw * (img.height / img.width);
  if (dh > g.h) {
    dh = g.h;
    dw = dh * (img.width / img.height);
  }
  const x = g.margin + (g.w - dw) / 2;
  const y = g.top + (g.h - dh) / 2;
  return { x, y, w: dw, h: dh, imageW: img.width, imageH: img.height };
}

function previewLocalFromEventOrPos(node, event, pos) {
  return graphEventToLocal(node, event) || localPos(node, pos);
}

function imageDirPreviewItemAtLocal(node, local) {
  if (!node || !isNodeClass(node, "ImageDirPreview") || !local) return null;
  const box = previewDrawBox(node);
  if (!box || !hit(local, box)) return null;
  const sx = (local[0] - box.x) * (box.imageW / box.w);
  const sy = (local[1] - box.y) * (box.imageH / box.h);
  return imageDirPreviewItemAtImagePoint(node, sx, sy);
}

function imageDirPreviewItemAtImagePoint(node, sx, sy) {
  if (!node || !isNodeClass(node, "ImageDirPreview")) return null;
  const st = node.__hpsPreviewState || {};
  const sourcePaths = Array.isArray(st.source_paths) ? st.source_paths : [];
  const count = Number(st.count || sourcePaths.length || 0);
  const cols = Number(st.columns || 0);
  const rows = Number(st.rows || 0);
  const tileW = Number(st.tile_width || 0);
  const tileH = Number(st.tile_height || 0);
  const gap = Number(st.gap || 0);
  if (!count || !cols || !rows || !tileW || !tileH || !sourcePaths.length) return null;
  const stepX = tileW + gap;
  const stepY = tileH + gap;
  if (stepX <= 0 || stepY <= 0) return null;
  const col = Math.floor(sx / stepX);
  const row = Math.floor(sy / stepY);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
  const inTileX = sx - col * stepX;
  const inTileY = sy - row * stepY;
  if (inTileX < 0 || inTileX > tileW || inTileY < 0 || inTileY > tileH) return null;
  const index = row * cols + col;
  if (index < 0 || index >= count || index >= sourcePaths.length) return null;
  if (isImageDirDeletedIndex(node, index)) return null;
  return { index, sourcePath: String(sourcePaths[index] || ""), ckptName: String(st.ckpt_name_str || "") };
}

function imageDirPreviewTileRect(node, index) {
  const st = node.__hpsPreviewState || {};
  const cols = Number(st.columns || 0);
  const tileW = Number(st.tile_width || 0);
  const tileH = Number(st.tile_height || 0);
  const gap = Number(st.gap || 0);
  if (!cols || !tileW || !tileH || index == null || index < 0) return null;
  const box = previewDrawBox(node);
  if (!box) return null;
  const row = Math.floor(index / cols);
  const col = index % cols;
  const sx = col * (tileW + gap);
  const sy = row * (tileH + gap);
  const scaleX = box.w / box.imageW;
  const scaleY = box.h / box.imageH;
  return { x: box.x + sx * scaleX, y: box.y + sy * scaleY, w: tileW * scaleX, h: tileH * scaleY };
}

function clearImageDirHover(node) {
  if (!node) return;
  if (node.__hpsHoveredPreviewIndex != null) {
    node.__hpsHoveredPreviewIndex = null;
    app.graph?.setDirtyCanvas?.(true, true);
  }
}

function setImageDirHover(node, item) {
  const index = item?.index ?? null;
  if (node.__hpsHoveredPreviewIndex !== index) {
    node.__hpsHoveredPreviewIndex = index;
    app.graph?.setDirtyCanvas?.(true, true);
  }
}

function updateImageDirHoverFromEvent(event) {
  let handled = false;
  const nodes = [...(app.graph?._nodes || [])].reverse();
  for (const node of nodes) {
    if (!node || node.flags?.collapsed || !isNodeClass(node, "ImageDirPreview")) continue;
    const local = graphEventToLocal(node, event);
    if (!hpsLocalInsideNode(node, local)) {
      clearImageDirHover(node);
      continue;
    }
    const item = imageDirPreviewItemAtLocal(node, local);
    setImageDirHover(node, item);
    handled = true;
    break;
  }
  if (!handled) {
    for (const node of app.graph?._nodes || []) {
      if (isNodeClass(node, "ImageDirPreview")) clearImageDirHover(node);
    }
  }
}

function installImageDirHoverCapture() {
  if (imageDirHoverCaptureInstalled) return;
  const canvasEl = app.canvas?.canvas;
  if (!canvasEl) return;
  imageDirHoverCaptureInstalled = true;
  canvasEl.addEventListener("mousemove", (event) => updateImageDirHoverFromEvent(event), true);
  canvasEl.addEventListener("mouseleave", () => {
    for (const node of app.graph?._nodes || []) {
      if (isNodeClass(node, "ImageDirPreview")) clearImageDirHover(node);
    }
  });
}

const NO_IMAGE_ASSET_URL = new URL("./assets/no_image.svg", import.meta.url).href;
let noImageAsset = null;
let noImageAssetRequested = false;

function ensureNoImageAsset() {
  if (noImageAsset || noImageAssetRequested) return noImageAsset;
  noImageAssetRequested = true;
  const img = new Image();
  img.onload = () => {
    noImageAsset = img;
    app.graph?.setDirtyCanvas?.(true, true);
  };
  img.onerror = () => {
    noImageAsset = null;
  };
  img.src = NO_IMAGE_ASSET_URL;
  return null;
}

function deletedImageDirIndexSet(node) {
  const raw = node?.__hpsPreviewState?.deleted_indices;
  if (!Array.isArray(raw) || !raw.length) return null;
  return new Set(raw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0));
}

function isImageDirDeletedIndex(node, index) {
  if (index == null || index < 0) return false;
  const set = deletedImageDirIndexSet(node);
  return !!set && set.has(Number(index));
}

function updateNodeDeletedIndices(node, values) {
  if (!node) return;
  const next = Array.isArray(values) ? values.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0) : [];
  node.__hpsPreviewState = { ...(node.__hpsPreviewState || {}), deleted_indices: next };
}

function drawNoImagePlaceholder(ctx, rect) {
  ctx.save();
  ctx.fillStyle = "rgba(20,20,20,0.72)";
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  const asset = noImageAsset || ensureNoImageAsset();
  if (asset) {
    ctx.drawImage(asset, rect.x, rect.y, rect.w, rect.h);
  } else {
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(1, rect.w - 1), Math.max(1, rect.h - 1));
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("NO IMAGE", rect.x + rect.w / 2, rect.y + rect.h / 2, Math.max(1, rect.w - 10));
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }
  ctx.restore();
}

async function fetchImageDirContextMenu(node, itemIndex) {
  const st = node.__hpsPreviewState || {};
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/image_dir_preview/context_menu`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: node.id, item_index: itemIndex, preview_session_id: st.preview_session_id || "", tab_id: HPS_TAB_ID }),
  });
  return await response.json();
}

async function setImageDirCheckpointThumbnail(node, itemIndex) {
  const st = node.__hpsPreviewState || {};
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/image_dir_preview/set_thumbnail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: node.id, item_index: itemIndex, preview_session_id: st.preview_session_id || "", tab_id: HPS_TAB_ID }),
  });
  const result = await response.json();
  if (result?.ok) {
    selectorThumbnailCache.delete(selectorThumbnailCacheKey(result.ckpt_name_str || ""));
    node.__hpsPreviewContextMessage = result.message || "Checkpoint thumbnail updated.";
    node.__hpsPreviewContextMessageAt = Date.now();
  } else {
    node.__hpsPreviewContextMessage = result?.error || "Failed to set checkpoint thumbnail.";
    node.__hpsPreviewContextMessageAt = Date.now();
  }
  syncVuePreviewUI(node);
  setTimeout(() => syncVuePreviewUI(node), 5100);
  app.graph?.setDirtyCanvas?.(true, true);
}

async function deleteImageDirPreviewImage(node, itemIndex) {
  const st = node.__hpsPreviewState || {};
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/image_dir_preview/delete_image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: node.id, item_index: itemIndex, preview_session_id: st.preview_session_id || "", tab_id: HPS_TAB_ID }),
  });
  const result = await response.json();
  if (result?.ok) {
    if (Array.isArray(result.deleted_indices)) updateNodeDeletedIndices(node, result.deleted_indices);
    if (result.deleted) clearImageDirHover(node);
    node.__hpsPreviewContextMessage = result.message || (result.deleted ? "Preview image deleted." : "Preview image not found.");
    node.__hpsPreviewContextMessageAt = Date.now();
  } else {
    node.__hpsPreviewContextMessage = result?.error || "Failed to delete preview image.";
    node.__hpsPreviewContextMessageAt = Date.now();
  }
  syncVuePreviewUI(node);
  setTimeout(() => syncVuePreviewUI(node), 5100);
  app.graph?.setDirtyCanvas?.(true, true);
}

async function openImageDirContextMenu(node, item, event) {
  hideHpsContextMenu();
  try {
    const result = await fetchImageDirContextMenu(node, item.index);
    if (!result?.ok) {
      showHpsContextMenu([{ label: result?.error || "Preview item not found", enabled: false }], event.clientX, event.clientY);
      return;
    }
    const items = (result.items || []).map((entry) => {
      if (entry?.id === "delete_image" && entry?.enabled !== false) {
        return {
          label: entry.label || "Delete image",
          enabled: true,
          onClick: async () => {
            if (!globalThis.confirm?.("Delete this image?")) return;
            await deleteImageDirPreviewImage(node, item.index);
          },
        };
      }
      if (entry?.id === "set_thumbnail" && entry?.enabled !== false) {
        return { label: entry.label || "Set as checkpoint thumbnail", enabled: true, onClick: () => setImageDirCheckpointThumbnail(node, item.index) };
      }
      return null;
    }).filter(Boolean);
    if (!items.length) {
      hideHpsContextMenu();
      return;
    }
    showHpsContextMenu(items, event.clientX, event.clientY);
  } catch (error) {
    showHpsContextMenu([{ label: "Failed to open menu", enabled: false }], event.clientX, event.clientY);
  }
}

function setupPreviewNode(nodeType) {
  installMinSize(nodeType, 340, 300);
  installTabIdSupport(nodeType);
  installCursorCapture();
  installImageDirHoverCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 340, 300);
    buildVuePreviewUI(this);
    if (isNodeClass(this, "EphemeralPreview")) setTimeout(() => restoreNodeStateFromBackend(this, "EphemeralPreview"), 0);
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    buildVuePreviewUI(this);
    if (isNodeClass(this, "EphemeralPreview")) setTimeout(() => restoreNodeStateFromBackend(this, "EphemeralPreview"), 0);
    return r;
  };

  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    ensureHiddenTabIdWidget(this);
    if (this.flags?.collapsed) return;
    const img = this.__hpsPreview;
    const g = previewGeometry(this);
    const messageX = Math.min(140, Math.max(g.margin, this.size[0] - 80));
    const captionY = g.isImageDir ? 36 : 20;
    const messageW = Math.max(1, this.size[0] - messageX - g.margin);
    ctx.save();
    if (this.__hpsPreviewCaption) {
      const st = this.__hpsPreviewState || {};
      const isWarning = st.status && !["ready", "loading"].includes(st.status);
      if (g.isImageDir) {
        ctx.fillStyle = isWarning ? "rgba(255,180,80,0.18)" : "rgba(0,0,0,0.18)";
        ctx.fillRect(messageX - 4, captionY - 13, messageW + 4, 18);
      }
      ctx.fillStyle = isWarning ? "#FFD28A" : "#ddd";
      ctx.font = "12px sans-serif";
      ctx.fillText(this.__hpsPreviewCaption, messageX, captionY, messageW);
    }
    if (g.isImageDir && (this.__hpsPreviewState?.progress || this.__hpsPreviewState?.progress_total)) {
      const st = this.__hpsPreviewState || {};
      const total = Math.max(1, Number(st.progress_total || st.max_preview_images || 1));
      const value = Math.max(0, Math.min(total, Number(st.progress_value || 0)));
      const barX = g.margin;
      const barY = 0;
      const barW = Math.max(1, this.size[0] - g.margin * 2);
      const barH = 6;
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = "rgba(255,255,255,0.58)";
      ctx.fillRect(barX, barY, barW * (value / total), barH);
    }
    const drawBox = previewDrawBox(this);
    if (img && drawBox) {
      ctx.drawImage(img, drawBox.x, drawBox.y, drawBox.w, drawBox.h);
      if (g.isImageDir) {
        for (const index of deletedImageDirIndexSet(this) || []) {
          const rect = imageDirPreviewTileRect(this, index);
          if (rect) drawNoImagePlaceholder(ctx, rect);
        }
      }
      if (g.isImageDir && this.__hpsHoveredPreviewIndex != null && !isImageDirDeletedIndex(this, this.__hpsHoveredPreviewIndex)) {
        const rect = imageDirPreviewTileRect(this, this.__hpsHoveredPreviewIndex);
        if (rect) {
          ctx.save();
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = 2;
          ctx.strokeRect(rect.x + 1, rect.y + 1, Math.max(1, rect.w - 2), Math.max(1, rect.h - 2));
          ctx.strokeStyle = "rgba(0,0,0,0.75)";
          ctx.lineWidth = 1;
          ctx.strokeRect(rect.x + 3, rect.y + 3, Math.max(1, rect.w - 6), Math.max(1, rect.h - 6));
          ctx.restore();
        }
      }
    } else {
      const st = this.__hpsPreviewState || {};
      const isLoading = st.status === "loading" || !!st.progress;
      if (!isLoading) {
        const text = this.__hpsPreviewCaption || "no preview";
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, this.size[0] / 2, g.top + g.h / 2, Math.max(1, g.w - 16));
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
      }
    }
    const contextMsg = this.__hpsPreviewContextMessage || "";
    const msgAge = Date.now() - Number(this.__hpsPreviewContextMessageAt || 0);
    if (contextMsg && msgAge < 5000 && g.isImageDir) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(8, Math.max(46, g.top - 22), Math.max(140, this.size[0] - 16), 18);
      ctx.fillStyle = "#ddd";
      ctx.font = "12px sans-serif";
      ctx.fillText(contextMsg, 12, Math.max(60, g.top - 9), Math.max(120, this.size[0] - 24));
    }
    ctx.restore();
  };

  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (event, pos, canvas) {
    if (isNodeClass(this, "ImageDirPreview") && event?.button === 0) {
      const local = previewLocalFromEventOrPos(this, event, pos);
      const item = imageDirPreviewItemAtLocal(this, local);
      if (item) {
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        setImageDirHover(this, item);
        openImageDirContextMenu(this, item, event);
        return true;
      }
      hideHpsContextMenu();
    }
    return origMouseDown ? origMouseDown.apply(this, arguments) : false;
  };
}

function syncVuePreviewUI(node, detail = null) {
  const ui = node?.__hpsVuePreviewUI;
  if (!ui) return;
  const state = detail || node.__hpsPreviewState || {};
  const contextMsg = node.__hpsPreviewContextMessage || "";
  const contextFresh = !!contextMsg && (Date.now() - Number(node.__hpsPreviewContextMessageAt || 0) < 5000);
  ui.caption.textContent = contextFresh
    ? contextMsg
    : (node.__hpsPreviewCaption || state.progress_message || state.message || "no preview");
  if (state.image) {
    const src = `data:image/${state.format || "jpeg"};base64,${state.image}`;
    // Only assign a changed src: re-assigning the same data URL reloads
    // the image and would retrigger the load handler that syncs again.
    if (ui.image.getAttribute("src") !== src) ui.image.src = src;
    ui.image.hidden = false;
    // The element carries inline display:block, which overrides the
    // [hidden] rule, so visibility must be driven through style as well.
    ui.image.style.display = "block";
  } else if (!state.progress) {
    ui.image.removeAttribute("src");
    ui.image.hidden = true;
    ui.image.style.display = "none";
  }
  // The canvas draws a placeholder over deleted tiles; mirror that with
  // overlay cells positioned over the letterboxed image content.
  if (ui.deletedOverlay) {
    ui.deletedOverlay.replaceChildren();
    if (isNodeClass(node, "ImageDirPreview")) {
      for (const index of deletedImageDirIndexSet(node) || []) {
        const rect = vuePreviewTileRect(node, index);
        if (!rect) continue;
        const cell = document.createElement("div");
        cell.style.position = "absolute";
        cell.style.left = `${rect.x}px`;
        cell.style.top = `${rect.y}px`;
        cell.style.width = `${rect.w}px`;
        cell.style.height = `${rect.h}px`;
        cell.style.background = "rgba(20,20,20,0.92)";
        cell.style.color = "rgba(255,255,255,0.88)";
        cell.style.display = "flex";
        cell.style.alignItems = "center";
        cell.style.justifyContent = "center";
        cell.style.font = "bold 10px sans-serif";
        cell.textContent = "NO IMAGE";
        ui.deletedOverlay.append(cell);
      }
    }
  }
}

function vuePreviewContentBox(node) {
  const ui = node?.__hpsVuePreviewUI;
  if (!ui?.image) return null;
  const rect = ui.image.getBoundingClientRect();
  const naturalW = ui.image.naturalWidth || 0;
  const naturalH = ui.image.naturalHeight || 0;
  // clientWidth/clientHeight are layout pixels. getBoundingClientRect()
  // is post-transform: the Vue node layer is CSS-scaled by the canvas
  // zoom, so measuring with the rect and then positioning in layout
  // pixels double-applies the zoom and the overlay drifts (about 0.87x
  // and up-left in the reported screenshot). Keep all geometry in
  // layout pixels and carry the zoom factor separately for events.
  const layoutW = ui.image.clientWidth || rect.width;
  const layoutH = ui.image.clientHeight || rect.height;
  if (!layoutW || !layoutH || !naturalW || !naturalH) return null;
  const scale = Math.min(layoutW / naturalW, layoutH / naturalH);
  if (!(scale > 0)) return null;
  return {
    rect,
    scale,
    zoom: layoutW ? rect.width / layoutW : 1,
    offsetX: (layoutW - naturalW * scale) / 2,
    offsetY: (layoutH - naturalH * scale) / 2,
  };
}

function vuePreviewTileRect(node, index) {
  const st = node?.__hpsPreviewState || {};
  const cols = Number(st.columns || 0);
  const tileW = Number(st.tile_width || 0);
  const tileH = Number(st.tile_height || 0);
  const gap = Number(st.gap || 0);
  if (!cols || !tileW || !tileH || index == null || index < 0) return null;
  const box = vuePreviewContentBox(node);
  if (!box) return null;
  const row = Math.floor(index / cols);
  const col = index % cols;
  return {
    x: box.offsetX + col * (tileW + gap) * box.scale,
    y: box.offsetY + row * (tileH + gap) * box.scale,
    w: tileW * box.scale,
    h: tileH * box.scale,
  };
}

function vuePreviewItemFromEvent(node, event) {
  const box = vuePreviewContentBox(node);
  if (!box || !event) return null;
  // Client coordinates are post-transform; convert back to layout
  // pixels before comparing with the layout-pixel content box.
  const zoom = box.zoom || 1;
  const px = (event.clientX - box.rect.left) / zoom;
  const py = (event.clientY - box.rect.top) / zoom;
  const contentW = (node.__hpsVuePreviewUI?.image?.naturalWidth || 0) * box.scale;
  const contentH = (node.__hpsVuePreviewUI?.image?.naturalHeight || 0) * box.scale;
  if (px < box.offsetX || py < box.offsetY || px > box.offsetX + contentW || py > box.offsetY + contentH) return null;
  return imageDirPreviewItemAtImagePoint(node, (px - box.offsetX) / box.scale, (py - box.offsetY) / box.scale);
}
function buildVuePreviewUI(node) {
  if (node.__hpsVuePreviewUI) return;
  const root = document.createElement("div");
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "6px";
  root.style.padding = "2px 0";
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.minWidth = "0";
  const stage = document.createElement("div");
  stage.style.position = "relative";
  stage.style.flex = "1 1 auto";
  stage.style.minHeight = "0";
  stage.style.width = "100%";
  const image = document.createElement("img");
  image.style.display = "block";
  image.style.width = "100%";
  image.style.height = "100%";
  image.style.minHeight = "0";
  image.style.objectFit = "contain";
  image.hidden = true;
  const deletedOverlay = document.createElement("div");
  deletedOverlay.style.position = "absolute";
  deletedOverlay.style.inset = "0";
  deletedOverlay.style.pointerEvents = "none";
  const hoverBox = document.createElement("div");
  hoverBox.style.position = "absolute";
  hoverBox.style.display = "none";
  hoverBox.style.border = "2px solid rgba(255,255,255,0.95)";
  hoverBox.style.boxShadow = "inset 0 0 0 1px rgba(0,0,0,0.75)";
  hoverBox.style.pointerEvents = "none";
  stage.append(image, deletedOverlay, hoverBox);
  const caption = document.createElement("small");
  caption.style.order = "-1";
  caption.style.whiteSpace = "pre-wrap";
  caption.style.minHeight = "16px";
  caption.style.color = "#FFD28A";
  root.append(stage, caption);
  stopHpsWidgetEventPropagation(root);
  // In the Vue renderer the LiteGraph onMouseDown never fires for this
  // node, so the click menu (delete image / set checkpoint thumbnail)
  // must be opened from the DOM image itself, mapping the click through
  // the object-fit: contain letterbox into composite-image coordinates.
  image.addEventListener("click", (event) => {
    if (!isNodeClass(node, "ImageDirPreview")) return;
    const item = vuePreviewItemFromEvent(node, event);
    if (item) {
      setImageDirHover(node, item);
      void openImageDirContextMenu(node, item, event);
    } else {
      hideHpsContextMenu();
    }
  });
  image.addEventListener("mousemove", (event) => {
    if (!isNodeClass(node, "ImageDirPreview")) return;
    const item = vuePreviewItemFromEvent(node, event);
    image.style.cursor = item ? "pointer" : "";
    const rect = item ? vuePreviewTileRect(node, item.index) : null;
    if (rect) {
      hoverBox.style.display = "block";
      hoverBox.style.left = `${rect.x}px`;
      hoverBox.style.top = `${rect.y}px`;
      hoverBox.style.width = `${rect.w}px`;
      hoverBox.style.height = `${rect.h}px`;
    } else {
      hoverBox.style.display = "none";
    }
  });
  image.addEventListener("mouseleave", () => {
    hoverBox.style.display = "none";
    image.style.cursor = "";
  });
  image.addEventListener("load", () => syncVuePreviewUI(node));
  // Fixed height: deriving the widget height from node.size is circular
  // in the Vue renderer, where the node height is the sum of its widgets.
  if (!addVueOnlyDomWidget(node, "hps_preview", "hps-preview", root, 260, "fill")) return;
  node.__hpsVuePreviewUI = { root, stage, image, caption, deletedOverlay, hoverBox };
  syncVuePreviewUI(node);
}

api.addEventListener(PREVIEW_EVENT, ({ detail }) => {
  if (!isForThisTab(detail)) return;
  const node = findGraphNodeById(detail?.node);
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
  if (isNodeClass(node, "ImageDirPreview")) node.__hpsHoveredPreviewIndex = null;
  const caption = detail.progress_message || detail.message || `${detail.count ?? 0} img · ${detail.columns ?? 0}×${detail.rows ?? 0} · ${detail.width ?? 0}×${detail.height ?? 0}`;
  node.__hpsPreviewCaption = caption;
  if (!detail.image) {
    if (!detail.progress) node.__hpsPreview = null;
    syncVuePreviewUI(node, detail);
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
  syncVuePreviewUI(node, detail);
});

// ---------- Selector ----------
const SELECTOR_VISIBLE_ROWS = 20;
const ROW_H = 20;
const SELECTOR_THUMBNAIL_POPUP_W = 250;
const SELECTOR_THUMBNAIL_POPUP_H = 250;
const selectorThumbnailCache = new Map();

function selectorThumbnailCacheKey(ckptName) {
  return String(ckptName || "");
}

function clearSelectorThumbnailHover(node) {
  if (!node) return;
  if (node.__hpsHoverCkptName || node.__hpsHoverRowIndex != null || node.__hpsHoverSource) {
    node.__hpsHoverCkptName = "";
    node.__hpsHoverRowIndex = null;
    node.__hpsHoverSource = "";
    app.graph?.setDirtyCanvas?.(true, true);
  }
}

function selectorVisibleRowIndexForCheckpoint(node, ckptName) {
  if (!ckptName) return null;
  const idx = selectorItems(node).findIndex((entry) => entry.ckpt_name_str === ckptName);
  if (idx < 0) return null;
  const row = idx - (node.__hpsScroll || 0);
  return row >= 0 && row < SELECTOR_VISIBLE_ROWS ? row : null;
}

function setSelectorThumbnailHover(node, ckptName, rowIndex = null, source = "") {
  if (!node || !ckptName) {
    clearSelectorThumbnailHover(node);
    return;
  }
  if (node.__hpsHoverCkptName !== ckptName || node.__hpsHoverRowIndex !== rowIndex || node.__hpsHoverSource !== source) {
    node.__hpsHoverCkptName = ckptName;
    node.__hpsHoverRowIndex = rowIndex;
    node.__hpsHoverSource = source;
    requestSelectorThumbnail(node, ckptName);
    app.graph?.setDirtyCanvas?.(true, true);
  }
}

function selectorItemAtLocal(node, local) {
  if (!local) return null;
  const r = selectorRects(node);
  if (!hit(local, r.list)) return null;
  const row = Math.floor((local[1] - r.list.y) / ROW_H);
  if (row < 0 || row >= SELECTOR_VISIBLE_ROWS) return null;
  const item = selectorItems(node)[(node.__hpsScroll || 0) + row];
  if (!item) return null;
  return { item, row };
}

async function requestSelectorThumbnail(node, ckptName) {
  const key = selectorThumbnailCacheKey(ckptName);
  if (!key) return;
  const cached = selectorThumbnailCache.get(key);
  if (cached?.status === "loading" || cached?.status === "ready" || cached?.status === "missing") return;
  selectorThumbnailCache.set(key, { status: "loading" });
  app.graph?.setDirtyCanvas?.(true, true);
  try {
    const query = new URLSearchParams({ ckpt_name_str: key });
    const response = await api.fetchApi(`/${EXTENSION_PREFIX}/selector/thumbnail?${query.toString()}`, { cache: "no-store" });
    const result = await response.json();
    if (!result?.ok || !result.found || !result.image) {
      selectorThumbnailCache.set(key, { status: "missing" });
      syncVueSelectorThumbnailUI(node);
      app.graph?.setDirtyCanvas?.(true, true);
      return;
    }
    const img = new Image();
    img.onload = () => {
      selectorThumbnailCache.set(key, {
        status: "ready",
        image: img,
        width: result.width || img.width,
        height: result.height || img.height,
        thumbnail_path: result.thumbnail_path || "",
      });
      syncVueSelectorThumbnailUI(node);
      app.graph?.setDirtyCanvas?.(true, true);
    };
    img.onerror = () => {
      selectorThumbnailCache.set(key, { status: "missing" });
      syncVueSelectorThumbnailUI(node);
      app.graph?.setDirtyCanvas?.(true, true);
    };
    img.src = `data:image/${result.format || "jpeg"};base64,${result.image}`;
  } catch (error) {
    selectorThumbnailCache.set(key, { status: "missing", error: String(error) });
    syncVueSelectorThumbnailUI(node);
    app.graph?.setDirtyCanvas?.(true, true);
  }
}

function updateSelectorThumbnailHover(node, event, pos) {
  if (!node || hpsNodeCollapsed(node)) return;
  const local = selectorLocalFromEventOrPos(node, event, pos);
  if (!hpsLocalInsideNode(node, local)) {
    clearSelectorThumbnailHover(node);
    return;
  }

  const hitItem = selectorItemAtLocal(node, local);
  if (hitItem?.item?.ckpt_name_str) {
    setSelectorThumbnailHover(node, hitItem.item.ckpt_name_str, hitItem.row, "list");
    return;
  }

  const selected = selectorSelected(node);
  if (selected) {
    setSelectorThumbnailHover(node, selected, selectorVisibleRowIndexForCheckpoint(node, selected), "selected");
    return;
  }

  clearSelectorThumbnailHover(node);
}

function drawSelectorThumbnailPopup(ctx, node) {
  const ckpt = node.__hpsHoverCkptName || "";
  if (!ckpt) return;
  const r = selectorRects(node);
  const cache = selectorThumbnailCache.get(selectorThumbnailCacheKey(ckpt)) || { status: "loading" };
  const x = r.list.x + r.list.w + 12;
  const rowIndex = Number.isFinite(node.__hpsHoverRowIndex) ? node.__hpsHoverRowIndex : null;
  const preferredY = rowIndex == null ? 46 : r.list.y + rowIndex * ROW_H - 8;
  const y = Math.max(8, Math.min(preferredY, (node.size?.[1] || 540) - SELECTOR_THUMBNAIL_POPUP_H - 8));
  const w = SELECTOR_THUMBNAIL_POPUP_W;
  const h = SELECTOR_THUMBNAIL_POPUP_H;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = 16;
  ctx.fillStyle = "rgba(20,20,20,0.94)";
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 1;
  drawRounded(ctx, x, y, w, h, 10);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  const pad = 8;
  const titleH = 22;
  ctx.fillStyle = "#ddd";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(ckpt, x + pad, y + 14, w - pad * 2);

  const imgBox = { x: x + pad, y: y + titleH + pad, w: w - pad * 2, h: h - titleH - pad * 2 };
  if (cache.status === "ready" && cache.image) {
    const img = cache.image;
    let dw = imgBox.w;
    let dh = dw * (img.height / img.width);
    if (dh > imgBox.h) {
      dh = imgBox.h;
      dw = dh * (img.width / img.height);
    }
    const ix = imgBox.x + (imgBox.w - dw) / 2;
    const iy = imgBox.y + (imgBox.h - dh) / 2;
    ctx.drawImage(img, ix, iy, dw, dh);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(imgBox.x, imgBox.y, imgBox.w, imgBox.h);
    ctx.fillStyle = cache.status === "missing" ? "#aaa" : "#ddd";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cache.status === "missing" ? "No sidecar thumbnail" : "Loading thumbnail...", imgBox.x + imgBox.w / 2, imgBox.y + imgBox.h / 2, imgBox.w - 12);
  }
  ctx.restore();
}


function selectorWidget(node) {
  return getWidget(node, "checkpoint");
}
function hideSelectorWidget(node) {
  const w = selectorWidget(node);
  if (w) {
    // Mirror the file's other hiding helpers: in the store-backed Vue
    // widget system, changing type alone may not suppress the widget.
    w.type = "hidden";
    w.hidden = true;
    w.options = { ...(w.options || {}), hidden: true };
    w.computeSize = () => [0, -4];
    w.draw = () => {};
  }
}

let vueSelectorThumbnailPopup = null;
let vueSelectorThumbnailOwner = null;

function ensureVueSelectorThumbnailPopup() {
  if (vueSelectorThumbnailPopup) return vueSelectorThumbnailPopup;
  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.zIndex = "10000";
  root.style.display = "none";
  root.style.width = `${SELECTOR_THUMBNAIL_POPUP_W}px`;
  root.style.padding = "8px";
  root.style.boxSizing = "border-box";
  root.style.border = "1px solid rgba(215,225,245,0.5)";
  root.style.borderRadius = "6px";
  root.style.background = "rgba(26,26,31,0.97)";
  root.style.boxShadow = "0 8px 22px rgba(0,0,0,0.55)";
  root.style.pointerEvents = "none";
  const title = document.createElement("div");
  title.style.marginBottom = "6px";
  title.style.color = "#ddd";
  title.style.fontSize = "12px";
  title.style.overflow = "hidden";
  title.style.textOverflow = "ellipsis";
  title.style.whiteSpace = "nowrap";
  const image = document.createElement("img");
  image.style.display = "none";
  image.style.width = "100%";
  image.style.height = `${SELECTOR_THUMBNAIL_POPUP_H - 36}px`;
  image.style.objectFit = "contain";
  const message = document.createElement("div");
  message.style.height = `${SELECTOR_THUMBNAIL_POPUP_H - 36}px`;
  message.style.display = "grid";
  message.style.placeItems = "center";
  message.style.color = "#bbb";
  message.style.fontSize = "12px";
  root.append(title, image, message);
  document.body.append(root);
  vueSelectorThumbnailPopup = { root, title, image, message };
  return vueSelectorThumbnailPopup;
}

function hideVueSelectorThumbnail(node = null) {
  if (node && vueSelectorThumbnailOwner !== node) return;
  if (vueSelectorThumbnailPopup) vueSelectorThumbnailPopup.root.style.display = "none";
  vueSelectorThumbnailOwner = null;
  if (node) node.__hpsVueThumbnailCkptName = "";
}

function syncVueSelectorThumbnailUI(node) {
  const ckptName = node?.__hpsVueThumbnailCkptName || "";
  if (!ckptName || vueSelectorThumbnailOwner !== node) return;
  const popup = ensureVueSelectorThumbnailPopup();
  const cached = selectorThumbnailCache.get(selectorThumbnailCacheKey(ckptName)) || { status: "loading" };
  popup.title.textContent = ckptName;
  if (cached.status === "ready" && cached.image?.src) {
    popup.image.src = cached.image.src;
    popup.image.style.display = "block";
    popup.message.style.display = "none";
  } else {
    popup.image.removeAttribute("src");
    popup.image.style.display = "none";
    popup.message.style.display = "grid";
    popup.message.textContent = cached.status === "missing" ? "No sidecar thumbnail" : "Loading thumbnail...";
  }
}

function showVueSelectorThumbnail(node, ckptName, anchor) {
  if (!node || !ckptName || !anchor) return;
  vueSelectorThumbnailOwner = node;
  node.__hpsVueThumbnailCkptName = ckptName;
  setSelectorThumbnailHover(node, ckptName, null, "vue-list");
  const popup = ensureVueSelectorThumbnailPopup();
  const rect = anchor.getBoundingClientRect();
  const width = SELECTOR_THUMBNAIL_POPUP_W;
  const height = SELECTOR_THUMBNAIL_POPUP_H;
  const left = rect.right + width + 12 <= window.innerWidth ? rect.right + 12 : Math.max(8, rect.left - width - 12);
  const top = Math.max(8, Math.min(window.innerHeight - height - 8, rect.top - 8));
  popup.root.style.left = `${left}px`;
  popup.root.style.top = `${top}px`;
  popup.root.style.display = "block";
  syncVueSelectorThumbnailUI(node);
}

function syncVueSelectorUI(node) {
  const ui = node?.__hpsVueSelectorUI;
  if (!ui) return;
  const selected = selectorSelected(node);
  const listScrollTop = ui.list.scrollTop;
  ui.list.replaceChildren();
  for (const item of selectorItems(node)) {
    const row = document.createElement("button");
    const value = item.ckpt_name_str || "";
    row.type = "button";
    row.textContent = `${STATUS_ICON[item.status || "none"] || ""} ${value}`.trim();
    row.dataset.active = String(value === selected);
    row.setAttribute("aria-pressed", String(value === selected));
    row.style.display = "block";
    row.style.width = "100%";
    row.style.minHeight = "22px";
    row.style.padding = "2px 7px";
    row.style.textAlign = "left";
    row.style.border = value === selected ? "1px solid rgba(176,216,255,0.9)" : "1px solid transparent";
    row.style.borderRadius = "3px";
    row.style.background = value === selected ? "rgba(78,121,177,0.82)" : "transparent";
    row.addEventListener("click", () => {
      setSelectorSelected(node, value);
      syncVueSelectorUI(node);
    });
    row.addEventListener("pointerenter", () => showVueSelectorThumbnail(node, value, row));
    row.addEventListener("focus", () => showVueSelectorThumbnail(node, value, row));
    ui.list.append(row);
  }
  // Rebuilding the rows collapses the scroll height and would otherwise
  // clamp scrollTop back toward the top on every selection.
  ui.list.scrollTop = listScrollTop;
  ui.refresh.disabled = !!node.__hpsLoading;
  ui.action.disabled = !!node.__hpsLoading || !selected;
  ui.action.textContent = selectorActionLabel(node);
  const directLinkOn = selectorDirectLinkEnabled(node);
  ui.action.dataset.active = String(directLinkOn);
  ui.action.setAttribute("aria-pressed", String(directLinkOn));
  ui.action.style.background = directLinkOn ? "rgba(74,151,105,0.94)" : "";
  ui.action.style.borderColor = directLinkOn ? "rgba(218,255,227,0.95)" : "";
  ui.action.style.boxShadow = directLinkOn ? "0 0 0 1px rgba(28,90,48,0.7) inset" : "";
  ui.status.textContent = node.__hpsStatus || "not loaded";
  refreshVueLayoutReclaim(node);
}
function buildVueSelectorUI(node) {
  if (node.__hpsVueSelectorUI) return;
  const root = document.createElement("div");
  root.style.display = "grid";
  root.style.gap = "6px";
  root.style.padding = "2px 0";
  root.style.width = "100%";
  root.style.gridTemplateRows = "auto auto 1fr";
  const list = document.createElement("div");
  list.style.overflowY = "auto";
  list.style.border = "1px solid rgba(210,220,240,0.34)";
  list.style.borderRadius = "4px";
  list.style.padding = "2px";
  list.style.background = "rgba(0,0,0,0.16)";
  // The list height is fixed on purpose: sizing it from the node
  // body makes the frontend treat the list height as required
  // content, which blocks shrinking and slowly stretches the node.
  // A fixed-height scrolling list (388 = the 452 widget height
  // minus the toolbar, status line and gaps) stays stable.
  list.style.maxHeight = "388px";
  keepWheelForNativeScroll(list);
  const buttons = document.createElement("div");
  buttons.style.display = "flex";
  buttons.style.gap = "6px";
  const refresh = document.createElement("button");
  refresh.textContent = "🔄 Refresh All";
  const action = document.createElement("button");
  const up = document.createElement("button");
  up.type = "button";
  up.textContent = "▲";
  up.title = "Scroll up";
  const down = document.createElement("button");
  down.type = "button";
  down.textContent = "▼";
  down.title = "Scroll down";
  const status = document.createElement("small");
  status.style.whiteSpace = "pre-wrap";
  buttons.append(refresh, action, up, down);
  root.append(buttons, status, list);
  stopHpsWidgetEventPropagation(root);
  root.addEventListener("pointerleave", () => hideVueSelectorThumbnail(node));
  refresh.addEventListener("click", () => void refreshSelector(node, true).finally(() => syncVueSelectorUI(node)));
  up.addEventListener("click", () => uiScrollByRows(node, -SELECTOR_VISIBLE_ROWS));
  down.addEventListener("click", () => uiScrollByRows(node, SELECTOR_VISIBLE_ROWS));
  action.addEventListener("click", () => {
    const mode = selectorActionMode(node);
    if (mode === "sync") void syncSelectedCheckpoint(node).finally(() => syncVueSelectorUI(node));
    else if (mode === "directlink") toggleSelectorDirectLink(node);
    else void pushSelectedToLocalList(node).finally(() => syncVueSelectorUI(node));
    syncVueSelectorUI(node);
  });
  if (!addVueOnlyDomWidget(node, "hps_selector_controls", "hps-selector-controls", root, 452, "shift")) return;
  node.__hpsVueSelectorUI = { root, list, refresh, action, up, down, status };
  syncVueSelectorUI(node);
}
function uiScrollByRows(node, rows) {
  const list = node?.__hpsVueSelectorUI?.list;
  if (!list) return;
  // Vue rows render about 28px tall (min-height, padding, border), not
  // the 20px canvas ROW_H, so page scrolling must use the DOM row height.
  list.scrollBy({ top: rows * 28, behavior: "smooth" });
}
function selectorRects(node) {
  const margin = 8;
  const gap = 6;
  const buttonY = 8;
  const buttonH = 24;
  const arrowW = 32;
  const refreshW = 102;
  const pushW = selectorActionMode(node) === "sync" ? 150 : 174;
  const pushX = margin + refreshW + gap;
  // Keep scroll buttons close to the toolbar action buttons instead of anchoring
  // them to the right edge. The right edge belongs to ComfyUI output pins.
  const upX = pushX + pushW + gap;
  const downX = upX + arrowW + gap;
  return {
    refreshAll: { x: margin, y: buttonY, w: refreshW, h: buttonH },
    pushLocalList: { x: pushX, y: buttonY, w: pushW, h: buttonH },
    up: { x: upX, y: buttonY, w: arrowW, h: buttonH },
    down: { x: downX, y: buttonY, w: arrowW, h: buttonH },
    list: { x: margin, y: 104, w: node.size[0] - 16, h: ROW_H * SELECTOR_VISIBLE_ROWS },
  };
}
function selectorItems(node) { return node?.__hpsItems || []; }
function selectorSelected(node) { return node ? (selectorWidget(node)?.value || node.__hpsSelected || "") : ""; }
function selectorStatusFor(node, ckptName) {
  const item = selectorItems(node).find((entry) => entry.ckpt_name_str === ckptName);
  return item?.status || "none";
}

function selectorTitleText(node, ckptName) {
  if (!ckptName) return "Checkpoint List Selector";
  const status = selectorStatusFor(node, ckptName);
  return `Selector : ${titleDisplayForCheckpoint(ckptName, status)}`;
}

function setSelectorSelected(node, value) {
  const w = selectorWidget(node); if (w) w.value = value;
  node.__hpsSelected = value;
  node.graph?.change?.();
  node.title = selectorTitleText(node, value);
  updateDirectLinkTaggers(node);
}
function selectorStatusText(result, prefix = "") {
  const s = result?.summary || {};
  return `${prefix}${s.total ?? 0} total (👑:${s.god ?? 0}, 💛:${s.favorite ?? 0}, 👍:${s.nice ?? 0}, ✔:${s.keep ?? 0}, 🗑:${s.delete ?? 0}, —:${s.none ?? 0})`;
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
  syncVuePreviewUI(node);
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function selectorActionMode(node) {
  const targets = getSelectorReviewTargets(node);
  if (targets.previews.length) return "sync";
  if (targets.taggers.length) return "directlink";
  return "push";
}

function selectorDirectLinkEnabled(node) {
  return selectorActionMode(node) === "directlink" && !!node.__hpsDirectLinkEnabled;
}

function selectorActionLabel(node) {
  const mode = selectorActionMode(node);
  if (mode === "sync") return "🎯 Sync Checkpoint";
  if (mode === "directlink") return selectorDirectLinkEnabled(node) ? "🌕 DirectLink ON" : "🌑 DirectLink OFF";
  return "🏹 Push to Local List";
}

const DIRECT_LINK_CONFIRM_MESSAGE = "Enable DirectLink?\n\nUse this mode only while checking generated images on a tablet, shared folder, or external viewer.\n\nOtherwise, connect ImageDirPreview and use Sync mode.\n\nTagger will label the checkpoint selected in ListSelector.";
let hpsDirectLinkConfirmShown = false;

function directLinkTaggerTargets(node) {
  const targets = getSelectorReviewTargets(node);
  return selectorActionMode(node) === "directlink" ? targets.taggers : [];
}

function clearTaggerTarget(node) {
  if (!node) return;
  node.__hpsTaggerPath = "";
  node.__hpsTaggerStatus = "none";
  node.__hpsTaggerMessage = "";
  if (isNodeClass(node, TAGGER_CLASS)) node.title = "Tagger";
  syncVueTaggerUI(node);
}

function setTaggerTargetSnapshot(node, ckptName, status = "none") {
  if (!node || !ckptName) return;
  node.__hpsTaggerPath = ckptName;
  node.__hpsTaggerStatus = status || "none";
  node.__hpsTaggerMessage = taggerCurrentMessage(node.__hpsTaggerStatus);
  node.title = node.__hpsTaggerStatus === "none"
    ? `Tagger : ${ckptName}`
    : `Tagger : ${STATUS_ICON[node.__hpsTaggerStatus]} ${ckptName}`;
  syncVueTaggerUI(node);
}

function updateDirectLinkTaggers(node) {
  const taggers = directLinkTaggerTargets(node);
  if (!taggers.length) return;
  if (!selectorDirectLinkEnabled(node)) {
    for (const tagger of taggers) clearTaggerTarget(tagger);
    app.graph?.setDirtyCanvas?.(true, true);
    return;
  }
  const selected = selectorSelected(node);
  if (!selected) {
    for (const tagger of taggers) clearTaggerTarget(tagger);
    app.graph?.setDirtyCanvas?.(true, true);
    return;
  }
  const status = selectorStatusFor(node, selected);
  for (const tagger of taggers) setTaggerTargetSnapshot(tagger, selected, status);
  app.graph?.setDirtyCanvas?.(true, true);
}

function toggleSelectorDirectLink(node) {
  if (selectorActionMode(node) !== "directlink") return;
  if (!node.__hpsDirectLinkEnabled) {
    if (!hpsDirectLinkConfirmShown) {
      hpsDirectLinkConfirmShown = true;
      if (!globalThis.confirm?.(DIRECT_LINK_CONFIRM_MESSAGE)) return;
    }
    node.__hpsDirectLinkEnabled = true;
  } else {
    node.__hpsDirectLinkEnabled = false;
  }
  updateDirectLinkTaggers(node);
  node.__hpsStatus = selectorDirectLinkEnabled(node)
    ? "DirectLink ON: Tagger follows selected checkpoint."
    : "DirectLink OFF: connect ImageDirPreview for Sync mode, or enable DirectLink for external review.";
  syncVueSelectorUI(node);
  app.graph?.setDirtyCanvas?.(true, true);
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
    } else if (selectorSelected(node)) {
      node.title = selectorTitleText(node, selectorSelected(node));
    }

    if (all) {
      selectorThumbnailCache.clear();
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
    syncVueSelectorUI(node);
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
        .filter((n) => isNodeClass(n, CYCLER_CLASS) && n.__hpsUseLocalList !== false)
        .map((n) => n.id),
    })),
  });
  const result = await response.json();
  if (result.ok && Array.isArray(result.states)) {
    for (const state of result.states) {
      const cycler = findGraphNodeById(state.node_id);
      if (cycler && isNodeClass(cycler, CYCLER_CLASS)) applyCyclerStatePayload(cycler, state);
    }
  }
  console.info(`[INFO] [CheckpointHandpickerSuite] Push Local List: ${selected} -> ${result.updated ?? 0} Cycler(s)`);
  node.__hpsStatus = result.ok
    ? `pushed : ${selected} (${result.updated} Cycler)`
    : (result.error || "Push failed");
  syncVueSelectorUI(node);
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
  syncVueSelectorUI(node);
  app.graph.setDirtyCanvas(true, true);
}

function maxSelectorScroll(node) {
  return Math.max(0, selectorItems(node).length - SELECTOR_VISIBLE_ROWS);
}

function scrollSelector(node, delta) {
  node.__hpsScroll = Math.max(0, Math.min(maxSelectorScroll(node), (node.__hpsScroll || 0) + delta));
  clearSelectorThumbnailHover(node);
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
  if (hit(local, r.refreshAll) || hit(local, r.pushLocalList) || hit(local, r.up) || hit(local, r.down)) return "pointer";
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
    const icon = selectorStatusIcon(status);
    // Keep the checkpoint-name column aligned even when status is none.
    ctx.textAlign = "center";
    ctx.fillText(icon, r.list.x + 14, y + ROW_H / 2, 18);
    ctx.textAlign = "left";
    ctx.fillText(ckpt, r.list.x + 28, y + ROW_H / 2, r.list.w - 42);
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
    buildVueSelectorUI(this);
    setTimeout(() => refreshSelector(this, false), 0);
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    hideSelectorWidget(this);
    buildVueSelectorUI(this);
    return r;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    ensureHiddenTabIdWidget(this);
    hideSelectorWidget(this);
    if (hpsNodeCollapsed(this)) return;
    const r = selectorRects(this);
    if (selectorActionMode(this) !== "directlink" && this.__hpsDirectLinkEnabled) {
      this.__hpsDirectLinkEnabled = false;
    }
    drawButton(ctx, r.refreshAll, "🔄 Refresh All", !this.__hpsLoading);
    drawButton(ctx, r.pushLocalList, selectorActionLabel(this), !this.__hpsLoading, selectorDirectLinkEnabled(this));
    drawButton(ctx, r.up, "▲", true);
    drawButton(ctx, r.down, "▼", true);

    ctx.save();
    ctx.fillStyle = "#ccc";
    ctx.font = "12px sans-serif";
    const status = this.__hpsStatus || "not loaded";
    status.split("\n").slice(0, 3).forEach((line, i) => ctx.fillText(line, 8, 50 + i * 14));
    ctx.restore();

    drawSelectorRows(ctx, this);
    drawSelectorThumbnailPopup(ctx, this);
  };

  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (event, pos, canvas) {
    if (hpsNodeCollapsed(this)) return origMouseDown ? origMouseDown.apply(this, arguments) : false;

    const r = selectorRects(this);
    const local = selectorLocalFromEventOrPos(this, event, pos);
    if (!local) return origMouseDown ? origMouseDown.apply(this, arguments) : false;

    if (hit(local, r.refreshAll)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      refreshSelector(this, true);
      return true;
    }
    if (hit(local, r.pushLocalList)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      const mode = selectorActionMode(this);
      if (mode === "sync") syncSelectedCheckpoint(this);
      else if (mode === "directlink") toggleSelectorDirectLink(this);
      else pushSelectedToLocalList(this);
      return true;
    }
    if (hit(local, r.up)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      scrollSelector(this, -SELECTOR_VISIBLE_ROWS);
      return true;
    }
    if (hit(local, r.down)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      scrollSelector(this, SELECTOR_VISIBLE_ROWS);
      return true;
    }

    const sb = selectorScrollbar(this);
    if (sb) {
      if (hit(local, sb.thumb)) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        event?.stopImmediatePropagation?.();
        this.__hpsScrollbarDragging = true;
        this.__hpsScrollbarDragOffset = local[1] - sb.thumb.y;
        this.__hpsScrollbarStartY = local[1];
        this.__hpsScrollbarStartScroll = sb.scroll;
        app.graph?.setDirtyCanvas?.(true, true);
        return true;
      }

      if (hit(local, sb.track)) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        event?.stopImmediatePropagation?.();
        if (local[1] < sb.thumb.y) {
          scrollSelector(this, -SELECTOR_VISIBLE_ROWS);
        } else {
          scrollSelector(this, SELECTOR_VISIBLE_ROWS);
        }
        return true;
      }
    }

    if (hit(local, r.list)) {
      const row = Math.floor((local[1] - r.list.y) / ROW_H);
      const item = selectorItems(this)[(this.__hpsScroll || 0) + row];
      if (item) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        event?.stopImmediatePropagation?.();
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

    updateSelectorThumbnailHover(this, event, pos);
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
    const local = selectorLocalFromEventOrPos(this, event, pos);
    if (hit(local, r.list)) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      scrollSelector(this, event.deltaY > 0 ? 3 : -3);
      return true;
    }
    return origMouseWheel ? origMouseWheel.apply(this, arguments) : false;
  };
}

// ---------- Tag Export / Import ----------
function tagTransferDirectoryValue(node) {
  const inputValue = node?.__hpsTagTransferDirectoryUI?.input?.value;
  if (inputValue !== undefined) return String(inputValue);
  return String(getWidget(node, TAG_TRANSFER_DIRECTORY_WIDGET)?.value ?? "");
}

function hideTagTransferDirectorySavedWidget(widget) {
  if (!widget) return;
  widget.type = "hidden";
  widget.hidden = true;
  widget.disabled = true;
  widget.serialize = true;
  widget.options = { ...(widget.options || {}), hidden: true };
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  for (const element of [widget.element, widget.inputEl, widget.domWidget?.element, widget.options?.element]) {
    if (!(element instanceof HTMLElement)) continue;
    element.hidden = true;
    element.setAttribute("aria-hidden", "true");
    element.style.setProperty("display", "none", "important");
  }
}

function buildTagTransferDirectoryUI(node) {
  const savedWidget = getWidget(node, TAG_TRANSFER_DIRECTORY_WIDGET);
  if (!savedWidget) return;
  if (node.__hpsTagTransferDirectoryUI) {
    node.__hpsTagTransferDirectoryUI.input.value = String(savedWidget.value ?? "");
    return;
  }
  savedWidget.label = "Tag Transfer Directory (full path only / network paths OK)";
  savedWidget.options = { ...(savedWidget.options || {}), placeholder: TAG_TRANSFER_DIRECTORY_PLACEHOLDER };
  if (typeof node.addDOMWidget !== "function") return;

  const root = document.createElement("div");
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "4px";
  root.style.width = "100%";
  root.style.height = "58px";
  root.style.boxSizing = "border-box";
  root.style.padding = "2px 0";

  const label = document.createElement("label");
  label.textContent = "Tag Transfer Directory (full path only / network paths OK)";
  label.style.fontSize = "11px";
  label.style.color = "rgba(230,230,230,0.88)";
  label.style.userSelect = "none";

  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.value = String(savedWidget.value ?? "");
  input.placeholder = TAG_TRANSFER_DIRECTORY_PLACEHOLDER;
  input.style.width = "100%";
  input.style.height = "30px";
  input.style.boxSizing = "border-box";
  input.style.padding = "5px 8px";
  input.style.border = "1px solid rgba(200,220,245,0.42)";
  input.style.borderRadius = "4px";
  input.style.background = "rgba(20,20,20,0.72)";
  input.style.color = "inherit";
  input.style.fontFamily = "monospace";
  input.style.fontSize = "11px";
  root.append(label, input);

  for (const eventName of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup"]) {
    input.addEventListener(eventName, (event) => event.stopPropagation());
  }
  input.addEventListener("input", () => {
    savedWidget.value = input.value;
    savedWidget.callback?.(input.value);
    node.graph?.change?.();
    app.graph?.setDirtyCanvas?.(true, true);
  });
  input.addEventListener("change", () => {
    savedWidget.value = input.value;
  });

  installWheelForwarding(root);
  try {
    const domWidget = node.addDOMWidget("tag_transfer_directory_editor", "hps-tag-transfer-directory", root, {
      serialize: false,
      hideOnZoom: false,
      getValue: () => input.value,
      setValue: (value) => {
        input.value = String(value ?? "");
        savedWidget.value = input.value;
      },
    });
    domWidget.computeSize = (width) => [width, 62];
    node.__hpsTagTransferDirectoryUI = { root, label, input, domWidget };
    hideTagTransferDirectorySavedWidget(savedWidget);
  } catch (error) {
    console.warn("[CheckpointHandpickerSuite] failed to create Tag Transfer Directory editor", error);
  }
}

function tagTransferRects(node) {
  const margin = 8;
  const gap = 8;
  const buttonW = 118;
  const buttonH = 28;
  return {
    exportButton: { x: margin, y: 76, w: buttonW, h: buttonH },
    importButton: { x: margin + buttonW + gap, y: 76, w: buttonW, h: buttonH },
    result: { x: margin, y: 116, w: Math.max(1, node.size[0] - margin * 2), h: Math.max(1, node.size[1] - 126) },
  };
}

function wrapTagTransferText(ctx, text, maxWidth) {
  const lines = [];
  for (const rawLine of String(text || "").split("\n")) {
    if (!rawLine) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const char of rawLine) {
      const candidate = current + char;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = char;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

function tagTransferCursorAt(node, local) {
  if (!local) return "";
  const r = tagTransferRects(node);
  if (hit(local, r.exportButton) || hit(local, r.importButton)) {
    return node.__hpsTagTransferBusy ? "not-allowed" : "pointer";
  }
  return "";
}

async function runTagTransfer(node, operation) {
  if (!node || node.__hpsTagTransferBusy) return;
  node.__hpsTagTransferBusy = true;
  node.__hpsTagTransferScroll = 0;
  node.__hpsTagTransferResult = operation === "export" ? "Exporting..." : "Importing...";
  app.graph?.setDirtyCanvas?.(true, true);
  try {
    const response = await api.fetchApi(`/${EXTENSION_PREFIX}/tag_transfer/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: tagTransferDirectoryValue(node) }),
    });
    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    if (operation === "import" && result?.ok && Array.isArray(result.changes)) {
      applyTagTransferChanges({ scope: "global", changes: result.changes });
    }
    if (result?.message) {
      node.__hpsTagTransferResult = result.message;
    } else if (result?.error) {
      node.__hpsTagTransferResult = `${operation === "export" ? "Export" : "Import"} failed.\n\n${result.error}`;
    } else {
      node.__hpsTagTransferResult = `${operation === "export" ? "Export" : "Import"} failed.\n\nHTTP ${response.status}`;
    }
  } catch (error) {
    node.__hpsTagTransferResult = `${operation === "export" ? "Export" : "Import"} failed.\n\n${error}`;
  } finally {
    node.__hpsTagTransferBusy = false;
    syncVueTagTransferUI(node);
    app.graph?.setDirtyCanvas?.(true, true);
  }
}

function syncVueTagTransferUI(node) {
  const ui = node?.__hpsVueTagTransferUI;
  if (!ui) return;
  const busy = !!node.__hpsTagTransferBusy;
  ui.exportButton.disabled = busy;
  ui.importButton.disabled = busy;
  ui.result.textContent = node.__hpsTagTransferResult || "Ready.";
}
function buildVueTagTransferUI(node) {
  if (node.__hpsVueTagTransferUI) return;
  const root = document.createElement("div");
  root.style.display = "grid";
  root.style.gap = "6px";
  root.style.padding = "2px 0";
  // Without explicit rows the grid stretches both rows to fill the
  // widget height, which made the buttons tall squares and left the
  // result as plain text; the canvas has normal-height buttons and
  // a dark result box filling the rest of the node.
  root.style.gridTemplateRows = "auto 1fr";
  const buttons = document.createElement("div");
  buttons.style.display = "flex";
  buttons.style.gap = "8px";
  const exportButton = document.createElement("button");
  exportButton.textContent = "📤 Export";
  const importButton = document.createElement("button");
  importButton.textContent = "📥 Import";
  for (const button of [exportButton, importButton]) {
    button.style.flex = "1";
    button.style.padding = "5px 0";
    button.style.background = "rgba(80,120,180,0.65)";
    button.style.border = "1px solid rgba(220,235,255,0.35)";
    button.style.borderRadius = "4px";
    button.style.color = "#fff";
  }
  const result = document.createElement("div");
  result.style.whiteSpace = "pre-wrap";
  result.style.wordBreak = "break-word";
  result.style.overflowY = "auto";
  result.style.minHeight = "0";
  result.style.background = "rgba(12,12,12,0.72)";
  result.style.border = "1px solid rgba(255,255,255,0.16)";
  result.style.borderRadius = "5px";
  result.style.padding = "6px 8px";
  result.style.fontSize = "12px";
  keepWheelForNativeScroll(result);
  buttons.append(exportButton, importButton);
  root.append(buttons, result);
  stopHpsWidgetEventPropagation(root);
  exportButton.addEventListener("click", () => void runTagTransfer(node, "export"));
  importButton.addEventListener("click", () => void runTagTransfer(node, "import"));
  if (!addVueOnlyDomWidget(node, "hps_tag_transfer_actions", "hps-tag-transfer-actions", root, 118, "fill")) return;
  node.__hpsVueTagTransferUI = { root, exportButton, importButton, result };
  syncVueTagTransferUI(node);
}

function setupTagTransferNode(nodeType) {
  installMinSize(nodeType, 420, 320);
  installCursorCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const result = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 420, 320);
    this.__hpsTagTransferBusy = false;
    this.__hpsTagTransferResult = "Ready.";
    this.__hpsTagTransferScroll = 0;
    buildTagTransferDirectoryUI(this);
    buildVueTagTransferUI(this);
    return result;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const result = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    // Defer both builders together so a loaded node keeps the same
    // widget order as a fresh one: directory editor first, actions next.
    setTimeout(() => {
      buildTagTransferDirectoryUI(this);
      buildVueTagTransferUI(this);
    }, 0);
    return result;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    if (hpsNodeCollapsed(this)) return;
    const r = tagTransferRects(this);
    const enabled = !this.__hpsTagTransferBusy;
    drawButton(ctx, r.exportButton, "📤 Export", enabled);
    drawButton(ctx, r.importButton, "📥 Import", enabled);

    ctx.save();
    ctx.fillStyle = "rgba(12,12,12,0.72)";
    ctx.strokeStyle = "rgba(210,210,210,0.28)";
    ctx.lineWidth = 1;
    drawRounded(ctx, r.result.x, r.result.y, r.result.w, r.result.h, 5);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(r.result.x + 1, r.result.y + 1, r.result.w - 2, r.result.h - 2);
    ctx.clip();
    ctx.fillStyle = "#ddd";
    ctx.font = "12px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const lineHeight = 16;
    const lines = wrapTagTransferText(ctx, this.__hpsTagTransferResult || "Ready.", r.result.w - 18);
    const visibleLines = Math.max(1, Math.floor((r.result.h - 12) / lineHeight));
    const maxScroll = Math.max(0, lines.length - visibleLines);
    this.__hpsTagTransferMaxScroll = maxScroll;
    this.__hpsTagTransferScroll = Math.max(0, Math.min(maxScroll, this.__hpsTagTransferScroll || 0));
    const start = this.__hpsTagTransferScroll;
    lines.slice(start, start + visibleLines).forEach((line, index) => {
      ctx.fillText(line, r.result.x + 7, r.result.y + 7 + index * lineHeight, r.result.w - 18);
    });
    if (maxScroll > 0) {
      const trackH = r.result.h - 12;
      const thumbH = Math.max(18, trackH * (visibleLines / lines.length));
      const thumbY = r.result.y + 6 + (trackH - thumbH) * (start / maxScroll);
      ctx.fillStyle = "rgba(220,220,220,0.35)";
      ctx.fillRect(r.result.x + r.result.w - 7, thumbY, 3, thumbH);
    }
    ctx.restore();
  };
  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (event, pos) {
    if (hpsNodeCollapsed(this)) return origMouseDown ? origMouseDown.apply(this, arguments) : false;
    const r = tagTransferRects(this);
    if (hitAny(this, pos, r.exportButton)) {
      if (!this.__hpsTagTransferBusy) runTagTransfer(this, "export");
      return true;
    }
    if (hitAny(this, pos, r.importButton)) {
      if (!this.__hpsTagTransferBusy) runTagTransfer(this, "import");
      return true;
    }
    return origMouseDown ? origMouseDown.apply(this, arguments) : false;
  };
  const origMouseWheel = nodeType.prototype.onMouseWheel;
  nodeType.prototype.onMouseWheel = function (event) {
    if (hpsNodeCollapsed(this)) return origMouseWheel ? origMouseWheel.apply(this, arguments) : false;
    const local = graphEventToLocal(this, event);
    if (hit(local, tagTransferRects(this).result) && (this.__hpsTagTransferMaxScroll || 0) > 0) {
      const direction = event.deltaY > 0 ? 3 : -3;
      this.__hpsTagTransferScroll = Math.max(0, Math.min(this.__hpsTagTransferMaxScroll, (this.__hpsTagTransferScroll || 0) + direction));
      app.graph?.setDirtyCanvas?.(true, true);
      event?.preventDefault?.();
      event?.stopPropagation?.();
      return true;
    }
    return origMouseWheel ? origMouseWheel.apply(this, arguments) : false;
  };
}

// ---------- Tagger ----------
function linkedCheckpointInputSource(node, inputName) {
  const index = node.inputs?.findIndex((input) => input.name === inputName) ?? -1;
  if (index < 0) return null;
  const linkId = node.inputs?.[index]?.link;
  if (linkId == null) return null;
  const link = app.graph?.links?.[linkId];
  const source = link ? app.graph?.getNodeById?.(link.origin_id) : null;
  return source ? { link, source } : null;
}

function isTaggerDirectLinkBlocked(node) {
  const info = linkedCheckpointInputSource(node, "ckpt_name_str");
  const source = info?.source;
  return !!(source && isNodeClass(source, SELECTOR_CLASS) && selectorActionMode(source) === "directlink" && !selectorDirectLinkEnabled(source));
}

function linkedCheckpointInputValue(node, inputName) {
  const info = linkedCheckpointInputSource(node, inputName);
  const source = info?.source;
  const link = info?.link;
  if (!source) return "";
  if (isNodeClass(source, CYCLER_CLASS)) return source.__hpsCyclerCkptName || "";
  if (isNodeClass(source, SELECTOR_CLASS)) {
    const mode = selectorActionMode(source);
    if (mode === "directlink") return selectorDirectLinkEnabled(source) ? (selectorSelected(source) || "") : "";
    return "";
  }
  const outputName = String(source.outputs?.[link.origin_slot]?.name || "").toLowerCase();
  if (outputName === "ckpt_name_str") {
    const ckptWidget = findCheckpointWidget(source) || findStartCheckpointWidget(source);
    const value = String(ckptWidget?.value || "");
    return value.endsWith(".safetensors") ? value : "";
  }
  return "";
}

function currentTaggerPath(node) {
  if (isTaggerDirectLinkBlocked(node)) return "";
  const info = linkedCheckpointInputSource(node, "ckpt_name_str");
  const source = info?.source;
  if (source && isNodeClass(source, SELECTOR_CLASS)) {
    if (selectorActionMode(source) === "directlink") return selectorDirectLinkEnabled(source) ? (selectorSelected(source) || "") : "";
    return node.__hpsTaggerPath || "";
  }
  return node.__hpsTaggerPath
    || linkedCheckpointInputValue(node, "ckpt_name_str")
    || "";
}
function taggerButtons(node) {
  // Keep positive status controls on the first row and delete separated below.
  const buttonW = 76;
  const gap = 6;
  const right = Math.max(442, (node.size?.[0] || 450) - 8);
  const topStatuses = ["god", "favorite", "nice", "keep"];
  const totalW = topStatuses.length * buttonW + (topStatuses.length - 1) * gap;
  const startX = right - totalW;
  const buttons = topStatuses.map((status, i) => ({
    status,
    x: startX + i * (buttonW + gap),
    y: 3,
    w: buttonW,
    h: 26,
  }));
  buttons.push({ status: "delete", x: right - buttonW, y: 35, w: buttonW, h: 26 });
  return buttons;
}
function taggerDeleteEnabled(node) {
  if (!currentTaggerPath(node)) return false;
  const current = node.__hpsTaggerStatus || "none";
  return current === "none" || current === "delete";
}
function taggerButtonsEnabled(node, status) {
  if (!currentTaggerPath(node)) return false;
  return status !== "delete" || taggerDeleteEnabled(node);
}
async function setTaggerStatus(node, status) {
  const ckpt = currentTaggerPath(node);
  if (!ckpt) {
    clearTaggerTarget(node);
    app.graph?.setDirtyCanvas?.(true, true);
    return;
  }
  if (status === "delete" && !taggerDeleteEnabled(node)) return;
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/tagger/set_status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tabPayload({ ckpt_name_str: ckpt, status })),
  });
  const result = await response.json();
  if (result.ok) {
    node.__hpsTaggerStatus = result.status;
    node.__hpsTaggerMessage = taggerCurrentMessage(result.status);
    node.title = result.status === "none" ? `Tagger : ${ckpt}` : `Tagger : ${STATUS_ICON[result.status]} ${ckpt}`;
  } else {
    node.__hpsTaggerMessage = result.error || "Failed";
  }
  syncVueTaggerUI(node);
  app.graph.setDirtyCanvas(true, true);
}
function syncVueTaggerUI(node) {
  const ui = node?.__hpsVueTaggerUI;
  if (!ui) return;
  const path = currentTaggerPath(node);
  const status = node.__hpsTaggerStatus || "none";
  for (const [name, button] of Object.entries(ui.buttons)) {
    const active = !!path && status === name;
    button.disabled = !taggerButtonsEnabled(node, name);
    button.dataset.active = String(active);
    button.setAttribute("aria-pressed", String(active));
    button.style.background = active ? "rgba(74,151,105,0.94)" : "";
    button.style.borderColor = active ? "rgba(218,255,227,0.95)" : "";
    button.style.boxShadow = active ? "0 0 0 1px rgba(28,90,48,0.7) inset" : "";
  }
  ui.message.textContent = path ? `${path}\n${node.__hpsTaggerMessage || taggerCurrentMessage(status)}` : taggerCurrentMessage("none");
}
function buildVueTaggerUI(node) {
  if (node.__hpsVueTaggerUI) return;
  const root = document.createElement("div");
  root.style.display = "grid";
  root.style.gap = "6px";
  root.style.padding = "2px 0";
  root.style.gridTemplateRows = "auto 1fr";
  const buttonsRow = document.createElement("div");
  buttonsRow.style.display = "flex";
  buttonsRow.style.flexWrap = "wrap";
  buttonsRow.style.gap = "5px";
  // Match the canvas layout, where the status buttons sit on the
  // right side of the node (and wrap onto a second right-aligned
  // row when the node is narrow).
  buttonsRow.style.justifyContent = "flex-end";
  const buttons = {};
  for (const status of TAGGER_STATUS_ORDER) {
    const button = document.createElement("button");
    button.textContent = `${STATUS_ICON[status]} ${STATUS_LABEL[status]}`;
    button.addEventListener("click", () => void setTaggerStatus(node, status));
    buttons[status] = button;
    buttonsRow.append(button);
  }
  const message = document.createElement("small");
  message.style.whiteSpace = "pre-wrap";
  root.append(buttonsRow, message);
  stopHpsWidgetEventPropagation(root);
  if (!addVueOnlyDomWidget(node, "hps_tagger_controls", "hps-tagger-controls", root, 124, "both")) return;
  node.__hpsVueTaggerUI = { root, buttons, message };
  syncVueTaggerUI(node);
}
function taggerCursorAt(node, local) {
  if (!local) return "";
  for (const b of taggerButtons(node)) {
    if (!hit(local, b)) continue;
    if (!taggerButtonsEnabled(node, b.status)) return "not-allowed";
    return "pointer";
  }
  return "";
}

function normalizeTaggerHeight(node) {
  if (!node?.size) return;
  // v9l moves the message area up by 21px. Shrink only default-ish old layouts;
  // user-expanded nodes should keep their chosen height.
  if (node.size[1] > 107 && node.size[1] <= 128) node.size[1] = 107;
}

function setupTaggerNode(nodeType) {
  installMinSize(nodeType, 450, 107);
  installTabIdSupport(nodeType);
  installCursorCapture();
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = origCreated ? origCreated.apply(this, arguments) : undefined;
    ensureSize(this, 450, 107);
    normalizeTaggerHeight(this);
    buildVueTaggerUI(this);
    setTimeout(() => restoreNodeStateFromBackend(this, TAGGER_CLASS), 0);
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    normalizeTaggerHeight(this);
    buildVueTaggerUI(this);
    setTimeout(() => restoreNodeStateFromBackend(this, TAGGER_CLASS), 0);
    return r;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    ensureHiddenTabIdWidget(this);
    if (hpsNodeCollapsed(this)) return;
    ctx.save();
    const p = currentTaggerPath(this);
    const linkedSource = linkedCheckpointInputSource(this, "ckpt_name_str")?.source;
    const current = p ? (this.__hpsTaggerStatus || selectorStatusFor(linkedSource, p) || "none") : "none";
    for (const b of taggerButtons(this)) {
      const enabled = taggerButtonsEnabled(this, b.status);
      const buttonColor = b.status === "delete" && enabled ? "rgba(105,90,90,0.65)" : null;
      drawButton(
        ctx,
        b,
        `${STATUS_ICON[b.status]} ${STATUS_LABEL[b.status]}`,
        enabled,
        p && current === b.status,
        buttonColor,
        { textColor: enabled ? undefined : "#888" }
      );
    }
    ctx.fillStyle = "#ddd";
    ctx.font = "12px sans-serif";
    if (p) {
      ctx.fillText(p, 8, 55);
      const msg = this.__hpsTaggerMessage || taggerCurrentMessage(current);
      ctx.fillStyle = current === "none" ? "#ccc" : "#ddd";
      ctx.fillText(msg, 8, 75);
      if (current !== "none" && current !== "delete") {
        ctx.fillStyle = "#aaa";
        ctx.fillText("Delete is available only from none.", 8, 95);
      } else if (current === "delete") {
        ctx.fillStyle = "#aaa";
        ctx.fillText("Delete script exported to output. ([y/N])", 8, 95);
      }
    } else {
      ctx.fillStyle = "#ccc";
      ctx.fillText(taggerCurrentMessage("none"), 8, 55);
    }
    ctx.restore();
  };
  const origMouseDown = nodeType.prototype.onMouseDown;
  nodeType.prototype.onMouseDown = function (e, pos) {
    if (hpsNodeCollapsed(this)) return origMouseDown ? origMouseDown.apply(this, arguments) : false;
    for (const b of taggerButtons(this)) {
      if (hitAny(this, pos, b)) {
        if (!taggerButtonsEnabled(this, b.status)) return true;
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
  if (isTaggerDirectLinkBlocked(node)) {
    clearTaggerTarget(node);
    app.graph.setDirtyCanvas(true, true);
    return;
  }
  node.__hpsTaggerPath = detail.ckpt_name_str;
  node.__hpsTaggerStatus = detail.status;
  node.__hpsTaggerMessage = taggerCurrentMessage(detail.status || "none");
  if (detail.title) node.title = detail.title;
  syncVueTaggerUI(node);
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
      if (selectorSelected(node) === detail.ckpt_name_str) {
        node.title = selectorTitleText(node, detail.ckpt_name_str);
        if (selectorDirectLinkEnabled(node)) updateDirectLinkTaggers(node);
      }
      syncVueSelectorUI(node);
    }
    if (PREVIEW_CLASSES.has(node.type || node.comfyClass) && node.__hpsPreviewCkptName === detail.ckpt_name_str) {
      node.__hpsPreviewStatus = detail.status || "none";
      setPreviewTitleFromCheckpoint(node, detail.ckpt_name_str, detail.status || "none");
    }
    if (isNodeClass(node, TAGGER_CLASS) && currentTaggerPath(node) === detail.ckpt_name_str) {
      node.__hpsTaggerStatus = detail.status || "none";
      node.__hpsTaggerMessage = taggerCurrentMessage(node.__hpsTaggerStatus);
      patchCheckpointTitle(node, "Tagger", detail.ckpt_name_str, node.__hpsTaggerStatus);
      syncVueTaggerUI(node);
    }
    // Cycler title/status are rebuilt from backend state via CYCLER_EVENT.
    // Do not patch the existing Cycler title here; stale status icons can accumulate.
  }
  scheduleSelectorGlobalRefresh();
  app.graph.setDirtyCanvas(true, true);
});

function applyTagTransferChanges(detail) {
  if (!isForThisTab(detail) || !Array.isArray(detail?.changes)) return;
  const changes = new Map(detail.changes.map((change) => [change.ckpt_name_str, change]));
  const execution = getExecutionState();
  if (execution && changes.has(execution.ckpt_name_str)) {
    const change = changes.get(execution.ckpt_name_str);
    execution.status = change.status || "none";
    execution.status_icon = change.status_icon || STATUS_ICON[execution.status] || "";
  }
  for (const node of app.graph?._nodes || []) {
    if (isNodeClass(node, SELECTOR_CLASS)) {
      for (const item of selectorItems(node)) {
        const change = changes.get(item.ckpt_name_str);
        if (change) item.status = change.status || "none";
      }
      const selected = selectorSelected(node);
      if (selected && changes.has(selected)) {
        node.title = selectorTitleText(node, selected);
        if (selectorDirectLinkEnabled(node)) updateDirectLinkTaggers(node);
      }
      syncVueSelectorUI(node);
    }
    if (PREVIEW_CLASSES.has(node.type || node.comfyClass)) {
      const change = changes.get(node.__hpsPreviewCkptName);
      if (change) {
        node.__hpsPreviewStatus = change.status || "none";
        setPreviewTitleFromCheckpoint(node, change.ckpt_name_str, node.__hpsPreviewStatus);
      }
    }
    if (isNodeClass(node, TAGGER_CLASS)) {
      const path = currentTaggerPath(node);
      const change = changes.get(path);
      if (change) {
        node.__hpsTaggerStatus = change.status || "none";
        node.__hpsTaggerMessage = taggerCurrentMessage(node.__hpsTaggerStatus);
        patchCheckpointTitle(node, "Tagger", path, node.__hpsTaggerStatus);
        syncVueTaggerUI(node);
      }
    }
    if (isNodeClass(node, CYCLER_CLASS)) {
      const change = changes.get(node.__hpsCyclerCkptName);
      if (change) node.__hpsCyclerStatusValue = change.status || "none";
    }
  }
  scheduleSelectorGlobalRefresh();
  app.graph?.setDirtyCanvas?.(true, true);
}

api.addEventListener(TAG_TRANSFER_EVENT, ({ detail }) => {
  applyTagTransferChanges(detail);
});

// ---------- Cycler ----------
function cyclerRects(node) {
  const filterY = 35;
  const filter = [{ status: "all", x: 8, y: filterY, w: 54, h: 24 }];
  CYCLER_FILTER_STATUSES.forEach((status, i) => filter.push({ status, x: 68 + i * 48, y: filterY, w: 42, h: 24 }));
  return {
    localListToggle: { x: 8, y: 4, w: 150, h: 24 },
    clearLocalList: { x: 164, y: 4, w: 122, h: 24 },
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
function schedulePushCyclerRuntimeControls(node) {
  if (!node || node.__hpsApplyingRuntimePayload) return;
  clearTimeout(node.__hpsRuntimePushTimer);
  node.__hpsRuntimePushTimer = setTimeout(() => pushCyclerRuntimeControls(node), 120);
}

async function pushCyclerRuntimeControls(node) {
  if (!node || node.__hpsApplyingRuntimePayload) return;
  syncCyclerSettingsWidgets(node);
  const response = await api.fetchApi(`/${EXTENSION_PREFIX}/cycler/set_runtime_controls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tabPayload({
      node_id: node.id,
      settings_revision: node.__hpsSettingsRevision ?? 0,
      active_filter: cyclerActiveFilter(node),
      use_local_list: node.__hpsUseLocalList !== false,
      ...getCyclerRuntimeControls(node),
    })),
  });
  const result = await response.json();
  if (result?.ok) applyCyclerStatePayload(node, result);
}

function installCyclerRuntimeControlHooks(node) {
  if (!node) return;
  let installedAny = false;
  for (const name of ["start_checkpoint", "mode", "change_every"]) {
    const widget = getWidget(node, name);
    if (!widget || widget.__hpsRuntimeHookInstalled) continue;
    widget.__hpsRuntimeHookInstalled = true;
    installedAny = true;
    const originalCallback = widget.callback;
    widget.callback = function (...args) {
      const r = originalCallback ? originalCallback.apply(this, args) : undefined;
      if (!node.__hpsApplyingRuntimePayload) {
        bumpCyclerSettingsRevision(node);
        schedulePushCyclerRuntimeControls(node);
      }
      return r;
    };
  }
  if (installedAny) node.__hpsRuntimeHooksInstalled = true;
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

function syncVueCyclerUI(node) {
  const ui = node?.__hpsVueCyclerUI;
  if (!ui) return;
  const active = cyclerActiveFilter(node);
  ui.localList.textContent = node.__hpsUseLocalList === false ? "☐ Use Local List" : "☑ Use Local List";
  // Match the canvas toggle colours: active is green, not blue.
  const localListActive = node.__hpsUseLocalList !== false;
  ui.localList.style.background = localListActive ? "rgba(70,140,110,0.82)" : "";
  ui.localList.style.borderColor = localListActive ? "rgba(235,255,245,0.95)" : "";
  for (const [status, button] of Object.entries(ui.filters)) {
    const selected = status === "all" ? active.length === 0 : active.includes(status);
    button.dataset.active = String(selected);
    button.setAttribute("aria-pressed", String(selected));
    button.style.background = selected ? "rgba(70,140,110,0.82)" : "";
    button.style.borderColor = selected ? "rgba(235,255,245,0.95)" : "";
  }
  ui.status.textContent = node.__hpsCyclerStatus || "Current: (not executed yet)";
  refreshVueLayoutReclaim(node);
}
function buildVueCyclerUI(node) {
  if (node.__hpsVueCyclerUI) return;
  const root = document.createElement("div");
  root.style.display = "grid";
  root.style.gap = "6px";
  root.style.padding = "2px 0";
  root.style.gridTemplateRows = "auto auto";
  root.style.alignContent = "start";
  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.flexWrap = "wrap";
  actions.style.gap = "5px";
  const localList = document.createElement("button");
  const clear = document.createElement("button");
  clear.textContent = "Clear Local List";
  actions.append(localList, clear);
  const filtersRow = document.createElement("div");
  filtersRow.style.display = "flex";
  filtersRow.style.flexWrap = "wrap";
  filtersRow.style.gap = "5px";
  const filters = {};
  for (const status of ["all", ...CYCLER_FILTER_STATUSES]) {
    const button = document.createElement("button");
    button.textContent = status === "all" ? "all" : STATUS_ICON[status];
    filters[status] = button;
    filtersRow.append(button);
    button.addEventListener("click", () => {
      if (status === "all") node.__hpsFilterStatuses = [];
      else {
        const set = new Set(node.__hpsFilterStatuses || []);
        if (set.has(status)) set.delete(status); else set.add(status);
        node.__hpsFilterStatuses = CYCLER_FILTER_STATUSES.filter((entry) => set.has(entry));
      }
      bumpCyclerSettingsRevision(node);
      syncCyclerSettingsWidgets(node);
      void pushCyclerFilter(node).finally(() => syncVueCyclerUI(node));
      syncVueCyclerUI(node);
    });
  }
  root.append(actions, filtersRow);
  stopHpsWidgetEventPropagation(root);
  localList.addEventListener("click", () => {
    node.__hpsUseLocalList = !node.__hpsUseLocalList;
    bumpCyclerSettingsRevision(node);
    syncCyclerSettingsWidgets(node);
    void pushCyclerFlags(node).finally(() => syncVueCyclerUI(node));
    syncVueCyclerUI(node);
  });
  clear.addEventListener("click", () => void clearLocalList(node).finally(() => syncVueCyclerUI(node)));
  // The canvas layout interleaves framework widgets: the custom
  // toggle/filter rows sit at the top (over the slots band), the
  // start_checkpoint/mode/change_every widgets follow, and the status
  // box comes last (cyclerRects: statusBox y=140). A single DOM
  // widget cannot interleave, so the Vue UI is split in two: this
  // top widget is moved before the framework widgets, and a separate
  // status widget stays at the end.
  if (!addVueOnlyDomWidget(node, "hps_cycler_controls", "hps-cycler-controls", root, 68, "shift")) return;
  moveVueWidgetToFront(node, "hps_cycler_controls");
  const statusRoot = document.createElement("div");
  statusRoot.style.display = "flex";
  statusRoot.style.padding = "2px 0";
  const status = document.createElement("small");
  status.style.whiteSpace = "pre-wrap";
  status.style.flex = "1 1 auto";
  status.style.minHeight = "0";
  status.style.overflowY = "auto";
  status.style.background = "rgba(12,12,12,0.72)";
  status.style.border = "1px solid rgba(210,210,210,0.28)";
  status.style.borderRadius = "5px";
  status.style.padding = "6px 7px";
  keepWheelForNativeScroll(status);
  statusRoot.append(status);
  stopHpsWidgetEventPropagation(statusRoot);
  addVueOnlyDomWidget(node, "hps_cycler_status", "hps-cycler-status", statusRoot, 80, "fill");
  node.__hpsVueCyclerUI = { root, statusRoot, localList, clear, filters, status };
  syncVueCyclerUI(node);
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
    installCyclerRuntimeControlHooks(this);
    buildVueCyclerUI(this);
    setTimeout(() => restoreNodeStateFromBackend(this, CYCLER_CLASS), 0);
    return r;
  };
  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
    restoreCyclerSettingsFromWidgets(this);
    installCyclerRuntimeControlHooks(this);
    buildVueCyclerUI(this);
    setTimeout(() => restoreNodeStateFromBackend(this, CYCLER_CLASS), 0);
    return r;
  };
  const origDraw = nodeType.prototype.onDrawBackground;
  nodeType.prototype.onDrawBackground = function (ctx) {
    if (origDraw) origDraw.apply(this, arguments);
    ensureHiddenTabIdWidget(this);
    restoreCyclerSettingsFromWidgets(this);
    installCyclerRuntimeControlHooks(this);
    const runtimeKey = JSON.stringify(getCyclerRuntimeControls(this));
    if (!this.__hpsApplyingRuntimePayload && this.__hpsLastRuntimeControlsKey && this.__hpsLastRuntimeControlsKey !== runtimeKey) {
      bumpCyclerSettingsRevision(this);
      schedulePushCyclerRuntimeControls(this);
    }
    this.__hpsLastRuntimeControlsKey = runtimeKey;
    if (hpsNodeCollapsed(this)) return;
    const r = cyclerRects(this);
    const active = cyclerActiveFilter(this);
    ctx.save();

    drawButton(ctx, r.localListToggle, this.__hpsUseLocalList === false ? "☐ Use Local List" : "☑ Use Local List", true, this.__hpsUseLocalList !== false);
    drawButton(ctx, r.clearLocalList, "Clear Local List", true, false, "rgba(105,90,90,0.65)");
    for (const b of r.filter) {
      const isAll = b.status === "all";
      const on = isAll ? active.length === 0 : active.includes(b.status);
      drawButton(ctx, b, isAll ? "all" : STATUS_ICON[b.status], true, on);
    }

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
  syncVueCyclerUI(node);
  app.graph.setDirtyCanvas(true, true);
});

app.registerExtension({
  name: EXT,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    installCheckpointRefreshFuturePatch(nodeType, nodeData);
    if (PREVIEW_CLASSES.has(nodeData.name)) return setupPreviewNode(nodeType);
    if (nodeData.name === SELECTOR_CLASS) return setupSelectorNode(nodeType);
    if (nodeData.name === TAGGER_CLASS) return setupTaggerNode(nodeType);
    if (nodeData.name === TAG_TRANSFER_CLASS) return setupTagTransferNode(nodeType);
    if (nodeData.name === CYCLER_CLASS) return setupCyclerNode(nodeType);
  },
});
