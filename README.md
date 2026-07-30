# opencode-task-model

An [opencode](https://opencode.ai) plugin that lets you run synchronous or background subagents on a model you choose **per call**, in the current session, without restarting opencode or hardcoding `model:` in each agent's `.md`.

opencode resolves plugin tools ahead of built-ins with the same name, so the agent sees a single `task` tool: native-shaped, plus per-call `model` and `reasoning` controls. Use `inherit` and `default` to keep native model-selection precedence.

## Why

The built-in `task` tool resolves the subagent model from the agent's frozen config (or inherits the parent model) and exposes no per-call model argument, and its `execute` is compiled into core so the arg cannot be bolted on. This plugin reimplements the spawn via the client API (`session.create` + `session.prompt`), where `model`, `agent`, and `variant` are set explicitly. With `model: "inherit"`, the child uses native model precedence.

## Install

```sh
VERSION="$(bun pm view opencode-task-model version)"
opencode plugin --global "opencode-task-model@$VERSION"
```

This resolves npm's current release once, installs that exact version, and adds the pinned reference to your global `opencode.json` automatically. `--global` puts it in your user config so every project picks it up; drop it to install into the current project only. Pinning avoids stale `@latest` alias or package-cache resolution.

OpenCode installs it with Bun on startup and caches it under `~/.cache/opencode/node_modules/`. Because it overrides the built-in `task` tool, no further wiring is needed: every agent that already uses `task` picks up the `model`/`reasoning` args automatically.

### Upgrade

From a repository checkout, resolve the current npm version and replace the global entry with an exact npm pin:

```sh
bun run opencode:install
```

The script resolves the exact version with `bun pm view` and updates your global `opencode.json`. Restart OpenCode afterward so it installs and loads that package version.

### Local development

From a checkout, point your global `opencode.json` directly at `src/index.ts` with a fresh import token:

```sh
bun run opencode:local
```

Run the command again after local edits before restarting OpenCode. The changing `?v=` token busts Bun's process-local dynamic-import cache.

Restart OpenCode after switching. Local source changes are picked up on later restarts. Before publishing or testing the registry package, switch back with `bun run opencode:install` and restart again.

## Usage

The tool signature:

```
task(subagent_type, description, prompt, task_id, model, reasoning, background)
```

- `subagent_type` — the subagent to run (e.g. `explore`, `general`, `review`, `design`)
- `description` — short task description, used as the child session title
- `prompt` — full self-contained instructions for the subagent
- `task_id` — pass a prior task ID created by this parent session for the same subagent and foreground/background mode; empty string starts fresh. Active background tasks cannot be extended; wait for completion before reusing their ID.
- `model` — a raw `providerID/modelID` string straight from `opencode models` (e.g. `<provider>/<model>`). Pass `inherit` to reproduce native precedence: the subagent's own configured `model:` wins, and if it has none the child inherits the invoking session's current model. The parent reasoning variant is inherited when the OpenCode API exposes it; pass `reasoning` for an explicit tier.
- `reasoning` — thinking effort: `default` (the model's own), or `low`/`medium`/`high` (some models also accept `xhigh`/`max`). Only affects models that support reasoning; a level the target model doesn't support is silently ignored by opencode. Legacy plugin schemas require `inherit`, `default`, an empty `task_id`, and `background: false` rather than omitted arguments.
- `background` — `false` runs in the foreground and returns the result; `true` launches asynchronously and returns immediately

Foreground tasks return the subagent's final text, with the child `task_id` in the result metadata for resuming.

Child sessions enforce parent ownership, derived deny rules, primary-only tool restrictions, and OpenCode's configured `subagent_depth`. The public plugin API does not expose native task prompt-part resolution, so `@file` and agent references inside delegated prompts are sent as text; include the needed paths or context explicitly.

## Background tasks

Set `background: true` on `task` for independent read-only work that should not block the calling agent:

```
task(subagent_type, description, prompt, task_id, model, reasoning, background=true)
```

Background mode returns as soon as the child starts. Because it uses the real `task` tool ID and returns native-shaped `background` metadata, OpenCode's Task renderer shows the child session, spinner, navigation, and completion state on the original tool call instead of creating a fake user message. Native task permissions keep `task` disabled in foreground subagents by default unless that agent explicitly enables it; background subagents always deny nested tasks. The main agent can continue working while up to eight children run in parallel.

On completion, the plugin shows a toast and one concise DCP-style status row such as `▣ Background · Review auth: completed`. That visible row is marked `ignored`, so it is excluded from model context. The capped final result is carried in a second `synthetic` part that stays hidden in the TUI but is visible to the main agent. Completion starts a deterministic parent response automatically; because that is a new assistant turn, OpenCode renders its normal assistant footer.

Background sessions use a deny-all sandbox that permits only OpenCode's `read`, `glob`, `grep`, and `webfetch` permission names. Shell, edits, nested tasks, and tools with other permission names are blocked. OpenCode permissions are name-based: MCP resource readers map to `read`, and a custom tool that deliberately reuses an allowed built-in name cannot be distinguished by a plugin. Use trusted plugins and synchronous `task` for agents that modify files.

Live background state is kept in the plugin process. Completed state is capped at 100 tasks per parent session and 1,000 globally, retained in memory for one hour, and each stored result is capped at 500,000 characters. Active timeout and completion-notification workers do not survive a full server restart, but completed child output remains available in the child session history.

## Picking models

There's no alias table — `model` takes a raw `providerID/modelID` string, so anything `opencode models` lists works without touching the plugin. This applies equally to foreground and background `task` calls. Reasoning is passed through as the prompt `variant`, so any effort tier the target model exposes works without further config.

Routing policy stays in your own markdown. `AGENTS.md`, an agent's `description` field, or a per-repo agents file, opencode already surfaces those to the model in context. Put "prefer `openai/gpt-5.6-terra` for reviews" wherever it belongs for you; the plugin just carries out the per-call override. No duplicated model registry baked into the tool description, no config schema to keep in sync.

## Releasing

This repository's release process is tag-driven via `.github/workflows/publish.yml`; maintainers do not run `npm publish` manually. To cut a release: bump `version` in `package.json`, commit it, then tag and push:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow verifies the tag matches `package.json`'s version, publishes an unpublished version via npm's OIDC trusted publishing (no stored token), and creates the corresponding GitHub Release if it does not already exist.

After the publish workflow completes, switch the maintainer setup from the local checkout to the newly published exact version, then restart OpenCode:

```sh
bun run opencode:install
```

## License

MIT
