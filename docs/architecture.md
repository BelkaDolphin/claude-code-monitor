# claude-monitor アーキテクチャ (M1 コア + M2 サーバ/Live + M3 ツリービュー + 常駐化)

対象バージョン: Claude Code 2.1.258 / Node.js 20+ (検証は v24.13.0) / Windows 11。
外部npm依存ゼロ（Node標準モジュールのみ）。ESM。

---

## 1. データ源と優先順位

| 優先 | 源 | 得られるもの | 信頼性 |
|---|---|---|---|
| 1 | **hooks** (`<monitorDir>/events/*.jsonl`) | 稼働/待機、ツール実行の開始終了、サブエージェント起動終了、通知、セッション終了理由 | 公式仕様。イベント駆動で確実 |
| 2 | **`~/.claude/sessions/<pid>.json`** + PID生存 | プロセス単位の生死、`status`、cwd、バージョン | **公式ドキュメント未記載**。将来消えうる |
| 3 | **transcript jsonl** (`~/.claude/projects/**/*.jsonl`) | ツリー構造、ツールログ、トークン数 | 公式に「内部形式・非安定」と明言 |
| 補 | **statusline sidecar** (`<monitorDir>/statusline/*.json`) | `rate_limits`、context使用率、コスト | 他のどこにも存在しない唯一の源 |
| 補 | **ccusage** (`npx ccusage`) | 突合用の第三者集計 | 検証専用。実行時依存ではない |

ライブ状態は必ず hooks を第一とし、jsonl は「ディスクに書かれた後の事実」を補う位置づけ。

---

## 2. モジュール構成

```
src/
  paths.js              パス解決 (claudeHome / projectsDir / sessionsDir / monitorDir)
                        + readUtf8 / readJsonUtf8 / writeFileAtomic / localDateKey
  jsonl-tail.js         バイトオフセット差分tail (JsonlTail) と一括ストリーム (streamLines)
  parser.js             1行 -> NormalizedRecord の防御的正規化 + ParseStats
  session-index.js      projects/ 走査、セッション列挙、subagents列挙、prefix検索
  tree.js               セッション -> サブエージェントのツリー復元と状態推定
  usage.js              message.id dedupe (最新採用) によるトークン集計
  tools-log.js          tool_use / tool_result の突合とツール入力の要約
  sessions.js           sessions/<pid>.json 読み取り + PID生存 + PID再利用検知
  hooks-ingest.js       events/*.jsonl の読み取り・正規化・状態fold
  statusline-sidecar.js statusline sidecar の読み取りと rate_limits 抽出
  installer.js          settings.json への hooks / statusLine の冪等な追加・削除
  ccusage.js            ccusage CLI ラッパ (突合専用)
  cli.js                サブコマンド群

  --- M2 で追加 ---
  auth.js               トークン発行・Cookie・Host/Origin/Sec-Fetch-Site 検証
  state.js              状態モデル (純粋関数。hooks/sessions/statusline/jsonl を1つに)
  collector.js          4つの源の tail・ポーリング・デバウンス (EventEmitter)
  sse.js                SSE 配信ハブ (最大8接続、15秒ping)
  server.js             127.0.0.1 固定の HTTP サーバとルーティング

  --- M3 で追加 ---
  tree-merge.js         hooks / meta.json / transcript を1本のツリーに合成 (純粋関数)
  tree-view.js          ツリービューの I/O とキャッシュ
                        (TreeCache / SessionIndexCache / HookHistory)

  --- M4 で追加 ---
  usage-view.js         Usage ビューの I/O とキャッシュ
                        (UsageFileCache = ファイル毎の message マップ / UsageStore /
                         CcusageCache = 10分キャッシュ + single-flight)

  --- 常駐化で追加 ---
  token-store.js        再起動をまたぐトークン (<monitorDir>/token) と url.txt
  log-file.js           サイズ上限付きログ (LogFile) と stdout/stderr の tee
  autostart.js          .vbs launcher の生成と schtasks への ONLOGON タスク登録
hooks/
  monitor-hook.js       hook 側スクリプト (stdin -> events/<日付>.jsonl に1行append)
  statusline.js         statusLine 側スクリプト (sidecar保存 + 1行表示)
public/
  index.html            Live / Tree / Usage ビュー + 通知設定パネル (インラインscript/style なし)
  notify-rules.js       通知設定の正規化・移行と枠しきい値の判定 (純粋関数。classic script)
  app.js                DOM差分更新・SSE再接続・Web Notifications・ツリー描画・使用量描画
  style.css             トークン化した配色 (prefers-color-scheme で自動切替)
```

### データフロー

```
Claude Code
  |
  |-- hook 発火 --> hooks/monitor-hook.js --> <monitorDir>/events/<YYYY-MM-DD>.jsonl
  |                                                |
  |-- statusLine --> hooks/statusline.js --> <monitorDir>/statusline/<session_id>.json
  |                        |                       |
  |-- transcript 追記 --> ~/.claude/projects/**.jsonl
                                 |                 |
                                 v                 v
                    jsonl-tail --> parser --> usage / tree / tools-log
                                                   |
                    hooks-ingest ------------------+--> cli.js
                    statusline-sidecar ------------+
                    sessions.js -------------------+
```

書き込み先は **`%USERPROFILE%\.claude-monitor\`** のみ（`CLAUDE_MONITOR_DIR` で上書き可）。
`~/.claude` 配下は `install-hooks` が `settings.json` を更新する場合を除き読み取り専用。
M4 で `<monitorDir>/usage/daily.json` が加わった —— **GET リクエストが書く唯一のファイル**である（8.4）。

---

## 3. 主要な設計判断

### 3.1 usage の dedupe

`message.id` 単位で **timestamp が最新のレコードを採用**する。同一timestampなら
トークン合計が大きい方（＝ファイル後方の、より完成したスナップショット）。

Claude Code は1つのassistantメッセージについて、ストリーミング途中のusage
スナップショットと最終値の両方をjsonlに書く。「最初の1件」を採用すると
実測で output_tokens が 522,600 対 2,334,305（4.5倍の過小集計）になる。
`docs/m0-local-findings.md` 参照。dedupeは**ファイル横断**で行う
（親transcriptとsidechainコピーに同じmessage.idが現れるため）。

### 3.2 ストリーミング読み

最大35MBのtranscriptがあるため全読みしない。

- `streamLines()` — 1MiBチャンクで読み、Bufferのまま `0x0A` で分割し、
  **完全な行だけ** UTF-8デコードする。マルチバイト文字がチャンク境界で
  割れても壊れない。
- `JsonlTail` — ファイルごとにバイトオフセットを保持。未終端の末尾行は
  Bufferで保持して次回に結合。`size < offset` を検出したらオフセットを
  0にリセット（truncate / rotate 対応）。`save()/load()` でプロセスを
  跨いで永続化できる。

### 3.3 パーサの防御姿勢

公式ドキュメントは transcript 形式について
"The entry format is internal to Claude Code and changes between versions,
so scripts that parse these files directly can break on any release."
と明言している。したがって:

- `JSON.parse` 失敗は **行番号・ファイル名付きでカウント**し、最新数件の
  スニペットを保持。処理は継続する。
- 未知の `type` は `unknownTypes` に集計して可視化。落ちない。
- すべてのフィールドアクセスはoptional / デフォルト値付き。

`cli.js stats <sessionId>` で統計を確認できる。統合テストは
「未知typeが1件でも出たら失敗」させて形式変更を早期検知する。

### 3.4 ツリー復元と状態推定

親子関係は3段階で決める:

1. `meta.json` の `parentAgentId`（spawnDepth>=2 のみ存在、実測 12/12）が
   あればそれが正。
2. 無ければ、全transcript（親＋全subagent）の `tool_use` ブロックを id で
   索引し、`meta.json` の `toolUseId` と照合する。その `tool_use` を発行した
   transcript の持ち主が親。ネストも同じ仕組みで解決する。
3. どちらにも当たらなければ orphan として別掲。

**状態は推定であり、フィールド名にそれを反映している** (`statusInferred` /
`statusSource`):

| 値 | 条件 |
|---|---|
| `completed` | 同期起動の `tool_result` が `status:"completed"`、または hooks の `SubagentStop` を観測 |
| `running` | 起動元 `tool_use` に対応する `tool_result` が存在しない |
| `async-unknown` | `status:"async_launched"` で、hooks の完了証跡が無い |
| `error` | `tool_result.is_error` |

### 3.5 hook の同期/非同期

`monitor-hook.js` は全イベントで `async: true`（fire-and-forget）。
**ただし `SessionEnd` だけは同期**。公式仕様では SessionEnd hook は
1.5秒の共有予算を持ち、`async: true` は「完全にバックグラウンド実行」
となるためプロセス終了と競合してイベントを取り逃す危険がある。
本フックは実測 75ms（ほぼNode起動時間）で予算内に収まる。

`monitor-hook.js` は **stdout/stderr に一切出力せず、必ず exit 0** する。
hook の stdout は会話に注入されうるため、沈黙が唯一安全な出力。

---

## 4. M2: 常駐サーバと Live ビュー

### 4.1 データフロー

```
                      ~/.claude-monitor/events/<日付>.jsonl
                        |  fs.watch(dir) + 1秒ポーリング
                        |  JsonlTail のバイトオフセットで差分だけ読む
                        v
                      hooks-ingest.normalizeEvent
                        |
  ~/.claude/sessions/*.json ---- 2秒 ----+
    (PID生存。procStart突合は60秒に1回)   |
                                         |
  ~/.claude-monitor/statusline/*.json ---+---> state.js
    fs.watch + 2秒                       |     reduce / applySessions
                                         |     applyStatusline / applyTranscript
  ~/.claude/projects/**/*.jsonl ---------+       |
    稼働セッションのみ 2秒 差分tail              |  不変更新 + changed フラグ
    索引(session-index)は30秒                    v
                                          collector: 250ms デバウンス
                                                 |
                                        'change' |
                                                 v
                                        sse.broadcast('snapshot', ...)
                                                 |
                              GET /api/stream    v      GET /api/state
                                          ブラウザ (public/app.js)
                                                 |
                                        セッションIDをキーにDOM差分更新
                                        + Web Notifications
```

I/O 失敗は全て `collector.stats()` のカウンタに積み、処理は継続する。
`errorCount` はヘッダの「取込エラー」に出る。`fs.watch` は Windows で取りこぼす
ため**必ずポーリングと二重化**する（watch は遅延短縮、ポーリングが保証）。

### 4.2 認証とオリジン検証

脅威はネットワークではない（127.0.0.1 固定）。**同じブラウザで開いている他サイト**が
`http://127.0.0.1:47321/` に投げるクロスサイト要求と DNS リバインディングである。
ダッシュボードは cwd・セッション名・コスト・枠残量を出すので、これを塞ぐ。

| 段 | 検査 | 失敗時 |
|---|---|---|
| 1 | 起動時に `crypto.randomBytes(32)` のトークンを生成。初回だけ `http://127.0.0.1:<port>/?t=<token>` | - |
| 2 | クエリのトークンが一致 → `cm_token` Cookie（HttpOnly / SameSite=Strict / Path=/）を発行して `/` へ 302 | 403（本文は `forbidden` のみ。ヒントを出さない） |
| 3 | 以降は Cookie を `crypto.timingSafeEqual`（SHA-256 ダイジェスト同士）で比較 | 403 |
| 4 | `Host` が `127.0.0.1:<port>` か `localhost:<port>` | 403 |
| 5 | `Origin` があれば `http://<Host>` と完全一致 | 403 |
| 6 | `Sec-Fetch-Site` があれば `same-origin` か `none` | 403 |

**トークン交換（`/?t=`）にも 4〜6 を先に適用する。** Cookie が要らない唯一の
経路なので、そこだけがリバインドされたホストに自分用の Cookie を発行させられる。

**静的ファイル（`/`, `/app.js`, `/style.css`）にも 3〜6 を適用する。**
トークン無しに UI を配れば、そこに書いてある構造がそのまま漏れるため。

ダイジェストを比較するのは、`timingSafeEqual` が長さ不一致で例外を投げるのと、
長さがタイミングから漏れるのを同時に防ぐため。形式（64桁hex）が違う入力でも
比較を1回実行してからfalseを返す。

