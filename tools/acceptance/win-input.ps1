<#
  win-input.ps1 - real Windows input for acceptance runs.

  Why this exists: the other verify scripts drive the renderer with synthesized DOM
  events (el.click() / dispatchEvent). Those prove the logic, but not that a real
  mouse press lands on the real window. This helper injects input through the OS
  (SendInput), so a test can exercise the true hit-testing path on a genuine window.

  ASCII only on purpose: Windows PowerShell 5.1 parses BOM-less UTF-8 as ANSI, so a
  non-ASCII literal in this file would be mangled. Non-ASCII text arrives as an
  argument, which is a proper Unicode string by then.

  Actions:
    geometry             -> JSON {x,y,w,h} of the target window in PHYSICAL pixels
    foreground           -> JSON {pid,name} of the current foreground window
    focus                -> restore + foreground the target window, then geometry
    batch   -Spec <json> -> run an array of steps in one process (see below)

  Batch step shapes:
    { "type": "focus" }
    { "type": "move",  "cssX": 100, "cssY": 200, "scale": 1.0 }
    { "type": "click", "cssX": 100, "cssY": 200, "scale": 1.0 }
    { "type": "key",   "key": "Return" }
    { "type": "text",  "text": "hello" }
    { "type": "sleep", "ms": 200 }

  Click coordinates are CLIENT-RELATIVE CSS pixels, not absolute screen pixels, and the
  screen position is derived here at click time. That matters: the caller measures a
  bounding rect, then the window may be moved or restored by focus handling, and an
  absolute coordinate computed from a stale origin would silently land on the wrong
  pixel. Deriving it immediately before the click removes that whole class of error.

  Safety: every click is refused unless the target process is the foreground window,
  so a stray coordinate can never land on somebody else's app.

  The batch spec arrives as -SpecB64 (base64 of the UTF-8 JSON). Passing raw JSON as a
  command-line argument does not survive the trip: cmd.exe/PowerShell strip the inner
  double quotes and ConvertFrom-Json then fails with "unterminated string". Base64 has
  no characters the shell rewrites.
#>
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$TargetPid = 0,
  [string]$Spec = '',
  [string]$SpecB64 = ''
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class ShopilotInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern IntPtr GetFocus();
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    /**
     * Client-area origin and size in PHYSICAL screen pixels.
     * Needed because a click coordinate computed in renderer CSS pixels has to be
     * translated into the same space the OS cursor lives in, and that space is only
     * physical pixels once this process is DPI aware (otherwise Windows silently
     * virtualizes the numbers on a scaled display).
     */
    public static void ReportClient(IntPtr hWnd, out int originX, out int originY, out int width, out int height)
    {
        RECT r;
        GetClientRect(hWnd, out r);
        POINT p = new POINT();
        p.X = 0;
        p.Y = 0;
        ClientToScreen(hWnd, ref p);
        originX = p.X;
        originY = p.Y;
        width = r.Right - r.Left;
        height = r.Bottom - r.Top;
    }

    public static void MakeDpiAware()
    {
        try { SetProcessDpiAwareness(2); } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    public static void MouseButton(uint flag)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].u.mi.dwFlags = flag;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void LeftClick()
    {
        MouseButton(MOUSEEVENTF_LEFTDOWN);
        System.Threading.Thread.Sleep(25);
        MouseButton(MOUSEEVENTF_LEFTUP);
    }

    public static void TypeChar(ushort codeUnit)
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wScan = codeUnit;
        inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].u.ki.wScan = codeUnit;
        inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void VirtualKey(ushort vk)
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = vk;
        inputs[0].u.ki.dwFlags = 0;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].u.ki.wVk = vk;
        inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@

# Physical-pixel coordinates: without this the OS virtualizes cursor coordinates on a
# scaled display, so a click computed from renderer CSS pixels lands in the wrong place.
[void][ShopilotInput]::MakeDpiAware()

$KEYMAP = @{
    'Return' = 0x0D; 'Enter' = 0x0D; 'Escape' = 0x1B; 'Esc' = 0x1B
    'Backspace' = 0x08; 'Tab' = 0x09; 'Down' = 0x28; 'Up' = 0x26
    'Left' = 0x25; 'Right' = 0x27; 'Delete' = 0x2E; 'Space' = 0x20
}

function Get-TargetHandle {
    if ($TargetPid -le 0) { throw 'TargetPid is required' }
    $proc = Get-Process -Id $TargetPid -ErrorAction Stop
    $handle = $proc.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { throw "process $TargetPid has no main window" }
    return $handle
}

function Get-Geometry($handle) {
    $rect = New-Object ShopilotInput+RECT
    if (-not [ShopilotInput]::GetWindowRect($handle, [ref]$rect)) { throw 'GetWindowRect failed' }
    $clientX = 0; $clientY = 0; $clientW = 0; $clientH = 0
    [ShopilotInput]::ReportClient($handle, [ref]$clientX, [ref]$clientY, [ref]$clientW, [ref]$clientH)
    return [pscustomobject]@{
        x = $rect.Left
        y = $rect.Top
        w = $rect.Right - $rect.Left
        h = $rect.Bottom - $rect.Top
        # click origin: physical screen coords of the client area's top-left corner
        clientX = $clientX
        clientY = $clientY
        clientW = $clientW
        clientH = $clientH
    }
}

