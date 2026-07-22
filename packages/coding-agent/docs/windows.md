# Windows Setup

ArcMind requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.arcmind/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Ask/Auto sandbox

ArcMind bundles the native `srt-win.exe` used by Ask and Auto; the first sandboxed command may request one setup approval and one UAC prompt, but it does not download a runtime. The synchronous Windows status/setup/wrap/cleanup lifecycle runs in a dedicated worker process, so provider streaming, child reasoning, CLI animation, and App Server events remain responsive.

Sandbox commands still execute FIFO behind one process-global and cross-process correctness lock because the current SRT backend shares one sandbox identity. Multiple subagents may reason concurrently, but two native-Windows sandbox commands do not run simultaneously. True parallel sandbox execution requires a future isolated capability-SID backend.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
