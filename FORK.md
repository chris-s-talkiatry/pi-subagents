# Fork notice

This is a maintained fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
(MIT, Copyright (c) 2026 tintinweb; see `LICENSE`, unchanged), based on the upstream `v0.19.0` tag
(`4f572eaa04c09d3dbc16e4a5f13a16b295e84e14`). It adds a versioned guard bridge for the scope-guard
extension in the owner's Pi configuration. Initial target runtime: Pi 1.4.0.

- Package name: `@chris-s-talkiatry/pi-subagents` (deliberately distinct from upstream so stock
  upstream can never silently stand in for it). Its unscoped short name remains `pi-subagents`.
- Branch `scope-guard-main` carries fork work; releases are immutable git tags `v<upstream>-scope-guard.<n>`.
- Superseding test artifact version `0.19.0-scope-guard.2` is identified by immutable tag `v0.19.0-scope-guard.2`; `.1` remains at its original local tag as a superseded record and is not accepted as the current artifact.
- Install by tag only, never by branch, via the Pi `git:` package source. Do not patch installed npm files.
- Guarded child sessions use the v1 `createChildGuardExtension` registration hook; ordinary discovered guard copies can detect the child with `getGuardChildContext(pi.events)` and remain inert, while the returned inline guard factory is loaded last. See `docs/guard-bridge.md` for ordering, failure behavior, and the trusted-extension limitation.
- Artifact `.2` supersedes `.1` after pre-deployment review found critical guard-off scheduler compatibility and status/filter boundary issues. Guarded capture reports `commit`/`branch` as package-owned only after the same cleanup invocation's `git add -A` received an allowed review; status and staging remain unbounded/reviewed. This ordering is enforced within the fork process and is not cryptographic evidence to another in-process extension.


## Development compatibility limitation

The fork's own `npm ci`, Vitest, TypeScript and Biome gates use its pinned Pi devDependencies at `0.84.2`. Keep those pins until a dedicated dependency-update change proves a safe bump: trying Pi `1.4.0` types produced two `src/mention-clone.ts` errors (`ExtensionContext` lacks `tools` and `executeTool` required by `ExtensionToolContext`; `systemPrompt` is readonly), and the test suite had 22 failures across 8 files. Host runtime compatibility with Pi `1.4.0` and `1.5.0` is verified separately by `~/.pi` tests against the immutable extracted artifact; these host-runtime checks do not claim the fork's own typecheck is against those host versions.