応答は必ず `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` /
`Referrer-Policy: no-referrer` / `X-Frame-Options: DENY` と、
`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
を付ける。CSP は「innerHTML を使わない・外部URLを参照しない」という手作業の規律の
**バックストップ**であって、代わりではない。

静的配信は3ファイルの許可リストのみ。パスは decode → `..` セグメントを含めば即 404 →
`path.posix.normalize` → 再度 `..` 検査 → 実パスが `public/` 配下かを確認、の4重。

### 4.3 状態機械

`phase` は hooks から導出する。`phaseSource` で根拠を明示する（M1 の `statusInferred` と同じ流儀）。

| イベント | 遷移 | 補足 |
|---|---|---|
| `SessionStart` | → `idle` | `endedReason` をクリア |
| `UserPromptSubmit` | → `busy` | |
| `PreToolUse`（agent_id 無し） | → `busy` | `currentTool = {name, toolUseId, since, agentId:null}` |
| `PreToolUse`（agent_id 有り） | phase が空なら → `busy` | その agent の `currentTool` と `tools` を更新。メインが空いている時だけセッションの `currentTool` にも出す |
| `SubagentStart` | phase が空なら → `busy` | サブエージェントが動いている＝そのセッションは動いている |
| `PostToolUse` / `PostToolUseFailure` | phase が空なら → `busy` | `toolUseId` が一致する `currentTool` を解除。失敗は agent の `errors` に加算 |
| `Notification` `permission_prompt` | → `waiting_permission` | |
| `Notification` `idle_prompt` / `agent_needs_input` | → `waiting_input` | |
| `Notification` その他 | 変化なし | 直近20件に記録 |
| `Stop` | → `idle` | `currentTool` 解除 |
| `PreCompact` | → `compacting` | 直前の phase を保存（連続 PreCompact で上書きしない） |
| `PostCompact` | → 保存した phase | 無ければ `busy` |
| `SessionEnd` | → `ended` | `reason` を保持 |
| 未知のイベント | 変化なし | `lastEventName` だけ更新。例外は投げない |

優先順位（`derivePhase`）:

1. `alive === false`（sessions.js が「このPIDは死んでいる」と言った）→ **`dead`**、`phaseSource: "pid"`
2. `hookPhase === "stale"`（4.5 のセッション掃引がそう推定した）→ **`stale`**、`phaseSource: "inferred"`
3. hook を1件でも見ていれば → その phase、`phaseSource: "hooks"`
4. hook が皆無なら sessions.js の `status` を写像 → `phaseSource: "sessions"`（UIは「推定」と表示）
5. それ以外 → `unknown`

`alive === null` は「`sessions/<pid>.json` が無い」であって死亡証拠ではない。
`dead` にはしない。逆に、一度 alive だったセッションが一覧から消えたら
`alive = false`（`aliveSource: "sessions-file-gone"`）にする。

#### 稼働（live）は「終わっていない」ではなく積極的な証拠で決める

`isLive(s)` が唯一の判定で、ヘッダの `counts.live` / `counts.busy` /
`counts.waiting`、Live のカード並び、`/api/sessions` の `live` 列、
`/api/tree` の `root.live` が全部ここを見る。

| 証拠 | 意味 |
|---|---|
| `alive === true` | 実際に生きている PID を確認した |
| `phaseSource === "hooks"` | hook 由来の phase がある（ただし `ended` / `stale` を除く） |
| `phaseSource === "sessions"` | `sessions/<pid>.json` が `status` を書いていた |

**証拠が1つも無ければ稼働ではない。** 「`ended` でも `dead` でもない」を
稼働と読むと、こちらが作っただけの空レコードが全部稼働になる。
`<monitorDir>/statusline/` は一度も掃除されないので `applyStatusline` は
ファイルの数だけセッションを作る（実測: 稼働1本に対しファイル5個）。
それらは hook も PID も無く `phase: "unknown"` / `phaseSource: "none"`
——「このセッションのことは何も聞いたことがない」という状態で、
ヘッダに「5 稼働」と出していた（詳細は
[docs/live-count-fix.md](live-count-fix.md)）。

`unknown` という phase 自体は残す（UIは「不明」と出せる）。
稼働かどうかと、何と表示するかは別の問いである。

`isLive` は**内部レコードと `toPublicSession` のワイヤ形状の両方**を受ける。
tree-view / tree-merge は後者しか見ないので、同じ関数で答えられないと
一覧とヘッダが食い違う。

常駐前提なので上限を置いてある。**実行中・稼働中は絶対に捨てない**:

| 対象 | 上限 | 捨てる順 |
|---|---|---|
| セッションごとの通知 | 20件 | 古い順 |
| セッションごとの完了サブエージェント | 30件（`MAX_COMPLETED_AGENTS`） | `endedAt` の古い順 |
| 終了・停止したセッション | 50件（`MAX_ARCHIVED_SESSIONS`） | `lastEventAt` の古い順 |

ファイル単位の記録（`JsonlTail` のバイトオフセット、`indexBySession`、
`UsageCollector`）もセッションと一緒に解放する。加えて `pollIndex` は、
前回の索引に有って今回無いファイル（＝Claude Code の30日自動削除）の
オフセットも捨てる。

セッションの掃除（`collector.prune()`）は**デバウンスされた emit の直前**で走る。
ポーラごとに書かないのは、セッションが終了扱いになる経路が hooks だけではないため。
`sessions/<pid>.json` が消えた（＝`SessionEnd` を出さずに死んだ）ケースは
`pollSessions` からしか判らず、その状況では hooks が1件も飛ばない。

### 4.4 SSE

状態が小さいので差分ではなく毎回 `event: snapshot` で全量を送る。
パッチプロトコルの取り違えが起きず、1通落としても次で自己修復する。
接続時にも即 `snapshot` を1通送る。15秒ごとに `: ping` コメント行。
同時接続は最大8で、超過は 503（`sse.add` はヘッダを書く前に判定する）。
クライアント側は EventSource の自動再接続に加えて、`readyState === CLOSED`（503等）を
検知したら指数バックオフ（1s → 30s上限）で自前に張り直す。

### 4.5 閉じるイベントが来ないものの扱い

hooks は「始まり」を落とすより「終わり」を落とす。実測で
`SubagentStop` の無いエージェントが1時間以上 `running` のまま残った
（`a458ad0670a1f500e`: `PreToolUse` と `PostToolUse` が1件ずつだけで、
`SubagentStart` も `SubagentStop` も `meta.json` も無い）。
そこで `state.sweepStale()` が時間で後始末する。

| 規則 | 既定 | すること |
|---|---|---|
| `PreToolUse` の後 `PostToolUse` が来ない | 15分 | `currentTool` を解除、`toolTimeouts` に加算 |
| エージェントが無音＋実行中ツール無し | 10分 | `status: "stale"` / `statusSource: "inferred"` |
| `subagents/agent-<id>.jsonl` の mtime が新しい | 10分以内 | **生存の証拠**として stale 化を打ち消す |
| 後から `SubagentStop` | - | `stale` → `completed` |
| 後から任意の hook イベント（そのエージェント宛） | - | `stale` → `running` |
| セッションが `ended` / `dead` | 即時 | 配下を `stale` |
| **セッション**が hook 無音（`busy` / `waiting_*` / `compacting` のとき） | 30分（`SESSION_STALE_MS`） | `hookPhase: "stale"` / `staleAt` / `staleReason`。`phaseSource` は `inferred` |
| セッションの transcript の mtime が新しい | 30分以内 | **生存の証拠**として stale 化を打ち消す |
| `alive === true` | - | **絶対に掃かない**（PID がそこにいると言っている） |
| 後から任意の hook イベント（そのセッション宛） | - | `stale` → 掃引前の phase（`touchSession`） |

**15分の閾値は実データで誤検知する** ——同じエージェントが1つのツールを
17分12秒走らせて正常終了した実例がある。だから、この掃引がするのは
「表示を下ろす」ことだけで、どれも**後続イベントで元に戻る**。

セッション掃引が要るのは、終わりを落とすのが hooks だけではないからである。
Claude Code が落ちる・端末が閉じる・マシンが再起動すると `SessionEnd` は
永久に来ない。実測: `ea1b82f5` の最後のイベントは 2026-09-02T23:59:50 の
`PostToolUse` で、そのまま4日間 `busy` のままだった。

三つ**同時に**成り立つときだけ倒す——hook が30分無音、`alive !== true`、
セッション自身の transcript も伸びていない。動いているセッションを
「停止推定」にするのが一番高くつく誤りなので、条件は重ねてある。
30分は `AGENT_STALE_MS` の3倍で、これは1本のツールが17分12秒走った実測が
あること、そしてエージェントと違ってセッションには `SubagentStop` に
相当する代替の終端イベントが無いことによる。

`idle` は掃かない。`idle` は「今作業している」という主張ではないので、
放置されていても嘘にならない。

`stale` は UI では「停止推定」。`ended`（本当に終わった）とも
`dead`（PIDが無い）とも別の語にしてある——これは推定であって事実ではない。

`toolTimeouts` / `agentsStale` / `sessionsStale` は `stats()` に出すが
`errorCount` には足さない。取り込みの失敗ではなく、こちらの推定だからである。

掃引は `SWEEP_POLL_MS`（30秒）ごとと `start()` で1回走る。時刻は
`collector.nowMs()`（注入された `now`）を使う——壁時計を直に読むと、
偽クロックで駆動されたコレクタが「4日前のイベント」を見て即座に
stale にしてしまう。

推定は推定として表示する（UI は `✓` ではなく `?` と「終了と推定」）。
M1 の `statusInferred` / `statusSource` と同じ流儀。

### 4.6 表示に使う名前と値の出どころ

| 表示 | 優先順位 |
|---|---|
| セッションのタイトル | (1) transcript の `ai-title`、ただし**プレースホルダは拒否**、(2) cwd 末尾 |
| 最新プロンプト | `UserPromptSubmit` の `prompt`。**タイトルには絶対に使わない** |
| エージェント名 | (1) `meta.json` の `description（agentType）`、(2) `agentType`、(3) 短縮 ID |
| エージェントのモデル | (1) `meta.json` の `model`（`"opus"` 等）、(2) 子 jsonl の最新 `assistant` の `message.model`、(3) 非表示 |

タイトルのプレースホルダ拒否は実測に基づく。Claude Code は ai-title を
最新プロンプトから再生成するので、画像だけを送るとタイトルが
`Image #1` に化ける。`isUsefulTitle()` がそれを弾き、**null で上書きせず
値ごと捨てる**ので直前の良いタイトルが残る。

モデル名の短縮は**テーブル駆動**で、末尾のリリース日付だけ剥がしてから引く。
引けなければ ID をそのまま出す（勝手に整形しない）。

### 4.7 落ちない、が最優先

常駐する監視ツールが**黙って死ぬのが最悪の故障**である。古いタブを見て
「異常なし」と思い続けてしまうから。防御は3層:

| 層 | 仕組み | 場所 |
|---|---|---|
| ポーラ | `safeTick(where, fn)` が同期 throw と Promise reject を捕らえ、`tickErrors` に積む。`setInterval` の中の例外には catch 先が無い | `collector.js` |
| HTTP | listener の恒久 `'error'` ハンドラ（EMFILE 等）、リクエスト/レスポンスごとの `'error'`（タブを閉じただけで落ちない） | `server.js` |
| プロセス | `uncaughtException` / `unhandledRejection` → 理由を stderr → `recordError` → close → **exit 1** | `installCrashHandlers` |

最後の層は握り潰して続行しない。uncaught の先はプロセス状態が不明で、
不明な状態から報告する監視こそが防ぎたい失敗そのものだから。
終了コードを1にすることで、supervisor 側で再起動できる。

ソケットの ECONNRESET / EPIPE は日常なので記録だけして、
UI の「取込エラー」には数えない（データが壊れている、という意味ではない）。

### 4.8 フロントエンドの制約

