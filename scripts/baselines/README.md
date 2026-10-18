# Structural regression baselines

`npm run check:cycles` checks TypeScript sources under `packages/*/src` using
in-memory JavaScript emission. This excludes erased type dependencies, including
implicit type imports. Static imports, reexports and literal `require()` calls
count; asynchronous `import()` calls do not. The baseline permits existing cyclic
edges to disappear, but rejects new cyclic edges, including inside an existing
strongly connected component. It does not attempt to remove existing cycles.

`npm run check:public-api` checks non-private ESM packages' `main`, `types`, conditional
export maps (including their resolution order), and value/type export names for
each TypeScript entrypoint. Wildcard subpaths are expanded, and curated surfaces
such as `@metis/coding-agent/host` are checked independently. Common root and host
exports must also resolve to the same declarations, so a mirror cannot silently
switch implementations while preserving export names. Packages without an
export map, such as `@metis/tui`, have their declared root entrypoint checked;
implicit deep imports are not enumerated. This is a surface gate, not a complete
signature-compatibility checker; typed contract tests and type checks remain
necessary. CommonJS public entrypoints and standalone declaration targets are
unsupported and fail explicitly instead of being recorded as empty surfaces.
CLI `bin` mappings are outside this surface gate.

Both gates run in `npm run check` (including pre-commit) and in the independent
architecture CI workflow. CI also runs their regression tests and the existing
source import and boundary checks.

Normal checks never rewrite these files. After an intentional architecture or
public API change has been reviewed, refresh the corresponding baseline from the
repository root, then review and commit its diff together with that change:

```sh
node scripts/check-runtime-cycles.mjs --update
node scripts/check-public-api.mjs --update
```

The initial baselines were captured from `694f3f17` before the helper extraction.

## Advisory duplicate report

`npm run check:dup` reports newly duplicated implementations against
`duplicates.json`. It runs in `npm run check` and architecture CI as an advisory
report: findings and scan errors are printed without failing the normal command;
CI additionally marks the report step `continue-on-error`. Regression tests for
the checker itself remain part of the normal required script tests.

Coverage is TypeScript/TSX source under `packages/*/src`, excluding declaration,
test/fixture and generated files. It compares function ASTs with at least 80
tokens, ignoring comments, formatting, optional punctuation and the callable's
own name. Parameters, modifiers, types, identifiers, literal values, parenthesis
grouping, raw template escapes and JSX text remain significant. It does not
detect near-duplicates or prove that two functions can safely be merged.
Nested functions already represented by a duplicated parent, or occupying at
least 85% of their parent, are suppressed to reduce redundant findings.

The baseline records hashes and counts per file/symbol, without line numbers.
Moving lines does not create a finding; an extra occurrence in an existing
cluster, including in the same file, does. Moving or renaming a baselined symbol
can require review. Existing duplicate counts can fall without failing a check.

Normal reports do not modify source files or their baseline. An incomplete scan
is diagnostic output, not evidence that the repository has no duplicates. After
reviewing intentional duplication, update the baseline explicitly and inspect
its diff:

```sh
node scripts/check-duplicates.mjs --update
```

## Advisory unused dependency report

`npm run check:unused-deps` scans the root manifest and declared workspaces,
including nested workspaces. It reports candidates and additions/removals against
`unused-deps.json`; it never removes dependencies, executes scanned code or
updates manifests/lockfiles. Like the duplicate report, it runs in `npm run check`
and a `continue-on-error` CI step. Findings, missing/invalid baselines and scan
errors do not fail normal reports. Incomplete scans skip incremental conclusions.

Evidence includes JavaScript/TypeScript production, test, script and config
imports/reexports, type imports, side effects, literal dynamic imports,
`require`/`resolve`, tsconfig types/extends, JSX runtimes, config strings and Vitest
environment directives. Package scripts recognize literal CLI commands, `npx` /
`npm exec` aliases and Node preload flags. Installed package metadata supplies bin
names, with built-in mappings for common repository tools. Run after installing
dependencies for best coverage. Sources belong to their nearest declared
workspace; sibling usage does not mask an unused declaration. Workspace scripts
and config usage can also account for tools declared at the root.

Peer, optional and recognized platform dependencies are conservatively retained.
Computed module references are listed as uncertainty, and affected unreferenced
dependencies remain candidates marked for manual review. Documentation, build
output and declarations in package.json are not usage evidence. Shell/YAML
files, arbitrary loaders and runtime/config indirection are not fully analyzed;
a reported candidate is not proof that a dependency is safe to remove. For
example, manually invoked tools documented in comments can still be reported.

The baseline stores only manifest path, dependency section and package name.
Losing the last detected reference or adding an unused declaration produces an
incremental candidate; line and version changes alone do not. Refresh explicitly
only after reviewing candidates (the initial baseline contains six candidates,
including manually invoked or implicitly used tools that need further review):

