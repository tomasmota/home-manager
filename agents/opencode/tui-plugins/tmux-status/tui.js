import { Plugin } from "@opencode/plugin/tui"
import { spawnSync } from "node:child_process"

import { createTmuxStatusPlugin } from "./core.js"

export default Plugin.define({
  id: "tomas.tmux-status",
  async setup(context) {
    if (!process.env.TMUX) return
    const pane = process.env.TMUX_PANE || spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
      encoding: "utf8",
    }).stdout?.trim()
    if (!/^%\d+$/.test(pane ?? "")) return

    const hooks = await createTmuxStatusPlugin({
      session: {
        context: async ({ sessionID }) => {
          await context.data.session.message.sync(sessionID)
          return (context.data.session.message.list(sessionID) ?? []).map((message) => {
            // The TUI cache stores message info and parts separately.
            const info = message.info ?? message
            const parts = message.parts ?? message.content ?? []
            return { ...info, content: parts, text: info.text ?? parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") }
          })
        },
      },
    }, { env: { ...process.env, TMUX_PANE: pane } })
    const owned = new Set()
    let events = Promise.resolve()
    const stop = context.data.listen(({ details }) => {
      const sessionID = details.data?.sessionID ?? details.data?.form?.sessionID
      const route = context.ui.router.current()
      if (route.type === "session" && route.sessionID) owned.add(route.sessionID)
      if (sessionID && !owned.has(sessionID)) return
      events = events.then(() => hooks.event(details)).catch((error) => console.error("tmux-status event failed", error))
    })

    return async () => {
      stop()
      await events
      await hooks.dispose()
    }
  },
})
