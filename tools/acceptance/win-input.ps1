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
    foreground           -> JSON with HWND, PID, title, class and process command line
    identity              -> JSON with all target-PID top-level windows and selected HWND
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
  [string]$SpecB64 = '',
  [ValidateSet('virtual', 'scan')][string]$KeyMode = 'virtual',
  [string]$DiagLog = '',
  [int]$X = 0,
  [int]$Y = 0
)

$ErrorActionPreference = 'Stop'

$script:DiagPath = if ($DiagLog) { $DiagLog } elseif ($env:SHOPILOT_INPUT_DIAG_LOG) { $env:SHOPILOT_INPUT_DIAG_LOG } else { '' }

function Write-Diagnostic {
    param([string]$Message, [object]$Data = $null)
    if (-not $script:DiagPath) { return }
    $entry = [ordered]@{
        timestamp = [DateTime]::UtcNow.ToString('o')
        message = $Message
    }
    if ($null -ne $Data) { $entry.data = $Data }
    try {
        $parent = Split-Path -Parent $script:DiagPath
        if ($parent) { [void](New-Item -ItemType Directory -Force -Path $parent) }
        Add-Content -LiteralPath $script:DiagPath -Value ($entry | ConvertTo-Json -Compress -Depth 8) -Encoding UTF8
    } catch {
        # Diagnostics must never change input behavior or make the helper fail.
    }
}

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class ShopilotInput
{
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

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
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    public static IntPtr[] FindWindowsForProcess(uint pid)
    {
        var windows = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            uint ownerPid = 0;
            GetWindowThreadProcessId(hWnd, out ownerPid);
            if (ownerPid == pid) windows.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
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

    public static uint VirtualKey(ushort vk)
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = vk;
        inputs[0].u.ki.dwFlags = 0;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].u.ki.wVk = vk;
        inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
        return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static uint KeyDown(ushort vk)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = vk;
        inputs[0].u.ki.dwFlags = 0;
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static uint KeyUp(ushort vk)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = vk;
        inputs[0].u.ki.dwFlags = KEYEVENTF_KEYUP;
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static uint ScanKeyDown(ushort scan)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wScan = scan;
        inputs[0].u.ki.dwFlags = 0x0008; // KEYEVENTF_SCANCODE
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static uint ScanKeyUp(ushort scan)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wScan = scan;
        inputs[0].u.ki.dwFlags = 0x0008 | KEYEVENTF_KEYUP; // KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public const uint GW_OWNER = 4;
    public const uint GA_ROOT = 2;
}
"@

# Physical-pixel coordinates: without this the OS virtualizes cursor coordinates on a
# scaled display, so a click computed from renderer CSS pixels lands in the wrong place.
[void][ShopilotInput]::MakeDpiAware()

$KEYMAP = @{
    'Return' = 0x0D; 'Enter' = 0x0D; 'Escape' = 0x1B; 'Esc' = 0x1B
    'Backspace' = 0x08; 'Tab' = 0x09; 'Down' = 0x28; 'Up' = 0x26
    'Left' = 0x25; 'Right' = 0x27; 'Delete' = 0x2E; 'Space' = 0x20
    'Control' = 0x11; 'Ctrl' = 0x11; 'Shift' = 0x10; 'Alt' = 0x12
    'W' = 0x57; 'A' = 0x41
}

# Set 1 make codes used by the scan-code path. These are deliberately separate
# from virtual-key codes so each diagnostic run records exactly which path ran.
$SCANMAP = @{
    'Return' = 0x1C; 'Enter' = 0x1C; 'Escape' = 0x01; 'Esc' = 0x01
    'Backspace' = 0x0E; 'Tab' = 0x0F; 'Down' = 0x50; 'Up' = 0x48
    'Left' = 0x4B; 'Right' = 0x4D; 'Delete' = 0x53; 'Space' = 0x39
    'Control' = 0x1D; 'Ctrl' = 0x1D; 'Shift' = 0x2A; 'Alt' = 0x38
    'W' = 0x11; 'A' = 0x1E
}

