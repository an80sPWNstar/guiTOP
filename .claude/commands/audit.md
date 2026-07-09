# Security & Quality Audit

Run a thorough audit of the guiTOP codebase. Read CLAUDE.md ONCE if not already in context.

Focus area (optional): $ARGUMENTS

## Token budget rules (non-negotiable)
- Each review agent gets: the specific files to review and what to look for. Not the entire codebase.
- Use Glob to identify source files first, then split them across agents by module.
- Agents return: file path, line number, issue description, severity. One line per finding. No essays.
- Only verify findings that look plausible — don't re-read every file an agent touched.

## Process
1. **Scope the audit** — Glob/Grep to identify all source files. Group by module.
2. **Fan out review agents** (parallel, one per dimension):
   - **Security** — shell injection in the SSH/exec layer, unsafe handling of nvidia-smi output, path traversal, input validation gaps (host config), dependency issues, hardcoded secrets/credentials, CSP/contextIsolation regressions
   - **Code quality** — complexity, dead code, unclear naming, bloated files, pointless abstractions
   - **Architecture** — deviations from CLAUDE.md structure, coupling, core logic in UI layer, broken interfaces, error isolation between hosts
3. **Verify** — read flagged files only at the reported line ranges. Discard false positives.
4. **Report** — confirmed issues as a flat list: `severity | file:line | description`. No prose.
5. **Fix critical security issues immediately.** Present everything else as a list and ask before changing.
