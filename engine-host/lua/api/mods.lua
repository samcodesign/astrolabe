-- items.modSources / items.modPool / items.addMod / items.removeMod
--
-- The crafting spine, and the Mod Browser, which are the same thing.
--
-- PoB has nine crafting features — the bench, essences, veiled, delve,
-- necropolis, beastcraft, corrupting, enchanting, implicits — and every one of
-- them does the same three steps: take a table of mods, filter it by what this
-- item can legally have, and let you pick one. The tables and the predicates
-- are all PoB's, so the work here is plumbing rather than logic:
--
--   * `item.affixes` is the item's own pool, built by `ParseRaw` from its base.
--   * `data.masterMods`, `data.essences`, `data.veiledMods`,
--     `data.necropolisMods` are the fixed catalogues.
--   * `Item:GetModSpawnWeight` (`Item.lua:1654`) decides whether a mod can roll
--     on this item at all — it weighs the item's tags against the mod's spawn
--     weights, and reimplementing it would get influence, delve and essence
--     mods subtly wrong.
--
-- **Applying a mod is three lines.** `addModifier` (`ItemsTab.lua:3591-3608`)
-- rebuilds the item from its own text, appends the mod's lines to
-- `explicitModLines`, and reparses. There is no separate crafting model — a
-- crafted mod is an explicit mod with a flag on it. That is why this one module
-- covers the bench and the browser and the free-text case together.

local util = require("api.util")
local buildApi = require("api.build")
local A, O = util.array, util.object

local M = { }

--- Which sources apply to an item, mirroring `ItemsTab.lua:3557-3589`.
---
--- The conditions are the item's own: a jewel has no crafting bench, a flask
--- has no essences, only body armour pieces take necropolis mods, and prefix /
--- suffix browsing is hidden once the item is crafted because the affix slots
--- are already spoken for.
--- The implicit-family sources, keyed by the `mod.type` they match.
---
--- `corrupted` additionally marks the item corrupted, which is not cosmetic:
--- a corrupted item cannot be crafted on afterwards.
local IMPLICIT_SOURCES = {
	{ id = "CORRUPTED", label = "Corrupted implicit", modType = "corrupted", corrupts = true },
	{ id = "EXARCH", label = "Searing Exarch", modType = "exarch" },
	{ id = "EATER", label = "Eater of Worlds", modType = "eater" },
}

local function implicitSource(id)
	for _, imp in ipairs(IMPLICIT_SOURCES) do
		if imp.id == id then return imp end
	end
	return nil
end

--- Does this item have any mods of that type available to it?
local function hasImplicitsOfType(item, modType)
	for _, mod in pairs(item.affixes or { }) do
		if (mod.type or ""):lower() == modType then
			local ok, weight = pcall(item.GetModSpawnWeight, item, mod)
			if ok and weight and weight > 0 then return true end
		end
	end
	return false
end

