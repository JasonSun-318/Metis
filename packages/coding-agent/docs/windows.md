# Windows Setup

Metis requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.metis/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Permissions

Ask/Auto/Full routing is the same on Windows, macOS, and Linux. Ask and Auto use the packaged workspace sandbox for ordinary model-initiated Bash and fail closed if the platform helper is unavailable; actions explicitly shown as host execution use the current user account after approval. Full runs on the host without Metis approval. Use a container, VM, Windows Sandbox, or separate OS account when the entire Metis process or installed integrations must be isolated.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
