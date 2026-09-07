# M0検証: 公式ドキュメント調査（2026-09-02）

## 出典URL一覧

- https://code.claude.com/docs/en/statusline
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/hooks-guide
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/llms.txt
- https://ccusage.com/
- https://ccusage.com/guide/json-output
- https://ccusage.com/guide/blocks-reports
- https://ccusage.com/guide/cli-options
- https://ccusage.com/guide/live-monitoring
- https://github.com/ccusage/ccusage
- https://raw.githubusercontent.com/ccusage/ccusage/main/docs/guide/json-output.md
- https://raw.githubusercontent.com/ccusage/ccusage/main/docs/guide/blocks-reports.md
- https://raw.githubusercontent.com/ccusage/ccusage/main/docs/guide/cli-options.md
- https://raw.githubusercontent.com/ccusage/ccusage/main/docs/guide/live-monitoring.md
- https://raw.githubusercontent.com/ccusage/ccusage/main/docs/guide/claude/index.md
- https://raw.githubusercontent.com/ccusage/ccusage/main/rust/adapters/claude/src/README.md
- https://registry.npmjs.org/ccusage/latest
- https://registry.npmjs.org/@anthropic-ai/claude-code/latest
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
- https://github.com/ccusage/ccusage/releases (GitHub API)
- https://api.github.com/repos/ccusage/ccusage/contents/... (リポジトリ構造確認, GitHub API)
- （非公式・コミュニティソース、4章の裏取り用）https://gist.github.com/samkeen/dc6a9771a78d1ecee7eb9ec1307f1b52
- （非公式）https://databunny.medium.com/inside-claude-code-the-session-file-format-and-how-to-inspect-it-b9998e66d56b
- （非公式）https://claude-dev.tools/docs/jsonl-format
- （非公式）https://github.com/anthropics/claude-code/issues/22526

すべて取得日 2026-09-02。原文引用は取得したページ・ファイルからの直接引用（英語原文のまま）。

---

## 1. statusline の stdin JSONスキーマ

**出典**: https://code.claude.com/docs/en/statusline （取得日 2026-09-02）

### 完全JSONスキーマ（原文そのまま、Accordion "Full JSON schema"より）

```json
{
  "cwd": "/current/working/directory",
  "session_id": "abc123...",
  "session_name": "my-session",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/path/to/transcript.jsonl",
  "model": {
    "id": "claude-opus-5",
    "display_name": "Opus"
  },
  "workspace": {
    "current_dir": "/current/working/directory",
    "project_dir": "/original/project/directory",
    "added_dirs": [],
    "git_worktree": "feature-xyz",
    "repo": {
      "host": "github.com",
      "owner": "anthropics",
      "name": "claude-code"
    }
  },
  "version": "2.1.90",
  "output_style": { "name": "default" },
  "cost": {
    "total_cost_usd": 0.01234,
    "total_duration_ms": 45000,
    "total_api_duration_ms": 2300,
    "total_lines_added": 156,
    "total_lines_removed": 23
  },
  "context_window": {
    "total_input_tokens": 15500,
    "total_output_tokens": 1200,
    "context_window_size": 200000,
    "used_percentage": 8,
    "remaining_percentage": 92,
    "current_usage": {
      "input_tokens": 8500,
      "output_tokens": 1200,
      "cache_creation_input_tokens": 5000,
      "cache_read_input_tokens": 2000
    }
  },
  "exceeds_200k_tokens": false,
  "prompt_cache": {
    "warm": true, "caching_observed": true, "ttl": "1h",
    "expires_at": 1738429200, "requests": 14, "misses": 2,
    "expected_rebuilds": 1, "hit_ratio": 0.91,
    "cache_write_tokens": 352000, "miss_recache_tokens": 310200,
    "last_miss_at": 1738425230, "recache_tokens_if_cold": 45000
  },
  "fast_mode": false,
  "effort": { "level": "high" },
  "thinking": { "enabled": true },
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 },
    "spend_limit": { "used_percentage": 62.8, "resets_at": 1740787200 }
  },
  "vim": { "mode": "NORMAL" },
  "agent": { "name": "security-reviewer" },
  "pr": { "number": 1234, "url": "...", "review_state": "pending" },
  "worktree": { "name": "my-feature", "path": "...", "branch": "worktree-my-feature", "original_cwd": "...", "original_branch": "main" }
}
```

