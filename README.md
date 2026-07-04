# opencode-dynamic-delegate

An [opencode](https://opencode.ai) plugin that **overrides the built-in `task` tool** so you can run a subagent on a model you choose **per call**, in the current session, without restarting opencode or hardcoding `model:` in each agent's `.md`.

opencode resolves plugin tools ahead of built-ins with the same name, so the agent sees a single `task` tool: native-shaped, plus two optional args (`model`, `reasoning`). Omit them and it behaves exactly like the built-in.

## Why

The built-in `task` tool resolves the subagent model from the agent's frozen config (or inherits the parent model) and exposes no per-call model argument, and its `execute` is compiled into core so the arg cannot be bolted on. This plugin reimplements the spawn via the client API (`session.create` + `session.prompt`), where `model`, `agent`, and `variant` are set explicitly. With no `model` (or `inherit`), the child runs on the invoking session's model, reproducing native behavior.

## Install

Add the package to the `plugin` array in your `opencode.json`. opencode installs it with Bun on startup and caches it under `~/.cache/opencode/node_modules/`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dynamic-delegate"]
}
```

Because it overrides the built-in `task` tool, no further wiring is needed: every agent that already uses `task` picks up the `model`/`reasoning` args automatically.

### Local development

To hack on it, clone the repo into a plugin directory opencode auto-loads (`~/.config/opencode/plugins/` for global, `.opencode/plugins/` for a project) and it loads on the next start:

```sh
git clone https://github.com/lars-hagen/opencode-dynamic-delegate.git \
  ~/.config/opencode/plugins/opencode-dynamic-delegate
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
- `model` — a raw `providerID/modelID` string straight from `opencode models` (e.g. `anthropic/claude-sonnet-5`, `anthropic/claude-opus-4-8`, `anthropic/claude-fable-5`, `openai/gpt-5.5`, `openai/gpt-5.4-mini`). Omit it or pass `inherit` to run on the subagent's own configured model (native behavior).
- `reasoning` — thinking effort: `default` (the model's own), or `low`/`medium`/`high` (most models also accept `xhigh`/`max` on the Anthropic models). A level the target model doesn't support is silently ignored by opencode.

It runs synchronously and returns the subagent's final text, with the child `task_id` in the result metadata for resuming.

## Picking models

There's no alias table — `model` takes a raw `providerID/modelID` string, so anything `opencode models` lists works without touching the plugin. Reasoning is passed through as the prompt `variant`, so any effort tier the target model exposes works without further config.

## License

MIT
