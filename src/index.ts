// opencode-task-model
//
// Overrides the built-in `task` tool. opencode resolves plugin tools ahead of
// built-ins of the same name, so the agent sees ONE task tool: native-shaped,
// plus per-call `model`, `reasoning`, and native-shaped background controls so you can run a subagent
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
// sentinels: model 'inherit', reasoning 'default', task_id '' (empty = fresh),
// and background false (foreground).

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

function xmlEscape(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

const BACKGROUND_SANDBOX_RULES = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "write", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "task", pattern: "*", action: "deny" },
  { permission: "todowrite", pattern: "*", action: "deny" },
]

async function authorizeTask(ctx: any, args: any) {
  if (typeof ctx?.ask !== "function") {
    throw new Error("This OpenCode version does not expose task permission authorization to plugins")
  }
  await ctx.ask({
    permission: "task",
    patterns: [args.subagent_type],
    always: ["*"],
    metadata: { description: args.description, subagent_type: args.subagent_type },
  })
}

async function resolveAgent(client: any, name: string) {
  const res = await client.app.agents()
  const agents = res?.data ?? res
  const found = (Array.isArray(agents) ? agents : []).find((agent: any) => agent?.name === name)
  if (!found || found.mode === "primary") throw new Error(`Unknown subagent type: ${name}`)
  return found
}

function childPermissions(parent: any, background: boolean, agent?: any, primaryTools: string[] = []) {
  const parentRules = Array.isArray(parent?.permission) ? parent.permission : []
  const rules = parentRules.filter((rule: any) =>
    rule?.action === "deny" || rule?.permission === "external_directory"
  )
  const agentRules = Array.isArray(agent?.permission) ? agent.permission : []
  const declares = (permission: string) => agentRules.some((rule: any) => rule?.permission === permission)
  // Parent deny/external-directory rules come last so a safe-tool allow can never
  // override a restriction inherited from the invoking session.
  if (background) return [...BACKGROUND_SANDBOX_RULES, ...rules]
  const denied = [
    ...(!declares("task") ? ["task"] : []),
    ...(!declares("todowrite") ? ["todowrite"] : []),
    ...primaryTools,
  ]
  for (const permission of denied) {
    if (!rules.some((rule: any) => rule?.permission === permission && rule?.pattern === "*" && rule?.action === "deny")) {
      rules.push({ permission, pattern: "*", action: "deny" })
    }
  }
  return rules
}

function hasBackgroundSandbox(actual: any) {
  if (!Array.isArray(actual) || actual.length < BACKGROUND_SANDBOX_RULES.length) return false
  return sameRules(actual.slice(0, BACKGROUND_SANDBOX_RULES.length), BACKGROUND_SANDBOX_RULES)
}

function sameRules(actual: any, expected: any[]) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((rule: any, index: number) => {
    const wanted = expected[index]
    return rule?.permission === wanted.permission && rule?.pattern === wanted.pattern && rule?.action === wanted.action
  })
}

async function configuredPrimaryTools(client: any) {
  if (typeof client.config?.get !== "function") return []
  const res = await client.config.get()
  if (res?.error) throw new Error(`Failed to read primary-only tools: ${JSON.stringify(res.error)}`)
  const tools = res?.data?.experimental?.primary_tools
  return Array.isArray(tools) ? tools.filter((value: any) => typeof value === "string") : []
}

async function enforceSubagentDepth(client: any, ctx: any) {
  let limit = 1
  if (typeof client.config?.get === "function") {
    const config = await client.config.get()
    if (config?.error) throw new Error(`Failed to read subagent depth: ${JSON.stringify(config.error)}`)
    if (Number.isInteger(config?.data?.subagent_depth) && config.data.subagent_depth >= 0) {
      limit = config.data.subagent_depth
    }
  }
  let currentID = ctx.sessionID
  let depth = 0
  const visited = new Set<string>()
  while (currentID) {
    if (visited.has(currentID)) throw new Error("Invalid cyclic session ancestry")
    visited.add(currentID)
    const current = await client.session.get({ path: { id: currentID } })
    if (current?.error || !current?.data?.id) throw new Error("Failed to verify subagent depth")
    if (!current.data.parentID) break
    depth++
    currentID = current.data.parentID
  }
  if (depth >= limit) {
    throw new Error(`Subagent depth limit reached (${limit}). Increase "subagent_depth" to allow nested subagents.`)
  }
}