### rate_limits の重要な原文

> "`rate_limits`: appears only for Claude.ai Pro and Max subscribers, or behind a Claude apps gateway that sets a spend limit for you, and only after the first API response in the session. Each window (`five_hour`, `seven_day`, `spend_limit`) may be independently absent, and Claude Code drops a window once its `resets_at` time passes."

**結論**: `resets_at` は **UNIX epoch秒**（ISO文字列ではない）。`used_percentage` は0-100の数値（%記号なし、100超えは`spend_limit`のみ有り得る）。**APIキー利用では `rate_limits` は含まれない**（Pro/Maxサブスクリプションか、spend limit付きClaude apps gatewayの場合のみ）。

### 更新トリガーの原文

> "Your script runs once when a session starts, including when you resume one. After that, it runs again when: A new assistant message arrives / `/compact` finishes / The permission mode changes / Vim mode toggles / You change the `command`... / A `refreshInterval` timer elapses... / A rate-limit window... reaches its `resets_at` time / A warm prompt cache... reaches its `expires_at` time"
> "Claude Code debounces updates at 300ms... If a new update triggers while your script is still running, Claude Code cancels the in-flight script."

**未記載/注意点**: `context_window.current_usage` は初回API応答前および`/compact`直後は`null`。`prompt_cache`はv2.1.251以降。`rate_limits.spend_limit`はv2.1.251以降。

---

## 2. hooks の仕様

**出典**: https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/hooks-guide （取得日 2026-09-02）

### 全hookイベント（原文ページのライフサイクル表より、32種）

SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd

