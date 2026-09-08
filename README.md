# claude-monitor

Claude Code の稼働状況・サブエージェントツリー・トークン使用量・ツール実行ログを
ローカルデータから読み取る監視ツール。ブラウザで見る Live / ツリー / Usage の3ビュー、
種類別 ON/OFF と利用枠のしきい値を持つ通知、ログオン時の自動起動を含む常駐化、
同じ情報を引く CLI からなる。

- 外部npm依存 **ゼロ**（Node標準モジュールのみ）
- `~/.claude` 配下は読み取り専用（`install-hooks` で `settings.json` を更新する場合を除く）
- 自前のデータ置き場は `%USERPROFILE%\.claude-monitor\`

設計と既知の制約は [docs/architecture.md](docs/architecture.md) を参照。

## 必要環境

- Node.js 20 以上（検証環境: v24.13.0）
- Claude Code 2.1.258 で検証
- 動作確認は Windows 11 のみ。`serve` と hooks の登録は OS 依存のコードを持たないが、Windows 以外では未検証。`install-autostart` と `tray` は Windows 専用。

## クイックスタート

```bash
git clone https://github.com/BelkaDolphin/claude-code-monitor.git
cd claude-code-monitor
node src/cli.js serve --open     # サーバを起動して既定のブラウザで開く
```

ライブ状態（稼働中・ツール実行・サブエージェント起動終了・通知）と `rate_limits` を
取り込むには hooks / statusLine の登録が要る（任意）。まず `--dry-run` で
内容を確認してから実行する。

```bash
node src/cli.js install-hooks --dry-run
node src/cli.js install-hooks
```

## ダッシュボード

```bash
node src/cli.js serve            # 既定 http://127.0.0.1:47321
node src/cli.js serve --open     # 起動して既定のブラウザで開く
node src/cli.js serve --port 8899
```

起動すると**トークン付きのURLが1行だけ標準出力に出る**。

```
http://127.0.0.1:47321/?t=13131313……（64桁のhex）
```

1. そのURLをブラウザで一度だけ開く。
2. サーバが `cm_token` Cookie（HttpOnly / SameSite=Strict）を発行して `/` にリダイレクトする。
   以後アドレスバーにトークンは残らない。
3. 以降は `http://127.0.0.1:47321/` だけでよい。Cookie が無い・違うアクセスは全て 403。

トークンは**プロセスごとに毎回作り直す**ので、サーバを再起動したら新しいURLを開き直す。
`Ctrl+C` で SSE を全切断してから終了する。

### 画面

- **Live** — 稼働中セッションのカード一覧。タイトル（transcript の ai-title、無ければ
  cwd の末尾）、cwd、PID、状態バッジ、モデル、context%、実行中のツールと経過秒、
  実行中サブエージェント、直近の通知、トークン合計、最終イベントからの経過時間。
  終了・停止したセッションは折りたたみの中。
  **稼働かどうかは積極的な証拠で決める**——生きている PID、hook 由来の phase、
  `sessions/<pid>.json` の `status` のどれか。statusline のサイドカーしか
  無いセッションは「不明」であって稼働ではない（statusline ディレクトリは
  掃除されないので、古いファイルが延々と残る）。hook が30分無音で PID も
  transcript も動いていないセッションは、作業中でも入力待ちでも「停止推定」に落ちる
  （ウィンドウを閉じただけでは `SessionEnd` が来ないことがあるため）。
  上部の帯が 5h / 7d の枠（`rate_limits`）で、復帰時刻はローカル時刻で出る。
- **通知** — 「通知を許可」でブラウザに許可を求め、「通知 ON/OFF」がマスタースイッチ。
  隣の「通知設定」でパネルが開く（詳細は下の「通知設定」）。
  同じセッションの同じ種類は5秒以内に重複させない。
- **Tree** — セッションからサブエージェントへのツリー。左がセッション一覧
  （稼働中が先頭。期間は 7 / 30 / 90 日）、右上がネストしたツリー、右下が詳細。
  ツリーの各行は 状態（`▶` 実行中 / `✓` 完了 / `?` 終了と推定 / `✗` エラー /
  `·` 完了不明）、`説明（種類）`、モデル、経過または所要、トークン、ツール数、
  実行中のツール。既定は深さ2まで開いた状態で、`▸`/`▾` で開閉できる。
  詳細パネルには**その値がどの源から来たか**（meta.json / hooks / transcript）を
  併記し、起動プロンプトとツール実行ログの末尾を出す。
  親が特定できないエージェント（hooks は知っているが transcript が消えているもの）は
  下部の折りたたみに分ける。
  稼働中のセッションを選んでいる間は2秒デバウンスで自動更新、終了済みは「更新」ボタン。
  Live カードの「Tree」ボタンからそのセッションのツリーへ直接飛べる。