async function parentAndPermissions(client: any, ctx: any, background: boolean, agent?: any) {
  let res: any
  try {
    res = await client.session.get({ path: { id: ctx.sessionID } })
  } catch (e) {
    throw new Error(`Failed to read parent session permissions: ${errMsg(e)}`)
  }
  if (res?.error || !res?.data?.id) {
    throw new Error(`Failed to read parent session permissions: ${JSON.stringify(res?.error ?? "unknown")}`)
  }
  const primaryTools = background ? [] : await configuredPrimaryTools(client)
  return { parent: res.data, permissions: childPermissions(res.data, background, agent, primaryTools) }
}

async function verifyChildSession(client: any, id: string, parentID: string, agent: string, permissions: any[]) {
  const res = await client.session.get({ path: { id } })
  const child = res?.data
  if (res?.error || !child?.id) throw new Error(`Failed to verify child session: ${JSON.stringify(res?.error ?? "unknown")}`)
  if (child.parentID !== parentID) throw new Error("Child session does not belong to the invoking session")
  if (child.agent !== agent) throw new Error("Child session belongs to a different subagent")
  if (!sameRules(child.permission, permissions)) {
    throw new Error("OpenCode did not preserve the required child permission rules")
  }
  return child
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
  return [`<task id="${xmlEscape(sessionID)}" state="${state}">`, `<${tag}>`, xmlEscape(text), `</${tag}>`, "</task>"].join("\n")
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
  variant?: string
  parentAgent?: string
}

const backgroundTasks = new Map<string, BackgroundTask>()
const backgroundLaunches = new Map<string, number>()
const BACKGROUND_TIMEOUT_MS = 15 * 60 * 1000
const BACKGROUND_RETENTION_MS = 60 * 60 * 1000
const BACKGROUND_MAX_TASKS_PER_PARENT = 100
const BACKGROUND_MAX_TASKS = 1_000
const BACKGROUND_MAX_ACTIVE_PER_PARENT = 8
const BACKGROUND_MAX_RESULT_CHARS = 500_000
const BACKGROUND_TITLE = /^(.*) \(@([^,]+), background\)$/s

function pruneBackgroundTasks(now = Date.now()) {
  for (const [id, task] of backgroundTasks) {
    if (task.status !== "running" && task.completedAt && now - task.completedAt > BACKGROUND_RETENTION_MS) {
      backgroundTasks.delete(id)
    }
  }
  const parents = new Set([...backgroundTasks.values()].map((task) => task.parentSessionID))
  for (const parent of parents) {
    const terminal = [...backgroundTasks.values()]
      .filter((task) => task.parentSessionID === parent && task.status !== "running")
      .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
    for (const task of terminal.slice(BACKGROUND_MAX_TASKS_PER_PARENT)) backgroundTasks.delete(task.id)
  }
  const terminal = [...backgroundTasks.values()]
    .filter((task) => task.status !== "running")
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
  for (const task of terminal.slice(BACKGROUND_MAX_TASKS)) backgroundTasks.delete(task.id)
}

function capResult(value: string) {
  if (value.length <= BACKGROUND_MAX_RESULT_CHARS) return value
  const marker = "\n\n[output truncated by opencode-task-model]"
  return `${value.slice(0, BACKGROUND_MAX_RESULT_CHARS - marker.length)}${marker}`
}

function backgroundIdentity(session: any, parentSessionID: string) {
  const match = typeof session?.title === "string" ? session.title.match(BACKGROUND_TITLE) : undefined
  if (!match || session?.parentID !== parentSessionID) return undefined
  return { description: match[1], agent: session.agent || match[2] }
}

