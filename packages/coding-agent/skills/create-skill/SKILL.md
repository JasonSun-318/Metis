---
name: create-skill
description: Create or update a Metis Skill when the user asks for a reusable workflow, domain guide, or capability that should be stored as a Skill.
---

# Create a Skill

Create the smallest complete Skill that matches the user's real examples.

## 1. Clarify the behavior

Before writing files, establish:

- The job the Skill must perform, with concrete example requests.
- Requests that should and should not trigger it.
- Whether it should trigger automatically or only when explicitly selected.
- Whether it is a user Skill or a project Skill.
- For a project Skill, the explicit target project directory.

In the first reply, ask only for the Skill's job, concrete example requests, requests that should not trigger it, and whether it should trigger automatically or only when explicitly selected. Do not ask the user to design frontmatter or choose resource folders; derive those later from the confirmed behavior. Ask only when missing information would materially change the result.

## 2. Choose the scope

- Project Skill: `<target project directory>/.metis/skills/<name>/SKILL.md`
- User Skill: `<METIS_CODING_AGENT_DIR>/skills/<name>/SKILL.md` when that existing environment variable is set; otherwise `~/.metis/agent/skills/<name>/SKILL.md`

Use a project directory already stated by the user as the target. If project scope is requested without an explicit target project directory, ask for it before writing files. Never create or change `METIS_CODING_AGENT_DIR`. Never create a system Skill.

Name the folder and Skill with lowercase letters, digits, and hyphens only. Keep the name under 64 characters and prefer a short verb-led name.

## 3. Choose invocation behavior

For automatic invocation, use only:

```yaml
---
name: example-skill
description: State what the Skill does and the requests or contexts that should trigger it.
---
```

For manual-only invocation, add:

```yaml
disable-model-invocation: true
```

Do not add unsupported frontmatter such as `license`, `compatibility`, `metadata`, or `allowed-tools`.

## 4. Decide required resources

Evaluate each resource type from the confirmed examples:

- `scripts/`: include only deterministic or repeatedly rewritten executable logic.
- `references/`: include only detailed knowledge that should be loaded on demand.
- `assets/`: include only templates or files copied into final outputs.

Create no empty directories or placeholder files. Do not add README, installation, quick-reference, or changelog files. Keep detailed information in one place and link every required resource directly from `SKILL.md`.

## 5. Implement and validate

1. Create and test required resource files first.
2. Write `SKILL.md` last with the built-in `write` or `edit` tool so Metis reloads the Skill.
3. Inspect the appended reload diagnostics. Fix naming, YAML, description, and collision problems before finishing.
4. Verify every path referenced by `SKILL.md` exists and stays inside the Skill folder.
5. Run syntax checks and one representative functional smoke test for every generated script.
6. Confirm the Skill is discovered under the intended scope and its trigger description matches the agreed positive and negative examples.

Keep `SKILL.md` concise, imperative, and focused on knowledge the model would not reliably infer itself.
