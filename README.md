# opencode-dynamic-delegate

An [opencode](https://opencode.ai) plugin that adds a `delegate` tool: run a subagent on a model you choose **per call**, in the current session, without restarting opencode or hardcoding `model:` in each agent's `.md`.

## Why

The built-in `task` tool resolves the subagent model from the agent's frozen config (or inherits the parent model) and exposes no per-call model argument. `delegate` spawns the child session itself via the client API, where `model` and `agent` are set explicitly on the prompt call.

## Install

Reference the plugin from the `plugin` array in your `opencode.json`:

```json
{
  "plugin": ["./plugins/opencode-dynamic-delegate"]
}
```

or by package spec once published to a registry/git.

## Usage

The tool signature:

```
delegate(subagent_type, description, prompt, model)
```

- `subagent_type` — the subagent to run (e.g. `explore`, `general`, `review`, `design`)
- `description` — short task description, used as the child session title
- `prompt` — full self-contained instructions for the subagent
- `model` — one of:
  - `inherit` — the subagent's configured model (same as `task`)
  - `sonnet` — `github-copilot/claude-sonnet-4.6`
  - `gpt` — `github-copilot/gpt-5.5`
  - `opus` — `github-copilot/claude-opus-4.8`

It runs synchronously and returns the subagent's final text.

## Customizing models

Edit the `MODELS` registry in `src/index.ts`. Each entry maps an alias to a full `providerID/modelID` string, and the `model` arg `enum` in the tool definition.

## License

MIT
