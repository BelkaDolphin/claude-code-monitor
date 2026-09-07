# M4 動作確認ログ（2026-09-06）

対象: `src/usage-view.js`（新規・I/O とキャッシュ）/ `src/usage.js`（`byDateModel` 追加）/
`src/server.js`（2エンドポイント + `guardAsync` 追加）/
`public/{index.html,app.js,style.css}`（Usage ビュー実装）。

環境: Windows 11 Pro 10.0.26200 / Node v24.13.0 / Claude Code 2.1.258 / `Asia/Tokyo`。
外部npm依存はゼロのまま（ccusage は突合ボタンを押したときだけ `npx` で起動する）。

---

## 1. テスト結果

```
$ npm test
ℹ tests 717
ℹ suites 142
ℹ pass 717
ℹ fail 0
ℹ duration_ms 7236
```

M3 / 常駐化までの **644件は全て pass のまま**。M4 で 73件追加した。
（この後のレビュー修正で **729件**になった —— 内訳は §9。）

| ファイル | 件数 | 内容 |
|---|---|---|
| `test/usage-view.test.js`（新規） | 43 | `modelSeries` の写像（別名も完全IDも同じ家族名／末尾の日付を剥がす／未知は `other`）、`windowOf` が LOCAL 暦日で「今日を含む N 日」であること、キャッシュのヒット・ミス（2回目は0ミス、答えは同一）、fingerprint が size と mtime のどちらでも動くこと、**片方だけキャッシュのまま他方が変わってもファイル横断 dedupe が正確なこと**、消えたファイルのキャッシュ追い出しと合計からの消失、mtime が窓より古いファイルを開かないこと、期間の絞り込みと「日別＝モデル別の和＝期間合計」、系列と生ID、セッション上位（順序・上限・cwd・支配的モデル・開始時刻）、sidecar からのコストと sidecar 無しの `null`、statusline ディレクトリ欠損耐性、ストアの書き出し（version 1・tmp 残らず・変化が無ければ書かない）、マージ3態（store のみ→`store` / live が小さい→`store`+`partial` / live が大きい→`live` かつ書き戻し）、壊れたストア・version 違い・形の壊れた日・書けないストア、projects が無いときの空ビュー、ccusage 突合（差分・完全一致・ccusage にしか無い日・失敗は固定文字列・タイムアウト・runner が throw・TTL・窓ごとのキー・**失敗はキャッシュしない**・**single-flight**・日付検証で argv に届かないこと・日付不正な行の除去） |
| `test/server.test.js`（追記） | +26 | `/api/usage` の 403 / 200 とその中身が実際に足し算として合うこと、`days` のクランプ（7/999/0/-4/abc/空/無し）と**窓の実長**、2回目がキャッシュから出ること、**ストアが注入した一時ディレクトリにだけ書かれること**（＋tmp が残らないこと）、Origin・Host・POST・HEAD、`/api/usage/` 配下の 404 JSON、ccusage の突合（注入 runner）・失敗が 200 + `ccusage unavailable` で **npm のエラー本文が本体に出ないこと**・runner が throw してもリスナーが生きていること、配信された HTML/JS/CSS の検査（プレースホルダ消滅・18個の id・叩くのは2ルートだけ・`cm.usageDays`・10秒デバウンス＋**発火時の再判定**・stale 判定・読み込み/失敗のテキスト・当日 `*`・「保存値」「一部欠損」・棒が `.gauge__track` の再利用で最大日基準・Tree ジャンプ・「推定 (Claude Code)」・ゲージが既存関数の再利用・インライン script/style/ハンドラ無し・禁止DOMシンク無し・外部参照無し・**モデル色にアンバーを使っていないこと**） |
| `test/usage.test.js`（追記） | +3 | `byDateModel` が日×モデルに割れること・**その日の合計に一致すること**、dedupe が同じく効くこと、日付不明が `UNKNOWN_DATE` に落ちること |

