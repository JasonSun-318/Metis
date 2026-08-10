# Windows Setup

Metis requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.metis/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Permissions

Ask/Full behavior is the same on Windows, macOS, and Linux: it is an application-level approval boundary. Ask requires one user decision for model actions other than proven safe structured reads and fixed internal controls; Full skips that approval. After approval, Metis provides no Windows-specific isolation—the action runs with the authority of the user account that started Metis. Use a container, VM, Windows Sandbox, or a separate OS account when isolation is required.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```
