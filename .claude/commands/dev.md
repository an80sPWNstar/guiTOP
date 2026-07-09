# guiTOP Development Orchestrator

You are orchestrating work on the guiTOP project. Read CLAUDE.md ONCE at the start — do not re-read it if already in context.

The user's request: $ARGUMENTS

## Token budget rules (non-negotiable)
- Do NOT re-read files already in your context window
- Do NOT spawn a sub-agent for something you can do yourself in under 30 seconds
- Do NOT tell sub-agents to "read CLAUDE.md for full context" — paste them ONLY the specific details they need (tech stack, file paths, the one relevant standard)
- Sub-agent prompts: state the task, the target files, and the constraints. Nothing else.
- Sub-agent / local-model responses: return ONLY what changed (file paths + what they did). No essays.
- Your own responses: short and direct. No restating the request, no summaries unless asked.

## Delegate to the local model first
guiTOP delegates well-scoped coding to the local model (Qwen3.6 on :8080) to save Claude tokens.
- Use `scratchpad/ask_local.py` (thinking OFF by default). Give it the exact I/O spec + real example data; keep each task within ~700 output tokens.
- Self-contained units (a parser, one widget, one pure function) → local model. Wiring, architecture, integration, and verification → you.
- NEVER ship local-model output unverified. Execute/test it. Watch for: over-engineering, shadowing built-ins (e.g. `parseInt`), truncation at the token cap.

## How to work
1. **Understand the request** — check what's already in your context. Only read files you haven't seen.
2. **Break it down** — split into independent pieces that can run in parallel where possible.
3. **Delegate** — local model for self-contained code; Agent tool (Explore/Plan/general-purpose) for search/design/multi-step. Each gets ONLY the context it needs, exact file paths, and the specific standards that apply.
4. **Parallelize independent work** — spawn agents in a single message so they run concurrently.
5. **Verify after completion** — read/execute the actual files. Summaries describe intent, not what happened.
6. **Security check** — after any code change, review for input validation, path traversal, shell injection in the SSH/exec layer, unsafe handling of nvidia-smi output. Fix immediately if found.

## Rules
- Never write bloated or over-abstracted code
- Never skip reading/executing files before trusting them
- Never trust agent/local-model summaries without verifying the actual changes
- Never add dependencies without checking them for known vulnerabilities
- Always follow the architecture in CLAUDE.md
- After code changes, verify JS with `node --check <file>` (and run the app when feasible) to catch errors
- Never re-read a file that's already in context
- Never spawn more agents than there are distinct independent tasks