### 共通フィールド（原文）

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "permission_mode": "default",
  "effort": { "level": "medium" },
  "hook_event_name": "PreToolUse"
}
```
> "**When running with `--agent` or inside a subagent, additional fields:** `agent_id`: Unique identifier for the subagent / `agent_type`: Agent name"

`permission_mode`の値: `"default"`, `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`

### Notification の notification_type

原文マッチャー表：`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled`

### SubagentStart / SubagentStop / Stop / SessionEnd のフィールド

ページが非常に大きく、WebFetch（内部の小型モデルが要約）ではこれらの節の生JSON例まで到達できませんでした（「Content truncated due to length」との返答）。そのため**フィールド一覧のみ**を再抽出し、さらに公式CHANGELOG.md（`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`）の該当バージョンの記述で裏取りしました。

- **Stop**: 共通フィールド + `last_assistant_message`, `stop_hook_active`
  - CHANGELOG v2.1.47: "Added `last_assistant_message` field to Stop and SubagentStop hook inputs, providing the final assistant response text so hooks can access it without parsing transcript files."
  - hooks-guideの原文: "Parse the `stop_hook_active` field from the JSON input and exit early if it's `true`" （8回連続block後に上書きされる仕様も明記）
- **SessionEnd**: 共通フィールド + `reason`（値: `clear`, `resume`, `logout`, `prompt_input_exit`, `other`）
- **SubagentStart**: 共通フィールド + `agent_id`, `agent_type`
  - CHANGELOG v2.0.43: "Added the `SubagentStart` hook event"
- **SubagentStop**: 共通フィールド + `agent_id`, `agent_type`, `last_assistant_message`, **`agent_transcript_path`**
  - CHANGELOG v2.0.42: "Added `agent_id` and `agent_transcript_path` fields to `SubagentStop` hooks."（**`agent_transcript_path`はSubagentStopのみに存在し、SubagentStartには無い**という重要な非対称性）
  - CHANGELOG（バージョン不明箇所）: "Stop and SubagentStop hook input now includes `background_tasks` and `session_crons` fields"

**取得不可**: これら4イベントの生JSONコード例そのもの（`{...}`形式の完全な例）はドキュメントページから verbatim 抽出できませんでした。フィールド名はCHANGELOGとの相互検証により高確度ですが、フィールドの型・ネスト構造の完全な原文提示はできていません。

### hooks設定ファイルの場所と優先順位

原文表（hooks-guide）:
| Location | Scope | Shareable |
|---|---|---|
| `~/.claude/settings.json` | All your projects | No |
| `.claude/settings.json` | Single project | Yes |
| `.claude/settings.local.json` | Single project | No |
| Managed policy settings | Organization-wide | Yes |
| Plugin `hooks/hooks.json` | When plugin is enabled | Yes |
| Skill frontmatter | Rest of session once invoked | Yes |
| Subagent frontmatter | While subagent is running | Yes |

明示的な「優先順位（どれが勝つか）」の記述は本文中に見当たらず、"disableAllHooks" については「Claude Code reads the value left after settings precedence applies, so a project's settings file can override yours」とのみ記載（詳細は`/docs/en/settings-reference`参照だが未取得）。

### タイムアウト既定値（原文）

> "`command`, `http`, `mcp_tool`: 10 minutes. Claude Code lowers this default to 30 seconds for `UserPromptSubmit`, `PreModelSwitch`, and `PostModelSwitch` hooks, and to 10 seconds for `MessageDisplay`."
> "`prompt`: 30 seconds." / "`agent`: 60 seconds."
> "`SessionEnd` hooks of any type share a 1.5-second budget. If your settings set a longer per-hook `timeout`, Claude Code raises the budget to match, up to 60 seconds."

### 非同期実行

原文表: `async`（trueならバックグラウンド実行）、`asyncRewake`（exit code 2でClaudeを起こす）。"The hook command is not enforced on `async: true` hooks - they run fully in background."

### サブエージェント内でのhook発火

原文（hooks-guide）:
> "Hooks from settings files, managed policy settings, and plugins also run inside subagents. When a subagent calls a tool, tool events such as `PreToolUse` and `PostToolUse` fire the same configured hooks as in the main conversation, and the input carries the `agent_id` and `agent_type` common input fields that identify the subagent."
> 補足: "For subagent hooks defined in frontmatter, Claude Code registers them only while that subagent is running... Claude Code converts a `Stop` hook in a subagent to `SubagentStop`."

---

## 3. ccusage の仕様

**出典**: `https://github.com/ccusage/ccusage`（GitHub上でリポジトリが`ryoppippi/ccusage`から`ccusage/ccusage`に移動済み）、docs/guide配下のmarkdownを直接取得、npm registry API（取得日 2026-09-02）

### バージョン

- npm registry (`https://registry.npmjs.org/ccusage/latest`)、GitHub Releases両方で **20.0.20** を確認（一致）
- npmjs.comのWebページ自体は403で直接取得不可だったが、registry APIで代替確認済み

### `daily --json` スキーマ（`docs/guide/json-output.md`より原文）

```json
{
	"daily": [
		{
			"date": "2026-05-16",
			"inputTokens": 277,
			"outputTokens": 31456,
			"cacheCreationTokens": 512,
			"cacheReadTokens": 1024,
			"totalTokens": 33269,
			"totalCost": 17.58,
			"modelsUsed": ["claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929"],
			"modelBreakdowns": [...]
		}
	],
	"totals": {
		"inputTokens": 11174, "outputTokens": 720366,
		"cacheCreationTokens": 896, "cacheReadTokens": 2304,
		"totalTokens": 734740, "totalCost": 336.47
	}
}
```

`--instances`時は`daily`ではなく`projects`キー（プロジェクト名→配列）になる。`--by-agent --json`使用時は各行に`agents`配列（`agent: "claude"`, `agent: "codex"`等）が追加される（**この"agent"はClaude Codeのサブエージェントではなく、ccusageが集計対象とするコーディングCLIツールの種別**＝claude/codex/opencode等を指す点に注意）。

