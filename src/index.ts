// opencode-dynamic-delegate
//
// Overrides the built-in `task` tool. opencode resolves plugin tools ahead of
// built-ins of the same name, so the agent sees ONE task tool: native-shaped,
// plus an optional per-call `model` (and `reasoning`) so you can run a subagent
// on a specific model in the current session without restarting or hardcoding
// `model:` in the agent .md. Loaded via the `plugin` array in opencode.json.
//
// Why reimplement instead of extend: the built-in task tool's execute is
// compiled into core and exposes no model arg; the only task hook edits the
// description the model sees, not behavior. So this spawns the child session
// itself via the client API, where model + agent + variant are set explicitly.
// Default (model omitted/inherit) reproduces native behavior: the child runs on
// the invoking session's model.
//
// Intentionally dependency-free (no imports, `any` types): keeps the plugin
// trivial to load and resolve regardless of where node_modules lives. The
// legacy arg-schema path marks every arg required, so the "optional" args use
// sentinels: model 'inherit', reasoning 'default', task_id '' (empty = fresh).

const MODELS: Record<string, string> = {
  sonnet: "github-copilot/claude-sonnet-4.6",
  gpt: "github-copilot/gpt-5.5",
  opus: "github-copilot/claude-opus-4.8",
  "opus-anth": "anthropic/claude-opus-4-8",
}

// Reasoning effort, passed to the subagent as the prompt `variant`. low/medium/high
// work on every alias; xhigh/max only resolve on opus-anth (Anthropic direct).
// A level the target model doesn't support is silently ignored by opencode.
const REASONING = ["default", "low", "medium", "high", "xhigh", "max"]

const MODEL_ALIASES = ["inherit", ...Object.keys(MODELS)]

function modelRef(alias: string) {
  const full = MODELS[alias]
  if (!full) return undefined
  const [providerID, ...rest] = full.split("/")
  return { providerID, modelID: rest.join("/") }
}

export default async ({ client }: any) => ({
  tool: {
    task: {
      description: [
        "Launch a subagent to handle a task, optionally on a model you choose.",
        "Drop-in for the built-in task tool: same subagent_type/description/prompt/task_id,",
        "plus an optional model + reasoning. Omit model (or use 'inherit') to run on the",
        "current session model, exactly like the native task tool.",
        "subagent_type: explore (codebase search), general (multi-step execution),",
        "review (code review), design (UI/full-stack).",
        "models: inherit (current session model), sonnet (Claude Sonnet 4.6), gpt (GPT-5.5),",
        "opus (Claude Opus 4.8 via GitHub Copilot), opus-anth (Claude Opus 4.8 via Anthropic direct).",
        "reasoning: how hard the model thinks. default keeps the model's own default;",
        "low/medium/high work on every alias (opus-anth also accepts xhigh/max). Ignored by",
        "non-reasoning models. Note: Copilot 'opus' only supports 'medium' (or 'default').",
        "Pass a prior task_id to resume that subagent session instead of starting fresh.",
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
        task_id: {
          type: "string",
          description:
            "Resume: pass a task_id from a prior task result to continue that subagent session. Empty string starts a fresh task.",
        },
        model: {
          type: "string",
          enum: MODEL_ALIASES,
          description: "Model alias. Use 'inherit' to run on the current session model (native behavior).",
        },
        reasoning: {
          type: "string",
          enum: REASONING,
          description:
            "Reasoning effort. 'default' leaves it to the model; low/medium/high work everywhere; xhigh/max only on opus-anth.",
        },
      },
      async execute(args: any, ctx: any) {
        const model = modelRef(args.model)
        const variant = args.reasoning && args.reasoning !== "default" ? args.reasoning : undefined

        let sessionID = typeof args.task_id === "string" && args.task_id ? args.task_id : undefined
        if (!sessionID) {
          const created = await client.session.create({
            body: {
              parentID: ctx.sessionID,
              title: `${args.description} (@${args.subagent_type})`,
            },
          })
          if (created.error || !created.data?.id) {
            return `task: failed to create session: ${JSON.stringify(created.error ?? "unknown")}`
          }
          sessionID = created.data.id
        }

        const res = await client.session.prompt({
          path: { id: sessionID },
          body: {
            agent: args.subagent_type,
            ...(model ? { model } : {}),
            ...(variant ? { variant } : {}),
            parts: [{ type: "text", text: args.prompt }],
          },
        })
        if (res.error) {
          return `task: subagent error: ${JSON.stringify(res.error)}`
        }
        const parts = res.data?.parts ?? []
        const text = parts
          .filter((p: any) => p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n")
          .trim()

        return {
          title: `${args.description} (@${args.subagent_type})`,
          output: text || "(subagent returned no text)",
          metadata: { task_id: sessionID, model: args.model || "inherit" },
        }
      },
    },
  },
})
