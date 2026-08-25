# CheckpointHandpickerSuite specification index

このディレクトリは、実装より先に守るべき現行仕様と退行条件を記録する。
過去の開発版ごとの差分や実装ファイルの複製は置かず、現在有効な契約だけを正本とする。

- [node-contracts.md](node-contracts.md): ノード登録、入出力、状態とフロントエンドの境界
- [selection-and-cycling.md](selection-and-cycling.md): Selector、Cycler、Local List、DirectLink
- [review-and-deletion.md](review-and-deletion.md): 評価、Preview、サムネイル、削除予約
- [tag-transfer.md](tag-transfer.md): 評価JSONのExport / Import
- [regression-matrix.md](regression-matrix.md): 静的検証と手動回帰項目

## 変更時の原則

1. 挙動を変更する前に該当仕様を更新する。
2. 仕様変更には、可能な限り対応する自動テストを追加する。自動化できないUI挙動は回帰マトリクスへ追加する。
3. PythonとJavaScriptの静的検証を成功させる。
4. 公開ノード名、ソケット、保存済みWorkflowとの互換性に影響する変更はREADMEとRELEASE_NOTESにも記載する。
5. `.spec`には仕様文書だけを置き、`suite_nodes.py`や`web/checkpoint_handpicker_suite.js`を複製しない。

現在の対象バージョンは `0.3.1`。
