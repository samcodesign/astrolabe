-- host.info, build.load, build.summary, build.save.

local util = require("api.util")
local A, O = util.array, util.object

local M = { }

-- ---------------------------------------------------------------------------
-- summary

--- The passive point budget PoB itself shows: 99 levels + 23 quest points, plus
--- whatever the build's modifiers grant (Build.lua:EstimatePlayerProgress).
local function pointsTotal(b)
	local extra = b.calcsTab.mainOutput and b.calcsTab.mainOutput.ExtraPoints or 0
	return 99 + 23 + extra
end

--- BuildSummary for the live build.
function M.summary()
	local b = util.build()
	local spec = b.spec
	local used, ascUsed = spec:CountAllocNodes()

	local allocated = A{ }
	for id in pairs(spec.allocNodes) do
		allocated[#allocated + 1] = id
	end
	table.sort(allocated)

	-- JSON object keys are strings; the schema's `Record<NodeId, number>` is a
	-- TypeScript index signature, which is the same thing.
	local masterySelections = O{ }
	for nodeId, effectId in pairs(spec.masterySelections or { }) do
		masterySelections[tostring(nodeId)] = effectId
	end

	return O{
		name = b.buildName or "Unnamed build",
		className = spec.curClassName,
		ascendClassName = spec.curAscendClassName,
		level = b.characterLevel,
		treeVersion = spec.treeVersion,
		allocated = allocated,
		pointsUsed = used,
		pointsTotal = pointsTotal(b),
		ascendancyPointsUsed = ascUsed,
		activeSpec = util.specId(spec),
		masterySelections = masterySelections,
	}
end

--- Recompute the way the UI does after an edit, then answer with the pair every
--- mutating method returns.
function M.applied()
	local b = util.build()
	b.buildFlag = true
	runCallback("OnFrame")
	return O{ summary = M.summary(), stats = require("api.stats").list() }
end

-- ---------------------------------------------------------------------------
-- methods

M.methods = { }

M.methods["host.info"] = function()
	local versions = A{ }
	for i, v in ipairs(treeVersionList) do
		versions[i] = v
	end
	return O{
		hostVersion = RPC_HOST_VERSION,
		pobVersion = launch.versionNumber or "unknown",
		pobCommit = RPC_POB_COMMIT ~= "" and RPC_POB_COMMIT or "unknown",
		treeVersions = versions,
		bootMs = util.round(RPC_BOOT_MS, 1),
	}
end

--- A share code is base64 over a zlib stream, with the URL-safe alphabet.
--- (ImportTab.lua:631 does exactly this in the other direction.)
local function decodeShareCode(code)
	code = code:gsub("%s", "")
	-- A URL is NOT a code. Taking its last path segment yields the site's build
	-- id, which then fails base64 decoding with a message about the code rather
	-- than about the link — so say what actually happened. PoB fetches the code
	-- behind a link before it ever gets here (Modules/BuildSiteTools.lua); the
	-- client does the same.
	if code:match("^https?://") then
		util.invalid("that is a link, not a build code; the client fetches the code behind it")
	end
	local raw = common.base64.decode(code:gsub("%-", "+"):gsub("_", "/"))
	if not raw or raw == "" then
		util.invalid("code is not valid base64")
	end
	local xml = Inflate(raw)
	if not xml or xml == "" then
		util.invalid("code did not inflate to a build; it may be truncated")
	end
	return xml
end

M.decodeShareCode = decodeShareCode

--- Flatten a CharacterPayload into the single table PoB's importer expects.
---
--- `ImportTab:DownloadPassiveTree` and `:DownloadItems` build exactly this by
--- merging the two endpoint responses onto the character-list entry, so we do
--- the same rather than inventing a shape: `passives` and `jewels` come from
--- get-passive-skills, `equipment` and `guardian` from get-items, and the
--- identifying fields (class, level, league) from either response's `character`
--- object.
---
--- Also accepts the flatter shape PoB's own headless helper and its import spec
--- use — a lone character object, or one wrapped in `{ character = ... }` —
--- because that is what `spec/System/SampleCharacter.json` contains.
local function characterData(payload)
	if type(payload) ~= "table" then
		util.invalid("character must be an object")
	end

	if type(payload.items) == "table" or type(payload.passives) == "table" then
		local items = type(payload.items) == "table" and payload.items or { }
		local passives = type(payload.passives) == "table" and payload.passives or nil
		if not passives or type(passives.hashes) ~= "table" then
			util.invalid("character.passives is not a get-passive-skills response")
		end
		if type(items.items) ~= "table" then
			util.invalid("character.items is not a get-items response")
		end

		local base = type(items.character) == "table" and items.character
			or type(passives.character) == "table" and passives.character
			or { }
		local charData = { }
		for key, value in pairs(base) do charData[key] = value end
		charData.name = charData.name or payload.character or "Imported character"
		charData.class = charData.class or "Scion"
		-- ImportPassiveTreeAndJewels matches on the league name to pick the
		-- ruthless tree; a missing one must not be nil there.
		charData.league = charData.league or "Standard"
		charData.passives = passives
		charData.jewels = passives.items
		charData.equipment = items.items
		charData.guardian = items.guardian
		return charData, charData.name
	end

	local charData = type(payload.character) == "table" and payload.character or payload
	if type(charData.equipment) ~= "table" or type(charData.passives) ~= "table" then
		util.invalid(
			"character must be a CharacterPayload with items/passives, "
			.. "or a character object with equipment/passives"
		)
	end
	return charData, charData.name or "Imported character"
end

M.methods["build.load"] = function(params)
	params = params or { }
	local sources = 0
	for _, key in ipairs({ "code", "xml", "character", "empty" }) do
		if params[key] ~= nil and params[key] ~= false then sources = sources + 1 end
	end
	if sources ~= 1 then
		util.invalid("build.load needs exactly one of code, xml, character or empty")
	end

	if params.empty then
		newBuild()
	elseif params.xml then
		if type(params.xml) ~= "string" then util.invalid("xml must be a string") end
		loadBuildFromXML(params.xml, "Imported build")
	elseif params.code then
		if type(params.code) ~= "string" then util.invalid("code must be a string") end
		loadBuildFromXML(decodeShareCode(params.code), "Imported build")
	else
		if type(params.character) ~= "table" then
			util.invalid("character must be the decoded character JSON object")
		end
		local charData, label = characterData(params.character)
		main:SetMode("BUILD", false, label)
		runCallback("OnFrame")
		-- Same order and arguments as HeadlessWrapper's loadBuildFromJSON, which
		-- is itself the same pair of calls ImportTab makes after a download.
		build.importTab:ImportItemsAndSkills(charData)
		build.importTab:ImportPassiveTreeAndJewels(charData)
	end

	build.buildFlag = true
	runCallback("OnFrame")
	return M.summary()
end

M.methods["build.summary"] = function()
	return M.summary()
end

M.methods["build.setLevel"] = function(params)
	params = params or { }
	local b = util.build()
	if type(params.level) ~= "number" then
		util.invalid("build.setLevel needs a numeric level")
	end
	local level = math.floor(params.level)
	if level < 1 or level > 100 then
		util.invalid("level must be between 1 and 100")
	end
	b.characterLevel = level
	-- Setting a level explicitly turns off PoB's "infer the level from points
	-- spent" mode, exactly as typing in the level box does (Build.lua:218).
	b.characterLevelAutoMode = false
	b.controls.characterLevel:SetText(tostring(level))
	b.configTab:BuildModList()
	b.modFlag = true
	return M.applied()
end

M.methods["build.setClass"] = function(params)
	params = params or { }
	local b = util.build()
	local spec = b.spec
	if type(params.className) ~= "string" then
		util.invalid("build.setClass needs a className")
	end

	local classId = spec.tree.classNameMap[params.className]
	if not classId then
		util.invalid("no such class: " .. params.className)
	end

	if classId ~= spec.curClassId then
		-- PoB does not decide this for you. Changing to a class your tree does
		-- not reach either resets the tree or routes a path to it, and it opens
		-- a confirm popup offering both (PassiveTreeView.lua:473-491). Deciding
		-- silently would throw away a tree without asking, so when there is a
		-- real choice we report it and change nothing; the client asks and calls
		-- back with `onConflict`.
		local conflict = spec:CountAllocNodes() > 0 and not spec:IsClassConnected(classId)
		local choice = params.onConflict

		if conflict and (choice == nil or choice == "ask") then
			return O{
				conflict = O{
					kind = "classChange",
					className = params.className,
					message = string.format(
						"Changing class to %s will reset your passive tree.\n"
							.. "This can be avoided by connecting one of the %s "
							.. "starting nodes to your tree.",
						params.className, params.className),
					options = A{ "connect", "reset" },
				},
			}
		end

		if conflict and choice == "connect" then
			if not spec:ConnectToClass(classId) then
				util.invalid("could not connect a path to " .. params.className)
			end
		elseif conflict and choice ~= "reset" then
			util.invalid("onConflict must be \"connect\", \"reset\" or \"ask\"")
		end

		spec:SelectClass(classId)
	end

	if params.ascendClassName ~= nil then
		if type(params.ascendClassName) ~= "string" then
			util.invalid("ascendClassName must be a string")
		end
		if params.ascendClassName == "None" then
			spec:SelectAscendClass(0)
		else
			local entry = spec.tree.ascendNameMap[params.ascendClassName]
			if not entry then
				util.invalid("no such ascendancy: " .. params.ascendClassName)
			end
			if entry.classId ~= spec.curClassId then
				util.invalid(string.format(
					"%s is not an ascendancy of %s",
					params.ascendClassName, spec.curClassName))
			end
			spec:SelectAscendClass(entry.ascendClassId)
		end
	end

	spec:AddUndoState()
	spec:SetWindowTitleWithBuildClass()
	b.modFlag = true
	return M.applied()
end

--- Serialises every tree variant, not just the active one: `TreeTab:Save`
--- writes one `<Spec>` per entry in `specList` and records `activeSpec`.
M.methods["build.save"] = function(params)
	params = params or { }
	local b = util.build()
	if params.as ~= "xml" and params.as ~= "code" then
		util.invalid('build.save needs as = "xml" or "code"')
	end
	-- SaveDB's argument is only used in its error message.
	local xml = b:SaveDB("rpc")
	if not xml then
		util.fail(util.ENGINE_ERROR, "the engine could not serialise this build")
	end
	if params.as == "xml" then
		return O{ data = xml }
	end
	local code = common.base64.encode(Deflate(xml)):gsub("%+", "-"):gsub("/", "_")
	return O{ data = code }
end

return M
