-- stats.get, and the shared DisplayStat projection the tree methods return.
--
-- The rows come from PoB's own `Modules/BuildDisplayStats`, filtered the same
-- way Build.lua:AddDisplayStatList filters them: a stat only appears if the
-- current main skill's flags allow it and its condFunc passes. Nothing here
-- decides *which* stats matter — that is the engine's call, not ours.

local util = require("api.util")
local A, O = util.array, util.object

local m_huge = math.huge

local M = { }

--- PoB colours are inline escapes: `^xRRGGBB` or `^N` for a palette index.
--- Only the hex form carries information a web frontend can use.
local function colour(code)
	if type(code) ~= "string" then return nil end
	local hex = code:match("^%^x(%x%x%x%x%x%x)$")
	return hex and ("#" .. hex) or nil
end

--- FormatStat scales percentage-style stats before printing them, so the value
--- we hand out has to be scaled the same way or `format` will not apply to it.
local function displayValue(statData, raw)
	if type(raw) ~= "number" then return nil end
	local scale = (statData.pc or statData.mod) and 100 or 1
	local offset = statData.mod and 100 or 0
	return raw * scale - offset
end

local function jsonNumber(v)
	if v == m_huge then return "Infinity" end
	if v == -m_huge then return "-Infinity" end
	if v ~= v then return nil end
	return v
end

--- Walk the display stat definitions against one actor's output, calling
--- `emit(statData, key, value)` for each row that PoB would show.
local function eachVisibleStat(b, statList, actor, emit)
	local flags = actor.mainSkill and actor.mainSkill.skillFlags or { }
	for _, statData in ipairs(statList) do
		if statData.stat and not statData.hideStat
			and util.matchFlags(statData.flag, statData.notFlag, flags) then
			local value = actor.output[statData.stat]
			if value and statData.childStat then
				value = value[statData.childStat]
			end
			-- SkillDPS is a list of per-skill rows, not a scalar; it has its own
			-- presentation in PoB and does not fit the DisplayStat shape.
			if type(value) == "number" then
				local show
				if statData.condFunc then
					show = statData.condFunc(value, actor.output) and true or false
				else
					show = value ~= 0
				end
				if show then
					emit(statData, statData.stat .. (statData.childStat or ""), value)
				end
			end
		end
	end
end

--- The stat panel for the live build, optionally filtered and/or compared.
--- `compareTo` is an allocation (a node id list) to measure the current build
--- against; each row then carries `delta` = current - that allocation.
function M.list(keys, compareTo)
	local b = util.build()
	local actor = b.calcsTab.mainEnv.player
	if not actor then
		util.fail(util.ENGINE_ERROR, "the engine has not produced an output yet")
	end

	local wanted
	if keys then
		wanted = { }
		for _, key in ipairs(keys) do wanted[key] = true end
	end

	local baseline
	if compareTo then
		baseline = M.outputForAllocation(b, compareTo)
	end

	local stats = A{ }
	eachVisibleStat(b, b.displayStats, actor, function(statData, key, raw)
		if wanted and not wanted[key] then return end
		local row = O{
			key = key,
			label = statData.label,
			value = jsonNumber(displayValue(statData, raw)),
			format = statData.fmt,
			colour = colour(statData.color),
		}
		if baseline then
			local before = baseline[statData.stat]
			if before and statData.childStat then before = before[statData.childStat] end
			if type(before) == "number" then
				local delta = displayValue(statData, raw) - displayValue(statData, before)
				row.delta = jsonNumber(delta)
			end
		end
		stats[#stats + 1] = row
	end)
	return stats
end

--- Output the build would have with exactly `nodeIds` allocated, expressed as
--- an add/remove delta against the live tree so PoB's fast misc calculator can
--- do it without rebuilding a whole spec.
function M.outputForAllocation(b, nodeIds)
	local spec = b.spec
	local target = { }
	for _, id in ipairs(nodeIds) do
		target[util.node(id, "compareTo")] = true
	end

	local addNodes, removeNodes = { }, { }
	for node in pairs(target) do
		if not node.alloc then addNodes[node] = true end
	end
	for _, node in pairs(spec.allocNodes) do
		-- Class and ascendancy start nodes are structural, never spent points.
		if not target[node] and node.type ~= "ClassStart" and node.type ~= "AscendClassStart" then
			removeNodes[node] = true
		end
	end

	local calcFunc = b.calcsTab:GetMiscCalculator()
	return calcFunc({ addNodes = addNodes, removeNodes = removeNodes })
end

M.methods = { }

M.methods["stats.get"] = function(params)
	params = params or { }
	local keys
	if params.keys ~= nil then
		if type(params.keys) ~= "table" then util.invalid("keys must be an array") end
		keys = params.keys
	end
	local compareTo = util.nodeIds(params.compareTo, "compareTo")
	return O{ stats = M.list(keys, compareTo) }
end

return M
