-- Shared helpers for the RPC api modules.

local json = require("api.json")

local M = { json = json }

M.array = json.array
M.object = json.object

-- JSON-RPC reserves -32768..-32000; application errors live below that.
M.PARSE_ERROR      = -32700
M.INVALID_REQUEST  = -32600
M.METHOD_NOT_FOUND = -32601
M.INVALID_PARAMS   = -32602
M.INTERNAL_ERROR   = -32603
M.ENGINE_ERROR     = -32000
M.NO_BUILD         = -32001

--- Raise a structured failure that the dispatcher turns into an RpcError.
--- Anything else that escapes a handler is reported as an engine error with the
--- Lua traceback attached.
function M.fail(code, message, data)
	error({ rpc = true, code = code, message = message, data = data }, 0)
end

function M.invalid(message)
	M.fail(M.INVALID_PARAMS, message)
end

--- Send an unsolicited notification. Notifications carry no id of their own —
--- the request they belong to is named inside `params`, per the schema.
function M.notify(method, params)
	RPC_WRITE(json.encode(M.object{ jsonrpc = "2.0", method = method, params = params }))
end

-- Long blocking work is announced as a matched busy/idle pair sharing a token,
-- so the frontend can show a spinner and take it down on a fact rather than a
-- timer. Scopes nest: `build.load` opens one, and the tree construction inside
-- it opens another.
local busyCount = 0

--- Open a busy scope. Pass the returned handle to `endBusy`.
function M.beginBusy(what)
	busyCount = busyCount + 1
	local scope = { token = "busy-" .. busyCount, what = what, started = RPC_NOW_MS() }
	M.notify("host.busy", M.object{ token = scope.token, what = what, elapsedMs = 0 })
	return scope
end

--- Re-announce an open scope, for work that can report progress as it goes.
function M.tickBusy(scope)
	M.notify("host.busy", M.object{
		token = scope.token,
		what = scope.what,
		elapsedMs = M.round(RPC_NOW_MS() - scope.started, 0),
	})
end

--- Close a busy scope. Must always run, including when the work failed.
function M.endBusy(scope)
	M.notify("host.idle", M.object{
		token = scope.token,
		elapsedMs = M.round(RPC_NOW_MS() - scope.started, 0),
	})
end

--- Round to `dp` decimals. Tree coordinates carry far more precision than the
--- renderer can use, and trimming it roughly halves the geometry payload.
function M.round(v, dp)
	if type(v) ~= "number" then return v end
	local scale = 10 ^ (dp or 2)
	return math.floor(v * scale + 0.5) / scale
end

--- The live build, or a clean error if nothing has been loaded yet.
function M.build()
	if not build or not build.spec then
		M.fail(M.NO_BUILD, "no build loaded; call build.load first")
	end
	return build
end

function M.spec()
	return M.build().spec
end

-- ---------------------------------------------------------------------------
-- spec identity
--
-- PoB identifies a tree variant by its index in `treeTab.specList`, which moves
-- when one is deleted or reordered. The schema promises a stable `SpecId`, so
-- we stamp each spec object with one the first time we see it.

local specCount = 0

function M.specId(spec)
	if not spec.hostSpecId then
		specCount = specCount + 1
		spec.hostSpecId = "spec-" .. specCount
	end
	return spec.hostSpecId
end

--- Index into `treeTab.specList` for a SpecId, or a clean error.
function M.specIndex(id)
	if type(id) ~= "string" then
		M.invalid("spec id must be a string")
	end
	local specList = M.build().treeTab.specList
	for index, spec in ipairs(specList) do
		if M.specId(spec) == id then
			return index, spec
		end
	end
	M.invalid("no such tree variant: " .. id)
end

--- Resolve a node id against the current spec, including cluster-jewel nodes
--- that only exist because a jewel synthesised them.
function M.node(id, what)
	local node = M.spec().nodes[id]
	if not node then
		M.invalid(string.format("%s: no node %s in this tree", what or "node", tostring(id)))
	end
	return node
end

--- Read a list of integers from params, rejecting anything else up front so a
--- bad request never reaches the engine.
function M.nodeIds(value, what)
	if value == nil then return nil end
	if type(value) ~= "table" then
		M.invalid(what .. " must be an array of node ids")
	end
	local out = { }
	for i, id in ipairs(value) do
		if type(id) ~= "number" then
			M.invalid(string.format("%s[%d] is not a node id", what, i))
		end
		out[i] = math.floor(id)
	end
	return out
end

--- PoB strings carry inline colour codes (`^7`, `^xFF0000`); strip them for
--- values that are meant to be read as text.
function M.plain(text)
	if type(text) ~= "string" then return text end
	return (text:gsub("%^%d", ""):gsub("%^x%x%x%x%x%x%x", ""))
end

--- Copy of Build.lua's local `matchFlags`, which decides whether a display stat
--- applies to the current skill. It is not exported, so it has to be mirrored.
function M.matchFlags(reqFlags, notFlags, flags)
	if type(reqFlags) == "string" then reqFlags = { reqFlags } end
	if reqFlags then
		for _, flag in ipairs(reqFlags) do
			if not flags[flag] then return false end
		end
	end
	if type(notFlags) == "string" then notFlags = { notFlags } end
	if notFlags then
		for _, flag in ipairs(notFlags) do
			if flags[flag] then return false end
		end
	end
	return true
end

return M
