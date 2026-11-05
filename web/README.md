# Formal Web integration

The approved Slate canvas is preserved here. `src/` remains the frozen prototype reference.

Entry: `index.html` and `main.tsx`. Runtime data comes from cookie-authenticated `/view`, `/rpc`, and worktree-scoped `/events`; no source-project path or task is hard-coded.

Browser gate: `node web/verify-browser.mjs <isolated-service-url[#code=...]>`. It checks five collapsed categories, closed Skill Hub, folder-first disclosure, camera controls, and zero retrieval RPCs during browsing. The initial behavioral RED was recorded against the frozen prototype before the formal entry was available.

For the root-created `harnessl3-browser-*` fixture only:

- `node web/verify-all.mjs <fixture.json>` runs the following three gates sequentially for CI or an independent smoke run. It appends generated Web tasks/preview receipts; the original fixture task IDs and fixed history remain unchanged. A temporary mutated skill copy is restored by the directory gate, including on failure.
- `node web/verify-fixture.mjs <fixture.json>` checks original and formal archives, explicit file previews, fixed history across a real commit, target races, camera anchors, touch, reduced motion and offline browsing. File previews create observation receipts and do not renew context retention.
- `node web/verify-manual.mjs <fixture.json>` creates Web tasks and exercises joint selection, context queries, committed-response loss and an explicit retry using the same request ID, and an empty selection.
- `node web/verify-directory.mjs <fixture.json>` changes only the canonical skill copy verified inside the fixture's data root, exercises automatic/manual directory updates, and restores the original bytes and catalog. It never edits repository skills.

These are Windows Edge/Chromium fixture checks, not a claim that native macOS/Linux acceptance has run. Build with `npm run build:web`.

Stable gates: `data-testid=app-shell/project-select/worktree-select`, `data-category-root`, `data-map-depth`, `data-node-id`, `data-node-state`, `data-skill-selector`, `data-skill-folder`, `data-skill-id`, `data-skill-file`, `data-historical`, `data-task-id`, and `data-view-seq`. Status labels distinguish browser requests, CLI responses, references, unknown observations, and partial results.

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