- **Usage** — 期間（7 / 14 / 30日）を選んで、期間合計のタイル、
  日別テーブル（4指標＋合計、最大の日に揃えた棒、その中のモデル別積み上げ）、
  モデル別の内訳、トークン上位20セッション（「Tree」ボタンでツリーへ飛べる）を出す。
  5h・7d の枠ゲージはページ上部のリボン（全ビュー共通）にあるので、ここには置かない。
  セッションの「モデル」列は**そのセッションのルート transcript のモデル**で、
  サブエージェントが別のモデルで回っていてもラベルは変わらない。
  当日の行は `*` 付き（進行中）。transcript が消えて自分の保存値から出している日は
  「保存値」、スキャンが保存値より小さい日は「一部欠損」バッジが付く。
  「ccusage と突合」ボタンを押したときだけ ccusage を実行し、
  指標ごとの差分と ccusage のコストを列に足す（10分キャッシュ・60秒タイムアウト）。
  実行するのは `npx --no ccusage@20.0.20` で、**ダウンロードは一切しない**。
  事前に `npm i -g ccusage@20.0.20`（または npx キャッシュに存在すること）が必要で、
  無ければ脚注に「`npm i -g ccusage@20.0.20` を実行してから再度押す」と出して終わる。
  集計は 30日 / 100ファイル / 27.5k行 で初回 0.8秒、以降 25ms（ファイル単位キャッシュ）。

### 通知設定

ヘッダの「通知設定」ボタンでパネルが開く。変更は**即座に保存・即座に反映**される
（保存ボタンは無い）。Esc かパネルの外側クリックで閉じる。

| 項目 | 既定 | 内容 |
|---|---|---|
| 通知 ON / OFF | OFF | マスタースイッチ。OFF なら以下は全て無効 |
| 種類 | 全て ON | `permission_prompt`（許可の確認）/ `idle_prompt`（入力待ち）/ `agent_needs_input` / `agent_completed` / ターン完了（`Stop`） |
| 利用枠のしきい値 | 5h・7d とも ON / 80% | `rate_limits` の使用率がしきい値以上になった瞬間に1回だけ通知する。1〜100 の整数のみ |
| この画面を見ている間は鳴らさない | ON | タブが表示中かつフォーカスがある間は通知しない（目の前にあるものを読み上げない） |
| テスト通知 | — | 押した瞬間に1件出す。上の「見ている間は鳴らさない」もマスタースイッチも無視する |

**この設定はブラウザの `localStorage`（キー `cm.notify.settings`）にだけ保存される。**
サーバには一切送らないし、サーバ側に設定エンドポイントも無い。したがって
**ブラウザごと・プロファイルごとの設定**であり、別のPCや別のブラウザからは引き継がれない。
以前のバージョンの `cm.notify.enabled`（`'1'`/`'0'`）は初回読み込み時に
マスタースイッチへ取り込まれ、古いキーは消える。
壊れた JSON や知らない version が入っていた場合は黙って既定値に戻す。

しきい値通知は**窓ごとに1回**。`resets_at` が変わる（＝枠がリセットされた）、
使用率がしきい値を下回る、しきい値を変える、のいずれかで再武装する。
接続した瞬間に既にしきい値を超えていた場合は**鳴らさず「通知済み」として黙る**
（タブを開き直すたびに鳴らないため）。

### API（すべて GET。Cookie と同一オリジンが必須）

| ルート | 内容 |
|---|---|
| `/api/state` | Live のスナップショット |
| `/api/stream` | SSE。接続時と変化のたびに `snapshot` |
| `/api/health` | 稼働時間・SSE接続数・collector 統計・ツリーキャッシュ統計 |
| `/api/sessions?days=N` | セッション一覧（既定30日、1〜90にクランプ。稼働中は期間で消えない） |
| `/api/tree/<sessionId>` | サブエージェントツリー1本（hooks + meta.json + transcript の合成） |
| `/api/tools/<sessionId>?agent=<agentId>&limit=N` | ツール実行ログの末尾（既定100、1〜500） |
| `/api/usage?days=N` | 日別・モデル別・セッション別のトークン使用量（既定30日、1〜90にクランプ。今日を含む N 暦日） |
| `/api/usage/ccusage?days=N` | 同じ窓を ccusage と突合。要求時のみ `npx --no ccusage@20.0.20` を実行（ダウンロード無し）し、失敗は `ccusage unavailable` の一語。未インストールのときだけ `notInstalled: true` と `ccusageVersion` を添える |

