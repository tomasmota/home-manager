import { spawn, spawnSync } from "node:child_process"

export const TmuxStatusPlugin = async () => {
  const pane = process.env.TMUX_PANE
  if (!process.env.TMUX || !pane) return {}

  const setStatusCommand = (state) =>
    `set-option -w -t ${pane} @opencode_status ${state}`

  const tmuxArgs = (state) => {
    if (state === null) return ["set-option", "-w", "-u", "-t", pane, "@opencode_status"]
    if (state === "done") {
      return [
        "if-shell",
        "-F",
        "-t",
        pane,
        "#{window_active_clients}",
        setStatusCommand("idle"),
        setStatusCommand("done"),
      ]
    }
    return ["set-option", "-w", "-t", pane, "@opencode_status", state]
  }

  const runTmux = (state) =>
    new Promise((resolve) => {
      try {
        const child = spawn("tmux", tmuxArgs(state), { stdio: "ignore" })
        child.once("error", resolve)
        child.once("close", resolve)
      } catch {
        resolve()
      }
    })

  let requestedState
  let appliedState
  let stopped = false
  let writes = Promise.resolve()

  const flush = async () => {
    while (appliedState !== requestedState) {
      const state = requestedState
      await runTmux(state)
      appliedState = state
    }
  }

  const setState = (state) => {
    if ((stopped && state !== null) || state === requestedState) return writes
    requestedState = state
    writes = writes.then(flush, flush)
    return writes
  }

  const stop = async () => {
    stopped = true
    await setState(null)
  }

  const clearOnExit = () => {
    stopped = true
    if (requestedState === null && appliedState === null) return
    requestedState = null
    try {
      spawnSync("tmux", tmuxArgs(null), { stdio: "ignore" })
    } catch {}
    appliedState = null
  }

  const childSessions = new Set()
  const isChild = (sessionID) => sessionID != null && childSessions.has(sessionID)

  const setLifecycleState = (state) => {
    if (requestedState === "waiting") return writes
    if (state === "idle") {
      if (requestedState === "working") return setState("done")
      if (requestedState === "done" || requestedState === "error") return writes
    }
    return setState(state)
  }

  process.once("exit", clearOnExit)
  await setState("idle")

  return {
    event: async ({ event }) => {
      const properties = event.properties ?? {}

      switch (event.type) {
        case "session.created":
        case "session.updated":
          if (properties.info?.id && properties.info.parentID) {
            childSessions.add(properties.info.id)
          }
          break
        case "session.status": {
          if (isChild(properties.sessionID)) break
          const status =
            typeof properties.status === "string" ? properties.status : properties.status?.type
          if (status === "busy" || status === "retry") await setLifecycleState("working")
          if (status === "idle") await setLifecycleState("idle")
          break
        }
        case "session.idle":
          if (!isChild(properties.sessionID)) await setLifecycleState("idle")
          break
        case "permission.asked":
        case "question.asked":
          await setState("waiting")
          break
        case "permission.replied":
        case "question.replied":
        case "question.rejected":
          await setState("working")
          break
        case "session.error":
          if (!isChild(properties.sessionID)) await setState("error")
          break
        case "server.instance.disposed":
          await stop()
          break
      }
    },
    "tool.execute.before": async ({ tool }) => {
      if (tool === "question") await setState("waiting")
    },
    dispose: async () => {
      await stop()
      process.off("exit", clearOnExit)
    },
  }
}
