---
name: Branch state for reviews
description: Biblicana has two branches with different conventions — review expectations differ
type: project
---

Biblicana has two active branches with different module systems and deps:
- `main` — CommonJS, npm, deployed to prod (457 servers), 22 commands, RapidAPI-heavy
- `refactor` — ESM (`"type": "module"`), pnpm, 26 commands, local SQLite replacing most RapidAPI calls

**Why:** Code-review reports should not flag CommonJS-vs-ESM as a bug without first checking which branch the file is on. Likewise, deps/vulnerability counts diverge.

**How to apply:** When reviewing, confirm the branch (`git branch --show-current`) before evaluating module syntax, package.json shape, or which RapidAPI endpoints are "still used". On `refactor`, local SQLite wrappers live in `src/utils/studyHelper.js` and are the current source of truth for dictionary/crossref/topicalindex/commentary; on `main` those commands still hit RapidAPI.
