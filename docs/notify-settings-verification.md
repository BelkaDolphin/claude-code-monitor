# 通知設定 動作確認ログ（2026-09-07）

対象: `public/notify-rules.js`（新規・純粋関数）/ `public/{index.html,app.js,style.css}`
（設定パネルと通知経路）/ `src/server.js`（静的配信リストに1本追加のみ）。

環境: Windows 11 Pro 10.0.26200 / Node v24.13.0 / Google Chrome（`channel: 'chrome'`）/
`Asia/Tokyo`。外部npm依存はゼロのまま（ブラウザ確認に使った playwright-core は
scratchpad 側に置いてあり、プロジェクトには入れていない）。

サーバ側は**設定を1バイトも知らない**。設定エンドポイントも保存ファイルも作っていない。

---

## 1. テスト結果

```
$ npm test
ℹ tests 806
ℹ suites 156
ℹ pass 806
ℹ fail 0
ℹ duration_ms 7468
```

M4 までの **753件は全て pass のまま**（1件だけ既存アサーションを更新した。§4）。
通知設定で 53件追加した。

| ファイル | 件数 | 内容 |
|---|---|---|
| `test/notify-rules.test.js`（新規） | 37 | `defaults()` が「設定が無かった頃の挙動」と一致すること（通知 OFF・全種類 ON・`quietWhenFocused` true・しきい値80）と毎回新しいオブジェクトを返すこと、種類が `NOTIFY_TYPES` 4つ + `turn_complete` であること、`spend_limit` が対象外であること、`normalizeThreshold` / `parseThreshold` が **1〜100の整数だけ**を通し 0・101・小数・文字列・空を落とすこと、`normalize()` が未知キーを捨て既知キーの型違いを既定値に落として**投げない**こと、`parse()` の移行3態（何も無い→既定＋書き戻し要求／旧キー `'1'`→`enabled` だけ真／新キーが有効なら旧キーを無視）と壊れた JSON・非オブジェクト・未知 version が**黙って既定値に戻り書き戻しを要求する**こと、JSON 往復で壊れないこと、`evaluateQuota()` の武装規則（1回だけ鳴る／下回ると再武装／`resets_at` が変わると同じ使用率でも再武装／しきい値変更で再武装／しきい値を上げただけでは鳴らない／`prime` は記録だけ／`on:false` は状態ごと捨てる／再ONで再武装／2窓が独立／**窓が消えた snapshot では記憶を据え置き**／`used_percentage` が数値でなければ「読めなかった」扱い／`resets_at` 欠損でも鍵が安定／`spend_limit` 無視／**前の武装状態を破壊しない**／引数が壊れていても投げない／しきい値100は100でだけ鳴る）、配信ファイル自体が禁止DOMシンクとブラウザグローバルに触れていないこと |
| `test/server.test.js`（追記） | +16 | `/notify-rules.js` が Cookie 無しで 403・有りで 200 かつ javascript であること、**HTML が app.js より前にそれを読むこと**、パネルの id 15個が全て存在すること、しきい値入力に `min="1" max="100"` が markup にもあること、`aria-expanded`/`aria-controls`/`label for` が付いていること、クライアントが**1つの versioned キーだけ**を書き旧キーは消す側であること、判定を再実装せず `RULES.*` に委ねていること（`renderQuota()` の戻り値を使う＝**最新capture の選択規則が1箇所**）、通知経路が全て設定を見ること、初回スナップショットが `prime` であること、**テスト通知が `canNotify()` を通らないこと**、Esc と外クリックで閉じること、rules ファイルに禁止DOMシンクが無いこと、パネル markup にインライン script/style/ハンドラが無いこと、`.npanel` 系の CSS があること、**`/api/notify` のような経路がクライアントにもサーバにも無いこと** |
| `test/server.test.js`（更新） | 1 | Usage タブの M4 バッジの検査を「バッジが**消えている**こと」に反転（§4） |

`test/notify-rules.test.js` は `public/notify-rules.js` を `fs.readFileSync` +
`node:vm` の `runInThisContext` で読む。**ブラウザとテストが同じ1本のファイルを見る**
ので、ルールが二重実装になり得ない。

> 実装中に踏んだ罠: 最初 `vm.createContext()` の**別 realm** で評価したところ、
> `assert.deepStrictEqual` がプロトタイプ違いで**19件まとめて落ちた**。
> ルールは全く正しいのに落ちる。同一 realm（`runInThisContext`）に変えて解決。
> `node --test` はファイルごとに別プロセスなので、グローバルの汚染は波及しない。

