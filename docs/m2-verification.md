# M2 動作確認ログ（2026-09-02 〜 09-03）

対象: `src/auth.js` / `src/state.js` / `src/collector.js` / `src/sse.js` /
`src/server.js` / `public/{index.html,app.js,style.css}` / `cli.js serve`。

環境: Windows 11 Pro 10.0.26200 / Node v24.13.0 / Claude Code 2.1.258 /
`Asia/Tokyo`。外部npm依存はゼロのまま。

---

## 1. テスト結果

```
$ npm test
ℹ tests 316
ℹ suites 68
ℹ pass 316
ℹ fail 0
ℹ duration_ms 1043
```

M1 の 141件は**全て pass のまま**。M2 で 175件追加した（うち33件は 09-03 のセキュリティ・堅牢性レビュー、
33件はブラウザ確認後の修正）。

| ファイル | 件数 | 内容 |
|---|---|---|
| `test/auth.test.js` | 23 | トークン生成、`timingSafeEqual` が実際に呼ばれること（`crypto.timingSafeEqual` を差し替えて検証。長さ32のダイジェスト同士であることも確認）、長さ違い・非文字列で例外を投げないこと、Cookie パース、Host / Origin / Sec-Fetch-Site の各拒否、CSPに `unsafe-inline` が無いこと |
| `test/state.test.js` | 64 | phase の全遷移（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/Notification 3種/Stop/PreCompact/PostCompact/SessionEnd）、PostCompact の復帰（busy・idle・waiting のそれぞれ）、連続 PreCompact、サブエージェントの start/stop と agent 単位のツール計数、`agent_transcript_path` の保持、未知イベントで落ちないこと、`reduce` が引数を書き換えないこと、**PID死亡が最優先**、sessions 一覧から消えたら dead、統計・スナップショットの並び順、上限（完了エージェント30件／終了セッション50件）を超えたら古い順に捨て、実行中・稼働中は残ること |
| `test/collector.test.js` | 26 | events への追記で `change` が発火、壊れた行のカウントと継続、未知イベントの記録、**日付ロールオーバー**（00:30起動で前日も読む／23:59→00:00で新ファイルへ）、statusline の合流、壊れた sidecar のスキップ、`stop()` の後始末、250ms デバウンスで5回の追記が1回の change になること、**hooks が一切来なくても sessions ポーラ経由で prune が走ること**と、捨てたセッションの `UsageCollector` が解放されること |
| `test/server.test.js` | 48 | 実際に 127.0.0.1 のエフェメラルポートで起動して `/`（403 → `?t=` で 302+Cookie → Cookie で 200）、`/app.js`・`/style.css` の Cookie 必須、`/api/state`・`/api/health`、`/api/stream` の初回 snapshot と**変更のプッシュ**、Origin/Sec-Fetch-Site/Host の拒否、**ディレクトリトラバーサル7パターンが全て404**、配信された `app.js` に `innerHTML` 等が無いこと、HTMLにインラインscript/style/ハンドラと外部URLが無いこと、CSSに `@import`・外部 `url()` が無いこと |

| `test/sse.test.js` | 14 | 同時接続上限8（9本目は `ok:false` で、**レスポンスに一切書かない**ので呼び出し側が 503 を返せる）、切断でスロットが空くこと、`req` の close/error でクライアントが外れ `res.end()` されること、`closeAll` 後は新規接続を拒否、broadcast が全員に届くこと、書き込みが EPIPE で落ちるクライアントだけが外れて他は届くこと、循環参照のペイロードで落ちないこと、ping タイマが最初の接続で始まり最後の切断で止まること |

M1 の統合テスト（実データ + ccusage）も回して、`parser.js` に `aiTitle` を、
`hooks-ingest.js` に `message` を足したことによる回帰が無いことを確認した:

```
$ CLAUDE_MONITOR_IT=1 node --test test/integration.test.js
✔ every transcript parses with zero failures and no unknown types (1014ms)
✔ our daily aggregation equals ccusage daily for every completed day (2858ms)
✔ the session index and tree build for every recent session (179ms)
✔ every subagent transcript reports its own agentId and isSidechain (96ms)
ℹ tests 4 / pass 4 / fail 0
```

`server.test.js` と `collector.test.js` の collector は一時ディレクトリ
（`events` / `statusline` / `sessions` / `projects`）だけを見る。
`~/.claude` と `~/.claude-monitor` の実データには触れていない。

---

## 2. `serve` の実データ確認

