# opencode-dynamic-delegate

An [opencode](https://opencode.ai) plugin that **overrides the built-in `task` tool** so you can run a subagent on a model you choose **per call**, in the current session, without restarting opencode or hardcoding `model:` in each agent's `.md`.

opencode resolves plugin tools ahead of built-ins with the same name, so the agent sees a single `task` tool: native-shaped, plus two optional args (`model`, `reasoning`). Omit them and it behaves exactly like the built-in.

## Why

The built-in `task` tool resolves the subagent model from the agent's frozen config (or inherits the parent model) and exposes no per-call model argument, and its `execute` is compiled into core so the arg cannot be bolted on. This plugin reimplements the spawn via the client API (`session.create` + `session.prompt`), where `model`, `agent`, and `variant` are set explicitly. With no `model` (or `inherit`), the child runs on the invoking session's model, reproducing native behavior.

## Install

Reference the plugin from the `plugin` array in your `opencode.json`:

```json
{
  "plugin": ["./plugins/opencode-dynamic-delegate"]
}
```

or by package spec once published to a registry/git.

## Usage

The tool signature (drop-in superset of native `task`):

```
task(subagent_type, description, prompt, task_id, model, reasoning)
```

- `subagent_type` — the subagent to run (e.g. `explore`, `general`, `review`, `design`)
- `description` — short task description, used as the child session title
- `prompt` — full self-contained instructions for the subagent
- `task_id` — pass a prior task_id to resume that subagent session; empty string starts fresh
- `model` — one of:
  - `inherit` — the subagent's configured model (native behavior)
  - `sonnet` — `github-copilot/claude-sonnet-4.6`
  - `gpt` — `github-copilot/gpt-5.5`
  - `opus` — `github-copilot/claude-opus-4.8` (only supports `medium`/`default` reasoning on Copilot)
  - `opus-anth` — `anthropic/claude-opus-4-8` (Anthropic direct)
- `reasoning` — thinking effort: `default` (model's own), `low`, `medium`, `high` on every alias; `xhigh`/`max` only on `opus-anth`. Levels a model doesn't support are silently ignored by opencode (except Copilot `opus`, which 400s on anything but `medium`).

It runs synchronously and returns the subagent's final text, with the child `task_id` in the result metadata for resuming.

## Customizing models

Edit the `MODELS` registry in `src/index.ts`. Each entry maps an alias to a full `providerID/modelID` string and feeds the `model` arg `enum`. Reasoning is passed through as the prompt `variant`, so any effort the target model exposes works without further config.

## License

MIT
