---
name: create-skill
description: Create or modify Agent Skills. Use when the user wants to create a new skill, edit an existing skill (including updating its description, name, instructions, or any frontmatter field), restructure a skill, or package a skill for sharing.
---

# Create Skill

This skill helps you create new Agent Skills that follow the agentskills.io specification.

## When to Use This Skill

Use this skill when the user asks you to:

- Create a new skill or capability
- Package instructions into a reusable format
- Set up a skill directory

## Agent Skills Format

An Agent Skill is a directory containing a SKILL.md file. Skills can also bundle additional resources alongside SKILL.md:

```
my-skill/
├── SKILL.md            (required)
├── scripts/            (optional) executable scripts for repetitive tasks
├── references/         (optional) documentation loaded into context as needed
└── assets/             (optional) templates, icons, or other output files
```

For simple skills, only SKILL.md is needed. Add bundled resources when the skill involves repetitive scripting work, large reference documentation, or reusable templates — things that would otherwise be recreated from scratch on every invocation.

**Keeping SKILL.md manageable:** Aim to keep SKILL.md under 500 lines. If it's growing large, move detailed content into `references/` files and link to them from SKILL.md with a note on when to read each one. This keeps the core instructions readable without losing depth.

## SKILL.md Structure

SKILL.md consists of two parts: a YAML frontmatter block at the top (delimited by `---`), followed by the markdown body.

```
---
name: my-skill
description: A clear description of what this skill does and when to use it.
license: (optional)
compatibility: Any environment requirements (optional)
metadata: (optional)
  author: your-name
  version: '1.0'
---

# Skill Title

## When to Use This Skill

Describe the scenarios where this skill should be applied.

## Instructions

Step-by-step instructions for the agent to follow.

## Examples

Include examples of inputs and expected outputs.
```

### Frontmatter Requirements

**Required fields:**

- **name:** 1-64 characters, lowercase alphanumeric and hyphens only
  - Must match the directory name exactly
  - Cannot start or end with hyphens
  - No consecutive hyphens allowed
  - Valid examples: `pdf-processing`, `code-review`, `data-analysis`
  - Invalid examples: `-my-skill`, `my--skill`, `My_Skill`

- **description:** 1-1024 characters describing:
  - What the skill does
  - When it should be used (important for agent discovery)
  - Should include specific keywords and trigger phrases
  - Example: "Use when the user mentions PDFs, forms, or document extraction" is better than "Helps with PDFs"

**Optional fields:**

- **license:** Licensing terms (e.g., MIT, Apache-2.0)
- **compatibility:** Environment requirements, max 500 characters
- **metadata:** Key-value pairs for additional information
- **allowed-tools:** Space-delimited list of pre-approved tools (experimental)

## Instructions for Creating a New Skill

1. **Understand the requirement:** Ask the user what the skill should accomplish and when it should be used.

2. **Choose a name:** Pick a descriptive, lowercase name with hyphens for word separation.

3. **Write a clear description:** This is crucial for skill discovery. Include:
   - What the skill does
   - Keywords and trigger phrases that help identify when to use it
   - Be specific and detailed (up to 1024 characters allowed)

4. **Create comprehensive instructions:** Write clear, step-by-step guidance that another agent can follow.

5. **Create the skill directory and file:**
   - Create directory: `{skills_dir}/{skill-name}/`
   - Create file: `{skills_dir}/{skill-name}/SKILL.md` (must be named exactly `SKILL.md`)
   - **CRITICAL:** When you write SKILL.md, the very first characters must be `---`. No title, description, or other content before the frontmatter.

6. **Validate the skill:** After creating all relevant files, validate using the skills-ref library. Do NOT validate until you have finished preparing all files. Pass the skill directory (not a single file or ZIP) to the validate command:

   ```bash
   pip install -q skills-ref && agentskills validate {skills_dir}/{skill-name}/
   ```

   If validation fails, read the error message and fix before proceeding.

7. **Prepare for sharing:** A skill must be shared as a single file — never as a directory path. List the contents of the skill directory first to understand skill contents.
   - If the skill directory contains a SKILL.md only and has no other bundled resources, share the SKILL.md file directly
   - If the skill has any bundled resources (scripts, references, assets): zip the entire skill directory. Do NOT extract just the SKILL.md — the bundled files are part of the skill. Use `.zip` format, not `.tar` or `.tar.gz`

8. **Inform the user:** Let the user know the skill has been created and validated successfully, and they can download it for use or manage it via their settings at https://www.perplexity.ai/computer/skills.

## Example: Creating a Code Review Skill

If asked to create a code review skill:

```
---
name: code-review
description: Review code for bugs, security issues, and best practices. Use when asked to review, audit, or check code quality.
license: MIT
---

# Code Review Skill

## When to Use This Skill

Use this skill when the user asks you to:

- Review code for issues
- Check code quality
- Audit for security vulnerabilities
- Suggest improvements to existing code

## Instructions

1. Read the code file(s) to be reviewed
2. Analyze for:
   - Logic errors and bugs
   - Security vulnerabilities (injection, XSS, etc.)
   - Performance issues
   - Code style and readability
   - Missing error handling
3. Provide feedback organized by severity (critical, warning, suggestion)
4. Include specific line references and suggested fixes
```

## Common Errors

**Error: "SKILL.md must start with YAML frontmatter (---)"**

This means the file doesn't start with `---` on line 1. The very first character must be the opening frontmatter delimiter.

- ❌ Wrong: Starting with title `# My Skill` before `---`
- ❌ Wrong: Blank lines before `---`
- ✅ Correct: File starts immediately with `---`

**Error: Invalid name format**

The name field has strict validation:

- Must be 1-64 characters
- Lowercase letters, numbers, and hyphens only
- Cannot start or end with hyphen
- No consecutive hyphens (`--`)
- Must match the directory name exactly

**Error: "Unexpected fields in frontmatter"**

Only these fields are allowed at the top level of frontmatter: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Any other top-level field will fail local validation via `agentskills validate`. Note: this is enforced by the local validator, not the server — but since step 6 runs local validation before uploading, the skill must pass this check.

If you need custom key-value data, nest it under `metadata`:

- ❌ Wrong: `version: '1.0'` as a top-level frontmatter field
- ✅ Correct:
  ```yaml
  metadata:
    version: '1.0'
  ```
