# M1 動作確認ログ（2026-09-02）

環境: Windows 11 Pro 26200 / Node.js v24.13.0 / Claude Code 2.1.258 / TZ=Asia/Tokyo
`D:\develop\Claude監視` は git リポジトリではない（git init していない）。

---

## 1. テスト結果

```
$ npm test        (node --test test/*.test.js)
tests 106 / suites 21 / pass 106 / fail 0 / skipped 0
duration_ms 382
```

統合テスト（実データ＋ccusage、既定はskip）:

```
$ CLAUDE_MONITOR_IT=1 node --test test/integration.test.js
▶ integration: real ~/.claude data
  ✔ every transcript parses with zero failures and no unknown types (693ms)
  ✔ our daily aggregation equals ccusage daily for every completed day (2877ms)
  ✔ the session index and tree build for every recent session (109ms)
  ✔ every subagent transcript reports its own agentId and isSidechain (72ms)
tests 4 / pass 4 / fail 0
```

未実行のとき（既定）は `﹣ integration: real ~/.claude data # set CLAUDE_MONITOR_IT=1 ...` と表示される。

---

## 2. usage の ccusage 突合（最重要）

```
$ node src/cli.js usage --daily --compare-ccusage
scanned 146 transcript file(s), 34,9xx lines, 0 parse failure(s)
dedupe: message.id, latest timestamp wins -> 9,8xx unique messages
```

| DATE | RESULT | d(input) | d(output) | d(cacheC) | d(cacheR) |
|---|---|---|---|---|---|
| 2026-08-03 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-04 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-05 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-06 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-07 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-08 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-09 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-10 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-12 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-14 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-15 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-16 | MATCH | 0 | 0 | 0 | 0 |
| 2026-08-23 | MATCH | 0 | 0 | 0 | 0 |
| 2026-09-01 | MATCH | 0 | 0 | 0 | 0 |
| 2026-09-02 (当日) | MATCH | 0 | 0 | 0 | 0 |

**全15日・全4指標が完全一致。** 当日分も偶然一致した（ccusage実行時点と
自前集計時点の間に親セッションが新しいメッセージを書かなかったため）。
当日分が不一致でも異常ではなく、その旨をCLIが出力に明記している。

参考: `docs/reference/usage_agg_v2.js` と同じ dedupe 規則
（message.id単位・timestamp最新採用・同着はトークン合計が大きい方）を実装。

実測の日次サンプル（同一実行時のローカル値）:

| DATE | MSGS | INPUT | OUTPUT | CACHE_CR | CACHE_RD |
|---|---|---|---|---|---|
| 2026-08-14 | 1,845 | 3,690 | 1,328,986 | 6,810,814 | 386,736,939 |
| 2026-08-16 | 192 | 384 | 126,289 | 1,898,904 | 27,793,957 |
| 2026-08-23 | 20 | 40 | 24,956 | 60,484 | 1,293,415 |
| 2026-09-01 | 110 | 220 | 66,552 | 349,958 | 6,428,257 |

`docs/m0-local-findings.md` の表と 08-16 / 08-23 / 09-01 が一致することも確認。

---

## 3. tree（実データ）

### 3.1 現在の親セッション（M1実装中のセッション）

```
$ node src/cli.js tree 11111111
session 11111111-2222-4333-8444-555555555555
cwd     D:\develop\Claude監視
files   4 (main + 3 subagent transcript(s))

session 11111111-... (D:\develop\Claude監視) tools=18 msgs=65 out=32462 1411s
|- agent afafafafafafafafa [general-purpose] "M0 local data verification" d1 sonnet async-unknown tools=58 msgs=166 out=5841 813s
|- agent a6a6a6a6a6a6a6a6a [general-purpose] "M0 official docs verification" d1 sonnet async-unknown tools=58 msgs=156 out=2857 707s
`- agent a4a4a4a4a4a4a4a4a [general-purpose] "Implement M1 core modules" d1 opus async-unknown tools=47 msgs=123 out=349 753s
```

M0の2エージェントとM1実装エージェント自身が子ノードとして出た。

### 3.2 ネスト（spawnDepth=2）の確認

```
$ node src/cli.js tree 22222222
session 22222222-3333-4444-8555-666666666666 (D:\develop\Claude\CaludeGame) tools=96 msgs=357 out=117815
|- agent adadadadadadadada [Explore] "研究UIと効果表示の調査" d1 claude-opus-5 completed tools=53 ...
|- agent ababababababababa [general-purpose] "監査1: GDD vs 実装の乖離" d1 opus async-unknown ...
|  |- agent a9a9a9a9a9a9a9a9a [Explore] "Audit UI promises vs GDD" d2 claude-opus-5 async-unknown ...
|  `- agent aeaeaeaeaeaeaeaea [Explore] "Audit cycle/inheritance engine promises" d2 ...
|- agent a7a7a7a7a7a7a7a7a [general-purpose] "監査2: 死にシステム検出" d1 opus async-unknown ...
|  |- agent acacacacacacacaca [general-purpose] "Audit event system wiring" d2 ...
|  `- agent a8a8a8a8a8a8a8a8a [general-purpose] "Audit outpost/exodus/bond/storage" d2 ...
...（全20ノード、orphan 0件）
```

19サブエージェント（うちdepth-2が7件）がすべて正しい親にぶら下がった。
日本語のdescriptionもcwdも化けていない。

---

## 4. その他サブコマンド

```
$ node src/cli.js paths
claudeHome         C:\Users\alice\.claude
projectsDir        C:\Users\alice\.claude\projects
monitorDir         C:\Users\alice\.claude-monitor
projectRoot        D:\develop\Claude監視
timezone           Asia/Tokyo

