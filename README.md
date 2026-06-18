# ComfyUI-CheckpointHandpickerSuite

Turn your ComfyUI checkpoint workflow into a deluxe checkpoint jukebox with a review desk attached.

Cycle checkpoints during batch generation, review the images they produce, tag the checkpoints you want to keep, set representative thumbnails, and prepare deletion candidates safely.

In many cases, you do not need to rebuild your main workflow. Place `CheckpointNameCycler` before your checkpoint loader, then build the review workflow in another tab.

## What this suite is for

`ComfyUI-CheckpointHandpickerSuite` is designed for checkpoint review and cleanup.

It helps you answer practical questions such as:

- Which checkpoints are actually useful in my own workflow?
- Which checkpoints produce images worth keeping?
- Which checkpoints deserve a strong thumbnail?
- Which checkpoints should be marked for later deletion?
- Which generated images are failed outputs and can be removed during review?

The suite focuses on checkpoints. It is not intended to replace LoRA managers.

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

## Basic review workflows

### 1. Batch-generation review

Use `CheckpointNameCycler` in front of your checkpoint loader.

```text
CheckpointNameCycler.ckpt_name -> CheckpointLoader.ckpt_name
CheckpointNameCycler.ckpt_name_str -> CheckpointStatusTagger.ckpt_name_str
```

Generate images while the Cycler changes checkpoints. Use the Tagger to mark the current checkpoint.

### 2. ImageDir review

Use `Checkpoint List Selector` with `ImageDir Preview`.

```text
CheckpointListSelector.ckpt_name_str -> ImageDirPreview.ckpt_name_str
```

Select a checkpoint in the Selector, sync it to ImageDir Preview, inspect generated images, set a thumbnail, or delete failed images.

### 3. External review with DirectLink

Use `Checkpoint List Selector` directly with `Checkpoint Status Tagger`.

```text
CheckpointListSelector.ckpt_name_str -> CheckpointStatusTagger.ckpt_name_str
```

This is for reviewing images outside ComfyUI, for example on a tablet, shared folder, or external image viewer.

When this connection is detected, the Selector shows:

- `🌑 DirectLink OFF`
- `🌕 DirectLink ON`

DirectLink is OFF by default. While OFF, selecting a checkpoint in the Selector does not update the Tagger target.

When you turn DirectLink ON, a confirmation dialog is shown once per browser page load:

```text
Enable DirectLink?

Use this mode only while checking generated images on a tablet, shared folder, or external viewer.

Otherwise, connect ImageDirPreview and use Sync mode.

Tagger will label the checkpoint selected in ListSelector.
```

After DirectLink is ON, the Tagger labels the checkpoint currently selected in the Selector.

## Checkpoint List Selector

`Checkpoint List Selector` is a manual review list for checkpoints.

The main action button changes depending on what is connected to `ckpt_name_str`.

- `🏹 Push to Local List`  
  Shown when no review node is connected.

- `🎯 Sync Checkpoint`  
  Shown when `ImageDir Preview` is connected.  
  This syncs the selected checkpoint to the connected review node. It does not queue or execute the workflow.

- `🌑 DirectLink OFF` / `🌕 DirectLink ON`  
  Shown when `Checkpoint Status Tagger` is connected without `ImageDir Preview`.  
  DirectLink is for external image review. The Tagger follows the selected checkpoint only while DirectLink is ON.

If both `ImageDir Preview` and `Checkpoint Status Tagger` are connected, Sync mode has priority.

The selector list supports:

- wheel scrolling
- up/down buttons
- scrollbar thumb dragging
- checkpoint row selection
- status icons in the list
- sidecar thumbnail hover preview when a checkpoint thumbnail exists

## Local List

`Local List` is a per-Cycler temporary checkpoint queue.

- Local List is isolated by browser tab and Cycler node.
- Push to Local List updates only Cyclers in the current tab.
- Local List has priority over normal Cycler selection modes, including fixed mode.
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

