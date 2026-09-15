Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@
# SW_RESTORE = 9, SW_SHOW = 5
$procs = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'ShopPilot' }
foreach ($x in $procs) {
  $h = $x.MainWindowHandle
  if ([W.U]::IsIconic($h)) { [void][W.U]::ShowWindow($h, 9) }
  else { [void][W.U]::ShowWindow($h, 5) }
  [void][W.U]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 800
  Write-Output "pid=$($x.Id) restored; stillMinimized=$([W.U]::IsIconic($h))"
}