`/api/usage` の応答の `days` は**日行の配列**であり、窓の長さは
**両ルートとも `windowDays`** で返す（同じ名前が2つのルートで別の意味に
ならないように揃えてある。`/api/usage/ccusage` の日行は `rows`）。

不正な形式のIDも存在しないIDも同じ 404 を返す（形式の当たりを教えないため）。
GET / HEAD 以外は 405。`/api/usage` は結果を `<monitorDir>/usage/daily.json` に
書き戻す（Claude Code が約30日で transcript を消すため）。**GET が書く唯一のファイル**で、
`~/.claude` 配下は読み取り専用のまま。

### セキュリティ上の前提

- サーバは **`127.0.0.1` にしか bind しない**。LAN からは見えない。
- 守っている脅威は「同じブラウザで開いている他のサイトからのクロスサイト要求」と
  DNS リバインディング。トークン（Cookie）に加えて `Host` / `Origin` /
  `Sec-Fetch-Site` を検証し、静的ファイルにも同じ検査をかける。
- **守っている境界は「ユーザーアカウント」まで。** `--persist-token` で保存される
  トークンとダッシュボードURLは、**同じユーザーアカウントで動く任意のプロセスから
  読める**（ファイルの ACL はそのユーザー自身を締め出せない）。このツールが守るのは
  ユーザーアカウントの境界と、ブラウザ経由の他オリジンからのアクセスであって、
  **同一ユーザ内で動く悪意あるプロセスは守らない**。それを脅威に含めるなら、
  そのプロセスは `~/.claude` 自体も読めるので、守るべき対象はこのツールではない。
- **既知の制約: 既定ポート（47321）が固定である。** 先に同じポートを取った偽サーバが
  居ると、ブックマークした起動URLを開いた時点で `?t=<token>` をそちらに渡してしまう。
  同一ユーザ内のプロセスに限る話（上記の境界の外）だが、ポートを固定にした代償として
  明記しておく。心配なら `--port` を毎回変え、URLはブックマークせずに使い捨てにすること。
- **起動URLは共有しない。** それが唯一の資格情報で、画面には他人に見せたくない
  作業ディレクトリ・セッション名・コスト・枠残量が出る。
  スクリーンショットを撮るならアドレスバーを入れない。
- ダッシュボードは読み取り専用。書き込み系のエンドポイントは無く、GET/HEAD 以外は 405。
- 外部への通信は一切しない（Webフォントも CDN も無し）。CSP でも塞いである。
  唯一の外部プロセス起動は「ccusage と突合」ボタンだが、`npx --no` なので
  **同意なくダウンロードすることはない**。手元に無ければ何も取りに行かず、
  `npm i -g ccusage@20.0.20` を案内して終わる。
- 他サイトの frame に入れられない（`X-Frame-Options: DENY` と CSP `frame-ancestors 'none'`）。
- サーバが予期せぬ例外で倒れた場合は、**黙って消えずに**理由を表示し、
  ポートを解放して終了コード1で終わる。古い画面を見て「異常なし」と
  誤解しないための設計。

## セットアップ

インストール作業は不要（依存パッケージが無いため `npm install` も不要）。

```bash
# 動作確認
node src/cli.js paths
node src/cli.js list --days 7
```

### hooks / statusLine の登録（任意）

ライブ状態（稼働中・ツール実行中・サブエージェント起動終了・通知）と
`rate_limits` を取るには hooks と statusLine の登録が必要。

```bash
# まず必ず内容を確認する（何も書き込まない）
node src/cli.js install-hooks --dry-run

# 問題なければ実行。settings.json.bak-<timestamp> を自動で作る
node src/cli.js install-hooks

# 元に戻す
node src/cli.js uninstall-hooks --dry-run
node src/cli.js uninstall-hooks
```

- 既存の hooks（例: `SessionEnd` の `session_end.ps1`）と `permissions` 等の
  設定は保持される。冪等性は**スクリプトのパス**で判定するので、同じフックが
  二重に登録されることはない。
