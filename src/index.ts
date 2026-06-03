// opencode-dynamic-delegate
//
// Adds a `delegate` tool: run a subagent on a model you choose per call, in the
// current session, without restarting opencode or hardcoding `model:` in each
// agent .md. Loaded via the `plugin` array in opencode.json.
//
// Why: the built-in `task` tool resolves the subagent model from the agent's
// frozen config (or inherits the parent model) and exposes no per-call model
// arg. This plugin spawns the child session itself via the client API, where
// model + agent are set explicitly on the prompt call.
//
// Intentionally dependency-free (no imports, `any` types): keeps the plugin
// trivial to load and resolve regardless of where node_modules lives.

const MODELS: Record<string, string> = {
  sonnet: "github-copilot/claude-sonnet-4.6",
  gpt: "github-copilot/gpt-5.5",
  opus: "github-copilot/claude-opus-4.8",
  "opus-anth": "anthropic/claude-opus-4-8",
}

function modelRef(alias: string) {
  const full = MODELS[alias]
  if (!full) return undefined
  const [providerID, ...rest] = full.split("/")
  return { providerID, modelID: rest.join("/") }
}

export default async ({ client }: any) => ({
  tool: {
    delegate: {
      description: [
        "Run a subagent on a model you choose, in the current session, no restart.",
        "Same idea as the task tool, but you pick the model per call.",
        "models: inherit (current session model), sonnet (Claude Sonnet 4.6), gpt (GPT-5.5), opus (Claude Opus 4.8 via GitHub Copilot), opus-anth (Claude Opus 4.8 via Anthropic direct).",
        "Returns the subagent's final text. Runs synchronously.",
      ].join(" "),
      args: {
        subagent_type: {
          type: "string",
          description: "Subagent to run: explore, general, review, or design.",
        },
        description: {
          type: "string",
          description: "Short 3-5 word task description.",
        },
        prompt: {
          type: "string",
          description: "Full self-contained instructions for the subagent.",
        },
        model: {
          type: "string",
          enum: ["inherit", "sonnet", "gpt", "opus", "opus-anth"],
          description: "Model alias. Use 'inherit' to run on the current session model.",
        },
      },
      async execute(args: any, ctx: any) {
        const model = modelRef(args.model)
        const created = await client.session.create({
          body: {
            parentID: ctx.sessionID,
            title: `${args.description} (@${args.subagent_type})`,
          },
        })
        if (created.error || !created.data?.id) {
          return `delegate: failed to create session: ${JSON.stringify(created.error ?? "unknown")}`
        }
        const res = await client.session.prompt({
          path: { id: created.data.id },
          body: {
            agent: args.subagent_type,
            ...(model ? { model } : {}),
            parts: [{ type: "text", text: args.prompt }],
          },
        })
        if (res.error) {
          return `delegate: subagent error: ${JSON.stringify(res.error)}`
        }
        const parts = res.data?.parts ?? []
        const text = parts
          .filter((p: any) => p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n")
          .trim()
        return text || "(subagent returned no text)"
      },
    },
  },
})
