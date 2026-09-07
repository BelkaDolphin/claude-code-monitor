# M3 動作確認ログ（2026-09-03）

対象: `src/tree-merge.js`（新規・純粋関数）/ `src/tree-view.js`（新規・I/Oとキャッシュ）/
`src/server.js`（3エンドポイント追加）/ `src/tree.js`（ai-title 取得を1行追加）/
`src/cli.js`（`tools` と `list` の時刻をローカルへ）/ `public/{index.html,app.js,style.css}`。

環境: Windows 11 Pro 10.0.26200 / Node v24.13.0 / Claude Code 2.1.258 / `Asia/Tokyo`。
外部npm依存はゼロのまま。

---

## 1. テスト結果

```
$ npm test
ℹ tests 419
ℹ suites 91
ℹ pass 419
ℹ fail 0
ℹ duration_ms 1023
```

M2 までの **316件は全て pass のまま**。M3 で 103件追加した
（実装時 94件 ＋ コードレビュー指摘で 6件〈第8章〉＋ 表示レビュー指摘で 3件〈第9章〉）。

| ファイル | 件数 | 内容 |
|---|---|---|
| `test/tree-merge.test.js`（新規） | 40 | 3源のマージ規則を1つずつ固定。status の優先順位（hooks > stale推定 > jsonl推定、ただし `tool_result` の事実は stale 推定に負けない）、`agent_type: ""` を絶対に採用しないこと、agentType/description/model の meta > hooks > transcript、startedAt の hooks > 子jsonl > 起動 tool_use、endedAt が「終了扱いのときだけ」transcript から来ること、負の所要時間・パース不能な時刻が null になること、startedAt 昇順（null は最後）、深さ2のネスト、親不明の orphan、**hooks にしか存在しないエージェント**（`a458ad0670a1f500e` の再現）、ルートのタイトル規則（プレースホルダ拒否）、トークン名の写像、`mergeTree()` を引数なしで呼んでも落ちないこと |
| `test/tree-api.test.js`（新規） | 46 | 合成した projects ツリーと events で実サーバを起動。ID の厳格検証（UUID / 17桁hex）、`clampInt`、新3ルートにも Cookie・Origin・Host・Sec-Fetch-Site が効くこと、POST が 405、HEAD に本文が無いこと、`days` のクランプと**稼働セッションが期間で消えないこと**、ネストと3源マージの実際の出力、`?agent=` の絞り込みと `main`、`limit` のクランプと**末尾**が返ること、不正IDと未知IDが同じ 404 JSON であること、キャッシュのフィンガープリント（本体・サブエージェント・meta数のどれが動いても変わる／並び順では変わらない）、LRU の追い出し、`toolUseIndex` を捨ててからキャッシュしていること、ツールログの遅延生成、索引の TTL、`HookHistory` の畳み込みと欠損ディレクトリ耐性、**ツリー生成で例外が出ても 500 JSON を返してサーバは生き続けること**、後から書かれた meta.json が索引の再構築を待たずに反映されること、**配下のファイルが消えても 200 を返しサーバが生き続けること**（8.1 / 8.2） |
| `test/server.test.js`（追記） | +17 | 配信された HTML に3ペインの id が揃い、プレースホルダが消えていること、クライアントが3エンドポイントだけを叩くこと、2秒デバウンス＋「見えているタブだけ」更新、`<ul>/<li>` と `aria-expanded` の実体、推定を事実として描かないこと（`?`/「終了と推定」/「無音からの推定」/`FIELD_SOURCE_LABEL`）、構造が変わった時だけ DOM を組み直すこと、localStorage が try/catch で包まれタブ・セッション・期間が復元されること、Live カードの Tree ボタン、**インラインscript/style/ハンドラと禁止DOMシンクが無いこと**、CSS が外部を一切参照しないこと、配色規律（アンバーは要対応のみ）、Tree ボタンが一覧を二重取得しないこと、デバウンス発火時にもタブの可視判定をすること（8.3 / 8.4） |

`test/tree-api.test.js` の collector も一時ディレクトリだけを見る。
`~/.claude` と `~/.claude-monitor` の実データには触れていない。

---

## 2. 実データで確認した形式

### 2.1 ID の形

厳格な正規表現でルートを検証するので、推測ではなく数えた。