- 登録されるのは `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `Stop` /
  `SubagentStart` / `SubagentStop` / `PreToolUse` / `PostToolUse` /
  `PostToolUseFailure` / `Notification` / `PreCompact` / `PostCompact`。
- **コマンドには `node` の絶対パス（`process.execPath`）を埋める。**
  素の `node` は起動元の PATH 次第で、GUI から起動した Claude Code は
  バージョンマネージャ（nvm / fnm / volta）が PATH を通すシェルプロファイルを
  継承しない。**hooks だけが黙って死ぬ**のはこれが原因になる。
  したがって **node を入れ替えたら `install-hooks` を再実行すること**。
  再実行は旧エントリを**その場で書き換える**（追加はしない）。
  リポジトリを移動したときも同じ。
- 既に `statusLine` が設定されていて、それが**我々のものでない**場合は
  **触らない**。hooks だけ登録し、「既存の statusLine があるため未登録」と出す。
  奪ってよければ `install-hooks --force-statusline` —— 元の値は
  `settings.json` の `_claudeMonitorStatusLineBackup` に退避され、
  `uninstall-hooks` が復元する。
- リポジトリや node のパスに `"` / 改行 / NUL（Windows では `%`、POSIX では
  `$` `` ` `` `\` `!`）が含まれる場合は**登録を拒否する**。hooks の
  `type: "command"` はシェル経由で起動されるので、そのままでは
  「書いてあるとおりのもの」が走らない。`--dry-run` でも同じ判断を出す。
- 反映は**新しいセッションから**。
- hooks は `~/.claude-monitor/events/<YYYY-MM-DD>.jsonl` に1イベント1行を追記する。
  実測で**約7MB/日**貯まるので、サーバが**既定30日で古い日のファイルを削除する**
  （`serve --events-keep-days N`、`0` で無期限）。削除は起動時と日跨ぎ時だけ、
  対象は `YYYY-MM-DD.jsonl` に完全一致する名前のみ。
  保持日数より古いセッションを Tree で開くと hook の証跡が無いので、
  エージェントの状態は transcript からの推定にフォールバックする。

### 常駐化（任意）

ログオン時に隠しウィンドウでサーバを起動し、ブックマーク1つで開けるようにする。Windows 専用。

**既定でトレイ常駐になる。** ログオンタスクが起動するのは node ではなく
**トレイホスト**（`tray/claude-monitor-tray.ps1`）で、これが通知領域にアイコンを出し、
サーバを子プロセスとして起動して**面倒を見る**。プロセスの親子関係はこうなる:

```
wscript.exe (autostart.vbs)
  └─ powershell.exe -STA -WindowStyle Hidden  ← トレイホスト（アイコン）
       └─ node.exe src/cli.js serve ...        ← サーバ
```

アイコンの色が状態そのものである。**緑=稼働中 / 灰=起動中 / 赤=再起動を諦めた**。
右クリックで「ダッシュボードを開く」「ログを開く」「再起動」「終了」、ダブルクリックで
ダッシュボードが開く。

**管理者権限は要らない。** 登録は XML 形式（`schtasks /Create /XML`）で行う。
`/SC ONLOGON` は全ユーザー向けのトリガーになるため非昇格では
「アクセスが拒否されました」で失敗するが、XML なら
`<LogonTrigger><UserId>` で自分のログオンだけに絞れるので通常権限で登録できる。

```bash
# まず必ず内容を確認する（何も書き込まない・何も実行しない）
node src/cli.js install-autostart --dry-run

# 問題なければ登録。作るタスクは claude-monitor ただ1つ
node src/cli.js install-autostart