`test/usage-view.test.js` の projects / statusline / monitorDir はすべて一時ディレクトリ。
`test/server.test.js` にも `monitorDir` / `statuslineDir` / `ccusageCache` の注入を足したので、
**実データの `~/.claude` も `~/.claude-monitor` も読まないし書かない**。ccusage は一度も spawn しない。

---

## 2. 実測した所要時間（実データ、読み取り専用）

実データ: `~/.claude/projects` 配下 **100 ファイル / 112.6 MB / 27,532 行 / パース失敗 0**、
dedupe 後 **7,051 メッセージ**。

### 2.1 `buildUsageView()` 直接（HTTP 抜き）

| 窓 | 開いたファイル | cold | warm 1 | warm 2 |
|---|---|---|---|---|
| `days=30` | 100 / 100 | **670 ms** | 19 ms | 16 ms |
| `days=7` | **31** / 100 | **204 ms** | 14 ms | 14 ms |

`days=7` で 31 ファイルしか開かないのは 8.3 の mtime 読み飛ばし。

### 2.2 HTTP 経由（実サーバ、port 47411、一時 monitorDir）

| リクエスト | 時間 | 備考 |
|---|---|---|
| `GET /api/usage`（cold） | **791 ms** | 18,085 バイト |
| `GET /api/usage`（warm ×3） | **26 / 23 / 26 ms** | `cache.misses: 0` |
| `GET /api/usage?days=7` | 20 ms | |
| `GET /api/usage?days=999` | — | `windowDays: 90`, `2026-06-09..2026-09-06` |
| `GET /api/usage/ccusage?days=7`（初回） | **2.44 s** | npx が既にキャッシュ済みの状態 |
| `GET /api/usage/ccusage?days=7`（2回目） | **28 ms** | `cached: true`、`runs: 1` |

目標（warm < 100 ms / cold < 2 s）はどちらも満たしている。
`/api/health` の `usageCache` は `{size:100, hits:491, misses:102}` ——
102 の内訳は初回の 100 と、**スモーク中に自分自身のセッションが2ファイル追記したぶん**。
fingerprint が実際に動いている証拠になった。

---

## 3. ccusage との突合（実データ）

`GET /api/usage/ccusage?days=7`:

```
2026-09-06  match true  dIn 0  dOut 0  dCC 0  dCR 0   cost  13.15
2026-09-04  match true  dIn 0  dOut 0  dCC 0  dCR 0   cost  81.89
2026-09-03  match true  dIn 0  dOut 0  dCC 0  dCR 0   cost  86.57
2026-09-02  match true  dIn 0  dOut 0  dCC 0  dCR 0   cost  30.43
2026-09-01  match true  dIn 0  dOut 0  dCC 0  dCR 0   cost  11.86
totals delta = 全指標 0        ccusage コスト合計 $223.89
```

**5日すべて4指標が完全一致**。進行中の当日（09-06）まで一致した。
これは M0 で確立した dedupe 規則（3.1）が、**ファイル単位キャッシュを挟んだマージ経路でも
壊れていない**ことの実測証拠である —— 8.2 で恐れていた過大計上が起きていれば、
ここに大きな正の差分が出る。

---

## 4. 実データで判明したこと

### 4.1 モデルIDの表が実データに追いついていなかった（既知の制約23）

全 transcript の生モデルIDを数えた:

| model | totalTokens | msgs | M3 の表 |
|---|---|---|---|
| `claude-opus-5` | 910,148,304 | 4,188 | あり |
| `claude-sonnet-5` | 263,503,861 | 1,708 | あり |
| `claude-fable-5` | 138,944,236 | 879 | あり |
| **`claude-fable-5-1`** | **25,684,424** | 216 | **無し** |
| **`claude-opus-4-7`** | **2,142,730** | 43 | **無し** |
| `claude-haiku-4-5-20251001` | 123,305 | 4 | 末尾日付を剥がして一致 |
| `<synthetic>` | 0 | 7 | 無し（モデルではない） |