`node src/cli.js serve --port 47399` を子プロセスとして起動し、標準出力に出た
起動URLを読んで Git Bash の `curl 7.88.1` で叩き、最後に SIGTERM で止めた。
（ドライバは scratchpad の `verify-serve.mjs`。リポジトリには置いていない。）

### 2.1 起動

```
stdout: http://127.0.0.1:47399/?t=13131313……（64桁hex、以下伏せる）
stderr: claude-monitor serving on 127.0.0.1:47399 (loopback only)
        open the URL above once; it sets a cookie and the token leaves the address bar.
        do NOT share the URL - it is the only credential.
        Ctrl+C to stop.
```

### 2.2 認証

```
$ curl -s -i http://127.0.0.1:47399/
HTTP/1.1 403 Forbidden
Cache-Control: no-store
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'
Content-Type: text/plain; charset=utf-8
Content-Length: 10
```
本文は `forbidden` の10バイトのみ。トークンのヒントは出ない。

```
$ curl -s -i 'http://127.0.0.1:47399/?t=<token>'
HTTP/1.1 302 Found
Set-Cookie: cm_token=<token>; HttpOnly; SameSite=Strict; Path=/
Location: /
Content-Length: 0
```

```
$ curl -s -H 'Cookie: cm_token=<token>' http://127.0.0.1:47399/
<!doctype html>
<html lang="ja">
...
<title>claude/monitor</title>
```

```
$ curl -s -o NUL -w '%{http_code}' -H 'Cookie: <valid>' -H 'Origin: http://evil.example' .../api/state
403
$ curl -s -o NUL -w '%{http_code}' -H 'Cookie: <valid>' --path-as-is .../../package.json
404
```

### 2.3 `/api/state`（実データ、抜粋）

```json
{
  "ok": true,
  "generatedAt": "2026-09-02T14:56:51.918Z",
  "revision": 212,
  "counts": { "total": 1, "live": 1, "busy": 0, "waiting": 1, "agentsRunning": 2 },
  "stats": {
    "hookEvents": 208,
    "hookParseFailures": 0,
    "errorCount": 0,
    "sessionsTracked": 1,
    "indexedSessions": 66,
    "activeDates": ["2026-09-02"],
    "unknownEvents": {}
  },
  "sessions": [
    {
      "sessionId": "11111111-2222-4333-8444-555555555555",
      "title": "Claude監視",
      "cwd": "D:\\develop\\Claude監視",
      "pid": 29340,
      "alive": true,
      "phase": "waiting_input",
      "phaseSource": "hooks",
      "model": "Fable 5.1",
      "contextPct": 16,
      "costUsd": 36.68780450000003,
      "rateLimits": {
        "five_hour": { "used_percentage": 34, "resets_at": 1788365400, "resetsAtIso": "2026-09-02T16:10:00.000Z" },
        "seven_day": { "used_percentage": 3,  "resets_at": 1788901200, "resetsAtIso": "2026-09-08T21:00:00.000Z" }
      },
      "currentTool": {
        "name": "Bash",
        "toolUseId": "toolu_01GjeR2N46TeNTjuZHepf5KF",
        "since": "2026-09-02T14:56:48.462Z",
        "agentId": "a3a3a3a3a3a3a3a3a"
      },
      "toolCount": 9,
      "activeAgents": 2,
      "agents": [
        { "agentId": "a3a3a3a3a3a3a3a3a", "agentType": "general-purpose",
          "status": "running", "tools": 75, "startedAt": "2026-09-02T14:34:48.208Z", "endedAt": null },
        { "agentId": "a1a1a1a1a1a1a1a1a", "agentType": null,
          "status": "running", "tools": 1, "startedAt": "2026-09-02T14:39:42.411Z", "endedAt": null }
      ],
      "notifications": [
        { "type": "idle_prompt", "message": "Claude is waiting for your input", "at": "2026-09-02T14:36:08.927Z" }
      ],
      "lastEventName": "PreToolUse",
      "lastEventAt": "2026-09-02T14:56:48.462Z",
      "tokens": { "input": 2776, "output": 70773, "cacheCreate": 1525854,
                  "cacheRead": 44748465, "total": 46347868, "messages": 331 }
    }
  ]
}
```

確認できたこと:

- **現行セッションが実データで出ている。** `pid 29340` / `alive true` /
  `phaseSource "hooks"`（`sessions` へのフォールバックではない）。
- **`rateLimits` が入っている。** `five_hour 34%`（復帰 16:10 UTC = **01:10 JST**）、
  `seven_day 3%`（復帰 09-09 06:00 JST）。sidecar 以外にこの値の出所は無い。
