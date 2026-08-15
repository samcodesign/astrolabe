-- stats.compare: "what would this change do?"
--
-- PoB's signature move. Hover a gem in the picker, a quality box, a gem's
-- enable tick or a config option, and it tells you the stat change before you
-- commit to it. All four are the same calculation: capture a baseline, apply
-- the change, run the fast calculator, diff, put everything back.
--
-- **Why this cannot use the override channel.** The tree comparison in
-- `api/stats.lua` passes `{ addNodes, removeNodes }` to the misc calculator and
-- never touches the build. `calcs.initEnv` understands exactly three override
-- keys — nodes in, nodes out, and one replacement item — and nothing else. There
-- is no gem-shaped or config-shaped override, so PoB does the only thing left:
-- it **edits the live build, calculates, and edits it back**
-- (`GemSelectControl.lua:59-103`, `ConfigTab.lua:721-766`, `SkillsTab.lua:911`).
--
-- That makes the failure mode a *corrupted build* rather than a failed request.
-- An error thrown between the edit and the restore leaves a gem the user never
-- chose sitting in their build, and the next save writes it to disk. So every
-- mutation here is split into `apply` and `restore`, the apply and the
-- calculation run inside one `pcall`, and the restore runs from the handler —
-- the same discipline `api/power.lua` uses for the cancellable optimiser.
--
-- It also means these are not reentrant. One at a time, and never while a
-- streaming job holds the engine.

local util = require("api.util")
local skillsApi = require("api.skills")
local configApi = require("api.config")
local A, O = util.array, util.object

local M = { }

-- ---------------------------------------------------------------------------
-- the diff
--
-- Mirrors `buildMode:CompareStatList` (`Build.lua:1877-1919`). It writes into a
-- tooltip, so the logic has to be restated rather than called — but every rule
-- below is its rule, including the ones that look arbitrary.

--- 0.001 is PoB's own threshold. Floating-point noise from re-running the whole
--- calculator is real, and without it half the stat list "changes" every time.
local EPSILON = 0.001

