// opencode-task-model
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

// Reasoning effort, passed to the subagent as the prompt `variant`. low/medium/high
// (and xhigh/max where a model supports them) map to the variant; a level the target
// model doesn't support is silently ignored by opencode. Only affects reasoning models.
const REASONING = ["default", "low", "medium", "high", "xhigh", "max"]

// A fast/lookup subagent (e.g. one configured with a small model and `variant: low`)
// is cheap by design. An explicit `reasoning` override on the task() call beats the
// subagent's own default (see createUserMessage in session/prompt.ts: input.variant
// short-circuits the agent's configured variant entirely) — that escalation path
// stays available on purpose, for when a real deep-dive is wanted. But it should be
// rare and deliberate: reflexively bumping reasoning for an ordinarily-phrased
// "explore thoroughly" ask can turn quick greps into multi-minute, many-tool runs.
// Default (reasoning omitted) always falls through to the agent's own configured
// variant, no code-level clamp here; the discipline is enforced by the
// description below, not by force.

// Resolve the model arg to a { providerID, modelID } ref, or undefined to inherit.
// Takes a raw "provider/model" string as listed by `opencode models`.
// 'inherit'/'' (or anything without a "/") falls through to inherit.
function modelRef(value: string) {
  const v = typeof value === "string" ? value.trim() : ""
  if (!v || v === "inherit" || !v.includes("/")) return undefined
  const [providerID, ...rest] = v.split("/")
  const modelID = rest.join("/").trim()
  if (!providerID.trim() || !modelID) return undefined
  return { providerID: providerID.trim(), modelID }
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

// The subagent's own configured model (its .md / config `model:`), or undefined.
// Mirrors native `next.model` in tool/task.ts: when set, it wins over inheriting
// the parent's model. Best-effort GET /agent via client.app.agents(); any failure
// (route gone, SDK shape change) returns undefined so the caller falls through to
// parent-model inherit, i.e. the pre-fix behavior.
async function agentModel(client: any, name: string) {
  try {
    const res = await client.app.agents()
    const list = res?.data ?? res
    const found = (Array.isArray(list) ? list : []).find((a: any) => a?.name === name)
    const m = found?.model
    if (m?.providerID && m?.modelID) return { providerID: m.providerID, modelID: m.modelID }
  } catch {
    // best-effort
  }
  return undefined
}

// The invoking assistant message's model (+ variant if the API exposes it). The
// session/message this tool was called from. Mirrors native reading
// msg.info.{modelID,providerID,variant} in tool/task.ts, the value a modelless
// subagent inherits. NOTE: the v1 client the plugin receives serializes modelID +
// providerID but not variant (see AssistantMessage in the SDK types), so `variant`
// here is best-effort and normally undefined; model inheritance is the reliable
// part. Best-effort overall: undefined on any failure or non-assistant message.
async function parentModelVariant(client: any, ctx: any) {
  try {
    const msg = await client.session.message({ path: { id: ctx.sessionID, messageID: ctx.messageID } })
    const info = msg?.data?.info
    if (info?.role === "assistant" && info.providerID && info.modelID) {
      return {
        model: { providerID: info.providerID, modelID: info.modelID },
        variant: typeof info.variant === "string" ? info.variant : undefined,
      }
    }
  } catch {
    // best-effort
  }
  return undefined
}

// Mirror the built-in task tool's output envelope. The model sees the tool OUTPUT
// string but not its metadata, so the child session id must live in the text for
// `task_id` resume to be usable. Matches packages/opencode/src/tool/task.ts.
function renderOutput(sessionID: string, state: "completed" | "error", text: string) {
  const tag = state === "error" ? "task_error" : "task_result"
  return [`<task id="${sessionID}" state="${state}">`, `<${tag}>`, text, `</${tag}>`, "</task>"].join("\n")
}

type BackgroundStatus = "running" | "completed" | "error" | "timeout"

type BackgroundTask = {
  id: string
  parentSessionID: string
  agent: string
  description: string
  status: BackgroundStatus
  createdAt: number
  completedAt?: number
  result?: string
  error?: string
  model?: { providerID: string; modelID: string }
}

const backgroundTasks = new Map<string, BackgroundTask>()
const BACKGROUND_TIMEOUT_MS = 15 * 60 * 1000

async function resolveModelVariant(client: any, args: any, ctx: any) {
  let model = modelRef(args.model)
  let variant = args.reasoning && args.reasoning !== "default" ? args.reasoning : undefined
  if (!model) {
    const configured = await agentModel(client, args.subagent_type)
    if (configured) {
      model = configured
    } else {
      const parent = await parentModelVariant(client, ctx)
      if (parent) {
        model = parent.model
        if (!variant) variant = parent.variant
      }
    }
  }
  return { model, variant }
}

function lastText(res: any) {
  const parts = res?.data?.parts ?? []
  const last = parts.filter((p: any) => p.type === "text" && typeof p.text === "string").pop()
  return (last?.text ?? "").trim()
}

async function notifyBackgroundComplete(client: any, task: BackgroundTask, parentAgent?: string) {
  const notification = [
    "<task-notification>",
    `<task-id>${task.id}</task-id>`,
    `<status>${task.status}</status>`,
    `<summary>Background task ${task.status}: ${task.description}</summary>`,
    task.error ? `<error>${task.error}</error>` : "",
    `<retrieval>Call task_bg_output with task_id "${task.id}" to retrieve the result.</retrieval>`,
    "</task-notification>",
  ].filter(Boolean).join("\n")

  try {
    if (typeof client.session?.promptAsync === "function") {
      await client.session.promptAsync({
        path: { id: task.parentSessionID },
        body: { noReply: true, ...(parentAgent ? { agent: parentAgent } : {}), parts: [{ type: "text", text: notification }] },
      })
    } else if (typeof client?._client?.post === "function") {
      await client._client.post({
        url: `/session/${task.parentSessionID}/prompt_async`,
        body: { noReply: true, ...(parentAgent ? { agent: parentAgent } : {}), parts: [{ type: "text", text: notification }] },
      })
    }
  } catch {
    // Best-effort. The task remains discoverable through task_bg_list.
  }

  try {
    await client.tui?.showToast({
      body: {
        title: "Background task finished",
        message: `${task.description}: ${task.status}`,
        variant: task.status === "completed" ? "success" : "error",
      },
    })
  } catch {
    // TUI may not be attached (server/headless use).
  }
}

// Set this tool part's metadata.sessionId WHILE the subagent runs, so the TUI Task
// renderer (routes/session/index.tsx) lights up its live "running" branch: child
// sync, clickable nav, and the streaming current-tool line. The built-in task tool
// does this via ctx.metadata() early, but that callback is a lazy Effect that
// opencode does NOT bridge for plugin tools (registry.ts only bridges `ask`), so a
// plugin calling ctx.metadata() is a no-op. We instead PATCH the part directly:
// fetch the parent message, find this tool call by ctx.callID, and write metadata
// via the PATCH /session/{id}/message/{messageID}/part/{partID} route, reached
// through the legacy client's protected `_client`. Best-effort: any failure (route
// gone, callID/messageID absent, _client shape change) degrades to completion-only
// metadata, which still gives clickable + duration + toolcount once the task ends.
async function setRunningMetadata(client: any, ctx: any, metadata: Record<string, any>, title?: string) {
  try {
    const sessionID = ctx?.sessionID
    const messageID = ctx?.messageID
    const callID = ctx?.callID
    const http = client?._client
    if (!sessionID || !messageID || !callID || typeof http?.patch !== "function") return

    const msg = await client.session.message({ path: { id: sessionID, messageID } })
    const part = (msg?.data?.parts ?? []).find((p: any) => p.type === "tool" && p.callID === callID)
    if (!part || part.state?.status !== "running") return

    const next = {
      ...part,
      state: {
        ...part.state,
        ...(title ? { title } : {}),
        metadata: { ...(part.state.metadata ?? {}), ...metadata },
      },
    }
    await http.patch({
      url: `/session/${sessionID}/message/${messageID}/part/${part.id}`,
      body: next,
    })
  } catch {
    // best-effort; completion-time metadata is the source of truth
  }
}

export default ({ client }: any) => {
  // Description is intentionally static. Routing policy (which model for which
  // job) belongs in the user's own markdown, AGENTS.md, an agent's description
  // field, or a per-repo agents file, where opencode already surfaces it to the
  // model in context. This plugin exposes the mechanism (per-call override), the
  // user's own docs express the intent. No duplication into every tool description.
  const baseDescription = [
    "Launch a subagent to handle a task, optionally on a model you choose.",
    "Drop-in for the built-in task tool: same subagent_type/description/prompt/task_id,",
    "plus an optional model + reasoning. Omit model (or use 'inherit') for native model",
    "resolution: the subagent's own configured model if it has one, else the invoking",
    "session's model.",
    "subagent_type: the name of a subagent configured in this environment.",
    "model: a raw 'provider/model' ref from 'opencode models', or omit/'inherit' for native resolution.",
    "reasoning: how hard the model thinks. 'default' keeps the model's own default;",
    "low/medium/high (and xhigh/max where supported) map to the prompt variant.",
    "Only affects models that support reasoning; unsupported values are ignored by opencode.",
    "For a fast/lookup subagent configured at low reasoning, keep 'default' unless the",
    "user explicitly asks for a deeper pass on this specific call; do not raise it",
    "yourself just because a search feels broad or the prompt says 'thoroughly'.",
    "Reach for an explicit model only when the job needs more capability, or a cheaper",
    "pass, than the subagent's default. If the user names a model or thinking level in",
    "plain language (e.g. 'use the big model'), honor it.",
    "Pass a prior task_id to resume that subagent session instead of starting fresh.",
    "Returns the subagent's final text. Runs synchronously.",
  ].join(" ")

  return {
  tool: {
    task: {
      description: baseDescription,
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
          description:
            "Raw \"provider/model\" ref from 'opencode models'. Use 'inherit' (or omit) for native resolution: " +
            "the subagent's configured model if it has one, else the invoking session's model.",
        },
        reasoning: {
          type: "string",
          enum: REASONING,
          description:
            "Reasoning effort passed to the subagent as the prompt variant. 'default' leaves it to the model. " +
            "Only affects models that support reasoning; unsupported values are ignored by opencode.",
        },
      },
      async execute(args: any, ctx: any) {
        // Reproduce native task's model precedence (tool/task.ts): when the caller
        // gives no explicit model, the subagent's own configured model wins, else the
        // child inherits the INVOKING assistant message's model (not the child
        // session's default, which a fresh child would otherwise resolve to). Variant
        // follows the parent only in the inherit case, matching native
        // `variant: next.model ? undefined : parentVariant`. An explicit model/reasoning
        // arg overrides both. All lookups are best-effort: on failure we leave model
        // undefined and let the server resolve it, the pre-fix fallback.
        const { model, variant } = await resolveModelVariant(client, args, ctx)

        // Resolve the child session: resume a VALID prior task_id, else create fresh.
        // Matches native behavior (tool/task.ts): an unknown/stale/deleted task_id
        // falls back to a new session rather than hard-failing the prompt.
        let sessionID: string | undefined
        const candidate = typeof args.task_id === "string" && args.task_id.trim() ? args.task_id.trim() : undefined
        if (candidate) {
          try {
            const existing = await client.session.get({ path: { id: candidate } })
            if (!existing.error && existing.data?.id) sessionID = existing.data.id
          } catch {
            // unresolved candidate; fall through to create
          }
        }
        if (!sessionID) {
          try {
            const created = await client.session.create({
              body: {
                parentID: ctx.sessionID,
                agent: args.subagent_type,
                title: `${args.description} (@${args.subagent_type})`,
                // Deny nested task on the child, reproducing the piece of native's
                // deriveSubagentSessionPermission that matters most here: since this
                // plugin OVERRIDES task, a subagent could otherwise recursively spawn
                // more subagents. Child session.permission layers on top of the agent's
                // own rules (session/tools.ts), so this restricts without erasing them.
                // The server's Session.CreateInput accepts `permission` (+ `agent`)
                // even though the generated v1 SDK body type omits them; extra fields
                // pass through at runtime. Native's todowrite/primary_tools denies and
                // parent-rule inheritance are skipped: they need the subagent's internal
                // permission ruleset, which the plugin client can't read.
                permission: [{ permission: "task", pattern: "*", action: "deny" }],
              },
            })
            if (created.error || !created.data?.id) {
              return `task: failed to create session: ${JSON.stringify(created.error ?? "unknown")}`
            }
            sessionID = created.data.id
          } catch (e) {
            return `task: failed to create session: ${errMsg(e)}`
          }
        }

        // Light up the live TUI branch before the (blocking) prompt call. Guarded;
        // no-ops on older servers. Completion metadata below is the durable record.
        const liveMeta = {
          sessionId: sessionID,
          parentSessionId: ctx.sessionID,
          ...(model ? { model } : {}),
        }
        await setRunningMetadata(client, ctx, liveMeta, args.description)

        // Propagate interrupt to the child. ctx.abort fires when the user interrupts
        // the parent session, but client.session.prompt is a blocking HTTP call that
        // keeps the child running SERVER-SIDE; nothing here cancels it. Passing
        // ctx.abort as a local fetch signal would only kill our wait and leak a live
        // child. So on abort we hit the child's own /session/{id}/abort, which stops
        // its run and lets the pending prompt return. once:true + finally cleanup so a
        // resolved prompt never leaves a dangling listener. Best-effort: swallow abort
        // errors (route gone, child already done). If ctx.abort already fired before we
        // got here, abort immediately so we don't spawn an unstoppable run.
        const abortChild = () => {
          // Fire-and-forget: don't await, and swallow rejection so a failed abort
          // (route gone, child already terminal) never becomes an unhandled rejection.
          try {
            void Promise.resolve(client.session.abort({ path: { id: sessionID } })).catch(() => {})
          } catch {
            // best-effort; child may already be terminal
          }
        }
        const signal: AbortSignal | undefined = ctx?.abort
        // Already interrupted before we could prompt: stop the child and return an
        // error envelope instead of starting a run the user already cancelled.
        if (signal?.aborted) {
          abortChild()
          return {
            title: args.description,
            output: renderOutput(sessionID!, "error", "task: aborted before the subagent started"),
            metadata: liveMeta,
          }
        }
        signal?.addEventListener("abort", abortChild, { once: true })

        // On any prompt failure, still return the task-shaped object (with liveMeta
        // and a state=error envelope) so the failed task stays clickable, keeps its
        // sessionId for resume, and surfaces the error to the model.
        let res: any
        try {
          res = await client.session.prompt({
            path: { id: sessionID },
            body: {
              agent: args.subagent_type,
              ...(model ? { model } : {}),
              ...(variant ? { variant } : {}),
              parts: [{ type: "text", text: args.prompt }],
            },
          })
        } catch (e) {
          return {
            title: args.description,
            output: renderOutput(sessionID!, "error", `task: subagent threw: ${errMsg(e)}`),
            metadata: liveMeta,
          }
        } finally {
          // Drop the abort listener on every exit (throw, error, success) so a
          // resolved task never leaves a stale handler bound to ctx.abort.
          signal?.removeEventListener("abort", abortChild)
        }
        if (res.error) {
          return {
            title: args.description,
            output: renderOutput(sessionID!, "error", `task: subagent error: ${JSON.stringify(res.error)}`),
            metadata: liveMeta,
          }
        }
        // Native returns only the LAST text part of the child result (tool/task.ts:
        // result.parts.findLast(text)), not every text part joined; joining can
        // duplicate or interleave intermediate assistant text.
        const text = lastText(res)

        // Metadata keys MUST be camelCase sessionId/parentSessionId: the TUI Task
        // renderer keys its child-session sync, clickable navigation, toolcall count
        // and duration off props.metadata.sessionId (see routes/session/index.tsx).
        // model mirrors the built-in's { providerID, modelID } shape when known.
        return {
          title: args.description,
          output: renderOutput(sessionID!, "completed", text || "(subagent returned no text)"),
          metadata: liveMeta,
        }
      },
    },
    task_bg: {
      description: [
        "Launch a read-only subagent in the background and return immediately.",
        "Use this for independent research, exploration, and review while you continue working.",
        "The child is forcibly denied edit, write, bash, and nested task tools to prevent concurrent workspace mutations.",
        "Supports the same dynamic model and reasoning overrides as task.",
        "A completion notification is sent when possible; use task_bg_output or task_bg_list to inspect it.",
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
          description: "Raw provider/model ref, or 'inherit' for native model resolution.",
        },
        reasoning: {
          type: "string",
          enum: REASONING,
          description: "Reasoning effort. Use 'default' to keep the model or agent default.",
        },
      },
      async execute(args: any, ctx: any) {
        const { model, variant } = await resolveModelVariant(client, args, ctx)
        let inheritedPermissions: any[] = []
        try {
          const parent = await client.session.get({ path: { id: ctx.sessionID } })
          const rules = Array.isArray(parent.data?.permission) ? parent.data.permission : []
          inheritedPermissions = rules.filter((rule: any) =>
            rule?.action === "deny" || rule?.permission === "external_directory"
          )
        } catch {
          // Older servers may not expose session permissions. Fixed write denies below still apply.
        }
        let sessionID: string
        try {
          const created = await client.session.create({
            body: {
              parentID: ctx.sessionID,
              agent: args.subagent_type,
              title: `${args.description} (@${args.subagent_type}, background)`,
              permission: [
                ...inheritedPermissions,
                { permission: "edit", pattern: "*", action: "deny" },
                { permission: "write", pattern: "*", action: "deny" },
                { permission: "bash", pattern: "*", action: "deny" },
                { permission: "task", pattern: "*", action: "deny" },
                { permission: "task_bg", pattern: "*", action: "deny" },
                { permission: "todowrite", pattern: "*", action: "deny" },
              ],
            },
          })
          if (created.error || !created.data?.id) {
            return `task_bg: failed to create session: ${JSON.stringify(created.error ?? "unknown")}`
          }
          sessionID = created.data.id
        } catch (e) {
          return `task_bg: failed to create session: ${errMsg(e)}`
        }

        const task: BackgroundTask = {
          id: sessionID,
          parentSessionID: ctx.sessionID,
          agent: args.subagent_type,
          description: args.description,
          status: "running",
          createdAt: Date.now(),
          ...(model ? { model } : {}),
        }
        backgroundTasks.set(sessionID, task)

        const timer = setTimeout(() => {
          if (task.status !== "running") return
          task.status = "timeout"
          task.completedAt = Date.now()
          task.error = "Background task timed out after 15 minutes"
          try {
            void Promise.resolve(client.session.abort({ path: { id: sessionID } })).catch(() => {})
          } catch {
            // Best-effort timeout cancellation.
          }
          void notifyBackgroundComplete(client, task, ctx.agent)
        }, BACKGROUND_TIMEOUT_MS)

        void Promise.resolve(client.session.prompt({
          path: { id: sessionID },
          body: {
            agent: args.subagent_type,
            ...(model ? { model } : {}),
            ...(variant ? { variant } : {}),
            parts: [{ type: "text", text: args.prompt }],
          },
        })).then((res: any) => {
          if (task.status !== "running") return
          clearTimeout(timer)
          task.completedAt = Date.now()
          if (res?.error) {
            task.status = "error"
            task.error = `Subagent error: ${JSON.stringify(res.error)}`
          } else {
            task.status = "completed"
            task.result = lastText(res) || "(subagent returned no text)"
          }
          void notifyBackgroundComplete(client, task, ctx.agent)
        }).catch((e: unknown) => {
          if (task.status !== "running") return
          clearTimeout(timer)
          task.status = "error"
          task.completedAt = Date.now()
          task.error = `Subagent threw: ${errMsg(e)}`
          void notifyBackgroundComplete(client, task, ctx.agent)
        })

        return {
          title: args.description,
          output: [
            `<task id="${sessionID}" state="running">`,
            "Background task started. Continue working; do not wait or poll immediately.",
            `Use task_bg_output(task_id="${sessionID}") when notified, or task_bg_list() to inspect active tasks.`,
            "</task>",
          ].join("\n"),
          metadata: { sessionId: sessionID, parentSessionId: ctx.sessionID, ...(model ? { model } : {}) },
        }
      },
    },
    task_bg_output: {
      description: "Return the current status and result of a background task without waiting for it.",
      args: {
        task_id: {
          type: "string",
          description: "Background task ID returned by task_bg.",
        },
      },
      async execute(args: any, ctx: any) {
        const id = typeof args.task_id === "string" ? args.task_id.trim() : ""
        const task = backgroundTasks.get(id)
        if (!task || task.parentSessionID !== ctx.sessionID) {
          return `task_bg_output: unknown task_id "${id}" in this session`
        }
        const detail = task.status === "completed" ? task.result : task.error
        const output = task.status === "running"
          ? [`<task id="${task.id}" state="running">`, "Background task is still running.", "</task>"].join("\n")
          : renderOutput(task.id, task.status === "completed" ? "completed" : "error",
              detail || `Background task ${task.status}.`)
        return {
          title: task.description,
          output,
          metadata: { sessionId: task.id, parentSessionId: task.parentSessionID, ...(task.model ? { model: task.model } : {}) },
        }
      },
    },
    task_bg_list: {
      description: "List background tasks launched by the current session and their statuses.",
      args: {},
      async execute(_args: any, ctx: any) {
        const tasks = [...backgroundTasks.values()]
          .filter((task) => task.parentSessionID === ctx.sessionID)
          .sort((a, b) => b.createdAt - a.createdAt)
        if (!tasks.length) return "No background tasks in this session."
        return tasks.map((task) =>
          `${task.id}  ${task.status.padEnd(9)}  @${task.agent}  ${task.description}`
        ).join("\n")
      },
    },
  },
  }
}