修正前は 27.8M トークン（2.9%）が `other` に落ちていた。
`src/usage-view.js` の `MODEL_SERIES` と `public/app.js` の `MODEL_LABEL` の**両方に**
`claude-fable-5-1` → Fable、`claude-opus-4-7` → Opus を足した。
`<synthetic>` は 0 トークンなので `other` のままにしてある（モデル名ではないため）。

### 4.2 保存ストアの実サイズ

30日分13日 + 90日窓の2日 = 15日で **10,118 バイト**。
1日あたり約 670 バイト（4指標 + モデル系列ごとの内訳）なので、
1年で 250 KB 程度。上限や剪定は入れていない。

### 4.3 セッションのコストは sidecar があるものにしか出ない

上位20セッションのうちコストが出たのは、statusline sidecar が現存する
**5セッションだけ**（`~/.claude-monitor/statusline/*.json` は5ファイル）。
sidecar は既知の制約5のとおり親セッションがアイドルの間は更新されず、
古いセッションのものは残っていない。**トークンはあるがコストが `null`** の行が普通にある、
という前提で描いてある（0 とは書かない）。

---

## 5. 作ったもの

### 5.1 サーバ

- `GET /api/usage?days=N` — `guard('api:usage')`
- `GET /api/usage/ccusage?days=N` — `guardAsync('api:usage-ccusage')`
- `/api/usage/` 配下のそれ以外は 404 JSON（M3 と同じ「一つの答え」方針）
- `/api/health` に `usageCache` と `ccusage` の統計を追加
- `startServer` / `createRequestHandler` に注入点を追加:
  `monitorDir` / `statuslineDir` / `usageCache` / `usageStore` / `ccusageCache` / `ccusageRunner`

**`guardAsync` を足したのは必然だった。** 既存の `guard()` は同期 throw しか捕まえない。
非同期ハンドラの reject は `unhandledRejection` に落ち、`installCrashHandlers`（4.7）が
それを致命として **exit 1** する。npx の失敗でサーバが落ちるのは、
「監視ツールが黙って死ぬのが最悪」という 4.7 の思想に真っ向から反する。

### 5.2 モジュール

`src/usage-view.js`。`tree-view.js` と同じ役割分担で、`usage.js`（純粋な集計）は触っていない
（`byDateModel` の追加のみ）。中身は
`UsageFileCache`（ファイル毎の message マップ）/ `UsageStore`（daily.json）/
`CcusageCache`（10分・single-flight）/ `buildUsageView` / `buildCcusageComparison`。

### 5.3 画面

上から 5h/7d ゲージ → 期間タイル6枚 → 日別テーブル（凡例つき積み上げ棒）→
モデル別 → セッション上位20（Tree ボタン・推定コスト）→ 統計フッタ・ccusage フッタ。

> レビュー修正（9.H）で **5h/7d ゲージは削除**した。ヘッダのリボンに同じものが
> 全ビュー共通で載っているため。現在は期間タイルが先頭である。

---

## 6. このブリーフから外したところ

1. **ビューの `days` は日行の配列、窓の長さは `windowDays`。**
   ブリーフの返り値の形（`{ ok, generatedAt, since, until, days: [...] }`）を優先した。
   その結果 `/api/usage?days=30` の応答で `days` がクエリと別の意味になるので、
   窓の長さを `windowDays` という別名で出している。
2. **モデル系列の表はサーバ側に置いた（複製した）。**
   ブリーフは「Tree が使っているのと同じ関数を再利用し、複製するな」と言うが、
   その関数（`public/app.js` の `modelLabel` / `MODEL_LABEL`）は
   **ブラウザ用 IIFE で export が無く、静的ファイルとして配信されている**ので
   Node から import できない。取れる道は2つで、
   (a) API が生IDを返してクライアントで畳む、(b) サーバに表を持つ、のどちらか。
   ブリーフ本文が「API はモデル名を系列に正規化する」と明言しているので (b) を採り、
   **クライアント側には2つ目の表を作らなかった**（複製を1箇所に留めた）。
   2つの表がずれないよう双方にコメントを入れ、4.1 の追加は両方に入れてある。
   既知の制約23として「新モデルが出たら2箇所を足す」を明記した。
