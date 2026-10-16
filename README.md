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

Follow [AGENTS.md](AGENTS.md), the existing module patterns, and Biome's tab
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
./metis-test.sh
```

Run static checks with:

```bash
npm run check
```

This includes architecture and native TypeScript import checks, regression
tests for the check scripts, generated protocol schema validation, dependency
lock checks, strict source/test type checks (including desktop TSX tests and browser fixtures), and
a browser bundle smoke check. Run `npm run check:scripts` for the check-script
regressions alone.

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
