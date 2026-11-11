# Development

See [AGENTS.md](../../../AGENTS.md) for additional guidelines.

## Setup

Requires Node.js 22.19 or newer. Clone https://gitee.com/sun124578963_0/metis.git, then from the repository root:

```bash
npm ci --ignore-scripts
```

Run from source:

```bash
/path/to/metis/metis-test.sh
```

The script can be run from any directory. Metis keeps the caller's current working directory. It starts the CLI with `tsx`, so a package build is not required.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "metisConfig": {
    "name": "metis",
    "configDir": ".metis"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemesDir } from "./config.ts";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.metis/agent/metis-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