- **サブエージェントを走行中として捉えている。** `agentsRunning 2`、
  `general-purpose` が 75ツール実行中。実行中のツール（`Bash`）が
  `agentId` 付きで出ている。
- **トークン集計が transcript の差分tailから出ている**（331メッセージ、合計46.3M）。
- `hookParseFailures 0` / `unknownEvents {}` / `errorCount 0`。

`phase` が `waiting_input` なのは正しい。メインのターンは `Stop` →
`Notification(idle_prompt)` で人間の入力待ちに入っており、その裏で
バックグラウンドのサブエージェントが動いている状態である。

### 2.4 `/api/health`

```json
{ "ok": true, "uptime": 1, "clients": 0, "errorCount": 0 }
```

### 2.5 SSE

```
$ curl -s --max-time 2 -H 'Cookie: <valid>' -H 'Accept: text/event-stream' .../api/stream
bytes received: 25677
frames: 3

retry: 2000

event: snapshot
data: {"ok":true,"generatedAt":"2026-09-02T14:56:51.918Z","serverNow":1788361011918,
       "revision":212,"counts":{"total":1,"live":1,"busy":0,"waiting":1,"agentsRunning":2},
       "stats":{"hookEvents":208,...,"errorCount":0,...},"sources":{...}, "sessions":[...]}
```

接続直後に `retry: 2000` と `event: snapshot` が届き、2秒の間に
（実セッションが動いていたため）計3フレームを受信した。
`test/server.test.js` の「a change on disk is pushed to a connected client」でも、
接続中に events ファイルへ `Notification(permission_prompt)` を書き足すと
新しい `snapshot` が push され、`phase` が `waiting_permission` になることを
確認している。

### 2.6 日付ロールオーバー（実地）

最終確認は 00:08 JST に走ったため、実データで日付跨ぎを踏んだ。

```
"activeDates": ["2026-09-02", "2026-09-03"]
"hookEvents": 378, "hookParseFailures": 0, "errorCount": 0
```

`primeDates()` の「01:00 より前に起動したら前日も読む」が実際に効き、
前日分のイベント（それまでの全履歴）と当日分の両方を読んで
`phase` が正しく `waiting_input` のままだった。合成テスト
（`test/collector.test.js` の 00:30起動 / 23:59→00:00）と実地の両方で確認できた。

### 2.7 停止

```
server exited: SIGTERM
port 47399 free: true
```

SIGTERM で SSE を全切断 → collector のタイマ停止 → listener close → exit 0。
ポートは解放済み（TCP接続を試みて ECONNREFUSED を確認）。
**確認用に起動したサーバは残っていない。**

---

## 3. CLI の時刻表示

```
$ node src/cli.js events --limit 5
events for 2026-09-02 (available: 2026-09-02)
162 event(s), 0 parse failure(s)  [times: local Asia/Tokyo]

TIME          EVENT        SESSION   AGENT     DETAIL
------------  -----------  --------  --------  ------
23:50:20.465  PreToolUse   11111111  a3a3a3a3  Edit
```

`--utc` を付けると従来どおり `TIME(UTC)` 列で `14:50:20.465` になる。
`--json` の出力には `timezone` フィールドを足した（値は `Asia/Tokyo`）。

---

## 4. 実装中に判明した、M1/M0 の想定と違った事実

1. **【重要】`SubagentStart` はほとんど発火しない。**
   2026-09-02 の実イベント（203件）の内訳:

   ```
   84 PreToolUse / 80 PostToolUse / 29 SubagentStop / 4 Stop / 4 Notification
    2 UserPromptSubmit / 2 PostToolUseFailure / 1 SubagentStart
   ```

   `SubagentStop` 29件に対し `SubagentStart` は **1件だけ**。
   さらに `SubagentStop` の `agent_type` は**空文字列 `""`** で届く:

   ```json
   {"hookEventName":"SubagentStop","agent_id":"a5a5a5a5a5a5a5a5a","agent_type":"",
    "agent_transcript_path":"...\\subagents\\agent-a5a5a5a5a5a5a5a5a.jsonl", ...}
   ```

   一方 `SubagentStart` にはちゃんと入る:

   ```json
   {"hookEventName":"SubagentStart","agent_id":"a3a3a3a3a3a3a3a3a",
    "agent_type":"general-purpose", ...}
   ```

   結果、多くのサブエージェントは「終わった」ことしか判らず `agentType` と
   `startedAt` が null になる。`state.js` は agent_id 付き `PreToolUse` の初回で
   `startedAt` を補うが、それも無ければ経過時間は出せない。
   **M3 のツリービューでは `meta.json`（`session-index.listSubagents` の
   `agentType` / `spawnDepth` / `parentAgentId`）を併用しないと種類が埋まらない。**
   （推測: `SubagentStart` が少ないのは、hooks を登録した 13:5x より前に起動していた
   エージェントの停止が拾われているためと、`Agent` ツールの非同期起動が
   `SubagentStart` を出さない経路を持つため。ソース未確認。）