```
$ find ~/.claude/projects -name "agent-*.jsonl" | sed 's/.*agent-//;s/\.jsonl//' | awk '{print length}' | sort | uniq -c
     82 17
$ ... | grep -vE '^[0-9a-f]{17}$' | wc -l
      0
```

- **セッションID = UUID**（`session-index.js` が M1 から使っている `UUID_RE` と同じ）。70セッション全て一致。
- **エージェントID = 小文字hex ちょうど17桁**。82ファイル全て一致。先頭は全て `a` だったが、
  これは1文字のサンプルバイアスの可能性があるので**先頭文字は検証条件に入れていない**。

`SESSION_ID_RE` / `AGENT_ID_RE`（`src/tree-view.js`）はこの実測に基づく。

### 2.2 `meta.json` は時刻を一切持たない（重要）

82個の `agent-<id>.meta.json` の全キーを数えた:

| キー | 出現 |
|---|---|
| `agentType` | 82 |
| `description` | 82 |
| `toolUseId` | 82 |
| `spawnDepth` | 82（値は 1 か 2 のみ） |
| `model` | 67（`sonnet` / `opus` / `haiku`） |
| `worktreePath` | 15 |
| `worktreeBranch` | 15 |
| `parentAgentId` | 13 |
| `spawnedWithWorktree` | 8 |

**時刻を表すキーは0個。** したがって「meta.json から開始時刻を取る」ことはできない。
開始時刻の優先順位が hooks → 子jsonl の最初のレコード → 起動した `tool_use` の
timestamp、という3段になっているのはこのためである。
M2 の第4章1項「サブエージェントの種類と開始時刻を確実に取るには meta.json が要る」は
**種類については正しく、開始時刻については誤り**だった。ここで訂正する。

### 2.3 新発見: SubagentStop があるのに transcript が消えているエージェントがある

セッション `ea1b82f5` を実データで開いたところ、hooks は **31体**のエージェントを
知っているのに `subagents/` には **7体**分のファイルしか無い。差分の30体は全て
`SubagentStop` を出しており、そのイベントは `agent_transcript_path` まで持っている:

```
SubagentStop agent=afc4633feea1e4761 session=ea1b82f5-... type="" 
             tp=...\ea1b82f5-...\subagents\agent-afc4633feea1e4761.jsonl
```

```
$ ls ~/.claude/projects/D--develop-Claude--/ea1b82f5-.../subagents/agent-afc4633feea1e4761.jsonl
No such file or directory
$ find ~/.claude/projects -name "agent-afc4633feea1e4761*"      # 全projects を検索
（0件）
```

つまり **Claude Code はサブエージェントの transcript を消す**（親セッションの
transcript は残っている）。既知の制約7「30日で消える」とは別の話で、
数時間で消えている。条件は未特定（推測: 完了したサブエージェントの後始末。ソース未確認）。

実装への影響: 「transcript に無いエージェント」は例外ではなく**普通にある**。
`mergeTree` は hooks にしか無いエージェントにもノードを作り、
親が判らないので `orphans` に入れて `origin: 'hooks'` を立てる。
UI は既定で閉じた `<details>`（「親が特定できないエージェント」）に入れる ——
30体をツリー本体に混ぜると実際の親子関係が読めなくなるため。

### 2.4 幽霊エージェント `a458ad0670a1f500e` の描画

M2 第7.1章で見つけた、`PreToolUse` と `PostToolUse` が1件ずつだけで
`SubagentStart` も `SubagentStop` も `meta.json` も transcript も無いエージェント。
実サーバ経由での出力:

```
ghost a458ad0670a1f500e:
  status=stale  statusSource=inferred  statusDetail=session-over
  origin=hooks  startedAt=2026-09-02T14:39:42.411Z  transcriptPath=null
  toolCount=1（toolCountSource=hooks）
```

`startedAt` は `SubagentStart` ではなく**最初の `PreToolUse`** から来ている
（`state.js` の `reduce` が `PreToolUse` で `startedAt` を補う経路）。
`statusDetail: "session-over"` は「セッション自体が終了しているので配下も終了とみなした」
という意味で、無音タイムアウトではない。UI は `?` と「終了と推定」で出し、
詳細パネルの「状態」行に根拠（`無音からの推定（session-over）`）を書く。

### 2.5 セッションタイトル