- `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `eval` /
  `new Function` / インラインイベントハンドラ属性を**使わない**。
  DOM は `createElement` + `textContent` + `classList` + `dataset` のみ。
  `test/server.test.js` が配信されたファイルを正規表現で検査して回帰を防ぐ。
- 外部URLを一切参照しない（Webフォントも含む）。書体はシステムスタックのみ。
- DOM はセッションIDをキーにノードを保持して差分更新する。全消し全作り直しをすると
  スクロール位置・テキスト選択・`<details>` の開閉が毎秒飛ぶ。
- 時刻は全てブラウザのローカル時刻で表示する（ディスク上は UTC ISO）。
- 配色は CSS カスタムプロパティでトークン化し、`prefers-color-scheme` で切替。
  **色は「人間の対応が要る」時だけ飽和色（アンバー）にする。** 実行中・待機・終了は
  無彩色〜低彩度に寄せ、視界の端で「呼ばれているか」だけが判る状態を作る。

## 5. 既知の制約

1. **transcript jsonl は非安定API。** 公式が明言している。パーサは防御的だが、
   フィールド名の変更で意味的に壊れる可能性は残る。統合テストで検知する。
2. **`~/.claude/sessions/` は公式未記載。** `status` / `procStart` / `pidDomain`
   などのフィールドはすべて実測ベース。将来の版で消えても動作が壊れない
   ように、欠損時は素通しする実装にしてある。
3. **`status` はハートビートではない。** 状態遷移時にのみ書かれる。実測で
   `busy` のまま7.5分以上mtimeが変わらなかった。mtimeが古い＝死んでいる、
   という判定をしてはならない。生死は `process.kill(pid, 0)` で見る。
4. **`rate_limits` はサブスクリプション限定。** Claude.ai Pro/Max、または
   spend limit 付きの Claude apps gateway 経由でのみ現れ、かつセッション
   最初のAPI応答より後にしか出ない。APIキー利用では永遠に出ない。
   `statusline` サブコマンドは理由付きで「取得不可」を報告する。
5. **statusLine はイベント駆動＋300msデバウンス。** ポーリングではないので、
   親セッションがアイドルの間は sidecar が更新されない。
6. **PID再利用。** `procStart`（Windows FILETIME）と実プロセスの StartTime を
   突き合わせて検知するが best-effort。PowerShell 呼び出しが失敗した場合は
   `kill(0)` の結果をそのまま返す。
7. **transcript は Claude Code 自身に削除される。** 実測で作業中に
   `~/.claude/.last-cleanup` が更新され、171ファイル→146ファイル、
   30日より古い日付のデータが消えた。過去分の集計は永続ではない。
   長期保存が必要なら独自にスナップショットを取る必要がある。
8. **ccusage は突合専用。** `npx -y ccusage@latest` を spawn するため
   ネットワークとダウンロードが要る。ダッシュボードの実行時依存にはしない。

### M2 で新たに判明した制約

9. **`SubagentStart` は `SubagentStop` より圧倒的に少ない。** 実測（2026-09-02、
   実データ 203イベント）で `SubagentStop` 29件に対し `SubagentStart` は **1件**。
   さらに `SubagentStop` の `agent_type` は**空文字列 `""`**で届く（公式ドキュメントは
   フィールドの存在だけを述べていて、値については述べていない）。
   結果、多くのサブエージェントは「終了した事実」しか判らず、`agentType` と
   `startedAt` が null のまま残る。`state.js` は
   `PreToolUse`（agent_id 付き）の初回でも `startedAt` を補うが、それも無ければ
   経過時間は出せない。**サブエージェントの種類と開始時刻を確実に取るには
   transcript の `meta.json`（M1 の `session-index.listSubagents`）が要る** ——
   M3 のツリービューではそちらを併用すること。
10. **稼働セッションの transcript は初回に全読みする。** `message.id` 単位の
    dedupe（3.1）は「最後に現れた行が正」なので、途中から読み始めると
    集計が壊れる。35MB のファイルなら初回だけ 1〜2 秒かかる。
    2回目以降はバイトオフセット差分なので stat 1回で済む。
11. **PID再利用の検査は60秒に1回。** `sessions.js` の突合は PowerShell を
    spawn するため、2秒ごとの一覧取得では `checkProcStart:false` で回している。
    「死んだ直後の1分間だけ生きて見える」可能性が理論上残る。
12. **CSS の値を JS から書くのは CSSOM 経由（`el.style.setProperty`）に限る。**
    `style-src 'self'` は `style=` 属性の**マークアップ上の記述**を禁じるが、
    CSSOM での設定は CSP の対象外。`setAttribute('style', ...)` は使わない。

### M3 で新たに判明した制約

13. **サブエージェントの transcript は親より先に消える。** 実測（2026-09-03）で、
    セッション `ea1b82f5` の hooks は31体のエージェントを知っているのに
    `subagents/` には7体分しか無い。差の30体は全て `SubagentStop` を出しており、
    そのイベントの `agent_transcript_path` が指すファイルが projects 配下の
    どこにも存在しない。既知の制約7（30日で消える）とは別で、数時間で消えている。
    条件は未特定。**「hooks は知っているが transcript が無いエージェント」は
    例外ではなく普通にある**、という前提で組むこと（6.3 の `origin: "hooks"`）。
14. **`meta.json` は時刻を一切持たない。** 実測82ファイルの全キーは
    `agentType` / `description` / `toolUseId` / `spawnDepth`（全件）と
    `model`(67) / `worktreePath`(15) / `worktreeBranch`(15) / `parentAgentId`(13) /
    `spawnedWithWorktree`(8) だけ。開始・終了時刻は hooks か transcript からしか取れない。
15. **ツリーのパースは同期でイベントループを止める。** 最大の実データ
    （34.2 MB / 18ファイル）で 248 ms。SSE の ping（15秒）にもブラウザの fetch にも
    十分収まるので worker_threads は入れていない。**この前提はファイルが1桁大きく
    なったら崩れる。**

### 常駐化 で新たに判明した制約

以下はコードを読んで確定させたか、`install-autostart --dry-run` を実行して観測したものだけ。
実登録（`schtasks /Create`）はまだ一度もしていない（`docs/autostart-verification.md`）。

16. **落ちても自動では復帰しない。** Task Scheduler の ONLOGON トリガーは「ログオンした」
    ときにしか発火しない。4.7 の設計で uncaught は exit 1 で終わるので、そこから
    **次のログオンまで落ちたまま**になる。だから隠し起動は必ずログを書く。
17. **タスクはユーザー単位・Windows 専用。** `install-autostart` を実行したアカウントの
    ログオンでしか起動しない。`installAutostart` は `--dry-run` 以外では win32 でなければ
    例外を投げる（dry-run はプラットフォーム判定より前に返るので、どこでも中身は読める）。
18. **ポート衝突で負けた側はディスクを変えない（ログを除く）。** `cmdServe` は
    bind を先にやり、成功してからトークンを読む・rotate する・`url.txt` を書く。
    `EADDRINUSE` なら `fail()` → exit 1 で、トークンも `url.txt` も触られない。
    **例外はログファイルだけ**で、`--log-file` を渡していれば拒否の1行のために作られる
    （それが目的である）。動いているインスタンスのブックマークは壊れない。
19. **`rotate-token` は走っているサーバに効かない。** `Auth` はトークンをメモリに持ち、
    Cookie の値はそのトークンそのもの（`safeEqual` の SHA-256 は長さを揃えるためで、
    HMAC でも導出でもない）。したがって rotate 直後は**古いブックマークと古い Cookie が通り、
    新しいURLの方が 403 になる**。再起動（自動起動なら次のログオン）で逆転する。
20. **`url.txt` は永続トークンのときしか書かれない。** プロセス毎トークンの `serve` は
    `token: per-process (nothing stored; the URL dies with this process)` と出して
    ディスクに何も残さない。`rotate-token` が `url.txt` のポートを信用するのも
    token ファイルが隣に在るときだけで、単独の `url.txt` は残骸として無視する。
21. **`serve.log` にトークンは入らないが、`token` と `url.txt` には入る。**
    ログは `redactSecrets()` で `?t=<64桁hex>` と `cm_token=<64桁hex>` を伏せてから書く。
    伏せていないのは `<monitorDir>/token` と `<monitorDir>/url.txt` の2ファイルで、
    ここは伏せては用を成さない。リクエストログは存在しない
    （`server.js` / `collector.js` / `auth.js` / `sse.js` は一切印字しない）ので、
    アクセスしたパスや cwd がログに出ることもない。
    スクラブはパターンマッチである以上、将来 URL 以外の形でトークンを印字する経路を
    足したら、`log-file.js` の `TOKEN_PATTERNS` も一緒に増やす必要がある。
22. **止める手段はプロセス終了だけ。** シャットダウン用のエンドポイントは設計上作っていない
    （ダッシュボードは読み取り専用）。`uninstall-autostart` はタスクと `.vbs` を消すだけで、
    今動いているサーバは止めない。

### M4 で新たに判明した制約

23. **モデル名の表が実データに追いついていなかった。** 2026-09-06 に実 transcript を
    数えたところ、M3 の `MODEL_LABEL` に無い ID が2つ出た ——
    `claude-fable-5-1`（25.7M トークン / 216 メッセージ）と
    `claude-opus-4-7`（2.1M / 43）。表駆動である以上、**新しいモデルが出るたびに
    2つの表（`src/usage-view.js` の `MODEL_SERIES` と `public/app.js` の
    `MODEL_LABEL`）を足す必要がある**。足し忘れは Usage では「other」、
    ツリーでは ID の素通しになる（どちらも嘘は言わないが、見づらい）。
    なお `<synthetic>` という model 値も実在する（7メッセージ・0トークン）。
    これはモデルではないので `other` のままが正しい。
24. **ダッシュボードで唯一 GET が書くファイルができた。** `<monitorDir>/usage/daily.json`。
    `~/.claude` を読み取り専用にする方針は変えていないが、「GET は何も書かない」は
    もう真ではない。書き込みはアトミック（tmp + rename）で、失敗しても
    `onError` に積むだけでビューは答える。
25. **「ダッシュボードは読み取り専用」だが保存値は消せない。** 保存ストアを消す
    エンドポイントも CLI も無い。誤った値が入った場合は
    `<monitorDir>/usage/daily.json` を手で消す（次のリクエストで作り直される。
    ただし transcript が既に消えている日付は二度と戻らない）。
26. **mtime による読み飛ばし（8.3）は「追記しかされない」前提に依存する。**
    transcript が後から書き換えられる（既存行の修正、ファイル全体の再生成）と、
    窓の外に見えるファイルの中身が窓の中に入り得る。実測では追記のみだが、
    jsonl は非安定APIなので前提が変わり得る（既知の制約1）。
27. **`?days=N` の窓の意味がルートごとに違う。** `/api/sessions` は
    「いまから N×24h」（mtime カットオフ）、`/api/usage` は
    「今日を含む N 暦日」。同じ `days=30` でも境界が一致しない。
28. **保存ストアは「書き手は1つ」を前提にしている（排他は無い）。**
    `<monitorDir>/usage/daily.json` にロックもロックファイルも無い。同じ
    monitorDir を見る `serve` が2本同時に走ると、書き込みが交差し得る。
    8.4 のとおり**書く直前に読み直して同じ規則でマージし直す**ので、
    競合窓は rename そのものだけに縮み、そこで落ちた更新も**次のビルドで自動的に
    復元される**（マージが単調で、値が後戻りしないため）。したがって実害は
    「一時的に片方の日付が古い値のまま」に留まるが、**厳密な排他ではない**。
    常時2本以上を回す構成は想定していない（トレイ常駐は1本、7.5）。
29. **`npx` の孫プロセスはシグナルで死なない。** Windows では
    `cmd.exe` → `npx.cmd` → `node.exe` の3段になるため、`child.kill()` は
    先頭にしか届かず、ccusage の node が残り続ける（実測で確認）。
    `taskkill /T /F` で木ごと殺している（8.5）。`spawn` する外部コマンドを
    増やすときは同じ問題を毎回考える必要がある。

### 通知設定 で新たに判明した制約

30. **通知設定はブラウザごと・プロファイルごとにしか存在しない。**
    `localStorage` の `cm.notify.settings` にしか無いので、別のPC・別のブラウザ・
    シークレットウィンドウでは既定値に戻る。サーバは自分がどう通知されているかを
    一切知らないため、**「通知したはずなのに来ない」をサーバ側のログから追えない**。
31. **`localStorage` が使えない環境では設定が保持されない。** アクセスは全て
    try/catch で包んであるので落ちはしないが、シークレットモードやサイトデータを
    禁止した設定では毎回既定値（通知 OFF）から始まる。
32. **しきい値通知は `rate_limits` が出ている間しか動かない。** 既知の制約4/5の
    とおり `rate_limits` はサブスクリプション限定で、かつ statusline サイドカーが
    更新されないと消える。**消えた窓は「読めなかった」として武装状態を保つ**ので
    再接続で鳴り直すことは無いが、逆に**枠が減っていく途中で sidecar が止まると
    しきい値を超えたことに気づけない**。ダッシュボードが枠を能動的に取りに行く
    手段は無い（既知の制約4）。
33. **`public/` に ES module ではない JS が1本増えた。** `public/notify-rules.js` は
    classic script（`window.CMNotifyRules`）で、`package.json` の `type: module` の
    下では `import` できない。テストは `fs.readFileSync` + `node:vm` の
    `runInThisContext` で読み込む（sandbox realm だと `deepStrictEqual` が
    プロトタイプ違いで落ちるため、**同一 realm で評価する**）。
    `public/` を増やすときは `src/server.js` の `STATIC_FILES` にも足す必要がある
    （固定リスト配信。ディレクトリを丸ごと配ってはいない）。
34. **テスト通知は「実際に通知が出るか」を保証しない。** OS 側の集中モード /
    サイレント時間 / 通知センターの設定はブラウザから見えない。テスト通知が
    「出た」ように見えて画面に何も出ないことはあり得る。

---

## 6. M3: ツリービュー

### 6.1 データフロー

Live（4.1）が「いま起きていること」を hooks から押し出すのに対し、ツリーは
**要求されたセッション1本を、その場で3源から組み立てる**。押し出しではなく引き。

```
  GET /api/tree/<sessionId>
        |
        +--> SessionIndexCache (TTL 2秒)  buildSessionIndex({days:0, withCwd:true})
        |       |  実測 91ms / 70セッション。days:0 なので古いセッションもIDで引ける
        |       v
        |     SessionEntry { jsonlPath, cwd, subagents[{agentId, size, mtimeMs, meta...}] }
        |        |
        |        +--> TreeCache (LRU 8, fingerprint = 全jsonlの size+mtime + meta数)
        |        |       ミス時のみ buildTree()  実測 248ms / 34.2MB / 18ファイル
        |        |       ヒット時 2ms
        |        |          |
        |        |          +--> tree {root, nodes, orphans}
        |        |          +--> spawns    起動 tool_use の {時刻, prompt}
        |        |          +--> lastToolAt agentId -> 最後の tool_use 時刻
        |        v
        +--> collector.snapshot() にそのセッションがあればそれ
        |    無ければ HookHistory (TTL 2秒, HooksIngest の差分読み + reduceAll + sweepStale)
        |        |
        |        v
        |     hookSession { phase, agents[{status, statusSource, currentTool, ...}] }
        v
     mergeTree()  ← 純粋。毎リクエスト必ず走る（キャッシュしない）
        |
        v
     {root, orphans, agentCount, hooksOnly, parse}
