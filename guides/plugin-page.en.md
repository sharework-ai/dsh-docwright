# Docwright document generation

A pack defines one document-generation scenario (or one stage of it): JSON Schema, parameter definitions, validation rules, generation prompt and related assets. Multiple packs chain into multi-stage scenarios. Parameters normally start being used only after the user confirms them, and every document ships with a replayable validation receipt. The full README lives on npm and GitHub.

- **Parameters**: the "Docwright params" card below on this page, or Settings → Docwright params.
- **Pack market**: the "Docwright packs" tab on the Plugins page (served from the deployment's `marketUrl`, default [dm.shrwk.com](https://dm.shrwk.com/)).
- **Custom packs**: `config.docwright.packsDir` in `cordis.yml` (convention `<workspace>/.docwright/packs/`); same-name packs override built-ins.