## Checkpoint Status Tagger

`Checkpoint Status Tagger` assigns a review status to a checkpoint.

Statuses:

- 👑 god!  
  Hall of fame / absolute keep.

- 💛 favorite  
  Favorite / recommended / frequently used.

- 👍 nice  
  Good candidate.

- ✔ keep  
  Keep.

- 🗑 delete  
  Marked for deletion.

There is no `none` button. Pressing the active status toggles it off to `none`.

`delete` can only be set from `none`. Pressing active `delete` toggles it back to `none`.

Delete is a reservation only. It never deletes checkpoints immediately.

Generated checkpoint deletion scripts are written under:

```text
ComfyUI/output/CheckpointHandpickerSuite/delete_scripts/
```

The generated script asks for confirmation before deleting files.

## Ephemeral Preview

`Ephemeral Preview` shows all images from the incoming `IMAGE` batch. It does not drop batch items.

When it receives images after a `Checkpoint Name Cycler` execution, it can display the checkpoint name from the tab-local execution state as:

```text
Preview : model.safetensors
```

This is display-only. It is not used for tagging or delete operations.

## ImageDir Preview

`ImageDir Preview` searches output images for the selected checkpoint and shows a contact sheet.

It has `max_preview_images`:

- default: `12`
- range: `1..80`

Smaller values are recommended for review and tagging because each image remains easier to inspect. Larger values are useful for overview.

Preview contact sheets do not upscale images. If the sheet fits within the 4096px content limit, images stay at their original size. If the sheet would be too large, images are scaled down.

### Image actions

In `ImageDir Preview`, left-click a live image tile to open the action menu.

Available actions:

- `Delete image`
- `Set as checkpoint thumbnail`

`Delete image` asks for confirmation, then deletes the source image file directly. It does not move the file to a custom trash directory.

After deletion, the tile position is preserved and a `NO IMAGE` overlay is drawn over that tile. Deleted tiles are inactive; they do not show hover highlight and do not open the action menu.

`Set as checkpoint thumbnail` copies the selected image as the checkpoint sidecar thumbnail. If a managed thumbnail already exists, it may be overwritten.

This makes ImageDir Preview useful for:

- choosing a representative checkpoint thumbnail
- deleting failed generated images during review
- checking which images a checkpoint actually produced

## Tab isolation

UI operation events are tab-local. Local List updates, Cycler UI updates, Tagger sync, DirectLink updates, and preview/progress updates include a tab id and are ignored by other tabs.

The Cycler also writes the last executed checkpoint to a tab-local frontend execution state. `Ephemeral Preview` may use that state to label previews.

`Checkpoint Status Tagger` does not use arbitrary shared preview state for delete operations. It acts on an explicitly connected `ckpt_name_str` input or a selected checkpoint supplied by DirectLink.

Checkpoint statuses are global. When a status changes, all tabs may refresh their own Selector lists, but global notifications do not directly modify arbitrary node titles by node id.

Top-bar locking and localStorage-based queue sharing are intentionally not included in this release.

## Safety

This suite is designed around review-first cleanup.

- Marking a checkpoint as `delete` does not delete it immediately.
- Checkpoint deletion uses an exported script with confirmation.
- ImageDir Preview image deletion asks for confirmation before deleting the image file.
- DirectLink asks for confirmation the first time it is enabled in a browser page load.

## Recommended saver nodes

- [`ComfyUI-GMImageSaver`](https://github.com/ruminar/ComfyUI-GMImageSaver)
- [`ComfyUI-PillowImageSaver`](https://github.com/ruminar/ComfyUI-PillowImageSaver)

Both saver nodes use the same filename and directory rules for checkpoint review workflows. Choose either one according to your environment.

For checkpoint-based image organization, connect `ckpt_name_safe` to the saver node's `label` input.

This lets generated images be saved under checkpoint-aware filenames/directories for preview, thumbnail, cleanup, and DirectLink workflows.