```

**マージ結果はキャッシュしない。** キャッシュしているのは「ディスクを読んだ結果」だけで、
hooks 由来の半分（実行中／完了、`currentTool`）は毎秒変わる。ファイルの mtime を
キーにしたキャッシュに載せると、実行中のエージェントが固まって見える。

`buildTree` が返す `toolUseIndex` は全 `tool_use` の `input` を保持していて大きい。
キャッシュに入れる前に必要な2つ（`spawns` / `lastToolAt`）だけ抜いて捨てる。

### 6.2 マージの優先順位

`src/tree-merge.js`。各フィールドは `*Source` を併せて返し、UI が
「← meta.json」「← hooks」の形でそのまま出す。M1 の `statusInferred` /
`statusSource` と同じ流儀で、**推定は推定として表示する**。

| フィールド | 優先順位 | 根拠 |
|---|---|---|
| `status` | (1) hooks の証跡、(2) `tool_result` に裏付けられた transcript の判定、(3) `sweepStale` の `stale`、(4) transcript の推定 | 下記 |
| `agentType` | meta.json > hooks（**空文字は無視**） | `SubagentStop` は `agent_type: ""` を送る（5-9） |
| `description` | meta.json > hooks | 人間が書いた説明は meta.json にしか無い |
| `model` | meta.json > hooks > 子jsonl の `message.model` | meta.model は67/82にしか無い。**表示は必ず「系列名」に正規化する**（下記） |
| `startedAt` | hooks > 子jsonl の最初のレコード > 起動した `tool_use` の時刻 | **meta.json は時刻を持たない**（5-14） |
| `endedAt` | hooks（`SubagentStop`）> 子jsonl の最後のレコード（終了扱いのときだけ） | 実行中に「最後の行」を終了時刻にしてはいけない |
| `toolCount` | 子jsonl の `tool_use` 数 > hooks の計数 | transcript が無ければ hooks しか無い |

`status` の4段の理由:

1. **hooks の証跡**は事実。`SubagentStop` を見たなら終わっている。
2. **`jsonl:tool-result-*`** も事実。同期起動の `tool_result` が `status:"completed"`
   と書いてあるなら終わっている。**ここが計画からの変更点** —— これを (3) より下に
   置くと、終了済みセッションの配下が `session-over` で一律「終了と推定」になり、
   transcript が事実を持っているものまで推定に落ちる。
3. **`stale`** はこちらの時間ベースの推定（4.5）。transcript の「判らない」には勝つ。
4. **transcript の推定**。`async_launched` と `no-tool-result` はどちらも
   「判らない」の別名なので最下位。

最終値は `running | completed | stale | error | async-unknown` のいずれか。
表示に使うマーク（`▶` / `✓` / `?` / `✗` / `~`）と日本語名は Live と**同じ1つのテーブル**
（`AGENT_MARK` / `AGENT_STATUS_LABEL`）から引く。マークには必ず `title` を付ける ——
`?`（終了と推定）も `~`（完了不明）も「こちらの推測」を意味するので、
記号だけでは説明になっていない。

#### 開始/終了時刻の出どころ

上の表はエージェント単位。**セッション単位**の開始/終了はさらに別の源から解決し、
一覧（`/api/sessions`）・ツリーのルート・CLI の `sessions` / `tree` が同じ順序を使う。
値には必ず `startedAtSource` / `endedAtSource` が付く。

| フィールド | 優先順位 | 根拠 |
|---|---|---|
| `startedAt` | `hooks`（`SessionStart`）> `sessions`（`sessions/<pid>.json` の `startedAt`）> `transcript`（先頭窓の**最小**時刻） | transcript は最初の書き込みまで開かれないので必ず遅れる |
| `endedAt` | `hooks`（`SessionEnd`）> `transcript`（末尾窓の**最大**時刻）> `mtime`（ファイル更新時刻） | mtime は「最後に**書いた**時刻」であって「最後のレコードの時刻」ではない。最後の手段 |

transcript のレコードは**時刻順に並んでいない**（実測 e2a7ec22: 5行目が .266Z、
6・7行目が .265Z）ので「最初/最後の時刻付きレコード」ではなく窓内の最小/最大を採り、
それでも先頭窓と末尾窓は別の窓であり再開の `SessionStart` は transcript の末尾より
後になり得るため、最後に「終了が開始より前なら開始に丸める（源はそのまま、所要は 0）」
という歯止めを置く（`tree-view.clampSpan`）。

3つの規則:

1. **開始時刻は先に名乗った源が勝つ**。`SessionStart` は再開でも飛ぶので、
   後から上書きすると数時間前に始まったセッションの開始が「今」になる。
   `state.js` の `SessionStart` と `applySessions` の両方がこれを守る。
2. **稼働中のセッションに終了時刻は無い**（`endedAt` は `null`）。最後のレコードも
   mtime も「終わった」とは言っていない。UI はそこに 稼働中 と出す。
3. **終了時刻は取り下げられる**。`SessionEnd` の後に `UserPromptSubmit` や
   `SessionStart` が来たら再開なので `endedAt` を捨てる。

transcript の最後の時刻は `session-index.readLastTimestamp` が**末尾 64KB だけ**を
読み、逆向きに走査して最初に見つかった時刻を返す。35MB の transcript を
一覧の描画のたびに全部読むわけにはいかないから。`type:'ai-title'` は時刻を持たず
末尾に来ることが多いので読み飛ばす。窓の中に時刻付きレコードが1件も無ければ
`null` を返し、**窓は広げない**（境界があることがこの読みを安全にしている）。
キャッシュキーは `(size, mtimeMs)` なので、伸びていない transcript は読み直さない。

#### モデル名の表示は系列名に揃える

同じエージェントでも、meta.json が勝てば `"opus"`、transcript が勝てば
`"claude-opus-5"` が来る。これをそのまま短縮すると1本のツリーに **"Opus" と
"Opus 5" が並び、別のモデルに見える**。そこで `MODEL_LABEL` は**両方の形を
系列名（Opus / Sonnet / Haiku / Fable）に写す**テーブルにしてある。

逆向き（`"opus"` → `"Opus 5"`）は採らない。**エイリアスはどの版に解決したかを
記録していない**ので、版を補うのは捏造になる（古い meta.json の `"opus"` が
当時の別の版を指していた可能性がある）。テーブルに無いIDは 4.6 の規則どおり
そのまま出す（勝手に整形しない）。

### 6.3 hooks にしか存在しないエージェント

`subagents/` にファイルが無く meta.json も無いのに hooks は知っている、という
エージェントが**普通にある**（5-13）。実測でセッション `ea1b82f5` は hooks が31体、
ディスクに7体。`a458ad0670a1f500e`（4.5）も同じ形。

`mergeTree` はこれらにもノードを作り、`origin: "hooks"` を立てる。
起動した `tool_use` が transcript のどこにも無い以上**親を主張できない**ので、
`orphans` に入れる。UI は既定で閉じた `<details>` に分ける ——
30体をツリー本体に混ぜると本当の親子関係が読めなくなるため。

### 6.4 エンドポイント

| ルート | 内容 |
|---|---|
| `GET /api/sessions?days=N` | セッション一覧。`days` 既定30・1〜90にクランプ。**稼働中は期間で消さない**。稼働 → 更新日時降順 |
| `GET /api/tree/<sessionId>` | マージ済みツリー1本 |
| `GET /api/tools/<sessionId>?agent=<agentId>&limit=N` | ツールログ末尾。`limit` 既定100・1〜500。`agent=main` は親スレッドのみ |

- **ID は実測に基づく厳格な正規表現**で検証する。セッションは UUID（70/70）、
  エージェントは小文字hex ちょうど17桁（82/82）。
- **不正な形式のIDも未知のIDも同じ 404 JSON** を返す。400 と 404 を書き分けると
  「その形は正しいID形式だ」と教えることになる。`..` を含むパスはそれより手前の
  `routeKey()`（4.2）が既存どおり弾く。
- 認証・Origin・Host・`Sec-Fetch-Site` は既存ルートと同じ。GET/HEAD 以外は 405。
- 例外は `guard()` が捕らえて 500 JSON にし、`collector.recordError` に積む。
  **プロセスは生き続ける**（4.7）。

### 6.5 フロントエンド

4.8 の制約はそのまま（`textContent` のみ、外部URLなし、時刻はローカル）。加えて:

- ツリーは `<ul>/<li>` のネスト、開閉は `<button aria-expanded>`。**既定は深さ2まで展開**。
- **構造のシグネチャ（id と深さの並び）が変わった時だけ DOM を組み直す。**
  変わらなければテキストだけ差し替える。全消し全作り直しをすると開閉と選択が飛ぶ。
- 稼働中セッションは SSE の `snapshot` ごとに再取得するが、**2秒デバウンス**し、
  **Tree タブが見えている間だけ**にする。35MB のパースを毎秒起こさないため。
  終了済みセッションは1回だけ取得し、以降は「更新」ボタン。
- 詳細パネルのツールログは、**transcript が実際に動いた時だけ**（`parse.cached === false`）
  取り直す。毎秒作り直すとスクロール位置が飛ぶ。
- **0 は空欄にする。** transcript を持たないエージェント（6.3）はトークンもツール数も
  0 なので、`0` と書くと数値ではなく「はぐれた文字」に見える。名前が無く ID を
  出す行は数値セルと同じ等幅にして、列が揃うようにする。
- タブ・選択セッション・期間は `localStorage`（try/catch 付き。値が無くても正しく描く）。
- サブエージェントの起動プロンプトは、**起動した `Agent` tool_use の `input.prompt`**
  から取る。`parser.js` は設計上メッセージ本文を保持しない（`textLength` だけ）ので、
  子 jsonl の最初の user メッセージは読めない。

---

## 7. 常駐化: 永続トークン・ログファイル・自動起動

「ログオンしたら勝手に立ち上がっていて、ブックマーク1つで開ける」状態にするための3点セット。
どれも**任意**で、既定の挙動（前景起動・プロセス毎トークン・ログ無し）は M2 から変えていない。

### 7.1 永続トークン

既定は今まで通り**プロセスごとに `crypto.randomBytes(32)`**（4.2 の段1）。秘密はプロセス内と
HttpOnly Cookie にしか存在せず、再起動で全部無効になる。人間が手で起動してコンソールの
URLを読む限り、これが一番強くてコストもゼロである。

これが成立しなくなるのが「Task Scheduler がログオン時に起動する」場合で、URLを読む
コンソールが誰にも見えない。`--persist-token` はそこだけを解く取引で、
トークンを `<monitorDir>/token`（既定 `%USERPROFILE%\.claude-monitor\token`）に置く。

| 項目 | 内容 |
|---|---|
| 保存先 | `<monitorDir>/token`。書き込みは `paths.writeFileAtomic`（`.tmp-<pid>-<rand>` → rename） |
| 受け取り方 | **bind の後**に `loadOrCreateToken()` し、`handle.auth.setToken()` で採用する（下記「順番」） |
| 暗黙の有効化 | `--rotate-token` と `--token-file P` は `--persist-token` を含む（プロセス毎トークンを rotate しても意味が無いため） |
| 受理条件 | `/^[0-9a-f]{64}$/` に**完全一致**するときだけ。長さ違い・大文字・途中の空白・余計な行・ディレクトリは全て「使えるトークン無し」扱いで上から書き直す |
| 前後の空白 | trim する（エディタが足すものなので）。途中の空白は許さない |
| 読めないファイル | 例外にせず「無い」と同じ扱い |
| `action` | `reused` / `created` / `regenerated`（あったが中身が使えなかった）/ `rotated` |

**順番が効く。** `cmdServe` は **bind を最初にやる**。ログを開く → `startServer({port})` で
listen する → **成功してから**トークンを読む（または rotate する）→ `auth.setToken()` で採用 →
`url.txt` を書く → 必要なら `--open`、の順である。理由は事故の形にある:
すでに隠しインスタンスが握っているポートに手でもう1つ立てるのが典型的な事故で、
トークンを先に読む（まして rotate する）と、**負けた側が勝っている側の秘密を書き換えてしまう**。
ユーザーのブックマークが理由も無く 403 を返し始めるのはこれである。
bind が失敗した場合、トークンも `url.txt` も**読まれも書かれもしない**。
残るのはログに記録された拒否の1行だけ。
トークンが listen 後に決まるので、`Auth` は `setPort()` と同じ理屈で `setToken()` を持ち、
`handle.url` は `auth.entryUrl()` を読み抜くゲッターになっている。
`setToken()` は falsy を無視する —— トークン無しに落ちることは、ブラウザの全ページに
ダッシュボードを開くのと同じだから。

**4.2 との関係は「段1だけの差し替え」である。** 保存されるのは URL に載るトークンだけで、
段2以降（`/?t=` からの Cookie 発行、`timingSafeEqual` によるダイジェスト比較、
`Host` / `Origin` / `Sec-Fetch-Site`）は一切変わらない。ブラウザ側の資格情報は依然として
HttpOnly + SameSite=Strict の `cm_token` Cookie 1つで、変わるのは
「その Cookie の元になる URL が再起動をまたいで生き残る」ことだけ。
広がるのは「トークンがファイルとブラウザ履歴にも存在する」という一点で、
これは Cookie が既に置かれている脅威モデル（ユーザーのプロファイルを読めるものは既に勝っている）と
同じ範囲だが、**確かに広がっている**のでフラグにして文書化してある。

Windows では `fs` のパーミッションビットが効かないので chmod はしていない。
`%USERPROFILE%` の ACL（本人 + SYSTEM + Administrators）に乗っているだけで、
それ以上を装わない。

**`url.txt`。** `<monitorDir>/url.txt` に `http://127.0.0.1:<port>/?t=<token>` を1行書く。
隠しインスタンスの起動URLを人間が知る唯一の手段なので、トークン込みで書くのが目的であり、
だからこそ `token` の隣に置いてある。書き込みに失敗してもサーバは起動する
（補助ファイルのせいで監視が立ち上がらないのは本末転倒）。

**書くのは永続トークンのときだけ**（`tokenInfo ? writeUrlFile(...) : null`）。
プロセス毎トークンのURLはそのプロセスと一緒に死ぬので、それをファイルに残すと
「入口に見えて入口ではないファイル」ができ、しかも後述のとおり `rotate-token` が
そこからポートを読んでしまう。永続化しない `serve` は
`token: per-process (nothing stored; the URL dies with this process)` と出して
ディスクには何も残さない。

