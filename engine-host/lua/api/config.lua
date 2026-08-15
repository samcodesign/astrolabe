-- config.schema / config.state / config.set: PoB's configuration options.
--
-- `Modules/ConfigOptions.lua` is a declarative list of ~1,000 entries — combat
-- conditions, enemy stats, buffs, map mods — and `ConfigTab` turns each one into
-- a control. Almost none of that is UI logic worth reimplementing: the list is
-- data, so we ship the data and let the client render it generically.
--
-- Two things make this more than a table dump.
--
-- **Visibility is per-build and must be decided here.** An entry can carry
-- `ifCond`, `ifSkillData`, `ifNode`, `ifOption`, `ifSkillFlag`, `ifEnemyCond`
-- and more (`ConfigTab.lua:350-630`), and they are answered from live engine
-- state — `mainEnv.conditionsUsed`, the allocated tree, the active skill list,
-- the values of *other* options. Reimplementing those predicates in the client
-- would mean rebuilding half the calculator in TypeScript and getting it
-- quietly wrong. Instead we read PoB's own answer: `ConfigTab` compiles every
-- predicate for an entry into a single `control.shown` closure and files the
-- control under `varControls[var]` (`ConfigTab.lua:320-332`, `:643`). Asking
-- that closure is both cheaper and exactly right.
--
-- **The schema and the state change at different rates.** The option catalogue
-- is fixed for a given game-data version; the values and the visibility mask
-- change on every edit. They are separate methods so a keystroke does not drag
-- a thousand option definitions back across the pipe.

local util = require("api.util")
local buildApi = require("api.build")
local A, O = util.array, util.object

local M = { }

--- The option list, loaded once. This is the same module `ConfigTab` reads
--- (`ConfigTab.lua:12`), so the two cannot drift.
local varList = nil
local function options()
	if varList == nil then
		varList = LoadModule("Modules/ConfigOptions")
	end
	return varList
end

local function configTab()
	local b = util.build()
	if not b.configTab then
		util.fail(util.ENGINE_ERROR, "this build has no config tab")
	end
	return b.configTab
end

local function activeSet(tab)
	return tab.configSets[tab.activeConfigSetId]
end

-- `api.compare` needs to reach the same option table and the same live input
-- map this module writes to, so both are shared rather than reimplemented.
M.configTab = configTab
M.activeSet = activeSet

-- ---------------------------------------------------------------------------
-- schema

--- Numeric entry types, which differ only in what they accept.
--- `count` is non-negative, `integer` and `countAllowZero` allow zero and
--- negatives, `float` allows decimals (`ConfigTab.lua:272-273`).
local NUMERIC = {
	count = true, integer = true, countAllowZero = true, float = true,
}

--- The value the option starts at.
---
--- Numerics deliberately do NOT fall back to zero here. PoB stores an unset
--- numeric as nil, not 0, and its calculator then applies the option's
--- *placeholder* instead (`ConfigTab.lua:1088-1093`). Reporting 0 as the
--- default made the client render "Melee distance to enemy: 0" for an option
--- the engine was computing with 15 — a stated value that was never true.
local function defaultFor(varData)
	if varData.defaultIndex and varData.list then
		local entry = varData.list[varData.defaultIndex]
		return entry and entry.val
	end
	if varData.type == "check" then return varData.defaultState or false end
	return varData.defaultState
end

local function describe(varData)
	local entry = O{
		var = varData.var,
		type = varData.type,
		label = util.plain(varData.label or varData.var),
	}

	-- Only literal tooltips travel. The rest are functions PoB evaluates against
	-- live state at hover time, and several are per-option rather than
	-- per-control, so they need their own pass rather than a string here.
	if type(varData.tooltip) == "string" then
		entry.tooltip = util.plain(varData.tooltip)
	end

	if varData.list then
		local list = A{ }
		for i, option in ipairs(varData.list) do
			-- `val` is what goes back to the engine and may be a string, a
			-- number or a boolean; the label is what the user picks.
			list[i] = O{ value = option.val, label = util.plain(option.label or tostring(option.val)) }
		end
		entry.list = list
	end

	local default = defaultFor(varData)
	if default ~= nil then entry.default = default end
	if varData.type == "float" then entry.step = "any" end
	if varData.type == "count" then entry.min = 0 end

	-- The value the calculator uses when the option is left alone. Fourteen
	-- options declare one — melee distance 15, projectile distance 40, withered
	-- stacks 15 — and `BuildModList` applies it whenever the input is unset
	-- (`ConfigTab.lua:1090-1092`). It is a hint, never a value: showing it as
	-- the value would claim the user set it, and leaving it out entirely
	-- (which is what reading the non-existent `inactiveText` did) claims the
	-- option is doing nothing when it is doing 15.
	if varData.defaultPlaceholderState ~= nil then
		entry.placeholder = varData.defaultPlaceholderState
	end

	return entry
