# Checkpoint Tag Export / Import

`Checkpoint Tag Export / Import` is a standalone management node for backing up and restoring HandpickerSuite checkpoint evaluations.

## Export

Click `Export` to create:

```text
output/CheckpointHandpickerSuite/
checkpoint_tags_YYYYMMDD_HHMMSS.json
```

Only evaluated checkpoints are exported. Each portable record contains:

```json
{
  "file_name": "modelA.safetensors",
  "file_size": 6847213568,
  "tag": "favorite"
}
```

Paths and checkpoint file timestamps are intentionally omitted. A missing checkpoint is reported as Failed and skipped. Duplicate `file_name + file_size` identities with different evaluations are reported as Ambiguous and omitted; equal evaluations are deduplicated.

The JSON is fully written to a temporary file before it is renamed to its final name.

## Import

Copy an exported JSON file into `output/CheckpointHandpickerSuite/` and click `Import`.

Import selects the matching filename with the greatest timestamp string. Timestamp validity and future dates are not checked. A numeric suffix resolves exports created in the same second. If the selected file is invalid, Import stops and does not fall back.

Current checkpoints are matched by exact file name and file size:

- no match: Missing;
- multiple matches: Ambiguous;
- current tag is `none`: Imported;
- current tag equals the imported tag: Unchanged;
- current tag differs: Conflict, and the current tag is preserved.

All valid changes are saved together. HandpickerSuite state is then refreshed automatically in every open browser tab.

An imported `delete` tag never creates a deletion reservation and never deletes a file. Toggle `delete` OFF and ON in `Checkpoint Status Tagger` if you later want to create the normal deletion reservation.

`Refresh All` removes a `delete` tag automatically after its checkpoint file no longer exists, even when no deletion reservation remains. Missing `god`, `favorite`, `nice`, and `keep` evaluations are preserved.