# 登録内容の確認（読み取り専用）。トレイが動いているかもここに出る
node src/cli.js autostart-status
```

**登録する前に試したいなら `tray`。** ログオンタスクが起動するのと同じものを、
今すぐ・何も登録せずに起動する。止めるのは `tray-stop`。

```bash
node src/cli.js tray --dry-run     # 実行するコマンドを全部見せて、何もしない
node src/cli.js tray               # 起動して、応答するまで待って結果を出す
node src/cli.js tray --no-wait     # 待たずに戻る
node src/cli.js tray-stop          # トレイごと停止（サーバも一緒に落ちる）
```

`tray` はトレイホストのPIDとサーバのPIDを `%USERPROFILE%\.claude-monitor\tray.pid`
に書く。`tray-stop` はこれを読んで、まず**行儀よく終了を頼み**（トレイ側が自分で
サーバを止め、アイコンを消し、`tray.pid` を消す）、応じないときだけ
`taskkill /T /F` に落とす。

#### アイコンが見当たらないとき

**Windows 11 は新しい通知アイコンを既定で「^」（オーバーフロー）の中に隠す。**
これは失敗ではない。常に見えるようにするには
**設定 > 個人用設定 > タスクバー > 「その他のシステム トレイ アイコン」** で
`claude-monitor` をオンにする（または「^」を開いてタスクバーにドラッグする）。

トレイが要らないなら `--no-tray` で従来どおり node を直接起動するタスクになる。
アイコンは出ないし、落ちたサーバも復帰しない。

```bash
node src/cli.js install-autostart --no-tray --dry-run
```

登録しただけでは何も動かない。**次のログオンから**起動する。起動後は

- `%USERPROFILE%\.claude-monitor\url.txt` にトークン付きの起動URLが1行入る。
  これをブラウザで一度開いてブックマークする。トークンはファイルに保存されるので、
  再ログオンしても同じURLが使える。書かれるのは `--persist-token` の起動のときだけで
  （自動起動の launcher はこれを渡す）、素の `serve` はディスクに何も残さない。
- `%USERPROFILE%\.claude-monitor\serve.log` に起動の記録・終了理由・クラッシュのスタックが残る。
  隠しウィンドウにはコンソールが無いので、様子が判るのはこのファイルだけ。
  トレイホストも**同じファイル**に `[tray]` 付きで1行ずつ書く（状態遷移・再起動・停止）。
  **トークンはログには書かれない**（`?t=…` は `?<token redacted>` に伏せられる）。
  伏せる規則はトレイ側にも同じものが入っている。
  平文で入っているのは `token` と `url.txt` の2ファイルだけ。
- `%USERPROFILE%\.claude-monitor\tray.pid` にトレイホストとサーバのPIDが、
  **それぞれのプロセス名と開始時刻を添えて** JSON で入る。
  トレイが行儀よく終了すれば消える。**残っていても動いているとは限らない** ——
  `/F` で殺されたトレイは自分の後始末をできない。Windows は PID を使い回すので、
  番号だけを信じると他人のプロセスを「サーバ」と呼びかねない。だから
  `autostart-status` と `tray-stop` は**名前と開始時刻まで突き合わせてから**判断し、
  食い違えば `stale tray.pid (pid N reused by chrome)` のように書いて、
  **何も殺さない**。
- `%USERPROFILE%\.claude-monitor\autostart.json` に、launcher が指しているパスが記録される
  （`install-autostart` が書き、`uninstall-autostart` が消す）。
  **リポジトリを移動・改名すると自動起動は黙って何もしなくなる** ——
  wscript は待たずに投げるので失敗を報告できず、トレイホストは読み込まれないので
  ログにも何も書けず、タスクは「成功」と報告される。症状は「アイコンが出ない」だけで、
  これは Windows がオーバーフローに隠しているのと見分けが付かない。
  `autostart-status` の `launcher pts:` 行がこれを検出する唯一の経路である。

**`url.txt` の URL は資格情報そのもの**（`?t=` に64桁のトークンが入っている）。共有しない。
作り直すなら `node src/cli.js rotate-token`。置き換わるのは**トークンのファイルだけ**で、
走っているサーバはメモリに古いトークンを持ったままなので、**再起動するまでは
古いブックマークと古い Cookie の方が通り、新しいURLが 403 になる**。
再起動（自動起動なら次のログオン）で逆転し、そこから先は新しいURLだけが通る。

解除:

```bash
node src/cli.js uninstall-autostart --dry-run
node src/cli.js uninstall-autostart
```

消えるのは**タスクと `autostart.vbs` の2つだけ**で、`token` / `url.txt` / `serve.log` は残る。
**今動いているサーバは止まらない。** シャットダウン用のエンドポイントは設計上存在しない
（ダッシュボードは読み取り専用）。止め方は3つ:

```bash
node src/cli.js tray-stop         # トレイ常駐ならこれ。トレイもサーバも止まる
```

トレイのメニューから「終了」でも同じ。トレイを使っていない（`--no-tray`）場合だけ、
プロセスを直接落とすことになる:

```powershell
netstat -ano | findstr :47321     # LISTENING 行の末尾が PID
taskkill /PID <pid> /F
```

`--dry-run` が最後に必ず表示する制約。トレイの有無で内容が変わる。

- **落ちたサーバはトレイホストが再起動する**（5秒 → 15秒 → 60秒 とバックオフ）。
  10分間に5回落ちたら再起動をやめ、アイコンを赤にしてバルーンを出す。理由は `serve.log` に残る。
- **トレイホスト自身が死ぬと、アイコンもサーバも道連れになる。** 次のログオンまで戻らない。
  ONLOGON トリガーは「ログオンした」ときにしか発火しないからである。
- **同じポートで2つ目のトレイは起動しない**（名前付き Mutex）。2つ目は黙って終了し、
  1つ目の `tray.pid` にもアイコンにも触らない。ただし Mutex はログオンセッション単位なので、
  **別のユーザーでログオンするとそちらでもトレイは起動し、サーバがポートを取れずに
  そのセッションのアイコンだけが赤くなる**（1つ目は無傷）。
- **`--no-tray` のときは Task Scheduler は落ちたプロセスを再起動しない。** サーバが
  予期せぬ例外で終了（exit 1）したら、次のログオンまで落ちたまま。理由は `serve.log` に残る。
- **同じポートで2つ目を手動起動しても起動しない。**
  `port 47321 is already in use - another claude-monitor may be running.` と出て
  終了コード1で終わる。bind が先なので、負けた側は**トークンも `url.txt` も読み書きしない** ——
  動いている方のブックマークは壊れず、拒否はログに1行残るだけ。
  並行して使うなら `--port N` か `CLAUDE_MONITOR_PORT` で別ポートにする。

## 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code の設定ディレクトリ |
| `CLAUDE_MONITOR_DIR` | `~/.claude-monitor` | 本ツールの書き込み先。**相対パスを指定した場合はホームディレクトリ基準**で解決する（cwd 基準ではない）。サーバは起動した cwd、hook は Claude Code のプロジェクト cwd で動くので、cwd 基準にすると両者が別の場所を見てダッシュボードが空のままになるため |
| `CLAUDE_MONITOR_PORT` | `47321` | `serve` の待受ポート（`--port` が優先） |
| `CLAUDE_MONITOR_IT` | 未設定 | `1` で統合テスト（実データ + ccusage）を有効化 |
| `CLAUDE_MONITOR_TEST_DIR` | OSのtemp | テストが作る一時ディレクトリの親 |

## CLI

すべてのサブコマンドは `--json` で機械可読出力になる。

```
node src/cli.js <command> [options]
```

| コマンド | 説明 |
|---|---|
| `sessions [--utc]` | 稼働セッション一覧（`~/.claude/sessions` + PID生存 + hook由来の状態）。`START` / `END` 列は開始・終了時刻でローカル表示（`--utc` でUTC表示）。`--json` は各値の出どころを `times` に付ける |
| `list [--days N] [--utc]` | セッション索引。既定は直近30日（ファイルmtime基準）。更新日時はローカル（`--utc` でUTC表示） |
| `tree <sessionId\|prefix> [--utc]` | セッション→サブエージェントのツリー。時刻はローカル（`--utc` でUTC表示） |
| `usage <sessionId\|prefix>` | 1セッションのトークン使用量（エージェント別・モデル別） |
| `usage --daily [--since D] [--until D] [--compare-ccusage]` | 日付別集計と ccusage との突合 |
| `tools <sessionId\|prefix> [--limit N] [--errors] [--utc]` | ツール実行ログ。時刻はローカル（`--utc` でUTC表示） |
| `events [--date YYYY-MM-DD] [--limit N] [--state] [--utc]` | hooks イベントと畳み込み状態。時刻はローカル（`--utc` で従来のUTC表示） |
| `serve [--port N] [--open] [--persist-token] [--rotate-token] [--token-file P] [--log-file [P]] [--events-keep-days N]` | Live ダッシュボード（127.0.0.1 のみ）。`--persist-token` はトークンを `~/.claude-monitor/token` に保存してURLをブックマーク可能にする（`--rotate-token` と `--token-file` は暗黙に有効化する）。`--log-file` はパス省略で `~/.claude-monitor/serve.log`、指定が無ければログ無し。`url.txt` は永続トークンのときだけ書く。`--events-keep-days` は `~/.claude-monitor/events/<日付>.jsonl` の保持日数（既定 30、`0` で無期限） |
| `rotate-token [--token-file P] [--port N]` | 保存済みトークンを作り直して `url.txt` を書き直す。**再起動するまで**は古いURL・Cookie の方が通り、新しいURLが403（再起動後に逆転）。ポートは `--port` > `CLAUDE_MONITOR_PORT` > `url.txt` の記録（token ファイルが在るときだけ）> 既定 の順で、既定に落ちたときだけ警告する |
| `statusline` | statusline sidecar が捉えた rate_limits 等 |
| `stats <sessionId\|prefix>` | パーサ統計（type別件数・未知type・parse失敗） |
| `install-hooks [--dry-run] [--force-statusline]` / `uninstall-hooks [--dry-run]` | 設定の登録・解除。既存の `statusLine` が他人のものなら hooks だけ登録して触らない（`--force-statusline` で退避のうえ置換、`uninstall-hooks` が復元） |
| `install-autostart [--port N] [--no-tray] [--dry-run]` / `uninstall-autostart [--dry-run]` | ログオン時に隠しウィンドウで起動するタスク（`claude-monitor`）の登録・解除。既定でトレイホスト経由（アイコン＋監視付き）、`--no-tray` で従来どおり node を直接起動。Windows 専用 |
| `autostart-status [--show-url]` | 自動起動タスク・launcher・ログ・`url.txt`・**トレイ**の状態と、**launcher が指すパスがまだ実在するか**（読み取り専用）。起動URLは既定で `?t=<redacted>` に伏せる（貼り付けても資格情報が漏れないように）。`--show-url` で全文表示 |
| `tray [--port N] [--no-wait] [--dry-run]` | ログオンタスクと同じトレイホストを、何も登録せずに今すぐ起動する。`tray.pid` にPIDを書く。Windows 専用 |
| `tray-stop [--port N] [--dry-run]` | トレイホスト（とそれが見ているサーバ）を停止する。まず行儀よく頼み、駄目なら `taskkill /T /F`。生死は **プロセステーブル** で判定し、両方消えたときだけ `tray.pid` を消す。残っていれば残ったPIDを出して **終了コード1**（`--port` は `tray.pid` にポートが無いときの予備）。Windows 専用 |
| `paths` | 解決済みパス一覧 |

`<sessionId>` は先頭一致のprefixでよい（例: `11111111`）。曖昧な場合は候補を表示する。

### 使用例

```bash
# 直近7日のセッション
node src/cli.js list --days 7

