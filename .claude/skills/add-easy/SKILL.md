---
name: add-easy
description: Add Easy domain modeling tool to this project. Use when the user says "add easy", "install easy", "add modeling", or wants to design their domain model.
allowed-tools: Read, Bash, Edit, Write, WebFetch
---

# Add Easy

Add the [Easy](https://github.com/blueshed/easy) domain modeling tool to this Simple project.

## Steps

1. In `compose.yml`, uncomment the `easy` and `plantuml` services (they are already present as comments)

2. Add `model.db` to `.gitignore` if not already there

3. Fetch the modeling skill from the Easy repo and write it into this project:
   - Fetch `https://raw.githubusercontent.com/blueshed/easy/refs/heads/main/.claude/skills/model-app/SKILL.md`
     Write to `.claude/skills/model-app/SKILL.md`
   - Fetch `https://raw.githubusercontent.com/blueshed/easy/refs/heads/main/.claude/skills/model-app/reference.md`
     Write to `.claude/skills/model-app/reference.md`

4. Tell the user:

```
Easy is ready. Run:

  bun run up

Then model your domain:

  bun model add-entity User
  bun model add-field User id number
  bun model add-field User name string
  bun model add-field User email string

Browse the model site at http://localhost:8080

When your model is complete, export and implement:

  bun model export-spec > spec.md
  /implement

The /model-app skill is now available for AI-driven modeling.
```

## Rules

- Only uncomment the existing commented-out services — do not add new YAML from scratch
- Do not start or restart Docker services
- Do not modify any files other than compose.yml, .gitignore, and the skill files
- Create the `.claude/skills/model-app/` directory if it doesn't exist
- Fetch skill files exactly as they are upstream — do not modify their content