2. **`Notification` の payload には `message` が入る。**
   `{"notification_type":"idle_prompt","message":"Claude is waiting for your input"}`。
   M1 の `normalizeEvent` はこれを拾っていなかったので、フィールドを1つ足した
   （既存の戻り値は変えていない）。

3. **hook payload には未記載のフィールド `scratchpad_dir` がある。**
   全イベント共通で入っている。`effort: {level: "xhigh"}` も実在した
   （m0 の共通フィールド一覧どおり）。`Stop` には `background_tasks` と
   `session_crons`（どちらも空配列）が付く。

4. **transcript の `ai-title` レコードの形は
   `{"type":"ai-title","aiTitle":"…","sessionId":"…"}`** で、`timestamp` を持たない。
   M1 の parser は `type` を数えるだけで値を拾っていなかったので `aiTitle` を足した。
   現行セッション（11111111）には ai-title が1件も無く、タイトルは cwd 末尾の
   「Claude監視」にフォールバックしている。別セッション dddddddd には
   `"aiTitle":"Claude Code監視システム"` が実在する。

5. **`readLiveSessions` の既定 `checkProcStart:true` は PowerShell を spawn する。**
   2秒ポーリングで毎回呼ぶと常時 PowerShell が立つので、collector は
   通常のティックを `checkProcStart:false` にし、60秒に1回だけ true にしている。

6. **`JsonlTail.read()` は初回にファイル全体を読む。** これは仕様どおりで、
   `message.id` dedupe（最後の行が正）を壊さないために必要。稼働セッションの
   35MB transcript でも初回だけの負担で、以降は stat 1回で済む。

7. **CSP `style-src 'self'` は CSSOM を止めない。** ゲージの幅は
   `el.style.width = "34%"` で設定している。ブロックされるのは
   マークアップ上の `style=` 属性と `<style>` 要素で、`setAttribute('style', …)` は
   避けている。

---

## 5. コードレビューでの指摘と対応

`feature-dev:code-reviewer` に新規8ファイルの静的レビューを依頼し、2件の指摘を受けて修正した。

**[Medium] prune が4つのポーラのうち1つにしか繋がっていなかった**
`pruneSessions()` を `pollHooks()` の中だけで呼んでいた。
しかしセッションが「終了扱い」になる経路は hooks だけではない。
`pollSessions()` の `applySessions()` は、`sessions/<pid>.json` が消えた
＝**クリーンな `SessionEnd` を出さずに死んだプロセス**を `alive:false` にする経路であり、
まさにこのフォールバックが必要な状況（端末を閉じた・強制終了した）では
hooks が1件も飛ばない。その間、上限を超えてセッションと `UsageCollector` が
溜まり続け、`/api/state` と SSE のペイロードが際限なく膨らむ。

→ `prune()` をメソッドに切り出し、**デバウンスされた emit の直前**で呼ぶようにした。
どのポーラが状態を動かしても、250ms に1回だけ prune が走る。
回帰テスト3件を追加（hooks なしで sessions ポーラだけを動かして prune を確認、
`markChanged()` 経由の prune、稼働中セッションは何歳でも残ること）。

**[Low] クライアント側の通知トラッキング Map が縮まなかった**
`public/app.js` は消えたセッションのカードDOMは掃除していたが、
`seenNotification` / `seenStop` / `lastNotified` の3つの Map は
タブを開いている限りセッションIDが増え続けるだけだった。

→ カードの掃除と同じ場所で `forgetSession(id)` を呼ぶようにした。

**指摘なしと確認された範囲**: `auth.js` / `server.js` のルーティングとオリジン検証、
`sse.js` のクライアント集合とping、`state.js` の不変更新（`agents` /
`notifications` の shallow copy 漏れ無し）、`app.js` の CSP 適合と
EventSource 再接続、`index.html` / `style.css`。
（レビュアは `el.style.<prop> = value` が `style-src` の対象外であることを
MDN で裏取りしている。第4章7項と一致。）

---

## 6. レビュー対応（2026-09-03）

セキュリティ・堅牢性レビューで挙がった6件をすべて修正し、回帰テストを33件追加した。
`npm test` → **283件 pass / 0 fail**（63スイート）。