### `blocks --json` スキーマ（`docs/guide/blocks-reports.md`より原文）

```json
{
	"blocks": [
		{
			"id": "2026-05-16T09:00:00.000Z",
			"startTime": "2026-05-16T09:00:00.000Z",
			"endTime": "2026-05-16T14:00:00.000Z",
			"actualEndTime": "2026-05-16T11:15:00.000Z",
			"isActive": true,
			"tokenCounts": {
				"inputTokens": 4512, "outputTokens": 285846,
				"cacheCreationInputTokens": 512, "cacheReadInputTokens": 1024
			},
			"costUSD": 156.4,
			"models": ["opus-4-1", "sonnet-4-5"]
		}
	]
}
```

※`json-output.md`内には別形式（`type: "blocks"`, `data: [...]`, `summary: {...}`）の例も併記されており、**ドキュメント内で2つの異なるJSON形状が混在**している点に注意（要検証：実際のCLI出力でどちらが正か、両ドキュメントが更新タイミングでずれている可能性）。

### dedupe方式（`rust/adapters/claude/src/README.md`より原文、想定と異なり重要）

> "Claude Code may write `isSidechain: true` entries for isolated sidechain conversations such as `/btw` `aside_question` logs under `subagents/`."
> "These files can replay parent conversation messages with the same message ID but a different request ID, including the parent cache-read usage."
> "ccusage keeps the parent entry and drops the replayed sidechain copy when at least one duplicate carries `isSidechain: true`. Distinct sidechain responses with their own message IDs are still counted."
> "When `requestId` is missing, the regular usage loader deduplicates by message ID and effective session ID."

**結論**: dedupeは「message.id + requestIdのハッシュ」という単純な仕組みではなく、**`isSidechain`フラグを考慮した特別ロジック**（sidechain側の複製を優先的に破棄）。message ID単独一致でも、`isSidechain`が絡まなければ別セッションの同一message IDは区別して保持する。

### オプション（`docs/guide/cli-options.md`原文抜粋）

- `--since` / `--until`: `YYYY-MM-DD` または `YYYYMMDD`、両端含む（inclusive）
- `--last N`: 直近N期間（daily/weekly/monthlyのみ、session/blocksには無し、`--since`等と併用不可）
- `--offline` / `-O`、`--timezone` / `-z`、`--mode auto|calculate|display`、`--order asc|desc`
- localeオプションは本ページに記載なし（**取得不可**、`--locale`という名前のオプションは確認できず）

### `blocks --active` / `--recent` / `--live`

- `--active`/`-a`: 現在アクティブなブロックのみ表示
- `--recent`/`-r`: 直近3日分
- `--live`: **v18.0.0で削除済み**（`blocks-reports.md`原文: "The `blocks --live` monitor feature has been removed in v18.0.0. This feature is available in v17.x. Please use the statusline command instead."）

**ドキュメント不整合の発見**: `cli-options.md`には依然として`ccusage blocks --live`の使用例が複数残っている（"Live monitoring mode"として）一方、`blocks-reports.md`と`live-monitoring.md`は明確に「REMOVED IN v18」と記載。ドキュメント間の更新漏れがある。

### サブエージェントjsonl集計

Claude Code自体の`subagents/`配下jsonl（`isSidechain: true`）は**集計対象に含まれるが、親と重複する部分は上記dedupeロジックで除外**される。独自のmessage IDを持つ応答は集計に含まれる。

---

## 4. `~/.claude/sessions/` と jsonl フォーマットの公式記述

**出典**: https://code.claude.com/docs/en/sessions （取得日 2026-09-02）

### 公式に確認できたこと

> "By default, Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your working directory path with non-alphanumeric characters replaced by `-`."

**重要な原文（想定と異なる、最重要発見）**:
> "Each line is a JSON object for a message, tool use, or metadata entry. **The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release.** To build on session data, use `/export` or the script interfaces instead."

