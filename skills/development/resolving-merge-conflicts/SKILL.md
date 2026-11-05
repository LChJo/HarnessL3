---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
---

> Skill Hub file reference: use this method under the target project's rules and task authorization; selecting or reading it runs no command or workflow. Linked methods are optional candidates, not automatic selections or archives; [maintenance notes](../../FILE-REFERENCES.md) are optional current-library guidance, and unprovided files or capabilities must be checked.

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, use the merge's stated goal and note the trade-off; unresolved intent remains explicit. Do **not** invent new behaviour or abort/restart an operation merely to hide conflicts. If resolution is blocked, keep the real state and explain what decision is missing.

4. Discover the project's **automated checks** and run them — typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Complete the authorized operation.** If finishing this merge/rebase is in scope, stage only its intended files and continue according to the project's rules. Do not stage unrelated work or assume a commit/branch operation is authorized by selecting this file. Otherwise leave the reviewed resolution ready and report the pending operation.