end

M.methods = { }

--- The option catalogue, in PoB's own order and grouping.
---
--- `ConfigOptions` is a flat list in which `{ section = "..." }` entries mark a
--- boundary rather than being options themselves (`ConfigOptions.lua:134`).
M.methods["config.schema"] = function()
	-- Touching the build first means a missing one is a clean NO_BUILD rather
	-- than a nil index deep in the loop.
	util.build()

	local sections = A{ }
	local current = nil
	for _, varData in ipairs(options()) do
		if varData.section then
			current = O{ name = util.plain(varData.section), options = A{ } }
			sections[#sections + 1] = current
		elseif varData.var and current then
			current.options[#current.options + 1] = describe(varData)
		end
	end
	return O{ sections = sections }
end

-- ---------------------------------------------------------------------------
-- state

--- PoB's border colour, read back as the state it encodes
--- (`ConfigTab.lua:665-677`).
---
--- The three cases are: set to something other than the default *and no longer
--- applicable* (reddish), set to something other than the default and
--- applicable (blue), or untouched (grey). Reading the colour is roundabout,
--- but the alternative is reimplementing the predicate — and this way the
--- "other than the default" test is PoB's own `GetDefaultState`, which already
--- treats a placeholder as the default. Getting that subtlety wrong is exactly
--- how the placeholder bug happened.
local INVALID_R, MODIFIED_R = 0.753, 0.451

local function borderState(control)
	if type(control.borderFunc) ~= "function" then return nil end
	local ok, r = pcall(control.borderFunc)
	if not ok or type(r) ~= "number" then return nil end
	if math.abs(r - INVALID_R) < 0.01 then return "invalid" end
	if math.abs(r - MODIFIED_R) < 0.01 then return "modified" end
	return nil
end

--- Current values, live placeholders, and the two masks.
---
--- `shown` is keyed only by the vars currently applicable; anything absent is
--- not relevant to this build right now. `invalid` is the subset of those that
--- are showing *only* because the user set them and the option no longer
--- applies — a stale toggle silently affecting the numbers, which is the one
--- thing a config panel must not hide.
function M.state()
	local tab = configTab()
	local set = activeSet(tab)

	local values = O{ }
	local placeholders = O{ }
	local shown = O{ }
	local invalid = O{ }
	local modified = O{ }
	for _, varData in ipairs(options()) do
		local var = varData.var
		if var then
			local value = set.input[var]
			if value ~= nil then values[var] = value end

			-- Live, per-set, and not always the declared one: PoB recomputes
			-- some at runtime, e.g. enemy level from the character's
			-- (`ConfigTab.lua:1062-1072`).
			local ph = set.placeholder[var]
			if ph ~= nil then placeholders[var] = ph end

			local control = tab.varControls[var]
			if control then
				-- `GetProperty` evaluates this control's own predicate.
				-- `IsShown` would also walk the anchor chain into PoB's layout,
				-- which encodes section collapse and window geometry — nothing
				-- to do with whether the option applies to the build.
				local ok, visible = pcall(control.GetProperty, control, "shown")
				if ok and visible then shown[var] = true end

				local state = borderState(control)
				if state == "invalid" then
					invalid[var] = true
					modified[var] = true
				elseif state == "modified" then
					modified[var] = true
				end
			end
		end
	end

	local sets = A{ }
	for i, id in ipairs(tab.configSetOrderList) do
		sets[i] = O{ id = id, title = util.plain(tab.configSets[id].title or "Default") }
	end

	return O{
		values = values,
		placeholders = placeholders,
		shown = shown,
		invalid = invalid,
		modified = modified,
		sets = sets,
		activeSet = tab.activeConfigSetId,
	}
end

M.methods["config.state"] = function()
	return M.state()
end

-- ---------------------------------------------------------------------------
-- mutation

--- Coerce an incoming value to what the entry's type stores.
---
--- The client sends JSON, so a `check` arrives as a boolean and a `count` as a
--- number — but a `list` entry's value can be any of string, number or boolean
--- depending on the option, so those are matched against the declared list
--- rather than coerced.
local function coerce(varData, value)
	local kind = varData.type

	if kind == "check" then
		if type(value) ~= "boolean" then
			util.invalid(varData.var .. " is a checkbox and takes true or false")
		end
		return value
	end

	if NUMERIC[kind] then
		if type(value) ~= "number" then
			util.invalid(varData.var .. " takes a number")
		end
		if kind ~= "float" then value = math.floor(value) end
		if kind == "count" and value < 0 then
			util.invalid(varData.var .. " cannot be negative")
		end
		return value
	end

	if kind == "text" then
		if type(value) ~= "string" then
			util.invalid(varData.var .. " takes a string")
		end
		return value
	end

	if kind == "list" then
		for _, option in ipairs(varData.list or { }) do
			if option.val == value then return option.val end
		end
		util.invalid(string.format("%s has no option %s", varData.var, tostring(value)))
	end

	util.invalid("cannot set an option of type " .. tostring(kind))
end

local function findVar(var)
	for _, varData in ipairs(options()) do
		if varData.var == var then return varData end
	end
	util.invalid("no such config option: " .. tostring(var))
end

-- Shared with `api.compare`, so a hover comparison validates an incoming value
-- against exactly the same rules as the commit that follows it.
M.findVar = findVar
M.coerce = coerce

--- Set one or more options.
---
--- Takes a map so a client can apply several at once — importing quest choices
--- writes bandit and both pantheons together, and doing that in one call means
--- one recalculation instead of three.
---
--- `clear` unsets options back to "never touched", which is not the same as
--- setting them to their default value: PoB distinguishes the two when it
--- decides what to highlight and what to write out. It is a separate list
--- rather than a null in `values` because a JSON null decodes to nil here, and
--- a nil value simply removes the key before `pairs` ever sees it.
M.methods["config.set"] = function(params)
	params = params or { }
	local values = params.values
	local clear = params.clear
	if values ~= nil and type(values) ~= "table" then
		util.invalid("config.set values must be an object")
	end
	if clear ~= nil and type(clear) ~= "table" then
		util.invalid("config.set clear must be an array of option names")
	end
	if values == nil and clear == nil then
		util.invalid("config.set needs values, clear, or both")
	end

	local tab = configTab()
	local set = activeSet(tab)
	local touched = false

	--- Push the stored value back onto PoB's own control. Other entries'
	--- `shown` predicates read these (`ifOption` reads the input table, and the
	--- borderFunc reads `control.state`), so a control left stale makes the
	--- visibility mask wrong for its neighbours rather than for itself.
	local function syncControl(varData)
		local control = tab.varControls[varData.var]
		if not control then return end
		local value = set.input[varData.var]
		if varData.type == "check" then
			control.state = value or false
		elseif varData.type == "list" and control.SelByValue then
			pcall(control.SelByValue, control, value, "val")
		elseif control.SetText then
			pcall(control.SetText, control, value ~= nil and tostring(value) or "")
		end
	end

	for _, var in ipairs(clear or { }) do
		if type(var) ~= "string" then
			util.invalid("config.set clear must contain option names")
		end
		local varData = findVar(var)
		set.input[var] = nil
		syncControl(varData)
		touched = true
	end

	for var, value in pairs(values or { }) do
		if type(var) ~= "string" then
			util.invalid("config option names must be strings")
		end
		local varData = findVar(var)
		set.input[var] = coerce(varData, value)
		syncControl(varData)
		touched = true
	end

	if not touched then
		return O{ summary = buildApi.summary(), stats = require("api.stats").list(), config = M.state() }
	end

	-- PoB's own order after any config edit (`ConfigTab.lua:267-271`).
	tab:AddUndoState()
	tab:BuildModList()
	local result = buildApi.applied()
	-- The mask ships with the result: changing one option can reveal or hide
	-- others, so a client that only re-read values would show a stale form.
	result.config = M.state()
	return result
end

-- ---------------------------------------------------------------------------
-- custom modifiers
--
-- Arbitrary mod text applied to the build, in named groups you can enable
-- individually. Invisible to `config.schema` because `Custom Modifiers` is a
-- bare section marker in `ConfigOptions.lua` with no entries under it — the
-- blocks are built at runtime from `configSet.customModsList`.
--
-- The part worth care is reporting *why* a line did not take. PoB's
-- `BuildModList` has no else branch (`ConfigTab.lua:1106-1129`): a line that
-- fails to parse is dropped in silence, and the only feedback anywhere is the
-- colour of the text in the box. So the per-line report below is ours, not a
-- projection of something PoB computes.

--- Classify one line the way `BuildModList` decides whether to apply it.
---
--- `modLib.parseMod` returns `(mods, extra)` and there is no error object in
--- PoB at all. The four outcomes are distinguishable and worth distinguishing:
--- a typo and a mod the engine knows but does not implement need different
--- words.
local function classifyLine(text)
	local stripped = StripEscapes(text):match("^%s*(.-)%s*$")
	if stripped == "" then
		-- `parseMod("")` returns `nil, " "`, so a blank line would otherwise be
		-- reported as an error and every paragraph break would look broken.
		return { ok = true, blank = true }
	end

	local ok, mods, extra = pcall(modLib.parseMod, stripped)
	if not ok then
		return { ok = false, reason = "unparsed", text = stripped }
	end

	if mods and not extra then
		return { ok = true, count = #mods }
	end
	if mods and #mods == 0 then
		-- Recognised, but on PoB's explicit unsupported list
		-- (`ModParser.lua:5891-5895`).
		return { ok = false, reason = "unsupported", text = stripped }
	end
	if mods then
		-- Parsed, but with text left over — the mod applies only in part, which
		-- PoB treats as a failure and drops entirely.
		return { ok = false, reason = "partial", text = stripped, leftover = extra }
	end
	return { ok = false, reason = "unrecognised", text = stripped }
end

--- Every line of a block, in order, with its verdict.
local function validate(text)
	local lines = A{ }
	local index = 0
	-- Matches PoB's own iteration (`ConfigTab.lua:1107`), which yields a final
	-- empty element; `classifyLine` treats those as blank.
	for line in (text or ""):gmatch("([^\n]*)\n?") do
		index = index + 1
		local verdict = classifyLine(line)
		if not verdict.blank then
			lines[#lines + 1] = O{
				line = index,
				text = line,
				ok = verdict.ok,
				reason = verdict.reason,
				leftover = verdict.leftover,
			}
		end
	end
	return lines
end

local function blockEntry(i, block)
	return O{
		index = i,
		title = util.plain(block.title or "Default"),
		-- `nil` counts as enabled: every check in PoB is `~= false`.
		enabled = block.enabled ~= false,
		text = block.text or "",
		lines = validate(block.text),
	}
end

local function customBlocks(tab)
	local set = activeSet(tab)
	set.customModsList = set.customModsList or { }
	if #set.customModsList == 0 then
		-- PoB keeps at least one, re-seeding after a delete
		-- (`ConfigTab.lua:26-28`, `:1257-1259`).
		table.insert(set.customModsList, { title = "Default", enabled = true, text = "" })
	end
	return set.customModsList
end

function M.customMods()
	local tab = configTab()
	local blocks = A{ }
	for i, block in ipairs(customBlocks(tab)) do
		blocks[i] = blockEntry(i, block)
	end
	return O{ blocks = blocks }
end

M.methods["config.customMods"] = function()
	return M.customMods()
end

--- Check text without committing it, for feedback while typing.
M.methods["config.validateMods"] = function(params)
	params = params or { }
	if type(params.text) ~= "string" then
		util.invalid("config.validateMods needs text")
	end
	return O{ lines = validate(params.text) }
end

local function blockAt(tab, index)
	local list = customBlocks(tab)
	if type(index) ~= "number" then
		util.invalid("block index must be a number")
	end
	local block = list[math.floor(index)]
	if not block then
		util.invalid(string.format("no custom mod block %d (there are %d)",
			math.floor(index), #list))
	end
	return block, list
end

--- PoB's epilogue after any custom-mod edit (`ConfigTab.lua:29-32`).
local function appliedWithMods()
	local tab = configTab()
	tab:AddUndoState()
	tab:BuildModList()
	local result = buildApi.applied()
	result.config = M.state()
	result.customMods = M.customMods()
	return result
end

M.methods["config.addCustomMod"] = function(params)
	params = params or { }
	local tab = configTab()
	local list = customBlocks(tab)
	if params.title ~= nil and type(params.title) ~= "string" then
		util.invalid("title must be a string")
	end
	table.insert(list, {
		title = params.title or ("Group " .. (#list + 1)),
		enabled = true,
		text = params.text or "",
	})
	local result = appliedWithMods()
	result.addedBlock = #list
	return result
end

M.methods["config.setCustomMod"] = function(params)
	params = params or { }
	local tab = configTab()
	local block = blockAt(tab, params.index)

	if params.title ~= nil then
		if type(params.title) ~= "string" then util.invalid("title must be a string") end
		block.title = params.title
	end
	if params.enabled ~= nil then
		if type(params.enabled) ~= "boolean" then util.invalid("enabled must be a boolean") end
		block.enabled = params.enabled
	end
	if params.text ~= nil then
		if type(params.text) ~= "string" then util.invalid("text must be a string") end
		-- Leading and trailing blank lines do not survive a save/load round
		-- trip — the XML layer strips surrounding whitespace (`xml.lua:52-58`) —
		-- so trimming here keeps what is on screen equal to what is on disk.
		block.text = params.text:gsub("^%s*\n", ""):gsub("\n%s*$", "")
	end

	return appliedWithMods()
end

M.methods["config.deleteCustomMod"] = function(params)
	params = params or { }
	local tab = configTab()
	local _, list = blockAt(tab, params.index)
	table.remove(list, math.floor(params.index))
	-- `customBlocks` re-seeds an empty list on the way back out, as PoB does.
	return appliedWithMods()
end

-- ---------------------------------------------------------------------------
-- config sets
--
-- A build can hold several complete sets of option values and switch between
-- them — "mapping" against "bossing", say — which is why `input` lives on a set
-- rather than on the tab (`ConfigTab.lua:1224-1244`). The set is part of the
-- build and is saved with it, so faking this client-side would lose it.

local function applyAndState()
	local tab = configTab()
	tab:AddUndoState()
	tab:BuildModList()
	local result = buildApi.applied()
	result.config = M.state()
	return result
end

local function setIndex(tab, id)
	for i, other in ipairs(tab.configSetOrderList) do
		if other == id then return i end
	end
	return nil
end

local function requireSet(tab, id)
	if type(id) ~= "number" then
		util.invalid("config set id must be a number")
	end
	id = math.floor(id)
	if not tab.configSets[id] then
		util.invalid("no such config set: " .. tostring(id))
	end
	return id
end

M.methods["config.newSet"] = function(params)
	params = params or { }
	local tab = configTab()
	if params.title ~= nil and type(params.title) ~= "string" then
		util.invalid("title must be a string")
	end

	-- `NewConfigSet` seeds every option with its declared default, which is
	-- what makes a new set a clean slate rather than an empty table the
	-- calculator would read nils out of.
	local created = tab:NewConfigSet(nil, params.title or "New Config Set")

	if params.copyFrom ~= nil then
		local source = tab.configSets[requireSet(tab, params.copyFrom)]
		created.input = copyTable(source.input)
		created.placeholder = copyTable(source.placeholder)
		created.customModsList = copyTable(source.customModsList, true)
		created.title = params.title or ((source.title or "Default") .. " copy")
	end

	table.insert(tab.configSetOrderList, created.id)
	tab:AddUndoState()
	local result = applyAndState()
	result.createdSet = created.id
	return result
end

M.methods["config.activateSet"] = function(params)
	params = params or { }
	local tab = configTab()
	local id = requireSet(tab, params.id)
	-- `SetActiveConfigSet` repoints `tab.input` at this set's table, which is
	-- the same table `env.configInput` reads (`CalcSetup.lua:395`) — so this one
	-- call is what actually swaps the values the calculator sees.
	tab:SetActiveConfigSet(id)
	return applyAndState()
end

M.methods["config.renameSet"] = function(params)
	params = params or { }
	local tab = configTab()
	local id = requireSet(tab, params.id)
	if type(params.title) ~= "string" or not params.title:match("%S") then
		util.invalid("title must be a non-empty string")
	end
	tab.configSets[id].title = params.title
	tab:AddUndoState()
	return O{ config = M.state() }
end

M.methods["config.deleteSet"] = function(params)
	params = params or { }
	local tab = configTab()
	local id = requireSet(tab, params.id)
	if #tab.configSetOrderList <= 1 then
		util.invalid("a build must keep at least one config set")
	end

	local index = setIndex(tab, id)
	table.remove(tab.configSetOrderList, index)
	tab.configSets[id] = nil

	-- Deleting the active set would leave `tab.input` pointing at a table
	-- nothing owns any more, and the calculator would keep reading it.
	if tab.activeConfigSetId == id then
		local fallback = tab.configSetOrderList[math.max(1, index - 1)]
		tab:SetActiveConfigSet(fallback)
	end

	tab:AddUndoState()
	return applyAndState()
end

return M
