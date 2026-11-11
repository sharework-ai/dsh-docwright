# Installing a scenario pack from the market

This guide is self-contained: everything below works in a dsh session with the docwright plugin installed. No `install.mjs`, no shell commands, no restart.

## When this applies

The user asks to install, add, fetch, or get a scenario pack — by name ("帮我安装 cosmic-context 技能", "install the resume pack") or by the document type they need ("装一个生成会议纪要的 pack"). The pack is installed from the deployment's pack market.

## Step 1 — find the pack (skip when the name is explicit)

Call `doc_market_search` with keywords you compose from the user's intent (document genre + domain words; English matches best). Each hit carries name, description, version, consumed pack types, and the install option. Present the plausible hit(s) and confirm the exact name with the user when more than one fits. If the user gave an exact pack name, skip this step.

The market URL is deployment state: the tools read `marketUrl` from the plugin config (default `https://dm.shrwk.com`). Never hardcode a market other than the one the deployment is configured with — the same tools serve test and production markets.

## Step 2 — ask for confirmation (always)

Call `doc_market_install` with `{ "pack": "<name>" }` and WITHOUT `confirm`. The result is a `pendingConfirmation` table listing the whole install closure: the requested pack plus every pack it consumes (transitively), each at its market version, the source market, and the target `packsDir`. Present this table to the user in plain language (for a chain pack, say that the dependencies install along with it).

Never self-confirm: do not call with `confirm: true` before the user has seen the table and approved it. If the user declines, stop — nothing has been written at this point.

## Step 3 — execute

After approval, re-call `doc_market_install` with `{ "pack": "<name>", "confirm": true }`. The install verifies the download against the market index (sha256, manifest name, content hash), lands it atomically in the `packsDir`, and hot-reloads the pack map. Members already installed at the market version are skipped; an existing pack name is updated in place.

The result lists what landed (`installed: name@version` entries). The packs are usable in THIS session immediately — no restart and no new session.

## Step 4 — verify and continue

Call `doc_packs` to confirm the pack (and its dependencies) now appear, then continue the user's original task with `doc_generate`. Upstream packs the chain needs are part of the closure, so a chained scenario works right away.

## Common situations

- **Market unreachable**: the tool fails with a clear error naming the market URL. Relay it; do not fabricate packs or copy files by hand.
- **Pack not on this market**: the error says the pack is not listed at the configured market. Offer `doc_market_search` for alternatives, or tell the user the pack must be published to this market first.
- **User wants a document type nobody wrote**: after a market search comes back empty, use the `docwright-pack-authoring` skill to author a new pack.
- **Updating instead of installing**: the same tool updates an already-installed pack name; the settings page's Packs tab offers check-for-updates and delete as well. Deleting a pack other installed packs depend on is refused (packInUse) unless the user explicitly confirms the break.
- **CLI fallback (outside a dsh session only)**: `node install.mjs <pack> --index <marketUrl>/api/index` — this is the market server's legacy installer, not part of the dsh plugin. Prefer the session tools; they run the same verified pipeline and add the confirmation gate.