$ node src/cli.js sessions
sessions dir: C:\Users\alice\.claude\sessions  (1 file(s), 1 *.key ignored)
  PID  ALIVE  STATUS  HOOK  SESSION      NAME        AGE   CWD
29340  yes    busy    -     11111111...  claude-37  895s   D:\develop\Claude監視
```
→ `.key` は開かずスキップ。`kill(0)` で生存 yes。HOOK が `-` なのは
install-hooks 未実行のため（正しい表示）。

```
$ node src/cli.js list --days 5
4 session(s) within 5 day(s); 65 older skipped; 31 project dir(s)
11111111 ... 397KB  subs=3  D--develop-Claude--  D:\develop\Claude監視
```
→ cwd はディレクトリ名からの逆変換ではなく jsonl 内の `cwd` から取得。
`D--develop-Claude--` から `D:\develop\Claude監視` は復元不可能なので、この方式が必須。

```
$ node src/cli.js tools 11111111 --limit 8
session 11111111-...: 196 tool call(s), 9 error(s), 1 pending
by tool: Bash=114 WebFetch=23 Write=23 Edit=9 Read=5 WebSearch=5 ToolSearch=4 Agent=3 ...
13:19:26   Bash  ok       3963  a4a4a4a4  cd "D:/develop/Claude監視" && node src/cli.js usage ...
13:20:04   Bash  pending     -  a4a4a4a4  cd "D:/develop/Claude監視" && node src/cli.js tools ...
```
→ 実行中の呼び出しが `pending` として正しく出た（結果がまだ書かれていないため）。

```
$ node src/cli.js stats 11111111
files 4, lines 674, parsed 674, blank 0, parse failures 0
record types: assistant 345 / user 207 / attachment 51 / queue-operation 14 /
              mode 10 / permission-mode 10 / bridge-session 10 / atis-latch 10 /
              last-prompt 9 / system 6 / file-history-snapshot 2
content blocks: tool_use 196 / tool_result 195 / thinking 113 / text 37
unknown types: none
```

```
$ node src/cli.js statusline
rate_limits unavailable: no statusline sidecar directory (statusLine hook not installed yet)

$ node src/cli.js events
no event files under C:\Users\alice\.claude-monitor\events
run `node src/cli.js install-hooks` first, then start a new Claude Code session.
```
→ 未導入状態でも理由付きで正しく報告する。

---

## 5. hooks / statusline スクリプトの単体動作（scratchpad上で検証）

`CLAUDE_MONITOR_DIR` を scratchpad に向けて実行。

```
$ echo '{"session_id":"s1","hook_event_name":"Stop","stop_hook_active":false}' | node hooks/monitor-hook.js
（出力なし、exit 0）  real 0m0.075s

$ node hooks/statusline.js < sl.json
Opus | ctx 8% | 5h 23% (resets 23:20) | 7d 41%
  real 0m0.076s
