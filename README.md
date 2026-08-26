# Agent Skills

A collection of reusable skills for AI agents. Skills provide procedural knowledge that helps agents accomplish specific tasks more effectively.

Compatible with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Cursor](https://cursor.sh), [Windsurf](https://windsurf.com), [GitHub Copilot](https://github.com/features/copilot), and [other supported agents](https://skills.sh).


## Available Skills

| Skill | Description |
|-------|-------------|
| [code-review](./code-review/SKILL.md) | Review code changes for bugs, security issues, performance problems, and best practice violations. |
| [create-new-skill](./create-new-skill/SKILL.md) | Create new agent skills with proper structure, progressive disclosure, and bundled resources. |
| [session-roast](./session-roast/SKILL.md) | Roast and grade a coding-agent session for token efficiency across Claude Code, Codex, and Cursor. |
| [tdd](./tdd/SKILL.md) | Test-driven development workflow. Write the test first, watch it fail, write minimal code to pass. |


## Install a Skill

Install skills using the [skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add mokhovyk/skills
```

This will install all skills from this repository and make them available to your AI agent.

### Source Formats

```bash
# GitHub shorthand (owner/repo)
npx skills add mokhovyk/skills

# Full GitHub URL
npx skills add https://github.com/mokhovyk/skills

# Direct path to a skill in a repo
npx skills add https://github.com/mokhovyk/skills/tree/main/tdd

# Any git URL
npx skills add git@github.com:mokhovyk/skills.git
```

### Options

| Option                    | Description                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-g, --global`            | Install to user directory instead of project                                                                                                       |
| `-a, --agent <agents...>` | <!-- agent-names:start -->Target specific agents (e.g., `claude-code`, `codex`). See [Available Agents](#available-agents)<!-- agent-names:end --> |
| `-s, --skill <skills...>` | Install specific skills by name (use `'*'` for all skills)                                                                                         |
| `-l, --list`              | List available skills without installing                                                                                                           |
| `--copy`                  | Copy files instead of symlinking to agent directories                                                                                              |
| `-y, --yes`               | Skip all confirmation prompts                                                                                                                      |
| `--all`                   | Install all skills to all agents without prompts                                                                                                   |

### Examples

```bash
# List skills in a repository
npx skills add mokhovyk/skills --list

# Install specific skills
npx skills add mokhovyk/skills --skill tdd --skill code-review

# Install to specific agents
npx skills add mokhovyk/skills -a claude-code -a opencode

# Non-interactive installation (CI/CD friendly)
npx skills add mokhovyk/skills --skill tdd -g -a claude-code -y

# Install all skills from a repo to all agents
npx skills add mokhovyk/skills --all

# Install all skills to specific agents
npx skills add mokhovyk/skills --skill '*' -a claude-code

# Install specific skills to all agents
npx skills add mokhovyk/skills --agent '*' --skill tdd
```

### Installation Scope

| Scope       | Flag      | Location            | Use Case                                      |
| ----------- | --------- | ------------------- | --------------------------------------------- |
| **Project** | (default) | `./<agent>/skills/` | Committed with your project, shared with team |
| **Global**  | `-g`      | `~/<agent>/skills/` | Available across all projects                 |

### Installation Methods

When installing interactively, you can choose:

| Method                    | Description                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| **Symlink** (Recommended) | Creates symlinks from each agent to a canonical copy. Single source of truth, easy updates. |
| **Copy**                  | Creates independent copies for each agent. Use when symlinks aren't supported.              |