local function sourcesFor(item)
	local out = A{ }
	local t = item.type
	local function add(id, label) out[#out + 1] = O{ id = id, label = label } end

	if t ~= "Tincture" and t ~= "Graft" then
		if t ~= "Jewel" then add("MASTER", "Crafting Bench") end
		if t ~= "Jewel" and t ~= "Flask" then
			add("ESSENCE", "Essence")
			add("VEILED", "Veiled")
		end
		if t == "Helmet" or t == "Body Armour" or t == "Gloves" or t == "Boots" then
			add("NECROPOLIS", "Necropolis")
		end
		if not item.clusterJewel and t ~= "Flask" then add("DELVE", "Delve") end
		if not item.crafted then
			add("PREFIX", "Prefix")
			add("SUFFIX", "Suffix")
		end
	end
	-- Implicit-family sources. These land on `implicitModLines` rather than
	-- `explicitModLines`, and they are all the same filter — `mod.type` against
	-- the source, `GetModSpawnWeight` for legality — which is why they cost
	-- almost nothing on top of the explicit ones
	-- (`ItemsTab.lua:3799-3821`, `:3028-3036`).
	--
	-- Offered only when the item actually has such mods available, rather than
	-- from a hardcoded list of item types: the affix pool already knows, and a
	-- source that opens to an empty list is worse than one that is absent.
	for _, imp in ipairs(IMPLICIT_SOURCES) do
		if hasImplicitsOfType(item, imp.modType) then add(imp.id, imp.label) end
	end

	-- Always last, and always available: arbitrary text, same as the config
	-- tab's custom modifiers but scoped to one item.
	add("CUSTOM", "Custom")
	return out
end

--- Is this line something the calculator can actually use?
---
--- The same question the custom-modifier block answers, and the reason the Mod
--- Browser is worth having: a mod that reads fine and does nothing is the
--- failure a user cannot see. `modLib.parseMod` reports success as
--- `mods and not extra` — there is no error object anywhere in PoB.
---
--- **The range has to be resolved first.** A catalogue mod reads
--- `(11-28)% increased Energy Shield`, and `parseMod` cannot read that — the
--- parenthesised range is not a number. Asking it directly reported almost
--- every mod in the game as unsupported, including ones that plainly work.
--- `itemLib.applyRange` at the midpoint is what PoB does before parsing
--- (`Item.lua:2474`), and the midpoint is arbitrary but irrelevant: we are
--- asking about the *shape* of the line, not its value.
local function supported(lines)
	for _, line in ipairs(lines) do
		local text = line
		if text:find("%(%-?%d+%.?%d*%-%-?%d+%.?%d*%)") then
			local ok, applied = pcall(itemLib.applyRange, text, 0.5)
			if ok and type(applied) == "string" then text = applied end
		end
		local ok, mods, extra = pcall(modLib.parseMod, text)
		if not ok or not mods or extra or #mods == 0 then return false end
	end
	return true
end

local function entry(index, lines, label, affixType, kind, extra)
	local text = A{ }
	for i, line in ipairs(lines) do text[i] = util.plain(line) end
	local out = O{
		index = index,
		lines = text,
		label = util.plain(label or table.concat(lines, " / ")),
		supported = supported(lines),
		kind = kind,
	}
	if affixType then out.affixType = affixType end
	if extra then for k, v in pairs(extra) do out[k] = v end end
	return out
end

--- Build the candidate list for one source.
---
--- Every branch here is a transcription of `buildMods` (`ItemsTab.lua:3408-...`)
--- — same tables, same predicates, same sort. The predicates are called rather
--- than reproduced; only the ordering is restated, and only because PoB sorts
--- into a control we do not have.
local function poolFor(b, item, sourceId)
	local out = A{ }
	local n = 0
	local function push(lines, label, affixType, kind, extra)
		n = n + 1
		out[n] = entry(n, lines, label, affixType, kind, extra)
	end

	if sourceId == "MASTER" then
		-- The bench cannot give you a second mod from a group you already have.
		local excludeGroups = { }
		for _, affixes in ipairs({ item.prefixes or { }, item.suffixes or { } }) do
			for i = 1, (affixes.limit or ((item.affixLimit or 6) / 2)) do
				local affix = affixes[i]
				if affix and affix.modId and affix.modId ~= "None" and item.affixes[affix.modId] then
					excludeGroups[item.affixes[affix.modId].group] = true
				end
			end
		end
		for _, craft in ipairs(b.data.masterMods) do
			if craft.types[item.type] and not excludeGroups[craft.group] then
				push(craft, table.concat(craft, " / "), craft.type, "crafted")
			end
		end

	elseif sourceId == "ESSENCE" then
		for _, essence in pairs(b.data.essences) do
			local mod = item.affixes[essence.mods[item.type]]
			if mod then
				push(mod, essence.name .. " — " .. table.concat(mod, " / "), mod.type, "custom",
					{ source = util.plain(essence.name) })
			end
		end

	elseif sourceId == "PREFIX" or sourceId == "SUFFIX" then
		for _, mod in pairs(item.affixes) do
			-- `GetModSpawnWeight` is the legality gate. It weighs the item's own
			-- tags against the mod's spawn table, which is what makes an
			-- influenced or delve mod legal on one item and not another.
			if sourceId:lower() == (mod.type or ""):lower() and item:GetModSpawnWeight(mod) > 0 then
				push(mod, (mod.affix or "") .. " — " .. table.concat(mod, " / "), mod.type, "custom",
					{ level = mod.level })
			end
		end

	elseif sourceId == "VEILED" then
		for _, mod in pairs(b.data.veiledMods) do
			if item:GetModSpawnWeight(mod) > 0 then
				push(mod, table.concat(mod, " / "), mod.type, "custom")
			end
		end

	elseif sourceId == "DELVE" then
		for _, mod in pairs(item.affixes) do
			if item:CheckIfModIsDelve(mod) and item:GetModSpawnWeight(mod) > 0 then
				push(mod, table.concat(mod, " / "), mod.type, "custom")
			end
		end

	elseif sourceId == "NECROPOLIS" then
		for _, mod in pairs(b.data.necropolisMods or { }) do
			if item:GetNecropolisModSpawnWeight(mod) > 0 then
				push(mod, table.concat(mod, " / "), mod.type, "custom")
			end
		end

	elseif implicitSource(sourceId) then
		local modType = implicitSource(sourceId).modType
		for _, mod in pairs(item.affixes) do
			if (mod.type or ""):lower() == modType and item:GetModSpawnWeight(mod) > 0 then
				push(mod, table.concat(mod, " / "), nil, modType, { level = mod.level })
			end
		end

	elseif sourceId == "CUSTOM" then
		-- Free text; there is nothing to enumerate.
		return out

	else
		util.invalid("no such mod source: " .. tostring(sourceId))
	end

	-- Prefixes before suffixes, then the source's own order — PoB's sort in
	-- every branch that has both.
	table.sort(out, function(a, c)
		if a.affixType ~= c.affixType then
			return (a.affixType or "") == "Prefix"
		end
		return a.index < c.index
	end)
	for i, row in ipairs(out) do row.index = i end
	return out
end

local function itemAt(id, what)
	local b = util.build()
	local tab = b.itemsTab
	if not tab then
		util.fail(util.ENGINE_ERROR, "this build has no items tab")
	end
	local item = tab.items[math.floor(tonumber(id) or 0)]
	if not item then
		util.invalid((what or "no such item") .. ": " .. tostring(id))
	end
	return b, tab, item
end

M.methods = { }

M.methods["items.modSources"] = function(params)
	params = params or { }
	local _, _, item = itemAt(params.item)
	return O{ sources = sourcesFor(item) }
end

--- Every mod this item could take from one source.
---
--- Also the Mod Browser: the same list, read rather than picked from. `search`
--- is a plain substring over the rendered lines, applied here so a source with
--- thousands of entries does not cross the pipe whole.
M.methods["items.modPool"] = function(params)
	params = params or { }
	local b, _, item = itemAt(params.item)
	local pool = poolFor(b, item, params.source)

	local query = type(params.search) == "string" and params.search:lower():match("^%s*(.-)%s*$") or ""
	if query ~= "" then
		local filtered = A{ }
		for _, row in ipairs(pool) do
			if row.label:lower():find(query, 1, true) then
				filtered[#filtered + 1] = row
			end
		end
		pool = filtered
	end

	return O{ mods = pool, total = #pool }
end

--- Add a mod to an item.
---
--- Mirrors `addModifier` exactly: rebuild the item from its own text, append
--- the lines, reparse. A crafted mod is an explicit mod carrying a flag, not a
--- separate kind of thing — which is why this is three lines rather than a
--- crafting engine.
M.methods["items.addMod"] = function(params)
	params = params or { }
	local b, tab, item = itemAt(params.item, "cannot craft on unknown item")

	if params.source == "CUSTOM" then
		local text = params.text
		if type(text) ~= "string" or not text:match("%S") then
			util.invalid("a custom modifier needs some text")
		end
		table.insert(item.explicitModLines, { line = text, custom = true })
	else
		local pool = poolFor(b, item, params.source)
		local index = math.floor(tonumber(params.index) or 0)
		local chosen = pool[index]
		if not chosen then
			util.invalid(string.format("no modifier %d in %s (it has %d)",
				index, tostring(params.source), #pool))
		end
		-- Implicits go on their own list, not among the explicits. Putting them
		-- in the wrong one would still calculate, but the item would render
		-- wrong and round-trip wrong.
		local imp = implicitSource(params.source)
		local target = imp and item.implicitModLines or item.explicitModLines
		for _, line in ipairs(chosen.lines) do
			table.insert(target, { line = line, [chosen.kind] = true })
		end
		-- Corrupting is a state change on the item, not just a mod: a corrupted
		-- item cannot be crafted on afterwards, and the sources list reflects
		-- that on the next read.
		if imp and imp.corrupts then item.corrupted = true end
	end

	item:BuildAndParseRaw()
	tab:AddUndoState()
	local result = buildApi.applied()
	result.items = require("api.items").state()
	return result
end

--- Remove one mod line.
---
--- Any of the six lists, because a crafted mod and a rolled one live in the
--- same place and the user should not have to know which is which.
M.methods["items.removeMod"] = function(params)
	params = params or { }
	local _, tab, item = itemAt(params.item, "no such item")

	local FIELDS = {
		buff = "buffModLines", enchant = "enchantModLines", scourge = "scourgeModLines",
		implicit = "implicitModLines", explicit = "explicitModLines",
		crucible = "crucibleModLines",
	}
	local field = FIELDS[params.list]
	if not field then
		util.invalid("no such mod list: " .. tostring(params.list))
	end
	local lines = item[field] or { }
	local index = math.floor(tonumber(params.index) or 0)
	if not lines[index] then
		util.invalid(string.format("no %s modifier %d on this item", tostring(params.list), index))
	end

	table.remove(lines, index)
	item:BuildAndParseRaw()
	tab:AddUndoState()
	local result = buildApi.applied()
	result.items = require("api.items").state()
	return result
end

return M
