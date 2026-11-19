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

-- Sessions on the current host, in the window's display order.
local function sessionOrder(cx: WindowCx): ({ManagedSession}, ManagedSession)
	local current = cx.sessions:current()
	local sessions = {}
	for _, session in cx.sessions:list() do
		if session.host == current.host then
			table.insert(sessions, session)
		end
	end
	return sessions, current
end

local function cycle(cx: WindowCx, step: number)
	local sessions, current = sessionOrder(cx)
	if #sessions < 2 then
		cx:toast("info", "No other session")
		return
	end
	local index = 1
	for i, session in sessions do
		if session.id == current.id then
			index = i
			break
		end
	end
	local target = sessions[((index - 1 + step) % #sessions) + 1]
	-- Tern's Lua ID encoding truncates large persisted session IDs.
	cx.sessions:switch(target.name)
	remember(cx)
end

tern.command({
	id = "next",
	title = "Next session",
	run = function(cx)
		cycle(cx, 1)
	end,
})

tern.command({
	id = "prev",
	title = "Previous session",
	run = function(cx)
		cycle(cx, -1)
	end,
})

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