### F1 [High] プロセスのクラッシュ耐性

**(a) `serve` に `uncaughtException` / `unhandledRejection` のハンドラ**
（`src/server.js` の `installCrashHandlers()`、`cli.js` の `cmdServe` から呼ぶ）。
監視ツールが**黙って消えるのが最悪**で、ユーザーは古いタブを見て「異常なし」と
思い続けてしまう。よって、理由を stderr に出す → collector の
`recordError` に記録 → listener を close してポートを解放 → **exit 1** とした。
握り潰して続行はしない（uncaught の先はプロセス状態が不明で、
不明な状態から報告する監視こそが防ぎたい失敗そのものだから）。
3秒で応答しない close は諦めて終了する。

実プロセスでの確認（空きポート 47390/47391、確認後に終了しポート解放済み）:

```
--- throw ---
server listened first : true (reachable: true)
exit code             : 1
stderr: uncaughtException: Error: synthetic uncaught exception
port free after exit  : true

--- reject ---
server listened first : true (reachable: true)
exit code             : 1
stderr: unhandledRejection: Error: synthetic unhandled rejection
port free after exit  : true
```

**(b) 各 `setInterval` コールバックを `safeTick(where, fn)` で包んだ**
（`src/collector.js`）。`setInterval` の中で投げられた例外には catch 先が無く、
そのまま uncaughtException になってプロセスが死ぬ。個々の I/O は既に守って
あったが、その間のコード（状態畳み込み、パス結合、将来の1行）は無防備だった。
同期の throw も Promise の reject も `tickErrors` カウンタ＋`recordError` に
統一し、`errorCount()`（UIの「取込エラー」）にも合算する。
`void this.pollSessions(...)` は `safeTick` 経由になったので拒否も拾える。
`applySessions` / `applyStatusline` / 1件ごとの `reduce` にも個別の try/catch を
足した（1件の壊れたイベントが日次ファイルの残り全部を止めないように）。

**(c) listener に恒久的な `'error'` ハンドラを残した**（`src/server.js`）。
listen 成功後に外していたため、後から来る `error`（EMFILE で fd が尽きる、
accept 時の ECONNABORTED）が EventEmitter に再スローされて落ちる状態だった。
bind 失敗を reject する `once` とは別に、記録だけする恒久ハンドラを
listen 前に付ける。

**(d) 通常の GET/HEAD でも `req` / `res` に `'error'` を付けた**。
ブラウザのタブを閉じるだけでプロセスが落ちてはいけない。
ECONNRESET / EPIPE は日常なので `recordError` にだけ残し、
UI の「取込エラー」には数えない（データが壊れているという意味ではないため）。

### F2 [Medium] `prune()` がファイル単位の記録を解放していなかった

`this.usage` しか掃除しておらず、`this.transcriptTail`（`JsonlTail.states`）と
`this.indexBySession` はプロセスが生きている限り増え続けていた。

- `prune()` は、**state から消す前に** `filesForSession(id)` でファイル一覧を
  取ってから、`transcriptTail.reset(file)` / `indexBySession.delete(id)` /
  `usage.delete(id)` を行うようにした（順序を逆にすると一覧が取れない）。
- `pollIndex()` は前回の索引に有って今回無いファイル
  （＝Claude Code の30日自動削除。M1 で実測: 171→146ファイル）の
  オフセットも解放する。
- `stats()` に `tailedFiles` と `usageCollectors` を追加して外から見えるようにした。

### F3 [Medium] トークン交換分岐がオリジン検証を通っていなかった

`/?t=<token>` は Cookie 不要な唯一の経路なので、そこだけが
DNS リバインディングで**自分自身に有効な Cookie を発行させられる**穴だった。
分岐の先頭で `auth.checkOrigin(req)` を通し、失敗は 403（本文固定）にした。

```
$ curl -o NUL -w '%{http_code}' -H 'Host: attacker.test' 'http://127.0.0.1:47393/?t=<token>'
403
```

### F4 [Medium] SSE のテストが無かった

`test/sse.test.js` を新規追加（14件、上の表を参照）。`res` をスタブ化して
ソケット無しで検証している。

### F5 [Low] クリックジャッキング対策

`securityHeaders()` に `X-Frame-Options: DENY` を、CSP に
`frame-ancestors 'none'` を追加。`SameSite=Strict` は Cookie が
クロスサイト要求に付くのを防ぐが、**既に認証済みのページを frame に入れて
測る**攻撃は防げないので、両方要る。全レスポンスで確認済み:

```
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'
```

