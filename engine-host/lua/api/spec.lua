-- spec.list / create / activate / rename / delete: PoB's tree variants.
--
-- A PoB build holds several `<Spec>` elements — the same character with
-- different passive trees — and `build.spec` is whichever one is active. All of
-- them are saved, so a frontend that fakes variants by diffing allocations both
-- loses them on save and pays two round trips per switch.
--
-- Every operation here mirrors `PassiveSpecListControl`, which is where PoB's
-- own new/copy/rename/delete buttons live.

local util = require("api.util")
local buildApi = require("api.build")
local A, O = util.array, util.object

local M = { }

local function summarise(spec)
	local allocated = A{ }
	for id in pairs(spec.allocNodes) do
		allocated[#allocated + 1] = id
	end
	table.sort(allocated)
	return O{
		id = util.specId(spec),
		title = spec.title or "Default",
		treeVersion = spec.treeVersion,
		allocated = allocated,
		pointsUsed = (spec:CountAllocNodes()),
	}
end

local function listSpecs(b)
	local specs = A{ }
	for i, spec in ipairs(b.treeTab.specList) do
		specs[i] = summarise(spec)
	end
	return specs
end

--- Keep the items tab's own tree dropdown in step, as
--- `PassiveSpecListControl:UpdateItemsTabPassiveTreeDropdown` does. Skipping
--- this leaves jewel sockets pointing at a variant that no longer exists.
local function syncControls(b)
	local dropdown = b.itemsTab.controls.specSelect
	if dropdown then
		local titles = { }
		for i, spec in ipairs(b.treeTab.specList) do
			titles[i] = spec.title or "Default"
		end
		dropdown:SetList(titles)
		dropdown.selIndex = b.treeTab.activeSpec
	end
	b.modFlag = true
	if b.SyncLoadouts then b:SyncLoadouts() end
end

M.methods = { }

M.methods["spec.list"] = function()
	local b = util.build()
	return O{ specs = listSpecs(b), active = util.specId(b.spec) }
end

M.methods["spec.create"] = function(params)
	params = params or { }
	local b = util.build()
	if params.title ~= nil and type(params.title) ~= "string" then
		util.invalid("title must be a string")
	end

	local newSpec
	if params.copyFrom ~= nil then
		local _, source = util.specIndex(params.copyFrom)
		-- Copying across tree versions is a conversion, not a copy, so the copy
		-- keeps its source's version and `treeVersion` is ignored here.
		newSpec = new("PassiveSpec", b, source.treeVersion)
		newSpec.jewels = copyTable(source.jewels)
		newSpec:RestoreUndoState(source:CreateUndoState())
		newSpec:BuildClusterJewelGraphs()
		newSpec.title = params.title or ((source.title or "Default") .. " copy")
	else
		local version = params.treeVersion or latestTreeVersion
		if type(version) ~= "string" or not treeVersions[version] then
			util.invalid("unknown tree version " .. tostring(params.treeVersion))
		end
		newSpec = new("PassiveSpec", b, version)
		-- A new variant starts on the same character, or it is not a variant of
		-- anything.
		newSpec:SelectClass(b.spec.curClassId)
		newSpec:SelectAscendClass(b.spec.curAscendClassId)
		if newSpec.SelectSecondaryAscendClass then
			newSpec:SelectSecondaryAscendClass(b.spec.curSecondaryAscendClassId or 0)
		end
		newSpec.title = params.title or "New Tree"
	end

	table.insert(b.treeTab.specList, newSpec)
	syncControls(b)
	return O{ spec = summarise(newSpec) }
end

M.methods["spec.activate"] = function(params)
	params = params or { }
	local b = util.build()
	local index = util.specIndex(params.id)
	b.treeTab:SetActiveSpec(index)
	syncControls(b)
	-- SetActiveSpec already raises buildFlag; applied() runs the frame.
	return buildApi.applied()
end

M.methods["spec.rename"] = function(params)
	params = params or { }
	local b = util.build()
	if type(params.title) ~= "string" or not params.title:match("%S") then
		util.invalid("title must be a non-empty string")
	end
	local _, spec = util.specIndex(params.id)
	spec.title = params.title
	syncControls(b)
	return O{ spec = summarise(spec) }
end

M.methods["spec.delete"] = function(params)
	params = params or { }
	local b = util.build()
	local specList = b.treeTab.specList
	if #specList <= 1 then
		util.invalid("a build must keep at least one tree variant")
	end
	local index = util.specIndex(params.id)

	table.remove(specList, index)
	if index == b.treeTab.activeSpec then
		-- Fall back to the neighbour, as the delete button does.
		b.treeTab:SetActiveSpec(math.max(1, index - 1))
		syncControls(b)
		buildApi.applied()
	else
		b.treeTab.activeSpec = isValueInArray(specList, b.spec)
		syncControls(b)
	end

	return O{ specs = listSpecs(b), active = util.specId(b.spec) }
end

return M
