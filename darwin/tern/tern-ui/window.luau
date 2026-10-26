--!strict

-- The tern-ui CLI owns reuse, splitting and board state; this only starts it
-- for the focused pane. The board runs in place from the skill checkout.
local HOME = tern.getenv("HOME") or ""
local SKILL = HOME .. "/.agents/skills/tern-ui"
local opening = false

local function failure(result: ProcessResult): string
	if result.timed_out then
		return "Timed out"
	end
	local text = if result.stderr ~= "" then result.stderr else result.stdout
	local ok, decoded = pcall(tern.json.decode, text)
	if ok and type(decoded) == "table" then
		if type(decoded.error) == "string" then
			return decoded.error
		end
		if type(decoded.status) == "string" then
			return "Board " .. decoded.status .. "; see its app.log"
		end
	end
	return string.sub((string.gsub(text, "%s+$", "")), 1, 300)
end

tern.command({
	id = "mr-board",
	title = "MR board",
	icon = "branch",
	run = function(cx)
		if opening then
			cx:toast("info", "MR board is already opening")
			return
		end
		opening = true
		-- A login shell supplies the PATH (uv, tern, glab) a Dock-started app lacks.
		-- Window pane ids are not the CLI's block ids, so the CLI resolves @focused.
		local ok, err = pcall(tern.process.run, {
			"/bin/zsh",
			"-lc",
			'exec uv run "$0" open my-mrs --app "$1" --focus --pane @focused',
			SKILL .. "/scripts/tern-ui.py",
			SKILL .. "/examples/mr-board.py",
		}, {
			cwd = HOME,
			timeout_ms = 60000,
		}, function(result, later)
			opening = false
			if result.status ~= 0 and later then
				later:toast("error", "MR board did not open", failure(result))
			end
		end)
		if ok then
			cx:toast("info", "Opening MR board")
		else
			opening = false
			cx:toast("error", "MR board did not open", tostring(err))
		end
	end,
})
