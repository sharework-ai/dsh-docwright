# Installing a scenario pack from the market

This guide is self-contained: everything below works in a dsh session with the docwright plugin installed. No `install.mjs`, no shell commands, no restart.

## When this applies

The user asks to install, add, fetch, or get a scenario pack — by name ("帮我安装 cosmic-context 技能", "install the resume pack") or by the document type they need ("装一个生成会议纪要的 pack") — or a whole SUITE ("安装整套 cosmic", "安装 cosmic 套件", "install the cosmic suite"; a suite is a named set of packs the market curates). Both are installed from the deployment's pack market.

## Step 1 — check what is already installed (always first)

Call `doc_packs` before anything else. It lists every installed pack with its version.

- **The pack is already installed at the market's current version**: tell the user it is already available and skip the install entirely — go straight to using it.
- **The pack is already installed but older**: no separate update call is needed — `doc_market_install` updates an existing pack name in place (Step 3 handles both install and update), or the user can use the settings page's Packs tab (check for updates).
- **The pack is not installed**: continue with Step 2. Some of its dependencies may already be installed; the install closure skips members already at the market version.
- **A SUITE was asked for**: the same check applies to the suite as a whole. Every member already installed at the market version → tell the user the suite is complete and skip the install. Some members installed, some missing → it is a top-up install: continue with Step 2, and in the confirmation table point out which members are skipped as already current.

Only when something is actually missing (or outdated and the user wants the new version) does installing make sense. Never install a pack or suite the user already has without saying so.

## Step 2 — find the pack (skip when the name is explicit)

Call `doc_market_search` with keywords you compose from the user's intent (document genre + domain words; English matches best). Each hit carries name, description, version, consumed pack types, the suites it belongs to, and the install option; a query that matches a whole suite also returns a suite card (its members list). Present the plausible hit(s) and confirm the exact name with the user when more than one fits. If the user gave an exact pack or suite name, skip this step.

**Suite branch**: when the search returned a suite card and the user asked for the whole set ("整套"), install it with `doc_market_install { "suite": "<name>" }` (Step 3-4 are identical, with `suite` instead of `pack`). When the user named ONE pack, still install just that pack — but mention which suite(s) it belongs to, so the user can decide to take the whole set instead.

The market URL is deployment state: the tools read `marketUrl` from the plugin config (default `https://dm.shrwk.com`). Never hardcode a market other than the one the deployment is configured with — the same tools serve test and production markets. A market that does not support suites returns no suite cards; single-pack installs work exactly as before.

## Step 3 — ask for confirmation (always)

Call `doc_market_install` with `{ "pack": "<name>" }` or `{ "suite": "<name>" }` and WITHOUT `confirm`. The result is a `pendingConfirmation` table listing the whole install plan: for a pack, the requested pack plus every pack it consumes (transitively); for a suite, every member pack plus the upstreams members pull in — suite members and consumed upstreams are labeled differently in the table. Each row carries the market version, the source market, and the target `packsDir`. Present this table to the user in plain language (for a chain pack, say that the dependencies install along with it; for a suite, say which entries are the members and which came along as upstreams). For anything already installed and only being updated/topped-up, say so explicitly — already-current members are marked as skipped.

Never self-confirm: do not call with `confirm: true` before the user has seen the table and approved it. If the user declines, stop — nothing has been written at this point.

## Step 4 — execute

After approval, re-call `doc_market_install` with `confirm: true` added. The install verifies each download against the market index (sha256, manifest name, content hash), lands them atomically in the `packsDir`, and hot-reloads the pack map once at the end. Members already installed at the market version are skipped; an existing pack name is updated in place; a mid-install failure keeps what already landed (retrying the same suite only installs the missing pieces).

The result lists what landed (`installed: name@version` entries). The packs are usable in THIS session immediately — no restart and no new session.

## Step 5 — verify and continue

Call `doc_packs` to confirm the pack (and its dependencies) now appear, then continue the user's original task with `doc_generate`. Upstream packs the chain needs are part of the closure, so a chained scenario works right away.

## Common situations

- **Market unreachable**: the tool fails with a clear error naming the market URL. Relay it; do not fabricate packs or copy files by hand.
- **Pack not on this market**: the error says the pack is not listed at the configured market. Offer `doc_market_search` for alternatives, or tell the user the pack must be published to this market first.
- **Suite not on this market**: the error says the suite is not offered at the configured market (an old market may not support suites at all). Fall back to installing the packs the user actually needs one by one, via `doc_market_search`.
- **User wants a document type nobody wrote**: after a market search comes back empty, use the `docwright-pack-authoring` skill to author a new pack.
- **Updating instead of installing**: the same tool updates an already-installed pack name; the settings page's Packs tab offers check-for-updates and delete as well. Deleting a pack other installed packs depend on is refused (packInUse) unless the user explicitly confirms the break.
- **CLI fallback (outside a dsh session only)**: `node install.mjs <pack> --index <marketUrl>/api/index` — this is the market server's legacy installer, not part of the dsh plugin. Prefer the session tools; they run the same verified pipeline and add the confirmation gate.
