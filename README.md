# ComfyUI-CheckpointHandpickerSuite

A draft integrated suite that bundles the following nodes:

## Checkpoint tools
- Checkpoint List Selector
- Checkpoint Name Cycler
- Checkpoint Status Tagger
- Checkpoint Status Filter

## Preview tools
- Ephemeral Preview Tap
- Ephemeral Preview
- ImageDir Preview

## Current draft scope
- Statuses: `favorite`, `nice`, `keep`, `delete`, `none`
- Cycler can accept queued checkpoints from the list selector
- Cycler can accept status filters
- List selector can refresh checkpoint widgets and queue a selected checkpoint to active cyclers
- Tagger can switch status interactively
- Preview nodes normalize images to a 512px long-edge tile and build near-square contact sheets
- Contact sheet layout ignores `gap` during packing and applies `gap=6` only while rendering
- ImageDir Preview searches the output directory by default, or a provided directory
- Delete reservations are exported to `temp/delete_reserved_checkpoints.py`

## Notes
This is a draft source bundle created from the agreed integrated specification and is intended for iterative refinement.
