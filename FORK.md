# Fork notice

This is a maintained fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
(MIT, Copyright (c) 2026 tintinweb; see `LICENSE`, unchanged), based on the upstream `v0.19.0` tag
(`4f572eaa04c09d3dbc16e4a5f13a16b295e84e14`). It adds a versioned guard bridge for the scope-guard
extension in the owner's Pi configuration. Initial target runtime: Pi 1.4.0.

- Package name: `@chris-s-talkiatry/pi-subagents` (deliberately distinct from upstream so stock
  upstream can never silently stand in for it). Its unscoped short name remains `pi-subagents`.
- Branch `scope-guard-main` carries fork work; releases are immutable git tags `v<upstream>-scope-guard.<n>`.
- Install by tag only, never by branch, via the Pi `git:` package source. Do not patch installed npm files.
