# ComfyUI-CheckpointHandpickerSuite

Turn your ComfyUI checkpoint workflow into a deluxe checkpoint jukebox with a review desk attached.

Cycle checkpoints during batch generation, preview the results, tag what deserves to stay, and prepare deletion candidates safely without deleting anything immediately.

In many cases, you do not need to rebuild your workflow.  
Just place `CheckpointNameCycler` in front of the checkpoint input of your existing checkpoint loader, and you can build the review workflow in another tab.

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ruminar/ComfyUI-CheckpointHandpickerSuite.git
```

Restart ComfyUI.

## Documentation

- [How to use](doc/HOW_TO_USE.md)
- [日本語ドキュメント](doc/README.ja.md)

## Nodes

- Checkpoint Name Cycler
- Checkpoint List Selector
- Checkpoint Status Tagger
- Ephemeral Preview
- ImageDir Preview

## Selector

`Checkpoint List Selector` can work in two modes.

- `🏹 Push to Local List`: shown when no review node is connected to `ckpt_name_str`.
- `🎯 Sync Checkpoint`: shown when `ckpt_name_str` is connected to `Checkpoint Status Tagger` or `ImageDir Preview`.

`Sync Checkpoint` does not queue or execute the workflow. It synchronizes the currently selected checkpoint to connected review nodes only.

After sync, the Selector shows a compact one-line message such as `synced : model.safetensors`.

The selector list supports wheel scrolling, up/down buttons, and scrollbar thumb dragging.

## Local List

`Local List` is a per-Cycler temporary checkpoint list.

- Local List is isolated by browser tab and Cycler node.
- Push to Local List updates only Cyclers in the current tab.
- Local List has priority over all normal selection modes, including fixed mode.
- Local List entries are used as-is and are not affected by Filter.
- Local List ignores `change_every`.
- Each Local List entry is consumed once per Cycler execution.
- Duplicate entries are allowed. Push the same checkpoint multiple times if you want to run it multiple times.
- While Local List is active, normal index, hold count, and Shuffle Once deck are not advanced.
- If the list becomes too large or is no longer needed, use `Clear Local List`.

## Cycler modes

### fixed

Fixed mode is compatible with a normal checkpoint selector.

- The selected checkpoint is always used.
- Filter is not applied to fixed mode.
- If the selected checkpoint disappears after refresh, the Cycler falls back to a valid checkpoint.
- Local List can still temporarily override fixed mode.

### increment

- Uses the ordered checkpoint list.
- Filter acts as a pass condition.
- Non-matching checkpoints are skipped and the index advances.
- Changing Filter does not reset the index.

### randomize

- Chooses randomly from the current Filter-matching set.
- Repeats are allowed.
- There is no skip/deck behavior.

### shuffle_once

- Builds a shuffled deck from all checkpoints, independent of Filter.
- Filter is applied only at selection time.
- Non-matching checkpoints are skipped and removed from the current deck.
- The selected checkpoint is also removed from the deck.
- When the deck becomes empty, a new unfiltered deck is created.

## Tagger

`Checkpoint Status Tagger` has four buttons:

- 💛 favorite
- 👍 nice
- ✔ keep
- 🗑 delete

There is no `none` button. Pressing the active status toggles it off to `none`.

`delete` can only be set from `none`; pressing active `delete` toggles it back to `none`.

Delete is a reservation only. It never deletes checkpoints immediately.

## Preview

- `Ephemeral Preview` shows all images from the incoming `IMAGE` batch. It does not drop batch items.
- When `Ephemeral Preview` receives images after a `Checkpoint Name Cycler` execution, it can display the checkpoint name from the tab-local execution state as `Preview : model.safetensors`. This is display-only; it is not used for tagging or delete operations.
- `ImageDir Preview` searches output images for the selected checkpoint and shows a contact sheet.

`ImageDir Preview` has `max_preview_images`:

- default: `12`
- range: `1..80`

Smaller values are recommended for review and tagging because each image remains easier to inspect. Larger values are useful for overview.

Preview contact sheets do not upscale images. If the sheet fits within the 4096px content limit, images stay at their original size. If the sheet would be too large, images are scaled down. Contact sheet packing uses the content area first, then adds gaps during rendering, so the final canvas may slightly exceed the nominal packing area.

## Tab isolation

UI operation events are tab-local. Local List updates, Cycler UI updates, Tagger sync, and preview/progress updates include a tab id and are ignored by other tabs.

The Cycler also writes the last executed checkpoint to a tab-local frontend execution state. `Ephemeral Preview` may use that state to label previews. `Checkpoint Status Tagger` never uses this shared state; it only acts on an explicitly connected `ckpt_name_str` input.

Checkpoint statuses are global. When a status changes, all tabs may refresh their own Selector lists, but global notifications do not directly modify arbitrary node titles by node id.

Top-bar locking and localStorage-based queue sharing are intentionally not included in this release.

## Safety

This suite is designed around review-first cleanup. Checkpoints marked for delete are only reserved for deletion. A generated script is used for actual deletion, with confirmation.