`ea1b82f5` の transcript には `{"type":"ai-title","aiTitle":"Image #1"}` が
最後に書かれている（M2 第7.6章）。ツリーのルートも Live と同じ
`state.isUsefulTitle()` で弾き、cwd 末尾の `Claude監視` に落ちることを実データで確認した。

---

## 3. 実測した所要時間

### 3.1 パース（`buildTree` / `buildToolLog`、同期）

実データ全66セッションのうち大きい順に5つ。`bytes` は本体＋全サブエージェントの合計。

| セッション | サイズ | ファイル数 | `buildTree` | `buildToolLog` | ノード | ツール呼び出し |
|---|---|---|---|---|---|---|
| `d1c5d494` | 34.2 MB | 18 | **248 ms** | 208 ms | 18 | 3000 |
| `1f91c036` | 21.9 MB | 13 | 131 ms | 130 ms | 13 | 1967 |
| `81626617` | 21.7 MB | 20 | 137 ms | 143 ms | 20 | 1788 |
| `ea1b82f5` | 9.2 MB | 8 | 49 ms | 49 ms | 8 | 661 |
| `dd79b43f` | 7.4 MB | 4 | 46 ms | 44 ms | 4 | 720 |

**最大でも 0.25 秒**で、計画時に懸念した「1〜2秒イベントループを止める」には
ならなかった。したがって worker_threads は入れていない（同期 + キャッシュのまま）。

### 3.2 HTTP 経由（実サーバ、`/api/tree/<id>`）

| 対象 | 初回 | 2回目 |
|---|---|---|
| `ea1b82f5`（9.2 MB / 8ファイル） | 68 ms（うちパース 63 ms） | **2 ms**（キャッシュ命中） |
| `d1c5d494`（34.2 MB / 18ファイル） | 251 ms（うちパース 206 ms） | - |
| `/api/sessions`（66セッション） | 100 ms（索引構築込み） | 索引はTTL 2秒で再利用 |

### 3.3 補助的な読み取り

| 対象 | 実測 |
|---|---|
| `buildSessionIndex({days:0, withCwd:true})` | 91 ms / 70セッション / 31プロジェクトdir |
| `buildSessionIndex({days:0, withCwd:false})` | 28 ms |
| `HooksIngest.readAll()` 初回（5.3 MB / 2日分 / 1090イベント） | 41〜47 ms |

`HooksIngest` はバイトオフセット差分なので2回目以降は stat のみ。

---

## 4. 作ったもの

### 4.1 サーバ

| ルート | 返すもの |
|---|---|
| `GET /api/sessions?days=N` | 左ペインのセッション一覧。`days` は既定30・1〜90にクランプ。**稼働中のセッションは期間で消さない**。稼働 → 更新日時降順で並ぶ |
| `GET /api/tree/<sessionId>` | 3源をマージしたツリー1本（`root` / `orphans` / `agentCount` / `hooksOnly` / `parse`） |
| `GET /api/tools/<sessionId>?agent=<agentId>&limit=N` | ツール実行ログの末尾。`limit` は既定100・1〜500。`agent=main` で親スレッドのみ |

全て既存の Cookie / Origin / Host / Sec-Fetch-Site 検査を通り、GET/HEAD 以外は 405。
**不正な形式のIDも未知のIDも同じ 404 JSON `{ok:false,error:"not found"}`** を返す
（400 と 404 を書き分けると「その形は正しいID形式だ」と教えることになるため）。
`..` を含むパスはそれより手前の `routeKey()` が既存どおり弾く（本文 `not found` のテキスト）。

例外は `guard()` が捕らえて 500 JSON にし、`collector.recordError` に積んでプロセスは
生き続ける（アーキテクチャ 4.7）。

### 4.2 モジュールを2つに分けた

計画は `src/tree-merge.js` 1本だったが、既存の「純粋なもの（`state.js`）とI/Oするもの
（`collector.js`）を分ける」流儀に合わせて分割した:

- `src/tree-merge.js` — **純粋**。`mergeTree()` と各優先順位の解決関数。ディスク・時計・
  グローバルを一切触らないので、40件のテストが全て合成データで書けている。
- `src/tree-view.js` — I/O とキャッシュ。`TreeCache` / `SessionIndexCache` /
  `HookHistory` / `buildTreeView` / `toolLogView` / `listSessionsView` と ID 検証。

### 4.3 キャッシュ