# サブエージェントツリー
node src/cli.js tree 11111111

# 日付別使用量を ccusage と突合（当日分は進行中なので差が出るのが正常）
# 事前に npm i -g ccusage@20.0.20 が必要。無ければダウンロードせずに失敗する
node src/cli.js usage --daily --since 2026-08-14 --compare-ccusage

# エラーになったツール呼び出しだけ
node src/cli.js tools 11111111 --errors

# パーサが未知のレコードtypeに遭遇していないか確認
node src/cli.js stats 11111111
```

## テスト

```bash
npm test                                  # 単体テスト（合成fixtureのみ、実データ不要）

# 統合テスト（実データを読み、インストール済みの ccusage を npx で起動する）
CLAUDE_MONITOR_IT=1 node --test test/integration.test.js
```

Windows の PowerShell から統合テストを実行する場合:

```powershell
$env:CLAUDE_MONITOR_IT = "1"; node --test test/integration.test.js
```

## 注意

- `rate_limits` は Claude.ai Pro/Max（または spend limit 付き gateway）でのみ
  取得できる。APIキー利用では出ない。
- transcript jsonl の形式は公式に「内部形式・バージョン間で変わる」と
  明言されている。`stats` の「未知type」が増えたら形式変更を疑うこと。
- Claude Code は古い transcript を自動削除する（実測で30日より古い分が消えた）。
  過去の集計値は永続ではない。
- `~/.claude-monitor/events/` は既定30日で切られる（上記）。それより前の
  hook 履歴が必要なら `--events-keep-days` を伸ばすか、自分で退避すること。
- **サブエージェントの transcript は親より先に消える。** 実測で、hooks が31体を
  知っているセッションのディスク上に7体分しか残っていなかった。Tree ビューは
  そういうエージェントも hooks の証跡だけで描くが、親は特定できないので
  「親が特定できないエージェント」に入る。

## ライセンス

MIT License。詳細は [LICENSE](LICENSE) を参照。
