# Formal Web integration

The approved Slate canvas is preserved here. `src/` remains the frozen prototype reference.

## v0.30 task presentation

Web displays existing CLI-created tasks. Input cards, history controls and the blank workspace have no task creation controls; headings, selectors and history rows omit the closed label. The stored lifecycle and read-only rules remain intact. The manual browser gate now creates its isolated tasks through the CLI, then exercises the same explicit Web selection, retry and empty-selection flows.

## v0.29 direct bodies and repeat links

An expanded object whose own body was returned keeps an explicit body leaf and hit route to output. The leaf opens that original entity's archived text; it does not add a second hit or imply any child body was returned. Aggregate ancestors generate no body leaf. Unmatched children retain the standalone directory overflow.

Opening the original sign-in link again reuses a valid browser session without cookie rotation or expiry extension. Without that session, consumed/invalid codes remain rejected. HTTP 401 shows sign-in recovery and preserves the requested target instead of claiming the local service is unavailable. The resident service lifetime remains separate from both login-code and cookie expiry.

Windows validation: `node --test tests/v1/web-projection.test.mjs tests/v1/web-service.test.mjs tests/v1/agent-initialization.test.mjs tests/v1/first-use.test.mjs` passed 16 tests after two initial failures. `node scripts/v1/web-hit-session-smoke.mjs` exercised real Edge, repeated original URLs, archived body details, unchanged cookie/expiry, signed-out recovery and unchanged task records. Existing browser and large-directory gates also passed. Reports and inspected screenshots are under `.harness-local/validation/hit-session-*`; the installed CLI was checked against the user's original one-body task. Cold restart recovery exceeded the first startup/reader deadlines and remains a separate performance limitation; no new macOS/Linux result is claimed. See [implementation status](../docs/implementation/STATUS.md).

Entry: `index.html` and `main.tsx`. Runtime data comes from cookie-authenticated `/view`, `/rpc`, and worktree-scoped `/events`; no source-project path or task is hard-coded.

Browser gate: `node web/verify-browser.mjs <isolated-service-url[#code=...]>`. It checks five collapsed categories, closed Skill Hub, selected folder disclosure or an unmatched-directory overflow, camera controls, and zero retrieval RPCs during browsing. The initial behavioral RED was recorded against the frozen prototype before the formal entry was available.

For the root-created `harnessl3-browser-*` fixture only:

- `node web/verify-all.mjs <fixture.json>` runs the following three gates sequentially for CI or an independent smoke run. It appends generated Web tasks/preview receipts; the original fixture task IDs and fixed history remain unchanged. A temporary mutated skill copy is restored by the directory gate, including on failure.
- `node web/verify-fixture.mjs <fixture.json>` checks original and formal archives, explicit file previews, fixed history across a real commit, target races, camera anchors, touch, reduced motion and offline browsing. File previews create observation receipts and do not renew context retention.
- `node web/verify-manual.mjs <fixture.json>` creates Web tasks and exercises joint selection, context queries, committed-response loss and an explicit retry using the same request ID, and an empty selection.
- `node web/verify-directory.mjs <fixture.json>` changes only the canonical skill copy verified inside the fixture's data root, exercises automatic/manual directory updates, and restores the original bytes and catalog. It never edits repository skills.

These are Windows Edge/Chromium fixture checks, not a claim that native macOS/Linux acceptance has run. Build with `npm run build:web`.

`node scripts/v1/web-loading-smoke.mjs` creates its own isolated fixture and holds the first task view response across an SSE reset. It checks that the first request survives, only the loading state is visible until data arrives, and the correct task then appears with five closed categories and a closed Hub. Results and screenshots are saved under `.harness-local/validation/`.

`node --test tests/v1/web-projection.test.mjs` checks hit paths, unmatched aggregation, empty selections and archived skill groups using the formal layout modules. `node scripts/v1/web-matched-smoke.mjs` adds a clearly synthetic render payload of 10,000 unmatched context nodes and 10,000 unmatched skills to an isolated native fixture. It checks bounded canvas nodes, 50-row pages, search, folder scope, details, unavailable unselected archives, URL refresh/back/forward, camera preservation and mobile layout. Browsing must leave the native task unchanged. Reports and screenshots use `.harness-local/validation/matched-nodes-*`; these results do not establish a large-repository backend SLA.

