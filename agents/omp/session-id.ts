import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

function copy(text: string): string | undefined {
  const result = spawnSync("pbcopy", [], { input: text, encoding: "utf8" });
  if (result.error) return result.error.message;
  if (result.status !== 0) return (result.stderr || `pbcopy exited ${result.status}`).trim();
  return undefined;
}

export default function sessionId(pi: ExtensionAPI): void {
  const copySessionPath = (ctx: ExtensionContext): void => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || !existsSync(sessionFile)) {
      ctx.ui.notify("This session has no saved transcript to copy yet.", "error");
      return;
    }
    const path = resolve(sessionFile);
    const failure = copy(path);
    ctx.ui.notify(
      failure ? `Clipboard write failed (${failure}); session path is ${path}` : `Copied session path ${path}`,
      failure ? "error" : "info",
    );
  };

  pi.registerCommand("sid", {
    description: "Copy this session's transcript path to the clipboard",
    handler: async (_args, ctx) => copySessionPath(ctx),
  });

  // alt+shift+s is unbound in the built-in keybinding table.
  pi.registerShortcut("alt+shift+s", {
    description: "Copy session transcript path",
    handler: ctx => copySessionPath(ctx),
  });
}
