# M0検証: ローカル実データ調査（2026-09-02）

## 1. sessions/<pid>.json の status遷移条件

**確認した事実:**

`C:\Users\alice\.claude\sessions\` には現在2ファイルのみ存在（他に残骸なし）:
- `29340.json`（593バイト、本セッションの状態ファイル）
- `29340.<hash>.key`（117バイト）

`.key`ファイルは中身を**読んでいない**（ファイル名がハッシュ値+`.key`でトークン/鍵の可能性が高く、指示の「トークン類は読まない」に該当すると判断したため）。

`29340.json`の内容（3回読込、全文）:
```
1回目 21:44:41観測: {"pid":29340,...,"status":"busy","updatedAt":1788352930998,"statusUpdatedAt":1788352930998,...}
2回目 21:50:15観測: {"pid":29340,...,"status":"busy","updatedAt":1788353121694,"statusUpdatedAt":1788353121694,...}
3回目 21:53:01観測: {"pid":29340,...,"status":"busy","updatedAt":1788353121694,"statusUpdatedAt":1788353121694,...}（変化なし）
```
statusUpdatedAtをローカル時刻変換すると `21:42:10` → `21:45:21`（変化）→ `21:45:21`（21:53:01まで7.5分以上不変）。

mtimeとstatusUpdatedAtの関係: `stat`のModify時刻とstatusUpdatedAtの値は**完全一致**（21:45:21.700216400 vs 1788353121694ms=21:45:21）。ファイルはstatus/updatedAtが変わった瞬間にのみ書き換えられ、mtime=statusUpdatedAtとみなせる。

pid生存確認: `tasklist`はコードページ問題で文字化けしたが解析結果からpid 29340がclaude.exeとして存在することを確認。PowerShell `Get-Process -Id 29340` で確定（`ProcessName: claude, StartTime: 2026/09/02 21:41:51`）。この`StartTime`は`29340.json`の`startedAt`(1788352912215ms)・`procStart`(Windows FILETIME値)と対応しており、pid再利用を`procStart`比較で検出できる設計と読み取れる（推測: PID再利用対策）。

**結論:**
- 観測できたstatusの値は **"busy" のみ**（idle/waitingは未観測）。理由: 観測window中（21:42〜21:53、約11分）本セッション（親）は継続してツール呼び出しを行っており、一度もアイドルに遷移しなかったため。
- statusUpdatedAtは**一定間隔のハートビートではなく、状態遷移イベント時のみ更新される**（21:45:21から21:53:01まで7.5分以上更新なし＝busy継続中は再書き込みされない）。
- mtimeはstatusUpdatedAtの書き込みタイミングと一致するため、ダッシュボード側で「ファイルmtimeが古い＝プロセスが死んでいる/固まっている」の判定に使える可能性がある。

**未確認/不明な点:**
- 死んだPIDのファイルが残存するか（残骸問題）は**未確認**。現在生きているセッションを意図的にkillして検証することは許可されておらず（実行中セッションの停止を伴うため）実施していない。`.last-cleanup`（`C:\Users\alice\.claude\.last-cleanup` = `2026-09-01T14:39:16.073Z`）というファイルがあり、何らかのクリーンアップ処理が走った形跡はあるが、その実装は見つけられなかった（`session_end.ps1`はsessions/配下を一切触らないことを確認済み — 後述）。
- idle/waiting状態の実在・値は未確認（推測: 存在する可能性は高いが未観測）。

---

## 2. 設定の現状（statusLine / hooks）

**確認した事実:**

`C:\Users\alice\.claude\settings.json` 全文（秘密情報なし、そのまま）:
```json
{
  "permissions": {"allow": ["Bash(flake8:*)", "Bash(cmd /c:*)", "mcp__pencil"]},
  "hooks": {
    "SessionEnd": [{"hooks": [{"type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\alice\\.claude\\bin\\session_end.ps1\""}]}]
  },
  "enabledPlugins": {...},
  "language": "小悪魔的でちょいツンデレな京都弁を話すJK",
  "effortLevel": "xhigh",
  "tui": "fullscreen",
  "agentPushNotifEnabled": true,
  "model": "claude-fable-5-1[1m]"
}
```
- `statusLine`キーは**存在しない**。
- `settings.local.json`は `C:\Users\alice\.claude\`にも `D:\develop\Claude監視\.claude\`（このディレクトリ自体が存在しない。PowerShell `Test-Path` で確認 = `False`、中身は`lancedb`と`models`のみ）にも存在しない。
- `~/.claude.json`（トップレベル設定）にも`statusLine`/`hooks`キーは存在しない（Node.jsでパースし全キー列挙して確認）。
- `.claude`全体を`statusLine`でgrepしても、jsonl内の会話ログやtipsHistory文字列にヒットするのみで、実際の設定としては**どこにも設定されていない**。

`SessionEnd`フックのスクリプト`C:\Users\alice\.claude\bin\session_end.ps1`（全文読了、安全な内容）:
- stdinのJSON（`session_id`, `cwd`）を受け取り、`<cwd>\.claude_sessions`というファイルに`タイムスタンプ\tsessionId`を追記し、直近10行のみ保持する処理。
- **rate_limits等のstdin JSONをログする処理は一切ない**（statusLine自体が未設定なので、そのstdinログも当然存在しない）。

`claude --version` → `2.1.258 (Claude Code)`

**結論:**
- **statusLineは現環境では一切設定されていない。** 外部スクリプトへの委譲もなし。ダッシュボードがstatusLineのstdin JSON（rate_limits含む）を情報源にする設計だった場合、**この環境では機能しない**（statusLine自体が発火しないため）。
- hooksは`SessionEnd`のみ設定されており、内容はsessions状態管理とは無関係（別ファイル`.claude_sessions`への軽量ログ）。PreToolUse/PostToolUse/Notification/Stop等の他のフックは未設定。

**未確認/不明な点:**
- 他マシン・他ユーザー環境でstatusLineが標準的に設定されているかは不明（今回はこのマシンの実データのみ検証）。

---

## 3. ccusageとの突合

**確認した事実:**

- `npx -y ccusage@latest --version` → **20.0.20**
- `npx -y ccusage@latest daily --json` / `blocks --json` 共に正常終了（exit 0）。出力はscratchpadの`ccusage_out/daily.json`（16日分）・`ccusage_out/blocks.json`（43ブロック）に保存。

自前集計スクリプト（`usage_agg_v2.js`）で `C:\Users\alice\.claude\projects` 配下の全`*.jsonl`（subagents/含む）を走査:
- **走査ファイル数: 170、総行数: 45326、JSON.parse失敗: 0件**
- `type==="assistant"`かつ`message.usage`ありのレコード: 24979件
- ユニークな`message.id`数: 13027

**最初の実装（message.idで「最初の1件」を採用）は誤りだった。** 検証の結果、同一`message.id`（＝同一`requestId`、両者は1:1で常に一致すると確認済み＝多重requestIdを持つmessage.idは0件）が複数行に渡って出現するケースが8850件あり、そのうち6000件は**usageの値が行ごとに増加**していた（例: `output_tokens`が3→5174のように、ストリーミング途中のスナップショットと完了時の最終値が両方JSONLに書き込まれている）。つまり「最初の1件」は未完成のusageを拾ってしまい、大幅な過小集計になっていた。

正しい方法は「**message.id単位でdedupし、タイムスタンプが最も新しい（＝usageが最も完全な）レコードを採用**」。これで比較した結果:

| 日付 | ccusage daily | 自前集計(dedup=最初の1件, 誤) | 自前集計(dedup=最新1件, 正) | 自前集計(dedupなし) |
|---|---|---|---|---|
| 2026-08-02 output | 2,334,305 | 522,600 | **2,334,305（完全一致）** | 2,773,626 |
| 2026-08-03 全指標 | input=10699/output=814101/cacheC=3175801/cacheR=272013201 | (省略) | **全指標完全一致** | (省略) |
| 2026-08-16 全指標 | input=384/output=126289/cacheC=1898904/cacheR=27793957 | - | **完全一致** | - |
| 2026-08-23 全指標 | input=40/output=24956/cacheC=60484/cacheR=1293415 | - | **完全一致** | - |
| 2026-09-01 全指標 | input=220/output=66552/cacheC=349958/cacheR=6428257 | - | **完全一致** | - |
| 2026-09-02（当日進行中） | input=222/output=1112/cacheC=67418/cacheR=265917 | - | input=886/output=17877/cacheC=224845/cacheR=3007757（大幅増） | - |

さらに全16日間の合計で照合:
- ccusage合計: `{input:87266, output:9207414, cacheCreation:47155472, cacheRead:2954351166}`
- 自前集計「dedup=最新」合計（09-02除く）+ ccusageの09-02当日分の値 = **input:87266 / output:9207414 / cacheCreation:47155472 / cacheRead:2954351166 → 全指標が桁レベルで完全一致**

09-02のみ数値がずれる理由も特定できた: `blocks --json`のアクティブブロック（`id:"2026-09-02T12:00:00.000Z"`）の`entries`が**7件**しかなく、ccusage実行時点でのスナップショットだった。その後もこのセッションで会話が続いた（自前集計時点では42件のmessage.id）ため、ccusage実行後に増えた分だけ自前集計の方が多い。**これはdedup方式の誤りではなく、実行タイミングの差による当然の乖離。**

**結論:**
- ccusageの正しい集計ロジックは「**message.id（=requestId）単位でdedupし、最新（完了時）のusageスナップショットを採用して日付ごとに合算**」。これでccusage本体の出力と完全一致することを実証済み。
- **「最初の1件を採用」する単純なdedupは大幅な過小集計（output_tokensで最大4.5倍程度の差）を生むため、ダッシュボード実装では絶対に避けるべき。**
- タイムゾーンはこの端末では`Asia/Tokyo`（`Intl.DateTimeFormat().resolvedOptions().timeZone`で確認）。ccusageのdaily集計もこのローカルタイムゾーンで日付境界を切っていると推定され、実際に一致したことからこの前提で問題ない。

**未確認/不明な点:**
- 他タイムゾーンでの挙動、UTC境界との厳密な整合性は未検証（このマシンの実データはすべてJSTで一致したため、追加検証の必要性は低いと判断）。

---

## 4. jsonlの付随事実

**確認した事実:**

最新セッション（本セッション自身）`C:\Users\alice\.claude\projects\D--develop-Claude--\ea1b82f5-5a07-4d1d-9920-479d8cece715.jsonl`（97行）の先頭3行:
```json
{"type":"mode","mode":"normal","sessionId":"ea1b82f5-5a07-4d1d-9920-479d8cece715"}
{"type":"permission-mode","permissionMode":"auto","sessionId":"ea1b82f5-5a07-4d1d-9920-479d8cece715"}
{"type":"bridge-session","sessionId":"...","bridgeSessionId":"cse_016R4Ny3ZaLdsiLNWJXihgDz","lastSequenceNum":0,"ownerAccountUuid":"...","ownerOrganizationUuid":"..."}
```
type出現数:
```json
{"mode":5,"permission-mode":5,"bridge-session":5,"file-history-snapshot":2,"user":16,"atis-latch":5,"attachment":27,"last-prompt":4,"assistant":22,"queue-operation":4,"system":2}
```

subagents/*.meta.jsonのサンプル（現セッション配下、そのまま）:
```json
{"agentType":"general-purpose","description":"M0 local data verification","toolUseId":"toolu_01LHApJhrNgJWEgnupvFATDo","spawnDepth":1,"model":"sonnet"}
```

**結論:**
- **v2.1.258のjsonlには`user`/`assistant`/`system`/`summary`以外に、`mode`/`permission-mode`/`bridge-session`/`atis-latch`/`attachment`/`last-prompt`/`queue-operation`/`file-history-snapshot`という多数の付随typeが存在する。** `summary`は今回のサンプルには出現しなかった（旧セッションの圧縮時のみ発生する可能性）。ダッシュボードのjsonlパーサはこれら未知typeを無視できる作り（存在チェックしてフォールスルー）にする必要がある。

**未確認/不明な点:**
- `bridge-session`/`atis-latch`等が標準Claude Code機能か、この環境固有の拡張かは未確認（推測: `bridgeSessionId`, `peerFeatures:["notify_idle","artifact_yield"]`等の存在から、Claude Code公式のリモート連携・モバイル連携機能である可能性が高いが断定はできない）。
- `summary`typeの実例は未確認（別セッションを追加で漁れば見つかる可能性あり、今回は範囲外として未実施）。

---

## ダッシュボード実装への重要な発見（まとめ）

1. **usage集計は「message.id dedup＋最新（最大）usageを採用」が必須。** 単純な「最初の1件」dedupは大幅な過小集計を生む（実証済み、最大4.5倍の乖離）。この方式でccusage本体と全指標が完全一致することを確認済み。
2. **statusLineはこの環境で一切未設定。** rate_limits等をstatusLine経由で取得する設計は前提が崩れる。sessions/<pid>.jsonのstatus/updatedAtの方が確実な情報源。
3. **status "busy" は状態遷移時のみ書き込まれ、定期ハートビートではない。** mtime監視だけで「生死」を判定するのは危険（busyが7分以上続いても正常な場合がある）。pid生存確認は`procStart`（プロセス開始時刻）も突き合わせてPID再利用誤検知を防ぐ設計が望ましい。
4. **jsonlのtypeは想定より多い**（`mode`/`bridge-session`/`atis-latch`等）。パーサは未知typeを無視するフォールバック必須。
5. **死んだPIDの残骸問題は未検証**（生きているセッションを止められないため）。本番実装前に、実際にセッション終了直後の`sessions/`配下の挙動を別途観測することを推奨。

**成果物（scratchpad、削除せず保持）:**
- `ccusage_out/daily.json`, `ccusage_out/blocks.json`（ccusage生出力）
- `usage_agg.js`（誤った版）, `usage_agg_v2.js`（正しいdedup版）, `dedup_deep.js`（原因究明スクリプト）
- `agg_dedup_last.json`（正しい集計結果、日付別）
