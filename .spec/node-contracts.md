# Node and state contracts

## 公開ノード

| 登録名 | 表示名 | 主な入力 | 出力 |
|---|---|---|---|
| `CheckpointListSelector` | Checkpoint List Selector | `checkpoint` | `ckpt_name`, `ckpt_name_str`, `ckpt_name_safe` |
| `CheckpointNameCycler` | Checkpoint Name Cycler | `start_checkpoint`, `mode`, `change_every` | `ckpt_name`, `ckpt_name_str`, `ckpt_name_safe` |
| `CheckpointStatusTagger` | Checkpoint Status Tagger | `ckpt_name_str` | なし |
| `CheckpointTagExportImport` | Checkpoint Tag Export / Import | `tag_transfer_directory` UI | なし |
| `EphemeralPreview` | Ephemeral Preview | `image` | なし |
| `ImageDirPreview` | ImageDir Preview | `ckpt_name_str`, `search_directory`, `max_preview_images` | なし |

## メニュー階層

通常ノードは`HandpickerSuite`直下、Preview系だけは`HandpickerSuite/Preview`へ登録する。

```text
HandpickerSuite
├─ Checkpoint List Selector
├─ Checkpoint Name Cycler
├─ Checkpoint Status Tagger
├─ Checkpoint Tag Export / Import
└─ Preview
   ├─ Ephemeral Preview
   └─ ImageDir Preview
```

## Checkpoint名の3出力

SelectorとCyclerは、同じ相対Checkpointパスを用途別に3形式で公開する。

- `ckpt_name`: Checkpoint Loaderへ接続できるCombo互換出力。
- `ckpt_name_str`: TaggerとImageDirPreviewへ接続するSTRING出力。
- `ckpt_name_safe`: 拡張子とファイル名に不向きな文字を除去・置換したSTRING出力。

値が同じでも型と接続先が異なるため、`ckpt_name_str`を削除して`ckpt_name`へ統合してはならない。
TaggerとImageDirPreviewの`ckpt_name_str`はSTRINGかつ`forceInput: True`を維持する。
未接続時に先頭Checkpointや共有Preview状態から対象を推測してはならない。

## 状態の所有範囲

- Cycler、Tagger、Preview、実行中Checkpointの保持状態はブラウザタブIDとノードIDで分離する。
- 通常のSelector同期、DirectLink、Tagger変更、Preview進捗は対象タブだけへ反映する。
- Tag Importと、Refresh Allによる消失済み`delete`評価の解除は全タブへ反映する。
- Cyclerの実行後スナップショットが、最後に実際に返したCheckpointの正本である。
- EphemeralPreviewのCheckpoint名表示はタブ内の実行状態を利用するが、評価や削除対象の決定には使用しない。

## 永続データ

- 評価DBは`data/checkpoint_statuses.json`へatomic保存する。
- `favorite`互換データは`data/checkpoint_favorites.json`へ同期する。
- `none`は評価DBからrecordを削除して表現する。
- Runtime UI状態はバックエンドメモリにも保持され、Workflowに保存されたhidden widgetは初期化時の復元元となる。

## フロントエンド読み込み契約

- 実装は`web/checkpoint_handpicker_suite.js`だけを正本とする。
- `WEB_DIRECTORY = "./web"`を維持する。
- JavaScriptのComfyUI importは`../../scripts/app.js`と`../../scripts/api.js`を使用する。
- 必須Comboへ`.`や空文字など、候補一覧に存在しないsentinelを残してQueue検証を失敗させてはならない。
