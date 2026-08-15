-- items.* : gear, the item pool, and item sets.
--
-- PoB's `ItemsTab` is 5,203 lines and `Item` another 2,684, but as with the
-- config tab most of that is not logic we want to own. The parts that matter:
--
--   * **`Item:ParseRaw` is the only correct item parser.** It reads the text
--     the game puts on the clipboard, and it is 1,200 lines because that format
--     is genuinely irregular — influences, catalysts, cluster jewels, crucible
--     trees, six independent variant axes. We call it. We never parse an item.
--
--   * **Slot legality is not obvious and must not be reimplemented.**
--     `IsItemValidForSlot` (`ItemsTab.lua:2457-2505`) knows that a quiver needs
--     a bow in the other hand, that two wands pair but a wand and a sceptre do
--     not, that a cluster jewel cannot go in an inner socket, and that charms
--     only fit charm sockets. Every one of those is a rule a reimplementation
--     would get subtly wrong, so the engine is asked.
--
--   * **An item is a value, a slot is a reference.** `itemsTab.items[id]` is a
--     pool keyed by numeric id; an item set holds `selItemId` per slot
--     (`ItemsTab.lua:1322-1400`). Equipping does not move anything — it
--     repoints a slot. Two sets can share one item, which is what makes
--     "same gear, different flasks" cheap.
--
-- The mod lines are split into six lists in PoB — buff, enchant, scourge,
-- implicit, explicit, crucible — and the split is meaningful (they render
-- differently and serialise in that order), so it is preserved rather than
-- flattened.

local util = require("api.util")
local buildApi = require("api.build")
local A, O = util.array, util.object

local M = { }

--- The six mod-line lists an item carries, in PoB's own order. `Save` walks
--- them in exactly this sequence when numbering `ModRange` elements
--- (`ItemsTab.lua:1344-1372`), so the order is load-bearing, not cosmetic.
local MOD_LISTS = {
	{ key = "buff", field = "buffModLines" },
	{ key = "enchant", field = "enchantModLines" },
	{ key = "scourge", field = "scourgeModLines" },
	{ key = "implicit", field = "implicitModLines" },
	{ key = "explicit", field = "explicitModLines" },
	{ key = "crucible", field = "crucibleModLines" },
}

--- Influence flags, as `Item.lua` stores them.
local INFLUENCES = {
	{ field = "shaper", name = "Shaper" },
	{ field = "elder", name = "Elder" },
	{ field = "warlord", name = "Warlord" },
	{ field = "hunter", name = "Hunter" },
	{ field = "crusader", name = "Crusader" },
	{ field = "redeemer", name = "Redeemer" },
	{ field = "searing", name = "Searing Exarch" },
	{ field = "tangled", name = "Eater of Worlds" },
}

local function itemsTab()
	local b = util.build()
	if not b.itemsTab then
		util.fail(util.ENGINE_ERROR, "this build has no items tab")
	end
	return b.itemsTab
end

local function activeSet(tab)
	return tab.itemSets[tab.activeItemSetId]
end

-- ---------------------------------------------------------------------------
-- projection

--- Does this line carry a rolled range, i.e. is there a slider for it?
---
--- PoB's own test: a `range` field *and* a `(min-max)` in the text
--- (`Item.lua:2471`). A line can have one without the other, and only both
--- together mean the value is adjustable.
local function rangeOf(modLine)
	if type(modLine.range) ~= "number" then return nil end
	local lo, hi = modLine.line:match("%((%-?%d+%.?%d*)%-(%-?%d+%.?%d*)%)")
	if not lo then return nil end
	return { value = modLine.range, min = tonumber(lo), max = tonumber(hi) }
end