つまり**公式は「jsonl直接パースは非推奨・非安定API」と明言**している。ダッシュボードがこのファイルを直接パースする設計である場合、これはM0で最も重要なリスクとして扱うべき。

### `~/.claude/sessions/`（projectsとは別ディレクトリ）について

`sessions.md`本文には**一切登場しない**。関連する公式な記述として、`claude agents --json`によるランニングセッション一覧、`state.json`（background session用、CHANGELOGに"a background session's `state.json` `detail`"という言及あり）などは存在するが、これは`~/.claude/projects/`とは別物と思われる内部実装で、**「~/.claude/sessions/」というパス名・`status: "busy"`というフィールドは公式ドキュメントに記載なし＝公式未記載**。

### jsonl内部構造（parentUuid / isSidechain / agentId）

**公式未記載**。WebSearchで見つかったのはすべて非公式のコミュニティソース：
- gist "claude-code-data-structures.md"（samkeen）
- Medium記事 "Inside Claude Code: The Session File Format"
- 個人ブログ "Claude Code JSONL transcript format explained"
- GitHub issue #22526（"corrupt parentUuid references"）

これらコミュニティ情報によれば`parentUuid`（前メッセージのUUID、先頭は`null`）、`isSidechain`（サブエージェント発行の行を示すフラグ）、`agentId`（サブエージェントごとの識別子）等が存在するとされるが、**Anthropic公式ドキュメントでの裏付けは取得できなかった**。かつ公式ページ自身が「フォーマットはバージョン間で変わる」と明言しているため、これらのフィールド名も将来変更されうる非保証の内部実装として扱うべき。

---

## 5. Claude Code の最新バージョンと変更点

### バージョン

- npm registry (`https://registry.npmjs.org/@anthropic-ai/claude-code/latest`): **2.1.258**
- npmjs.comのWebページは403で直接取得不可（registry API で代替確認）

### CHANGELOG抜粋（`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`、statusline/rate_limits/hooks/session関連、直近版）

- **2.1.258**: "Fixed telemetry (OTEL) settings pushed through server-managed settings being ignored on warm starts"
- **2.1.257**: `/doctor`のstale sandbox mask files警告追加、background session承認待ちの表示修正
- **2.1.251**: "Added a per-session prompt-cache line to `/cost`", "Added a matching `prompt_cache` object for status line scripts", "Fixed sessions getting stuck on 'text content blocks must be non-empty' errors"
- **2.1.250**: server-managed settings診断追加
- **2.1.248**: prompt-cache miss修正（トークン再定義タイミング）
- **2.1.247**: "Added the `SendFeedback` tool"
- **2.1.246**: status lineのcost/duration表示バグ修正
- **2.1.243**: `/status`に"Skipped sources"行追加、`/tasks`にサブエージェントのモデル・effort表示追加
- **2.1.239**: コスト見積もりに1.1倍の米国内推論プレミアム反映
- **2.1.234**: "Claude is now continued automatically when a claude.ai usage limit resets"（`quota_auto_resume_*`系Notificationの追加はこのあたりに対応）
- **2.1.126付近**: `PreModelSwitch`/`PostModelSwitch` hookイベント追加、"Added a Spend limit bar to `/usage` and a `rate_limits.spend_limit` status line field"（statusline docsの記載時期と一致）

hooksイベントの追加履歴（古いバージョンまで遡って確認、schema検証の根拠として重要）:
- v2.0.42: `agent_id`, `agent_transcript_path`をSubagentStopに追加
- v2.0.43: `SubagentStart`イベント追加、`tool_use_id`をPreToolUse/PostToolUseHookInputに追加
- v2.1.47: `last_assistant_message`をStop/SubagentStopに追加
- （バージョン特定できず）: Stop/SubagentStop分離、`hook_event_name`追加、`background_tasks`/`session_crons`フィールド追加

**注**: CHANGELOG.mdには日付表記がなくバージョン番号のみのため「直近3ヶ月」を日付で厳密に区切ることはできなかった（バージョン番号の並びから直近と判断）。