```

- どちらも 75ms 程度（ほぼNode起動時間）。50ms級の要求にほぼ収まる。
- `monitor-hook.js` は stdout に一切出さず必ず exit 0。
- 壊れたstdinを渡した場合は `{"parseError":true,"raw":"..."}` として記録し、
  クラッシュしないことを確認。
- statusline の出力は仕様の例（`Opus | ctx 8% | 5h 23% (resets 21:30) | 7d 41%`）と
  同じ形式。パーセントは四捨五入ではなく切り捨て（23.5 → 23%）。
- sidecar `<monitorDir>/statusline/s1.json` に tmp→rename で保存され、
  `node src/cli.js statusline` で rate_limits を読み出せることを確認。

ingest 側:
```
$ node src/cli.js events --state
3 event(s), 0 parse failure(s)
13:20:30.421  PreToolUse    test-ses  -         Bash
13:20:30.501  SubagentStop  test-ses  aTEST123  general-purpose
folded session state:  test-ses  tool-running
folded agent state:    aTEST123  stopped  type=general-purpose
```

---

## 6. install-hooks --dry-run（書き込みなし）

```
$ node src/cli.js install-hooks --dry-run
install (DRY RUN - nothing written)
settings: C:\Users\alice\.claude\settings.json (exists)
hook command: node "D:\develop\Claude監視\hooks\monitor-hook.js"
statusLine  : node "D:\develop\Claude監視\hooks\statusline.js" (added)
events added: SessionStart, SessionEnd, UserPromptSubmit, Stop, SubagentStart,
              SubagentStop, PreToolUse, PostToolUse, PostToolUseFailure,
              Notification, PreCompact, PostCompact
