# 「3 稼働」なのに動いているのは1本だけ（2026-09-06）

Live ヘッダの稼働数が、実際に動いている Claude Code の本数と合わない。
原因は2つあり、どちらも「終わりのイベントが来なかったもの」の扱いだった。

## 再現

サーバは本番（47321）に触らず 47416 に別インスタンスを立て、実データ
（`~/.claude` と `~/.claude-monitor`）をそのまま読ませた。
このとき動いていた Claude Code は `77b69db3` の1本だけ。

### 修正前

```
== /api/state == 200
counts: {"total":6,"live":5,"busy":0,"waiting":1,"agentsRunning":1}
  77b69db3 phase=waiting_input src=hooks  alive=true  lastEventAt=2026-09-06T15:05:15Z
  ec5bbb84 phase=unknown      src=none    alive=null  lastEventAt=null
  addd5ad7 phase=unknown      src=none    alive=null  lastEventAt=null
  b5824c60 phase=unknown      src=none    alive=null  lastEventAt=null
  ea1b82f5 phase=unknown      src=none    alive=null  lastEventAt=null
  5340fbb3 phase=ended        src=hooks   alive=null
== /api/sessions == 200 rows=32 live=5
   77b69db3 live=true  phase=waiting_input endedAt=null
   addd5ad7 live=true  phase=unknown       endedAt=null   ← 一覧では「稼働中」
   b5824c60 live=true  phase=unknown       endedAt=null   ← 9/3 のセッション
   ea1b82f5 live=true  phase=unknown       endedAt=null   ← 9/2 のセッション
   ec5bbb84 live=true  phase=unknown       endedAt=null
```

`counts.live` が 5。ヘッダの数字が現実と合わないだけでなく、ツリーの左一覧が
終了時刻の代わりに「稼働中」と出し、カードも Live 側に並んでいた。

## 原因

### (1) 稼働の判定が「終わっていない」だった

`state.isLive()` は `phase !== 'dead' && phase !== 'ended'` だった。
一方 `applyStatusline()`（`state.js`）は `<monitorDir>/statusline/` の
**ファイルの数だけ**セッションレコードを作る。model / context% / cost /
rate_limits はここにしか無いので、レコードを作ること自体は正しい。
しかしこのディレクトリは一度も掃除されない：

```
$ ls ~/.claude-monitor/statusline/
77b69db3-....json   Sep  7 00:01   ← 動いている1本
addd5ad7-....json   Sep  5 01:10
b5824c60-....json   Sep  3 23:39
ea1b82f5-....json   Sep  3 01:13
ec5bbb84-....json   Sep  5 05:19
```

これらは hook イベントも `sessions/<pid>.json` も持たないので
`phase: 'unknown'` / `phaseSource: 'none'` / `alive: null`
——「このセッションのことは何も聞いたことがない」状態である。
それが「`ended` でも `dead` でもない」ので稼働に数えられていた。

同じ式が3箇所に手書きで散っていたのも効いていた
（`state.buildSnapshot`、`tree-view.listSessionsView` ×2、
`tree-merge.mergeTree`、`public/app.js` の `archived`）。

### (2) セッション用の stale 掃引が無かった

`sweepStale()` はツールとエージェントしか見ていなかった。
`SessionEnd` を出さずに落ちたセッション——Claude Code が殺された、
端末が閉じた、マシンが再起動した——は永久に `busy` のまま残る。

実測: `ea1b82f5` の最後のイベントは `2026-09-02T23:59:50` の `PostToolUse`。
`collector` は起動時に直近2日分の day-file しか再生しない
（`listEventDates().slice(-2)`）ので今回は hook が1件も載らなかったが、
day-file が窓の中にある間はこのセッションが「実行中」と表示され続ける。

## 直した内容