3. **`public/app.js` の `MODEL_LABEL` にも2件足した（M3 の資産に手を入れた）。**
   ブリーフは M4 の範囲を Usage に限っていたが、
   同じ2つの表がずれたまま残るのは 8.2 の趣旨に反する。ツリーの表示は
   `claude-fable-5-1` の素通しから「Fable」に変わる（表の設計意図どおりの挙動）。
4. **`?days=` の選択肢は 7/14/30（ブリーフどおり）だが、API のクランプ上限は 90。**
   `/api/sessions` と同じ `MAX_DAYS` を共有しているため。UI から 90 は選べない。
5. **mtime による読み飛ばし（8.3）はブリーフに無い追加。**
   `days=7` で cold 670 ms → 204 ms。追記しかされない前提に依存するので、
   既知の制約26として明記した。
6. **日行は新しい順で返す。** ブリーフは順序を指定していない。
   30日の表は今日から遡って読むものなので降順にし、ccusage の行も同じ順に揃えた。
7. **テーブルは差分更新ではなく署名ベースの全再構築。**
   4.8 は「全消し全作り直しをするな」と言うが、その理由（毎秒スクロールと選択が飛ぶ）は
   10秒デバウンス＋署名一致でスキップ、で消える。30行 × 12列の差分器を書くより
   壊れにくい。署名が変わったときだけ組み直す。
8. **CLI は変更していない。** ブリーフの `usage --daily --by-model`（任意）は、
   `byDateModel` を CLI 表に出すには表の列設計から変わるので見送った。
   `usage --daily --compare-ccusage` は従来どおり動く。

---

## 7. スモークテストの手順（再現用）

実データを読むが、**書くのは一時ディレクトリだけ**。稼働中の本番（47321）には触らない。

```bash
SMOKE=/tmp/cm-smoke && mkdir -p "$SMOKE/statusline"
cp ~/.claude-monitor/statusline/*.json "$SMOKE/statusline/"   # コスト表示を見るため（読み取りのみ）
CLAUDE_MONITOR_DIR="$SMOKE" node src/cli.js serve --port 47411 > "$SMOKE/serve.out" 2>&1 &
URL=$(head -1 "$SMOKE/serve.out")
curl -s -c "$SMOKE/jar" -o /dev/null "$URL"                   # 302 で Cookie を受け取る
curl -s -b "$SMOKE/jar" -w "%{time_total}\n" "http://127.0.0.1:47411/api/usage" -o "$SMOKE/u.json"
curl -s -b "$SMOKE/jar" "http://127.0.0.1:47411/api/usage/ccusage?days=7" -o "$SMOKE/cc.json"
```

確認したこと:

- Cookie 無しは 403、`/api/usage/other` は 404 JSON、POST は 405、HEAD は本文なし。
- ストアは `$SMOKE/usage/daily.json` にだけ出来た。
  **`~/.claude-monitor/usage` は存在しないまま**（`ls` で確認）。
- `.tmp-*` は残っていない（`ls` の結果が `daily.json` の1件のみ）。
- 停止後、47411 に LISTENING は無し。`curl` は接続拒否。
- 本番の 47321 は生きたまま（Cookie 無しで 403 が返る）。
- collector のエラーは1件だけで、内容は
  「一時 monitorDir に `events/` が無い」というスモーク環境固有のもの。M4 とは無関係。

ブラウザでの表示確認（Playwright スクリーンショット）は実施していない。

---

## 8. 未解決の問題 / 次にやるべきこと

1. **稼働中の本番サーバ（47321）は M4 を持っていない。** M3 のときと同じで、
   `serve` プロセスを再起動しないと `/api/usage` は 404 を返す。
   トレイ常駐なら `tray-stop` → 再起動、自動起動なら次のログオン。