Stable gates: `data-testid=app-shell/project-select/worktree-select/node-directory`, `data-category-root`, `data-map-depth`, `data-node-id`, `data-node-state`, `data-node-overflow`, `data-directory-row`, `data-skill-overflow`, `data-skill-selector`, `data-skill-folder`, `data-skill-id`, `data-skill-file`, `data-historical`, `data-task-id`, and `data-view-seq`. Status labels distinguish browser requests, CLI responses, references, unknown observations, and partial results.

Legacy projection is separate: original dot IDs, group, local source-version fields and file references remain original. Missing complete snapshots/C4 remain unknown; current model/catalog never fill those gaps.

## Recorded Windows verification, 2026-11-06

Executed on Windows Node 24.12.0 and headless Edge against the generated `harnessl3-browser-vJvUZH` fixture (port 62041). The service remained running. Repository skills, prototype sources, real task archives and the reference skill library were not edited. Session credentials were kept inside the test process and omitted from artifacts.

```text
npm run build:cli
npm run build:web
node web/verify-manual.mjs .harness-local/implementation-20261105/browser-fixture.json
node web/verify-directory.mjs .harness-local/implementation-20261105/browser-fixture.json
node web/verify-fixture.mjs .harness-local/implementation-20261105/browser-fixture.json
```

Both builds exited 0. Actual manual-write result:

```json
{"taskId":"32f6d427-f642-4fe2-aa03-b8b3bf6b8502","emptyTaskId":"883c15d7-5930-46c0-9e24-ba48514d6676","createdBy":"web","selection":"directory+two-bodies+three-explicit-skill-reasons","nextQuery":"two-targets-with-retained-known","retry":"same-id-after-committed-response-loss","batches":3,"emptySelection":"zero-body-no-false-object-return","pageErrors":[]}
```

The first selection returned two exact bodies, a direct directory and three explicitly chosen quality skills. All three batches retained `source=web`. A real commit followed by an injected lost HTTP response left the action error visible through background refresh. One manual retry reused the request ID, created no duplicate batch and retained the first body byte-for-byte. The empty task retained `lastReadAt=null` and zero object hits.

Actual directory lifecycle result:

```json
{"canonicalCopyInsideFixture":true,"directory":["automatic-add","automatic-body-edit","automatic-category-rename","automatic-delete","invalid-clears-candidates","manual-invalid-refresh","manual-recovery"],"oldPlan":"original-group-and-bytes","sourceEpoch":{"before":0,"after":0},"restoredCatalogRevision":true,"pageErrors":[]}
```

The canonical skill copy was resolved and verified inside the fixture data root before any mutation. Invalid frontmatter cleared candidates and appeared as text in details. A renamed/edited `quality` group did not change a fixed task's original group or archived `SKILL.md` bytes. Source status remained `clean` with the same real source-tree and scan-policy fingerprints; the final catalog revision matched the initial revision.

Final complete browse result after the builds:

```json
{"results":[{"categories":5,"initialChildren":0,"hub":"folder-first","browsingDisclosures":0},{"canvasAnchor":"fixed-on-expansion","collapsedDescendants":"hidden-and-restored"},{"nativeSkills":"folder→skill→file→explicit-archived-preview","contextReadUnchanged":true},{"legacy":["original-dot-hierarchy","original-group","original-file-bytes","original-c4"]},{"historyBatch":"fixed-across-real-commit","retentionBasis":"unchanged"},{"targetIsolation":["late-old-response-ignored","old-task-options-cleared","project-worktree-switch"]},{"phone":["390x844","one-finger-pan","two-finger-zoom","reduced-motion","offline-disclosure","same-origin-resources"]}],"pageErrors":[]}
```

