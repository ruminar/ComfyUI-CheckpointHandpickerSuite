# Review, tagging, and deletion specification

## Checkpoint評価

評価値と表示順は次のとおり。

1. `god` / `👑 god!`
2. `favorite` / `💛 favorite`
3. `nice` / `👍 nice`
4. `keep` / `✔ keep`
5. `delete` / `🗑 delete`
6. `none` / `— none`

Taggerは`none`ボタンを表示しない。現在選択中の評価ボタンをもう一度押すと`none`へ戻る。正の評価同士は直接変更できるが、`delete`は現在値が`none`または`delete`のときだけ操作できる。したがって正の評価から削除予約するには、いったん現在の評価をOFFにする。

Taggerは明示された`ckpt_name_str`だけを評価する。未接続時、およびSelector直結でDirectLink OFFのときは操作対象を持たない。評価変更は同じタブのSelector、Tagger、Preview、Cycler状態へ反映する。

## Checkpoint削除予約

`delete`評価は即時削除ではない。通常のTagger操作で`delete`をONにしたときだけ予約recordを追加し、次を`output/CheckpointHandpickerSuite/delete_scripts/`へ生成する。

- `checkpoint_delete_queue.jsonl`
- `delete_reserved_checkpoints.py`
- `checkpoint_delete_plan.txt`

生成scriptはCheckpoint単位で`[y/N]`確認を行う。評価を`delete`以外へ戻した場合は有効な予約をcancelし、scriptを更新する。

削除候補は対象Checkpoint、その対応JSON、および同一ディレクトリの保守的なsidecar thumbnailに限定する。thumbnail拡張子は`.jpg`, `.jpeg`, `.png`, `.webp`とし、曖昧な部分一致検索、ImageDirPreview検索結果、review/output画像をCheckpoint削除対象にしてはならない。

Refresh Allでは、物理Checkpointが存在しない予約をcancelする。予約recordの有無にかかわらず、物理Checkpointが存在しない`delete`評価もDBから除去し、以後のExportで永続的なFailedにならないようにする。消失した`god`, `favorite`, `nice`, `keep`評価はバックアップ用途のため保持する。

## Ephemeral Preview

入力画像batchからメモリ上でcontact sheetを作り、ディスクへpreview cacheを書かずブラウザへ送る。最後のCycler実行状態が同じタブにあればCheckpoint名と評価を表示する。この表示用状態をTaggerや削除対象の決定へ使用しない。

## ImageDir Preview

- `ckpt_name_str`未接続時は自力でCheckpointを選ばずinactiveとする。
- `search_directory`が空の場合はComfyUI outputを検索する。
- 対応画像は`.png`, `.jpg`, `.jpeg`, `.webp`。
- 再帰検索は一致候補3,000件で打ち切り、更新日時順から最大`max_preview_images`件を表示する。
- Selector Syncの重い読み込みはevent loop外で実行し、進捗通知だけで既存contact sheetを消さない。
- 表示した`source_paths`、layout、`preview_session_id`をbackend stateへ保存し、操作時にsessionを検証する。

生きているtileをhoverすると枠を描き、左クリックで次の順序のmenuを開く。右クリックはComfyUI本来の動作を変更しない。

1. `Delete image`
2. `Set as checkpoint thumbnail`

`Delete image`は確認後に元画像を直接削除する。現在のtile位置は詰めず、`deleted_indices`へ記録して`NO IMAGE`を重ね、以後hoverとmenuを無効にする。

`Set as checkpoint thumbnail`は選択画像から、既存の保守的なsidecarを上書きする。存在しなければ`<checkpoint_stem>.jpg`を作成し、Selectorのthumbnail cacheを無効化する。Checkpoint評価やLocal Listは変更しない。
