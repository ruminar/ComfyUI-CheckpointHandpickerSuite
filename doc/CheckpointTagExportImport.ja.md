# Checkpoint Tag Export / Import

`Checkpoint Tag Export / Import`は、HandpickerSuiteで蓄積したCheckpoint評価をバックアップ・復元するための独立した管理ノードです。

接続用の入力・出力ソケットはなく、ComfyUI Queueにも接続しません。キャンバス上へ単独で配置して使用します。

## Tag Transfer Directory

ディレクトリ入力欄はWorkflowへ保存されます。空欄では`Default: output/CheckpointHandpickerSuite/`が薄いplaceholderとして表示され、そのデフォルト位置を使用します。

カスタム値には、すでに存在するフルパスを指定します。ローカルの絶対パスとUNC／ネットワークパスを使用できます。指定したディレクトリが存在しない場合はエラーとなり、自動作成もデフォルト位置へのfallbackも行いません。ExportとImportは常に同じ指定先を使用し、その直下だけを検索します。

## Export

`Export`を押すと、次のディレクトリへJSONを保存します。

```text
output/CheckpointHandpickerSuite/
checkpoint_tags_YYYYMMDD_HHMMSS.json
```

Exportされるのは評価済みCheckpointだけです。各recordには次の情報が入ります。

```json
{
  "file_name": "modelA.safetensors",
  "file_size": 6847213568,
  "tag": "favorite"
}
```

ディレクトリ、ドライブ、Checkpointファイルの日時は保存しません。Checkpoint本体が見つからない評価はFailedとしてスキップします。同じ`file_name + file_size`に異なる評価がある場合はAmbiguousとして出力せず、評価が同じ場合は1recordへ統合します。

JSONは一時ファイルへ完全に書き込んだ後、正式なファイル名へ変更します。

一時ファイル名は毎回一意で、同じ共有ディレクトリへ複数PCから同時にExportしても同じ最終ファイル名を上書きしないよう短時間の予約ファイルを使用します。

## Import

別環境へ移行する場合は、ExportしたJSONをImport先の`output/CheckpointHandpickerSuite/`へコピーして`Import`を押します。

Import対象は、規定形式に一致するファイル名のうち日時文字列が最大のものです。日時が実在するか、未来日付かは検証しません。同一秒のファイルは数値suffixで比較します。選択された最新JSONが壊れていた場合、古いJSONへ自動fallbackせずImportを中止します。

Studioで書き出した `Anima_20261125_153000.json` のようなファイルは、同じディレクトリの直下へコピーし、**Import File…** でファイル名を指定します。規定のファイル名へ変更する必要はありません。この操作では既存評価が変わる場合に件数を示して確認します。確認を取り消した場合は変更を保存しません。

確認後にJSONの内容や適用対象が変わった場合、古い確認では保存せず、適用できる評価があれば再確認します。保存前に照合先のファイル名とサイズを再検査し、消失やサイズ変更があった対象はFailedとして報告します。

Import先では、Checkpointをファイル名とファイルサイズの完全一致で照合します。

- 一致なし：Missing
- 複数一致、または一致先の相対パスが別のCheckpointと同じ評価キーになる：Ambiguous
- 現在の評価が`none`：Imported
- 現在の評価とImport評価が同じ：Unchanged
- 現在の評価とImport評価が異なる：自動ImportではConflict。**Import File…** で上書きを確認した場合はImported

有効な変更はまとめて保存され、Import完了後に開いている全ブラウザタブのHandpickerSuite表示へ自動反映されます。

`delete`評価をImportしても、削除予約は新規作成されず、Checkpoint本体も削除されません。既存の予約が有効になりかねない場合は、新たな`delete`評価の適用を見送ります。`delete`を別の評価で上書きすると、評価の保存後に残っていた削除予約を取り消します。取消に失敗した場合は、保存済みの評価とは別に警告を表示します。後から通常の削除予約を作成したい場合は、`Checkpoint Status Tagger`で`delete`を一度OFFにしてからONにしてください。

Checkpoint本体が存在しなくなった`delete`評価は、削除予約が残っていない場合でも`Refresh All`で自動的に評価DBから除去されます。存在しない`god`、`favorite`、`nice`、`keep`評価はバックアップ用途のため保持されます。
