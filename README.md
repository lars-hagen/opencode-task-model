# opencode-task-model

An [opencode](https://opencode.ai) plugin that lets you run synchronous or background subagents on a model you choose **per call**, in the current session, without restarting opencode or hardcoding `model:` in each agent's `.md`.

opencode resolves plugin tools ahead of built-ins with the same name, so the agent sees a single `task` tool: native-shaped, plus per-call `model` and `reasoning` controls. Use `inherit` and `default` to keep native model-selection precedence.

## Why

The built-in `task` tool resolves the subagent model from the agent's frozen config (or inherits the parent model) and exposes no per-call model argument, and its `execute` is compiled into core so the arg cannot be bolted on. This plugin reimplements the spawn via the client API (`session.create` + `session.prompt`), where `model`, `agent`, and `variant` are set explicitly. With `model: "inherit"`, the child uses native model precedence.

## Install

```sh
opencode plugin --global opencode-task-model@latest
```

This installs the package and adds it to your global `opencode.json`'s `plugin` array for you. `--global` puts it in your user config so every project picks it up; drop it to install into the current project only. `@latest` tracks the newest release instead of freezing the version at install time. Or add it by hand:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-task-model@latest"]
}
```

Either way, opencode installs it with Bun on startup and caches it under `~/.cache/opencode/node_modules/`. Because it overrides the built-in `task` tool, no further wiring is needed: every agent that already uses `task` picks up the `model`/`reasoning` args automatically.

### Local development

To hack on it, clone the repo into a plugin directory opencode auto-loads (`~/.config/opencode/plugins/` for global, `.opencode/plugins/` for a project) and it loads on the next start:

```sh
git clone https://github.com/lars-hagen/opencode-task-model.git \
  ~/.config/opencode/plugins/opencode-task-model
```

## Usage

The tool signature (drop-in superset of native `task`):

```
task(subagent_type, description, prompt, task_id, model, reasoning)
```

- `subagent_type` — the subagent to run (e.g. `explore`, `general`, `review`, `design`)
- `description` — short task description, used as the child session title
- `prompt` — full self-contained instructions for the subagent
- `task_id` — pass a prior task ID created by this parent session for the same subagent; empty string starts fresh
- `model` — a raw `providerID/modelID` string straight from `opencode models` (e.g. `<provider>/<model>`). Pass `inherit` to reproduce native precedence: the subagent's own configured `model:` wins, and if it has none the child inherits the invoking session's current model. The parent reasoning variant is inherited when the OpenCode API exposes it; pass `reasoning` for an explicit tier.
- `reasoning` — thinking effort: `default` (the model's own), or `low`/`medium`/`high` (some models also accept `xhigh`/`max`). Only affects models that support reasoning; a level the target model doesn't support is silently ignored by opencode. Legacy plugin schemas require the `inherit`, `default`, and empty `task_id` sentinels rather than omitted arguments.

It runs synchronously and returns the subagent's final text, with the child `task_id` in the result metadata for resuming.

Child sessions enforce parent ownership, derived deny rules, primary-only tool restrictions, and OpenCode's configured `subagent_depth`. The public plugin API does not expose native task prompt-part resolution, so `@file` and agent references inside delegated prompts are sent as text; include the needed paths or context explicitly.

## Background tasks

Use `task_bg` for independent read-only work that should not block the calling agent:

```
task_bg(subagent_type, description, prompt, model, reasoning)
task_bg_output(task_id)
task_bg_list()
```

`task_bg` is registered in OpenCode's `experimental.primary_tools` list and returns as soon as the child starts. OpenCode therefore disables it for all subagents instead of relying on a runtime caller check. The main agent can continue working while up to eight children run in parallel. On completion, the plugin sends a hidden synthetic session notification to the main agent and a visible TUI toast. `task_bg_output` returns the result without waiting; `task_bg_list` shows all tasks launched by the current session.

Background sessions use a deny-all sandbox that permits only OpenCode's `read`, `glob`, `grep`, and `webfetch` permission names. Shell, edits, nested tasks, and tools with other permission names are blocked. OpenCode permissions are name-based: MCP resource readers map to `read`, and a custom tool that deliberately reuses an allowed built-in name cannot be distinguished by a plugin. Use trusted plugins and synchronous `task` for agents that modify files.

Live background state is kept in the plugin process. Completed state is capped at 100 tasks per parent session and 1,000 globally, retained in memory for one hour, and each stored result is capped at 500,000 characters. `task_bg_output` and `task_bg_list` reconstruct task results from child sessions when OpenCode reloads the plugin. Active timeout and completion-notification workers do not survive a full server restart, but completed child output remains retrievable by task ID.

## Picking models

There's no alias table — `model` takes a raw `providerID/modelID` string, so anything `opencode models` lists works without touching the plugin. This applies equally to `task` and `task_bg`. Reasoning is passed through as the prompt `variant`, so any effort tier the target model exposes works without further config.

Routing policy stays in your own markdown. `AGENTS.md`, an agent's `description` field, or a per-repo agents file, opencode already surfaces those to the model in context. Put "prefer `openai/gpt-5.6-terra` for reviews" wherever it belongs for you; the plugin just carries out the per-call override. No duplicated model registry baked into the tool description, no config schema to keep in sync.

## Releasing

This repository's release process is tag-driven via `.github/workflows/publish.yml`; maintainers do not run `npm publish` manually. To cut a release: bump `version` in `package.json`, commit it, then tag and push:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow verifies the tag matches `package.json`'s version, publishes an unpublished version via npm's OIDC trusted publishing (no stored token), and creates the corresponding GitHub Release if it does not already exist.

## License

MIT