function Invoke-KeyEdge([string]$part, [uint16]$code, [string]$edge, [string]$mode) {
    $isDown = $edge -eq 'keydown'
    $sent = if ($mode -eq 'scan') {
        if ($isDown) { [ShopilotInput]::ScanKeyDown($code) } else { [ShopilotInput]::ScanKeyUp($code) }
    } else {
        if ($isDown) { [ShopilotInput]::KeyDown($code) } else { [ShopilotInput]::KeyUp($code) }
    }
    Write-Diagnostic "send-input $edge" ([ordered]@{
        key = $part
        mode = $mode
        vk = if ($mode -eq 'virtual') { [int]$code } else { 0 }
        scan = if ($mode -eq 'scan') { [int]$code } else { 0 }
        sendInputCount = [int]$sent
    })
    if ($sent -ne 1) { throw "SendInput failed for $edge $part mode=$mode count=$sent" }
}

function Get-DiagnosticWindowSummary {
    $target = $null
    $foreground = $null
    try { $target = Get-TargetWindowInfo | Select-Object hwnd,pid,title,className,x,y,w,h } catch { }
    try { $foreground = Get-ForegroundInfo | Select-Object hwnd,pid,title,className,rootHwnd } catch { }
    return [ordered]@{ target = $target; foreground = $foreground }
}

function Invoke-KeyStep([string]$keyText) {
    $parts = @($keyText -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -eq 0) { throw 'key is required' }
    $codes = @()
    foreach ($part in $parts) {
        $lookup = $part
        if (-not $KEYMAP.ContainsKey($lookup)) { $lookup = $part.ToUpperInvariant() }
        $map = if ($KeyMode -eq 'scan') { $SCANMAP } else { $KEYMAP }
        if (-not $map.ContainsKey($lookup)) { throw "unsupported key: $part" }
        $codes += [pscustomobject]@{ name = $part; code = [System.UInt16]$map[$lookup] }
    }
    Write-Diagnostic 'key sequence begin' ([ordered]@{
        key = $keyText
        mode = $KeyMode
        targetPid = $TargetPid
        identity = Get-DiagnosticWindowSummary
    })
    if ($codes.Count -eq 1) {
        Invoke-KeyEdge $codes[0].name $codes[0].code 'keydown' $KeyMode
        try { Start-Sleep -Milliseconds 30 } finally { Invoke-KeyEdge $codes[0].name $codes[0].code 'keyup' $KeyMode }
        Write-Diagnostic 'key sequence end' ([ordered]@{ key = $keyText; mode = $KeyMode })
        return
    }
    $pressed = New-Object System.Collections.Generic.List[object]
    try {
        foreach ($item in $codes) {
            Invoke-KeyEdge $item.name $item.code 'keydown' $KeyMode
            [void]$pressed.Add($item)
            Start-Sleep -Milliseconds 25
        }
        Start-Sleep -Milliseconds 80
    } finally {
        for ($i = $pressed.Count - 1; $i -ge 0; $i--) {
            $item = $pressed[$i]
            Invoke-KeyEdge $item.name $item.code 'keyup' $KeyMode
            Start-Sleep -Milliseconds 25
        }
        Write-Diagnostic 'key sequence end' ([ordered]@{ key = $keyText; mode = $KeyMode; released = $pressed.Count })
    }
}

function Get-ProcessCommandLine([int]$processId) {
    $commandLine = ''
    try {
        $row = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId={0}" -f $processId) -ErrorAction Stop
        $commandLine = [string]$row.CommandLine
    } catch {
        try {
            $row = Get-WmiObject -Class Win32_Process -Filter ("ProcessId={0}" -f $processId) -ErrorAction Stop
            $commandLine = [string]$row.CommandLine
        } catch { $commandLine = '' }
    }
    return $commandLine
}

function Get-WindowText($handle) {
    $length = [ShopilotInput]::GetWindowTextLength($handle)
    $capacity = [Math]::Max(256, $length + 1)
    $builder = New-Object System.Text.StringBuilder $capacity
    [void][ShopilotInput]::GetWindowText($handle, $builder, $builder.Capacity)
    return $builder.ToString()
}

function Get-WindowClass($handle) {
    $builder = New-Object System.Text.StringBuilder 256
    [void][ShopilotInput]::GetClassName($handle, $builder, $builder.Capacity)
    return $builder.ToString()
}

