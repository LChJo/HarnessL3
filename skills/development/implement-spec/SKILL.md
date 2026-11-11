---
name: implement-spec
description: Implement a whole agreed spec and its dependency-linked tickets. Use when the user requests the complete build rather than one ticket; parallel workers are optional and require actual support and authorization.
---

> Apply this method within the target project's rules and task authorization. Selecting or reading it does not execute commands or grant additional permissions.

The goal is the complete spec implemented and verified on the confirmed target. Tickets form a **task graph**, not a flat list: a **frontier** ticket has no unfinished blockers. For an agreed Git integration workflow, land the result on its integration branch; an ordinary directory can implement the same graph without creating Git.

1. Read the spec and every ticket, resolve their real blocking relationships, and confirm the target directory/worktree and acceptance criteria. Use the project's existing local artifacts or configured tracker; missing hosted setup is not a prerequisite failure.
2. Select frontier tickets. Execute sequentially unless independent workers and their write scopes are supported and authorized. Each concurrent writer needs its own confirmed isolated worktree/branch or equivalent project isolation. Use existing targets; create branches/worktrees only within explicit authorization. Never reset a worker's target to force agreement.
3. Give each authorized worker a fresh context window, the minimum explicit L3 handoff, the spec/ticket references, target/base and its acceptance criteria. Read pointers rather than duplicating the conversation. Exploration is optional; any retained research gets a stable shared location and evidence pointers.
4. Implement one ticket against its agreed public interfaces. Use a failing behavior check when warranted, then the smallest passing change; run the project's actual required checks. Review both documented standards and the ticket's requirements before declaring that ticket ready. A skill name is not an already-read dependency.
5. Integrate completed work only through the agreed workflow. Check the actual base and current integration tip before a merge, resolve conflicts within scope, and rerun affected checks. Staging, commits, merges and tracker writes require their actual authorization. Record outcomes accurately when a publication step remains pending.
6. Recompute the frontier after each completion. Keep failed or blocked tickets unresolved and hold their descendants; continue independent authorized tickets when useful. A started worker or accepted write request is not proof of completion; recover uncertain operations through their original receipt before retrying.
7. Once every ticket's behavior is complete, review the entire result separately against the spec and the repository's standards, then resolve material findings and run the required integrated checks. Report the confirmed target, completed work, evidence and remaining publication steps.
8. Maintain retained spec/ticket/model/evidence links in the same phase, preserving entity identities and archived history. Close tracker work or publish/advance a PR only when that operation is authorized. A draft PR requires an actual ahead-of-base change; it is optional unless the agreed tracker workflow needs one. Clean up only task-owned worktrees or artifacts whose deletion is authorized and whose evidence pointers are preserved.

Completion means every acceptance criterion is implemented and checked, integration state is known, and failures or pending external actions are explicitly accounted for. Selecting this method does not start another agent or automate the task graph inside HarnessL3.
