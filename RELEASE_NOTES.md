# ComfyUI-CheckpointHandpickerSuite 0.2.0

ComfyUI-CheckpointHandpickerSuite 0.2.0 is a major workflow upgrade for checkpoint review, tagging, thumbnail setup, and generated-image cleanup.

This release turns the suite from a checkpoint cycling/tagging helper into a more complete checkpoint review desk: you can now review generated images per checkpoint, choose the best image as the checkpoint thumbnail, delete failed preview images, and tag checkpoints while reviewing images either inside ComfyUI or externally on a tablet/shared folder/image viewer.

## Highlights

### 👑 New `god!` status

A new top-tier status has been added above `favorite`.

Status order:

* 👑 `god!`
* 💛 `favorite`
* 👍 `nice`
* ✔ `keep`
* 🗑 `delete`
* `none`

Use `god!` for hall-of-fame checkpoints or models you absolutely want to keep.

`delete` remains a reserved deletion state. Checkpoints are never deleted immediately when tagged.

### ImageDir Preview actions

`ImageDir Preview` can now do more than display a contact sheet.

Left-click a preview image tile to open the image action menu:

* `Delete image`
* `Set as checkpoint thumbnail`

#### Set as checkpoint thumbnail

You can now set the best generated image as the checkpoint thumbnail directly from `ImageDir Preview`.

This is especially useful when paired with model manager tools that display sidecar checkpoint thumbnails.

#### Delete generated preview images

You can now delete failed generated images directly from `ImageDir Preview`.

* Deletion asks for confirmation.
* Images are deleted directly from disk.
* The contact sheet layout is preserved.
* Deleted tiles are marked with a `NO IMAGE` overlay.
* Deleted tiles become inactive and do not open the action menu.

This is intended for quickly cleaning up failed AI-generated images while reviewing checkpoints.

### 🌑🌕 DirectLink mode

`Checkpoint List Selector` now supports DirectLink mode for external image review.

Use this when you want to review generated images outside ComfyUI, for example:

* on a tablet
* in a shared folder
* in an external image viewer
* on a larger monitor

Connect:

```text
CheckpointListSelector.ckpt_name_str -> CheckpointStatusTagger.ckpt_name_str
```

When this connection is detected, the Selector button becomes:

* `🌑 DirectLink OFF`
* `🌕 DirectLink ON`

DirectLink is OFF by default. While OFF, selecting a checkpoint in the Selector does not update the Tagger target.

When DirectLink is turned ON, the Tagger labels the checkpoint currently selected in the Selector.

A confirmation dialog is shown once per browser page load:

```text
Enable DirectLink?

Use this mode only while checking generated images on a tablet, shared folder, or external viewer.

Otherwise, connect ImageDirPreview and use Sync mode.

Tagger will label the checkpoint selected in ListSelector.
```

If `ImageDir Preview` is connected, the Selector uses normal Sync mode instead.

### Selector action button cleanup

`Checkpoint List Selector` now changes its main action depending on what it is connected to:

* No review node connected:

  * `🏹 Push to Local List`
* Connected to `ImageDir Preview`:

  * `🎯 Sync Checkpoint`
* Connected only to `Checkpoint Status Tagger`:

  * `🌑 DirectLink OFF` / `🌕 DirectLink ON`

The old `List Only` button has been removed from the normal UI.
Internal refresh behavior remains available where needed.

### Tagger UI improvements

`Checkpoint Status Tagger` has been cleaned up for better readability.

* The current tag status is easier to read.
* Delete guidance text is shorter.
* The message area is more compact.
* DirectLink source text is not shown in the Tagger, to keep focus on the current tag state.
* DirectLink ON/OFF state is shown by the Selector instead.

### Delete script output moved to `output`

Checkpoint deletion scripts are now exported to:

```text
ComfyUI/output/CheckpointHandpickerSuite/delete_scripts/
```

instead of the ComfyUI temp directory.

The folder is created automatically when needed.

This makes deletion scripts easier to find and less likely to disappear unexpectedly when temp files are cleared.

### Sidecar thumbnail cleanup support

When creating checkpoint deletion scripts, the suite now also includes managed sidecar thumbnail candidates for the checkpoint.

This helps keep checkpoint folders cleaner after deleting reserved checkpoints.

Checkpoint deletion is still script-based and confirmation-based.
No checkpoint file is deleted immediately from the UI.

### ListSelector thumbnail preview

`Checkpoint List Selector` can show sidecar checkpoint thumbnails while hovering checkpoint rows.

This makes it easier to recognize checkpoints visually before selecting or tagging them.

## Recommended companion saver nodes

For best results, use this suite together with one of these saver nodes:

* `ComfyUI-GMImageSaver`
* `ComfyUI-PillowImageSaver`

Connect `ckpt_name_safe` to the saver node's `label` input.

This lets generated images be saved into checkpoint-aware filenames or directories, making `ImageDir Preview`, thumbnail selection, and cleanup much more effective.

## Notes

This release keeps the review-first cleanup philosophy:

* tagging a checkpoint as `delete` only reserves it for deletion
* checkpoint deletion is performed later by an exported script
* generated image deletion in `ImageDir Preview` is immediate, but requires confirmation

## Upgrade notes

After updating, restart ComfyUI.

If an existing workflow contains old `Checkpoint Status Tagger` or `Checkpoint List Selector` nodes from earlier versions, recreating those nodes may help ensure the latest UI and connection behavior is used.