| 何 | キー | 無効化 |
|---|---|---|
| パース済みツリー | 本体jsonlの `size+mtime` ＋ 全サブエージェントjsonlの `size+mtime` ＋ meta.json の個数 | ディスクの1バイトが動いたら即。時間では無効化しない |
| ツールログ | 同上（同じスロットに遅延生成） | 同上 |
| セッション索引 | なし（TTL 2秒） | 2秒 |
| hooks履歴 | なし（TTL 2秒、読み取りは差分） | 2秒 |

LRU 8件。**マージ自体はキャッシュしない** —— hooks 由来の半分（実行中/完了、
`currentTool`）は毎秒変わるので、ファイル mtime をキーにしたキャッシュに載せてはいけない。

`buildTree` が返す `toolUseIndex` は全 `tool_use` の `input` を丸ごと持っていて
大きい（3000件のセッションで数MB）。キャッシュに入れる前に、必要な2つ
（起動時刻と起動プロンプト）だけ抜き出して `null` にしている。テストで固定済み。

### 4.4 `HookHistory`（計画外の追加）

collector は**稼働中のセッションしか追わない**。そのままだと先週のセッションの
ツリーは hooks の証跡がゼロになり、`cli.js tree` が `completed` と言うものを
Web UI は `async-unknown` と表示してしまう（実際にそうなった）。

そこで `src/tree-view.js` に `HookHistory` を足した。`HooksIngest.readAll()` +
`reduceAll` + `sweepStale` + `pruneSessions` を回して、collector が知らない
セッションの hooks 状態を必要になった時だけ作る。上限は collector と同じ
（終了セッション50件）。あふれたセッションは transcript だけで描かれる。

サーバは「collector が持っていればそれ、無ければ `HookHistory`」の順で使う。

### 4.5 マージの優先順位（実装した表）

| フィールド | 優先順位 |
|---|---|
| `status` | (1) hooks の証跡（`SubagentStop` → `completed`、tool イベント → `running`）、(2) `tool_result` に裏付けられた transcript の判定（`completed` / `error`）、(3) `sweepStale` の `stale` 推定、(4) transcript の推定（`async-unknown` / `running`） |
| `agentType` | meta.json > hooks（**空文字は無視**） |
| `description` | meta.json > hooks |
| `model` | meta.json > hooks > 子jsonl の `message.model` |
| `startedAt` | hooks（`SubagentStart` か最初の `PreToolUse`）> 子jsonl の最初のレコード > 起動した `tool_use` の timestamp |
| `endedAt` | hooks（`SubagentStop`）> 子jsonl の最後のレコード（**終了扱いのときだけ**） |
| `toolCount` | 子jsonl の `tool_use` 数 > hooks の計数 |

**計画からの1点の変更**: 計画では「hooks > stale推定 > jsonl推定」の3段だった。
そのままだと、終了済みセッションの配下は全て `session-over` で `stale` になり、
`tool_result` が `status:"completed"` と**事実**を言っているエージェントまで
「終了と推定」に落ちる。`stale` はこちらの推定、`tool_result` は transcript に
書かれた事実なので、**`jsonl:tool-result-*` だけは `stale` に勝つ**ようにした。
`async_launched` / `no-tool-result`（どちらも「判らない」の別名）は従来どおり負ける。

各フィールドは `statusSource` / `agentTypeSource` / `modelSource` /
`startedAtSource` / `endedAtSource` / `toolCountSource` を併せて返し、
詳細パネルが「← meta.json」「← hooks」の形でそのまま出す。M1 の
`statusInferred` / `statusSource` と同じ流儀。

### 4.6 画面

左（セッション一覧）／右上（ツリー）／右下（詳細）の3ペイン。

- 一覧は稼働中が先頭、以降は更新日時降順。行はタイトル・状態ドット・cwd末尾・
  「n分前」・サブエージェント数。期間は 7 / 30 / 90 日のセレクタ。
- ツリーは `<ul>/<li>` のネスト。開閉は `<button aria-expanded>`。**既定は深さ2まで展開**。
  行は 状態マーク（`▶` 実行中 / `✓` 完了 / `?` 終了と推定 / `✗` エラー / `·` 完了不明）、
  名前（`description（agentType）`）、モデル短縮名（Live と同じテーブル駆動）、
  経過（実行中は1秒ごと）または所要、トークン合計、ツール数、実行中ツール。
