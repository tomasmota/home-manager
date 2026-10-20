--!strict

local currentSession: number? = nil
local previousSession: number? = nil

local function remember(cx: WindowCx)
	local session = cx.sessions:current()
	if session.id ~= currentSession then
		previousSession = currentSession
		currentSession = session.id
	end
end

tern.on("focus", function(_ev, cx)
	remember(cx)
end)

-- Empty sessions emit no focus event. Also initialize after plugin reloads.
local function poll(cx: WindowCx?)
	if cx then
		remember(cx)
	end
	tern.timer(50, poll)
end
tern.timer(0, poll)

tern.command({
	id = "last",
	title = "Last session",
	run = function(cx)
		remember(cx)
		if previousSession then
			for _, session in cx.sessions:list() do
				if session.id == previousSession then
					-- Tern's Lua ID encoding truncates large persisted session IDs.
					cx.sessions:switch(session.name)
					remember(cx)
					return
				end
			end
		end
		previousSession = nil
		cx:toast("info", "No previous session")
	end,
})
