---
name: use-uvx
description: Instructs the agent to use uvx for running arbitrary Python packages instead of pip or python -m. Use when the user asks to run a Python package or when you need to use Python tools like agentskills.
license: MIT
---

# Use UVX for Python Packages

## When to Use This Skill

Use this skill when you need to:
- Run arbitrary Python packages or tools (like `skills-ref`, `agentskills`, `black`, `ruff`, etc.)
- Understand how to execute Python scripts that require third-party dependencies.

## Instructions

1. **Understand Environment Limitations:** This environment is managed by Nix. Global Python environments cannot be modified using `pip`. You **MUST NOT** use `pip`, `pipx`, or `python3 -m pip`.
2. **Use UVX:** Instead, use `uvx` (or `uv run`) which provides ephemeral execution of Python tools without touching global state.
3. **Execute Packages:**
   - To run a package directly without installing it globally, use `uvx <package-name> [args...]`.
   - If the package executable name differs from the package name, use the `--from` flag: `uvx --from <package-name> <executable-name> [args...]`.
4. **Execute Scripts with Dependencies:**
   - Use `uv run` to run a script with dependencies: `uv run --with <dependency1> --with <dependency2> python script.py`.

## Examples

**Example 1: Running agentskills validate**
Instead of `python3 -m pip install -q skills-ref && python3 -m agentskills validate <path>`, run:
```bash
uvx agentskills validate <path>
```

**Example 2: Running a script with requests**
```bash
uv run --with requests python fetch_data.py
```