- 親不明のものは閉じた `<details>` に分ける。
- 詳細パネルは ID・状態と根拠・種類・説明・深さ・モデル・開始/終了（**日付付きローカル時刻**）・
  所要・トークン内訳・ツール数・実行中ツール・最終ツール時刻・worktree・transcript パス・
  プロンプト・ツール実行ログ末尾40件。
- 稼働中セッションを選んでいる間は SSE の `snapshot` ごとに再取得（**2秒デバウンス**、
  かつ Tree タブが見えている時だけ）。終了済みは1回だけ取得し、以降は「更新」ボタン。
- Live カードに「Tree」ボタンを追加。押すとタブを切り替えてそのセッションを開く。
- タブ・選択セッション・期間は `localStorage`（try/catch 付き）に保存する。

**プロンプトの出どころ**: 計画では「子jsonl の最初の user メッセージ」だったが、
`parser.js` は設計上メッセージ本文を保持しない（`textLength` だけ）。本文を持たせると
35MB のファイルでメモリが跳ねる。代わりに**起動した `Agent` tool_use の `input.prompt`**
を使う（`toolUseIndex` が `input` を持っているので追加のパースが要らない）。
無ければ meta.json の `description`。

### 4.7 CLI の持ち越し（M2 第8章）

`tools` の `TIME(UTC)` 列と `list` の `MODIFIED (UTC)` 列をローカル時刻にした。
`events` と同じく `--utc` で従来の表示に戻せる。ヘッダ行に
`[times: local Asia/Tokyo]` / `[times: UTC]` を出す。

```
$ node src/cli.js list --days 3
5 session(s) within 3 day(s); 61 older skipped; 30 project dir(s)  [times: local Asia/Tokyo]
SESSION   MODIFIED               KB  SUBS  ...
b5824c60  2026-09-03 19:02:28   233     1  ...

$ node src/cli.js tools ea1b82f5 --limit 3
session ea1b82f5-...: 661 tool call(s), 15 error(s), 0 pending  [times: local Asia/Tokyo]
TIME      TOOL   STATUS    MS  AGENT   INPUT
01:10:45  Bash   ok      4988  (main)  cd "D:/develop/Claude監視" && npm test ...
```

---

## 5. 実サーバでのスモークテスト

自前のポート 47399 で起動し（**ユーザが動かしているサーバには触れていない**）、
全ルートを叩いてから SIGTERM で停止、ポートが解放されたことまで確認した。
ドライバは scratchpad の `smoke.mjs`。リポジトリには置いていない。

```
port 47399 free before start: true
OK   403 without cookie /api/sessions
OK   403 without cookie /api/tree/ea1b82f5-...
OK   403 without cookie /api/tools/ea1b82f5-...
OK   token exchange 302 + cookie
OK   /api/sessions 200            100ms count=66 days=30
     live first: b5824c60(live) ea1b82f5 e2a7ec22
OK   days clamped low / high / default        (0→1, 9999→90, bogus→30)
OK   /api/tree nested 200         cold=68ms(parse 63ms) warm=2ms cached=true
     title=Claude監視 agents=37 hooksOnly=30 orphans=30
       - a04d1504b8 [async-unknown/jsonl:async_launched] M0 local data verification（general-purpose） sonnet
       - af97eb64c6 [async-unknown/jsonl:async_launched] M0 official docs verification（general-purpose） sonnet
       - a4d8ef6226 [async-unknown/jsonl:async_launched] Implement M1 core modules（general-purpose） opus
       - a5b6b7f8ed [async-unknown/jsonl:async_launched] Review M1 core implementation（feature-dev:code-reviewer） sonnet
       - a795e2824a [async-unknown/jsonl:async_launched] Security review of M2 server（feature-dev:code-reviewer） sonnet
       - a25952fdd8 [completed/hooks:SubagentStop] Implement M2 server and Live view（general-purpose） opus 893s
         - a68ec5b2f7 [async-unknown/jsonl:async_launched] Review M2 code（feature-dev:code-reviewer） claude-sonnet-5
OK   ghost a458ad0670a1f500e rendered  status=stale/inferred:session-over origin=hooks
OK   /api/tree biggest 200        d1c5d494 34.2MB files=18 http=251ms parse=206ms agents=17
OK   /api/tools agent-scoped      total=58 allAgents=661 first=Bash
OK   /api/tools limit clamp / bad agent 404
OK   bogus session id 404 / unknown uuid 404 json
OK   cross-site Origin refused / POST 405
OK   /api/health has treeCache + hookHistory
     {"treeCache":{"size":2,"max":8,"hits":3,"misses":2},
      "hookHistory":{"refreshes":1,"eventsRead":1090,"readErrors":0,"sessions":2}}
OK   / serves the dashboard
port 47399 free after stop: true
```

