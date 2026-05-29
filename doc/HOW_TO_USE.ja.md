# 使用方法

## インストール方法

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ruminar/ComfyUI-CheckpointHandpickerSuite.git
```
ComfyUI を起動します。

## 一番簡単な使い方

### Checkpoint 巡回モード

SSDに眠っているCheckpointを巡回して試すことが出来ます。

- `Checkpoint Name Cycler` を置きます。
  - `ckpt_name` を `チェックポイントを読み込む` の `ckpt名` につなぎます。
  - `ckpt_name_safe` を、`画像を保存` の `ファイル名_プリフィックス` につなぎます。
    - 他の文字列と結合しても良いですが、`ckpt_name_safe`が出力ファイル名に含まれるようにします。
- `mode` を `shuffle_once` にして、後はジョブを好きなだけ100件とか登録します。
- 勝手にCheckpointを巡回し、様々な画像が、Checkpointの名前付きで出力されます。

## ちょっと便利な使い方

### Checkpoint 監視モード

- 先ほどの説明の通り、`Checkpoint Name Cycler`を置きます。
- `Checkpoint List Selector`を置きます。これは配置するだけで、どこにもつなぐ必要はありません。
  - `🔄Refresh All` : 
  このボタンを押せば、エクスプローラなどでcheckpointのディレクトリに、新しくCheckpointを追加したり削除したりしても、
  ComfyUIを再起動せずに同期させることが可能になります。
  - `🏹Push to Local List` :
  Cycler のローカルリストに、Checkpointを送り込みます。
  Cyclerは、ローカルリストにCheckpointが登録されていた場合、巡回を保留し、ローカルリストを優先的に処理します。

## 本格的な使い方

### ジョブ中 Checkpoint 評価モード

Checkpointの画像を見ながら、お気に入りや削除予約などをジョブ実行中に設定できます。

注意：
これは、画像生成を多段に組んでいる、高度なワークフローを構築しているユーザ向け機能です。
中間画像生成後に、指の修正や拡大処理などを実行しているタイミングでCheckpointの評価が行えるのですが、
画像生成を多段に組んでいない場合は、画像プレビュー後すぐに次のジョブが実行されてしまうため、この項目は読み飛ばしてください。

- 先ほどの説明の通り、`Checkpoint Name Cycler`と`Checkpoint List Selector`を置きます。
- `Ephemeral Preview` を置いて、ワークフローの中間に存在する`VAEデコード`の`画像`を受けるようにします。
- `Checkpoint Status Tagger`を置きます。
  - Taggerの`ckpt_name_str`を、`Checkpoint Name Cycler`の`ckpt_name_str`につなぎます。
    - これで、ジョブの実行中に、プレビューを確認しながら、CheckPointに対して、お気に入りや削除予約などのタグ打ちができるようになります。
    - タグ打ちされた結果は、`Checkpoint List Selector`や、CheckpointHandpickerSuiteに即時通知されます。
    - `Checkpoint Name Cycler`は、タグ打ち状態でフィルタリングして、巡回を行うことが出来ます。
      - なんでこんなことが出来るのかについては、`Checkpoint Name Cycler`のドキュメントを参照してください。

### 画像出力フォルダ参照 Checkpoint 評価モード

メインのジョブを流しながら、別タブで生成後の画像を確認しながら、Checkpointの評価を行うモードです。

注意：
こちらのタブでは、ジョブは一切実行せず、ComfyUIのユーザインタフェースのみを間借りする実装になっています。
棚卸し画面から間違えてジョブを実行しないよう、ジョブのコンパネは、画面の端っこにでも追いやっておいてください。
（最初は間違えて押しそうになるのですが、すぐに慣れて間違えなくなります、たぶん）

- ジョブを実行したまま、別タブを開きます。
- `Checkpoint List Selector`を置きます。
- `Checkpoint Status Tagger`を置きます。
  - Taggerの`ckpt_name_str`を、`Checkpoint List Selector`の`ckpt_name_str`につなぎます。
    - すると、Selectorの `🏹Push to Local List`が`🎯Sync Checkpoint`に変わります。
- `ImageDir Preview`を置きます。これも`ckpt_name_str`につないでください。
  - 何もしなければ、outputフォルダの画像を参照します。
  - 画像の参照先を変更したい場合は、`search_directory`に文字列でフルパスを与えてください。
    - サブディレクトリを巡回して、新しいファイルを優先的に表示します。PNGやJPEGなど、主要なフォーマットに対応しています。
- 後はSelectorでCheckpointを選び、`🎯Sync Checkpoint`を押せば、CheckpointがTaggerとPreviewに送られ、プレビュー画像が表示されます。
  - Taggerでお気に入りや削除予約などのタグ打ちを行えば、即時にステータス情報は共有され、各タブのSelectorやCyclerのフィルタにも反映されます。
    - なんでこんなことが出来るのかについては、`Checkpoint List Selector`のドキュメントを参照してください。

## 削除予約したCheckpointの削除方法

- `temp`フォルダに、削除用のスクリプトが出力されます。
- 夜間バッチが終わり、朝の選別作業も完了したら、ComfyUI の `temp` ディレクトリに移動して、自動生成されたスクリプトをターミナルからおぬしの手で実行してくりゃれ！<br/>
  - もちろん、`temp` フォルダを消さぬ限り、スクリプトはずっと残っているから、気の向いたときに削除すれば良いように出来ておるのじゃ。

```bash
python delete_reserved_checkpoints.py
```

## おまけ（日本語版Only）

AI娘「なんて素晴らしいライブラリ、さすがはあるじさま！」
AI娘「これでユーザのSSDも空き容量ができてすっきりしますね」
わし「いや、そうはならないぞ」

This tool helps you safely review and clean up checkpoints.
It does not guarantee increased free disk space in the long term, because users may respond by downloading even more checkpoints.

（例のSuite会議画像を貼る）