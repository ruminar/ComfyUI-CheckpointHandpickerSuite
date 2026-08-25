# Selection and cycling specification

## Checkpoint List Selector

SelectorはCheckpoint一覧、評価アイコン、現在選択、スクロール操作を表示する。主操作は接続先によって変わる。

| 接続状態 | ボタン | 動作 |
|---|---|---|
| Review対象なし | `🏹 Push to Local List` | 選択をCyclerのLocal Listへ追加する |
| ImageDirPreviewあり | `🎯 Sync Checkpoint` | TaggerとImageDirPreviewを明示的に同期する |
| Taggerのみ | `🌑 DirectLink OFF` / `🌕 DirectLink ON` | 外部画像レビュー用の追従を切り替える |

ImageDirPreviewとTaggerの両方が接続されている場合はSyncを優先する。`Push to Local List`を短縮せず、通常UIへ`List Only`ボタンを戻さない。

DirectLinkは初期状態OFFとする。ONへ切り替える確認はブラウザページごとに最初の1回だけ表示し、キャンセル時も表示済みとする。ONでは選択変更にTaggerが追従し、OFFではSelector由来のTagger対象を持たない。ONの表示はボタンだけをactive表示し、Selector全体を緑枠にしない。

一覧行のhoverでは、Checkpointと同じディレクトリにある保守的なsidecar thumbnailだけを表示する。スクロール、ノード外への移動、Refresh Allで古いpopup/cacheを消す。ImageDirPreviewの検索先やComfyUI outputをthumbnail探索に流用しない。

## Refresh All

Refresh AllはComfyUIのCheckpoint一覧cacheを更新し、HandpickerSuiteと既知の標準Checkpoint widgetを現在存在する候補へ同期する。必須Comboの現在値が消失していれば、実在する候補へ補正する。

Refreshは削除予約の整理と、物理ファイルが消失した`delete`評価の解除も行う。詳細は[review-and-deletion.md](review-and-deletion.md)を参照する。

## Checkpoint Name Cycler

CyclerはQueue登録時ではなく、ノードの実行時に最新のバックエンド状態からCheckpointを解決する。初回はWorkflowに保存された値をruntime stateへ取り込み、以後は新しいsettings revisionを持つ更新だけを採用する。

- `fixed`: `start_checkpoint`を返す。通常のstatus filterは選択を変えない。
- `increment`: 全Checkpointの順序を進み、現在のfilterに一致しない項目を飛ばす。
- `randomize`: 現在の候補から毎回ランダム選択し、重複を許す。
- `shuffle_once`: 全Checkpointからglobal deckを作り、順に消費する。実行時のfilterに不一致の項目も消費し、deckが空なら再構築する。

`change_every`回は同じ通常選択を保持する。実行結果のtitle、Current Job、status iconは最後に実際に返したCheckpointから再構築し、フロントエンドのstatus通知で既存titleへiconを継ぎ足さない。

status filterの順序は`all`, `👑 god`, `💛 favorite`, `👍 nice`, `✔ keep`, `🗑 delete`, `— none`。filter一致が0件のときは全Checkpointへfallbackし、その事実を状態表示へ出す。

## Local List

- Local Listはsetではなく順序付きlistで、重複を許す。
- ONかつ空でない場合、通常モードより優先し、1実行につき先頭1件を消費する。
- Local List中は`change_every`で保持せず、1件ずつ進む。
- Local Listの消費は`shuffle_once`のglobal deckを進めない。
- 空の場合は通常のCycler候補へ戻る。
- Push、Clear、ON/OFFは、最後に実行したCheckpoint名・source・Current Jobを書き換えない。
- 0件時に`Local List Remaining: 0`を表示せず、`Queue`という名称を使わない。
- status表示ではShuffle DeckをLocal Listより先に置き、Local List項目番号1〜9を2桁幅で揃える。