local function compareList(statList, actor, baseOutput, compareOutput)
	local rows = A{ }
	local flags = actor and actor.mainSkill and actor.mainSkill.skillFlags or { }

	for _, statData in ipairs(statList) do
		-- `childStat` rows are sub-fields of a table-valued stat and `SkillDPS`
		-- is a per-skill list; neither subtracts.
		if statData.stat and not statData.childStat and statData.stat ~= "SkillDPS"
			and util.matchFlags(statData.flag, statData.notFlag, flags) then

			local after = compareOutput[statData.stat] or 0
			local before = baseOutput[statData.stat] or 0
			local diff = after - before

			-- FullDPS only exists when some socket group opted into it. If the
			-- speculative pass did not produce one, `after` is 0 and the diff
			-- would read as "loses all your DPS" (`Build.lua:1884-1886`).
			if statData.stat == "FullDPS" and not compareOutput[statData.stat] then
				diff = 0
			end

			local shown = diff > EPSILON or diff < -EPSILON
			if shown and statData.condFunc then
				-- Either side passing is enough: a stat that only becomes
				-- relevant *because* of the change still has to be reported.
				shown = statData.condFunc(after, compareOutput)
					or statData.condFunc(before, baseOutput)
			end

			if shown then
				-- Percent-style stats are stored as fractions. Unlike the
				-- absolute display there is no -100 offset here, because a
				-- constant offset cancels in a subtraction.
				local scale = (statData.pc or statData.mod) and 100 or 1
				local row = O{
					key = statData.stat,
					label = statData.label,
					delta = util.jsonNumber(diff * scale),
					format = statData.fmt,
					better = ((statData.lowerIsBetter and diff < 0)
						or (not statData.lowerIsBetter and diff > 0)) and true or false,
				}
				-- Only some stats are meaningful as a ratio, and a zero on
				-- either side makes one meaningless (`Build.lua:1903`).
				if statData.compPercent and after ~= 0 and before ~= 0 then
					row.percent = util.jsonNumber(after / before * 100 - 100)
				end
				rows[#rows + 1] = row
			end
		end
	end
	return rows
end

--- Player rows, plus minion rows when the main skill has one. PoB shows both
--- under separate headings (`Build.lua:1924-1936`); the minion list is a
--- different stat table read from a different actor, so it cannot be merged.
local function diff(b, baseOutput, compareOutput)
	local env = b.calcsTab.mainEnv
	local result = O{
		stats = compareList(b.displayStats, env.player, baseOutput, compareOutput),
	}
	if env.player.mainSkill and env.player.mainSkill.minion
		and baseOutput.Minion and compareOutput.Minion then
		local minion = compareList(b.minionDisplayStats, env.minion,
			baseOutput.Minion, compareOutput.Minion)
		if #minion > 0 then result.minion = minion end
	end
	return result
end

-- ---------------------------------------------------------------------------
-- the harness

--- Run one speculative calculation. `mutate` returns an `apply`/`restore` pair:
--- it must capture whatever it is about to overwrite *before* returning, so the
--- restore is valid even if the apply itself throws.
local function speculate(b, mutate)
	local calcFunc, calcBase = b.calcsTab:GetMiscCalculator()
	if not calcFunc then
		util.fail(util.ENGINE_ERROR, "the engine has not produced an output yet")
	end

	local apply, restore = mutate()

	-- Editing the live build sets the rebuild flag. The user has not actually
	-- changed anything, so the flag must not survive the peek or the next frame
	-- recalculates for nothing (`ConfigTab.lua:753-756`).
	local buildFlag = b.buildFlag

	local ok, output = pcall(function()
		apply()
		return calcFunc(nil)
	end)

	restore()
	b.buildFlag = buildFlag

	if not ok then
		util.fail(util.ENGINE_ERROR,
			"could not calculate that change: " .. tostring(output))
	end
	return diff(b, calcBase, output)
end

-- ---------------------------------------------------------------------------
-- the changes
--
-- Each returns `apply, restore`.

local function gemSlot(params, what)
	local tab = skillsApi.skillsTab()
	local group = skillsApi.groupAt(tab, params.group)
	local index = math.floor(tonumber(params.gem) or 0)
	if index < 1 then
		util.invalid(what .. " needs a gem index")
	end
	return tab, group, index
end

local function existingGem(params, what)
	local tab, group, index = gemSlot(params, what)
	local gem = group.gemList[index]
	if not gem then
		util.invalid(string.format("no gem %d in this group (it has %d)",
			index, #group.gemList))
	end
	return tab, group, index, gem
end

--- "Selecting this gem will give you:" — what the slot would be worth holding
--- `gemId` instead of whatever is there now, or holding it at all if the slot
--- is the empty one past the end.
---
--- `gemData` is assigned directly rather than going through
--- `ProcessSocketGroup`, exactly as `CalcOutputWithThisGem` does: the resolver
--- is the slow part and the calculator only reads the resolved field. Level is
--- recomputed for the new gem, but quality, count and enabled stay as the user
--- set them — the question is "this gem in this slot", not "a fresh gem".
local function gemChange(b, params)
	local tab, group, index = gemSlot(params, "a gem comparison")
	if index > #group.gemList + 1 then
		util.invalid(string.format(
			"gem index %d is out of range (the group has %d)", index, #group.gemList))
	end
	if type(params.gemId) ~= "string" or not b.data.gems[params.gemId] then
		util.invalid("no such gem: " .. tostring(params.gemId))
	end
	local gemData = b.data.gems[params.gemId]

	local gemList = group.gemList
	local existing = gemList[index]
	-- Only the three fields the apply touches need saving; everything else on
	-- the instance is left alone.
	local saved = existing and {
		gemData = existing.gemData,
		level = existing.level,
		displayEffect = existing.displayEffect,
	} or nil
	-- `initEnv` rebuilds this to describe the *speculative* group, and the
	-- socket-group tooltip reads it (`CalcSetup.lua:1690`, `SkillsTab.lua:1335`).
	local displayGemList = group.displayGemList

	local apply = function()
		local gem = existing
		if not gem then
			gem = {
				quality = tab.defaultGemQuality or 0,
				count = 1,
				enabled = true,
				enableGlobal1 = true,
				enableGlobal2 = true,
				gemId = gemData.id,
				nameSpec = gemData.name,
				skillId = gemData.grantedEffectId,
			}
			gemList[index] = gem
		end
		gem.level = tab:ProcessGemLevel(gemData)
		gem.gemData = gemData
		gem.displayEffect = nil
	end

	local restore = function()
		if saved then
			local gem = gemList[index]
			if gem then
				gem.gemData = saved.gemData
				gem.level = saved.level
				gem.displayEffect = saved.displayEffect
			end
		else
			gemList[index] = nil
		end
		group.displayGemList = displayGemList
	end

	return apply, restore
end

--- One numeric field on an existing gem. PoB only offers this for quality, and
--- only against 20 (`SkillsTab.lua:911-918`); the value is a parameter here
--- because the same mechanism answers "what about level 21?" for free.
local function gemFieldChange(b, params, field, what)
	local _, _, _, gem = existingGem(params, what)
	local value = tonumber(params.value)
	if not value then util.invalid(what .. " takes a numeric value") end
	value = math.floor(value)

	local saved = gem[field]
	return function() gem[field] = value end,
		function() gem[field] = saved end
end

--- "Disabling this gem will give you:" — always the flip of the current state,
--- because that is the only other state a checkbox has.
local function gemEnabledChange(b, params)
	local _, _, _, gem = existingGem(params, "a gem enable comparison")
	local saved = gem.enabled
	return function() gem.enabled = not saved end,
		function() gem.enabled = saved end
end

--- "Toggling this option will give you:".
---
--- Config values live in the active set's `input` map, and the mod list has to
--- be rebuilt around them for the change to reach the calculator at all
--- (`ConfigTab.lua:746-751`) — which is why this one is markedly slower than
--- the gem cases, and why PoB caches it per output revision.
---
--- `clear` unsets rather than zeroing, so a numeric with a placeholder can be
--- compared against what the engine actually falls back to.
local function configChange(b, params)
	local tab = configApi.configTab()
	local set = configApi.activeSet(tab)
	local var = params.var
	if type(var) ~= "string" then
		util.invalid("a config comparison needs a var name")
	end
	local varData = configApi.findVar(var)

	local value
	if params.clear ~= true then
		if params.value == nil then
			util.invalid("a config comparison needs a value, or clear")
		end
		value = configApi.coerce(varData, params.value)
	end

	local saved = set.input[var]
	return function()
			set.input[var] = value
			tab:BuildModList()
		end,
		function()
			set.input[var] = saved
			tab:BuildModList()
		end
end

local CHANGES = {
	gem = gemChange,
	gemEnabled = gemEnabledChange,
	config = configChange,
	gemQuality = function(b, p) return gemFieldChange(b, p, "quality", "a quality comparison") end,
	gemLevel = function(b, p) return gemFieldChange(b, p, "level", "a level comparison") end,
	gemCount = function(b, p) return gemFieldChange(b, p, "count", "a count comparison") end,
}

-- ---------------------------------------------------------------------------
-- the override channel
--
-- Items are the one case that does *not* have to edit the live build. Unlike
-- gems and config, `calcs.initEnv` understands an item-shaped override —
-- `repSlotName` plus `repItem` (`CalcSetup.lua:713-717`) — so the whole
-- apply/restore dance above is unnecessary here, and with it the risk of
-- leaving a foreign item in the build when a calculation throws.

--- Run one speculative calculation through an override.
---
--- No restore, because nothing was mutated. That is the entire difference from
--- `speculate`, and it is why item comparisons cannot corrupt a build.
local function speculateOverride(b, override)
	local calcFunc, calcBase = b.calcsTab:GetMiscCalculator()
	if not calcFunc then
		util.fail(util.ENGINE_ERROR, "the engine has not produced an output yet")
	end
	local ok, output = pcall(calcFunc, override)
	if not ok then
		util.fail(util.ENGINE_ERROR,
			"could not calculate that change: " .. tostring(output))
	end
	return diff(b, calcBase, output)
end

--- "Equipping this will give you:".
---
--- Three cases, and picking the wrong one silently compares nothing:
---
---   * **A flask** is not swapped into a slot, it is *toggled* —
---     `{ toggleFlask = item }`. A tincture likewise
---     (`ItemDBControl.lua:247`). Passing `repItem` for either produces a diff
---     of zero rows and looks like "this changes nothing".
---   * **An empty slot** is `repSlotName` with no `repItem`; `initEnv` reads
---     the missing field as nil and the slot comes out bare.
---   * **Everything else** is the ordinary replacement. Note that a two-hander
---     emptying the off-hand is handled by `initEnv` itself
---     (`CalcSetup.lua:715-717`) — do not pre-empt it here.
local function itemOverride(b, params)
	local tab = b.itemsTab
	if not tab then
		util.fail(util.ENGINE_ERROR, "this build has no items tab")
	end

	-- Clearing a slot: no item to look up, so the slot is all that is needed.
	if params.item == false or params.item == nil then
		if type(params.slot) ~= "string" or not tab.slots[params.slot] then
			util.invalid("no such slot: " .. tostring(params.slot))
		end
		return { repSlotName = params.slot }
	end

	local id = math.floor(tonumber(params.item) or 0)
	local item = tab.items[id]
	if not item then
		util.invalid("no such item: " .. tostring(params.item))
	end

	local base = item.base or { }
	if base.flask then return { toggleFlask = item } end
	if base.tincture then return { toggleTincture = item } end

	local slot = params.slot
	if type(slot) ~= "string" or not tab.slots[slot] then
		util.invalid("no such slot: " .. tostring(slot))
	end
	return { repSlotName = slot, repItem = item }
end

local OVERRIDES = {
	item = itemOverride,
}

M.methods = { }

M.methods["stats.compare"] = function(params)
	params = params or { }
	local change = params.change
	if type(change) ~= "table" then
		util.invalid("stats.compare needs a change object")
	end

	local b = util.build()

	local override = OVERRIDES[change.kind]
	if override then
		return speculateOverride(b, override(b, change))
	end

	local build = CHANGES[change.kind]
	if not build then
		util.invalid("cannot compare a change of kind " .. tostring(change.kind))
	end
	return speculate(b, function() return build(b, change) end)
end

return M