---

## 2. ブラウザでの目視・実挙動確認（Chrome・1280x900）

一時ポート **47431** + 一時 `CLAUDE_MONITOR_DIR` / `CLAUDE_CONFIG_DIR`（`os.tmpdir()` 配下）で
`node src/cli.js serve --port 47431` を起動し、起動ログに出たトークン付きURLを
そのまま開いた。**ユーザーの本番サーバ（47321・`~/.claude-monitor`）には接続していない。**
終了後 `netstat` で 47431 に LISTENING が残っていないことを確認済み。

`window.Notification` は `addInitScript` で**呼び出しを記録するスタブ**に差し替えた
（permission は `granted`）。headless でなくても OS 通知は検証に使えないため、
「クライアントが何件・どの内容で通知しようとしたか」を数える方針にした。

| # | 確認したこと | 結果 |
|---|---|---|
| 1 | `/notify-rules.js` が読まれ `window.CMNotifyRules` が存在する | OK |
| 2 | 初回読み込みで `cm.notify.settings` に既定値が書かれる（`v:1`・`enabled:false`） | OK |
| 3 | 「通知設定」でパネルが開き `aria-expanded="true"` になる | OK（目視確認済み） |
| 4 | しきい値55・「ターン完了」OFF・「見ている間は鳴らさない」OFF が**保存ボタン無しで**即保存される | OK |
| 5 | しきい値に `0` を入れると**黙って捨てられ 80 が戻る**（表示も保存値も） | OK |
| 6 | Esc でパネルが閉じる | OK |
| 7 | リロード後もしきい値55・チェック状態が残っている | OK |
| 8 | `cm.notify.enabled='1'` だけを仕込んで読み込むと `enabled:true` に移行し、**旧キーが消え**、ヘッダが「通知 ON」`aria-pressed="true"` になる | OK |
| 9 | 初回スナップショットでは1件も通知しない（prime） | OK（0件） |
| 10 | ONにした種類（`permission_prompt`）の hook イベントを events に追記すると1件通知する | OK（`smoke — 許可の確認`） |
| 11 | OFFにした種類（`agent_completed`）を追記しても**増えない** | OK（1件のまま） |
| 12 | sidecar の `five_hour` を 20%→71%（しきい値50）にすると `tag: quota:five_hour` が1件出る | OK（本文 `71% 使用 · 復帰 22:46`） |
| 13 | さらに 83% に上げても**再通知しない** | OK（1件のまま） |
| 14 | 「テスト通知」は `quietWhenFocused` もマスタースイッチ OFF も無視して出る | OK（`claude/monitor — テスト`） |
| 15 | Usage タブから `M4` バッジが消え、`.tab__m` の要素が0個 | OK |
| 16 | console エラー・pageerror が0件 | OK |

**16/16 pass**。パネルを開いた状態のスクリーンショットも撮って目視確認済み
（配色・行の揃い・ラベルの対応・ヘッダのボタン列が崩れていないこと）。
スクリーンショットはリポジトリ直下に置いたので `.gitignore` の `/*.png` で除外される。

---

## 3. 作ったもの

### 3.1 モジュール

- `public/notify-rules.js` —— classic script（`window.CMNotifyRules`）。
  `defaults` / `normalize` / `normalizeThreshold` / `parseThreshold` / `parse` /
  `evaluateQuota`。**DOM も localStorage も Notification も触らない**ので、
  ブラウザとテストで同じ1本を評価できる。詳細は architecture 9.2。

### 3.2 画面

- ヘッダに「通知設定」ボタン。押すと `topbar__actions` にアンカーした
  ポップオーバー（`.npanel`）が開く。中身はチェックボックス8個
  （種類5・利用枠2・`quietWhenFocused` 1）と数値入力2個、テスト通知、閉じる。
  変更は即保存・即反映。Esc / 外クリック / 「閉じる」で閉じ、フォーカスは
  開閉ボタンへ戻る。
- パネル下部に**なぜ今は鳴らないか**の1行（許可していない／ブロックされている／
  マスタースイッチが OFF）。空文字の時は CSS の `:empty` で行ごと消える。
- 保存形式は `cm.notify.settings` に JSON 1個（architecture 9.3）。
  旧キー `cm.notify.enabled` は初回に取り込んで削除する。

### 3.3 通知経路

- `fireNotifications()` が種類ごとに設定を見る。**OFF の種類は「処理済み」として
  記録だけ進める**（あとでONにしたときに溜まった分が一気に出ない）。