Screenshots: `validation/formal-overview.png`, `validation/mobile-overview.png`, `validation/legacy-c4.png`. Phone checks used touch emulation; they do not claim a physical-device or Safari run. Offline checks cover the already loaded canvas and local-only resources, not a service-worker cold load. Native macOS/Linux results are tracked by the main implementation verification separately.

## Windows temporary-path alias reproduction

`node web/verify-temp-alias.mjs` creates an owned Windows temporary directory and a junction alias, runs the unchanged `scripts/v1/browser-smoke.mjs` with both `TEMP` and `TMP` pointing through that alias, then removes the alias and its verified owned target. It saves redacted output to `validation/temp-alias-browser-win32.json`; use `BROWSER_CHANNEL=chromium` when the Playwright browser is installed.

Actual 2026-11-06 result on Node 24.12.0 and Edge 156.0.4314.58:

```json
{"platform":"win32","node":"v24.12.0","browserChannel":"msedge","tempIsAlias":true,"exitCode":0,"stdout":"{\"platform\":\"win32\",\"browser\":\"156.0.4314.58\",\"gates\":3,\"eventDisplaySamples\":3,\"p50\":1397,\"p95\":1701}\n","stderr":""}
```

The child descriptor retained the raw junction path while directory guards compared canonical paths. The existing fixture and all three browser gates passed without modification. This did not reproduce the Windows CI Chromium failure, and does not establish that CI passed. Production Web/backend code stayed frozen.

## CRLF archive verification regression

The locked Playwright 1.64.0 browser was installed into the absolute cache `I:\AI\HarnessL3\.harness-local\tools\playwright` with `npx --no-install playwright install chromium`. It downloaded Chromium/headless-shell 156.0.8078.4 revision 1248, FFmpeg 1013 and the Winldd 1007 helper; no system dependency installation or browser-setting change was performed.

The original LF seed also passed the complete junction-alias smoke using Chromium 156.0.8078.4. An explicit CRLF seed then reproduced the Windows failure: the old directory assertion compared a textarea's LF display value with raw CRLF bytes. The failed assertion was `old plan returns its original bytes despite directory rename/edit`; this was a display-comparison error, not evidence of archive corruption.

`createBrowserFixture({crlfSeed:true})`, or `HARNESS_TEST_BROWSER_CRLF_SEED=1`, now prepares that regression case. After CLI init and before any task starts, it resolves and checks the owned fixture/data/skill boundaries, rejects child links, converts only the generated skill copy's Markdown files to CRLF, and refreshes the catalog. Repository skills and user libraries are never converted.

The corrected gate checks two distinct boundaries. The textarea is compared using HTML newline normalization. The actual `task read` API response is independently compared byte-for-byte with the original CRLF fixture, checked against the fixed task's original SHA-256 reference, and checked for both reported and actual byte length. Normalizing the visual value cannot hide changed archive bytes.

Actual Windows regression command, 2026-11-06:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = 'I:\AI\HarnessL3\.harness-local\tools\playwright'
$env:BROWSER_CHANNEL = 'chromium'
$env:HARNESS_TEST_BROWSER_CRLF_SEED = '1'
node web/verify-temp-alias.mjs
```

The original assertion exited 1. After the verification-only fix, the same configuration exited 0 with empty stderr, all three browser gates and three commit/display samples (P50 1156 ms, P95 1361 ms). The directory result was:

```json
{"canonicalCopyInsideFixture":true,"directory":["automatic-add","automatic-body-edit","automatic-category-rename","automatic-delete","invalid-clears-candidates","manual-invalid-refresh","manual-recovery"],"oldPlan":"original-group-and-bytes","originalArchivedBytesExact":true,"archivedLineEndings":"crlf","sourceEpoch":{"before":0,"after":0},"restoredCatalogRevision":true,"pageErrors":[]}
```

All three gates reported no page errors; owned temporary junctions and targets were removed. Redacted RED/GREEN reports are `validation/temp-alias-browser-win32-chromium-crlf-red.json` and `validation/temp-alias-browser-win32-chromium-crlf-green.json`; the complete successful smoke report is `.harness-local/validation/browser-win32.json`. This local result does not substitute for a subsequent CI run.