ネストが1段（`a25952fdd8` → `a68ec5b2f7`）実データで正しく描けている。
`a25952fdd8` だけが `completed/hooks:SubagentStop` なのは、他の5体の `SubagentStop` が
届いていないため（M2 第4章1項の「終わりを落とす」がそのまま出ている）。

---

## 6. 未解決の問題 / 次にやるべきこと

- **ブラウザでの実描画は未確認。** この環境にブラウザが無い。3ペインのレイアウト、
  折りたたみの見え方、詳細パネルの読みやすさは実機で一度見ること。
  特に `orphans` が30件出るセッションで、閉じた `<details>` が邪魔になっていないか。
- **サブエージェント transcript が消える条件が不明**（第2.3章）。判れば
  「hooks にしか無い」エージェントを orphan ではなく正しい親の下に置ける可能性がある。
  いまは `toolUseId` が transcript に見つからない以上、親を主張できない。
- **`SubagentStart` はやはりほぼ飛ばない。** 実データ1090イベントでも同じ傾向。
  その結果 `async-unknown` のまま残るエージェントが多い。これは仕様上の限界で、
  こちらで埋めるなら「起動した `tool_use` の時刻」までが限度。
- **詳細パネルのツールログは transcript が動いた時だけ更新する。** キャッシュ命中中は
  再取得しない（スクロール位置を毎秒飛ばさないため）。稼働中エージェントの
  ツールログが最大で「次に1バイト書かれるまで」古い。
- **collector は当日分の events しか読まない。** 日付をまたいで生き続けている
  セッションのエージェントは、collector 側では前日分の証跡を持たない
  （`HookHistory` は全日分を読むので、そちらに落ちれば拾える）。
- **`orphans` の上限が無い。** hooks が知っているエージェント数だけ増える。
  1セッション30件は確認済み。数百になる状況があるなら上限が要る。
- **メモリ上限の値は暫定のまま**（M2 から持ち越し）。ツリーキャッシュは8件だが、
  34MB セッションのパース結果を8本抱えた時の実測はしていない。
- Usage ビュー（M4）は未着手。`src/usage.js` の集計はあるので、
  `node src/cli.js usage --daily` で今も見られる。

---

## 7. サーバ再起動が要る

**ユーザは動かしているダッシュボードを一度止めて起動し直す必要がある。**
新しいタブ（Tree）も新しいエンドポイントも、起動中のプロセスには入っていない。
トークンは**プロセスごとに作り直される**ので、再起動後は標準出力に出る
新しい `http://127.0.0.1:<port>/?t=<token>` を一度開くこと（古い Cookie は 403 になる）。

---

## 8. レビュー指摘と修正（2026-09-03）

Sonnet によるレビューで4件の指摘。全て修正し、回帰テストを6件追加した。
`npm test` → **416件 pass / 0 fail**（91スイート、410 → 416）。

### 8.1 [Medium] `buildTreeView` が meta.json を読み直していなかった

`src/tree-view.js` のコメントは「索引のキャッシュを信用せず meta.json を読み直す」と
書いてあったのに、実際のコードは `entry.subagents` が空でない時だけそれを使い、
**空の時にだけ** `listSubagents()` を呼んでいた。意図の裏返しである。

結果として、サブエージェントが1体でも居るセッションでは、後から書かれた
meta.json が `SessionIndexCache` の TTL（2秒）が切れるまで反映されない。
Claude Code は子の jsonl を作った**直後**に meta.json を書くので、
「名前が出るまで最大2秒 `a1234567` のまま」という状態が起きる。

**修正**: `entry.projectPath` があれば**必ず** `listSubagents()` で読み直す
（無い場合だけ `entry.subagents` にフォールバック）。コメントも実装に合わせた。
コストは readdir 1回＋エージェントごとに小さな JSON 1本で、直前に行った
パース（最大248ms）に比べれば無視できる。副次的に、消えたエージェントの
meta が自動的に落ちる（8.2 と同根）。

