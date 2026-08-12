import { spawn, spawnSync } from "node:child_process"
import { closeSync, constants, openSync, writeSync } from "node:fs"

export const TmuxStatusPlugin = async () => {
  const pane = process.env.TMUX_PANE
  const hasTmux = Boolean(process.env.TMUX && pane)

  const paneTTY = hasTmux
    ? spawnSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_tty}"], {
        encoding: "utf8",
      }).stdout?.trim()
    : null
  let bellFD = null
  try {
    if (paneTTY) bellFD = openSync(paneTTY, constants.O_WRONLY)
  } catch {}

  const ringBell = () => {
    if (bellFD !== null) {
      try {
        writeSync(bellFD, "\x07")
        return
      } catch {
        try {
          closeSync(bellFD)
        } catch {}
        bellFD = null
      }
    }
    try {
      process.stdout.write("\x07")
    } catch {}
  }

  const closeBell = () => {
    if (bellFD === null) return
    try {
      closeSync(bellFD)
    } catch {}
    bellFD = null
  }

  const setStatusCommand = (state) =>
    `set-option -w -t ${pane} @opencode_status ${state}`

  const setOptionArgs = (name, value) =>
    value === null
      ? ["set-option", "-w", "-u", "-t", pane, name]
      : ["set-option", "-w", "-t", pane, name, String(value)]

  const formatDuration = (seconds) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor(seconds / 60) % 60
    const remainder = seconds % 60
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    }
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
  }

  const tmuxArgs = (state, startedAt, duration) => {
    const timerArgs = setOptionArgs("@opencode_started_at", startedAt)
    const durationArgs = setOptionArgs("@opencode_duration", duration)
    let statusArgs = setOptionArgs("@opencode_status", state)
    if (state === "done") {
      statusArgs = [
        "if-shell",
        "-F",
        "-t",
        pane,
        "#{window_active_clients}",
        setStatusCommand("idle"),
        setStatusCommand("done"),
      ]
    }
    return [...statusArgs, ";", ...timerArgs, ";", ...durationArgs]
  }

  const runTmux = (state, startedAt, duration) => {
    if (!hasTmux) return Promise.resolve()
    return new Promise((resolve) => {
      try {
        const child = spawn("tmux", tmuxArgs(state, startedAt, duration), { stdio: "ignore" })
        child.once("error", resolve)
        child.once("close", resolve)
      } catch {
        resolve()
      }
    })
  }

  let requestedState
  let appliedState
  let promptStartedAt = null
  let appliedStartedAt
  let completedDuration = null
  let appliedDuration
  let stopped = false
  let writes = Promise.resolve()

  const flush = async () => {
    while (
      appliedState !== requestedState ||
      appliedStartedAt !== promptStartedAt ||
      appliedDuration !== completedDuration
    ) {
      const state = requestedState
      const startedAt = promptStartedAt
      const duration = completedDuration
      await runTmux(state, startedAt, duration)
      appliedState = state
      appliedStartedAt = startedAt
      appliedDuration = duration
    }
  }

  const setState = (state) => {
    if (stopped && state !== null) return writes
    const promptActive = state === "working" || state === "waiting"
    if (promptActive && promptStartedAt === null) {
      promptStartedAt = Math.floor(Date.now() / 1000)
    }
    if (promptActive) completedDuration = null
    if (!promptActive) {
      if (state === "done" && promptStartedAt !== null) {
        const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - promptStartedAt)
        completedDuration = formatDuration(elapsed)
      }
      if (state !== "done") completedDuration = null
      promptStartedAt = null
    }
    if (state === requestedState) return writes
    requestedState = state
    writes = writes.then(flush, flush)
    if (state === "waiting" || state === "done" || state === "error") {
      ringBell()
    }
    return writes
  }

  const stop = async () => {
    stopped = true
    await setState(null)
    closeBell()
  }

  const clearOnExit = () => {
    stopped = true
    closeBell()
    promptStartedAt = null
    completedDuration = null
    if (
      requestedState === null &&
      appliedState === null &&
      appliedStartedAt === null &&
      appliedDuration === null
    ) {
      return
    }
    requestedState = null
    if (hasTmux) {
      try {
        spawnSync("tmux", tmuxArgs(null, null, null), { stdio: "ignore" })
      } catch {}
    }
    appliedState = null
    appliedStartedAt = null
    appliedDuration = null
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
          if (!isChild(properties.sessionID)) {
            // User interrupts are reported as errors by OpenCode, but are not failures.
            await setState(properties.error?.name === "MessageAbortedError" ? "idle" : "error")
          }
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