### F6 [Low] HEAD にボディを返していた

`send(req, res, ...)` に集約し、HEAD では **GET と同じヘッダ（`Content-Length`
込み）を返してボディを書かない**（RFC 9110）。`/api/stream` への HEAD は
405（`Allow: GET`）にした ── 誰も読まない購読を開いて8枠の1つを
占有させないため。

```
$ curl -I -H 'Cookie: <valid>' .../api/state
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 13545     <- ボディは0バイト

$ curl -o NUL -w '%{http_code}' -I -H 'Cookie: <valid>' .../api/stream
405
```

### 再確認

修正後に実データで `serve` を通しで確認（ポート 47393、確認後に SIGTERM で停止、
`port free: true`）。`/api/state` は従来どおり現行セッションを
`phase:"waiting_input"` / `phaseSource:"hooks"` / `rateLimits` 入りで返し、
`stats` に新しい `tickErrors: 0` / `tailedFiles: 8` / `usageCollectors: 1` が出る。
`errorCount` は 0 のまま。**確認に使ったサーバは全て停止済み**（LISTENING なし）。

---

## 7. ブラウザ確認後の修正（2026-09-03）

ユーザーが実際にブラウザで Live ビューを開き、描画・SSE・通知一覧が正常に動くことを
確認したうえで、スクリーンショットから7件の問題が挙がった。すべて修正し、
回帰テストを33件追加した。`npm test` → **316件 pass / 0 fail**（68スイート）。

### 7.1 幽霊エージェント（最重要）

**症状**: AGENTS に `▶ a1a1a1a1 1h 13m 1 tools` が実行中として残り、
ヘッダの「エージェント」もそれを数えていた。

**実データの確認**（`%USERPROFILE%\.claude-monitor\events\2026-09-02.jsonl`）:

```
2026-09-02T14:39:42.411Z PreToolUse   agent_id=a1a1a1a1a1a1a1a1a tool_name=Bash
2026-09-02T14:56:54.199Z PostToolUse  agent_id=a1a1a1a1a1a1a1a1a
```

- `SubagentStart` **なし**、`SubagentStop` **なし**、`subagents/` に
  `agent-a1a1a1a1...` のファイルも `meta.json` も**なし**。
- **報告と1点違った**: 依頼文には「PostToolUse も無く」とあったが、実際には
  **17分12秒後に PostToolUse が届いている**。つまりツールは正常に終わっており、
  欠けているのはエージェントのライフサイクル・イベントだけだった。
  （推測: 子エージェントが起動した孫エージェントで、`SubagentStart`/`Stop` の
  hook が発火しない経路を通った。第4章1項の「SubagentStart はほぼ発火しない」と
  同根と思われる。ソース未確認。）

この「17分12秒」は設計に直接効く事実である。**15分のツールタイムアウトは
実データで誤検知する**。したがって、タイムアウトは
「currentTool の表示を下ろすだけ」の可逆な操作に限定し、
エージェントの生死判定とは分離した。

**実装**（`src/state.js` の `sweepStale()`、`src/collector.js` の `sweep()`）:

| 規則 | 既定 | 効果 |
|---|---|---|
| (a) `PreToolUse` から `PostToolUse` が来ないまま経過 | 15分（`toolTimeoutMs`） | `currentTool` を解除、`stats.toolTimeouts` に加算 |
| (b) エージェントが無音で、実行中ツールも無い | 10分（`agentStaleMs`） | `status: "stale"` / `statusSource: "inferred"`、`agentsRunning` から除外 |
| (c) `subagents/agent-<id>.jsonl` の mtime が新しい | 10分以内 | **生存の積極的証拠**として (b) を打ち消す。ファイルが無ければ (b) のみ |
| (d) 後から `SubagentStop` | - | `stale` → `completed`（`statusSource: "hooks"`） |
| (e) 後から任意の hook イベント | - | `stale` → `running` に復帰 |
| (f) セッションが `ended` / `dead` | 即時 | 配下のエージェントを `stale`（`staleReason: "session-over"`） |

**すべて推定であって事実ではない**ので、そう表示する。UI は `✓`（完了）ではなく
`?` と「終了と推定」を出し、色も落とす。(e) があるおかげで誤検知は自己修復する
——(a) が17分のツールを誤って切っても、その後の `PostToolUse` で元に戻る。

`toolTimeouts` / `agentsStale` は `stats()` に出るが、**`errorCount` には
加算しない**。取り込みの失敗ではなく、こちらの推定だからである。

### 7.2 エージェントの表示名

