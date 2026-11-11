![docwright](/assets/images/logo.svg)

# Docwright document generation

A pack defines one document-generation scenario (or one stage of it): JSON Schema, parameter definitions, validation rules, generation prompt and related assets. Multiple packs chain into multi-stage scenarios. Parameters normally start being used only after the user confirms them, and every document ships with a replayable validation receipt. The full README lives on npm and [GitHub](https://github.com/sharework-ai/dsh-docwright).

- **Install scenario packs**: use the "Docwright packs" tab on the Plugins page, or [click here](https://dm.shrwk.com) to browse and install.
- **Configure packs or this plugin**: the tabs below let you set pack parameters, update or delete packs, and configure the plugin's own parameters.
- **Create a new scenario pack**: try prompting in a session — "create a skill that generates a resume from the given materials; it must cover at least basic information and education, and the highest education in basic information must appear in the education section."