function Get-WindowInfo($handle) {
    if ($handle -eq [IntPtr]::Zero -or -not [ShopilotInput]::IsWindow($handle)) { return $null }
    $windowPid = [uint32]0
    $threadId = [ShopilotInput]::GetWindowThreadProcessId($handle, [ref]$windowPid)
    $rect = New-Object ShopilotInput+RECT
    $hasRect = [ShopilotInput]::GetWindowRect($handle, [ref]$rect)
    $left = 0; $top = 0; $right = 0; $bottom = 0
    if ($hasRect) {
        $left = $rect.Left; $top = $rect.Top; $right = $rect.Right; $bottom = $rect.Bottom
    }
    $root = [ShopilotInput]::GetAncestor($handle, [ShopilotInput]::GA_ROOT)
    $owner = [ShopilotInput]::GetWindow($handle, [ShopilotInput]::GW_OWNER)
    return [pscustomobject]@{
        # nativeHandle is retained for internal calls; hwnd is the JSON-safe identity.
        nativeHandle = $handle
        hwnd = [Int64]$handle.ToInt64()
        pid = [int]$windowPid
        threadId = [int]$threadId
        title = Get-WindowText $handle
        className = Get-WindowClass $handle
        visible = [bool][ShopilotInput]::IsWindowVisible($handle)
        ownerHwnd = if ($owner -eq [IntPtr]::Zero) { 0 } else { [Int64]$owner.ToInt64() }
        rootHwnd = if ($root -eq [IntPtr]::Zero) { 0 } else { [Int64]$root.ToInt64() }
        x = $left
        y = $top
        w = $right - $left
        h = $bottom - $top
        processName = ''
        commandLine = ''
    }
}

function Get-TargetWindowCandidates {
    if ($TargetPid -le 0) { throw 'TargetPid is required' }
    $targetProcess = Get-Process -Id $TargetPid -ErrorAction Stop
    if ($targetProcess.ProcessName -notin @('electron', 'ShopPilot')) {
        throw "refusing non-Electron target process pid=$TargetPid name=$($targetProcess.ProcessName)"
    }
    $processCommandLine = Get-ProcessCommandLine $TargetPid
    if (-not $processCommandLine) { throw "refusing target pid=$TargetPid because process command line could not be verified" }
    $items = New-Object System.Collections.Generic.List[object]
    # Enumerate in native code, then inspect each returned HWND. This avoids relying on
    # Process.MainWindowHandle and avoids a PowerShell delegate callback scope.
    foreach ($handle in [ShopilotInput]::FindWindowsForProcess([uint32]$TargetPid)) {
        $info = Get-WindowInfo $handle
        # EnumWindows already returns top-level windows. Keep the PID check explicit so
        # a stale MainWindowHandle or a foreground window from another app can never pass.
        if ($null -ne $info -and $info.pid -eq $TargetPid) { [void]$items.Add($info) }
    }
    foreach ($item in $items) {
        [void]($item.processName = $targetProcess.ProcessName)
        [void]($item.commandLine = $processCommandLine)
    }
    return @($items.ToArray())
}

function Get-TargetWindowInfo {
    $candidates = @(Get-TargetWindowCandidates)
    $usable = @($candidates | Where-Object {
        $_.pid -eq $TargetPid -and $_.visible -and $_.rootHwnd -eq $_.hwnd -and $_.w -gt 40 -and $_.h -gt 40
    })
    if ($usable.Count -eq 0) {
        $dump = ($candidates | Select-Object hwnd,pid,title,className,visible,x,y,w,h,rootHwnd,processName,commandLine | ConvertTo-Json -Compress -Depth 4)
        throw "process $TargetPid has no unique visible top-level window; candidates=$dump"
    }
    if ($usable.Count -ne 1) {
        $dump = ($usable | Select-Object hwnd,pid,title,className,visible,x,y,w,h,rootHwnd,processName,commandLine | ConvertTo-Json -Compress -Depth 4)
        throw "process $TargetPid has multiple visible top-level windows; refusing to guess; candidates=$dump"
    }
    return $usable[0]
}

