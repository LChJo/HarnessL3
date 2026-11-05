---
name: research
description: Investigate a question against high-trust primary sources and capture cited findings in the project's existing research location. Use when the user needs research, documentation or API facts; a background agent is optional.
---

> Skill Hub file reference: use this method under the target project's rules and task authorization; selecting or reading it runs no command or workflow. Linked methods are optional candidates, not automatic selections or archives; [maintenance notes](../../FILE-REFERENCES.md) are optional current-library guidance, and unprovided files or capabilities must be checked.

Investigate in the current agent. If the host supports background agents and the task authorizes delegation, a separately scoped reader may do this work while other work continues; otherwise keep the same research method without pretending another agent ran.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
