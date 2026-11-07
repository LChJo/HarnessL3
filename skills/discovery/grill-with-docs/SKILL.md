---
name: grill-with-docs
description: Combine an interview with maintaining domain terms and design decision records in the project's existing documentation. Use when both unresolved choices and durable documentation need work; use grilling for a plain interview.
---

> Apply this method within the target project's rules and task authorization. Selecting or reading it does not execute commands or grant additional permissions.

Explore the project's actual files before asking about facts. Walk the unresolved design decisions and their dependencies one question at a time; provide a recommendation and wait for the user's answer before depending on it. Reuse decisions already confirmed.

As answers land, record the resolved domain terms and design decisions in the project's existing authoritative model, glossary or ADRs. Preserve the term's meaning, the decision's rationale and relevant alternatives; keep unanswered choices explicitly unresolved. Do not create a second knowledge store merely to use this method.

When confirmed answers change retained project documents, maintain their current context/evidence references in the same phase. Reuse the project's authority and retention/Git conventions rather than introducing a second glossary or decision store.
