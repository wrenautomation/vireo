# vireo

Start at `README.md`. Why it is shaped this way: `designs/` (dated, with decision logs).
Before a commit: `pnpm -s gates`.

- Vireo imports nothing from a host. A host's need is a port (`Ports`, `CliHost`), never an import.
- Schema change: edit `src/schema.ts`, run `pnpm db:generate`, commit the SQL. Never edit an applied migration.
- Tests run on PGlite with synthetic data. No lead data, client names or secrets: this repo is public.
- Release: bump `version`, tag `v<version>`, push the tag. CI publishes.
- Wren is the first host (`wren/packages/variants`). A breaking change bumps the minor and updates wren in the same pass.
