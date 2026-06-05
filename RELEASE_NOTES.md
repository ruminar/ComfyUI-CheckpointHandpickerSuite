# ComfyUI-CheckpointHandpickerSuite v0.1.2

## v0.1.2 - Cycler filter persistence and UI collapse fixes

This is a bugfix release for Cycler workflow persistence and collapsed node UI behavior.

### Fixed

- Fixed an issue where `Checkpoint Name Cycler` status filter settings were reset after saving, loading, switching tabs, or frontend redraws.
- `Use Local List` ON/OFF state is now preserved with the workflow.
- Runtime-only state such as Local List contents, current index, repeat count, and shuffle deck is intentionally not saved.
- Fixed custom controls remaining visible when Suite nodes are collapsed.

## Highlights

- Checkpoint Name Cycler for batch checkpoint cycling
- Checkpoint List Selector for review and Local List workflows
- Checkpoint Status Tagger for favorite / nice / keep / delete-reserved tagging
- Ephemeral Preview for zero-disk preview display
- ImageDir Preview for output-folder review contact sheets
- Tab-local UI operation with shared checkpoint status
- Safe cleanup flow using delete reservation and confirmation script