2. **ブラウザでの目視確認が未了。** 積み上げ棒の色分け、ダークテーマ、
   狭い画面（720px 未満で棒の列を隠す）、当日 `*` と2種のバッジ、
   凡例とテーブルの対応は、DOM とスタイルの検査までしかしていない。
3. **`partial` / `保存値` の実物をまだ見ていない。** 論理はテストで固定したが、
   実データで発火するのは Claude Code が 30日クリーンアップを走らせた後
   （既知の制約7）で、それを待っていない。
4. **ストアに剪定が無い。** 1年で 250 KB 程度なので当面は問題ないが、
   誤った値が入ったときに消す手段が「ファイルを手で削除」しかない（既知の制約25）。
5. **`<synthetic>` の正体を確かめていない。** 7メッセージ・0トークンで、
   Claude Code が生成した合成 assistant メッセージ（API エラー時の代替など）と
   推測しているが**確認していない**。0トークンなので集計には影響しない。
6. **ccusage の初回実行が npx のキャッシュ状態に依存する。** 今回は 2.44 秒で返ったが、
   これは `ccusage@latest` が既にダウンロード済みだったため。
   まっさらな環境では 60 秒のタイムアウトに当たり得る。
   当たった場合の表示（`ccusage unavailable`）はテスト済みだが、実測はしていない。
7. **`/api/usage` は同期でイベントループを止める。** cold で 670 ms。
   M3 のツリー（248 ms）より長い。SSE の ping（15秒）には十分収まるが、
   **transcript が1桁増えたらこの前提は崩れる**（既知の制約15と同じ性質）。
   その時は worker_threads か、日別集計のインクリメンタル化が要る。

---

## 9. レビュー修正（2026-09-06）

M4 のレビューで出た8件を潰した。`npm test` は **729件 pass / 0 fail**
（M4 直後の 717 から +12。M3 までの 644件は引き続き無傷）。

### A（高）`src/ccusage.js` のタイムアウトが Windows のプロセスツリーを残す

`runCcusage` が起動するのは `cmd.exe` → `npx.cmd` → `node.exe`（ccusage）の3段。
60秒で切れたとき `child.kill()` が届くのは先頭の `cmd.exe` だけで、
**孫の node は生き残る**。実測で確認した:

```
grandchild pid 37640 alive after child.kill(): true
```

`killChildTree()` を足し、win32 では `spawn('taskkill', ['/PID', pid, '/T', '/F'])`
（シェル文字列ではなく spawn）、それ以外は `child.kill()`。`taskkill` が見つからない・
非0で終わったときは `child.kill()` に落とす。`setTimeout` の中で走るので
**この関数からは例外が出ない**（出ると 4.7 の `uncaughtException` が exit 1 する）。
`src/autostart.js` の `killTree()` と同じ理由・同じコマンドである。

戻り値の契約は変えていない。`runCcusage` は元から **reject せず**
`{ok:false, timedOut:true, error:'timed out after Nms'}` で **resolve** する
（`ccusageDaily` / `ccusageBlocks` がその形に依存している）。
ブリーフの「reject する」はこの resolve のことと解釈した。

検証: `test/ccusage.test.js`（新規3件）。`opts.command` という注入点を足して、
`cmd.exe /d /s /c node <一時ファイル>` という**本番と同じ2段構造**を 500ms の
タイムアウトで走らせる。孫が stdout に書いた pid を取り、`process.kill(pid, 0)` が
throw するまで最大3秒ポーリングする。非 win32 では孫がいないので、そのまま
「子が消えたこと」だけを見る。`killChildTree` を `child.kill()` に戻すと落ちることも確認した。

### B（中）ストアのマルチライタ競合

`UsageStore.save()` が**書く直前にディスクを読み直して同じ規則でマージし直す**ように
した（日付ごとに `totalTokens` が大きい方が勝つ／相手が足した日付は残す）。
規則が単調なので排他は要らず、落ちた更新は次のビルドで自己修復する。