`url.txt` はもう1つ役目を持つ。**`rotate-token` が書くURLのポートの出どころ**である。
rotate は普通、`serve --port N` や logon タスクの起動から何時間も経ってから引数無しで叩かれる。
このプロセスは動いているサーバに問い合わせる手段を持たないので、
`--port` > `CLAUDE_MONITOR_PORT` > **`url.txt` に記録されたポート**（`readUrlPort()`）> 既定 47321
の順で決める。どれにも当たらず既定に落ちた場合だけ `WARNING` を出す ——
ポートの違うURLは 403 にすらならず、ただ繋がらないので、黙って間違えるのが一番悪い。
値の無い裸の `--port` はポートの指定とみなさず、記録された方に落とす。
そして **`url.txt` を信用するのは token ファイルが隣に在るときだけ**。
`serve` はこの2つを一緒に、永続トークンのときだけ書くので、`url.txt` 単独は
（古い版が書いたか、token だけ消したかの）残骸であり、残骸は証拠ではない。

**rotate の意味論。** `rotate-token` が置き換えるのは**トークンのファイルだけ**で、
新しいURLを `url.txt` に書き直す。それ以外は何も起こらない。

走っているサーバはトークンをメモリに持っており（`startServer` → `new Auth`）、
発行済みの Cookie の値は**そのトークンそのもの**である。
`hasValidCookie` → `isToken` → `safeEqual` はそれをメモリ上のトークンと比べるだけで、
HMAC も鍵導出も無い（`safeEqual` が SHA-256 に通すのは長さを揃えて `timingSafeEqual` を
安全に使うためであって、値を派生させているのではない）。
したがってファイルが変わっても、開いているセッションについては何も変わらない:

- **再起動するまで** —— 古いブックマークも、既に配られた Cookie も**通り続ける**。
  403 になるのは `rotate-token` が印字した**新しい**URLの方である。
- **再起動した後**（自動起動なら次のログオン）—— 逆転する。新しいURLだけが通り、
  古いブックマークと古い Cookie は全て 403 になる。

走っているサーバに知らせる手段は意図的に作っていない。ダッシュボードには書き込み系の
エンドポイントが無く、秘密を再読込させるためにそれを1つ足せば、サーバ唯一の特権操作になる。

### 7.2 ログファイル

隠しウィンドウのインスタンスにはコンソールが無い。起動URLも、ポート衝突の拒否も、
4.7 のクラッシュ理由も、誰も見ない窓に出て消える。**黙って死ぬのが最悪の故障**という
4.7 の前提をそのまま引き継ぐと、「隠して動かすならログを書くこと」が条件になる。

- **tee 方式。** `teeConsole(log)` が `process.stdout.write` / `process.stderr.write` を
  差し替える。呼び出し側に「2回ログを書く」規律を要求しない。これで `cli.js` の `fail()` も、
  シグナルハンドラの `SIGINT received - shutting down` も、`installCrashHandlers` の
  `uncaughtException: <stack>` も、追加の配線なしに全部落ちる。
  元の関数は**束縛していないそのまま**を保持し、`restore()` は同じ関数オブジェクトを戻す
  （bind したコピーは挙動は同じでも「まだ手つかずか」を見ている他のコードを騙す）。
- **同期書き込み。** append で開いた fd への `fs.writeSync`。ストリームではない。
  クラッシュ経路の終点は `process.exit(1)` で、これは未flushの非同期書き込みを捨てる。
  バッファするロガーは**まさに必要だった1行**を落とす。
- **行ごとのタイムスタンプ。** `2026-09-04T20:44:01.123Z out | ` / `err | ` を各行の頭に付ける。
  末尾の改行は保存し、空の stamped 行を作らない。
- **サイズ上限。** 既定 4 MiB（`DEFAULT_MAX_BYTES`）。書き込みで超えるなら先に
  `<file>.1` へ rename して空のファイルを開き直す。世代は1つだけなので通常は最悪 8 MiB。
  ログオンから shutdown まで何ヶ月も走るものがディスクを埋められてはならない一方、
  履歴が全く無いログはクラッシュ後に読めないため、truncate ではなく rename にしてある。
- **ローテートは `renameSync` **1回**で、成功する前に何も消さない。**
  `renameSync` は既存の `<file>.1` を置き換える（Windows では MoveFileEx +
  MOVEFILE_REPLACE_EXISTING）ので、先に `rmSync` しても得るものは無く、
  その後 rename が失敗したときに前の世代を失う分だけ損をする。
  **失敗しても truncate に落ちない。** 同じログに別プロセス（2つ目のインスタンス、
  手で起動したサーバ）が追記している可能性があり、`writeFileSync(file, '')` は
  その行を捨てる。上限を一時的に超える方が小さい失敗である。
  失敗したら `retryRotateAtBytes = bytes + maxBytes` を置いて、
  **もう1世代分育つまで再試行しない**（毎回 rename を叩いて毎回失敗するのを避ける）。
  サイズは `open()` の中で `statSync` から**読み直す**ので、次の判断は推測ではなく事実に基づく。
- **1回の書き込みが上限を丸ごと食べないようにする。** 書き込み前ローテートが
  「最悪 2×maxBytes」を保証するのは、1チャンクが1世代に収まる間だけ。
  数MBのスタックトレースやコンソールへの巨大な貼り付けは収まらないので `capChunk()` が切り、
  切ったことを `...[truncated N bytes]` としてファイルに書く（末尾を黙って失うのは、
  このモジュールが防ごうとしている失敗そのもの）。切断は UTF-8 の境界を守る。
  マーカーすら入らないほど上限が小さい場合は、説明ではなく上限の方を守る。
- **全ての書き込みを包む。** ディスク満杯・ファイルロック・ディレクトリ削除で
  サーバが落ちてはならない。失敗は `writeErrors` / `lastError` に数えるだけで投げない。
  Windows ではディレクトリに対する `openSync(dir, 'a')` が**成功して**使えそうな fd を返し、
  失敗するのは最初の write なので、呼び出し側が頼れる契約は
  「`write()` が false を返し `writeErrors` が増える」であって「fd が null」ではない。

- **トークンを消してから書く。** `write()` は `redactSecrets()` を通してから stamp する。
  対象は `?t=`/`&t=` に続く64桁hex（起動URL）と `cm_token=<64桁hex>`（Cookie）の2パターンで、
  前者は `t=` ごと `<token redacted>` に置換する。「ログに起動URLが入っていない」ことが
  `?t=` の grep 1回で確かめられるようにするためで、hex が本物かどうかの判断を挟まない。
  消すのは「今このプロセスが配っているトークン」ではなくパターンである
  （`rotate-token` の実行も、古いトークンを握ったままのクラッシュハンドラも、同じファイルに書く）。
  スクラブは `LogFile` の中の1箇所だけで行う。印字する側全員に規律を要求すると、いつか破られる。

**何が記録されるか。** `cli.js` が印字するものだけ ——
起動バナー、`error:` 行、シグナル受信、クラッシュのスタック、そして
**トークンを伏せた**起動URL（`http://127.0.0.1:47321/?<token redacted>`）。

**何が意図的に記録されないか。**

1. **トークンそのもの。** 起動URLは「コンソールには出さなければならない（手で起動した人には
   他に開く手段が無い）が、ファイルには残してはならない」という両立が要る。
   `openServeLog` は tee を張る**前**の `process.stdout.write` を `rawOut` として捕まえておき、
   `printWithToken()` がログへは `log.write()` 経由でスクラブ済みの行を、
   コンソールへは `rawOut` で素の1行を書く。`--json` の payload も `url` を含むので同じ経路を通す。
   **ログを先に書く**のは、こちらが同期の `fs` 呼び出しで、Windows のパイプ上の stdout は
   非同期だから。ちょうどこの辺りでプロセスが殺された場合（supervisor やテストが
   止めるのはまさにここ）、失うのはコンソールの写しの方であって、永続する記録ではない。
   ログはプロセスより長生きし、世代を1つ残し、ログオンのたびに書かれる。
   そこに生きた資格情報があるのは「期限の無い資格情報」と同じである。
   ディスク上の起動URLの置き場は `url.txt` ただ1つで、これは `token` の隣に置いてある。
2. **リクエストログ。** `server.js` / `collector.js` / `auth.js` / `sse.js` は `console.*` も
   `process.stdout` も一切呼ばない。したがってアクセスされたパス、cwd、セッション名、
   コスト、枠残量、SSE の中身はログに出ない。アクセスログを足す実装は入っていないし、
   足すなら 4.2 の「ヒントを出さない」方針と併せて設計し直す必要がある。

`serve` は `--log-file` を渡したときだけログを開く（`pathFlag` は未指定で `null`）。
`--log-file` を末尾に置いた場合と `--log-file=`（空の値）はどちらも既定パスとして扱う ——
ログを求めた人に「黙ってログ無し」を返さないため。
前景で手で起動したときの既定はログ無しで、M2 までと同じ挙動である。

### 7.3 自動起動

**なぜ `schtasks /TR node ...` を直接使わないか。** `node.exe` はコンソールサブシステムの
バイナリなので、ONLOGON タスクが直接指すと毎回のログオンで黒い窓が出る（点滅、または居座る）。
`wscript.exe` は GUI サブシステムのホストで自前のコンソールを持たない。
そこから `WScript.Shell.Run cmd, 0, False` を呼ぶ —— `0` = 非表示、`False` = 待たない。
wscript は即座に終了するのでタスクは「完了」と報告され、node はそのまま走り続ける。
この2つ（コンソールを作らないホスト／待たずに投げる）を同時に満たす一番小さい仕掛けが
`.vbs` 1ファイルである。

**なぜ UTF-16LE + BOM か。** このプロジェクトのパスは日本語を含む（`D:\develop\Claude監視`）。
BOM の無いファイルを wscript はシステムの ANSI コードページで解釈するので、
パスが化けて**存在しないディレクトリ**を指す。BOM を付ければ Unicode として確実に読む。
`toUtf16LeBom()` が先頭に `FF FE` を付ける。本文は CRLF（Windows Script Host のファイルなので）。

launcher が起動するコマンド（既定 = トレイ経由。7.5 を見よ）:

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden
  -File "<repo>\tray\claude-monitor-tray.ps1" -Port <port> -Node "<node.exe>"
  -Cli "<repo>\src\cli.js" -LogFile "<monitorDir>\serve.log" -MonitorDir "<monitorDir>"
```

`--no-tray` を渡すと、従来どおり node を直接起動する:

```
"<node.exe>" "<repo>\src\cli.js" serve --persist-token --port <port> --log-file "<monitorDir>\serve.log"
```

VBS の文字列リテラルの中なので二重引用符は `""` で書く（`vbsQuote`）。
パスに `"` や CR / LF / NUL が含まれる場合は launcher を作らずに例外を投げる
（Windows のパスに `"` は入らないので、入っているなら我々が扱うべきパスではない）。
この拒否は `assertQuotablePath()` に1つだけ置き、**VBS の文字列リテラルと
schtasks の `/TR` 値の両方**が通る。どちらも、エスケープされていない引用符が
「ログオンのたびに黙って別のものを実行する」に化ける場所だからである。
検査は `planAutostart()`（`buildLauncherVbs` と `createTaskArgs`）の中で走るので、
**launcher を書く前・タスクを登録する前に失敗する**。半端に登録された状態は残らない。
`--open` は渡さない —— `serve` は `--open` が無ければブラウザを開かないので、
隠しインスタンスに必要な既定が最初からそれになっている（抑止用のフラグは不要）。

登録するタスクは**`claude-monitor` ただ1つ**。作るのも調べるのも消すのもこの名前だけ。

```
schtasks /Create /TN claude-monitor /XML <monitorDir>\autostart.xml /F
```

**なぜ `/SC ONLOGON` を使わないか —— 使えなかったからである。** この環境（非昇格）で実測:

```
schtasks /Create /TN X /TR "cmd.exe /c exit" /SC ONLOGON /RL LIMITED /F
-> 終了コード 1  「エラー: アクセスが拒否されました。」
```

`/SC ONLOGON` は**ユーザーの紐付かない**ログオントリガーを作る。それは
**全ユーザーのログオンで発火する**タスクであり、作ることそのものが管理者の行為である。
そして schtasks のコマンドラインには、これを1ユーザーに絞るフラグが無い ——
`/RU` は「何者として**実行**するか」であって「誰のログオンで**起動**するか」ではない。
つまりコマンドライン形式では、我々が欲しいタスクを**表現できない**。

XML 形式なら表現できる。`<LogonTrigger>` に `<UserId>DOMAIN\user</UserId>` を入れれば
per-user のトリガーになり、**昇格なしで登録できる**（同じ環境で `/XML` は 0 を返した）。
この `<UserId>` 1個が、登録できるかできないかの分かれ目である。

XML の要素はスキーマの順序どおりに並べる（RegistrationInfo → Triggers → Principals →
Settings → Actions、`LogonTrigger` の中は Enabled → UserId → Delay）。
順序が違うと Task Scheduler は文書ごと受け付けない。

- **`<RunLevel>LeastPrivilege</RunLevel>`** = ユーザーの通常のトークン。**昇格を要求してはならない。**
  誰も見ていないログオン時に UAC のプロンプトが出たら、それはハングと区別が付かない。
- **`<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>` = 無制限。ここが一番効く。**
  既定は **72時間**で、超えるとスケジューラがタスクを**停止する** ——
  我々にとってそれはトレイホストの、ひいてはサーバの死である。
  3日ごとに自分が殺される監視役は、居ないより悪い。
- **`<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`** = 2つ目を起こさない。
  `.ps1` の名前付き Mutex が既に拒否するが、二重の防御は安く、壊れ方が違う。
- **`<Delay>PT10S</Delay>`** = シェルが通知領域を作る時間を与える。
  まだ存在しないタスクバーに追加されたアイコンは黙って捨てられる。