function Get-ForegroundInfo {
    $fg = [ShopilotInput]::GetForegroundWindow()
    $fgPid = 0
    [void][ShopilotInput]::GetWindowThreadProcessId($fg, [ref]$fgPid)
    $name = ''
    try { $name = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch { $name = '?' }
    return [pscustomobject]@{ pid = $fgPid; name = $name }
}

function Invoke-Focus {
    $handle = Get-TargetHandle
    [void][ShopilotInput]::ShowWindow($handle, 9)   # SW_RESTORE

    # Windows only grants SetForegroundWindow to a process that already owns the
    # foreground (or was started by it). Our test runner is a background process, so a
    # plain call is silently ignored (observed: foreground stayed on an unrelated app).
    # Attaching to the current foreground thread's input queue lifts that restriction,
    # which is the standard workaround.
    $fg = [ShopilotInput]::GetForegroundWindow()
    $fgThread = 0
    $fgPid = 0
    if ($fg -ne [IntPtr]::Zero) { $fgThread = [ShopilotInput]::GetWindowThreadProcessId($fg, [ref]$fgPid) }
    $thisThread = [ShopilotInput]::GetCurrentThreadId()

    if ($fgThread -ne 0 -and $fgThread -ne $thisThread) {
        [void][ShopilotInput]::AttachThreadInput($fgThread, $thisThread, $true)
    }
    try {
        [void][ShopilotInput]::BringWindowToTop($handle)
        [void][ShopilotInput]::SetForegroundWindow($handle)
        [void][ShopilotInput]::SetFocus($handle)
    } finally {
        if ($fgThread -ne 0 -and $fgThread -ne $thisThread) {
            [void][ShopilotInput]::AttachThreadInput($fgThread, $thisThread, $false)
        }
    }
    Start-Sleep -Milliseconds 350
    return (Get-Geometry $handle)
}

function Assert-TargetForeground {
    $fg = Get-ForegroundInfo
    if ($fg.pid -ne $TargetPid) {
        throw "refusing to click: foreground is pid=$($fg.pid) name=$($fg.name), expected pid=$TargetPid"
    }
}

switch ($Action) {
    'geometry' { (Get-Geometry (Get-TargetHandle)) | ConvertTo-Json -Compress }
    'foreground' { (Get-ForegroundInfo) | ConvertTo-Json -Compress }
    'focus' { (Invoke-Focus) | ConvertTo-Json -Compress }
    'batch' {
        if (-not $SpecB64) { throw 'SpecB64 is required for batch' }
        $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($SpecB64))
        $steps = $json | ConvertFrom-Json
        $done = New-Object System.Collections.ArrayList
        foreach ($step in $steps) {
            switch ($step.type) {
                'focus' { $null = Invoke-Focus; [void]$done.Add('focus') }
                'move' {
                    Assert-TargetForeground
                    $g = Get-Geometry (Get-TargetHandle)
                    $sx = [int][Math]::Round($g.clientX + [double]$step.cssX * [double]$step.scale)
                    $sy = [int][Math]::Round($g.clientY + [double]$step.cssY * [double]$step.scale)
                    if (-not [ShopilotInput]::SetCursorPos($sx, $sy)) { throw 'SetCursorPos failed' }
                    Start-Sleep -Milliseconds 40
                    [void]$done.Add("move:$sx,$sy")
                }
                'click' {
                    Assert-TargetForeground
                    $g = Get-Geometry (Get-TargetHandle)
                    $sx = [int][Math]::Round($g.clientX + [double]$step.cssX * [double]$step.scale)
                    $sy = [int][Math]::Round($g.clientY + [double]$step.cssY * [double]$step.scale)
                    if (-not [ShopilotInput]::SetCursorPos($sx, $sy)) { throw 'SetCursorPos failed' }
                    Start-Sleep -Milliseconds 60
                    [ShopilotInput]::LeftClick()
                    Start-Sleep -Milliseconds 60
                    [void]$done.Add("click:$sx,$sy")
                }
                'key' {
                    Assert-TargetForeground
                    if (-not $KEYMAP.ContainsKey([string]$step.key)) { throw "unsupported key: $($step.key)" }
                    [ShopilotInput]::VirtualKey([System.UInt16]$KEYMAP[[string]$step.key])
                    Start-Sleep -Milliseconds 60
                    [void]$done.Add("key:$($step.key)")
                }
                'text' {
                    Assert-TargetForeground
                    foreach ($ch in ([string]$step.text).ToCharArray()) {
                        [ShopilotInput]::TypeChar([System.UInt16][int]$ch)
                        Start-Sleep -Milliseconds 10
                    }
                    # Report length only: the text can be long and lands in logs.
                    [void]$done.Add("text:len=$($step.text.Length)")
                }
                'sleep' { Start-Sleep -Milliseconds ([int]$step.ms); [void]$done.Add("sleep:$($step.ms)") }
                default { throw "unsupported step type: $($step.type)" }
            }
        }
        [pscustomobject]@{ done = $done; geometry = (Get-Geometry (Get-TargetHandle)) } | ConvertTo-Json -Compress -Depth 4
    }
    default { throw "unsupported action: $Action" }
}