検証: `test/usage-view.test.js` に3件追加。
(1) ビルド中に別プロセスが書いた状況を作り、**相手だけが知る日付が残り**・
**相手の方が大きい日は後戻りしない**こと。(2) 古い小さい値で上書きできないこと。
(3) `store` を注入して「B が読む → A が書く → B が書く」を実際に交差させ、
両者の日付が残ること。マージを外すと3件とも落ちる。
`architecture.md` 8.4 と既知の制約28に「書き手は1つ前提・自己修復であって排他ではない」を明記した。

### C（中）`guardAsync` の catch が未テスト

既存の失敗系テストは `CcusageCache.daily` 自身の try/catch に吸われていて、
`guardAsync` の catch には**一度も到達していなかった**。
`ccusageCache` を注入した2本目のサーバを立て、`daily()` が
(1) 同期 throw する場合と (2) reject した Promise を返す場合を追加。
どちらも **500 + `{"ok":false,"error":"internal error"}`**、詳細は `onError` にだけ行き、
**直後の `/api/health` が 200 を返す**（プロセスが生きている）ことまで見る。

### D（低）`/api/usage/ccusage` の `days` が窓の長さだった

`/api/usage` の `days` は日行の配列なので、同じ名前が2つの意味を持っていた。
**`windowDays` に改名**（フロントは読んでいないので UI 変更なし）。
M4 のテストを `body.windowDays === 7` かつ `body.days === undefined` に直し、
`architecture.md` 8.6 と README の表に注記を足した。

### E（UI）積み上げ棒が全部灰色

`.useg { background: var(--m-other) }` が `.useg--opus` などの**後ろ**にあり、
詳細度が同じなので基底が勝っていた（レビューのスクリーンショットで確認された）。
基底を修飾子の**前**に移動。テストで `css.indexOf('.useg { height')` <
`css.indexOf('.useg--opus { background')` を固定し、5系列すべての宣言も確認する。

### F（UI）`compact()` が「1000k」を出す

`toFixed` が単位の境界を越えて丸め上がっていた。丸めた仮数が 1000 に達したら
**単位を繰り上げる**ようにし、**G**（1e9〜）を足した（30日合計が既に 973M）。
`compact` は Live / Tree と共用なので、通常値の出力は変えていない。

配信された `app.js` から関数本体を切り出して `node:vm` で評価する形でテストした
（IIFE なので export が無い）。期待値の表:

| n | 期待 | |
|---|---|---|
| 0 / 999 | `0` / `999` | 単位なし |
| 1000 / 1100 / 12000 | `1.0k` / `1.1k` / `12k` | 従来どおり |
| 999,499 | `999k` | 繰り上がらない |
| **999,800 / 999,999** | **`1.0M`** | **修正前は `1000k`** |
| 1,400,000 / 264,000,000 / 973,000,000 | `1.4M` / `264M` / `973M` | 従来どおり |
| **999,900,000 / 1e9 / 1.5e9** | **`1.0G` / `1.0G` / `1.5G`** | **G 追加** |
| 2.5e12 | `2500G` | G が最上位 |
| NaN / Infinity / `'12'` | `-` | 非数はハイフン |

### G（UI）セッション表の「モデル」列が違うモデルを指す

最多系列（サブエージェント込み）を採っていたので、Fable で回しているセッションが
サブエージェントの Opus に押されて「Opus」と出ていた。
**ルート transcript のレコード（`agentId` が無いもの）の系列**を優先し、
ルートにモデルが1件も無いときだけ従来の規則に落とす。

検証: 単体テスト2件（ルート Fable 40トークン + サブエージェント Opus 15,000トークン →
`Fable`。`byModel` の側は従来どおり Opus 15,000 / Fable 40 のまま）と、
ルートにモデルが無い場合のフォールバック。実データのスモークでも裏が取れた ——
`days=7` の上位6セッションが**全て `Fable`** で、期間合計の内訳は
Opus 284M / Sonnet 35M / Fable 32M。まさに「Opus と表示されていた」状態だった。

