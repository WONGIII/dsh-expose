# Live end-to-end verification for dsh-expose against a real dsh web instance.
# Usage: pwsh -File verify-live.ps1 -Base http://127.0.0.1:19399 -Token <launch token> -LanIp <this machine's LAN address>
param(
  [string]$Base = 'http://127.0.0.1:19399',
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$LanIp,
  [int]$ExposePort = 3080
)

$ErrorActionPreference = 'Stop'
if (-not ('System.Net.Http.HttpClient' -as [type])) {
  Add-Type -AssemblyName System.Net.Http | Out-Null
}
$script:failures = 0

function New-Client {
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $handler.UseCookies = $true
  $handler.CookieContainer = [System.Net.CookieContainer]::new()
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(20)
  return $client
}

function Send-Json([System.Net.Http.HttpClient]$Client, [string]$Method, [string]$Url, [string]$Json) {
  if ($Method -eq 'GET') {
    return $Client.GetAsync($Url).GetAwaiter().GetResult()
  }
  $content = [System.Net.Http.StringContent]::new($Json, [System.Text.Encoding]::UTF8, 'application/json')
  return $Client.PostAsync($Url, $content).GetAwaiter().GetResult()
}

function Check([string]$Label, [bool]$Ok, [string]$Detail) {
  $mark = if ($Ok) { 'PASS' } else { 'FAIL'; }
  if (-not $Ok) { $script:failures++ }
  Write-Host ("[{0}] {1} :: {2}" -f $mark, $Label, $Detail)
}

function Body([System.Net.Http.HttpResponseMessage]$Response) {
  return $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
}

Write-Host "== 1. plugin presence on the instance itself =="
$local = New-Client
$index = $local.GetAsync("$Base/?token=$Token").GetAwaiter().GetResult()
Check 'token login mints a cookie' ($index.StatusCode -eq 303) "HTTP $([int]$index.StatusCode)"

$state = Send-Json $local 'GET' "$Base/api/dsh-expose/state" $null
$stateBody = Body $state
Check 'control API answers' ($state.StatusCode -eq 200) "HTTP $([int]$state.StatusCode)"
$stateJson = $stateBody | ConvertFrom-Json
Check 'shipped default is 0.0.0.0:3080' ($stateJson.store.defaults.host -eq '0.0.0.0' -and $stateJson.store.defaults.port -eq 3080) "defaults=$($stateJson.store.defaults.host):$($stateJson.store.defaults.port)"
Check 'current setting is reported' ($null -ne $stateJson.settings.host -and $stateJson.settings.port -gt 0) "now=$($stateJson.settings.host):$($stateJson.settings.port) enabled=$($stateJson.settings.enabled)"
Check 'upstream is the instance carrier' ($null -ne $stateJson.upstream) "upstream=$($stateJson.upstream.authority)"

$indexBody = Body $index
$bootIndex = $local.GetAsync("$Base/").GetAwaiter().GetResult()
$bootBody = Body $bootIndex
Check 'browser half is in the page boot graph' ($bootBody.Contains('dsh-expose')) "index HTTP $([int]$bootIndex.StatusCode), graph mentions dsh-expose: $($bootBody.Contains('dsh-expose'))"

Write-Host "`n== 2. anonymous remote client is refused =="
$anon = New-Client
$anonIndexStatus = 'no listener yet'
$anonApiStatus = 'no listener yet'
try {
  $anonIndexStatus = [int]($anon.GetAsync("http://${LanIp}:$ExposePort/").GetAwaiter().GetResult().StatusCode)
  $anonApiStatus = [int]($anon.GetAsync("http://${LanIp}:$ExposePort/api/dsh-expose/state").GetAwaiter().GetResult().StatusCode)
} catch {
  # Expected before the switch is opened: nothing is listening on the published port.
}
Write-Host ("     before exposure: index HTTP {0}, api HTTP {1}" -f $anonIndexStatus, $anonApiStatus)

