# Checkpoint Tag Export / Import specification

## ノードと保存先

`Checkpoint Tag Export / Import`はQueueへ参加しない独立管理ノードで、接続用socketを持たない。UIは次を表示する。

- `Tag Transfer Directory (full path only / network paths OK)`
- 空欄時のplaceholder `Default: output/CheckpointHandpickerSuite/`
- `📤 Export`
- `📥 Import`
- 件数、詳細、エラーを表示できるscroll可能なResult領域

入力値はtrimする。空なら`output/CheckpointHandpickerSuite/`を使用し、Export時だけ必要に応じて作成する。空でない値は既存の絶対ディレクトリでなければエラーとする。ローカル絶対パスとUNC/network pathを許可するが、custom directoryは自動作成せず、defaultへfallbackしない。ExportとImportは指定directory直下だけを扱う。

## Export形式

ファイル名は`checkpoint_tags_YYYYMMDD_HHMMSS.json`。同一秒に衝突する場合は数値suffixを付ける。document形式は次のとおり。

```json
{
  "format_version": 1,
  "exported_at": "2026-08-19T12:34:56+09:00",
  "evaluations": [
    {
      "file_name": "modelA.safetensors",
      "file_size": 6847213568,
      "tag": "favorite"
    }
  ]
}
```

portable identityは大文字小文字を含む正確な`file_name + file_size`とする。directory、drive、relative path、Checkpoint更新日時は出力しない。対象は`none`以外の評価済み`.safetensors`だけとする。

- 評価DBのrelative pathから物理Checkpointが見つからないrecordはFailedとしてスキップする。
- 同じrelative pathが複数rootで異なるfile sizeへ解決される場合はAmbiguousとしてスキップする。
- 同じidentityに同じ評価が複数あれば1recordへ統合する。
- 同じidentityに異なる評価が複数あればAmbiguousとして出力しない。
- 他recordのFailed/AmbiguousでExport全体を中止しない。

評価DBは処理開始時にsnapshotを取り、その後のTagger変更はそのExportへ含めない。JSONは同じdirectoryの一意な一時ファイルへ完全に書き、flush後に正式名へ置換する。短時間の予約ファイルにより、共有directory上の同名上書きとpartial JSON公開を防ぐ。

## Import対象の選択

対象名は`checkpoint_tags_YYYYMMDD_HHMMSS.json`または数値suffix付きだけとする。形式外ファイルは無視し、日時文字列とsuffix数値の組が最大のファイルを1件選ぶ。

日時が実在するか、現在以前かは検証しない。したがってファイル名を未来の日時文字列へ変更すれば、そのファイルを優先できる。選択した最新JSONが不正でも、古いExportへfallbackせずImportを中止する。

`format_version`は整数`1`だけを受理する。document rootや`evaluations`自体が不正ならImportを中止する。個別recordが不正ならFailedとしてスキップする。同じidentityに異なるtagが含まれる場合はAmbiguousとしてスキップし、同一tagの重複は1件へまとめる。

## 現環境との照合とmerge

現環境の`.safetensors`を全Checkpoint rootから走査し、exactな`file_name + file_size`で照合する。

| 状態 | Result | DB更新 |
|---|---|---|
| 一致なし | Missing | なし |
| 複数の物理Checkpointが一致 | Ambiguous | なし |
| 現在評価が`none` | Imported | Import評価を設定 |
| 現在評価とImport評価が同じ | Unchanged | なし |
| 現在評価とImport評価が異なる | Conflict | 現在評価を維持 |

遅いJSON検証とCheckpoint走査が終わった後、評価DBを1回読み、全recordをmergeし、変更があれば1回だけatomic保存する。通常Tagger書き込みとはlockを共有しないが、commitはawaitを挟まない同期区間とする。このためcommitより前に完了したTagger評価はImport対象外またはConflictになり、commitより後のTagger評価はImport結果を上書きする。常に操作順で後のTagger指定が優先される。

ExportとImport同士は同時実行せず、別のtransfer処理が実行中なら`BUSY`を返す。

## Import後の反映とdelete

Imported recordだけをbackendのTagger、Preview、Cycler、tab execution stateへ同期し、global eventで開いている全ブラウザタブのHandpickerSuite UIへ直ちに反映する。ユーザーによる手動reloadを要求しない。

Importされた`delete`は論理評価だけを復元し、削除予約queueや削除scriptを作らない。後から削除予約が必要ならTaggerで`delete`を一度OFFにしてからONにする。物理Checkpointが既に存在しない`delete`評価はRefresh Allで除去する。