local function modEntry(index, modLine)
	local entry = O{
		index = index,
		-- Multi-line mods exist (cluster jewel enchantments); the newline is
		-- part of the value and the client decides how to break it.
		line = util.plain(modLine.line or ""),
	}
	if modLine.crafted then entry.crafted = true end
	if modLine.fractured then entry.fractured = true end
	if modLine.scourge then entry.scourge = true end
	-- A line PoB parsed but could not turn into modifiers keeps its leftover,
	-- which is the same "understood / partly understood" distinction the custom
	-- modifier block reports.
	if modLine.extra then entry.unparsed = util.plain(modLine.extra) end
	local range = rangeOf(modLine)
	if range then
		entry.range = range.value
		entry.rangeMin = range.min
		entry.rangeMax = range.max
	end
	return entry
end

--- Variant axes. A unique can carry up to six independent ones — `variant`
--- plus `variantAlt` through `variantAlt5` (`ItemsTab.lua:1213-1236`) — which
--- is how items like Watcher's Eye offer several unrelated choices at once.
local function variantsOf(item)
	if not item.variantList or #item.variantList == 0 then return nil end
	local options = A{ }
	for i, name in ipairs(item.variantList) do
		options[#options + 1] = O{ index = i, name = util.plain(name) }
	end
	local axes = A{ }
	axes[#axes + 1] = O{ key = "variant", selected = item.variant or 1 }
	for i = 2, 6 do
		local suffix = i == 2 and "Alt" or ("Alt" .. (i - 1))
		if item["has" .. "Variant" .. suffix] or item["variant" .. suffix] then
			axes[#axes + 1] = O{
				key = "variant" .. suffix,
				selected = item["variant" .. suffix] or 1,
			}
		end
	end
	return O{ options = options, axes = axes }
end

--- One item, as the client needs it to render a tooltip and an editor.
function M.itemEntry(tab, item)
	local base = item.base or { }
	local entry = O{
		id = item.id,
		name = util.plain(item.name or item.baseName or ""),
		rarity = item.rarity,
		baseName = util.plain(item.baseName or ""),
		type = item.type,
		subType = base.subType,
		corrupted = item.corrupted or false,
		mirrored = item.mirrored or false,
	}
	-- `title` is set only for rares and uniques, where the displayed name and
	-- the base are different lines.
	if item.title then entry.title = util.plain(item.title) end
	if item.namePrefix then entry.namePrefix = util.plain(item.namePrefix) end
	if item.nameSuffix then entry.nameSuffix = util.plain(item.nameSuffix) end
	if item.itemLevel then entry.itemLevel = item.itemLevel end
	if item.quality then entry.quality = item.quality end
	if item.league then entry.league = util.plain(item.league) end
	if item.talismanTier then entry.talismanTier = item.talismanTier end
	if item.catalyst and item.catalyst > 0 then
		entry.catalyst = item.catalyst
		entry.catalystQuality = item.catalystQuality
	end

	-- Requirements the character has to meet. PoB colours these against the
	-- character's own attributes; we report the number and let the stat panel
	-- own the comparison.
	local req = item.requirements
	if req then
		entry.requires = O{
			level = req.level, str = req.str, dex = req.dex, int = req.int,
		}
	end

	-- Defences, which are on the base rather than the mod list.
	if item.armourData then
		local defences = O{ }
		local any = false
		for _, key in ipairs({ "Armour", "Evasion", "EnergyShield", "Ward" }) do
			local v = item.armourData[key]
			if v and v > 0 then
				defences[key:sub(1, 1):lower() .. key:sub(2)] = v
				any = true
			end
		end
		if any then entry.defences = defences end
	end

	local influences = A{ }
	for _, inf in ipairs(INFLUENCES) do
		if item[inf.field] then influences[#influences + 1] = inf.name end
	end
	if #influences > 0 then entry.influences = influences end

	-- Sockets and links, which is what decides whether a socket group fits.
	if item.sockets and #item.sockets > 0 then
		local sockets = A{ }
		for i, socket in ipairs(item.sockets) do
			sockets[#sockets + 1] = O{
				index = i,
				colour = socket.color,
				-- PoB stores the link group per socket; sockets in the same
				-- group are linked to each other.
				group = socket.group,
			}
		end
		entry.sockets = sockets
	end

	local mods = O{ }
	local anyMods = false
	for _, list in ipairs(MOD_LISTS) do
		local lines = item[list.field]
		if lines and #lines > 0 then
			local out = A{ }
			for i, modLine in ipairs(lines) do
				out[#out + 1] = modEntry(i, modLine)
			end
			mods[list.key] = out
			anyMods = true
		end
	end
	if anyMods then entry.mods = mods end

	local variants = variantsOf(item)
	if variants then entry.variants = variants end

	-- The exact text PoB would write out. The client shows it for copy, and it
	-- is what `items.paste` round-trips.
	local ok, raw = pcall(function()
		item:BuildAndParseRaw()
		return item.raw
	end)
	if ok and type(raw) == "string" then entry.raw = raw end

	return entry
end

--- The slots, in PoB's own display order, each with what is in it.
---
--- Jewel sockets are slots too, but they only exist while their tree node is
--- allocated (`ItemsTab.lua:1652-1673`), so the list is per-build and changes
--- as the tree does.
local function slotList(tab, set)
	local spec = tab.build and tab.build.spec
	local slots = A{ }
	for _, slot in ipairs(tab.orderedSlots or { }) do
		local name = slot.slotName
		-- **A jewel socket does not store its item in the item set.** It stores
		-- it on the tree spec, keyed by node id (`ItemSlotControl.lua:61-73`),
		-- because a socketed jewel belongs to the *tree* — which is why swapping
		-- tree variants swaps your jewels with it. The item set does hold a
		-- `[nodeId]` entry, but that is the trade-search URL, not the item, and
		-- reading it reported every socket as empty.
		local selected
		if slot.nodeId then
			selected = spec and spec.jewels[slot.nodeId] or nil
		else
			local holder = set[name]
			selected = holder and holder.selItemId or nil
		end
		local entry = O{
			name = name,
			label = util.plain(slot.label or name),
		}
		if slot.nodeId then entry.nodeId = slot.nodeId end
		if slot.weaponSet then entry.weaponSet = slot.weaponSet end
		if selected and selected ~= 0 and tab.items[selected] then
			entry.itemId = selected
		end
		-- Abyssal sockets and jewel sockets come and go; PoB hides a slot whose
		-- socket no longer exists rather than showing an empty one.
		if type(slot.shown) == "function" then
			local ok, shown = pcall(slot.shown, slot)
			entry.shown = (not ok) or shown ~= false
		else
			entry.shown = true
		end
		slots[#slots + 1] = entry
	end
	return slots
end

function M.state()
	local tab = itemsTab()
	local set = activeSet(tab)

	local items = A{ }
	for _, id in ipairs(tab.itemOrderList or { }) do
		local item = tab.items[id]
		if item then items[#items + 1] = M.itemEntry(tab, item) end
	end

	local sets = A{ }
	for _, id in ipairs(tab.itemSetOrderList or { }) do
		local s = tab.itemSets[id]
		if s then
			sets[#sets + 1] = O{
				id = id,
				title = util.plain(s.title or ("Set " .. id)),
				useSecondWeaponSet = s.useSecondWeaponSet or false,
			}
		end
	end

	return O{
		slots = slotList(tab, set),
		items = items,
		sets = sets,
		activeSet = tab.activeItemSetId,
		useSecondWeaponSet = set and set.useSecondWeaponSet or false,
	}
end

M.methods = { }

M.methods["items.list"] = function()
	return M.state()
end

--- Which slots this item may legally go in.
---
--- Answered by PoB, not by us — see the header. Reported as a list so the
--- client can offer exactly the legal destinations rather than offering all of
--- them and failing on commit.
--- Recalculate and answer with the refreshed gear alongside the stats.
local function appliedWithItems()
	local result = buildApi.applied()
	result.items = M.state()
	return result
end

--- A slot control by name, or a clean error.
local function slotAt(tab, name)
	if type(name) ~= "string" then util.invalid("slot must be a string") end
	local slot = tab.slots[name]
	if not slot then util.invalid("no such slot: " .. name) end
	return slot
end

local function itemAt(tab, id, what)
	local n = math.floor(tonumber(id) or 0)
	local item = tab.items[n]
	if not item then
		util.invalid((what or "no such item") .. ": " .. tostring(id))
	end
	return item, n
end

--- Add an item from the text the game puts on the clipboard.
---
--- `Item:ParseRaw` is the whole of the parsing, and it is the only correct
--- implementation of a genuinely irregular format. An item whose `base` did not
--- resolve is a parse failure, which is exactly the test `Load` uses before it
--- will keep one (`ItemsTab.lua:1259`).
---
--- `equip` follows PoB's auto-equip: the first empty legal slot takes it
--- (`AddItem`, `:1695-1702`). Off by default, because pasting a stash tab of
--- candidates should not silently redress the character.
M.methods["items.paste"] = function(params)
	params = params or { }
	if type(params.text) ~= "string" or params.text:match("^%s*$") then
		util.invalid("items.paste needs the item text")
	end

	local ok, item = pcall(function() return new("Item", params.text) end)
	if not ok or not item then
		util.invalid("that does not look like an item")
	end
	if not item.base then
		util.invalid("could not recognise the item's base type")
	end

	local tab = itemsTab()
	tab:AddItem(item, params.equip ~= true)
	tab:PopulateSlots()
	tab:AddUndoState()
	return appliedWithItems()
end

M.methods["items.slotsFor"] = function(params)
	params = params or { }
	local tab = itemsTab()
	local id = math.floor(tonumber(params.item) or 0)
	local item = tab.items[id]
	if not item then
		util.invalid("no such item: " .. tostring(params.item))
	end
	local out = A{ }
	for _, slot in ipairs(tab.orderedSlots or { }) do
		local ok, valid = pcall(tab.IsItemValidForSlot, tab, item, slot.slotName)
		if ok and valid then out[#out + 1] = slot.slotName end
	end
	return O{ slots = out }
end

--- Put an item in a slot, or clear the slot with `item = false`.
---
--- The legality check is PoB's, and the *clean-up* is PoB's too: `Populate`
--- clears any slot whose item is no longer valid (`ItemSlotControl.lua:93-96`),
--- which is what makes equipping a two-hander drop the off-hand rather than
--- leaving an impossible pair. Repointing the slot and repopulating is the
--- whole operation; nothing is moved.
M.methods["items.equip"] = function(params)
	params = params or { }
	local tab = itemsTab()
	local slot = slotAt(tab, params.slot)

	if params.item == false or params.item == nil then
		slot:SetSelItemId(0)
	else
		local item, id = itemAt(tab, params.item, "cannot equip unknown item")
		local ok, valid = pcall(tab.IsItemValidForSlot, tab, item, slot.slotName)
		if not ok or not valid then
			util.invalid(string.format("%s cannot go in %s",
				util.plain(item.name or item.baseName or "that item"), slot.slotName))
		end
		slot:SetSelItemId(id)
	end

	tab:PopulateSlots()
	tab:AddUndoState()
	return appliedWithItems()
end

--- Remove an item from the build entirely.
---
--- Loud, because `DeleteItem` reaches much further than the item pool
--- (`ItemsTab.lua:1768-1815`): it clears the item out of *every* item set, and
--- out of every tree spec's jewel sockets — and for a cluster jewel it also
--- deallocates the nodes that only existed because the jewel was socketed.
--- Deleting a cluster jewel is a tree edit, so the client must confirm it.
M.methods["items.delete"] = function(params)
	params = params or { }
	local tab = itemsTab()
	local item = itemAt(tab, params.item, "cannot delete unknown item")
	tab:DeleteItem(item)
	return appliedWithItems()
end

--- Adjust where a rolled modifier sits in its range, 0..1.
---
--- Only lines that actually carry a range accept this; `rangeOf` uses PoB's own
--- test, and a line without a `(min-max)` in it has no slider to move.
M.methods["items.setModRange"] = function(params)
	params = params or { }
	local tab = itemsTab()
	local item = itemAt(tab, params.item, "no such item")

	local listKey = params.list
	local field
	for _, list in ipairs(MOD_LISTS) do
		if list.key == listKey then field = list.field end
	end
	if not field then
		util.invalid("no such mod list: " .. tostring(listKey))
	end
	local lines = item[field] or { }
	local index = math.floor(tonumber(params.index) or 0)
	local modLine = lines[index]
	if not modLine then
		util.invalid(string.format("no %s modifier %d on this item", listKey, index))
	end
	if not rangeOf(modLine) then
		util.invalid("that modifier does not have a range to set")
	end

	local range = tonumber(params.range)
	if not range then util.invalid("range must be a number between 0 and 1") end
	modLine.range = math.max(0, math.min(1, range))

	item:BuildModList()
	tab:AddUndoState()
	return appliedWithItems()
end

--- Choose a variant on one of the item's axes.
---
--- `key` is `variant`, `variantAlt`, `variantAlt2` … — a unique can offer up to
--- six independent choices, and they are separate fields rather than one list
--- (`ItemsTab.lua:1213-1236`).
M.methods["items.setVariant"] = function(params)
	params = params or { }
	local tab = itemsTab()
	local item = itemAt(tab, params.item, "no such item")

	local key = params.key or "variant"
	if not key:match("^variant%a*%d*$") then
		util.invalid("no such variant axis: " .. tostring(key))
	end
	if not item.variantList or #item.variantList == 0 then
		util.invalid("that item has no variants")
	end
	local index = math.floor(tonumber(params.index) or 0)
	if index < 1 or index > #item.variantList then
		util.invalid(string.format("variant %d is out of range (the item has %d)",
			index, #item.variantList))
	end

	item[key] = index
	-- The variant decides which mod lines apply, so the raw text has to be
	-- rebuilt and reparsed before the mod list means anything.
	item:BuildAndParseRaw()
	tab:AddUndoState()
	return appliedWithItems()
end

--- Recolour and relink an item's sockets to fit the socket groups assigned to
--- its slot.
---
--- Mirrors `SkillsTab.lua:242-283`. Three rules that are easy to miss:
---
---   * **Abyssal sockets are preserved, not rebuilt.** They are counted first,
---     subtracted from the budget, and re-appended at the end — each in its own
---     link group, because an abyss jewel is never linked to anything.
---   * **The budget is the base's `socketLimit`**, not the item's current socket
---     count. An item can be under-socketed and this is what fills it out.
---   * **Each socket group gets its own link group**, in list order, so two
---     groups in one item come out as separate links rather than one long one.
---
--- Gems past the limit are dropped rather than squeezed in: PoB stops at
--- `maxSockets` and so do we. That is a real outcome the client should surface —
--- the group still has the gems, the item just cannot hold them.
M.methods["items.optimiseSockets"] = function(params)
	params = params or { }
	local b = util.build()
	local tab = itemsTab()
	local slot = slotAt(tab, params.slot)

	local set = activeSet(tab)
	local holder = set[slot.slotName]
	local id = holder and holder.selItemId or nil
	local item = id and id ~= 0 and tab.items[id] or nil
	if not item then
		util.invalid("nothing is equipped in " .. slot.slotName)
	end
	if not item.base or not item.base.socketLimit then
		util.invalid(util.plain(item.name or item.baseName or "that item") .. " has no sockets")
	end

	local abyssal = 0
	for _, socket in ipairs(item.sockets or { }) do
		if socket.color == "A" then abyssal = abyssal + 1 end
	end

	local colours = { "R", "G", "B" }
	local budget = item.base.socketLimit - abyssal
	local groupCount = 0
	local sockets = { }

	for _, group in ipairs(b.skillsTab.socketGroupList) do
		if group.slot == slot.slotName then
			for _, gem in ipairs(group.gemList) do
				local granted = gem.grantedEffect or (gem.gemData and gem.gemData.grantedEffect)
				if granted and budget > 0 then
					-- A gem with no colour requirement wants a white socket.
					local colour = granted.color and colours[granted.color] or "W"
					table.insert(sockets, { color = colour, group = groupCount })
					budget = budget - 1
				end
			end
			groupCount = groupCount + 1
		end
	end

	for _ = 1, abyssal do
		table.insert(sockets, { color = "A", group = groupCount })
		groupCount = groupCount + 1
	end

	item.sockets = sockets
	-- The socket layout is part of the item's text, so it has to be rewritten
	-- and reparsed before anything downstream sees the change.
	item:BuildAndParseRaw()
	b.skillsTab:UpdateSocketGroups()
	tab:AddUndoState()

	local result = appliedWithItems()
	result.skills = require("api.skills").list()
	return result
end

-- ---------------------------------------------------------------------------
-- item sets

local function requireSet(tab, id)
	local n = math.floor(tonumber(id) or 0)
	local set = tab.itemSets[n]
	if not set then util.invalid("no such item set: " .. tostring(id)) end
	return set, n
end

M.methods["items.newSet"] = function(params)
	params = params or { }
	local tab = itemsTab()
	local set = tab:NewItemSet()
	set.title = type(params.title) == "string" and params.title or ("Set " .. set.id)

	-- A copy takes the other set's slot assignments. It shares the *items* —
	-- they are references, so this is cheap and edits to an item show in both,
	-- which is the point of item sets.
	if params.copyFrom ~= nil then
		local source = requireSet(tab, params.copyFrom)
		for slotName, slot in pairs(tab.slots) do
			if not slot.nodeId and source[slotName] and set[slotName] then
				set[slotName].selItemId = source[slotName].selItemId
				set[slotName].active = source[slotName].active
			end
		end
		set.useSecondWeaponSet = source.useSecondWeaponSet
	end

	table.insert(tab.itemSetOrderList, set.id)
	tab:AddUndoState()
	local result = appliedWithItems()
	result.createdSet = set.id
	return result
end

M.methods["items.activateSet"] = function(params)
	params = params or { }
	local tab = itemsTab()
	local _, id = requireSet(tab, params.id)
	tab:SetActiveItemSet(id)
	tab:AddUndoState()
	return appliedWithItems()
end

M.methods["items.renameSet"] = function(params)
	params = params or { }
	local tab = itemsTab()
	local set = requireSet(tab, params.id)
	if type(params.title) ~= "string" or params.title:match("^%s*$") then
		util.invalid("an item set needs a name")
	end
	set.title = params.title
	tab:AddUndoState()
	return appliedWithItems()
end

M.methods["items.deleteSet"] = function(params)
	params = params or { }
	local tab = itemsTab()
	local _, id = requireSet(tab, params.id)
	if #tab.itemSetOrderList <= 1 then
		util.invalid("a build must keep at least one item set")
	end

	for index, other in ipairs(tab.itemSetOrderList) do
		if other == id then
			table.remove(tab.itemSetOrderList, index)
			break
		end
	end
	tab.itemSets[id] = nil
	-- Deleting the active set has to leave a live one selected, or every slot
	-- reads from a table that is no longer there.
	if tab.activeItemSetId == id then
		tab:SetActiveItemSet(tab.itemSetOrderList[1])
	end
	tab:AddUndoState()
	return appliedWithItems()
end

--- Swap to the second weapon set.
---
--- Not cosmetic: it decides which weapon slots feed the calculation, and PoB
--- redirects equips into the swap slots while it is on
--- (`ItemsTab.lua:1616-1619`).
M.methods["items.setWeaponSwap"] = function(params)
	params = params or { }
	if type(params.enabled) ~= "boolean" then
		util.invalid("enabled must be true or false")
	end
	local tab = itemsTab()
	local set = activeSet(tab)
	set.useSecondWeaponSet = params.enabled
	tab:PopulateSlots()
	tab:AddUndoState()
	return appliedWithItems()
end

return M
