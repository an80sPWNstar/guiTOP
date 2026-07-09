# Build Phase Executor

Execute a specific build phase of the guiTOP project. Read CLAUDE.md ONCE at the start if not already in context.

Phase to execute: $ARGUMENTS

## Token budget rules (non-negotiable)
- Read CLAUDE.md once. Do not re-read it.
- Assess current state with Grep/Glob, not by spawning Explore agents for simple checks.
- Sub-agent / local-model prompts include ONLY: the task, target file paths, and relevant constraints. No full project dumps.
- Instruct them to return only what they created/changed — file paths and a one-line summary per file.
- Do not spawn agents for trivial file creation you can do inline.

## Process
1. **Check current state** — use Glob/Grep to see what exists. Only read files you haven't seen. Don't rebuild what's done.
2. **Plan the phase** — if the phase has 3+ independent pieces, spawn a Plan agent with the specific phase details. For simpler phases, plan inline.
3. **Implement** — delegate self-contained code to the local model (`scratchpad/ask_local.py`, thinking OFF); fan out Agent-tool sub-agents in parallel for independent modules:
   - One worker per distinct module/concern
   - Each gets: exactly what to build, target file paths, and only the standards that apply
   - Each returns: file paths created/modified + one-line summary each
4. **Verify** — read changed files; run `node --check` on JS; execute local-model output before trusting it; run the app when feasible. Security-review every file handling external input (nvidia-smi output, SSH, host config).
5. **Report** — what was built (file list), verify status, next phase. Three to five lines max.

## Rules
- Each phase must leave the project in a runnable state
- No stubbed-out methods or TODO placeholders — either implement it or don't add it
- Follow project structure from CLAUDE.md exactly
- Security review every file that handles external input
- Never re-read files already in context
- Never spawn agents for work you can do inline in under 30 seconds
