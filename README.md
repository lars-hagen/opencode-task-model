# opencode-task-model

An [opencode](https://opencode.ai) plugin that **overrides the built-in `task` tool** so you can run a subagent on a model you choose **per call**, in the current session, without restarting opencode or hardcoding `model:` in each agent's `.md`.

opencode resolves plugin tools ahead of built-ins with the same name, so the agent sees a single `task` tool: native-shaped, plus two optional args (`model`, `reasoning`). Omit them and it behaves exactly like the built-in.

## Why

The built-in `task` tool resolves the subagent model from the agent's frozen config (or inherits the parent model) and exposes no per-call model argument, and its `execute` is compiled into core so the arg cannot be bolted on. This plugin reimplements the spawn via the client API (`session.create` + `session.prompt`), where `model`, `agent`, and `variant` are set explicitly. With no `model` (or `inherit`), the child runs on the invoking session's model, reproducing native behavior.

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
- `task_id` — pass a prior task_id to resume that subagent session; empty string starts fresh
- `model` — a raw `providerID/modelID` string straight from `opencode models` (e.g. `<provider>/<model>`). Omit it or pass `inherit` to reproduce native precedence: the subagent's own configured `model:` wins, and if it has none the child inherits the invoking session's current model. (Reasoning is not inherited via the plugin API surface; pass `reasoning` if you need a specific tier.)
- `reasoning` — thinking effort: `default` (the model's own), or `low`/`medium`/`high` (some models also accept `xhigh`/`max`). Only affects models that support reasoning; a level the target model doesn't support is silently ignored by opencode.

It runs synchronously and returns the subagent's final text, with the child `task_id` in the result metadata for resuming.

## Picking models

There's no alias table — `model` takes a raw `providerID/modelID` string, so anything `opencode models` lists works without touching the plugin. Reasoning is passed through as the prompt `variant`, so any effort tier the target model exposes works without further config.

Routing policy stays in your own markdown. `AGENTS.md`, an agent's `description` field, or a per-repo agents file, opencode already surfaces those to the model in context. Put "prefer `openai/gpt-5.6-terra` for reviews" wherever it belongs for you; the plugin just carries out the per-call override. No duplicated model registry baked into the tool description, no config schema to keep in sync.

## Releasing

Publishing to npm is tag-driven only, via `.github/workflows/publish.yml` — there's no manual `npm publish` step. To cut a release: bump `version` in `package.json`, commit it, then tag and push:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow verifies the tag matches `package.json`'s version, publishes via npm's OIDC trusted publishing (no stored token), and mirrors the tag as a GitHub Release. This keeps git and npm from drifting apart: a version can only reach the registry if it has a corresponding tag/commit in this repo.

## License

MIT
