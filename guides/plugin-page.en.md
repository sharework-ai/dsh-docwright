# Docwright document generation

A pack defines one document type (JSON Schema, validation rules, generation prompt); packs chain into multi-stage scenarios. Params pass a confirmation gate before generation, and every document ships with a replayable validation receipt. The full README lives on npm and GitHub.

- **Parameters**: the "Docwright params" card below on this page, or Settings → Docwright params.
- **Pack market**: the "Docwright packs" tab on the Plugins page (served from the deployment's `marketUrl`, default [dm.shrwk.com](https://dm.shrwk.com/)).
- **Custom packs**: `config.docwright.packsDir` in `cordis.yml` (convention `<workspace>/.docwright/packs/`); same-name packs override built-ins.