- **`<Principal><UserId>`** には SID を入れる（`whoami /user /fo csv /nh` の2列目）。
  名前より曖昧さが無いからである。読めなければ `DOMAIN\user` に落とす ——
  スケジューラはこれも受け付けるので、失敗ではなくフォールバックとして扱い、
  dry-run にどちらを使ったか出す。
  なお `whoami` は **System32 の絶対パス**で呼ぶ。Git for Windows が同名の MSYS 版を
  同梱しており、PATH の順によってはそちらが拾われて `/user` を理解せず終了コード1になる
  （実測）。
- **`/F`** = 同名タスクの上書き。install を冪等にする。
- 補間する値はすべて `escapeXml()` を通す（`&` `<` `>` `"`）。
  日本語はそのまま入る —— ファイルは UTF-16LE + BOM で書き、宣言も `encoding="UTF-16"` にする。
  `.vbs` と同じ理由が一層上で繰り返されている。
- `schtasks` は argv 配列で `spawnSync`（`shell: false`）。
  `displayCommand()` が出す引用符は**人間が cmd.exe に貼るための表示専用**である。

`autostart.xml` は登録後も**残す**（`autostart-status` が何を登録したか見せられる）。
`uninstall-autostart` が `.vbs` / `.json` と一緒に消す。

**状態の読み取りは `/Query /XML ONE` を parse する。** `/FO LIST` のフィールド名は
**ローカライズされる**（この環境では日本語）ので、それを parse すると英語版 Windows でだけ
動いて日本語環境では黙って何も返さない実装になる。XML のスキーマは全ロケールで同じ。
`/FO LIST /V` の生出力は表示用に末尾へ付けるだけで、判断には使わない。
`schtasks` のエラーメッセージはコンソールのコードページ（この環境では CP932）で出るので、
`decodeConsole()` が BOM → UTF-8 →（置換文字が出たら）Shift_JIS の順に best-effort で読む。
実際に判断に使うのは終了コードなので、これは人間が読む文面にしか影響しない。

**`uninstall-autostart` が消すもの。** `claude-monitor` タスクと `<monitorDir>/autostart.vbs`
の**2つだけ**。`token` / `url.txt` / `serve.log` / `events/` には触れない。
schtasks の終了コードが 0 以外でも（大抵は「そんなタスクは無い」）launcher の削除は実行する。
launcher の行は `existsSync` の実際の結果で書き分ける ——
dry-run では `(would be removed)` か `(missing)`、実行時は `(removed)` /
`(still present)` / `(missing)`。無いものに「消します」と言うのは、
出力を追う人には「在る」と読めてしまう。
**今動いているサーバは止まらない** —— シャットダウン用のエンドポイントは設計上存在しない
（ダッシュボードは読み取り専用）。

**`--dry-run` の規律は `installer.js` と同じ。** 実行する argv、書き込むファイルの
パス・エンコーディング・バイト数、そして VBS の全文を印字して、何にも触らない。
dry-run はプラットフォーム判定より前に return するので Windows 以外でも中身を確認できる
（非 dry-run の `installAutostart` は win32 以外で例外を投げる）。
`autostart-status` は読み取り専用で、何も作らず何も変えない。

### 7.4 既知の制約

1. **落ちたサーバはトレイホストが復帰させる（7.5）。バックオフは 5s → 15s → 60s、
   10分に5回で断念。** トレイを使わない（`--no-tray`）ときは従来どおり
   ONLOGON トリガーは「ログオンした」ときにしか発火せず、4.7 の設計で uncaught は
   exit 1 で終わるので、そこから**次のログオンまで落ちたまま**になる。
   どちらにせよ「隠し起動は必ずログを書く」の理由は変わらない。
   **トレイホスト自身が死んだ場合は、アイコンもサーバも道連れで、次のログオンまで戻らない。**
2. **タスクはユーザー単位・Windows 専用。** 登録したアカウントのログオンでしか動かない。
   トレイはさらに Windows 限定である（System.Windows.Forms の NotifyIcon）。
3. **ポート衝突時、2つ目は本当に何も変えない。** bind が先なので、負けた側は
   トークンも `url.txt` も読まず書かない。`EADDRINUSE` で `fail()` → exit 1。
   ディスクに残るのは**ログに書かれた拒否の1行だけ**である（7.1「順番が効く」）。
   ただし `--log-file` を渡していれば、その1行のためにログファイルは作られる。
4. **`rotate-token` は走っているサーバに効かない**（7.1）。rotate 直後は
   古いブックマークと古い Cookie の方が通り、新しいURLが 403 になる。再起動で逆転する。
5. **`url.txt` は永続トークンのときしか書かれない**（7.1）。プロセス毎トークンで
   起動した場合、ディスクにはURLが残らない —— 見に行っても無い、が正しい状態である。
   逆に、token ファイルを消して `url.txt` だけ残すと `rotate-token` はそれを残骸として無視する。
6. **ログのトークン隠しはパターンマッチである**（7.2）。`?t=` と `cm_token=` の2形だけを見ている。
   トークンを別の形で印字する経路を足したら `TOKEN_PATTERNS` も足すこと。
   `token` と `url.txt` は伏せていない（伏せたら用を成さない）ので、そちらは秘密として扱う。
7. **止める手段はプロセス終了だけ。** シャットダウン用エンドポイントは無く、
   `uninstall-autostart` も動いているサーバを止めない。トレイ常駐なら
   `tray-stop` かメニューの「終了」が窓口になるが、これも結局プロセスを終わらせている
   だけで、サーバに「止まれ」と言う経路は相変わらず存在しない。
10. **新しい通知アイコンは既定で「^」の中である。** Windows 11 は初めて出たアイコンを
   オーバーフローに入れる。**動いているのに何も見えない**ので、「起動していない」と
   区別が付かない —— 見えるようにするのはユーザーの操作（設定 > 個人用設定 >
   タスクバー > その他のシステム トレイ アイコン）で、こちらから固定する API は無い。
   `install-autostart` の dry-run と README がこれを明記する理由である。
11. **`tray.pid` は主張であって事実ではない。** `/F` で殺されたトレイは finally を
   走らせられないのでファイルが残る。だから `trayStatus()` は必ず PID の
   **名前と開始時刻**まで見て、残っているだけのものを `stale` と呼ぶ（7.5）。
   `tray-stop` はその場合に置き去りのサーバを片付けてファイルを消す役も負うが、
   PID が**再利用されていた**場合は何も殺さず何も送らず、ファイルだけ消す。
12. **2人目のユーザーのトレイは赤くなる。** Mutex は `Local\`（ログオンセッション単位）
   なので、別セッションでもトレイ自体は起動する。しかしポートはマシン全体で1つなので、
   そのサーバは bind に負けて終了し、バックオフの末に**そのセッションのアイコンが赤くなる**。
   1人目は無傷。意図した挙動である（7.5 に理由）。
13. **リポジトリを移動すると、`autostart-status` 以外は誰も気付かない。**
   launcher は動き、wscript は 0 で終わり、タスクは成功と報告され、
   トレイホストは読み込まれないので何もログに書けない。
   `autostart-status` の `launcher pts:` 行だけが唯一の検出経路である（7.5）。
   これは `install-autostart` が書く `autostart.json` に依存するので、
   **それ以前に登録した環境では一度入れ直すまで使えない**。
8. **上限を一時的に超えることがある。** rename に失敗したローテートは何も消さず何も切らずに
   諦め、もう1世代分育つまで再試行しない（`retryRotateAtBytes`）。
   同じファイルに追記している他プロセスの行を捨てるよりは、太ったログの方が小さい失敗である。
   また `maxBytes` を超える単一チャンクは `...[truncated N bytes]` を付けて切られる。
9. **実登録の確認がまだ無い。** `schtasks /Create` の成功、ログオン時に本当に窓が出ないこと
   —— これらは**設計意図であって観測結果ではない**。
   確認手順は `docs/autostart-verification.md` 第5章、未確認の一覧は同第6章にある。
   （BOM 無しで日本語パスが壊れることは、その後**実際に観測した**。同 第8章。）

### 7.5 トレイ常駐

**解こうとしている問題は「動いているのが判らない」である。** 7.3 は窓が出ないことに
成功しすぎた。ログオンで静かに起動したサーバは、`netstat` を叩くか `serve.log` を
開くまで、動いているのか落ちたのか区別が付かない。しかも ONLOGON トリガーは
落ちたプロセスを起こし直さない（7.4-1）。**見えること**と**面倒を見ること**は
同じ1つの常駐プロセスで両方片付く。それがトレイホストである。

```
wscript.exe (autostart.vbs)                    ← コンソールを持たない、待たない
  └─ powershell.exe -STA -WindowStyle Hidden   ← トレイホスト（アイコン＋監視）
       └─ node.exe src/cli.js serve ...        ← サーバ
```

**なぜ npm のトレイモジュールではないのか。** このプロジェクトの実行時依存はゼロで、
それを維持する。ネイティブのトレイモジュールは Node のバージョンごとにプリビルドの
バイナリを引き連れてくるし、リポジトリに `.ico` を1つ置くことにもなる（誰も diff
できないバイナリが1つ増える）。`System.Windows.Forms` の `NotifyIcon` は Windows 11 に
最初から在り、アイコンは 16x16 の `Bitmap` に円を描いて `GetHicon()` すれば実行時に作れる。
代償は**STA でなければならない**こと（`NotifyIcon` はメッセージループを要求する）と、
`-WindowStyle Hidden` が要ること。両方とも本実装の前にプロトタイプで確かめてある
（`docs/autostart-verification.md` 第8章）。

**なぜ UTF-8 BOM 付きか。** 7.3 の `.vbs` と同じ理由が、別の言語で繰り返される。
Windows PowerShell 5.1 は BOM の無い `.ps1` を**システムの ANSI コードページ**
（この環境では CP932）で解釈する。メニューの「ダッシュボードを開く」は化けるだけでは
済まず、化けたバイト列がクォートやバッククォートに当たれば**パース自体が失敗する**。
実際にこの作業中、BOM を付け忘れた作業用スクリプトが
`D:\develop\Claude監視` を `D:\develop\Claude逶｣隕・` と読んで落ちている。
`test/tray.test.js` が先頭3バイトが `EF BB BF` であることを検査する。

**単一インスタンスは名前付き Mutex。** `Local\claude-monitor-tray-<port>` を
`WaitOne(0)` で取り、取れなければ**黙って exit 0**。ログオンタスクの二重起動、
手で叩いた `cli.js tray`、既に通知領域に居るアイコン —— これらが2つのアイコンになって
1つのサーバを取り合う事態を防ぐ。負けた側が静かに消えるのは `serve` が bind に
負けたときと同じ作法である（7.4-3）。前の持ち主が解放せずに死んだ場合の
`AbandonedMutexException` は「我々が所有者になった」として扱う。

**負けた側は `tray.pid` の在り処を知らない。** これは順番の問題で、間違えると
一番痛い形で壊れる。`$script:PidFile` は **Mutex を取れてから**代入する。
finally は全ての退出経路で走る（負けて `exit 0` する経路も含む）ので、
負けた側がパスを知っていると、**勝っている側の `tray.pid` を消しながら**去ることになる。
そうなると `tray-stop` は「止めるものが無い」と言い、アイコンは生きているのに
到達手段が無くなる。二重の保険として `Remove-PidFile` は
（a）Mutex を保持している場合のみ動き、（b）ファイルの `trayPid` が自分の `$PID`
であることを確認してから消す。

**`Local\` はログオンセッション単位である。** `Global\` にはしていない。
`Global\` なら2人目のユーザーのトレイは**黙って起動を拒否**し、アイコンも出ず
理由も画面に出ない。現状は2人目のセッションでもトレイは起動し、その配下のサーバが
TCP bind に負けて（ポートはマシン全体で1つ）、そのセッションには**赤いアイコン**が出る。
1人目のトレイは無傷のまま。黙って何も起きないより、見えて説明の付く失敗の方がよい。

**監視は3秒ごとの WinForms Timer。** 状態は2つの観測から決める:

- 子プロセスが生きているか（`Process.HasExited`）
- `127.0.0.1:<port>` に TCP 接続できるか（500ms タイムアウト、`TcpClient.BeginConnect`）

`running` は**両方**を要求する。ポートが応答しても子が死んでいるなら、それは
「我々のサーバが動いている」ではなく「他人がポートを握っている」——
つまり我々のサーバが落ち続けている理由の方である。HTTP ではなく接続だけを見るのは、
ダッシュボードが全ルートでトークンを要求するので、叩いても 403 しか判らないからである。

子が予期せず終了していたら**バックオフして再起動する: 5秒 → 15秒 → 60秒**（以降60秒）。
10分の窓の中で5回失敗したら再起動をやめ、アイコンを赤にしてバルーンを出す。
再起動で直らない何か（他プロセスが握るポート、壊れたインストール）を、
誰も見ていないところで毎分 node を生やし続けるより、赤いアイコンの方がましである。

アイコンは**状態が変わったときだけ**作り直し、古い `HICON` は `DestroyIcon` で解放する
（P/Invoke）。`Icon.FromHandle` はハンドルを所有せず、`Icon.Dispose()` も解放しない —
ログオンからシャットダウンまで走るプロセスで、状態が変わるたびに GDI ハンドルを
1つずつ漏らすわけにはいかない。

**子には `CLAUDE_MONITOR_DIR` を渡す。** サーバは自分のデータ置き場を
`src/paths.js` の `monitorDir()` で解決し、`token` と `url.txt` を書くのは**サーバの方**である。
これを渡さないと、トレイが見ているディレクトリとサーバが書くディレクトリが食い違う。
「ダッシュボードを開く」は `-MonitorDir` の `url.txt` を読むので、
他人の実行の URL を開くか、何も見つけられないかのどちらかになる。
（これは机上の心配ではない —— スモークで実際にそうなった。）

**`url.txt` は許可リストで検査してから開く。** `Open-Dashboard` は
`server.js` の `openBrowser()` と**同じ**正規表現を当てる ——
`^http://127\.0\.0\.1:\d{1,5}/\?t=[0-9a-f]{64}$`（PowerShell 側は大小を区別する
`-cmatch`。JS 側にも `i` フラグは無い）。`^https?://` で通していた頃は、
このファイルを書ける者が**任意の URL をシェルに渡させられた**。
プロファイルディレクトリを書ける攻撃者は既に大きな力を持っているが、
「シェルに渡る唯一の文字列」を検査しない理由にはならない。
弾いた場合は素の `http://127.0.0.1:<port>/` に落とし、
ログには**ファイル名だけ**を「url.txt rejected」として残す（中身は書かない）。

