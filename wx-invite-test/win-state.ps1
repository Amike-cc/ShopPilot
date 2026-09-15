Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@
$procs = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'ShopPilot' }
foreach ($x in $procs) {
  $h = $x.MainWindowHandle
  $min = [W.U]::IsIconic($h)
  $vis = [W.U]::IsWindowVisible($h)
  Write-Output "pid=$($x.Id) hwnd=$h minimized=$min visible=$vis"
}
Write-Output "count=$($procs.Count)"