---

## ダッシュボード実装への影響（重要な発見まとめ）

1. **jsonlトランスクリプトの直接パースは公式に非推奨**であり、「フォーマットは各バージョンで変わりうる」と明言されている（`sessions.md`）。M0設計が`~/.claude/projects/*.jsonl`の直接パースに依存するなら、フォーマット変更に対する耐性（バージョン検知・フォールバック）を要件に入れるべき。
2. **`~/.claude/sessions/`ディレクトリと`status: "busy"`は完全に公式未記載**。既存のMEMORY.mdの前提（"sessions/稼働判定"）はコミュニティ発の非公式情報に依存している可能性が高く、裏付けが必要。
3. **`rate_limits`はPro/Maxサブスクリプションかspend limit付きgatewayでしか出ない**（APIキー直利用では出ない）。ダッシュボードがAPIキー環境でも動作する前提なら、rate_limits非表示時のフォールバックが必須。
4. **statusline更新はイベント駆動＋300msデバウンス**であり、ポーリングではない。またサブエージェント実行中は本セッションがidleだとイベントが止まるため、`refreshInterval`設定が無い限りリアルタイム性が落ちる。
5. **SubagentStop特有のフィールドとしてagent_transcript_path**が存在（SubagentStartには無い）。サブエージェント単位のトランスクリプト追跡にはSubagentStop hookの活用が有効。
6. **ccusageは20.0.20時点でRustコア（rust/adapters, rust/crates/ccusage-core）＋プラットフォーム別ネイティブバイナリという構成に移行しており**、単純なNode.js製CLIという想定は古い可能性がある（GitHub repo構造から確認、リポジトリ自体も`ryoppippi/ccusage`から`ccusage/ccusage`に移転済み）。
7. **ccusageの`blocks --live`はv18.0.0で削除済み**（statuslineコマンドが代替）。ただし公式ドキュメント内でも`cli-options.md`が未更新で矛盾した記述が残っており、ccusageドキュメント自体の一貫性に注意が必要。
8. **ccusageのdedupeは単純なmessage.id+requestIdハッシュではなく、`isSidechain`を考慮した非対称ロジック**（sidechain側の複製を優先破棄）。Claude Codeのサブエージェント使用量を独自に集計する場合、この挙動を参考にできる。
9. hooksリファレンスページは非常に大きく、WebFetchツール経由ではStop/SessionEnd/SubagentStart/SubagentStopの生JSON例を完全な形で取得できなかった（要素名のみ複数経路でクロスチェック）。M0の厳密な検証としては、可能であれば実機で`claude --debug`を使い実際のhook入力をキャプチャすることを推奨する。

---

## 追記: トランスクリプト自動削除（2026-09-02）

**出典**:
- https://code.claude.com/docs/en/data-usage （data-retentionセクション）
- https://code.claude.com/docs/en/settings-reference （設定一覧表）
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md

### `cleanupPeriodDays` の存在

`settings-reference`の設定一覧表に原文で記載あり:

> `cleanupPeriodDays` | "Choose how many days Claude Code keeps [transcripts](/docs/en/data-usage#data-retention) before deleting them" | Topic: Privacy and telemetry | Scope: Any file

CHANGELOG.md v0.2.117: "Introduced settings.cleanupPeriodDays"（最も古い導入記録）。

### 既定値（30日）

`data-usage.md`「Data retention」節に原文で明記:

> "Local caching: Claude Code clients store session transcripts locally in plaintext under `~/.claude/projects/` for 30 days by default to enable session resumption. Adjust the period with `cleanupPeriodDays`. See [application data](/docs/en/claude-directory#application-data) for what's stored and how to clear it."

**結論**: 既定値は**30日**で確定（原文引用で確認）。

補足（CHANGELOG v2.1.89）: "Changed `cleanupPeriodDays: 0` in settings.json to be rejected with a validation error — it previously silently disabled transcript persistence"。0を指定して削除を無効化することは現在は不可（バリデーションエラー）。

