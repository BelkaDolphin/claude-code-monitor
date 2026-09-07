# claude-monitor - Windows system tray host.
#
# THIS FILE MUST STAY UTF-8 **WITH BOM**. Windows PowerShell 5.1 decodes a
# BOM-less .ps1 with the system ANSI codepage (CP932 here), which turns every
# Japanese menu string below into mojibake - and, worse, can break the parse
# outright when a mangled byte pair ends in a backtick or a quote. The BOM is
# the same fix, for the same reason, as the UTF-16LE+BOM on autostart.vbs; see
# src/autostart.js. test/tray.test.js asserts the first three bytes are EF BB BF.
#
# What this is for. The dashboard is started hidden at logon (src/autostart.js),
# which is exactly the arrangement in which nobody can tell whether it is
# running. This host puts an icon in the notification area and supervises the
# server, so "is it up?" is answered by looking, and a crash is recovered from
# instead of waiting for the next logon.
#
# Process tree:  wscript.exe (autostart.vbs)
#                  -> powershell.exe -STA -WindowStyle Hidden (this file)
#                       -> node.exe src/cli.js serve ...
#
# Why PowerShell + System.Windows.Forms and not an npm tray module: the project
# has zero runtime dependencies and intends to keep them, a native tray module
# would drag in a prebuilt binary per Node version, and WinForms' NotifyIcon is
# already on every Windows 11 machine. The cost is that the host must run STA
# (a message loop is required) and be started with -WindowStyle Hidden, which
# was verified before this file was written.
#
# It must never take the server down with it. Every timer tick, every menu
# handler and every log write is wrapped: an exception here would end the
# message loop and kill the child in the finally block, which is the one
# outcome a supervisor is not allowed to produce by accident.

[CmdletBinding()]
param(
  # 0 means "not given". Deliberately NOT defaulted to the real port: this file
  # is always launched by src/autostart.js or `cli.js tray`, both of which pass
  # one, and a bare run that silently starts a server on the user's port would
  # be the kind of surprise this project spends its dry-runs avoiding.
  [int]$Port = 0,
  [string]$Node = '',
  [string]$Cli = '',
  [string]$LogFile = '',
  [string]$MonitorDir = '',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- constants --

# Backoff between restarts, in seconds. The last value repeats.
$script:BackoffSeconds = @(5, 15, 60)
# More than this many restarts inside the window and we stop trying: something
# is wrong that restarting cannot fix (a port held by a foreign process, a
# broken install), and a hidden loop respawning node every minute forever is
# worse than an icon that says so.
$script:MaxFailures = 5
$script:FailureWindowSeconds = 600
$script:PollMs = 3000
$script:ConnectTimeoutMs = 500

$script:State = 'starting'
$script:Child = $null
$script:Icon = $null
$script:IconHandle = [IntPtr]::Zero
$script:Notify = $null
$script:Mutex = $null
$script:MutexHeld = $false
$script:StopEvent = $null
$script:PidFile = $null
$script:Failures = @()
$script:NextStartAt = [datetime]::MinValue
$script:GaveUp = $false

# ------------------------------------------------------------------ logging --

# The same two shapes src/log-file.js scrubs, for the same reason: this file is
# appended to by both processes, it outlives them, and a live bearer token in it
# is a credential with no expiry. The tray never handles the token itself - but
# it CAN read url.txt, which is nothing but a token-bearing URL, so the rule is
# enforced here too rather than trusted not to be needed.
function Get-Redacted([string]$Text) {
  $out = [string]$Text
  $out = $out -replace '([?&])t=[0-9a-f]{64}', '$1<token redacted>'
  $out = $out -replace 'cm_token=[0-9a-f]{64}', 'cm_token=<redacted>'
  return $out
}

# One line into the server's own log, stamped the way src/log-file.js stamps so
# the two writers produce a single readable file. Never throws: a locked or
# rotated-away file must not end the message loop.
#
# NOT [System.IO.File]::AppendAllText. That opens with FileShare.Read, and the
# server holds the very same file open for append (src/log-file.js keeps an fd
# so a crashing process still flushes) - so AppendAllText throws for as long as
# the server is up, which is precisely when the tray has something to say. The
# failure is invisible, because the catch below is doing its job. FileShare
# ReadWrite is what node's own `fs.openSync(file, 'a')` asks for; matching it
# lets both processes append to one file.
function Write-TrayLog([string]$Message) {
  if (-not $script:LogPath) { return }
  $stream = $null
  try {
    $stamp = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $line = "$stamp out | [tray] " + (Get-Redacted $Message) + "`r`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
    $stream = New-Object System.IO.FileStream(
      $script:LogPath,
      [System.IO.FileMode]::Append,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::ReadWrite)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
  } catch {
    # Nowhere left to report it to. Losing a log line is survivable; losing the
    # tray because the log file was momentarily locked is not.
  } finally {
    if ($stream) { try { $stream.Dispose() } catch { } }
  }
}

# ------------------------------------------------------------------- icons --

function Initialize-TrayTypes {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  if (-not ('CmTray.Native' -as [type])) {
    # Icon.FromHandle does NOT own the handle, and Icon.Dispose() does not free
    # it (documented). Rebuilding the icon on every state change without this
    # would leak one GDI handle per change, forever, in a process that is meant
    # to run from logon to shutdown.
    Add-Type -Namespace CmTray -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(System.IntPtr hIcon);
'@
  }
}

# A 16x16 filled circle, drawn at runtime. No .ico ships with the repo: one
# more binary in the tree that nobody can diff, for three solid colours.
# Returns @{ Icon = <System.Drawing.Icon>; Handle = <IntPtr> } - the caller owns
# both and must DestroyIcon the handle.
function New-StateIcon([string]$State) {
  switch ($State) {
    'running' { $rgb = @(46, 160, 67) }   # green
    'failed'  { $rgb = @(218, 54, 51) }   # red
    default   { $rgb = @(140, 148, 158) } # grey: starting / unknown
  }
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $rgb[0], $rgb[1], $rgb[2]))
    $g.FillEllipse($fill, 1, 1, 14, 14)
    $fill.Dispose()
    # A dark rim so the dot stays visible on a light taskbar.
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 0, 0, 0)), 1
    $g.DrawEllipse($pen, 1, 1, 14, 14)
    $pen.Dispose()
  } finally {
    $g.Dispose()
  }
  $handle = $bmp.GetHicon()
  $icon = [System.Drawing.Icon]::FromHandle($handle)
  $bmp.Dispose()
  return @{ Icon = $icon; Handle = $handle }
}

