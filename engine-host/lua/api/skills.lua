-- skills.mainSelection / build.setMainSkill: which skill the stats describe.
--
-- A build's stat panel reports one skill, and until now nothing said which. The
-- engine has always known — `build.mainSocketGroup` picks a socket group and
-- `mainActiveSkill` picks a skill within it — but neither was reachable, so an
-- imported character showed a DPS number with no way to attribute or change it.
--
-- The projection mirrors `buildMode:RefreshSkillSelectControls`
-- (`Modules/Build.lua:1549-1647`) and the mutations mirror the dropdown
-- handlers above it (`:473-561`). PoB decides per-skill which of the six
-- controls even apply — a part selector only for multi-part skills, stages only
-- for skills that have them, a minion picker only for minion skills — so each
-- one is reported as present-or-absent rather than as a value the client has to
-- know when to ignore.
--
-- PoB threads a `suffix` through all of this so the Calcs tab can hold a second,
-- independent selection. We only ever want the main one, which is suffix "".

local util = require("api.util")
local buildApi = require("api.build")
local A, O = util.array, util.object

local M = { }

--- The socket group the stats currently come from, and the active skill inside
--- it. Both indices are 1-based and may point past the end of a list that has
--- since shrunk, which PoB tolerates by falling back to 1.
local function currentGroup(b)
	local list = b.skillsTab.socketGroupList
	local index = b.mainSocketGroup or 1
	return list[index], index, list
end

local function currentSkill(group)
	if not group then return nil, 1 end
	local index = group.mainActiveSkill or 1
	return group.displaySkillList and group.displaySkillList[index], index
end

--- `srcInstance` is the gem the active skill came from; every per-skill setting
--- (part, stages, mines, minion) is stored on it rather than on the skill,
--- because the skill object is rebuilt on every recalculation.
local function srcInstanceOf(activeSkill)
	return activeSkill and activeSkill.activeEffect and activeSkill.activeEffect.srcInstance or nil
end

-- ---------------------------------------------------------------------------
-- projection

--- Skills granted by an item explode source are labelled by their source rather
--- than their own name (`Build.lua:1571-1574`), which is how two copies of the
--- same granted effect stay tellable apart.
local function skillLabel(activeSkill)
	local src = activeSkill.activeEffect.srcInstance.explodeSource
	local name = src and (src.name or src.dn)
	if name then return "From " .. util.plain(name) end
	return util.plain(activeSkill.activeEffect.grantedEffect.name)
end

local function skillOptions(group)
	local options = A{ }
	for i, activeSkill in ipairs(group.displaySkillList or { }) do
		options[i] = O{ index = i, label = skillLabel(activeSkill) }
	end
	return options
end

