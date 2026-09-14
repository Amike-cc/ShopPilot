/** 读主窗口与视图的实际几何，判断"视口 0×0"是窗口不可见还是视图未挂载。 */
const { execSync } = await import('child_process')
const out = execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne \'\' } | Select-Object Id,MainWindowTitle | ConvertTo-Json -Compress"', { encoding: 'utf8' })
console.log('带主窗口的 electron 进程:', String(out).trim().slice(0, 400) || '(无)')
const pidOut = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'electron.exe\'\\" | Where-Object { $_.CommandLine -like \'*9250*\' -and $_.CommandLine -notlike \'*--type=*\' } | Select-Object -ExpandProperty ProcessId"', { encoding: 'utf8' })
const pid = String(pidOut).trim()
console.log('主进程 pid:', pid)
if (pid) {
  const win = execSync(`powershell -NoProfile -Command "Get-Process -Id ${pid} | Select-Object Id,MainWindowHandle,MainWindowTitle | ConvertTo-Json -Compress"`, { encoding: 'utf8' })
  console.log('主进程窗口:', String(win).trim())
}
