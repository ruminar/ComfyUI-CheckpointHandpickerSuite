# Regression matrix

## 静的検証

```powershell
$py = "C:\path\to\python.exe"
& $py -B -c "import ast, pathlib; [ast.parse(pathlib.Path(p).read_text(encoding='utf-8')) for p in ('suite_nodes.py', '__init__.py')]"
node --check web/checkpoint_handpicker_suite.js
git diff --check
```

現時点では専用の自動テストsuiteを持たない。ロジック変更時はComfyUI依存部を分離して自動テストを追加し、この表へ対応を記載する。

## 仕様と回帰確認の対応

| 保護対象 | 主な確認 |
|---|---|
| 6ノードの登録と表示名 | ComfyUI再起動後に全ノードがカテゴリへ表示される |
| 3出力の互換性 | Selector/CyclerからLoader、Tagger、ImageDirPreviewへ既存Workflowのまま接続できる |
| JS読み込み契約 | custom UIが表示され、hidden widgetが通常widgetとして露出しない |
| Selector 3モード | 接続先ごとにPush、Sync、DirectLinkの正確なボタンへ切り替わる |
| DirectLink安全性 | OFFではTaggerが追従せず、ON確認はページ内1回、ONはボタンだけactiveになる |
| Cycler runtime state | 保存・再読込・タブ移動後もmode、change_every、filter、Local List設定を維持する |
| 4つのCycler mode | fixed、increment、randomize、shuffle_onceが実行時の候補規則に従う |
| Local List | 重複を保持し、1実行で1件消費し、Clear/ON/OFFでCurrent Jobを変えない |
| status順序とdelete制約 | `👑 💛 👍 ✔ 🗑 —`を全UIで揃え、正評価から直接deleteへ変更できない |
| 削除script安全性 | `[y/N]`を維持し、対象Checkpoint群以外の画像を削除候補にしない |
| Refresh All cleanup | Explorer/scriptで消えたCheckpointの予約と`delete`評価を除き、正評価は保持する |
| EphemeralPreview | disk cacheを作らず、表示用実行状態が評価対象へ流用されない |
| ImageDirPreview | progress中も既存sheetを維持し、左クリックmenuとsession検証が機能する |
| 画像削除 | 確認後に元画像を削除し、tile位置を保った`NO IMAGE`表示が非操作になる |
| thumbnail設定 | 保守的なsidecarだけを作成/上書きし、Selector cacheを更新する |
| Tag Export | missingをFailed、異なる重複評価をAmbiguousにし、残りをatomic出力する |
| 最新Export選択 | 未来日時名を許可し、形式外を無視し、壊れた最新JSONからfallbackしない |
| Tag Import merge | noneだけを更新し、同値をUnchanged、異値をConflictとして現在値を守る |
| Import delete | 評価だけを復元し、予約queueと削除scriptを生成しない |
| Import UI同期 | Import直後に開いている全タブのSelector、Tagger、Preview、Cycler表示が更新される |
| 共有directory | 未作成custom pathをerrorにし、同時transferをBUSY、同時Exportを同名上書きしない |

## Tag Transferの最小手動シナリオ

1. default、既存local絶対path、既存UNC path、空白だけの入力を確認する。
2. 存在しないcustom pathでExport/Importが失敗し、directory作成もdefault fallbackもしないことを確認する。
3. evaluated、missing、同一identity同評価、同一identity異評価を含むDBからExportし、件数とJSONを確認する。
4. Export名を未来日時へ変更してImport対象になること、形式外ファイルが無視されることを確認する。
5. 最新JSONを壊し、古い正常JSONへfallbackしないことを確認する。
6. none、同値、異値、missing、物理重複を含む環境へImportし、各ResultとDBを確認する。
7. Import処理の前後でTaggerを操作し、後に完了したTagger指定が最終値になることを確認する。
8. `delete`をImportして予約が作られないこと、OFF/ON後は通常予約が作られることを確認する。
9. 複数ブラウザタブを開いた状態でImportし、手動reloadなしに全タブへ反映されることを確認する。