function Remove-StateIcon($Built) {
  if (-not $Built) { return }
  try { if ($Built.Icon) { $Built.Icon.Dispose() } } catch { }
  try {
    if ($Built.Handle -and $Built.Handle -ne [IntPtr]::Zero) {
      [void][CmTray.Native]::DestroyIcon($Built.Handle)
    }
  } catch { }
}

function Get-StateLabel([string]$State) {
  switch ($State) {
    'running' { return '稼働中' }
    'failed'  { return '停止（再起動を諦めた）' }
    default   { return '起動中' }
  }
}

# Swap the icon and the tooltip, but only when the state actually changed: the
# rebuild costs a GDI handle and a shell notification, and neither is free in a
# process that ticks every 3 seconds for months.
function Set-TrayState([string]$State) {
  if ($State -eq $script:State -and $script:Icon) { return }
  $previous = $script:State
  $script:State = $State
  $old = @{ Icon = $script:Icon; Handle = $script:IconHandle }
  $built = New-StateIcon $State
  $script:Icon = $built.Icon
  $script:IconHandle = $built.Handle
  if ($script:Notify) {
    $script:Notify.Icon = $script:Icon
    # NotifyIcon.Text throws above 63 characters on .NET Framework.
    $text = "claude-monitor · $(Get-StateLabel $State) · port $Port"
    if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
    $script:Notify.Text = $text
  }
  # Only after the new icon is in place, so the shell is never pointed at a
  # handle we have already destroyed.
  Remove-StateIcon $old
  if ($previous -ne $State) { Write-TrayLog "state $previous -> $State" }
}

# ------------------------------------------------------------- the server --