### 判定基準（作成日か最終更新日か）

**公式ドキュメント（data-usage.md、settings-reference）には判定基準の明記なし＝取得不可**。settings-referenceの説明文は "how many days Claude Code keeps transcripts before deleting them" とあるのみで、起点が作成日・最終更新日・最終アクセス日のいずれかを明言していない。WebSearchで見つかった非公式のブログ記事（brycewatson.com、dev.classmethod.jp等）には「最終更新日(mtime)基準」「起動時にスキャン」といった記述があったが、**Anthropic公式ソースでは裏付けが取れなかった**ため、確定情報としては扱わない。

### 削除対象（jsonlのみか、他ディレクトリも含むか）

CHANGELOG.mdの複数バージョンから、**`cleanupPeriodDays`の掃除対象はセッションtranscript(jsonl)だけでなく段階的に拡大されてきたことが原文で確認できた**:

- v2.1.83: "Fixed tool result files never being cleaned up, ignoring the `cleanupPeriodDays` setting"（ツール結果ファイルも対象）
- v2.1.101: "Fixed `--setting-sources` without `user` causing background cleanup to ignore `cleanupPeriodDays` and delete conversation history older than 30 days"
- v2.1.117: "The `cleanupPeriodDays` retention sweep now also covers `~/.claude/tasks/`, `~/.claude/shell-snapshots/`, and `~/.claude/backups/`"（tasks/, shell-snapshots/, backups/ ディレクトリも対象に追加）
- v2.1.248: "Fixed Claude Desktop and Cowork sessions disappearing after 30 days: the transcript cleanup now keeps desktop-written sessions while they are in the app (unless org policy manages retention); the new `desktopSessionCleanupPeriodDays` setting caps the exemption"（Desktop/Cowork系は別設定`desktopSessionCleanupPeriodDays`で例外扱い）
- v2.1.257: "Fixed leftover `cc-daemon-*` folders in the system temp directory after an interrupted background daemon start; the `cleanupPeriodDays` retention sweep now removes them"（一時ディレクトリのdaemonフォルダも対象）

**結論**: `cleanupPeriodDays`は単なる「jsonlファイル削除」ではなく、`~/.claude/projects/`配下のtranscriptに加え、`~/.claude/tasks/`、`~/.claude/shell-snapshots/`、`~/.claude/backups/`、システム一時ディレクトリの`cc-daemon-*`、ツール結果ファイルなど**複数の内部ストレージを対象とする横断的な保持期間設定**である。

**`subagents/`や`~/.claude/sessions/`が明示的に対象に含まれる/含まれないという記述は公式ソースに見当たらず＝取得不可**。ただし`subagents/`配下のファイルは`~/.claude/projects/<project>/`のサブディレクトリと推定され（3章のccusage adapter READMEの記述を参照）、"transcripts"という包括的な表現からは対象に含まれる可能性が高いが、明示的な原文確認はできていない。

### `.last-cleanup` ファイルへの言及

`data-usage.md`、`settings-reference`、CHANGELOG.md全文（grep検索）のいずれにも`.last-cleanup`という文字列は**一切登場しなかった＝取得不可**。この名前のファイルによる掃除実行管理は公式ソースでは確認できなかった。

### まとめ

| 項目 | 結果 |
|---|---|
| `cleanupPeriodDays`の存在 | 確認済み（settings.json、"Any file"スコープ、v0.2.117で導入） |
| 既定値 | **30日**（data-usage.md原文で確認） |
| 判定基準（作成日/更新日） | **取得不可**（公式記載なし、非公式ブログのみ） |
| 削除対象 | jsonlだけでなく`tasks/`, `shell-snapshots/`, `backups/`, 一時ディレクトリの`cc-daemon-*`, ツール結果ファイルまで対象（CHANGELOGで段階的拡大を確認）。`subagents/`は明示記載なし |
| `.last-cleanup`ファイル | **取得不可**（公式ソースに記載なし） |
