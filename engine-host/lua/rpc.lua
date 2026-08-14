-- JSON-RPC 2.0 dispatcher.
--
-- Rust hands us one line at a time and takes back a "still busy" flag; every
-- other decision is made here. Two rules shape the code:
--
--   * The process must never die. Any error inside a method — including one
--     raised deep in PoB's engine — comes back as an RpcError carrying the Lua
--     traceback in `data`.
--   * Streaming methods answer immediately and do their work in `RPC_STEP`,
--     so a `tree.powerCancel` sent while a heatmap is running is actually read.

-- The api modules require each other; putting the host's lua/ on package.path
-- means `require` memoises them instead of re-running each file per importer.
if not package.path:find(HOST_LUA, 1, true) then
	package.path = HOST_LUA .. "/?.lua;" .. package.path
end

local util  = require("api.util")
local json  = util.json
local A, O  = util.array, util.object

-- Must run before anything builds a spec: connector geometry is derived from
-- asset dimensions, which the headless image stubs report as 1x1.
require("api.images").install()

local buildApi = require("api.build")
local statsApi = require("api.stats")
local treeApi  = require("api.tree")
local powerApi = require("api.power")
local specApi  = require("api.spec")

local methods = { }
for _, module in ipairs({ buildApi, statsApi, treeApi, powerApi, specApi }) do
	for name, fn in pairs(module.methods) do
		methods[name] = fn
	end
end

--- Methods whose real cost is measured in seconds. Each gets a `host.busy` /
--- `host.idle` pair around it, so the frontend takes its spinner down on a
--- fact rather than a timer. Loading a tree version opens its own nested scope
--- from `api.images`, since that is the five-second part.
local SLOW = {
	["build.load"] = "loading build",
	["build.setClass"] = "rebuilding the tree",
	["tree.geometry"] = "building tree geometry",
	["spec.activate"] = "switching tree variant",
	["spec.create"] = "creating tree variant",
}

local function respond(id, result)
	RPC_WRITE(json.encode(O{ jsonrpc = "2.0", id = id, result = result }))
end

local function respondError(id, code, message, data)
	local err = O{ code = code, message = message }
	if data then err.data = data end
	RPC_WRITE(json.encode(O{ jsonrpc = "2.0", id = id, error = err }))
end

--- Turn whatever escaped a handler into an RpcError. A table with `rpc = true`
--- is a deliberate failure raised by util.fail; anything else is the engine
--- breaking, and the traceback is the only useful thing we can say about it.
local function toError(err)
	if type(err) == "table" and err.rpc then
		return err.code, err.message, err.data
	end
	local message = type(err) == "table" and tostring(err.message or err.msg) or tostring(err)
	return util.ENGINE_ERROR, message, nil
end

--- Call `fn` with a traceback handler attached, so the `data` field of an
--- engine error shows where in PoB it happened rather than just the last line.
local function invoke(fn, params, id)
	local traceback
	local ok, result = xpcall(function()
		return fn(params, id)
	end, function(err)
		if type(err) == "table" and err.rpc then
			return err
		end
		traceback = debug.traceback(tostring(err), 2)
		return err
	end)
	if ok then
		return true, result
	end
	local code, message, data = toError(result)
	return false, nil, code, message, data or traceback
end

--- Handle one line. Returns true if a streaming job is still running.
function RPC_HANDLE(line)
	if not line or not line:match("%S") then
		return powerApi.busy()
	end

	local request, decodeErr = json.decode(line)
	if type(request) ~= "table" then
		respondError(nil, util.PARSE_ERROR, "could not parse request", tostring(decodeErr))
		return powerApi.busy()
	end

	local id = request.id
	if type(id) ~= "number" then
		respondError(nil, util.INVALID_REQUEST, "request needs a numeric id")
		return powerApi.busy()
	end
	if type(request.method) ~= "string" then
		respondError(id, util.INVALID_REQUEST, "request needs a method name")
		return powerApi.busy()
	end

	local fn = methods[request.method]
	if not fn then
		respondError(id, util.METHOD_NOT_FOUND, "no such method: " .. request.method)
		return powerApi.busy()
	end

	-- The busy scope is closed on every path, including a failed method: an
	-- unmatched host.busy would leave the frontend spinning forever.
	local scope = SLOW[request.method] and util.beginBusy(SLOW[request.method])
	local ok, result, code, message, data = invoke(fn, request.params, id)
	if scope then util.endBusy(scope) end

	if ok then
		respond(id, result)
	else
		respondError(id, code, message, data)
	end
	return powerApi.busy()
end

--- Advance a streaming job by one chunk. Returns true while work remains.
function RPC_STEP()
	return powerApi.step()
end

-- Exposed for the test harness, which drives the same dispatcher in-process
-- rather than over a pipe.
RPC_METHODS = methods