# Windows paths cannot contain a double quote, so a value that does is not a
# path - it is a corrupted setting or an injection attempt. Same refusal, and
# the same reasoning, as assertQuotablePath() in src/autostart.js.
#
# A TRAILING BACKSLASH is refused too, and for a different reason: `"C:\dir\"`
# does not end where it looks like it ends. The backslash escapes the closing
# quote under the CRT rules node.exe parses its command line with, so the rest
# of the line - `serve --persist-token --port ...` - would be swallowed into the
# value. src/autostart.js noTrailingSep() strips it before we are ever called;
# this is the second line of that defence, for a value that reached us some
# other way.
function ConvertTo-QuotedArg([string]$Value) {
  if ($Value -match '["\r\n]') {
    throw "refusing to build a command line for a path containing a quote or newline: $Value"
  }
  if ($Value -match '\\$') {
    throw "refusing to build a command line for a path ending in a backslash (it would escape the closing quote): $Value"
  }
  return '"' + $Value + '"'
}

function Start-MonitorServer {
  $arguments = @(
    (ConvertTo-QuotedArg $Cli),
    'serve',
    '--persist-token',
    '--port', [string]$Port,
    '--log-file', (ConvertTo-QuotedArg $script:LogPath)
  ) -join ' '

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = $arguments
  # UseShellExecute=$false + CreateNoWindow=$true is the pair that keeps
  # node.exe - a console-subsystem binary - from ever painting a window. stdout
  # and stderr are left unredirected on purpose: nothing here would drain the
  # pipes, and a full pipe would block the server. The server writes everything
  # to --log-file anyway.
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = (Split-Path -Parent (Split-Path -Parent $Cli))
  # The server resolves its own data directory (src/paths.js monitorDir) from
  # CLAUDE_MONITOR_DIR, and it is the process that writes token and url.txt.
  # Without this the tray would watch one directory while the server wrote to
  # another - which is not a test-only concern: "ダッシュボードを開く" reads
  # url.txt out of -MonitorDir, and it would find a URL for somebody else's run,
  # or none at all.
  $psi.EnvironmentVariables['CLAUDE_MONITOR_DIR'] = $MonitorDir

  $proc = [System.Diagnostics.Process]::Start($psi)
  $script:Child = $proc
  Write-TrayLog "spawned server pid=$($proc.Id) port=$Port"
  Write-PidFile
  return $proc
}

# Kill the child AND anything it started. node spawns powershell for
# Get-Process (src/sessions.js) and may be mid-call when we stop it; killing
# only the parent would strand those. taskkill /T /F is the only tool on the box
# that walks the tree.
function Stop-MonitorServer {
  $proc = $script:Child
  $script:Child = $null
  if (-not $proc) { return }
  try {
    if ($proc.HasExited) { return }
  } catch {
    return
  }
  $serverPid = $proc.Id
  try {
    & taskkill.exe /PID $serverPid /T /F 2>&1 | Out-Null
  } catch {
    # taskkill missing or refused - fall through to the .NET kill below.
  }
  try {
    if (-not $proc.HasExited) { $proc.Kill() }
  } catch { }
  try { [void]$proc.WaitForExit(5000) } catch { }
  Write-TrayLog "stopped server pid=$serverPid"
}

# Is anything answering on the port? A connect, not a request: the dashboard
# needs a token for every route, so an HTTP probe would only ever learn 403.
function Test-ServerPort {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($script:ConnectTimeoutMs, $false)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch { }
  }
}

# ----------------------------------------------------------------- pid file --

# <monitorDir>\tray.pid, so `autostart-status` can say whether the tray is up
# without guessing from a process list. Both PIDs, because either one dying is
# a different failure.
#
# A PID ON ITS OWN IS NOT AN IDENTITY. Windows reuses PIDs freely, and a machine
# that has been up for weeks will have wrapped many times - so a reader that
# trusts a bare number can report somebody else's process as "the server", and
# `tray-stop` could kill it. Each PID is therefore written with the two things
# that pin it down: the process START TIME and the process NAME. src/autostart.js
# pidMatches() compares both before believing this file (the same trick
# src/sessions.js plays with its own pid files).
#
# The name is read off the process rather than hardcoded, so a future host that
# is pwsh.exe instead of powershell.exe stays correct without a code change.
function Get-ProcessFacts($Process) {
  $facts = [ordered]@{ pid = $null; name = $null; startedAt = $null }
  if (-not $Process) { return $facts }
  try {
    if ($Process.HasExited) { return $facts }
    $facts.pid = $Process.Id
    $facts.name = $Process.ProcessName
    # StartTime can throw (a process that exits between these two lines, or one
    # we are not allowed to ask about). A missing time is not fatal: the reader
    # falls back to the name, and says it could not verify.
    try { $facts.startedAt = $Process.StartTime.ToUniversalTime().ToString('o') } catch { }
  } catch { }
  return $facts
}

