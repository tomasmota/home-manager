--!strict

local function cycle(cx: WindowCx, direction: number)
	local sessions = cx.sessions:list()
	if #sessions < 2 then
		return
	end

	for index, session in sessions do
		if session.current then
			local target = (index - 1 + direction) % #sessions + 1
			cx.sessions:switch(sessions[target].id)
			return
		end
	end
end

tern.command({
	id = "next",
	title = "Next session",
	run = function(cx)
		cycle(cx, 1)
	end,
})

tern.command({
	id = "previous",
	title = "Previous session",
	run = function(cx)
		cycle(cx, -1)
	end,
})