1. **`state.isLive()` を積極的な証拠に変えた。**
   `alive === true`、hook 由来の phase（`ended` / `stale` を除く）、
   `sessions/<pid>.json` の `status` のいずれかが要る。
   証拠ゼロのレコードは稼働ではない。`phase` は `unknown` のまま残すので
   UI は今まで通り「不明」と出せる。内部レコードと `toPublicSession` の
   ワイヤ形状の両方を受けるので、ヘッダ・一覧・ツリーが同じ答えになる。
   手書きの比較は全部この関数に置き換えた。

2. **セッション用の stale 掃引を足した**（`SESSION_STALE_MS` = 30分、
   `opts.sessionStaleMs` で注入可）。`hookPhase` が
   `busy` / `waiting_permission` / `waiting_input` / `compacting` で、
   `alive !== true` で、hook が30分無音で、**かつ**そのセッション自身の
   transcript の mtime も30分より古いときだけ `hookPhase: 'stale'` にする。
   `staleAt` / `staleReason`（`no hook event for 30 min, PID unknown`）を付け、
   `derivePhase` は `phaseSource: 'inferred'` を返す。
   `alive === true` は絶対に掃かない。後続の hook イベントは
   `touchSession()` が掃引前の phase に戻す（エージェントの
   `touchAgent()` と同じ流儀）。UI 表示は「停止推定」。

3. **エージェント由来のイベントもセッションの phase を埋めるようにした。**
   `SubagentStart` と `agent_id` 付きの `PreToolUse` / `PostToolUse` は
   これまでセッションの `hookPhase` を一切書かなかったので、サブエージェント
   のイベントしか無いセッションが (1) の規則では「証拠なし」になっていた。
   空のときだけ `busy` を埋める（`idle` / `ended` を上書きしない）。

4. **掃引が注入クロックを使うようにした。** `collector.sweep()` の既定が
   `Date.now()` だったため、偽クロックで駆動したコレクタが
   「4日前のイベント」を見て即座に stale にしてしまった。
   `collector.nowMs()` 経由にした。

5. **`collector.sweep()` に transcript の mtime を渡した。**
   `indexBySession` の `mtimeMs`（`sessionFileMtimes`）。
   エージェント側の `agentFileMtimes` と同じ形。
   `stats().sessionsStale` に件数が出る（`errorCount` には足さない）。

## 修正後

```
== /api/state == 200
counts: {"total":6,"live":1,"busy":0,"waiting":1,"agentsRunning":1}
  77b69db3 phase=waiting_input src=hooks alive=true
  ec5bbb84 phase=unknown src=none  ← レコードは残る（model/cost の置き場）
  addd5ad7 phase=unknown src=none
  b5824c60 phase=unknown src=none
  ea1b82f5 phase=unknown src=none
  5340fbb3 phase=ended   src=hooks
== /api/sessions == 200 rows=30 live=1
   77b69db3 live=true  phase=waiting_input endedAt=null
   b5824c60 live=false phase=unknown endedAt=2026-09-03T14:38:17.819Z src=transcript
   ea1b82f5 live=false phase=unknown endedAt=2026-09-02T16:13:09.355Z src=transcript
```

`counts.live` が 1。古い2本は稼働から外れ、一覧では「稼働中」ではなく
transcript 由来の終了時刻が出る。行数が 32 → 30 に減ったのは、
transcript がディスクに無く「稼働中だから期間の窓で消さない」という
理由だけで載っていた2本が落ちたため（`listSessionsView` の第2ループ）。

## 残っている制約

- `<monitorDir>/statusline/` は今も掃除されない。レコードは増え続けるが、
  稼働に数えられなくなったので `pruneSessions`（`MAX_ARCHIVED_SESSIONS` = 50）
  の対象になり、上限が効くようになった。
- 30分の窓は誤検知しうる。1本のツールが17分12秒走った実測があり、
  それを超える無音は「hook が来ていないだけ」かもしれない。
  だから掃引は表示を下ろすだけで、後続イベントで完全に元へ戻る。
- `idle` のセッションは掃かない。「今作業している」という主張ではないので、
  放置されていても表示が嘘にならない。