function Write-PidFile {
  if (-not $script:PidFile) { return }
  $tmp = "$($script:PidFile).tmp"
  try {
    $server = Get-ProcessFacts $script:Child
    $payload = [ordered]@{
      trayPid         = $PID
      trayName        = $script:SelfFacts.name
      trayStartedAt   = $script:SelfFacts.startedAt
      serverPid       = $server.pid
      serverName      = $server.name
      serverStartedAt = $server.startedAt
      port            = $Port
      startedAt       = $script:StartedAt
      logFile         = $script:LogPath
    }
    $json = ($payload | ConvertTo-Json -Compress)
    [System.IO.File]::WriteAllText($tmp, $json + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    # Swap it in rather than writing over the live file: a reader that opens
    # tray.pid mid-write gets half a JSON object, and while readTrayPid() treats
    # that as "no tray" rather than crashing, "no tray" is the wrong answer.
    #
    # File.Replace maps to Win32 ReplaceFile(), which is the atomic swap. The
    # obvious File.Move(src, dst, overwrite) overload does NOT exist on .NET
    # Framework 4.x, which is what Windows PowerShell 5.1 runs on - it arrived
    # in .NET Core 3.0 - so Replace is the only atomic option here, and it needs
    # the destination to already exist. First write goes through Move instead.
    if ([System.IO.File]::Exists($script:PidFile)) {
      # [NullString]::Value, NOT $null: PowerShell converts a bare $null bound to
      # a [string] parameter into an EMPTY STRING, and File.Replace then throws
      # "the path format is invalid" on a backup path of "". This one threw on
      # every write after the first - caught and logged, so the tray kept
      # running with a tray.pid that never learned the server's PID.
      [System.IO.File]::Replace($tmp, $script:PidFile, [NullString]::Value)
    } else {
      [System.IO.File]::Move($tmp, $script:PidFile)
    }
  } catch {
    Write-TrayLog "could not write tray.pid: $($_.Exception.Message)"
    try { if ([System.IO.File]::Exists($tmp)) { Remove-Item -LiteralPath $tmp -Force } } catch { }
  }
}

# Remove OUR pid file, and only ours.
#
# Two guards, because getting this wrong strands a working instance. The mutex
# loser must never delete the winner's file - it never had one - and even a
# holder re-reads the file first, in case something else has since claimed it.
function Remove-PidFile {
  if (-not $script:PidFile -or -not $script:MutexHeld) { return }
  try {
    if (-not (Test-Path -LiteralPath $script:PidFile)) { return }
    $owner = $null
    try {
      $owner = (Get-Content -LiteralPath $script:PidFile -Raw | ConvertFrom-Json).trayPid
    } catch { }
    if ($null -ne $owner -and $owner -ne $PID) {
      Write-TrayLog "leaving tray.pid alone: it names pid $owner, not us ($PID)"
      return
    }
    Remove-Item -LiteralPath $script:PidFile -Force
  } catch { }
}

# ------------------------------------------------------------ menu actions --

function Open-Dashboard {
  # url.txt is written by `serve --persist-token` and contains the bearer token.
  # It is handed straight to the shell and NEVER logged - see Get-Redacted; the
  # log line below deliberately names the file, not its contents.
  $urlFile = Join-Path $MonitorDir 'url.txt'
  $url = $null
  $rejected = $false
  try {
    if (Test-Path -LiteralPath $urlFile) {
      $text = [System.IO.File]::ReadAllText($urlFile).Trim()
      # The SAME allow-list server.js openBrowser() applies, and for the same
      # reason: this string is handed to the shell. `^https?://` would let
      # through anything that started with http, including a URL pointing
      # somewhere else entirely - and this file is one an attacker who can write
      # the profile directory could edit. -cmatch (case SENSITIVE) because the
      # token is lowercase hex and the JS regex carries no `i` flag either.
      if ($text -cmatch '^http://127\.0\.0\.1:\d{1,5}/\?t=[0-9a-f]{64}$') {
        $url = $text
      } else {
        $rejected = $true
      }
    }
  } catch { }
  if (-not $url) {
    # No usable url.txt (the server has not written one, it was started without
    # a persisted token, or the contents did not pass). The bare URL still
    # reaches a running server; it just answers 403, which is a far clearer
    # message than a dead link.
    $url = "http://127.0.0.1:$Port/"
    if ($rejected) {
      # The file name, never the contents - what was rejected may be anything.
      Write-TrayLog "url.txt rejected (not a loopback entry URL): $urlFile - opening the bare loopback URL (expect 403)"
    } else {
      Write-TrayLog "no url.txt at $urlFile - opening the bare loopback URL (expect 403)"
    }
  } else {
    Write-TrayLog "opening the dashboard URL from $urlFile"
  }
  Start-Process $url
}

function Open-LogFile {
  if (-not $script:LogPath) { return }
  if (-not (Test-Path -LiteralPath $script:LogPath)) {
    Write-TrayLog "log file does not exist yet: $($script:LogPath)"
    return
  }
  Start-Process $script:LogPath
}

function Restart-MonitorServer {
  Write-TrayLog 'restart requested from the tray menu'
  Stop-MonitorServer
  $script:Failures = @()
  $script:GaveUp = $false
  $script:NextStartAt = [datetime]::MinValue
  Set-TrayState 'starting'
  try {
    [void](Start-MonitorServer)
  } catch {
    Write-TrayLog "restart failed: $($_.Exception.Message)"
    Set-TrayState 'failed'
  }
}

# ------------------------------------------------------------- supervision --

function Register-Failure {
  $now = [datetime]::UtcNow
  $cutoff = $now.AddSeconds(-$script:FailureWindowSeconds)
  $script:Failures = @($script:Failures | Where-Object { $_ -gt $cutoff })
  $script:Failures += $now
  if ($script:Failures.Count -ge $script:MaxFailures) {
    $script:GaveUp = $true
    Write-TrayLog "giving up: $($script:Failures.Count) restarts in the last $($script:FailureWindowSeconds)s"
    Set-TrayState 'failed'
    try {
      $script:Notify.BalloonTipTitle = 'claude-monitor'
      $script:Notify.BalloonTipText = "サーバが繰り返し落ちています。$($script:LogPath) を確認してください。"
      $script:Notify.ShowBalloonTip(10000)
    } catch { }
    return
  }
  # 5s, 15s, then 60s for every further attempt.
  $index = [Math]::Min($script:Failures.Count - 1, $script:BackoffSeconds.Count - 1)
  $wait = $script:BackoffSeconds[$index]
  $script:NextStartAt = $now.AddSeconds($wait)
  Write-TrayLog "restarting in ${wait}s (failure $($script:Failures.Count) of $($script:MaxFailures))"
}

function Update-TrayState {
  $alive = $false
  if ($script:Child) {
    try { $alive = -not $script:Child.HasExited } catch { $alive = $false }
  }

  if (-not $alive) {
    if ($script:Child) {
      $code = '?'
      try { $code = $script:Child.ExitCode } catch { }
      Write-TrayLog "server exited unexpectedly (code $code)"
      $script:Child = $null
      Write-PidFile
      Register-Failure
    }
    if ($script:GaveUp) {
      Set-TrayState 'failed'
      return
    }
    Set-TrayState 'starting'
    if ([datetime]::UtcNow -ge $script:NextStartAt) {
      try {
        [void](Start-MonitorServer)
      } catch {
        Write-TrayLog "spawn failed: $($_.Exception.Message)"
        Register-Failure
      }
    }
    return
  }

  # Alive, so the only question left is whether it is listening yet. `running`
  # requires BOTH: a port answered by somebody else's process is not our server
  # running, it is the reason ours keeps dying.
  Set-TrayState $(if (Test-ServerPort) { 'running' } else { 'starting' })
}

# ------------------------------------------------------------------ startup --

# Fill in what was not passed. MonitorDir matters most: tray.pid and url.txt
# both live there, and CLAUDE_MONITOR_DIR is how the tests keep out of the real
# profile directory.
if (-not $MonitorDir) {
  $MonitorDir = if ($env:CLAUDE_MONITOR_DIR) { $env:CLAUDE_MONITOR_DIR } else { Join-Path $env:USERPROFILE '.claude-monitor' }
}
$script:LogPath = if ($LogFile) { $LogFile } else { Join-Path $MonitorDir 'serve.log' }
$script:StartedAt = [datetime]::UtcNow.ToString('o')
$script:SelfFacts = Get-ProcessFacts ([System.Diagnostics.Process]::GetCurrentProcess())

# NOTE: $script:PidFile is deliberately NOT set here. It is set only after the
# single-instance mutex has been WON (see below), because Remove-PidFile runs in
# the finally block on every exit path - including the one where we lost the
# mutex and are leaving immediately. A loser that knew the path would delete the
# WINNER's tray.pid on its way out, stranding a healthy tray: `tray-stop` would
# then find nothing to stop and the icon would have no way to be reached.

if ($SelfTest) {
  # What node:test runs. Everything that could fail on a machine we have not
  # seen - the two assemblies, the P/Invoke compile, all three icons, the
  # NotifyIcon and the menu - is exercised, and nothing is shown, spawned or
  # written. Exit 0 and one line on stdout is the whole contract.
  Initialize-TrayTypes
  $built = @()
  foreach ($state in @('running', 'starting', 'failed')) { $built += (New-StateIcon $state) }
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  foreach ($label in @('ダッシュボードを開く', 'ログを開く', '再起動', '終了')) { [void]$menu.Items.Add($label) }
  $probe = New-Object System.Windows.Forms.NotifyIcon
  $probe.Icon = $built[0].Icon
  $probe.Text = "claude-monitor · $(Get-StateLabel 'running') · port $Port"
  $probe.ContextMenuStrip = $menu
  $probe.Dispose()
  $menu.Dispose()
  foreach ($b in $built) { Remove-StateIcon $b }

  # Prove the redaction rule on a fixed sample. Get-Redacted is the only thing
  # standing between url.txt and a log file that keeps a live credential for
  # months, and it is a PowerShell copy of a JavaScript regex - exactly the kind
  # of duplicate that rots silently. Printing it lets node:test check it without
  # this script having to run for real.
  $sample = 'http://127.0.0.1:47321/?t=' + ('a' * 64) + ' cookie cm_token=' + ('b' * 64)
  Write-Output "redaction: $(Get-Redacted $sample)"
  Write-Output 'selftest ok'
  exit 0
}

# [Console]::Error, not Write-Error: $ErrorActionPreference is 'Stop', so
# Write-Error would THROW rather than print, and the script would exit 1 - the
# code that means "it crashed" - instead of 2, the code that means "you did not
# give me what I need".
if ($Port -lt 1 -or $Port -gt 65535) {
  [Console]::Error.WriteLine('claude-monitor tray: a -Port between 1 and 65535 is required (this script is launched by src/autostart.js or `cli.js tray`, both of which pass one)')
  exit 2
}
if (-not $Node -or -not $Cli) {
  [Console]::Error.WriteLine('claude-monitor tray: -Node and -Cli are required')
  exit 2
}

try {
  # One tray per port. A second logon task run, a hand-started `cli.js tray` and
  # the one already in the notification area must not become two icons fighting
  # over one server - so the loser leaves quietly, exactly as `serve` does when
  # it loses the bind.
  #
  # `Local\` is the per-LOGON-SESSION namespace, not machine-wide, and that is
  # deliberate: `Global\` would need no privilege here but would make a second
  # user's tray silently refuse to start, with no icon and nothing on screen to
  # say why. As it stands a second logon session DOES start its own tray, its
  # server loses the TCP bind (port 47321 is machine-wide), and that session
  # sees the failed/red icon while the first session's tray stays healthy - a
  # visible, self-explaining outcome instead of a silent one. See architecture
  # 7.4 既知の制約.
  $script:Mutex = New-Object System.Threading.Mutex($false, "Local\claude-monitor-tray-$Port")
  try {
    $script:MutexHeld = $script:Mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    # The previous holder died without releasing. We now own it.
    $script:MutexHeld = $true
  }
  if (-not $script:MutexHeld) {
    # Nothing has been created yet and $script:PidFile is still null, so the
    # finally block below has nothing of the winner's to touch.
    Write-TrayLog "another tray host already holds port $Port - exiting quietly (pid $PID)"
    exit 0
  }
  # Won. From here we own tray.pid, and Remove-PidFile is allowed to run.
  $script:PidFile = Join-Path $MonitorDir 'tray.pid'

  # How `cli.js tray-stop` asks for a CLEAN exit. Killing the tray with
  # taskkill would also work - it is the child of the tree - but the process
  # would die between statements, leaving tray.pid on disk and a ghost icon in
  # the notification area until the shell next repaints it. Setting an event the
  # poll timer already checks costs one handle and gets the finally block run.
  $script:StopEvent = New-Object System.Threading.EventWaitHandle(
    $false, [System.Threading.EventResetMode]::ManualReset, "Local\claude-monitor-tray-stop-$Port")

  Initialize-TrayTypes
  New-Item -ItemType Directory -Force -Path $MonitorDir | Out-Null
  Write-TrayLog "tray host starting (pid $PID, port $Port)"

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $menu.Items.Add('ダッシュボードを開く')
  $logItem = $menu.Items.Add('ログを開く')
  $restartItem = $menu.Items.Add('再起動')
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $quitItem = $menu.Items.Add('終了')

  # Every handler is wrapped. An exception escaping one of these ends the
  # message loop, and ending the message loop stops the server.
  $openItem.add_Click({ try { Open-Dashboard } catch { Write-TrayLog "open failed: $($_.Exception.Message)" } })
  $logItem.add_Click({ try { Open-LogFile } catch { Write-TrayLog "open log failed: $($_.Exception.Message)" } })
  $restartItem.add_Click({ try { Restart-MonitorServer } catch { Write-TrayLog "restart failed: $($_.Exception.Message)" } })
  $quitItem.add_Click({
    try { Write-TrayLog 'exit requested from the tray menu' } catch { }
    [System.Windows.Forms.Application]::ExitThread()
  })

  $script:Notify = New-Object System.Windows.Forms.NotifyIcon
  $script:Notify.ContextMenuStrip = $menu
  $script:Notify.add_DoubleClick({ try { Open-Dashboard } catch { Write-TrayLog "open failed: $($_.Exception.Message)" } })
  # Set-TrayState only acts on a CHANGE, so the first call has to be against a
  # state the host is not already in.
  $script:State = 'unknown'
  Set-TrayState 'starting'
  $script:Notify.Visible = $true

  Write-PidFile
  try {
    [void](Start-MonitorServer)
  } catch {
    Write-TrayLog "could not start the server: $($_.Exception.Message)"
    Register-Failure
  }

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = $script:PollMs
  $timer.add_Tick({
    try {
      if ($script:StopEvent -and $script:StopEvent.WaitOne(0)) {
        Write-TrayLog 'stop requested (tray-stop)'
        [System.Windows.Forms.Application]::ExitThread()
        return
      }
      Update-TrayState
    } catch {
      # A tick that throws must not end the loop; the next one gets another go.
      try { Write-TrayLog "poll failed: $($_.Exception.Message)" } catch { }
    }
  })
  $timer.Start()

  [System.Windows.Forms.Application]::Run()
  exit 0
} catch {
  Write-TrayLog "tray host failed: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
  exit 1
} finally {
  # Order matters: the server dies with the tray on purpose (an icon that
  # outlives what it reports on is worse than no icon), the icon is removed
  # before the process goes so the shell does not leave a ghost, and the pid
  # file is deleted last so nothing reads it after the PIDs are gone.
  try { Stop-MonitorServer } catch { }
  try {
    if ($script:Notify) { $script:Notify.Visible = $false; $script:Notify.Dispose() }
  } catch { }
  try { Remove-StateIcon @{ Icon = $script:Icon; Handle = $script:IconHandle } } catch { }
  Remove-PidFile
  try { if ($script:StopEvent) { $script:StopEvent.Dispose() } } catch { }
  try { if ($script:MutexHeld -and $script:Mutex) { $script:Mutex.ReleaseMutex() } } catch { }
  try { if ($script:Mutex) { $script:Mutex.Dispose() } } catch { }
}
