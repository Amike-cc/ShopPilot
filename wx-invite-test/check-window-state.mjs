/** 检查 ShopPilot 主窗口的可见状态（是否最小化/被隐藏），必要时恢复显示。 */
const { execSync } = await import('child_process')
const ps = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@
$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'ShopPilot' }
foreach ($x in $p) {
  $h = $x.MainWindowHandle
  "pid=$($x.Id) hwnd=$h minimized=$([W.U]::IsIconic($h)) visible=$([W.U]::IsWindowVisible($h))"
}
`
const out = execSync(`powershell -NoProfile -Command ${JSON.stringify(ps)}`, { encoding: 'utf8' })
console.log('窗口状态:\n' + out.trim())
console.log('\n如果 minimized=True 或 visible=False，那 0×0 视口就有解了。')
