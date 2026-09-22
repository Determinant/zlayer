# Working in ZLayer

Run commands from the repository root. The root package owns the app; only
`packages/contracts` and `packages/domain` are npm workspaces.

## Read before changing behavior

- [Documentation index](docs/README.md): reading order and task-to-guide lookup.
- [Direction and principles](docs/product/direction.md): enduring product choices.
- [Engineering guide](docs/development/engineering.md): simplicity, ownership,
  recovery and source-identity invariants.
- [Architecture](docs/architecture/overview.md) and
  [layer plugins](docs/architecture/layer-plugins.md): source layout and lifecycle boundaries.

Read the relevant feature and data contracts from the index before changing their
behavior. Each plugin's documentation starts at `src/layers/<plugin>/README.md`;
its algorithms, design notes and validation stay in that folder. Shared application
contracts and project-wide guidance live in `docs/`.
The roadmap distinguishes implemented and planned work. ADRs retain
design rationale; dated reviews and evidence do not prove the current tree passes.
Keep unrelated working-tree changes intact.

## Verification and documentation

Use [local development](docs/development/local-development.md#verification) for
the verification commands and browser prerequisites. Before committing, the
repository requires `npm run verify:full`; device-only release checks remain separate.

Update the owning guide when behavior or a contract changes. Follow the
[documentation maintenance rules](docs/README.md#keeping-the-docs-useful): preserve
rationale, constraints and unresolved findings, maintain links, and keep proposals
and historical results distinguishable from current requirements.
