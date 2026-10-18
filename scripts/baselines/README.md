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