`agent_type` は `SubagentStop` で空文字列になる（第4章1項）ため、ID が
そのまま出ていた。`subagents/agent-<id>.meta.json` を優先し、
`description（agentType）` の形で出す。meta が無いときだけ短縮 ID。

meta は `session-index.listSubagents()` が既に読んでいるので、
30秒ごとの索引更新（`pollIndex`）から `applyAgentMeta()` に流すだけで済んだ。
**既存のエージェント記録を補強するだけで、新規には作らない** ——
`subagents/` にはそのセッションが過去に起こした全エージェントが残っており、
全部カードにすると実行中のものが埋もれるため。

実データでの効果:

```
before: ▶ a3a3a3a3
after : ▶ Implement M2 server and Live view（general-purpose）  Opus
```

### 7.3 rate limits の復帰時刻に日付

7D の「復帰 06:00」は今朝と読めてしまい、待ち時間を大幅に過小表示していた。
`resets_at` がブラウザの今日でなければ `9/9 06:00` の形にする
（5H が日付をまたぐ場合も同じ経路で解決する）。

### 7.4 TOKENS に cache作

`cache_creation_input_tokens` を `cache作` として追加。合計には元から
含まれていた（`usageTotal` は課金対象4指標すべてを足す）ので、内訳の表示だけの変更。

### 7.5 ヘッダの「要対応」

0件のときは無彩色のまま、1件以上でカードのバッジと同じアンバー
（`--wait`）にする。ページ全体の「色が付いたら呼ばれている」という規則に揃えた。

### 7.6 セッションタイトルの不安定さ

**症状**: 画像付きメッセージを送るとタイトルが `Claude監視`（cwd 末尾）から
`Image #1` に変わった。

**原因は当方のプロンプト流用ではなかった。** `UserPromptSubmit` の `prompt` は
どこにも使っていない。実データを見ると、**Claude Code 自身が transcript に
`{"type":"ai-title","aiTitle":"Image #1"}` を書いている**:

```
$ grep -o '"type":"ai-title"[^}]*}' <session>.jsonl | tail -3
"type":"ai-title","aiTitle":"Image #1","sessionId":"11111111-..."
"type":"ai-title","aiTitle":"Image #1","sessionId":"11111111-..."
"type":"ai-title","aiTitle":"Image #1","sessionId":"11111111-..."
```

つまり ai-title は最新プロンプトから再生成されており、添付だけの
メッセージでは添付のプレースホルダがそのまま題になる。

**対策**: 優先順位（(1) ai-title、(2) cwd 末尾）は指示どおりに保ちつつ、
**プレースホルダ的な ai-title を受け付けない**ようにした
（`isUsefulTitle()`: `Image #1` / `[Image #2]` / `Screenshot` /
`[Attachment]` などを拒否）。拒否した場合は **null で上書きせず値を捨てる**ので、
直前の良いタイトルが残り、一度も無ければ cwd 末尾に落ちる。

最新プロンプトは別行「最新プロンプト」として先頭80文字を薄色で出す
（改行は空白に潰す、`textContent` のみ）。状態側は200文字で切って
スナップショットが膨らまないようにしてある。

### 7.7 サブエージェントのモデル

`/api/state` の agents 要素に `model` と `modelSource` を追加。

| 優先 | 情報源 | 実データでの形 | 備考 |
|---|---|---|---|
| 1 | `meta.json` の `model` | `"opus"` / `"sonnet"` | 7件中6件に存在。spawnDepth=2 の1件には無い |
| 2 | 子の jsonl の最新 `assistant` の `message.model` | `"claude-opus-5"` / `"claude-sonnet-5"` / `"claude-haiku-4-5-20251001"` / `"claude-fable-5"` | 既に差分 tail しているので追加コストはほぼ無い |
| 3 | どちらも無ければ | 表示しない | |

meta が必ず勝つ。transcript 由来の値が meta を上書きすることはない
（`applyAgentMeta` が `modelSource` を見て弾く）。

表示名は**テーブル駆動**（`MODEL_LABEL`）。末尾のリリース日付
（`-20251001`）だけ剥がしてから引き、**引けなければ ID をそのまま出す**。
勝手な整形はしない。

### 7.8 再確認（実データ、ポート 47392、確認後に停止）

