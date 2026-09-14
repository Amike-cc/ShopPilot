/** 找主进程 pid（带 --type= 的都是子进程），并在需要时重启应用 */
const { execSync } = await import('child_process')
const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'electron.exe\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"', { encoding: 'utf8' })
let arr = []
try { arr = JSON.parse(out) } catch { arr = [] }
if (!Array.isArray(arr)) arr = [arr]
const mains = arr.filter(p => String(p.CommandLine || '').includes('9250') && !String(p.CommandLine || '').includes('--type='))
for (const m of mains) console.log(m.ProcessId, '|', String(m.CommandLine).trim().slice(0, 130))
console.log('主进程数:', mains.length)