async function recoverBackgroundTask(client: any, id: string, parentSessionID: string) {
  try {
    const sessionRes = await client.session.get({ path: { id } })
    const session = sessionRes?.data
    const identity = backgroundIdentity(session, parentSessionID)
    if (sessionRes?.error || !identity) return undefined
    if (!hasBackgroundSandbox(session.permission)) return undefined

    const messageRes = await client.session.messages({ path: { id } })
    if (messageRes?.error || !Array.isArray(messageRes?.data)) {
      if (backgroundTasks.get(id)?.status === "running") backgroundTasks.delete(id)
      return undefined
    }
    const messages = messageRes.data
    const assistant = messages.filter((message: any) => message?.info?.role === "assistant").pop()
    const completedAt = assistant?.info?.time?.completed
    const error = assistant?.info?.error
    const createdAt = session.time?.created ?? Date.now()
    const expired = !error && !completedAt && Date.now() - createdAt >= BACKGROUND_TIMEOUT_MS
    const status: BackgroundStatus = error ? "error" : completedAt ? "completed" : expired ? "timeout" : "running"
    const terminalAt = completedAt ?? (error || expired ? Date.now() : undefined)
    const task: BackgroundTask = {
      id,
      parentSessionID,
      agent: identity.agent,
      description: identity.description,
      status,
      createdAt,
      ...(terminalAt ? { completedAt: terminalAt } : {}),
      ...(error ? { error: capResult(`Subagent error: ${JSON.stringify(error)}`) } : {}),
      ...(expired ? { error: "Background task timed out after 15 minutes" } : {}),
      ...(status === "completed" ? { result: capResult(lastText({ data: assistant }) || "(subagent returned no text)") } : {}),
      ...(session.model?.providerID && (session.model.modelID || session.model.id) ? {
        model: { providerID: session.model.providerID, modelID: session.model.modelID ?? session.model.id },
      } : {}),
    }
    if (expired) {
      try {
        void Promise.resolve(client.session.abort({ path: { id } })).catch(() => {})
      } catch {
        // Best-effort recovery cancellation.
      }
    }
    if (status === "running" || !terminalAt || Date.now() - terminalAt <= BACKGROUND_RETENTION_MS) {
      backgroundTasks.set(id, task)
      pruneBackgroundTasks()
    }
    return task
  } catch {
    return undefined
  }
}

async function recoverBackgroundChildren(client: any, parentSessionID: string) {
  try {
    const children = await client.session.children({ path: { id: parentSessionID } })
    const recoverable = (Array.isArray(children?.data) ? children.data : [])
      .filter((session: any) =>
        (!backgroundTasks.has(session?.id) || backgroundTasks.get(session.id)?.status === "running") &&
        backgroundIdentity(session, parentSessionID)
      )
      .sort((a: any, b: any) => (b?.time?.created ?? 0) - (a?.time?.created ?? 0))
    for (let index = 0; index < recoverable.length; index += 8) {
      await Promise.all(recoverable.slice(index, index + 8).map((session: any) =>
        recoverBackgroundTask(client, session.id, parentSessionID)
      ))
    }
  } catch {
    // Older servers may not expose child-session listing; live in-memory tasks still work.
  }
}

function reserveBackgroundLaunch(parentSessionID: string) {
  const running = [...backgroundTasks.values()].filter((task) =>
    task.parentSessionID === parentSessionID && task.status === "running"
  ).length
  const launching = backgroundLaunches.get(parentSessionID) ?? 0
  if (running + launching >= BACKGROUND_MAX_ACTIVE_PER_PARENT) return false
  backgroundLaunches.set(parentSessionID, launching + 1)
  return true
}

function releaseBackgroundLaunch(parentSessionID: string) {
  const remaining = (backgroundLaunches.get(parentSessionID) ?? 1) - 1
  if (remaining > 0) backgroundLaunches.set(parentSessionID, remaining)
  else backgroundLaunches.delete(parentSessionID)
}

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