**リポジトリを動かすと黙って死ぬ。** これを検出するために、`install-autostart` は
launcher の隣に `<monitorDir>\autostart.json` を書く。何が起きるかというと ——
リポジトリを移動・改名すると、ログオンタスクは存在しないパスを指す launcher を実行する。
`.vbs` は動く。`sh.Run` は存在しない実行ファイルへのコマンドラインを投げる。
**`Run` は wait=False なので失敗を報告できず**、wscript は 0 で終了する。
トレイホストは一度も読み込まれないので、**自分が動かなかったことをログに書けない**。
Task Scheduler は「成功」と言う。唯一の症状は「アイコンが出ない」で、
これは「Windows がオーバーフローに入れた」と見分けが付かない。
つまり検出は**外からしかできない**ので、`autostart-status` がこの sidecar を読み、
`trayScript` / `node` / `cli` / `launcher` の実在を確かめて、
欠けていれば大きな声で言う。sidecar が無い場合は「ok」でも「壊れている」でもなく
**「この検査は使えない（再インストールせよ）」**と言う。
`.vbs` を読み返して解析する案は採らなかった —— 自分で生成した文字列から、
2つの形（tray / --no-tray）に分けて引用符付きパスを復元することになり、
書いた時点で手元にあった値をわざわざ推測し直すことになる。

**ログに書かないもの。** トレイは `serve.log` に `[tray]` 付きで1行ずつ追記する。
`redactSecrets`（7.2）と**同じ2つのパターン**が PowerShell 側にも置いてある。
トレイ自身はトークンを持たないが、`url.txt` を読む —— あれは
トークン入りURLそのものである。だから「ダッシュボードを開く」が書くのは
**ファイル名であって中身ではない**。

追記は `File.AppendAllText` **ではなく** `FileStream` を
`FileShare::ReadWrite` で開いて行う。`AppendAllText` は `FileShare.Read` で開くので、
サーバが同じファイルを追記用に握っている間（＝トレイが言うことがある間ずっと）
必ず例外になる。しかも catch が仕事をしているせいで**失敗が見えない**。
node 側の `fs.openSync(file, 'a')` が要求する共有モードに合わせてある。
これも設計ではなく、観測して直した（第8章）。

**`tray.pid` —— PID は識別子ではない。** `<monitorDir>\tray.pid` に自分と子のPIDを
JSON で書き、きれいに終了するときに消す。ただし**裸の数字は誰のことも指さない**。
Windows は PID を再利用するし、数週間動いているマシンでは何周もしている。
生存確認だけの読み手は、いずれ**他人のプロセスを「サーバ」と呼ぶ**ことになり、
`tray-stop` はそれを `taskkill /T /F` で子ごと殺す。

だから各 PID には、それを固定する2つの事実を添えて書く ——
**プロセスの開始時刻とプロセス名**（`Process.StartTime` の ISO UTC と `ProcessName`）。
`src/autostart.js` の `pidMatches()` が、`Get-Process` で観測した実際の値と突き合わせる。
`src/sessions.js` が自分の pid ファイルに対してやっているのと同じ手（`pidReused`）で、
許容差も同じ 60 秒である（記録側と観測側で時計が同一とは限らない）。
名前は決め打ちせずプロセスから読む。将来ホストが `pwsh.exe` になっても壊れない。

判定は**積極的な証拠**を要求する。「矛盾が無い」では足りない ——
名前も開始時刻も読めなかった行、identity を持たない古い形式の `tray.pid` は
**stale として扱い、running とは言わない**。`killTree()` は `expect` を**必須**にし、
殺す直前にもう一度突き合わせ、食い違えば**何も実行しない**。
ディスク上の数字を `taskkill /T /F` に渡す関数に、
「誰のことか言わずに呼べる経路」を残さないためである。

`autostart-status` は食い違いの中身まで書き分ける ——
`gone`（掃除すべき残骸）と `reused by chrome`（他人のものなので触ってはならない）は
別の世界である。後者では `tray-stop` は**イベントも送らず何も殺さず**、
自分のものである `tray.pid` だけを消す。

書き込みは**アトミックに差し替える**。`tray.pid.tmp` に書いてから
`File.Replace`（Win32 の `ReplaceFile`）で入れ替える。読み手が書き込み途中の
ファイルを開くと JSON が半分になり、`readTrayPid()` はそれを「トレイ無し」と解釈する ——
落ちはしないが答えが間違う。`File.Move` の overwrite 付きオーバーロードは
**.NET Framework 4.x に存在しない**（.NET Core 3.0 で追加）ので、PS 5.1 では
`Replace` が唯一のアトミック手段であり、これは対象が既に在ることを要求する。
初回だけ `Move` を使う。なお backup 引数には `[NullString]::Value` を渡すこと ——
`$null` は PowerShell が**空文字列**に変換してしまい、`Replace` は
「パスの形式が無効です」で落ちる（実際に落ちた。8.2 を見よ）。

**止め方は2段。** `tray-stop` はまず名前付きイベント
`Local\claude-monitor-tray-stop-<port>` を Set する。ポーリングの Timer がこれを見て
`Application.ExitThread()` を呼ぶので、**finally が走る** —— サーバを止め、アイコンを消し、
`tray.pid` を消す。応じないときだけ `taskkill /PID <tray> /T /F` に落ちる。
`/T` が要るのは、node がさらに `Get-Process` のために powershell を生やすことがあり
（`src/sessions.js`）、半端に殺した木は孤児を残すからである。
`/F` で殺した場合は `tray.pid` を消すのが誰も居なくなるので、`tray-stop` が代わりに消す。

**`cli.js tray` も wscript を経由する。** ここは驚きがあった場所である。
トレイホストを node の子として直接起動すると生き残らない ——
`spawn(..., {detached: true})` は Windows では `DETACHED_PROCESS` で、
powershell.exe はコンソールを一切持てずに**1行も実行せずに死ぬ**。
`detached` を外すと、今度は親の node が終わった瞬間に道連れになる。
`wscript.exe` の `Run(cmd, 0, False)` はコマンドをシェルに投げて戻るので、
**失う親が居ないホスト**が残る。7.3 の launcher がやっているのと同じことなので、
`tray` は同じ `.vbs` を書いて wscript に渡し、読み終わった launcher を消す。
測定結果は `docs/autostart-verification.md` 第8章にある。

---

## 8. M4: Usage ビュー

### 8.1 データフロー

Live（4.1）が hooks の押し出し、ツリー（6.1）が1セッションの引きなのに対し、
Usage は**期間を指定して全 transcript を引く**。押し出す源が無い —— トークン量は
hooks にもイベントにも現れず、jsonl の `message.usage` にしか無いからである。

```
~/.claude/projects/**/*.jsonl
        │  listTranscripts()  … readdir + stat（サブエージェント分も含む）
        │  mtime < since-2日 のファイルは開かない（8.3）
        ▼
  UsageFileCache.records(file)          ← fingerprint = size:mtimeMs
        │  ファイル1本ごとの Map<message.id, best record>
        ▼
  merge（latest timestamp wins / 同値ならトークン合計が大きい方）  ← ファイル横断 dedupe（3.1）
        ▼
  期間で絞る（LOCAL の暦日）→ byDate / byDateModel / byModel / bySession
        │                                    │
        │                                    └─ statusline sidecar の cost.total_cost_usd
        ▼                                        （セッション行の「推定 (Claude Code)」）
  <monitorDir>/usage/daily.json と突き合わせて日行を確定（8.4）
        ▼
  GET /api/usage
```

`src/usage.js`（純粋な集計）と `src/usage-view.js`（I/O とキャッシュ）に分けてある。
M3 で `tree.js` / `tree-merge.js` と `tree-view.js` を分けたのと同じ理由で、
ディスクに触る側だけを差し替えてテストできるようにするため。

### 8.2 なぜキャッシュが「ファイルごとの合計」ではなく「ファイルごとの message マップ」なのか

**これが M4 で唯一まちがえてはいけない設計判断である。**

dedupe（3.1）は**ファイル横断**で効く。同じ `message.id` が親 transcript と
sidechain コピーの両方に書かれ、**timestamp が新しい方の1件だけ**が正しい。

ファイルごとの合計をキャッシュして足し合わせると、この重複が**ファイルの数だけ
数えられる**。dedupe が防いでいる 4.5 倍の過大計上そのものであり、しかも合計に
なった後では「どの message が入っているか」が失われているので、後から引き算で
直すこともできない。

したがってキャッシュの値は**そのファイル1本だけから作った `message.id -> 最良レコード`
の Map** である。マージ側で同じ「新しい方が勝つ／同時刻ならトークン合計が大きい方」
を適用すれば、何本がキャッシュから来ようと**全ファイルを1回で読んだのと同じ答え**になる。
`test/usage-view.test.js` の「CROSS-FILE dedupe stays exact when one file is cached
and the other changed」がこれを固定している（親をキャッシュのまま子だけ更新して、
親の古いスナップショットが勝たないことを確認する）。

レコードは4指標だけに削ってから持つ（`thinking_tokens` などは合計に入れないので捨てる）。
実測 7,051 メッセージで、キャッシュ全体は数 MB に収まる。

### 8.3 期間の窓と、開かないファイル

- `?days=N`（既定30・1〜90にクランプ）。クランプは M3 の `clampInt` /
  `DEFAULT_DAYS` / `MIN_DAYS` / `MAX_DAYS` をそのまま使う。
- 窓は **LOCAL の暦日**で「今日を含む N 日」。`days=30` なら `today-29 … today`。
  ローリング 30×24h ではない（`/api/sessions` の mtime カットオフとはここが違う）。
  日付キーは `localDateKey()` で、CLI の `usage --daily` と同じ。
- **mtime が窓の開始より2日以上古いファイルは開かない。** レコードは追記されるので
  ファイル内のどの timestamp も mtime 以下であり、窓内のレコードを持ち得ない。
  マージンの2日は時計のずれと日付境界のため。`days=7` で実測 100 → 31 ファイル、
  cold 670 ms → 204 ms。**この最適化は「追記しかされない」前提に依存している。**

### 8.4 保存ストア `<monitorDir>/usage/daily.json`

既知の制約7（Claude Code が約30日で transcript を消す）があるので、スキャンだけでは
先月いくら使ったかに答えられない。そこで毎回の結果を自分で書き戻す。

```json
{ "version": 1, "days": { "2026-09-06": { "msgs": 0, "totals": {…}, "byModel": {…}, "updatedAt": "…" } } }
```

マージ規則は**日付ごとに totalTokens が大きい方を採る**、それだけ。

| live | store | 返す値 | `source` | `partial` |
|---|---|---|---|---|
| ある | 無い/小さい | live | `live` | false |
| ある | 大きい | **store** | `store` | **true** |
| 無い | ある | store | `store` | false |

- `partial: true` は「transcript が消えた（あるいは消された）ので、今回のスキャンは
  過去に自分で測った値より小さい」という意味。UI は「一部欠損」バッジで出す。
- 進行中の当日も同じ規則で扱える。当日の値は単調増加なので、大きい方を採れば正しい。
- **変化があった時だけ書く。** 同じ結果を2回作っても2回目は書かない。
- 書き込みは `writeFileAtomic()`（tmp + rename）。壊れたストア・読めないストア・
  version 違いは `onError` に1回報告して**空から作り直す**。
  ビューが落ちることは無い（4.7）。
- **書く直前にディスクをもう一度読んで、同じ規則でマージし直す。** ロックは無い。
  ビルドの最初に読んでから書くまでに数百 ms あり、その間に同じ monitorDir を見る
  別プロセス（`serve` を2本、トレイ＋シェル）が書き得るので、素の
  read-modify-write では相手の日付が黙って消える。マージ規則が**単調**
  （日付ごとに大きい方が勝つ・相手が足した日付は残す）なので、再読込を rename の
  直前に置けば競合窓は書き込み自体だけになり、それでも落ちた分は次のビルドで
  復元される —— 負けた側の値が、次に測り直した値より大きいことはないからである。
  排他ではなく**自己修復**（既知の制約28）。
- **これがダッシュボードで唯一 GET が書くファイルである。** `~/.claude` は従来どおり
  読み取り専用のまま。

### 8.5 ccusage は要求されたときだけ

既知の制約8のとおり `npx -y ccusage@latest` はダウンロードとネットワークを要するので、
ダッシュボードの実行時依存にはしない。ボタンを押したときだけ動く。

- **日付は `^\d{4}-\d{2}-\d{2}$` で検証してから** argv に載せる（`ccusage.js` の
  `SAFE_ARG` に加えて、こちら側でも形を固定する）。