- `canNotify()` の「見ている間は黙る」を `quietWhenFocused` で切り替え可能にした。
- `fireQuotaNotifications()` を追加。`renderQuota()` が**自分の描いた `rateLimits` を
  返す**ようにして、それを渡す（最新 capture の選択規則を2箇所に書かない）。

---

## 4. このブリーフから外した／変えたところ

- **既存テストを1件だけ書き換えた。** `test/server.test.js` の
  「Usage タブは `<span class="tab__m">M4</span>` を持つ」というアサーションは、
  バッジを外す指示と**正面から矛盾する**ので、削除ではなく
  「バッジが markup からも CSS からも消えていること」に反転させた。
  仕様変更に伴う更新であって、実装を通すための書き換えではない。
- **サーバ側の通知（トーストや設定API）は作っていない。** M2 の決定どおり。
  理由は architecture 9.1 に書いた。
- **`spend_limit` のしきい値通知は作っていない。** 金額の上限であって使用量の窓ではなく、
  再武装に使える `resets_at` を持たないため（既知の制約32の隣）。
- **通知音・通知のクリック先の設定は作っていない。** Web Notifications の
  `silent` や `requireInteraction` はブラウザごとに挙動が違い、
  「設定はあるが効かない」項目になりやすい。
- **設定のエクスポート／インポートは作っていない。** ブラウザを変えると消えることの
  救済にはなるが、項目が10個しかないうちは入れ直す方が早い（既知の制約30）。

---

## 5. スモークテストの手順（再現用）

```bash
# 1) 一時ディレクトリと一時ポートで起動（本番の 47321 / ~/.claude-monitor には触らない）
CLAUDE_MONITOR_DIR=/tmp/cm-smoke/monitor CLAUDE_CONFIG_DIR=/tmp/cm-smoke/claude \
  node src/cli.js serve --port 47431
# 起動ログの http://127.0.0.1:47431/?t=<64桁hex> をそのままブラウザで開く

# 2) 通知を出させるには hooks の events に1行追記する
#    <CLAUDE_MONITOR_DIR>/events/<YYYY-MM-DD>.jsonl に
#    {"receivedAt":"...","hookEventName":"Notification","hook_event_name":"Notification",
#     "session_id":"<sid>","notification_type":"permission_prompt","message":"..."}

# 3) 枠のしきい値を試すには statusline サイドカーを書き換える
#    <CLAUDE_MONITOR_DIR>/statusline/<sid>.json の
#    rate_limits.five_hour.used_percentage を上げる（resets_at は未来のepoch秒）

# 4) 終わったらプロセスを落とし、ポートが空いたことを確認する
netstat -ano | grep 47431   # LISTENING が無ければOK
```

ブラウザ側の確認は playwright-core（`chromium.launch({ channel: 'chrome' })`）で
自動化した。`window.Notification` をスタブに差し替えると、OS 通知に頼らずに
「何件・どの `tag` で鳴らそうとしたか」を数えられる。

---

## 6. 未解決の問題 / 次にやるべきこと

1. **`quietWhenFocused` は「このタブ」しか見ていない。** 同じダッシュボードを
   2つのタブで開いていると、裏のタブは鳴らし、前のタブは黙る。
   タブ間で協調する仕組み（`BroadcastChannel` など）は入れていない。
2. **しきい値を跨いだ瞬間を取りこぼす経路がある。** sidecar が更新されないまま
   枠が減っていくと（既知の制約5）、次に sidecar が動いた時には既に超えている。
   その1回は鳴る（`prime` ではないので）が、**いつ超えたかは分からない**。
3. **設定の移行パスは今の1本しかない。** `v:2` を作る日が来たら、
   `parse()` は「知らない version は既定値に戻す」しか知らないので、
   `v:1 → v:2` の変換をそこに足す必要がある。今は**戻す**のが正しい挙動。
4. **テスト通知が OS に届いたかは検証できない。** 集中モードや通知センターの設定は
   ブラウザから見えない（既知の制約34）。「テスト通知を押しても何も出ない」という
   問い合わせに対して、ダッシュボード側から言えることは
   「ブラウザは受け付けた」までである。
5. **パネルにフォーカストラップは入れていない。** Esc と外クリックで閉じ、
   閉じたら開閉ボタンにフォーカスが戻るところまで。Tab でパネルの外へ抜けられる。
   小さなポップオーバーとしては許容範囲だが、厳密なダイアログの作法ではない。