**追加テスト**（`test/tree-api.test.js`、1件）: TTL を1時間にした
`SessionIndexCache` から `SessionEntry` を取り（＝索引は絶対に更新されない）、
その後 meta.json を書き戻すと、**索引を再構築せずに**（`idx.builds === 1`）
名前・種類・`descriptionSource: "meta"` が出ることを確認する。
なお**親子関係は meta.json の `toolUseId` / `parentAgentId` に依存する**ので、
そちらは再パースが要る。テストのコメントにその線引きを書いた。

### 8.2 [Low] 「配下のファイルが消える」競合の統合テストが無かった

既知の制約 5-13（サブエージェントの transcript が親より先に消える）は
文書化しただけで、テストが無かった。

**追加テスト**（`test/tree-api.test.js`、3件）: 専用のセッション
（`cccccccc-…`、他のテストが依存しない）に2体のサブエージェントを作り、
索引に載せてから片方の `.jsonl` と `.meta.json` を**両方削除**する。

| ケース | 期待 | 実際 |
|---|---|---|
| 古い `SessionEntry` のまま `buildTreeView` | 例外を投げない。残った側は名前付きで健在、消えた側はノードとして残るが名前とトークンを失う | その通り |
| 索引を作り直してから `buildTreeView` | 消えた側は索引から落ち、**hooks の `SubagentStop` だけで** `origin: "hooks"` の orphan として見える | その通り（`completed` / `hooks:SubagentStop`） |
| HTTP 経由（`/api/tree` と `/api/tools`） | **500 ではなく 200**。両方のエージェントがどこかに出る。続く `/api/health` と `/api/sessions` も 200 | その通り |

`parser.js` の `parseFile` が欠損ファイルを `stats.skippedFiles` に落として
継続する（M1 の防御姿勢）ため、追加の防御コードは要らなかった。

### 8.3 [Low] タブを離れた後にデバウンスが発火していた

`onSnapshotForTree()` は `currentView !== 'tree'` を**タイマーを仕掛ける時にしか**
見ていなかった。Tree タブを見ている間に仕掛かった2秒タイマーは、その2秒の間に
Live タブへ移っても発火し、`/api/sessions` と `/api/tree`（＝最大34MBのパース）を
走らせていた。6.5 の「見えている間だけ更新する」に反する。

**修正**: 2つのタイマーコールバックの先頭でも `currentView !== 'tree'` を見て
そのまま return する。

### 8.4 [Low] Live カードの Tree ボタンが一覧を2回取りに行っていた

`showTreeFor()` が `selectView('tree')`（→ `enterTree()` → `loadSessions()`）を
呼んだうえで、自分でも `loadSessions()` を呼んでいた。1クリックで同じ
`/api/sessions` が2本飛ぶ。

**修正**: `showTreeFor()` からの `loadSessions()` を削除し、
`selectView('tree'); selectSession(sessionId);` にした。`selectSession()` は
**同期で** `tree.selected` を立てるので、後から解決する `enterTree()` の
継続は「もう選択済み」の枝に入り、一覧を描き直すだけで選択を上書きしない。

### 8.5 テスト

追加6件（`test/tree-api.test.js` +4、`test/server.test.js` +2）。

| テスト | 何を止めるか |
|---|---|
| 8.1 の meta 再読み | `entry.subagents` に戻したら落ちる |
| 8.2 の3件 | 欠損ファイルで 500 になったら落ちる。サーバが死んでも落ちる |
| `showTreeFor` に `loadSessions(` が無いこと | 二重取得が戻ったら落ちる |
| `onSnapshotForTree` の可視判定が**3箇所**あること | どれか1つでも消えたら落ちる |

後ろ2件は `public/app.js` の該当関数の本文だけを切り出して検査する
（`bodyOf()` ヘルパ。改行はシェルのエスケープ事故を避けるため
`String.fromCharCode(10)` で作る）。

### 8.6 再確認

```
$ npm test
ℹ tests 416
ℹ suites 91
ℹ pass 416
ℹ fail 0
ℹ duration_ms 1026
```

実サーバのスモーク（自前ポート 47403、ユーザのサーバには非接触）も再実行し、
全項目 OK・ポート解放まで確認した。実測値は変わらず
（`ea1b82f5` cold 68ms / warm 4ms、34.2MB の `d1c5d494` が HTTP 264ms・パース 210ms）。
---