async function notifyBackgroundComplete(client: any, task: BackgroundTask) {
  const state = task.status === "completed" ? "completed" : "error"
  const detail = task.status === "completed"
    ? task.result || "(subagent returned no text)"
    : task.error || `Background task ${task.status}.`
  const tag = state === "completed" ? "task_result" : "task_error"
  const notification = [
    `<task id="${xmlEscape(task.id)}" state="${state}">`,
    `<summary>Background task ${task.status}: ${xmlEscape(task.description)}</summary>`,
    `<${tag}>`,
    xmlEscape(detail),
    `</${tag}>`,
    "</task>",
  ].join("\n")
  const visibleDescription = task.description
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "Background task"
  const visibleStatus = `▣ Background · ${visibleDescription}: ${task.status}`

  try {
    let parentAgent = task.parentAgent
    try {
      const parent = await client.session.get({ path: { id: task.parentSessionID } })
      if (parent?.data?.agent) parentAgent = parent.data.agent
    } catch {
      // Fall back to the invoking agent captured at launch.
    }
    const body = {
      // Start deterministic parent processing. The concise status is visible but
      // excluded from model context; the full result is model-visible but TUI-hidden.
      noReply: false,
      ...(parentAgent ? { agent: parentAgent } : {}),
      ...(task.variant ? { variant: task.variant } : {}),
      parts: [
        { type: "text", ignored: true, text: visibleStatus },
        { type: "text", synthetic: true, text: notification },
      ],
    }
    await client.session.prompt({
      path: { id: task.parentSessionID },
      body,
    })
  } catch {
    // Best-effort. The child session remains available through normal session history.
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

async function startBackgroundTask(
  client: any,
  args: any,
  ctx: any,
  permissions: any[],
  model: { providerID: string; modelID: string } | undefined,
  variant: string | undefined,
  parentVariant: string | undefined,
) {
  await recoverBackgroundChildren(client, ctx.sessionID)
  pruneBackgroundTasks()
  if (!reserveBackgroundLaunch(ctx.sessionID)) {
    return `task: maximum of ${BACKGROUND_MAX_ACTIVE_PER_PARENT} active background tasks reached for this session`
  }

  let sessionID: string
  let task: BackgroundTask
  try {
    const candidate = typeof args.task_id === "string" && args.task_id.trim() ? args.task_id.trim() : undefined
    let existing: any
    if (candidate) {
      try {
        existing = await client.session.get({ path: { id: candidate } })
      } catch {
        // Match native task behavior: a deleted ID starts a fresh child.
      }
    }

    if (candidate && !existing?.error && existing?.data?.id) {
      await verifyChildSession(client, candidate, ctx.sessionID, args.subagent_type, permissions)
      const recovered = await recoverBackgroundTask(client, candidate, ctx.sessionID)
      if (recovered?.status === "running") return `task: background task_id "${candidate}" is already running`
      sessionID = candidate
    } else {
      const created = await client.session.create({
        body: {
          parentID: ctx.sessionID,
          agent: args.subagent_type,
          title: `${args.description} (@${args.subagent_type}, background)`,
          permission: permissions,
        },
      })
      if (created.error || !created.data?.id) {
        return `task: failed to create background session: ${JSON.stringify(created.error ?? "unknown")}`
      }
      sessionID = created.data.id
      await verifyChildSession(client, sessionID, ctx.sessionID, args.subagent_type, permissions)
    }

    task = {
      id: sessionID,
      parentSessionID: ctx.sessionID,
      agent: args.subagent_type,
      description: args.description,
      status: "running",
      createdAt: Date.now(),
      ...(model ? { model } : {}),
      ...(parentVariant ? { variant: parentVariant } : {}),
      ...(ctx.agent ? { parentAgent: ctx.agent } : {}),
    }
    backgroundTasks.set(sessionID, task)
  } catch (e) {
    return `task: failed to start background session: ${errMsg(e)}`
  } finally {
    releaseBackgroundLaunch(ctx.sessionID)
  }

  const metadata = {
    sessionId: sessionID,
    parentSessionId: ctx.sessionID,
    background: true,
    jobId: sessionID,
    ...(model ? { model } : {}),
  }
  await setRunningMetadata(client, ctx, metadata, args.description)

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
    pruneBackgroundTasks()
    void notifyBackgroundComplete(client, task)
  }, BACKGROUND_TIMEOUT_MS)

  void Promise.resolve().then(() => client.session.prompt({
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
      task.error = capResult(`Subagent error: ${JSON.stringify(res.error)}`)
    } else {
      task.status = "completed"
      task.result = capResult(lastText(res) || "(subagent returned no text)")
    }
    pruneBackgroundTasks()
    void notifyBackgroundComplete(client, task)
  }).catch((e: unknown) => {
    if (task.status !== "running") return
    clearTimeout(timer)
    task.status = "error"
    task.completedAt = Date.now()
    task.error = capResult(`Subagent threw: ${errMsg(e)}`)
    pruneBackgroundTasks()
    void notifyBackgroundComplete(client, task)
  })

  return {
    title: args.description,
    output: [
      `<task id="${xmlEscape(sessionID)}" state="running">`,
      "<summary>Background task started</summary>",
      "<task_result>",
      "The task is working in the background. You will be notified automatically when it finishes.",
      "Continue with non-overlapping work; do not poll immediately.",
      "</task_result>",
      "</task>",
    ].join("\n"),
    metadata,
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
    "plus model + reasoning controls. Use 'inherit' for native model",
    "resolution: the subagent's own configured model if it has one, else the invoking",
    "session's model.",
    "subagent_type: the name of a subagent configured in this environment.",
    "model: a raw 'provider/model' ref from 'opencode models', or 'inherit' for native resolution.",
    "reasoning: how hard the model thinks. 'default' keeps the model's own default;",
    "low/medium/high (and xhigh/max where supported) map to the prompt variant.",
    "Only affects models that support reasoning; unsupported values are ignored by opencode.",
    "For a fast/lookup subagent configured at low reasoning, keep 'default' unless the",
    "user explicitly asks for a deeper pass on this specific call; do not raise it",
    "yourself just because a search feels broad or the prompt says 'thoroughly'.",
    "Reach for an explicit model only when the job needs more capability, or a cheaper",
    "pass, than the subagent's default. If the user names a model or thinking level in",
    "plain language (e.g. 'use the big model'), honor it.",
    "Pass a prior task_id to resume that subagent session in the same foreground or background mode.",
    "A running background task cannot be extended; wait for it to finish before reusing its task_id.",
    "Set background=true to return immediately and run independent work asynchronously.",
    "Foreground is the default and returns the subagent's final text.",
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
            "Resume a completed task in the same foreground or background mode. A running background task cannot be extended. Empty string starts fresh.",
        },
        model: {
          type: "string",
          description:
            "Raw \"provider/model\" ref from 'opencode models'. Use 'inherit' for native resolution: " +
            "the subagent's configured model if it has one, else the invoking session's model.",
        },
        reasoning: {
          type: "string",
          enum: REASONING,
          description:
            "Reasoning effort passed to the subagent as the prompt variant. 'default' leaves it to the model. " +
            "Only affects models that support reasoning; unsupported values are ignored by opencode.",
        },
        background: {
          type: "boolean",
          description:
            "Run the agent in the background and return immediately. Use false for normal foreground execution.",
        },
      },
      async execute(args: any, ctx: any) {
        await enforceSubagentDepth(client, ctx)
        await authorizeTask(ctx, args)
        const agent = await resolveAgent(client, args.subagent_type)
        const runInBackground = args.background === true
        const { permissions } = await parentAndPermissions(client, ctx, runInBackground, agent)
        // Reproduce native task's model precedence (tool/task.ts): when the caller
        // gives no explicit model, the subagent's own configured model wins, else the
        // child inherits the INVOKING assistant message's model (not the child
        // session's default, which a fresh child would otherwise resolve to). Variant
        // follows the parent only in the inherit case, matching native
        // `variant: next.model ? undefined : parentVariant`. An explicit model/reasoning
        // arg overrides both. All lookups are best-effort: on failure we leave model
        // undefined and let the server resolve it, the pre-fix fallback.
        const { model, variant } = await resolveModelVariant(client, args, ctx)
        if (runInBackground) {
          const parentVariant = (await parentModelVariant(client, ctx))?.variant
          return startBackgroundTask(client, args, ctx, permissions, model, variant, parentVariant)
        }

        // Resolve the child session: resume a VALID prior task_id, else create fresh.
        // Matches native behavior (tool/task.ts): an unknown/stale/deleted task_id
        // falls back to a new session rather than hard-failing the prompt.
        let sessionID: string | undefined
        const candidate = typeof args.task_id === "string" && args.task_id.trim() ? args.task_id.trim() : undefined
        if (candidate) {
          let existing: any
          try {
            existing = await client.session.get({ path: { id: candidate } })
          } catch {
            // Match native task behavior: an unavailable or deleted ID starts a fresh child.
          }
          if (!existing?.error && existing?.data?.id) {
            try {
              await verifyChildSession(client, candidate, ctx.sessionID, args.subagent_type, permissions)
              sessionID = candidate
            } catch (e) {
              return `task: cannot resume task_id "${candidate}": ${errMsg(e)}`
            }
          }
        }
        if (!sessionID) {
          try {
            const created = await client.session.create({
              body: {
                parentID: ctx.sessionID,
                agent: args.subagent_type,
                title: `${args.description} (@${args.subagent_type})`,
                permission: permissions,
              },
            })
            if (created.error || !created.data?.id) {
              return `task: failed to create session: ${JSON.stringify(created.error ?? "unknown")}`
            }
            sessionID = created.data.id
            await verifyChildSession(client, sessionID!, ctx.sessionID, args.subagent_type, permissions)
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
  },
  }
}