```sh
node scripts/check-unused-deps.mjs --update
```

An incomplete scan refuses baseline updates. Normal commands never rewrite
either advisory baseline; pruning old entries also requires an explicit update.

## Advisory internal export report

`npm run check:dead-exports` reports internal export candidates and changes against
`dead-exports.json`. It runs in `npm run check` and a `continue-on-error` architecture
CI step. Findings, missing/invalid baselines and scan errors do not block normal
reports. The check never removes exports or source, runs analyzed code, or writes
a baseline during a normal invocation. Its regression tests remain required.

Candidates are top-level exports in production TypeScript/TSX under
`packages/*/src`, excluding generated files, declarations and test fixtures.
Declared public entrypoints (`main`, `types` and conditional/wildcard exports),
their reexports and types reachable through public signatures are protected.
Reference evidence includes production, tests, e2e fixtures, scripts and configs,
including type references, namespace access and literal dynamic imports.

Candidates are grouped as `zero-reference`, `same-file-only`, `test-only` or
`barrel-only`. These describe detected references, not proof of dead code or
permission to delete a test interface. Imports count as evidence; the report is
not a whole-program reachability analysis. Aliases of the same declaration are
grouped into one candidate. Computed imports and namespace access
are reported as coverage uncertainty. External consumers, custom runtime loaders
and other indirection still require manual review.

The baseline stores file, export name and category, without line numbers. Moving
lines does not add a candidate; losing the last reference or changing its category
does. Incomplete scans skip incremental conclusions and refuse baseline updates.
After reviewing the report, explicitly refresh and inspect only this baseline:

```sh
node scripts/check-dead-exports.mjs --update
```

## Advisory type debt and suppression report

`npm run check:type-debt` counts production TypeScript/TSX under `packages/*/src`
and compares per-file/category counts with `type-debt.json`. It reports explicit
`any` types, `as any` / `<any>` assertions, non-null expressions, and Biome
suppression openings by rule/category. An assertion's `any` is also included in
the explicit-any total; those categories must not be summed. Suppression counts
represent rule mentions, not the number of lines suppressed. Closing
`biome-ignore-end` comments do not add counts.

The scanner uses TypeScript syntax and actual comment trivia, excluding literal
text, tests/fixtures, declaration files and generated sources. Generated header
markers must occur in leading comments. Counts do not depend on line numbers;
an increase in one file cannot be offset by a decrease in another. Replacing debt
within the same file/category without changing its count is outside this budget's
coverage. This is an advisory count, not a type-safety or suppression-validity proof.

Normal findings, missing/invalid baselines and incomplete scans remain advisory
in `npm run check` and architecture CI. Normal runs never change source or the
baseline; incomplete scans skip incremental conclusions. Existing Biome rule
levels are unchanged. The checker's regression tests remain required.

Refresh only after reviewing the counts; an incomplete scan refuses the update:

```sh
node scripts/check-type-debt.mjs --update
```

The agent and coding-agent `public-api-types.test.ts` suites additionally assert
selected public queue, session and tool-render signatures. Root `tsgo --noEmit`
checks those assertions, including negative assignments. They supplement the
export-surface gate; they are not exhaustive signature compatibility checks.

## Advisory presentation boundary report

`npm run check:presentation-boundaries` checks direct dependencies from
`packages/coding-agent/src/core` and `src/presentation`. It reports core-to-modes
and presentation-to-modes edges (including type dependencies), plus runtime
presentation-to-core edges. Type-only presentation-to-core dependencies and
modes-to-presentation compatibility reexports remain allowed. This is a direct
edge report; it does not replace the existing runtime cycle or package boundary
guards and does not attempt to remove the extension loader's existing root cycle.

The report parses imports, reexports, import types, literal dynamic imports and
`require()` calls. It distinguishes erased types from runtime dependencies and
normalizes relative source paths. Package aliases and arbitrary loader APIs are
outside this report's coverage. Computed module references, unreadable or
invalid sources, and incomplete classification are reported as coverage gaps;
an incomplete scan cannot establish a clean result or refresh the baseline.

Stable baseline identities contain source, target, rule and type/runtime kind.
Line moves and repeated occurrences of the same edge do not create a new edge;
a new target or kind does. The report lists added, removed and unchanged edges.
Normal invocations never modify source or baseline files and remain advisory for
findings, missing/invalid baselines and scan errors. Architecture CI additionally
uses `continue-on-error`; regression tests for the report remain required.

The initial baseline records no violations after the second-wave presentation
move. Refresh only after reviewing an intentional boundary change, then inspect
the diff:

```sh
node scripts/check-presentation-boundaries.mjs --update
```
