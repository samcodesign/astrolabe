-- A minimal stand-in for the `busted` test framework.
--
-- Path of Building's real regression suite runs under busted in CI
-- (`busted --lua=luajit`, with the stale golden-build tests excluded). Those
-- specs are the only independent check that our host drives the engine exactly
-- as PoB does, so we need to run them — but busted is a LuaRocks package and we
-- embed LuaJIT with no rock tree.
--
-- The specs use a small, mechanical slice of the API: 8 structural functions
-- and ~25 assertion forms, all counted from the spec sources. This implements
-- that slice and nothing more.
--
-- Deviation from real busted: `it` bodies run eagerly as they are declared,
-- rather than being collected and run afterwards. Every spec except the
-- excluded golden one is written to work either way.

local M = {
	passed = 0,
	failed = 0,
	pending = 0,
	failures = {},
	currentFile = "?",
}

local frames = {}

local function contextName()
	local parts = {}
	for _, f in ipairs(frames) do
		parts[#parts + 1] = f.name
	end
	return table.concat(parts, " › ")
end

-- ---------------------------------------------------------------------------
-- value formatting and comparison

local function fmt(v)
	local t = type(v)
	if t == "string" then return string.format("%q", v) end
	if t == "table" then
		local n = 0
		for _ in pairs(v) do n = n + 1 end
		return string.format("table(%d)", n)
	end
	return tostring(v)
end

local function deepEqual(a, b)
	if a == b then return true end
	if type(a) ~= "table" or type(b) ~= "table" then return false end
	for k, v in pairs(a) do
		if not deepEqual(v, b[k]) then return false end
	end
	for k in pairs(b) do
		if a[k] == nil then return false end
	end
	return true
end

local function fail(msg)
	error({ __bustedFailure = true, message = msg }, 3)
end

-- ---------------------------------------------------------------------------
-- assertions

local function check(cond, msg)
	if not cond then fail(msg) end
end

local eq = function(expected, actual, message)
	check(expected == actual,
		message or string.format("expected %s, got %s", fmt(expected), fmt(actual)))
end

local same = function(expected, actual, message)
	check(deepEqual(expected, actual),
		message or string.format("expected %s, got %s (deep)", fmt(expected), fmt(actual)))
end

local notEq = function(expected, actual, message)
	check(expected ~= actual,
		message or string.format("expected something other than %s", fmt(expected)))
end

local near = function(expected, actual, tolerance, message)
	tolerance = tolerance or 1e-6
	check(type(actual) == "number" and math.abs(expected - actual) <= tolerance,
		message or string.format("expected %s ± %s, got %s",
			fmt(expected), fmt(tolerance), fmt(actual)))
end

local truthy = function(v, message)
	check(v ~= nil and v ~= false, message or string.format("expected truthy, got %s", fmt(v)))
end

local falsy = function(v, message)
	check(v == nil or v == false, message or string.format("expected falsy, got %s", fmt(v)))
end

local assertTable = {
	-- identity
	equal = eq, equals = eq, are_equal = eq, not_equal = notEq,
	-- deep
	same = same,
	-- truthiness
	truthy = truthy, falsy = falsy,
	is_true = function(v, m) check(v == true, m or string.format("expected true, got %s", fmt(v))) end,
	is_false = function(v, m) check(v == false, m or string.format("expected false, got %s", fmt(v))) end,
	True = function(v, m) check(v == true, m or string.format("expected true, got %s", fmt(v))) end,
	False = function(v, m) check(v == false, m or string.format("expected false, got %s", fmt(v))) end,
	is_truthy = truthy, is_falsy = falsy,
	is_nil = function(v, m) check(v == nil, m or string.format("expected nil, got %s", fmt(v))) end,
	is_not_nil = function(v, m) check(v ~= nil, m or "expected not nil") end,
	-- strings
	matches = function(pattern, s, m)
		check(type(s) == "string" and s:match(pattern) ~= nil,
			m or string.format("expected %s to match %s", fmt(s), fmt(pattern)))
	end,
	-- errors
	has_error = function(fn, expected, m)
		local ok, err = pcall(fn)
		check(not ok, m or "expected the call to raise")
		if expected ~= nil then
			if type(err) == "table" and err.message then err = err.message end
			check(deepEqual(expected, err),
				m or string.format("expected error %s, got %s", fmt(expected), fmt(err)))
		end
	end,
}

assertTable.are = {
	equal = eq, equals = eq, same = same,
	near = near,
	not_false = function(v, m) notEq(false, v, m) end,
	not_equals = notEq, not_equal = notEq,
}
assertTable.are_not = { equal = notEq, equals = notEq, same = function(e, a, m)
	check(not deepEqual(e, a), m or "expected values to differ")
end }
assertTable.is = {
	not_false = function(v, m) notEq(false, v, m) end,
	truthy = truthy, falsy = falsy,
	equal = eq, same = same,
}
assertTable.has_no = {
	errors = function(fn, m)
		local ok, err = pcall(fn)
		check(ok, m or ("expected no error, got " .. tostring(err)))
	end,
}
assertTable.has = { error = assertTable.has_error, errors = assertTable.has_error }
assertTable.near = near

-- busted's `assert` is both a table of matchers and a callable assert().
M.assert = setmetatable(assertTable, {
	__call = function(_, cond, message)
		check(cond, message or "assertion failed")
		return cond
	end,
})

-- ---------------------------------------------------------------------------
-- structure

function M.describe(name, fn)
	local frame = { name = name, befores = {}, afters = {}, teardowns = {} }
	frames[#frames + 1] = frame

	local ok, err = pcall(fn)
	if not ok then
		M.failed = M.failed + 1
		M.failures[#M.failures + 1] = {
			file = M.currentFile,
			name = contextName() .. " (describe body)",
			message = type(err) == "table" and err.message or tostring(err),
		}
	end

	for i = #frame.teardowns, 1, -1 do
		pcall(frame.teardowns[i])
	end
	frames[#frames] = nil
end

function M.it(name, fn)
	if type(fn) ~= "function" then
		M.pending = M.pending + 1
		return
	end

	for _, frame in ipairs(frames) do
		for _, before in ipairs(frame.befores) do
			local ok, err = pcall(before)
			if not ok then
				M.failed = M.failed + 1
				M.failures[#M.failures + 1] = {
					file = M.currentFile,
					name = contextName() .. " › " .. name .. " (before_each)",
					message = type(err) == "table" and err.message or tostring(err),
				}
				return
			end
		end
	end

	local ok, err = pcall(fn)

	for i = #frames, 1, -1 do
		for _, after in ipairs(frames[i].afters) do
			pcall(after)
		end
	end

	if ok then
		M.passed = M.passed + 1
	else
		M.failed = M.failed + 1
		M.failures[#M.failures + 1] = {
			file = M.currentFile,
			name = contextName() .. " › " .. name,
			message = type(err) == "table" and err.message or tostring(err),
		}
	end
end

local function currentFrame()
	return frames[#frames]
end

function M.before_each(fn)
	local f = currentFrame()
	if f then f.befores[#f.befores + 1] = fn else fn() end
end

function M.after_each(fn)
	local f = currentFrame()
	if f then f.afters[#f.afters + 1] = fn end
end

-- `setup` is declared before the its it applies to, so running it now gives the
-- right order. `teardown` must wait for the describe to finish.
function M.setup(fn) pcall(fn) end

function M.teardown(fn)
	local f = currentFrame()
	if f then f.teardowns[#f.teardowns + 1] = fn else pcall(fn) end
end

function M.pending_(name) M.pending = M.pending + 1 end

--- Install into the global environment, the way busted does.
function M.install()
	_G.describe = M.describe
	_G.it = M.it
	_G.before_each = M.before_each
	_G.after_each = M.after_each
	_G.setup = M.setup
	_G.teardown = M.teardown
	_G.pending = M.pending_
	_G.expose = M.describe
	_G.insulate = M.describe
	_G.assert = M.assert
end

return M