already present: (none)
```

生成される settings.json で確認したこと:
- 既存の `SessionEnd` フック（`session_end.ps1`）が**そのまま保持**され、
  我々のフックが2つ目のエントリとして追加される。
- `permissions` / `enabledPlugins` / `language` / `effortLevel` / `tui` /
  `agentPushNotifEnabled` / `model` はすべて無傷。
- `SessionEnd` のみ `{"type":"command","command":"...","timeout":5}`（同期）、
  他は `{"type":"command","command":"...","async":true}`。

**実際の install-hooks は実行していない**（指示どおり --dry-run のみ）。
`uninstall-hooks --dry-run` も「no change needed」を返すことを確認済み。

---

## 7. 実装中に判明した、docs と異なる／docs に無い事実

1. **【重要】非同期サブエージェントの tool_result は「起動した」だけを意味する。**
   親transcriptには起動直後に
   `toolUseResult = {"isAsync":true,"status":"async_launched","agentId":"..."}`
   が書かれる。全履歴で async 106件 / sync 4件。
   したがって「tool_result があれば completed」という当初の設計前提は**誤り**。
   状態は `completed` / `running` / `async-unknown` / `error` に分け、
   `statusSource` で根拠を明示する実装にした。確実な完了判定には
   `SubagentStop` フックが必要。

2. **`meta.json` に `parentAgentId` がある。** spawnDepth>=2 の12件すべてに存在し、
   depth-1 の87件には無い。toolUseId索引によるネスト解決より直接的で確実。
   他に `worktreePath` / `worktreeBranch` / `spawnedWithWorktree` も存在する。
   `model` は 85/99 にしかない（depth-2 の Explore 等で欠落）。

3. **ネストしたサブエージェントの jsonl は同じ `subagents/` 直下にフラットに置かれる。**
   ディレクトリのネストは無い。

4. **transcript の type は m0 調査の一覧より多い。** 新たに実在を確認したもの:
   `ai-title`, `file-history-delta`, `frame-link`, `agent-name`, `cost-state`,
   `artifact-autoreact-ledger`, `artifact-comment-monitor`。
   逆に `summary` と `progress` は 146ファイル / 34,000行超のどこにも出現しなかった
   （念のため既知typeとして登録済み）。
   `system` の subtype は `turn_duration` / `stop_hook_summary` / `away_summary` /
   `local_command` / `compact_boundary` / `model_consent_fallback` の6種。

5. **ccusage 20.0.20 の `daily --json` は日付フィールドが `date` ではなく `period`。**
   公式ドキュメント `docs/guide/json-output.md` の例は `date` と書いてあるが実物は違う。
   さらに各行に `agent`（`"all"`）と `metadata` が付く。両方受け付ける実装にした。

6. **Node 20.12+ / 24 では `.cmd` を `spawn` で直接起動できない（EINVAL）。**
   `npx.cmd` 直叩きは失敗し、`shell:true` は DEP0190 警告を出す。
   引数をallow-listで検証したうえで `cmd.exe /d /s /c` を明示的に起動する方式にした。

7. **Claude Code は古い transcript を自動削除する。** 作業中（21:57→22:12）に
   `~/.claude/.last-cleanup` が更新され、transcript が 171ファイル / 45,613行 から
   146ファイル / 34,847行 に減った。消えたのは 2026-08-02 以前、つまり
   **保持期間はおよそ30日**と推測される（推測: 30日ちょうどの境界で消えたことと
   `.last-cleanup` の更新タイミングの一致から。ソースは未確認）。
   → 過去分の集計値は永続ではない。長期保持するなら独自スナップショットが要る。

8. **`assistant` レコードには `sessionId` と `session_id` の両方が現れる。**
   さらに `attributionAgent` / `attributionSkill` / `attributionMcpServer` /
   `attributionMcpTool` / `slug` / `effort` / `apiBlockIndex` といった
   m0未記載のフィールドがある。パーサは `sessionId` を優先し `session_id` に
   フォールバックする。

9. **`~/.claude/sessions/<pid>.json` の実フィールド**（m0の記述を実物で再確認）:
   `pid` / `sessionId` / `cwd` / `startedAt` / `procStart`(Windows FILETIME文字列) /
   `version` / `peerProtocol` / `peerFeatures` / `kind` / `entrypoint` / `pidDomain` /
   `messagingSocketPath` / `name` / `nameSource` / `nameSince` / `status` /
   `updatedAt` / `statusUpdatedAt` / `bridgeSessionId`。
   `procStart` は 1601年起点の100ns tick で、`116444736000000000` を引いて
   10000で割ると epoch ms になる（テストで検証済み）。

10. **サブエージェント spawn のツール名は `Agent`**（全履歴で110回）。`Task` ではない。

---

## 8. 未解決の問題 / 次にやるべきこと

- `install-hooks` を実際に実行しての end-to-end 検証が未了（指示により --dry-run のみ）。
  実行後は新しいセッションを1つ起こして `events --state` と `statusline` を確認したい。
- 非同期サブエージェントの完了判定は `SubagentStop` フック導入後にしか確定しない。
  それまでは `async-unknown` のままになる。
- 死んだPIDの `sessions/<pid>.json` 残骸の挙動は依然未検証（m0から持ち越し）。
  PID再利用検知は実装したが、再利用が実際に起きた状況でのテストはできていない。
- `rate_limits` の実データが1件も無いため、`five_hour` / `seven_day` / `spend_limit`
  の実際の値・resets_at の挙動は合成データでしか検証できていない。
- 出力テーブルは全角文字の幅を1文字として数えるため、日本語を含む列で桁がずれる
  （cwd を最終列に置いて実害を避けている）。UI 実装時に要対応。

---

## 9. レビュー対応（2026-09-02）

コードレビューで挙がった5件をすべて修正し、回帰テストを追加した。

### 修正内容

**[Critical] #1 `installer.js` — 壊れた settings.json の全消し**

`readJsonUtf8()` が「ファイル無し」と「あるがJSON.parse失敗」の両方で `null` を返すため、
settings.json が壊れている状態で `install-hooks` を実行すると `existed=false` と判定され、
バックアップ無しで `permissions` / `enabledPlugins` / `language` / `effortLevel` / `tui` /
`agentPushNotifEnabled` / `model` / 既存 `SessionEnd` hook をすべて失う経路があった。

- `readSettingsFile()` を新設し、`readFileSync` と `JSON.parse` を分離して
  `missing` / `ok` / `corrupt` の3状態を返すようにした。
  読めるが JSON でない場合（トップレベルが配列の場合も含む）と、
  ENOENT 以外の I/O エラー（EACCES 等）は両方 `corrupt` 扱いにする。
- `corrupt` のときは **バックアップを取った上で `CorruptSettingsError` を投げて中断**する。
  黙って上書きしない。`--dry-run` でも同じく検出してエラー表示し、
  こちらは**バックアップも含めて一切書き込まない**。
- `cli.js` は `CorruptSettingsError` を捕捉して、復旧手順を含むメッセージを
  stderr に出して exit 1 する（`--json` 時は `{ok:false, error:"corrupt-settings", ...}`）。
- BOM 付きの settings.json は `stripBom` を通すので従来どおり `ok` と判定される。

**[High] #2 `installer.js` — 非アトミックな書き込み**

`fs.writeFileSync` を `paths.js` の `writeFileAtomic`（tmp書き込み→rename）に置換。
書き込み途中でクラッシュしても半端な settings.json が残らない。
`writeFileAtomic` は rename 失敗時も tmp を必ず削除する。

**[High] #3 `jsonl-tail.js` — statSync→openSync の TOCTOU**

`JsonlTail.read()`（旧91行）と `streamLines()`（旧215行）の `openSync` が無防備で、
Claude Code の transcript 自動削除（第7章7項で実測、稼働中に25ファイル消えた）と
重なると `usage --daily` 等が ENOENT で全体失敗しうる状態だった。

- 両方の `openSync` を try/catch し、ENOENT / ENOTDIR なら
  `read()` は `missing:true`、`streamLines()` は `{lineCount:0, missing:true}` を返す。
  `streamLines` の戻り値に `missing` を追加した（存在しないファイルと
  空ファイルを呼び出し側が区別できるようにするため）。
- `parser.js` の `parseFile()` はファイル単位の I/O 例外と `missing` を捕捉して
  `ParseStats.recordSkippedFile()` に記録し、処理を継続する。
  `ParseStats` に `skippedFiles` / `skippedFileSamples` を追加し、
  `merge()` と `toJSON()` にも反映した。
- `usage.js` の `aggregateFiles()` にも try/catch を重ね、
  結果の `summary.skippedFiles` に件数を出す。
- `cli.js` は `usage --daily` と `stats` でスキップ件数（と理由）を表示する。

**[Medium] #4 `jsonl-tail.js` — 先頭 BOM**

`stripBomBuffer()` を追加し、**オフセット0の読み取り時のみ** BOM を除去する。
`JsonlTail.read()` は `st.offset === 0` のときだけ、`streamLines()` は最初のチャンクだけ
適用するので、ファイル途中に現れる同じ3バイトは内容として保持される。

**[Low] #5 `installer.js` — インデント固定**

`detectIndent()` を追加し、既存ファイルの最初のインデント行から
スペース数（1〜8）またはタブを検出して踏襲する。検出できなければ2スペース。
冪等判定（`unchanged`）も検出したインデントで行うため、
4スペースの settings.json がインデント差だけで書き換わることはない。
`install-hooks` の出力に `indent` 行を追加した。

### テスト結果

```
$ npm test
tests 141 / suites 26 / pass 141 / fail 0
（修正前 106件 → +35件の回帰テスト）
```

追加したテストファイル:

- `test/installer-review.test.js`（21件）
  - 壊れた settings.json で install が例外で止まること、
    **元ファイルがバイト単位で無変更**であること、バックアップが作られ中身が一致すること
  - `--dry-run` は例外を投げつつディレクトリ内容を一切変えないこと
  - uninstall も同様に拒否すること／missing は通常の新規インストールであること
  - トップレベル配列・BOM付きファイルの判定
  - 書き込み後に `.tmp-` ファイルが残らないこと（install / uninstall / 新規ディレクトリ）
  - 2スペース・4スペース・タブの検出と踏襲、インデントが内容を変えないこと、
    インデント差で不要な再書き込みが起きないこと
- `test/io-resilience.test.js`（14件）
  - `fs.statSync` をラップして「stat 成功直後にファイルを削除」する実際の競合を再現し、
    `JsonlTail.read()` と `streamLines()` が例外を投げず `missing:true` を返すこと
  - **列挙後に削除されたファイルを含む集計**（3ファイル中1つが消滅）が落ちず、
    生き残り2ファイルの合計（107）を返しつつ `skippedFiles: 1` を報告すること
  - 全ファイル消滅時も落ちないこと、`ParseStats.merge`/`toJSON` がスキップ件数を運ぶこと
  - BOM の除去（`stripBomBuffer` 単体、`streamLines`、`parseFile`、`aggregateFiles`）
  - **ファイル途中の BOM は内容として保持**されること（先頭のみ剥がす）
  - BOM がチャンク境界（chunkSize=5）にかかっても壊れないこと
  - BOM 無しファイルが一切影響を受けないこと

### 修正後の再確認

```
$ node src/cli.js install-hooks --dry-run
install (DRY RUN - nothing written)
settings: C:\Users\alice\.claude\settings.json (exists)
hook command: node "D:\develop\Claude監視\hooks\monitor-hook.js"
statusLine  : node "D:\develop\Claude監視\hooks\statusline.js" (added)
indent      : 2 spaces
events added: SessionStart, SessionEnd, UserPromptSubmit, Stop, SubagentStart,
              SubagentStop, PreToolUse, PostToolUse, PostToolUseFailure,
              Notification, PreCompact, PostCompact
already present: (none)
```
→ 既存の `SessionEnd`（session_end.ps1）と全設定キーの保持を再確認。
実ファイルは mtime `2026-09-02 21:42:00` / 927バイトのまま無変更、
`settings.json.bak-*` も生成されていない（--dry-run のみ実行）。

```
$ node src/cli.js usage --daily --since 2026-08-30 --compare-ccusage
scanned 147 transcript file(s), 35,224 lines, 0 parse failure(s)

DATE          RESULT  d(input)  d(output)  d(cacheC)  d(cacheR)
2026-09-01    MATCH          0          0          0          0
2026-09-02 *  MATCH          0          0          0          0
```
→ ccusage との一致は維持。

```
$ CLAUDE_MONITOR_IT=1 node --test test/integration.test.js
tests 4 / pass 4 / fail 0
```
→ 実データに対する統合テストも全件 pass。
