# Metis

Metis is an extensible general-purpose agent foundation for terminal and application integrations.

## Packages

- `@metis/ai`: multi-provider LLM API
- `@metis/agent-core`: agent runtime and tool execution
- `@metis/coding-agent`: interactive CLI, SDK, and RPC mode
- `@metis/tui`: terminal UI components
- `@metis/app-protocol`: runtime-independent request, response, and event contracts
- `@metis/app-server`: recoverable multi-session application server
- `@metis/desktop`: Electron shell and React application

## Architecture and code conventions

The runtime builds upward through `ai → agent-core → coding-agent → app-server`,
with `tui` providing terminal components to `coding-agent`. Application clients share
`app-protocol` contracts. The app-server integrates through the public
`@metis/coding-agent/host` entry point; desktop communicates with the app-server
through its transport and protocol rather than importing runtime implementation.

Import other workspace packages through their public entry points. Relative
imports stay within a package. In desktop, renderer code uses the preload API
and shared contracts; it cannot import main-process code or Node/Electron APIs.
Shared desktop modules and app-protocol source remain independent of those
runtimes. An exceptional import requires a trailing
`// boundary-allow: <reason>` comment explaining the boundary crossing.

Follow the existing module patterns and Biome's tab
indentation and 120-column formatting for files covered by its configuration.
Use strict, erasable TypeScript, explicit interfaces, and top-level imports.
Keep deliberate lazy loading where browser compatibility, optional native
dependencies, or startup cost requires it. These conventions follow
[pi's development rules](https://github.com/earendil-works/pi/blob/main/AGENTS.md)
and [minimal-core philosophy](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md).

## Development

Requires Node.js 22.19 or newer.

```bash
npm ci --ignore-scripts
./test.sh          # full test suite with an isolated agent directory
./metis-test.sh    # run the interactive CLI from source
```

Static checks have two tiers:

```bash
npm run check:fast   # pre-commit: staged files only, path-scoped
npm run check        # full repository gate (pre-push hook and CI)
```

`npm run check` includes architecture and native TypeScript import checks, regression
tests for the check scripts, generated protocol schema validation, dependency
lock checks, strict source/test type checks (including desktop TSX tests and browser fixtures), and
a browser bundle smoke check. The full gate runs the independent checks in parallel (up to four jobs) and
caches successful results for an unchanged working tree under `.cache/checks/`;
set `METIS_CHECK_CONCURRENCY` or `METIS_CHECK_NO_CACHE=1` to control that. `check:fast` keeps the staged-file subset, the
path-scoped desktop type check and the check-script regressions; whole-repository
analyses such as runtime cycles, public API surfaces, duplicate/dead-export
reports and type debt run in the full gate only. Run `npm run check:scripts` for
the check-script regressions alone.

`npm run build` refreshes the AI model catalog through `generate-models`; set
`METIS_SKIP_MODEL_REGENERATION=1` to use the offline build when model data files
should not be rewritten.

Native Windows acceptance has a dedicated probe script; it refuses to run off
Windows so a pass always means native evidence:

```bash
npm run build            # probes load staged grammar/native assets
npm run verify:windows   # native Windows only: paths/journal/native addon/editors/child processes
```

The nightly `Architecture checks` workflow runs the same probes on a Windows
runner; push and pull-request runs stay on Linux so per-push cost is unchanged.

The desktop dev runtime hashes its build inputs and skips the six package builds
when nothing changed; set `METIS_FORCE_DEV_REBUILD=1` to force a rebuild.
`npm run clean:artifacts` reports regenerable desktop build/test artifacts (add
`--apply` to delete them, or `--include-cache` for the check cache and dev
runtime).

Biome checks source and test `.ts`/`.tsx` files, desktop browser TSX fixtures,
and explicitly listed check scripts. Keep Hook dependencies complete; explain
intentional refresh or focus triggers with dependency-specific suppressions.
Prefer semantic HTML and document any necessary custom-control exceptions locally.

`./test.sh` removes provider credentials from the child environment and uses a
temporary agent configuration directory. It leaves the user's authentication
and session files in place and cleans up the temporary directory on exit.

## Repository

https://gitee.com/sun124578963_0/metis.git

## License

MIT. See [LICENSE](LICENSE).
