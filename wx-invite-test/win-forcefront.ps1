Add-Type -Namespace W2 -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
'@

$p = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'ShopPilot' } | Select-Object -First 1
if (-not $p) { Write-Output "no-window"; exit }
$h = $p.MainWindowHandle

# 先看当前前台是谁
$fg = [W2.U]::GetForegroundWindow()
$fgPid = 0
[void][W2.U]::GetWindowThreadProcessId($fg, [ref]$fgPid)
Write-Output "shopilot.hwnd=$h foreground.hwnd=$fg foreground.pid=$fgPid shopilot.pid=$($p.Id)"

# 最小化 → 还原（制造真实状态变化，绕过前台锁）
[void][W2.U]::ShowWindow($h, 6)   # SW_MINIMIZE
Start-Sleep -Milliseconds 400
[void][W2.U]::ShowWindow($h, 9)   # SW_RESTORE
Start-Sleep -Milliseconds 250

# AttachThreadInput 技巧：把当前线程输入队列接到前台线程，再 SetForegroundWindow
$fgThread = [W2.U]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$myThread = [W2.U]::GetCurrentThreadId()
[void][W2.U]::AttachThreadInput($myThread, $fgThread, $true)
[void][W2.U]::BringWindowToTop($h)
[void][W2.U]::SetForegroundWindow($h)
[void][W2.U]::AttachThreadInput($myThread, $fgThread, $false)
# HWND_TOP=0, SWP_NOMOVE|SWP_NOSIZE=0x0002|0x0001
[void][W2.U]::SetWindowPos($h, [IntPtr]::Zero, 0,0,0,0, 0x0003)

Start-Sleep -Milliseconds 500
$fg2 = [W2.U]::GetForegroundWindow()
$fg2Pid = 0
[void][W2.U]::GetWindowThreadProcessId($fg2, [ref]$fg2Pid)
Write-Output "after: foreground.hwnd=$fg2 foreground.pid=$fg2Pid isShopilot=$($fg2 -eq $h) minimized=$([W2.U]::IsIconic($h))"