## 9. ブラウザ確認後の表示修正（2026-09-03）

Playwright（playwright-core + `channel:'chrome'`、ヘッドレス）で Tree タブを実際に
描画して確認。3ペイン・深さ2のネスト・詳細パネル・orphans の折りたたみ・
900px 幅での縦積み（横スクロール無し）・コンソールエラー0件は問題なし。
表示上の指摘が3件あり、修正して再撮影で確認した。
`npm test` → **419件 pass / 0 fail**（416 → 419）。

### 9.1 hooks のみのエージェント行に裸の `0` が出ていた

transcript を持たないエージェント（6.3）はトークンもツール数も 0 なので、
`√ afc4633f 0` のように**数値ではなく「はぐれた文字」**に見えていた。

**修正**: トークンが 0／不明ならセルごと空にする
（`n.tokens && n.tokens.total ? … : ''`。ツール数は元から 0 で空だった）。
併せて、名前が無く ID を出す行に `tnode__label--id` を付けて**等幅・立体**にした
——proportional の斜体だと桁が揃わず読みにくかった。
このクラスは `.tnode__btn--hooks .tnode__label`（hooks のみを斜体にする規則）より
詳細度を上げないと負けるので、`.tnode__btn .tnode__label--id` の2クラスで書いてある。

### 9.2 1本のツリーに「Opus」と「Opus 5」が混在していた

同じエージェントでも meta.json が勝てば `"opus"`、transcript が勝てば
`"claude-opus-5"` が来る（6.2）。短縮テーブルが前者を `Opus`、後者を `Opus 5` に
写していたため、**別のモデルに見えていた**。

**修正**: `MODEL_LABEL` を**両方の形から系列名（Opus / Sonnet / Haiku / Fable）へ**
写すテーブルにした。逆向き（`"opus"` → `"Opus 5"`）は採らない ——
エイリアスはどの版に解決したかを記録していないので、版を補うのは捏造になる。
テーブルに無いIDはこれまでどおりそのまま出す。`docs/architecture.md` 6.2 に明記した。

### 9.3 `async-unknown` のマークが見えなかった

中黒 `·` は開閉トグルと紛れて**ほぼ見えなかった**。`~` に変更。
併せて、Live と Tree で二重定義していたマーク表を1つに統合し
（`AGENT_MARK` / `AGENT_STATUS_LABEL`）、**全マークに日本語名の `title` を付けた**
（`▶` 実行中 / `✓` 完了 / `?` 終了と推定 / `✗` エラー / `~` 完了不明）。
`?` も `~` も「こちらの推測」を意味するので、記号だけでは説明になっていない。

### 9.4 再撮影での確認（DOM から直接読んだ値）

```
[03] model cells=["Opus","Sonnet"]  versioned=0
[03] bare-zero cells=0
[03] marks=["■=セッション","✓=完了","~=完了不明"]  untitled=0
[07] orphan bare-zero cells=0
[07] 先頭の orphan 行:
     glyph="?" title="終了と推定" label="a458ad06"
     class="tnode__label tnode__label--id" font="Cascadia Mono" fontStyle="normal"
     tok=""  tools="1 tools"
[console] none      （undefined / NaN / Invalid Date の文字列も0件）
```

スクリーンショットは scratchpad の `e2e/v2/03-tree-nested.png` と
`e2e/v2/07-tree-orphans-open.png`。撮影は**自前ポート**（47405 / 47407）で起動した
サーバに対して行い、`browser.close()` とサーバの kill を `finally` に置いて、
終了後にポート解放とプロセス残留ゼロを確認している。

### 9.5 テスト

追加3件（`test/server.test.js`）。既存2件は新しい仕様に合わせて**強めて**書き直した。

| テスト | 何を止めるか |
|---|---|
| 裸の 0 を出さない（9.1） | `compact(0)` が戻ったら落ちる。ID セルの等幅指定が消えても落ちる |
| エイリアスとフルIDが同じ系列名になる（9.2） | テーブルの値に版番号が復活したら落ちる |
| 全マークに `title` が付く（9.3） | Live / Tree どちらの `setAttribute('title', …)` が消えても落ちる |
| `AGENT_MARK` が5状態を持ち `async-unknown` が `·` でない（9.3） | マークが中黒に戻ったら落ちる |