- タイムアウト **60秒**。時間切れのときは `child.kill()` ではなく
  **`taskkill /PID <pid> /T /F`（プロセスツリー）**で殺す。Windows で起動するのは
  `cmd.exe` → `npx.cmd` → `node.exe`（ccusage）の3段で、先頭の `cmd.exe` に
  シグナルを送っても**孫の node は生き残る**（実測で確認）。7.3 の `killTree()` と
  同じ理由・同じコマンドである。`taskkill` 自体が失敗したら `child.kill()` に
  落とす。この処理は `setTimeout` の中で走るので、**何があっても throw しない**
  （逃げた例外は `uncaughtException` に落ち、4.7 が致命として扱う）。
- 成功は **10分間**キャッシュ、キーは `since|until`。
  **失敗はキャッシュしない**（ボタンが再試行できなくなるので）。
- **single-flight**。同時に来た呼び出しは1回の実行を共有する。タブを2枚開いて
  両方でボタンを押しても npx は1回しか走らない。
- 失敗時にブラウザへ返すのは `{"ok":false,"error":"ccusage unavailable"}` の
  **固定文字列だけ**。npm のエラー本文やコマンドラインは `onError`（=
  `collector.recordError`）にしか行かない。
- 差分は「本ツール − ccusage」を指標ごとに出す。当日は進行中なので差が出るのが正常。

### 8.6 エンドポイント

| ルート | 内容 |
|---|---|
| `GET /api/usage?days=N` | 期間の日別・モデル別・セッション別。`days` 既定30・1〜90にクランプ |
| `GET /api/usage/ccusage?days=N` | 同じ窓を ccusage と突合（要求時のみ実行） |

- `/api/usage/` 配下のそれ以外は M3 と同じ **404 JSON**（400 と書き分けない）。
- 認証・Origin・Host・`Sec-Fetch-Site` は既存ルートと同じ。GET/HEAD 以外は 405。
- `/api/usage` は同期なので `guard()`、`/api/usage/ccusage` は Promise を返すので
  **`guardAsync()`**。前者のままだと reject が `unhandledRejection` に落ち、
  `installCrashHandlers` が exit 1 する —— npx の失敗でサーバが死ぬのは論外である。
  なお ccusage の**実行**失敗は `CcusageCache.daily` が自分で握って 200 +
  `ccusage unavailable` にするので、`guardAsync` の catch に来るのは
  **キャッシュ層そのものが壊れた場合**だけ。そのときは 500 +
  `{"ok":false,"error":"internal error"}` を返し、**リスナーは生き続ける**。
- レスポンスの `days` は**日行の配列**、窓の長さは `windowDays`。
  `/api/usage/ccusage` も**窓の長さは `windowDays`** で返す
  （`days` という名前が2つのルートで別の意味を持たないようにするため）。

### 8.7 フロントエンド

4.8 / 6.5 の制約はそのまま。加えて:

- 上から **(a) 期間合計のタイル**、**(b) 日別テーブル**、**(c) モデル別**、
  **(d) セッション上位20**。
  5h/7d ゲージは**ページ上部のリボン（`#quota-rows`）にしか置かない**。
  リボンは全ビュー共通のヘッダにあるので、Usage タブの中に同じものをもう一組
  持つと、1つの数字に対して DOM が2本・更新経路が2本になる。
- 日別テーブルのバーは `.gauge__track` を**そのまま使う**。外側の幅が最大の日に
  対する比、内側がモデル系列の積み上げ。幅は CSSOM（`style.setProperty`）で入れる
  （既知の制約12）。
  積み上げの色は `.useg--opus` などの修飾子で付けるが、**基底の `.useg` は
  修飾子より前に書く**。詳細度が同じなので、後に書いた方が勝ち、
  基底を下に置くと全セグメントが灰色（`--m-other`）になる。
- セッション表の「モデル」列は**ルート transcript（`agentId` が無いレコード）の
  系列**である。サブエージェントを含めて最多の系列を採ると、Fable で回している
  セッションが「Opus」と表示される（サブエージェントの方が桁違いに重いため。
  実データで全セッションがそうなっていた）。ルートにモデルが1件も無いときだけ
  従来どおり「最もトークンを動かした系列」に落とす。
- `compact()`（Live / Tree と共用）は k / M / **G** の3単位。`toFixed` は
  丸め上がるので、999,800 が「1000k」という存在しない単位になっていた。
  丸めた仮数が 1000 に達したら**単位を繰り上げる**（→「1.0M」）。
- **モデル名はサーバが系列に畳んで返す**（Opus/Sonnet/Haiku/Fable/other）。
  クライアント側に2つ目の `MODEL_LABEL` を作らないため。
  サーバ側の表は `src/usage-view.js` の `MODEL_SERIES` で、`public/app.js` の
  `MODEL_LABEL` と**同じ家族名で一致させる**（app.js はブラウザ用 IIFE なので import できない）。
- モデルの色は**アンバーを使わない**。アンバーは「人間の対応が要る」の意味で
  予約されている（4.8）ので、内訳の色分けには使えない。
- 当日行は CLI と同じく `*` を付け、`title` で「進行中」と言う。
  `source: 'store'` は「保存値」、`partial` は「一部欠損」バッジ。
- SSE の `snapshot` で再取得するが、**10秒デバウンス**（ツリーの2秒より重い。
  1回で全 transcript を読むため）、**Usage タブが見えている間だけ**、
  かつ**タイマー発火時にもう一度可視判定をする**（8.3 の M3 レビュー指摘と同じ）。
- 期間は `localStorage` の `cm.usageDays`（`cm.tab` と同じ try/catch 付きアクセサ）。
- テーブルは**署名が変わった時だけ**組み直す（日付・合計・source・セッション・
  ccusage の取得時刻を並べた文字列）。10秒ごとに DOM を捨てないため。
- 読み込み中・失敗は必ずテキストノードで出す。空白のペインにはしない。

---

## 9. 通知設定

M2 で決めた「通知はブラウザの Web Notifications API だけ」を維持したまま、
**何を鳴らすか**をユーザーが決められるようにした回。サーバは1バイトも増えていない
（`STATIC_FILES` に `notify-rules.js` を足しただけ）。

### 9.1 なぜサーバ側に設定を置かないか

置ける場所はあった（`<monitorDir>/notify.json` と設定エンドポイント）。置かなかった:

- **通知を出すのはブラウザで、サーバではない。** 通知が出るかどうかを最終的に
  決めるのは OS とブラウザの許可状態で、これはサーバから見えない。
  設定だけサーバに置くと「サーバは ON と思っているのに何も鳴らない」という
  食い違いの置き場所が増えるだけになる。
- **ブラウザごとに違って当然の設定である。** 作業用PCでは全部鳴らし、
  サブモニタの表示専用タブでは枠の警告だけ、という使い分けは自然だが、
  サーバに1つ置くとそれができない。
- **書き込みルートを増やしたくない。** M4 で「GET が書く唯一のファイル」が
  既に1つできている（既知の制約24）。設定の PUT を足すと、認証とオリジン検証の
  境界に**状態を変える動詞**が初めて現れる。監視ツールの攻撃面としては割に合わない。

代償は既知の制約30/31（ブラウザを変えると設定も消える）。受け入れた。

### 9.2 データフロー

```
localStorage['cm.notify.settings']
        │  (boot 時に1回)
        ▼
CMNotifyRules.parse(raw, legacy)  ──► 正規化済み settings
        │                                  ▲
        │                                  │ 変更のたびに JSON.stringify して書き戻す
        ▼                                  │
   パネルのチェックボックス ────────────────┘
        
SSE snapshot ──► render()
                  ├─ renderQuota(sessions) ──► 描いた rateLimits を返す
                  ├─ fireNotifications(sessions)   … 種類別 ON/OFF を見る
                  └─ fireQuotaNotifications(limits, prime)
                          └─ CMNotifyRules.evaluateQuota(limits, armed, settings, prime)
                                     └─ {armed, fire[]} ──► notify()
```

`public/notify-rules.js` は**純粋関数だけ**を持つ classic script で、
DOM も `localStorage` も `Notification` も触らない。app.js より前に読み込み、
`window.CMNotifyRules` として使う。テストは同じファイルを `node:vm` で評価する
（既知の制約33）ので、**ブラウザとテストで別実装になることがない**。

### 9.3 保存形式

キーは1つだけ: `cm.notify.settings`。

```json
{
  "v": 1,
  "enabled": false,
  "kinds": {
    "permission_prompt": true, "idle_prompt": true,
    "agent_needs_input": true, "agent_completed": true,
    "turn_complete": true
  },
  "quota": {
    "five_hour": { "on": true, "threshold": 80 },
    "seven_day": { "on": true, "threshold": 80 }
  },
  "quietWhenFocused": true
}
```

- **既定値は「設定が無かった頃の挙動」と完全に一致させてある。** 通知は OFF で始まり、
  ONにすれば全種類鳴り、見ている間は黙る。設定を足したこと自体で挙動が変わらない。
- `kinds` の最初の4つは `src/state.js` の `NOTIFY_TYPES` と同じ。
  `turn_complete` だけはクライアント固有で、`lastEventName === 'Stop'` から出している
  （サーバの notification レコードには存在しない）。
- **`v` は必ず持つ。** 知らない version・壊れた JSON・型の違う値は**黙って既定値に戻す**。
  監視ツールの通知設定は、直せない形で失敗するより黙って初期値に戻る方がよい。
  正規化は総当たりで、未知のキーは落とし、既知のキーは1つずつ型を見る。
  結果として `settings.kinds.<種類>` はガード無しで読める。
- **旧キー `cm.notify.enabled`（`'1'`/`'0'`）からの移行**は `parse()` の中。
  新キーが有効ならそちらが勝つ。無効・不在なら既定値を作り、旧キーが `'1'` の時だけ
  `enabled` を立てる。`parse()` は `migrated` を返し、真なら呼び側が書き戻して
  旧キーを消す。**移行が「ユーザーが言っていない設定」を発明することはない**
  （旧キーは ON/OFF しか持っていなかったので、他は全部既定値になる）。

### 9.4 しきい値通知の武装ルール

`evaluateQuota()` の全状態は「窓ごとの `{resetsAt, threshold, fired}`」だけ。
`fired` を立てるのが通知で、**再武装（`fired` を落とす）は3つの理由でしか起きない**:

1. `resets_at` が変わった —— 枠が転がったので、同じ使用率でも**新しい超過**である。
2. 使用率がしきい値を下回った —— 次に超えたらまた新しい超過。
3. ユーザーがしきい値を動かした —— 新しい問いには新しい答えを返す。
   （80→60 に下げて既に 85% なら、その場で鳴る。それが「60% で教えて」の意味。）

そのほか:

- **窓がスナップショットから消えた場合は状態を据え置く。** `rate_limits` は
  サイドカーが古くなると普通に消える（既知の制約5）ので、消えたら忘れる実装だと
  再接続のたびに鳴る。`used_percentage` が数値でない場合も同じく「読めなかった」扱い。
- **初回スナップショットは `prime`。** 既にしきい値を超えていたら通知せず
  `fired` だけ立てる。タブを開き直すたびに鳴らないため。既存の
  `primeNotifications()` と同じ思想。
- `on: false` の窓は**状態ごと捨てる**。もう一度 ON にしたら、
  古い判断の続きではなく再武装から始まる。
- **`spend_limit` は対象外**。金額の上限であって使用量の窓ではなく、
  再武装に使える `resets_at` を持たない。
- 通知に使う `rate_limits` は**リボンが描いたものと同じ**。`renderQuota()` が
  自分の選んだ `rateLimits` を返し、それを渡す。
  「最新の capture を選ぶ」規則を2箇所に書くと、**画面の数字と通知の数字が
  食い違い得る**——同じ関数の戻り値を使えばその不整合は構造的に起きない。

### 9.5 フロントエンド

4.8 の制約はそのまま（`innerHTML` 禁止、外部参照ゼロ）。加えて:

- パネルの**markup は index.html に静的に置く**。チェックボックス9個と数値入力2個は
  完全に固定なので、`createElement` で毎回組み立てる理由が無い。
  app.js は値の出し入れとイベントの結線だけをする。
- **コントロールは真実ではない。** 保存されている設定が真実で、
  パネルを開くたびに `refreshNotifyPanel()` が設定を**コントロールへ押し込む**。
  逆流は `change` ハンドラの中だけ。
- 数値入力は `min`/`max` を markup にも持たせるが、**信用はしない**。
  `change` のたびに `parseThreshold()` に通し、1〜100 の整数でなければ
  **黙って捨てて保存値を書き戻す**。0 を「常に通知」に丸めるような親切はしない。
- 位置は `.topbar__actions { position: relative }` に対する `position: absolute`。
  ヘッダの高さを実測してオフセットに焼くと、ヘッダが折り返した瞬間にずれる。
- **Esc とパネル外クリックで閉じる**。外クリックの判定から開閉ボタン自身を
  除外しないと、開いた同じクリックで閉じてしまう。
- **テスト通知は `canNotify()` を通さない**（`quietWhenFocused` もマスタースイッチも
  無視する）。押した本人が画面を見ているのは当たり前で、
  「押しても何も起きないボタン」の方が害が大きい。
  権限が `default` の時だけ先に `requestPermission()` を呼ぶ
  （ユーザー操作の中でしか呼べないため、ボタンのハンドラが唯一の呼び場所）。
- `window.CMNotifyRules` が無い（配信に失敗した）場合は
  「通知設定」ボタンを `disabled` にし、通知は全て黙る。
  ルールが読めない状態で既定値をでっち上げて鳴らす方が危ない。