--- Everything that depends on which skill is active: the part selector, the
--- stage and mine counts, and the minion pickers. Returns the fields to merge
--- into the response, or nothing when the skill has none of them.
local function skillDetail(b, activeSkill, out)
	local activeEffect = activeSkill and activeSkill.activeEffect
	if not activeEffect then return end
	local src = activeEffect.srcInstance
	local granted = activeEffect.grantedEffect
	local parts = granted.parts

	-- A part selector only exists for skills with more than one part; a skill
	-- with a single part has nothing to choose (`Build.lua:1589`).
	local partIndex = 1
	if parts and #parts > 1 then
		local options = A{ }
		for i, part in ipairs(parts) do
			options[i] = O{ index = i, label = util.plain(part.name) }
		end
		partIndex = src.skillPart or 1
		out.part = O{ options = options, index = partIndex }
	end

	-- Stages come from two unrelated places: a multi-part skill whose *selected*
	-- part has stages, or a single-part skill flagged multiStage. PoB checks them
	-- separately and they are mutually exclusive (`:1596`, `:1605`).
	if parts and #parts > 1 and parts[partIndex] and parts[partIndex].stages then
		out.stageCount = src.skillStageCount
			or activeSkill.skillData.stagesMax
			or parts[partIndex].stagesMin
			or 1
	elseif activeSkill.skillFlags.multiStage and not (parts and #parts > 1) then
		out.stageCount = src.skillStageCount
			or activeSkill.skillData.stagesMax
			or activeSkill.skillData.stagesMin
			or 1
	end

	if activeSkill.skillFlags.mine then
		-- PoB leaves this blank rather than defaulting it (`:1603`), because an
		-- unset mine count means "however many the config says", not zero.
		out.mineCount = src.skillMineCount
	end

	if activeSkill.skillFlags.disable then return end
	if not (granted.minionList or activeSkill.minionList[1]) then return end

	if granted.minionHasItemSet then
		-- Animate Guardian and friends: the "minion" is an item set, not a
		-- creature (`:1611-1619`).
		local options = A{ }
		for i, itemSetId in ipairs(b.itemsTab.itemSetOrderList) do
			local itemSet = b.itemsTab.itemSets[itemSetId]
			options[i] = O{ id = itemSetId, label = util.plain(itemSet.title or "Default Item Set") }
		end
		out.minion = O{
			kind = "itemSet",
			options = options,
			id = src.skillMinionItemSet or (options[1] and options[1].id) or nil,
			enabled = #options > 1,
		}
	else
		local options = A{ }
		for i, minionId in ipairs(activeSkill.minionList) do
			options[i] = O{ id = minionId, label = util.plain(b.data.minions[minionId].name) }
		end
		out.minion = O{
			kind = "minion",
			options = options,
			id = src.skillMinion or (options[1] and options[1].id) or nil,
			enabled = #options > 1,
			-- An empty list here is the spectre case: the skill takes minions but
			-- the build has none, which PoB says in the dropdown itself (`:1641`).
			note = (#options == 0) and "No spectres in build" or nil,
		}
	end

	if activeSkill.minion then
		local options = A{ }
		for i, minionSkill in ipairs(activeSkill.minion.activeSkillList) do
			options[i] = O{ index = i, label = util.plain(minionSkill.activeEffect.grantedEffect.name) }
		end
		out.minionSkill = O{
			options = options,
			index = src.skillMinionSkill or 1,
			enabled = #options > 1,
		}
	end
end

function M.selection()
	local b = util.build()
	local group, groupIndex, groupList = currentGroup(b)

	local groups = A{ }
	for i, socketGroup in ipairs(groupList) do
		groups[i] = O{ index = i, label = util.plain(socketGroup.displayLabel or "") }
	end

	-- No socket groups at all is a real state, not an error: a build started from
	-- nothing has no gems yet. PoB shows a placeholder and hides everything below
	-- it (`Build.lua:1557-1564`).
	if #groups == 0 then
		return O{ groups = groups, groupIndex = 1, empty = true }
	end

	local out = O{ groups = groups, groupIndex = groupIndex, empty = false }
	if not group then return out end

	local activeSkill, skillIndex = currentSkill(group)
	out.skill = O{
		options = skillOptions(group),
		index = skillIndex,
		enabled = #(group.displaySkillList or { }) > 1,
	}
	skillDetail(b, activeSkill, out)
	return out
end

-- ---------------------------------------------------------------------------
-- socket groups and gems
--
-- The data model is flat, which is why this is the smaller of the two editing
-- jobs: a socket group is `{ label, slot, enabled, includeInFullDPS, gemList }`
-- and a gem is seven scalar fields (`SkillsTab.lua:768-777`). Everything hard —
-- resolving a name to a granted effect, validating the level against the gem's
-- natural maximum, deriving stat requirements and the socket colour — is done
-- by `ProcessSocketGroup` (`:1134-1207`). We mutate the list and call it.

--- PoB's own slot list (`SkillsTab.lua:13-27`). A group assigned to a slot is
--- socketed in that item, which is what links gem colours to sockets.
local SLOTS = {
	"Weapon 1", "Weapon 2", "Weapon 1 Swap", "Weapon 2 Swap",
	"Helmet", "Body Armour", "Gloves", "Boots",
	"Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt",
}

local function skillsTab()
	local b = util.build()
	if not b.skillsTab then
		util.fail(util.ENGINE_ERROR, "this build has no skills tab")
	end
	return b.skillsTab
end

--- Which socket group each skill set had selected, so switching away and back
--- returns you to the skill you were looking at. Host-side only: PoB's build
--- format has no per-set field for this, and its own answer — clamp the index
--- down and forget — silently loses the selection.
local mainGroupPerSet = { }

local function groupAt(tab, index, what)
	if type(index) ~= "number" then
		util.invalid((what or "group") .. " must be a number")
	end
	local group = tab.socketGroupList[math.floor(index)]
	if not group then
		util.invalid(string.format("no socket group %d (build has %d)",
			math.floor(index), #tab.socketGroupList))
	end
	return group
end

-- `api.compare` resolves the same group and gem indices this module's mutations
-- take, so it borrows the same validation rather than growing its own.
M.groupAt = groupAt
M.skillsTab = skillsTab

--- One gem, as the client needs it: what the user typed, what it resolved to,
--- and why it did not resolve if it did not.
local function gemEntry(i, gem)
	local granted = gem.grantedEffect or (gem.gemData and gem.gemData.grantedEffect)
	local entry = O{
		index = i,
		nameSpec = util.plain(gem.nameSpec or ""),
		gemId = gem.gemId,
		level = gem.level or 1,
		quality = gem.quality or 0,
		enabled = gem.enabled ~= false,
		-- PoB's two "also apply this outside the group" flags, which is how a
		-- support in one group can affect another (`SkillsTab.lua:773-774`).
		enableGlobal1 = gem.enableGlobal1 ~= false,
		enableGlobal2 = gem.enableGlobal2 ~= false,
		count = gem.count or 1,
		support = granted and granted.support or false,
	}
	-- Requirements only exist once the gem resolved, and only for real gems —
	-- a skill granted by an item has no gem to require anything.
	if gem.reqLevel then
		entry.reqLevel = gem.reqLevel
		entry.reqStr = gem.reqStr
		entry.reqDex = gem.reqDex
		entry.reqInt = gem.reqInt
	end
	if gem.gemData then
		entry.name = util.plain(gem.gemData.name)
		entry.maxLevel = gem.gemData.naturalMaxLevel
		entry.tags = util.plain(gem.gemData.tagString or "")
		-- Only a resolved gem sits in a socket. Item-granted skills have no
		-- gem and no socket, and `ProcessSocketGroup` leaves the field nil on
		-- them until some later pass happens to set it — reporting that made
		-- the flag appear and disappear for a group the user cannot edit.
		if gem.matchesSocket ~= nil then entry.matchesSocket = gem.matchesSocket end
	end

	-- A Vaal gem grants two effects and each half can be toggled independently
	-- (`SkillsTab.lua:1021-1030`). The names are the checkbox labels, so send
	-- them rather than making the client guess which halves exist.
	local effects = gem.gemData and gem.gemData.grantedEffectList
	if gem.gemData and gem.gemData.vaalGem and effects then
		local toggles = A{ }
		for i = 1, 2 do
			local effect = effects[i]
			if effect and not effect.support then
				toggles[#toggles + 1] = O{ index = i, name = util.plain(effect.name) }
			end
		end
		if #toggles > 0 then entry.globalEffects = toggles end
	end

	-- `count` scales the skill's DPS by a scalar — totems, mines, shotgunning.
	-- PoB shows it only when the gem grants a usable active effect
	-- (`SkillsTab.lua:983-994`); on a plain support it means nothing.
	local list = effects or { gem.grantedEffect }
	for i, effect in ipairs(list) do
		if effect and not effect.support and not effect.unsupported
			and (not effect.hasGlobalEffect or gem["enableGlobal" .. i]) then
			entry.showCount = true
			break
		end
	end
	-- The socket colour a granted effect wants: 1 str, 2 dex, 3 int
	-- (`SkillsTab.lua:1185-1192`).
	if granted and granted.color then
		entry.colour = ({ "R", "G", "B" })[granted.color]
	end
	-- A gem that did not resolve keeps the text the user typed and says why,
	-- rather than vanishing.
	if gem.errMsg then entry.error = util.plain(gem.errMsg) end
	return entry
end

local function groupEntry(tab, i, group)
	local gems = A{ }
	for gi, gem in ipairs(group.gemList) do
		gems[gi] = gemEntry(gi, gem)
	end
	return O{
		index = i,
		label = util.plain(group.label or ""),
		-- Derived during a recalculation from the group's active skills
		-- (`CalcSetup.lua:1794-1803`), so it is only meaningful after one.
		displayLabel = util.plain(group.displayLabel or ""),
		slot = group.slot or nil,
		enabled = group.enabled ~= false,
		-- Set during a calculation from the slot's weapon set
		-- (`CalcSetup.lua:1504`): a group socketed in the weapon set that is not
		-- currently active is inert, however "enabled" it looks. PoB labels it
		-- `(Disabled)` (`SkillListControl.lua:76-80`). Absent before the first
		-- calculation, which is not the same as false.
		slotEnabled = group.slotEnabled ~= false,
		includeInFullDPS = group.includeInFullDPS or false,
		count = group.groupCount or 1,
		mainActiveSkill = group.mainActiveSkill or 1,
		-- Groups that came from an item rather than the user cannot be edited;
		-- PoB hides the delete button for them (`SkillsTab.lua:750`).
		fromItem = group.source ~= nil,
		-- The support imbued into this group's item slot, by name. Two fields
		-- have to agree for it to apply — see `skills.setImbuedSupport` — and
		-- this is the one that persists, so it is the one worth reporting.
		imbuedSupport = group.imbuedSupport and util.plain(group.imbuedSupport) or nil,
		gems = gems,
	}
end

function M.list()
	local b = util.build()
	local tab = b.skillsTab

	local groups = A{ }
	for i, group in ipairs(tab.socketGroupList) do
		groups[i] = groupEntry(tab, i, group)
	end

	local slots = A{ }
	for i, name in ipairs(SLOTS) do
		slots[i] = name
	end

	local sets = A{ }
	for i, id in ipairs(tab.skillSetOrderList or { }) do
		local set = tab.skillSets[id]
		sets[i] = O{ id = id, title = util.plain(set and set.title or "Default") }
	end

	return O{
		groups = groups,
		slots = slots,
		sets = sets,
		activeSet = tab.activeSkillSetId,
		mainGroup = b.mainSocketGroup or 1,
	}
end

-- ---------------------------------------------------------------------------
-- methods

M.methods = { }

M.methods["skills.mainSelection"] = function()
	return M.selection()
end

M.methods["skills.list"] = function()
	return M.list()
end

--- Every gem that can be socketed.
---
--- Sent once and cached by the client: fixed for a given game-data version.
--- The client does its own matching over this, which is what
--- `GemSelectControl` does with the same list.
---
--- Filtered as `PopulateGemList` filters it (`GemSelectControl.lua:105-135`).
--- We previously dropped only `unsupported`, which meant offering gems PoB
--- never shows anyone — picking one is a dead end the user cannot diagnose.
M.methods["skills.gemCatalogue"] = function(params)
	params = params or { }
	local b = util.build()
	-- Legacy gems are hidden by default, as in PoB. Exposed as a parameter
	-- rather than a hardcoded filter so the client can offer the toggle.
	local showLegacy = params.showLegacy == true
	-- Imbued supports are a narrower set than "any support": PoB excludes
	-- exceptional and awakened ones, and any support that also grants an active
	-- skill (`GemSelectControl.lua:117-124`).
	local imbuedOnly = params.imbued == true

	local gems = A{ }
	for gemId, gem in pairs(b.data.gems) do
		local granted = gem.grantedEffect
		local tagString = gem.tagString or ""
		-- "Exceptional" covers both the tagged ones and awakened gems, which
		-- PoB identifies as a legacy gem that is the plus-version of another
		-- (`GemSelectControl.lua:117`).
		local awakened = granted and granted.legacy and granted.plusVersionOf
		local exceptional = (awakened or tagString:match("Exceptional")) and true or false

		local hidden = not gem.name
			or not granted
			-- Rejected on selection anyway (`SkillsTab.lua:1178-1181`).
			or granted.unsupported
			-- PoB never lists these to anyone (`GemSelectControl.lua:114`).
			or granted.hideFromGemList
			or (granted.legacy and not showLegacy)

		if not hidden and imbuedOnly then
			hidden = not granted.support
				or exceptional
				or (gem.secondaryGrantedEffect and not gem.secondaryGrantedEffect.support) and true or false
		end

		if not hidden then
			gems[#gems + 1] = O{
				id = gemId,
				name = util.plain(gem.name),
				support = granted.support or false,
				exceptional = exceptional,
				legacy = granted.legacy or false,
				colour = granted.color and ({ "R", "G", "B" })[granted.color] or nil,
				tags = util.plain(tagString),
				maxLevel = gem.naturalMaxLevel,
			}
		end
	end
	-- `data.gems` is keyed by metadata path, so `pairs` order is arbitrary and
	-- would differ between runs. Sort so the client's list is stable.
	table.sort(gems, function(a, b2) return a.name < b2.name end)
	return O{ gems = gems }
end

--- Recalculate and return the refreshed skill list with it.
---
--- `applied()` is what rebuilds `displayLabel` and re-resolves every gem, so
--- the list has to be read *after* it or it describes the previous state.
local function appliedWithSkills()
	local result = buildApi.applied()
	result.skills = M.list()
	result.mainSkill = M.selection()
	return result
end

M.methods["skills.addGroup"] = function(params)
	params = params or { }
	local tab = skillsTab()
	if params.label ~= nil and type(params.label) ~= "string" then
		util.invalid("label must be a string")
	end
	-- Same shape PoB creates for an imported group (`SkillsTab.lua:684`).
	local group = { label = params.label or "", enabled = true, gemList = { } }
	if params.slot ~= nil then
		if not isValueInArray(SLOTS, params.slot) then
			util.invalid("no such item slot: " .. tostring(params.slot))
		end
		group.slot = params.slot
	end
	table.insert(tab.socketGroupList, group)
	tab:AddUndoState()
	local result = appliedWithSkills()
	result.addedGroup = #tab.socketGroupList
	return result
end

M.methods["skills.setGroup"] = function(params)
	params = params or { }
	local tab = skillsTab()
	local group = groupAt(tab, params.group)

	if params.label ~= nil then
		if type(params.label) ~= "string" then util.invalid("label must be a string") end
		group.label = params.label
	end
	if params.slot ~= nil then
		-- Explicit false clears the assignment, which is PoB's "None" entry.
		if params.slot == false then
			group.slot = nil
		elseif isValueInArray(SLOTS, params.slot) then
			group.slot = params.slot
		else
			util.invalid("no such item slot: " .. tostring(params.slot))
		end
	end
	if params.enabled ~= nil then
		if type(params.enabled) ~= "boolean" then util.invalid("enabled must be a boolean") end
		group.enabled = params.enabled
	end
	if params.includeInFullDPS ~= nil then
		if type(params.includeInFullDPS) ~= "boolean" then
			util.invalid("includeInFullDPS must be a boolean")
		end
		group.includeInFullDPS = params.includeInFullDPS
	end
	if params.count ~= nil then
		group.groupCount = math.max(1, math.floor(tonumber(params.count) or 1))
	end

	tab:AddUndoState()
	return appliedWithSkills()
end

M.methods["skills.deleteGroup"] = function(params)
	params = params or { }
	local b = util.build()
	local tab = b.skillsTab
	local index = math.floor(params.group or 0)
	groupAt(tab, index)

	table.remove(tab.socketGroupList, index)
	-- The main-skill pointer is an index into this list, so deleting below it
	-- would silently repoint the stat panel at a different skill.
	local main = b.mainSocketGroup or 1
	if main > index then
		b.mainSocketGroup = main - 1
	elseif main == index then
		b.mainSocketGroup = math.max(1, math.min(main, #tab.socketGroupList))
	end

	tab:AddUndoState()
	return appliedWithSkills()
end

--- Add or change one gem.
---
--- A `gem` index one past the end appends, which is how PoB's own empty last
--- row works (`SkillsTab.lua:763-778`) — there is no separate "add" action.
M.methods["skills.setGem"] = function(params)
	params = params or { }
	local b = util.build()
	local tab = b.skillsTab
	local group = groupAt(tab, params.group)

	if group.source then
		util.invalid("this socket group comes from an item and cannot be edited")
	end

	local index = math.floor(tonumber(params.gem) or 0)
	if index < 1 or index > #group.gemList + 1 then
		util.invalid(string.format(
			"gem index %d is out of range (the group has %d, append with %d)",
			index, #group.gemList, #group.gemList + 1))
	end

	local gem = group.gemList[index]
	local isNew = gem == nil
	if isNew then
		if params.gemId == nil then
			util.invalid("adding a gem needs a gemId")
		end
		gem = {
			nameSpec = "", level = 1, quality = 0, enabled = true,
			enableGlobal1 = true, enableGlobal2 = true, count = 1, new = true,
		}
		group.gemList[index] = gem
	end

	if params.gemId ~= nil then
		if type(params.gemId) ~= "string" or not b.data.gems[params.gemId] then
			util.invalid("no such gem: " .. tostring(params.gemId))
		end
		gem.gemId = params.gemId
		-- Clearing skillId matters: it takes priority over gemId in
		-- `ProcessSocketGroup` (`:1151`), so leaving a stale one pins the gem to
		-- the old skill and the change appears to do nothing.
		gem.skillId = nil
	end

	for name, field in pairs({ level = "level", quality = "quality", count = "count" }) do
		if params[name] ~= nil then
			local n = tonumber(params[name])
			if not n then util.invalid(name .. " must be a number") end
			gem[field] = math.max(name == "quality" and 0 or 1, math.floor(n))
		end
	end
	for _, flag in ipairs({ "enabled", "enableGlobal1", "enableGlobal2" }) do
		if params[flag] ~= nil then
			if type(params[flag]) ~= "boolean" then
				util.invalid(flag .. " must be a boolean")
			end
			gem[flag] = params[flag]
		end
	end

	-- Resolve before asking for a default level: `ProcessSocketGroup` is what
	-- populates `gemData`, and `ProcessGemLevel` needs it.
	tab:ProcessSocketGroup(group)
	if isNew and gem.gemData then
		gem.level = tab:ProcessGemLevel(gem.gemData)
		gem.naturalMaxLevel = gem.level
	end

	tab:AddUndoState()
	return appliedWithSkills()
end

M.methods["skills.deleteGem"] = function(params)
	params = params or { }
	local tab = skillsTab()
	local group = groupAt(tab, params.group)
	if group.source then
		util.invalid("this socket group comes from an item and cannot be edited")
	end
	local index = math.floor(tonumber(params.gem) or 0)
	if not group.gemList[index] then
		util.invalid(string.format("no gem %d in this group (it has %d)",
			index, #group.gemList))
	end

	table.remove(group.gemList, index)
	-- Same hazard as deleting a group: the active-skill pointer is an index
	-- into the list this gem feeds.
	if group.mainActiveSkill and group.mainActiveSkill > 1 then
		group.mainActiveSkill = math.max(1, group.mainActiveSkill - 1)
	end

	tab:ProcessSocketGroup(group)
	tab:AddUndoState()
	return appliedWithSkills()
end

-- ---------------------------------------------------------------------------
-- skill sets
--
-- Whole gem loadouts, exactly parallel to config sets. `SetActiveSkillSet`
-- repoints `socketGroupList` (`SkillsTab.lua:1451-1475`) the way
-- `SetActiveConfigSet` repoints `input`.

local function setIndexOf(tab, id)
	for i, other in ipairs(tab.skillSetOrderList) do
		if other == id then return i end
	end
	return nil
end

local function requireSet(tab, id)
	if type(id) ~= "number" then
		util.invalid("skill set id must be a number")
	end
	id = math.floor(id)
	if not tab.skillSets[id] then
		util.invalid("no such skill set: " .. tostring(id))
	end
	return id
end

--- Switch sets, keeping the main-skill pointer honest.
---
--- `build.mainSocketGroup` is an index into `socketGroupList`, and the switch
--- repoints that list wholesale. PoB does not fix the index here — it clamps it
--- later, inside the next calculation (`CalcSetup.lua:1483-1489`), and only
--- downward. Two things go wrong as a result: between the switch and the next
--- frame the index dangles (PoB's own `Build.lua:487` reads it unguarded), and
--- the clamp is destructive — going from a 6-group set with main = 5 to a
--- 2-group set pins it to 2 forever, including on the way back.
---
--- So clamp here, before anything reads it, and remember where each set was so
--- returning to one restores its selection. PoB cannot do that; the format has
--- no per-set main-group field.
local function activateSet(b, tab, id)
	local previous = tab.activeSkillSetId
	if previous then
		mainGroupPerSet[previous] = b.mainSocketGroup or 1
	end

	tab:SetActiveSkillSet(id)

	local count = #tab.socketGroupList
	local remembered = mainGroupPerSet[id]
	b.mainSocketGroup = math.max(1, math.min(remembered or 1, math.max(count, 1)))
end

M.methods["skills.newSet"] = function(params)
	params = params or { }
	local tab = skillsTab()
	if params.title ~= nil and type(params.title) ~= "string" then
		util.invalid("title must be a string")
	end

	local created = tab:NewSkillSet()
	created.title = params.title or "New Skill Set"

	if params.copyFrom ~= nil then
		-- Three levels deep, because `copyTable` is shallow per level and a
		-- shared gem table would make edits to the copy hit the original
		-- (`SkillSetListControl.lua:14-32`).
		local source = tab.skillSets[requireSet(tab, params.copyFrom)]
		for i, group in ipairs(source.socketGroupList) do
			local newGroup = copyTable(group, true)
			newGroup.gemList = { }
			for gi, gem in ipairs(group.gemList) do
				newGroup.gemList[gi] = copyTable(gem, true)
			end
			created.socketGroupList[i] = newGroup
		end
		created.title = params.title or ((source.title or "Default") .. " copy")
	end

	-- `NewSkillSet` registers the set but does not add it to the order list —
	-- PoB does that in the rename popup's Save handler
	-- (`SkillSetListControl.lua:63`). A set missing from the order list is
	-- invisible in the dropdown *and is never saved*.
	table.insert(tab.skillSetOrderList, created.id)
	tab:AddUndoState()
	local result = appliedWithSkills()
	result.createdSet = created.id
	return result
end

M.methods["skills.activateSet"] = function(params)
	params = params or { }
	local b = util.build()
	local tab = b.skillsTab
	activateSet(b, tab, requireSet(tab, params.id))
	tab:AddUndoState()
	return appliedWithSkills()
end

M.methods["skills.renameSet"] = function(params)
	params = params or { }
	local tab = skillsTab()
	local id = requireSet(tab, params.id)
	if type(params.title) ~= "string" or not params.title:match("%S") then
		util.invalid("title must be a non-empty string")
	end
	tab.skillSets[id].title = params.title
	tab:AddUndoState()
	return O{ skills = M.list() }
end

M.methods["skills.deleteSet"] = function(params)
	params = params or { }
	local b = util.build()
	local tab = b.skillsTab
	local id = requireSet(tab, params.id)
	if #tab.skillSetOrderList <= 1 then
		util.invalid("a build must keep at least one skill set")
	end

	local index = setIndexOf(tab, id)
	table.remove(tab.skillSetOrderList, index)
	tab.skillSets[id] = nil
	mainGroupPerSet[id] = nil

	-- Deleting the active set leaves `socketGroupList` pointing at a table
	-- nothing owns; the calculator would keep reading it.
	if tab.activeSkillSetId == id then
		activateSet(b, tab, tab.skillSetOrderList[math.max(1, index - 1)])
	end

	tab:AddUndoState()
	return appliedWithSkills()
end

--- Move a gem within its group.
---
--- Order is not cosmetic: PoB matches gems against an item's sockets by
--- position (`UpdateSocketGroups`, `:1219-1243`), so moving one can change
--- which sockets are satisfied.
--- Imbue a support into the group's item slot.
---
--- An imbued support applies to everything in that slot as if it were socketed
--- there, without occupying a socket. PoB adds it as an `ExtraSupport` at level
--- 1 (`CalcSetup.lua:1557-1563`).
---
--- **Two fields have to agree or nothing happens.** `CalcSetup` checks
--- `imbuedSupportBySlot[slotName] and group.imbuedSupport` — the first is the
--- granted effect and is keyed by *slot*, the second is the gem's name and is
--- what gets written to the build file. Setting only one is a silent no-op:
--- with just the name it never reaches the calculator, and with just the effect
--- it is forgotten on save.
---
--- Not every support is eligible. PoB offers non-exceptional supports that do
--- not themselves grant an active skill (`GemSelectControl.lua:117-124`), which
--- is what `skills.gemCatalogue { imbued = true }` filters to.
M.methods["skills.setImbuedSupport"] = function(params)
	params = params or { }
	local b = util.build()
	local tab = skillsTab()
	local group = groupAt(tab, params.group)

	-- Keyed by slot, so a group with no slot has nowhere to put it.
	if not group.slot then
		util.invalid("an imbued support belongs to an item slot, and this group is not assigned to one")
	end
	tab.imbuedSupportBySlot = tab.imbuedSupportBySlot or { }

	if params.gemId == nil or params.gemId == false then
		tab.imbuedSupportBySlot[group.slot] = nil
		group.imbuedSupport = nil
	else
		local gem = type(params.gemId) == "string" and b.data.gems[params.gemId]
		if not gem then
			util.invalid("no such gem: " .. tostring(params.gemId))
		end
		local granted = gem.grantedEffect
		if not granted or not granted.support then
			util.invalid(util.plain(gem.name or "that gem") .. " is not a support")
		end
		tab.imbuedSupportBySlot[group.slot] = granted
		group.imbuedSupport = util.plain(gem.name)
	end

	tab:AddUndoState()
	return appliedWithSkills()
end

M.methods["skills.reorderGem"] = function(params)
	params = params or { }
	local tab = skillsTab()
	local group = groupAt(tab, params.group)
	if group.source then
		util.invalid("this socket group comes from an item and cannot be edited")
	end

	local from = math.floor(tonumber(params.gem) or 0)
	local to = math.floor(tonumber(params.to) or 0)
	if not group.gemList[from] then
		util.invalid("no gem " .. tostring(params.gem) .. " in this group")
	end
	if to < 1 or to > #group.gemList then
		util.invalid(string.format("cannot move to %d; the group has %d gems",
			to, #group.gemList))
	end
	if from ~= to then
		table.insert(group.gemList, to, table.remove(group.gemList, from))
	end

	tab:ProcessSocketGroup(group)
	tab:AddUndoState()
	return appliedWithSkills()
end

local function wholeNumber(value, what, min)
	if type(value) ~= "number" then
		util.invalid(what .. " must be a number")
	end
	local n = math.floor(value)
	if n < (min or 1) then
		util.invalid(string.format("%s must be at least %d", what, min or 1))
	end
	return n
end

--- Every field is optional; a call sets whichever ones it names.
---
--- Order matters and follows PoB's: the group is chosen first, then the skill
--- within it, then the per-skill settings — because each of those resolves
--- against the one before it. Setting a group and a part in one call therefore
--- means "that group's current skill, this part", which is what the sequence of
--- clicks it stands in for would do.
M.methods["build.setMainSkill"] = function(params)
	params = params or { }
	local b = util.build()
	local groupList = b.skillsTab.socketGroupList

	if params.group ~= nil then
		local index = wholeNumber(params.group, "group")
		if not groupList[index] then
			util.invalid(string.format("no socket group %d (build has %d)", index, #groupList))
		end
		b.mainSocketGroup = index
	end

	local group = groupList[b.mainSocketGroup or 1]
	if not group then
		util.invalid("this build has no socket groups")
	end

	if params.skill ~= nil then
		local index = wholeNumber(params.skill, "skill")
		local count = #(group.displaySkillList or { })
		if index > count then
			util.invalid(string.format("no skill %d in this socket group (it has %d)", index, count))
		end
		group.mainActiveSkill = index
	end

	local activeSkill = currentSkill(group)
	local src = srcInstanceOf(activeSkill)

	-- The remaining fields all live on the source gem. A build with an empty
	-- socket group has no gem to write them to, and silently dropping them would
	-- look like the setting did not stick.
	local perSkill = {
		part = "skillPart",
		stageCount = "skillStageCount",
		mineCount = "skillMineCount",
		minionSkill = "skillMinionSkill",
	}
	for name, field in pairs(perSkill) do
		if params[name] ~= nil then
			if not src then
				util.invalid(name .. " needs an active skill, and this socket group has none")
			end
			-- Mine and stage counts are quantities and may legitimately be zero;
			-- part and minion-skill are 1-based list indices.
			local min = (name == "stageCount" or name == "mineCount") and 0 or 1
			src[field] = wholeNumber(params[name], name, min)
		end
	end

	if params.minion ~= nil then
		if not src then
			util.invalid("minion needs an active skill, and this socket group has none")
		end
		-- Minion ids are strings from the data tables; item-set ids are numbers.
		-- Which one applies is a property of the skill, so the client echoes back
		-- whichever `kind` the projection reported.
		if type(params.minion) == "number" then
			src.skillMinionItemSet = math.floor(params.minion)
		elseif type(params.minion) == "string" then
			src.skillMinion = params.minion
		else
			util.invalid("minion must be a minion id or an item set id")
		end
	end

	b.modFlag = true
	-- `applied()` raises buildFlag and runs the frame, which is what every one of
	-- PoB's own handlers does (`Build.lua:476-477`).
	local result = buildApi.applied()
	-- The lists are rebuilt by that frame — changing the skill can change which
	-- controls exist at all — so the fresh projection ships with the new stats
	-- rather than costing the client a second round trip to discover it.
	result.mainSkill = M.selection()
	return result
end

return M
