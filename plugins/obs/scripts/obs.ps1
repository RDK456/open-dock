# Sends one request to OBS Studio's WebSocket server (protocol v5, OBS 28+), then disconnects.
param([string]$Command = 'ToggleRecord', [string]$Target = '', [string]$Port = '4455', [string]$Password = '')
$ErrorActionPreference = 'Stop'
$ct = [Threading.CancellationToken]::None
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
try { $ws.ConnectAsync([Uri]"ws://127.0.0.1:$Port", $ct).Wait(3000) | Out-Null } catch { }
if ($ws.State -ne 'Open') { throw "OBS isn't running, or its WebSocket server is off (Tools > WebSocket Server Settings)." }

function Receive-Message {
  $buffer = New-Object byte[] 65536
  $text = [Text.StringBuilder]::new()
  do {
    $result = $ws.ReceiveAsync([ArraySegment[byte]]::new($buffer), $ct).Result
    [void]$text.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
  } until ($result.EndOfMessage)
  $text.ToString() | ConvertFrom-Json
}
function Send-Message($message) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($message | ConvertTo-Json -Depth 6 -Compress))
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, $ct).Wait()
}
function Get-Hash([string]$value) {
  [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))
}

try {
  $hello = Receive-Message
  $identify = @{ op = 1; d = @{ rpcVersion = 1; eventSubscriptions = 0 } }
  if ($hello.d.authentication) {
    $identify.d.authentication = Get-Hash ((Get-Hash ($Password + $hello.d.authentication.salt)) + $hello.d.authentication.challenge)
  }
  Send-Message $identify
  if ((Receive-Message).op -ne 2) { throw "OBS refused the WebSocket password." }

  $data = @{}
  if ($Command -eq 'SetCurrentProgramScene') { $data.sceneName = $Target }
  if ($Command -eq 'ToggleInputMute') { $data.inputName = $Target }
  Send-Message @{ op = 6; d = @{ requestType = $Command; requestId = 'opendock'; requestData = $data } }
  do { $reply = Receive-Message } until ($reply.op -eq 7)
  if (-not $reply.d.requestStatus.result) { throw "OBS: $($reply.d.requestStatus.comment)" }
} finally {
  $ws.Dispose()
}
