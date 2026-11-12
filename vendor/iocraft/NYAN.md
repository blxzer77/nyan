# Vendored iocraft

This directory is the `iocraft` crate (`packages/iocraft`) of
[Haleclipse/CometixTUI](https://github.com/Haleclipse/CometixTUI) at commit
`ec7c06155482815a4b4a99be5ad4c62675a632a1`, the commit nyan's `Cargo.lock`
pins for the rest of that repository. CometixTUI is a fork of
[ccbrown/iocraft](https://github.com/ccbrown/iocraft), licensed MIT OR
Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`, copied from the repository root).

nyan's `Cargo.toml` substitutes it with
`[patch."https://github.com/Haleclipse/CometixTUI"]`. Only `iocraft` is
vendored; `chalk` and `iocraft-macros` still resolve from the locked git commit.

## Differences from upstream

- `Cargo.toml`: `chalk` and `iocraft-macros` are `git` dependencies instead of
  `path = "../…"`, since their workspace siblings are not vendored.
- `README.md` (a symlink to the repository README upstream) is dropped.