Write-Host "`n== 3. open the switch from the instance UI path =="
$open = Send-Json $local 'POST' "$Base/api/dsh-expose/config" (@{ enabled = $true; host = '0.0.0.0'; port = $ExposePort } | ConvertTo-Json -Compress)
$openJson = (Body $open) | ConvertFrom-Json
Check 'switch reports listening' ($openJson.listener.listening -eq $true) "bind=$($openJson.listener.bindHost):$($openJson.listener.port) error=$($openJson.listener.error)"
Check 'addresses are published' ($openJson.addresses.Count -gt 0) "$($openJson.addresses.Count) address(es)"
$lanUrl = ($openJson.addresses | Where-Object { $_.address -eq $LanIp } | Select-Object -First 1)
Check 'LAN address is advertised with a token link' ($null -ne $lanUrl -and $lanUrl.tokenUrl -match 'token=') "$($lanUrl.url)"

# The public egress lookup is asynchronous by design (the tab stays instant);
# the refresh route is the deterministic way to wait for it.
$refreshed = Send-Json $local 'POST' "$Base/api/dsh-expose/refresh" '{}'
$refreshedJson = (Body $refreshed) | ConvertFrom-Json
$publicInfo = "ip=$($refreshedJson.public.ip) direct=$($refreshedJson.public.direct)"
Check 'public egress detected' ($null -ne $refreshedJson.public.ip) $publicInfo
$natEntry = $refreshedJson.addresses | Where-Object { $_.kind -eq 'nat' } | Select-Object -First 1
Check 'NAT egress is published as a forwarding address' ($null -ne $natEntry -and $natEntry.requiresForwarding -eq $true) "$($natEntry.url)"

Write-Host "`n== 4. remote browser experience through the published port =="
$remote = New-Client
$remoteIndex = $remote.GetAsync("http://${LanIp}:$ExposePort/").GetAwaiter().GetResult()
Check 'anonymous index is refused with 401' ($remoteIndex.StatusCode -eq 401) "HTTP $([int]$remoteIndex.StatusCode)"

$login = $remote.GetAsync($lanUrl.tokenUrl).GetAwaiter().GetResult()
Check 'token link over LAN mints a cookie' ($login.StatusCode -eq 303) "HTTP $([int]$login.StatusCode) -> $($login.Headers.Location)"

$remoteApi = $remote.GetAsync("http://${LanIp}:$ExposePort/api/dsh-expose/state").GetAwaiter().GetResult()
Check 'authenticated /api works through the tunnel' ($remoteApi.StatusCode -eq 200) "HTTP $([int]$remoteApi.StatusCode)"

$remoteIndex2 = $remote.GetAsync("http://${LanIp}:$ExposePort/").GetAwaiter().GetResult()
Check 'cookie now serves the app index' ($remoteIndex2.StatusCode -eq 200 -and (Body $remoteIndex2).Contains('__DSH_BOOT__')) "HTTP $([int]$remoteIndex2.StatusCode)"

$probe = Send-Json $local 'POST' "$Base/api/dsh-expose/probe" '{}'
$probeJson = (Body $probe) | ConvertFrom-Json
Check 'self-test passes every leg' ($probeJson.probe.ok -eq $true) (($probeJson.probe.steps | ForEach-Object { "$($_.label)=$($_.status)" }) -join ', ')

Write-Host "`n== 5. live counters =="
$after = Send-Json $local 'GET' "$Base/api/dsh-expose/state" $null
$afterJson = (Body $after) | ConvertFrom-Json
Check 'requests were counted' ($afterJson.stats.requests -gt 0) "requests=$($afterJson.stats.requests) clients=$($afterJson.stats.clients.Count)"

Write-Host "`n== 6. close the switch again =="
$close = Send-Json $local 'POST' "$Base/api/dsh-expose/config" '{"enabled":false}'
$closeJson = (Body $close) | ConvertFrom-Json
Check 'switch reports stopped' ($closeJson.listener.listening -eq $false) "listening=$($closeJson.listener.listening)"

$closed = $false
try {
  $dead = (New-Client).GetAsync("http://127.0.0.1:$ExposePort/").GetAwaiter().GetResult()
} catch {
  $closed = $true
}
Check 'published port no longer answers' $closed 'connection refused after switching off'

Write-Host ""
if ($script:failures -eq 0) { Write-Host 'ALL LIVE CHECKS PASSED' } else { Write-Host "$script:failures LIVE CHECK(S) FAILED"; exit 1 }
