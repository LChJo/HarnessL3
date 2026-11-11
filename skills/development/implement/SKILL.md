---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
---

> Apply this method within the target project's rules and task authorization. Selecting or reading it does not execute commands or grant additional permissions.

Implement the work described by the user in the spec or tickets. If the user supplies a ticket reference, read it through the project's configured tracker or local artifact store and state its title before starting. Resolve a material ambiguity before implementing; a missing hosted tracker does not require setup when the ticket exists locally.

Where useful, reproduce the required behavior with a failing test at the task's agreed test seam, then implement the smallest passing change. Reuse decisions already made instead of requesting the same approval again.

Discover the project's actual checks. Run focused tests and typechecking while making changes, then the required checks at the end; report only commands actually run.

Once done, check the change against the originating spec and the repository's documented standards in separate passes when useful, and resolve material findings within scope.

Report the resulting changes, verification and remaining risks. Commit only when the task or established project rules authorize it, and only in the confirmed target worktree/branch; selecting this file does not itself authorize a commit.

Before closing the phase, keep affected retained specs, task documents and context/evidence references consistent with the actual implementation. Record the checked scope when no knowledge change is needed; preserve archived task history.