```json
"counts": { "total": 1, "live": 1, "waiting": 1, "agentsRunning": 1 },
"stats":  { "toolTimeouts": 1, "agentsStale": 1, "errorCount": 0 },
"title":  "Claude監視",
"lastPrompt": "（プロンプト本文は省略）",
"agents": [
  { "agentId": "a1a1a1a1a1a1a1a1a", "label": "a1a1a1a1",
    "status": "stale", "statusSource": "inferred", "staleReason": "silent" },
  { "agentId": "a3a3a3a3a3a3a3a3a",
    "label": "Implement M2 server and Live view（general-purpose）",
    "model": "opus", "modelSource": "meta",
    "status": "running", "statusSource": "hooks" }
]
```

- **幽霊 `a1a1a1a1` は `running` ではなくなった**（`stale` / 推定）。
- `agentsRunning` は **0 ではなく 1** だが、残っている1件は
  `a3a3a3a3a3a3a3a3a` ＝ **この作業を実行しているエージェント本人**で、
  実際に稼働中である。幽霊だけが消え、本物は残るという期待どおりの結果。
- タイトルは ai-title が `Image #1` のままでも `Claude監視` で安定している。
- `errorCount` は 0（推定は失敗ではないので加算されない）。
- 確認後 SIGTERM で停止、`port 47392 free: true`。

### 7.9 テスト（33件追加）

- `test/state.test.js`（45→64）: 実測どおりのイベント列で作った幽霊が
  stale になり `agentsRunning` が 0 になること、無音期間内なら running のままで
  あること、子 jsonl が新しければ stale にしないこと、後から `SubagentStop` で
  completed に、任意の hook で running に戻ること、17分ツールの反例、
  セッション終了で即 stale、二重掃引で二重計上しないこと。
  meta と transcript のモデル優先順位、未知エージェントの meta を無視すること、
  ラベルの段階的な劣化。プロンプトがタイトルにならないこと、
  プレースホルダ ai-title の拒否、`excerpt` の整形。
  **時刻はすべて注入**しており `setTimeout` に依存しない。
- `test/collector.test.js`（20→26）: `sweep()` が実際に `agentsRunning` を
  減らすこと、`start()` が一度掃引するので最初のスナップショットから
  幽霊が出ないこと、閾値が設定可能なこと、meta.json からの補強、
  meta に model が無いとき transcript から取ること、
  プロンプトで title が変わらないこと。
- `test/server.test.js`（40→48）: 配信された `app.js` / `index.html` /
  `style.css` に対して、日付付き復帰時刻・`cache作`・要対応の強調・
  最新プロンプト行・stale の別記号・モデルのテーブル駆動が実際に入っていること、
  および禁止 DOM シンクとインライン要素が増えていないこと。

---

## 8. 未解決の問題 / 次にやるべきこと

- **サブエージェントの種類が埋まらない**（上記 4-1）。M3 で `meta.json` と
  hooks を突き合わせて解決する。`SubagentStop` の `agent_type: ""` は
  上流の挙動なので、こちらで補うしかない。
- **メモリ上限は入れたが、値は暫定。** 1セッションで完了エージェントが13件溜まったので、
  完了サブエージェントは1セッションあたり30件、終了・停止セッションは50件で
  古い順に捨てる（実行中・稼働中は絶対に捨てない）。UI 側はさらに
  「実行中の全部＋完了の直近3件」しか描かない。M3 で実運用の増え方を見て調整する。
- **ブラウザでの実描画は 09-03 に確認済み**（描画・SSE・通知一覧が正常。
  そこで見つかった7件は第7章で修正した）。ただしこの環境にブラウザが無いため、
  修正後の見た目は再確認できていない。特に第7章で足した
  「最新プロンプト」行・エージェントのモデル表示・stale の `?` 表記は
  実機で一度見ること。
- **通知の実挙動（Web Notifications）は未検証。**
- **`SubagentStart`/`Stop` が飛ばない経路が存在する。** 第7.1章の
  `a1a1a1a1a1a1a1a1a` がその実例で、いまは時間による推定で処理している。
  Claude Code 側の条件（推測: 孫エージェント）を特定できれば、
  推定ではなく事実で判定できる。
- 死んだ PID の `sessions/<pid>.json` が残るのかは M1 から持ち越しのまま。
  `applySessions` は「一覧から消えたら dead」という扱いも入れてあるので、
  どちらの挙動でも `dead` になるようにはしてある。
- `tools` サブコマンドの `TIME(UTC)` 列と `list` の `modified` 列は UTC のまま
  （M2 の指示は `events` のみ）。揃えるなら M3 で。
- ポート衝突は検証済み。占有中のポートを指定すると collector を止めてから

  ```
  error: port 47398 is already in use - another claude-monitor may be running. Use --port N or CLAUDE_MONITOR_PORT.
  ```

  を stderr に出して exit 1 する（プロセスは残らない）。