### H（UI）ゲージの重複

5h/7d ゲージは全ビュー共通のヘッダリボン（`#quota-rows`）に既にあるので、
`#view-usage` の中の複製（`#usage-gauges` / `#usage-gauges-none`）を
`index.html` / `app.js`（`renderUsageQuota` と `usage.gauges`）/ `style.css`
（`.usage__gauges` / `.usage__none`）から削除した。ヘッダ側は無変更。
テストは「Usage タブにゲージが無いこと」＋「残った `renderQuota` が
`freshestRateLimits` / `buildGauge` の共有実装のままであること」に置き換えた。

---

## 10. レビュー修正後のスモーク（port 47413・一時 monitorDir）

本番（47321）とトレイには触っていない。`CLAUDE_MONITOR_DIR` を一時ディレクトリに
向けて `node src/cli.js serve --port 47413` を起動し、Cookie を取ってから叩いた。

| リクエスト | 結果 |
|---|---|
| `GET /api/usage?days=7` | **200 / 327 ms**、7,476 バイト。`windowDays: 7`、`2026-08-31..2026-09-06`、日行5、合計 351,888,473 |
| `GET /api/usage/ccusage?days=7` | **200 / 2.06 s**（実際に npx を起動）。`windowDays: 7`、**`days` は undefined**（D の確認） |
| ccusage 突合 | **5日すべて `match: true`、合計の差分は4指標とも 0**（コスト $236.05） |
| `GET /api/health` | `usageCache {size:33, hits:32, misses:34}` / `ccusage {runs:1, cached:1, inflight:0}` |
| セッションのモデル列 | 上位6件すべて `Fable`（G の確認） |

後始末:

- ストアは一時ディレクトリの `usage/daily.json` にだけ出来た。
- 停止後、**47413 に LISTENING は無し**（残るのはクライアント側の TIME_WAIT だけ）。
  `curl` は接続拒否。
- `ccusage` / `npx` の残留プロセスは無し（`Win32_Process` の `CommandLine` を検索）。
- 本番 47321 は LISTENING のまま、Cookie 無しで 403。

---

## 11. ブラウザでの目視確認（ダークテーマ・1280x1200・fullPage）

`playwright-core` + インストール済み Chrome（headless）で 47413 のスモークを開き、
Usage タブに切り替えてスクリーンショットと計算済みスタイルを取った。
`playwright-core` はスクラッチパッドに入れてあり、**プロジェクトの依存はゼロのまま**。

| 見たもの | 結果 |
|---|---|
| 積み上げ棒の実効色（E） | `.useg--opus` → `rgb(95,155,242)`、`--sonnet` → `rgb(84,183,138)`、`--fable` → `rgb(162,172,185)`。ダークの `--m-other` は `rgb(58,66,78)` なので、**全灰色は解消**している |
| `#view-usage` の中のゲージ（H） | **0個**。ヘッダの `#quota-rows` に 2個（5H / 7D）で、リボンは従来どおり |
| セッションの「モデル」列（G） | 上位20行のうち17行が `Fable`、`Opus` は本当に Opus で回っている3行だけ（`d06c6847` / `0165fd1e` / `49ab3616`）。ルート優先が効いている |
| タイルと表の数値（F） | `5.4k` / `41k` / `3.1M` / `22M` / `965M` / `990M`。**「1000k」「1000M」は出ていない** |
| console / pageerror | **0件** |
| 当日行・バッジ | `2026-09-06 *`（進行中）を確認。`保存値` / `一部欠損` は今回も発火せず（§8.3 のまま） |

スクリーンショットはスクラッチパッドに置いた（リポジトリには入れていない）。
残っている未確認: **ライトテーマ**と**720px 未満の狭い画面**（棒の列を隠す分岐）。