function Get-TargetHandle {
    return (Get-TargetWindowInfo).nativeHandle
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
    if ($fg -eq [IntPtr]::Zero) { return [pscustomobject]@{ hwnd = 0; pid = 0; title = ''; className = ''; processName = '?'; commandLine = ''; rootHwnd = 0 } }
    $info = Get-WindowInfo $fg
    if ($null -eq $info) { return [pscustomobject]@{ hwnd = [Int64]$fg.ToInt64(); pid = 0; title = ''; className = ''; processName = '?'; commandLine = ''; rootHwnd = 0 } }
    $foregroundProcessName = ''
    try { $foregroundProcessName = (Get-Process -Id $info.pid -ErrorAction Stop).ProcessName } catch { $foregroundProcessName = '?' }
    return [pscustomobject]@{
        hwnd = $info.hwnd
        pid = $info.pid
        title = $info.title
        className = $info.className
        processName = $foregroundProcessName
        commandLine = Get-ProcessCommandLine $info.pid
        rootHwnd = $info.rootHwnd
    }
}

function Invoke-Focus {
    $target = Get-TargetWindowInfo
    $handle = $target.nativeHandle
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
    Assert-TargetForeground
    return (Get-Geometry $handle)
}

function Assert-TargetForeground {
    $target = Get-TargetWindowInfo
    $fg = Get-ForegroundInfo
    if ($fg.pid -ne $TargetPid) {
        throw "refusing to click: foreground is hwnd=$($fg.hwnd) pid=$($fg.pid) process=$($fg.processName), expected target pid=$TargetPid"
    }
    if ($fg.rootHwnd -ne $target.hwnd) {
        throw "refusing to click: foreground root hwnd=$($fg.rootHwnd) does not match target hwnd=$($target.hwnd) for pid=$TargetPid"
    }
}

switch ($Action) {
    'identity' {
        $target = Get-TargetWindowInfo
        $all = @(Get-TargetWindowCandidates | Select-Object hwnd,pid,threadId,title,className,visible,ownerHwnd,rootHwnd,x,y,w,h,processName,commandLine)
        [pscustomobject]@{
            targetPid = $TargetPid
            targetProcess = Get-ProcessCommandLine $TargetPid
            selected = ($target | Select-Object hwnd,pid,threadId,title,className,visible,ownerHwnd,rootHwnd,x,y,w,h,processName,commandLine)
            windows = $all
        } | ConvertTo-Json -Compress -Depth 6
    }
    'geometry' { (Get-Geometry (Get-TargetHandle)) | ConvertTo-Json -Compress }
    'foreground' { (Get-ForegroundInfo) | ConvertTo-Json -Compress }
    'focus' { (Invoke-Focus) | ConvertTo-Json -Compress }
    'windowAt' {
        # 点击坐标处的顶层窗口归属：OS 点击被谁吃了，用这个查（HTML 的 elementFromPoint 看不见 OS 级遮挡）
        $pt = New-Object ShopilotInput+POINT
        $pt.X = $X; $pt.Y = $Y
        $h = [ShopilotInput]::WindowFromPoint($pt)
        $wpid = 0
        [void][ShopilotInput]::GetWindowThreadProcessId($h, [ref]$wpid)
        $info = Get-WindowInfo $h
        $windowProcessName = ''
        try { $windowProcessName = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { $windowProcessName = '?' }
        $windowCommandLine = if ($wpid -gt 0) { Get-ProcessCommandLine $wpid } else { '' }
        [pscustomobject]@{
            x = $X
            y = $Y
            hwnd = if ($h -eq [IntPtr]::Zero) { 0 } else { [Int64]$h.ToInt64() }
            pid = $wpid
            title = if ($info) { $info.title } else { '' }
            className = if ($info) { $info.className } else { '' }
            processName = $windowProcessName
            commandLine = $windowCommandLine
            rootHwnd = if ($info) { $info.rootHwnd } else { 0 }
        } | ConvertTo-Json -Compress
    }
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
                    Invoke-KeyStep ([string]$step.key)
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
        $identity = Get-TargetWindowInfo
        [pscustomobject]@{
            done = $done
            geometry = (Get-Geometry $identity.nativeHandle)
            identity = ($identity | Select-Object hwnd,pid,threadId,title,className,visible,ownerHwnd,rootHwnd,x,y,w,h,processName,commandLine)
        } | ConvertTo-Json -Compress -Depth 6
    }
    default { throw "unsupported action: $Action" }
}
