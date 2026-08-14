-- tree.geometry, tree.allocate, tree.deallocate, tree.path, tree.search.

local util = require("api.util")
local buildApi = require("api.build")
local statsApi = require("api.stats")
local images = require("api.images")
local A, O = util.array, util.object
local round = util.round

local M = { }

-- ---------------------------------------------------------------------------
-- geometry

--- PoB's node types, mapped onto the names the schema uses.
local NODE_TYPE = {
	Normal = "normal",
	Notable = "notable",
	Keystone = "keystone",
	Mastery = "mastery",
	Socket = "socket",
	ClassStart = "classStart",
	-- Kept distinct from a plain ascendancy node: pathing may start from one of
	-- these but never route through it (PassiveSpec.lua:926).
	AscendClassStart = "ascendClassStart",
}

local CONNECTOR_STATES = { Normal = "normal", Intermediate = "intermediate", Active = "active" }

--- Ring art for jewel radii, by the `art` name `tree.jewels` reports.
--- Two sprites per jewel: PoB draws them counter-rotated so the pair reads as
--- one ornate ring (PassiveTreeView.lua:1179-1204).
local RING_ART = {
	"PassiveSkillScreenEternalEmpireJewelCircle1",
	"PassiveSkillScreenEternalEmpireJewelCircle2",
	"PassiveSkillScreenKaruiJewelCircle1",
	"PassiveSkillScreenKaruiJewelCircle2",
	"PassiveSkillScreenMarakethJewelCircle1",
	"PassiveSkillScreenMarakethJewelCircle2",
	"PassiveSkillScreenTemplarJewelCircle1",
	"PassiveSkillScreenTemplarJewelCircle2",
	"PassiveSkillScreenVaalJewelCircle1",
	"PassiveSkillScreenVaalJewelCircle2",
	"PassiveSkillScreenKalguuranJewelCircle1",
	"PassiveSkillScreenKalguuranJewelCircle2",
}

--- The socket art for a socketed jewel, by base type.
---
--- PoB does not draw the gem as a separate image: it swaps the socket's own
--- overlay sprite (PassiveTreeView.lua:126-155). A cluster jewel's own
--- expansion sockets use the "Alt" variants.
local function socketOverlay(jewel, isExpansion)
	local base = jewel.baseName or ""
	local subType = jewel.base and jewel.base.subType
	local function pick(plain, alt)
		return isExpansion and alt or plain
	end
	if base == "Crimson Jewel" then return pick("JewelSocketActiveRed", "JewelSocketActiveRedAlt") end
	if base == "Viridian Jewel" then return pick("JewelSocketActiveGreen", "JewelSocketActiveGreenAlt") end
	if base == "Cobalt Jewel" then return pick("JewelSocketActiveBlue", "JewelSocketActiveBlueAlt") end
	if base == "Prismatic Jewel" then return pick("JewelSocketActivePrismatic", "JewelSocketActivePrismaticAlt") end
	if subType == "Abyss" then return pick("JewelSocketActiveAbyss", "JewelSocketActiveAbyssAlt") end
	if subType == "Charm" then
		if base == "Ursine Charm" then return "CharmSocketActiveStr" end
		if base == "Corvine Charm" then return "CharmSocketActiveInt" end
		if base == "Lupine Charm" then return "CharmSocketActiveDex" end
		return nil
	end
	if base == "Timeless Jewel" then return pick("JewelSocketActiveLegion", "JewelSocketActiveLegionAlt") end
	if base == "Large Cluster Jewel" then return "JewelSocketActiveAltPurple" end
	if base == "Medium Cluster Jewel" then return "JewelSocketActiveAltBlue" end
	if base == "Small Cluster Jewel" then return "JewelSocketActiveAltRed" end
	return nil
end

--- The generic rings, which every jewel without art of its own uses.
---
--- Unlike the timeless art these live in `Assets/`, not `TreeData/`, and PoB
--- loads them by path at construction (PassiveTreeView.lua:33-40) rather than
--- through the tree's atlases — so they have to be registered by hand.
local SHADED_RING_ART = {
	"ShadedOuterRing",
	"ShadedOuterRingFlipped",
	"ShadedInnerRing",
	"ShadedInnerRingFlipped",
}

--- `art` -> the two sprite keys, in draw order.
local RING_SPRITES = {
	eternal = { "PassiveSkillScreenEternalEmpireJewelCircle1", "PassiveSkillScreenEternalEmpireJewelCircle2" },
	karui = { "PassiveSkillScreenKaruiJewelCircle1", "PassiveSkillScreenKaruiJewelCircle2" },
	maraketh = { "PassiveSkillScreenMarakethJewelCircle1", "PassiveSkillScreenMarakethJewelCircle2" },
	templar = { "PassiveSkillScreenTemplarJewelCircle1", "PassiveSkillScreenTemplarJewelCircle2" },
	vaal = { "PassiveSkillScreenVaalJewelCircle1", "PassiveSkillScreenVaalJewelCircle2" },
	kalguur = { "PassiveSkillScreenKalguuranJewelCircle1", "PassiveSkillScreenKalguuranJewelCircle2" },
	default = { "ShadedOuterRing", "ShadedOuterRingFlipped" },
}

--- The second, smaller pair a generic jewel draws inside the outer one. Only
--- `default` has one: the timeless jewels draw a single ring and nothing else
--- (PassiveTreeView.lua:1178-1199).
local INNER_RING_SPRITES = {
	default = { "ShadedInnerRing", "ShadedInnerRingFlipped" },
}

--- PoB nudges the inner ring out slightly rather than sitting it exactly on the
--- inner radius (PassiveTreeView.lua:1166). The outer ring gets no such factor.
local INNER_RING_SCALE = 1.06

--- Where an image actually sits, as a path under Path of Building's `src`.
---
--- That is PoB's own namespace for art — it loads tree sheets as
--- `TreeData/legion/legion-art.png` and the jewel rings as
--- `Assets/ShadedOuterRing.png`, both relative to `src` — so using it here means
--- an asset outside `TreeData` is nameable at all. Rooting on `TreeData` instead
--- left the four shaded-ring images unreachable, and a plain jewel fell back to
--- a bare circle with nothing reporting why.
---
--- When an image is not vendored (some are only ever fetched by the desktop
--- client) we still report the expected location, so the frontend can tell what
--- is missing.
local function sheetPath(treeVersion, fileName)
	return "TreeData/" .. (images.resolve(treeVersion, fileName) or (treeVersion .. "/" .. fileName))
end

--- Sprite coordinate fields are sometimes per-zoom-level arrays; take the
--- largest, which is what `PassiveTree` does when it builds its spriteMap.
local function largest(v)
	return type(v) == "table" and v[#v] or v
end

--- True for a node a timeless jewel has conquered for the Abyss. Mirrors
--- `isAbyssConquered` (PassiveTreeView.lua:23-26); the Abyss variants of the
--- frames and connector art are drawn only for these.
local function isAbyssConquered(node)
	local conqueror = node and node.conqueredBy and node.conqueredBy.conqueror
	return (conqueror and conqueror.type and conqueror.type:match("^abyss_")) ~= nil
end

--- Register the legion sprite sheets.
---
--- `PassiveTree` loads these from their own directory, separately from the
--- version's atlases, and merges them into `spriteMap` and `assets`
--- (PassiveTree.lua:366-411). They are the *only* source of artwork for a node
--- a timeless jewel has replaced: `ReplaceNode` copies `icon` and `sprites`
--- straight off a legion node (PassiveSpec.lua:1620-1635), and that icon path
--- appears in no version atlas. Without this pass a conquered node exports with
--- an empty `icon` and renders as a bare frame — the node keeps its new name
--- and stats, so nothing anywhere reports a failure.
---
--- `treeAssets` carries the Abyss frames and orbit art, which is the same story
--- for the ring drawn around such a node.
--- Shared by every tree version, and re-read on each geometry export otherwise —
--- which happens after every jewel change.
local legionSprites = nil

local function addLegionSprites(sprites, sheets)
	if legionSprites == nil then
		local ok, loaded = pcall(LoadModule, "TreeData/legion/tree-legion.lua")
		legionSprites = (ok and type(loaded) == "table") and loaded or false
	end
	local legion = legionSprites
	if not legion then return end

	--- Legion art sits under `TreeData/legion/`, not under a version directory,
	--- so it is shared by every tree version and named accordingly.
	local function sheetOf(entry)
		if not entry or not entry.filename then return nil end
		sheets[entry.filename] = "TreeData/legion/" .. entry.filename
		return entry.filename
	end

	local function put(key, fileName, coords)
		sprites[key] = O{
			sheet = fileName,
			x = largest(coords.x),
			y = largest(coords.y),
			w = largest(coords.w),
			h = largest(coords.h),
		}
	end

	for spriteType, data in pairs(legion) do
		if spriteType == "treeAssets" then
			-- Keyed by bare asset name, as `tree.assets` is. Registered after that
			-- pass so the real art replaces the standalone-file entry it invents
			-- for a name it cannot resolve — `AbyssNotableFrameAllocated.png` does
			-- not exist on disk, and every Abyss frame pointed at one.
			for _, entry in ipairs(data) do
				local fileName = sheetOf(entry)
				if fileName then
					for name, coords in pairs(entry.coords or { }) do
						put(name, fileName, coords)
					end
				end
			end
		else
			-- `keystoneActive`, `notableInactive`, ... — the same type names the
			-- version atlases use, so `nodeIcon`'s existing key needs no special
			-- case. PoB takes the last (largest) zoom level and lets legion
			-- overwrite a same-named base entry rather than guarding the write.
			local fileName = sheetOf(data[#data])
			if fileName then
				for name, coords in pairs(data[#data].coords or { }) do
					put(spriteType .. "/" .. name, fileName, coords)
				end
			end
		end
	end
end

--- Flatten the sprite sheets into `sprites` (key -> sub-rect, in sheet pixels)
--- and `sheets` (file -> path under TreeData).
---
--- Two kinds of key end up in `sprites`:
---   * `<spriteType>/<art path>` for node icons, whose art path is shared
---     between the active and disabled atlases (`skills-3.jpg` and
---     `skills-disabled-3.jpg`), which is how the game dims unallocated nodes.
---   * the bare asset name for everything else — frames, connector art, group
---     backgrounds, class art — because those atlases are keyed by asset name
---     already, and it is what `TreeConnector.sheet` and the group `background`
---     refer to.
---
--- Any asset that is *not* in an atlas gets a whole-image entry pointing at its
--- own file, so the renderer only ever needs one rule: look the key up in
--- `sprites`, then its `sheet` up in `sheets`.
local function buildAtlas(tree)
	local versionNum = treeVersions[tree.treeVersion].num
	local sprites, sheets = O{ }, O{ }
	-- spriteMap entry -> our ref, so an asset PoB resolved to an atlas entry can
	-- be matched back by identity rather than by name.
	local byEntry = { }

	for spriteType, data in pairs(tree.skillSprites or { }) do
		local maxZoom
		if not tree.imageZoomLevels then
			maxZoom = data
		elseif versionNum >= 3.19 then
			maxZoom = data[0.3835] or data[1]
		else
			maxZoom = data[#data]
		end
		if maxZoom and maxZoom.coords then
			local fileName = maxZoom.filename:gsub("%?%x+$", "")
			if versionNum >= 3.16 then
				fileName = fileName:gsub(".*/", "")
			end
			sheets[fileName] = sheetPath(tree.treeVersion, fileName)
			-- The per-ascendancy "bloodline" atlases repeat the same asset names
			-- with different art; PoB reaches them through a name prefix, so they
			-- must not claim the bare name here.
			local isVariant = spriteType:match("Bloodline$") ~= nil
			for name, coords in pairs(maxZoom.coords) do
				local entry = O{
					sheet = fileName,
					x = largest(coords.x),
					y = largest(coords.y),
					w = largest(coords.w),
					h = largest(coords.h),
				}
				sprites[spriteType .. "/" .. name] = entry
				if not isVariant and not name:find("/", 1, true) and not sprites[name] then
					sprites[name] = entry
				end
				local mapped = tree.spriteMap and tree.spriteMap[name] and tree.spriteMap[name][spriteType]
				if mapped then byEntry[mapped] = entry end
			end
		end
	end

	-- `tree.assets` is the name space the rest of the payload uses. Some entries
	-- PoB has already redirected into an atlas (the bloodline frames and the
	-- alternate-ascendancy emblems, PassiveTree.lua:337-360); match those by
	-- identity so the right variant wins, and fall back to the standalone file
	-- for everything else.
	for name, asset in pairs(tree.assets or { }) do
		local matched = byEntry[asset]
		if matched then
			sprites[name] = matched
		else
			-- `tree.assets` wins over a same-named spriteMap entry, and must
			-- overwrite one that is already there.
			--
			-- The two are not interchangeable. `LineConnectorNormal` exists in
			-- both: the standalone PNG is 736x16, the atlas tile in line-3.png
			-- is 368x13 — a different crop at half the width. PoB's connector
			-- rendering reads `tree.assets` (PassiveTreeView.lua:719-732) and
			-- computes geometry from the same asset's dimensions
			-- (`art.height * 1.33` for the half-width, `dist / (art.width *
			-- 1.33)` for the tiling count). Resolve the art to the atlas while
			-- the geometry came from the standalone file and every straight
			-- link is drawn with art of the wrong size and repeat frequency.
			local fileName = name .. ".png"
			sheets[fileName] = sheetPath(tree.treeVersion, fileName)
			sprites[name] = O{
				sheet = fileName,
				x = 0,
				y = 0,
				w = asset.width or 0,
				h = asset.height or 0,
			}
		end
	end

	addLegionSprites(sprites, sheets)

	-- The jewel radius ring art.
	--
	-- PoB loads these by path rather than through `tree.assets`
	-- (PassiveTreeView.lua:33-58), so they never reach the atlas on their own —
	-- but a client cannot draw a jewel's radius the way PoB does without them.
	-- Each timeless jewel has its own pair, drawn as two counter-rotated copies;
	-- every other jewel uses the generic shaded rings.
	local function addWholeImage(name, path)
		if sprites[name] or not path then return end
		local w, h = images.readSize(path)
		if not w or not h then return end
		local fileName = name .. ".png"
		sheets[fileName] = path
		sprites[name] = O{ sheet = fileName, x = 0, y = 0, w = w, h = h }
	end

	for _, name in ipairs(RING_ART) do
		local found = images.resolve(tree.treeVersion, name .. ".png")
		addWholeImage(name, found and ("TreeData/" .. found))
	end
	for _, name in ipairs(SHADED_RING_ART) do
		addWholeImage(name, "Assets/" .. name .. ".png")
	end

	-- Drop sheets nothing points at any more.
	--
	-- The `tree.assets` pass invents a standalone file per asset name, and the
	-- legion pass then re-points 30 of those names — the Abyss frames and orbit
	-- art — at `legion-art.png`, where the art actually is. Their invented
	-- `AbyssOrbit1Normal.png` entries survived the re-point and had the client
	-- fetching 30 files that have never existed. Harmless to look at, but the
	-- renderer loads every sheet named here, so it is 30 guaranteed failures on
	-- every tree load and 30 lines of noise now that those get reported.
	--
	-- A sheet is reachable only by being named in some sprite, so that is the
	-- whole test. What remains missing after this is genuinely missing:
	-- `PassiveMasteryConnectedButton` is listed in GGG's asset table and ships
	-- no file, and reporting it is the point.
	local used = { }
	for _, entry in pairs(sprites) do used[entry.sheet] = true end
	for name in pairs(sheets) do
		if not used[name] then sheets[name] = nil end
	end

	return sprites, sheets
end

--- Look up a sprite by key, returning a copy so each node owns its refs.
local function ref(sprites, key)
	local found = key and sprites[key]
	if not found then return nil end
	return O{ sheet = found.sheet, x = found.x, y = found.y, w = found.w, h = found.h }
end

--- The node's own artwork, per allocation state.
---
--- `PassiveTreeView` picks `node.sprites[type:lower()..(alloc and "Active" or
--- "Inactive")]` for ordinary nodes and a different set for masteries; the two
--- atlases behind those keys are the coloured and desaturated sheets.
local function nodeIcon(node, sprites)
	local icon = O{ }
	if node.type == "Mastery" then
		if node.masteryEffects then
			icon.active = ref(sprites, node.activeIcon and ("masteryActiveSelected/" .. node.activeIcon))
			icon.inactive = ref(sprites, node.inactiveIcon and ("masteryInactive/" .. node.inactiveIcon))
		else
			local plain = ref(sprites, node.icon and ("mastery/" .. node.icon))
			icon.active, icon.inactive = plain, plain
		end
		return icon
	end
	if node.type == "ClassStart" or node.type == "AscendClassStart" or node.type == "Socket" then
		-- These have no icon of their own; the frame is the whole artwork.
		return icon
	end
	if node.icon then
		local kind = node.type:lower()
		icon.active = ref(sprites, kind .. "Active/" .. node.icon)
		icon.inactive = ref(sprites, kind .. "Inactive/" .. node.icon)
	end
	return icon
end

--- The ring drawn around the icon, which is what actually shows state. PoB
--- keys these off `node.overlay[state .. suffixes]` (PassiveTreeView.lua:877).
local function nodeFrame(node, sprites)
	local frame = O{ }
	if node.type == "ClassStart" then
		frame.allocated = ref(sprites, node.startArt)
		frame.unallocated = ref(sprites, "PSStartNodeBackgroundInactive")
		frame.path = frame.unallocated
		return frame
	end
	if node.type == "AscendClassStart" then
		local prefix = node.bloodlineOverlayPrefix or ""
		local art = ref(sprites, prefix .. "AscendancyMiddle") or ref(sprites, "AscendancyMiddle")
		frame.allocated, frame.path, frame.unallocated = art, art, art
		return frame
	end
	if not node.overlay then return frame end

	local suffix = ""
	if node.type == "Socket" then
		suffix = node.expansionJewel and "Alt" or ""
	else
		suffix = (node.ascendancyName and "Ascend" or "") .. (node.isBlighted and "Blighted" or "")
	end
	local prefix = (node.ascendancyName and node.bloodlineOverlayPrefix) or ""
	local function frameRef(state)
		local name = node.overlay[state .. suffix] or node.overlay[state]
		if not name then return nil end
		return ref(sprites, prefix .. name) or ref(sprites, name)
	end
	frame.allocated = frameRef("alloc")
	frame.path = frameRef("path")
	frame.unallocated = frameRef("unalloc")

	-- An Abyss-conquered notable or keystone gets its own frames
	-- (PassiveTreeView.lua:880-889). PoB falls back to the ordinary overlay when
	-- the asset is absent, which is what the `or` here preserves.
	if isAbyssConquered(node) and (node.type == "Notable" or node.type == "Keystone") then
		local frameType = node.ascendancyName and "Ascendancy" or node.type
		local function abyss(state)
			return ref(sprites, "Abyss" .. frameType .. "Frame" .. state)
		end
		frame.allocated = abyss("Allocated") or frame.allocated
		frame.path = abyss("CanAllocate") or frame.path
		frame.unallocated = abyss("Unallocated") or frame.unallocated
	end
	return frame
end

--- The glow drawn over an allocated mastery, or a tattooed node's backdrop.
local function nodeEffect(node, sprites)
	if node.type == "Mastery" and node.masteryEffects and node.activeEffectImage then
		return ref(sprites, "masteryActiveEffect/" .. node.activeEffectImage)
	end
	if node.isTattoo and node.activeEffectImage then
		return ref(sprites, "tattooActiveEffect/" .. node.activeEffectImage)
	end
	return nil
end

--- The chooser's options for a mastery node.
---
--- `available` is false when the effect is already taken by a *different*
--- mastery: PoB filters its popup on exactly this test
--- (TreeTab.lua:OpenMasteryPopup), because an effect may be used once per tree.
local function masteryEffects(node, spec)
	if node.type ~= "Mastery" or not node.masteryEffects then return nil end
	local effects = A{ }
	for _, option in ipairs(node.masteryEffects) do
		local effect = spec and spec.tree.masteryEffects[option.effect]
		local stats = A{ }
		for i, line in ipairs((effect and effect.sd) or option.stats or { }) do
			stats[i] = util.plain(line)
		end
		local takenBy = spec and isValueInTable(spec.masterySelections, option.effect)
		effects[#effects + 1] = O{
			id = option.effect,
			stats = stats,
			available = (not takenBy) or takenBy == node.id,
		}
	end
	return effects
end

M.masteryEffects = masteryEffects

local function nodeEntry(node, static, sprites, spec)
	local stats = A{ }
	for i, line in ipairs(node.sd or { }) do
		stats[i] = util.plain(line)
	end
	-- The passive graph, which is NOT the same as the drawn connectors: PoB
	-- records a link for every pair but skips drawing one when either end is a
	-- Mastery or ClassStart (PassiveTree.lua:610-613). Export the links so path
	-- finding can reach masteries at all.
	local linked = A{ }
	for _, otherId in ipairs(node.linkedId or { }) do
		linked[#linked + 1] = otherId
	end

	return O{
		id = node.id,
		name = node.dn or node.name or "",
		type = NODE_TYPE[node.type] or "normal",
		linked = linked,
		x = round(node.x, 1),
		y = round(node.y, 1),
		icon = nodeIcon(node, sprites),
		frame = nodeFrame(node, sprites),
		effect = nodeEffect(node, sprites),
		stats = stats,
		ascendancy = node.ascendancyName,
		radius = round(node.size or (node.overlay and node.overlay.size) or 0, 1),
		synthetic = (static and static[node.id] == nil) or nil,
		masteryEffects = masteryEffects(node, spec),
	}
end

--- One entry per art state. The three states have differently sized artwork, so
--- `BuildArc` computes separate vertices for each; a renderer that swaps state
--- on allocation needs all three up front.
local function appendConnector(out, connector, nodeById, sprites)
	if not connector or not connector.vert or not connector.type then return end
	local uv = connector.c
	if not uv or not uv[9] then return end
	-- PoB uses the Abyss line art only when *both* ends are conquered
	-- (PassiveTreeView.lua:715-721), so a link out of the jewel's radius keeps
	-- the ordinary art and the boundary reads correctly.
	local prefix = ""
	if nodeById
		and isAbyssConquered(nodeById[connector.nodeId1])
		and isAbyssConquered(nodeById[connector.nodeId2]) then
		prefix = "Abyss"
	end
	local uvs = A{
		O{ x = round(uv[9], 4),  y = round(uv[10], 4) },
		O{ x = round(uv[11], 4), y = round(uv[12], 4) },
		O{ x = round(uv[13], 4), y = round(uv[14], 4) },
		O{ x = round(uv[15], 4), y = round(uv[16], 4) },
	}
	for state, name in pairs(CONNECTOR_STATES) do
		local vert = connector.vert[state]
		if vert and vert[1] then
			local sheet = connector.type .. state
			if prefix ~= "" and sprites[prefix .. sheet] then sheet = prefix .. sheet end
			out[#out + 1] = O{
				from = connector.nodeId1,
				to = connector.nodeId2,
				verts = A{
					O{ x = round(vert[1], 1), y = round(vert[2], 1) },
					O{ x = round(vert[3], 1), y = round(vert[4], 1) },
					O{ x = round(vert[5], 1), y = round(vert[6], 1) },
					O{ x = round(vert[7], 1), y = round(vert[8], 1) },
				},
				uvs = uvs,
				sheet = sheet,
				state = name,
			}
		end
	end
end

local function groupEntry(group, isExpansion)
	local orbits = A{ }
	for orbit in pairs(group.oo or { }) do
		if type(orbit) == "number" then orbits[#orbits + 1] = orbit end
	end
	table.sort(orbits)

	local background = ""
	if group.ascendancyName and group.isAscendancyStart then
		background = "Classes" .. group.ascendancyName
	elseif group.oo then
		if group.oo[3] then
			background = isExpansion and "GroupBackgroundLargeHalfAlt" or "PSGroupBackground3"
		elseif group.oo[2] then
			background = isExpansion and "GroupBackgroundMediumAlt" or "PSGroupBackground2"
		elseif group.oo[1] then
			background = isExpansion and "GroupBackgroundSmallAlt" or "PSGroupBackground1"
		end
	end

	return O{
		x = round(group.x, 1),
		y = round(group.y, 1),
		background = background,
		orbits = orbits,
		ascendancy = group.ascendancyName or nil,
		isAscendancyStart = group.isAscendancyStart or nil,
	}
end

--- Sorted keys of `t`, so a `pairs` walk over a table PoB keys by id produces
--- the same order every run — these end up in committed fixtures.
local function sortedKeys(t)
	local keys = { }
	for key in pairs(t or { }) do keys[#keys + 1] = key end
	table.sort(keys)
	return keys
end

--- The seven base classes, in PoB's own class-id order.
---
--- `startNodeId` is the tree's entrance for that class. It cannot be derived
--- client-side: the `classStart` nodes carry GGG's internal names, and two of
--- them ("SIX", "Seven") do not name a class at all. PoB resolves it while
--- walking the node list (PassiveTree.lua:525) and every class switch needs it
--- (PassiveSpec.lua:578).
local function classEntries(tree)
	local out = A{ }
	for _, classId in ipairs(sortedKeys(tree.classes)) do
		local class = tree.classes[classId]
		out[#out + 1] = O{
			id = classId,
			name = class.name or "",
			startNodeId = class.startNodeId,
		}
	end
	return out
end

--- Ascendancy wheels and their flavour text.
---
--- PoB draws the wheel on the ascendancy's *start* group and writes the flavour
--- text at an offset derived from `flavourTextRect` minus the art's half-size
--- (PassiveTreeView.lua:596-625). None of that is reachable from the node or
--- group tables, so it has to be exported separately.
local function ascendancyEntries(tree)
	local out = A{ }

	-- `tree.classes` is keyed by PoB's own class id and is *0-based*: after the
	-- JSON decodes to a 1-based array, PassiveTree.lua:95-101 shifts every entry
	-- down by one ("migrate to old format"), leaving 0 = Scion .. 6 = Shadow.
	-- Pre-3.10 trees ship in that layout to begin with (3_9/tree.lua has an
	-- explicit `[0]={["name"]="Scion"}`).
	--
	-- So the key *is* the class id — it is what PassiveTree.lua:155-161 stores in
	-- `classNameMap` and what `spec.curClassId` holds. `ipairs` cannot be used
	-- here: it starts at 1, which both drops Scion entirely and shifts every
	-- other class one place off its real id.
	for _, classId in ipairs(sortedKeys(tree.classes)) do
		local class = tree.classes[classId]
		-- Pre-3.10 the ascendancy list is `class.classes`; from 3.10 it is
		-- `class.ascendancies`, which PassiveTree.lua:156-158 then aliases onto
		-- `class.classes` so the rest of PoB keeps working.
		local ascendancies = class.ascendancies or class.classes
		for _, ascendClassId in ipairs(sortedKeys(ascendancies)) do
			-- Index 0 is the "None" entry PoB injects for its dropdown
			-- (PassiveTree.lua:160), not an ascendancy — it has no id and no art.
			if ascendClassId ~= 0 then
				local asc = ascendancies[ascendClassId]
				out[#out + 1] = O{
					id = asc.id or asc.name or "",
					name = asc.name or asc.id or "",
					-- Which base class owns this. Without it the client cannot tell
					-- a same-class ascendancy switch (always allowed, silent) from a
					-- cross-class one (which may reset the tree and needs a prompt).
					classId = classId,
					className = class.name or "",
					-- The wheel's entrance, allocated by SelectAscendClass
					-- (PassiveSpec.lua:608-613). Pathing may start there but never
					-- routes through it, so without it allocated the whole wheel is
					-- unreachable.
					startNodeId = asc.startNodeId,
					flavourText = asc.flavourText and util.plain(asc.flavourText) or nil,
					flavourTextColour = asc.flavourTextColour or nil,
					flavourTextRect = asc.flavourTextRect and O{
						x = round(tonumber(asc.flavourTextRect.x) or 0, 1),
						y = round(tonumber(asc.flavourTextRect.y) or 0, 1),
					} or nil,
				}
			end
		end
	end

	-- Alternate ascendancies sit in their own table and use larger art, which
	-- changes the offset the renderer must apply. Dropping the legacy ones
	-- (PassiveTree.lua:109-152) leaves the table sparse, so it has no array part
	-- and `pairs` order is unspecified — walk it by sorted key instead.
	for _, ascendClassId in ipairs(sortedKeys(tree.alternate_ascendancies)) do
		local asc = tree.alternate_ascendancies[ascendClassId]
		out[#out + 1] = O{
			id = asc.id or asc.name or "",
			name = asc.name or asc.id or "",
			flavourText = asc.flavourText and util.plain(asc.flavourText) or nil,
			flavourTextColour = asc.flavourTextColour or nil,
			flavourTextRect = asc.flavourTextRect and O{
				x = round(tonumber(asc.flavourTextRect.x) or 0, 1),
				y = round(tonumber(asc.flavourTextRect.y) or 0, 1),
			} or nil,
			alternate = true,
		}
	end

	return out
end

--- Geometry for one tree. When `spec` is given, its cluster-jewel subgraphs are
--- folded in: those nodes, groups and connectors exist only at runtime.
function M.geometry(tree, spec)
	local nodes, connectors, groups = A{ }, A{ }, A{ }
	local static = tree.nodes
	local sprites, sheets = buildAtlas(tree)

	local nodeSource = spec and spec.nodes or tree.nodes
	for _, node in pairs(nodeSource) do
		if node.x and node.y and not node.isProxy and not (node.group and node.group.isProxy) then
			nodes[#nodes + 1] = nodeEntry(node, static, sprites, spec)
		end
	end
	table.sort(nodes, function(a, b) return a.id < b.id end)

	-- Conquest is recorded on the *spec's* nodes, not the shared tree's, so the
	-- Abyss connector test has to look them up there.
	for _, connector in pairs(tree.connectors or { }) do
		appendConnector(connectors, connector, nodeSource, sprites)
	end
	for _, group in pairs(tree.groups or { }) do
		if not group.isProxy then groups[#groups + 1] = groupEntry(group, false) end
	end

	if spec then
		for _, subGraph in pairs(spec.subGraphs or { }) do
			for _, connector in pairs(subGraph.connectors or { }) do
				appendConnector(connectors, connector, nodeSource, sprites)
			end
			if subGraph.group then groups[#groups + 1] = groupEntry(subGraph.group, true) end
		end
	end

	-- The class illustrations and ascendancy backdrops, positioned in tree space.
	-- These live in sprites.lua rather than tree.lua, and without them the tree
	-- reads as a bare graph.
	local extraImages = A{ }
	for _, image in ipairs(tree.extraImages or { }) do
		extraImages[#extraImages + 1] = O{
			x = round(image.x, 1),
			y = round(image.y, 1),
			image = image.image,
		}
	end

	return O{
		version = tree.treeVersion,
		size = round(tree.size, 1),
		nodes = nodes,
		connectors = connectors,
		groups = groups,
		sprites = sprites,
		sheets = sheets,
		extraImages = extraImages,
		classes = classEntries(tree),
		ascendancies = ascendancyEntries(tree),
	}
end

-- ---------------------------------------------------------------------------
-- mutation

--- Recompute exactly the way the UI does after a tree edit.
local function recompute(b)
	b.buildFlag = true
	runCallback("OnFrame")
end

local function allocatedSet(spec)
	local set = { }
	for id in pairs(spec.allocNodes) do set[id] = true end
	return set
end

-- ---------------------------------------------------------------------------
-- search

--- PassiveTreeView builds its search params inline in Draw(); this is the same
--- parse, lifted so the matcher can be driven without a frame.
local function prepSearch(text)
	local search = text:lower()
	local words = { }
	for phrase in search:gmatch('"([^"]*)"') do
		words[#words + 1] = phrase
		search = search:gsub('"' .. phrase:gsub("([%(%)])", "%%%1") .. '"', "")
	end
	for word in search:gmatch("(%S*)") do
		if word:match("%S") ~= nil then
			words[#words + 1] = word
		end
	end
	return words
end

-- ---------------------------------------------------------------------------
-- methods

M.methods = { }

M.methods["tree.geometry"] = function(params)
	params = params or { }
	local b = util.build()
	local version = params.version
	if version == nil or version == b.spec.treeVersion then
		return M.geometry(b.spec.tree, b.spec)
	end
	if not treeVersions[version] then
		util.invalid("unknown tree version " .. tostring(version))
	end
	if not main.tree[version] then
		main:LoadTree(version)
	end
	return M.geometry(main.tree[version], nil)
end

M.methods["tree.allocate"] = function(params)
	params = params or { }
	local b = util.build()
	local spec = b.spec
	local ids = util.nodeIds(params.nodes, "nodes")
	if not ids or #ids == 0 then
		util.invalid("tree.allocate needs a non-empty nodes array")
	end

	local altPath
	if params.path then
		altPath = { }
		for i, id in ipairs(util.nodeIds(params.path, "path")) do
			altPath[i] = util.node(id, "path")
		end
	end

	for _, id in ipairs(ids) do
		local node = util.node(id, "nodes")
		-- A mastery is not allocated by clicking it: an effect has to be chosen,
		-- and allocating it blind would spend a point on nothing.
		if node.type == "Mastery" then
			util.invalid(string.format(
				"node %d is a mastery; choose an effect with tree.setMastery instead", id))
		end
		if not node.path and not node.alloc then
			util.invalid(string.format("node %d cannot be reached from the current tree", id))
		end
		-- An explicit route only makes sense for the node it reaches, and PoB
		-- requires the target itself to be in it.
		local route = altPath
		if route then
			local contains = false
			for _, n in ipairs(route) do
				if n == node then contains = true break end
			end
			if not contains then route = nil end
		end
		spec:AllocNode(node, route)
	end

	recompute(b)
	return O{ summary = buildApi.summary(), stats = statsApi.list() }
end

M.methods["tree.setMastery"] = function(params)
	params = params or { }
	local b = util.build()
	local spec = b.spec
	if type(params.node) ~= "number" then
		util.invalid("tree.setMastery needs a numeric node")
	end
	local node = util.node(math.floor(params.node), "node")
	if node.type ~= "Mastery" then
		util.invalid(string.format("node %d is not a mastery", node.id))
	end

	if params.effect == nil then
		-- Clearing the choice un-allocates the mastery, and PoB's own
		-- DeallocSingleNode is what restores the full option list on the node.
		if node.alloc then
			spec:DeallocNode(node)
		else
			spec:AddMasteryEffectOptionsToNode(node)
			spec.masterySelections[node.id] = nil
		end
	else
		if type(params.effect) ~= "number" then
			util.invalid("effect must be an effect id or null")
		end
		local effectId = math.floor(params.effect)
		local offered = false
		for _, option in ipairs(node.masteryEffects or { }) do
			if option.effect == effectId then offered = true break end
		end
		if not offered then
			util.invalid(string.format("effect %d is not offered by node %d", effectId, node.id))
		end
		local takenBy = isValueInTable(spec.masterySelections, effectId)
		if takenBy and takenBy ~= node.id then
			util.invalid(string.format(
				"effect %d is already used on mastery %s", effectId, tostring(takenBy)))
		end

		-- Exactly TreeTab:SaveMasteryPopup, minus the popup.
		local effect = spec.tree.masteryEffects[effectId]
		node.sd = effect.sd
		node.allMasteryOptions = false
		node.reminderText = { "Tip: Right click to select a different effect" }
		spec.tree:ProcessStats(node)
		spec.masterySelections[node.id] = effect.id
		if not node.alloc then
			spec:AllocNode(node)
		end
	end
	spec:AddUndoState()
	b.modFlag = true
	recompute(b)

	-- Choosing here can remove an option from a chooser somewhere else, so the
	-- caller gets the availability of every mastery back, not just this one.
	local effects = O{ }
	for id, other in pairs(spec.nodes) do
		local options = masteryEffects(other, spec)
		if options then effects[tostring(id)] = options end
	end

	return O{ summary = buildApi.summary(), stats = statsApi.list(), masteryEffects = effects }
end

M.methods["tree.deallocate"] = function(params)
	params = params or { }
	local b = util.build()
	local spec = b.spec
	local ids = util.nodeIds(params.nodes, "nodes")
	if not ids or #ids == 0 then
		util.invalid("tree.deallocate needs a non-empty nodes array")
	end

	local before = allocatedSet(spec)
	local requested = { }
	for _, id in ipairs(ids) do
		local node = util.node(id, "nodes")
		requested[id] = true
		if node.alloc then
			spec:DeallocNode(node)
		end
	end

	-- Anything else that fell out was only connected through what we removed.
	local orphaned = A{ }
	for id in pairs(before) do
		if not spec.allocNodes[id] and not requested[id] then
			orphaned[#orphaned + 1] = id
		end
	end
	table.sort(orphaned)

	recompute(b)
	return O{ summary = buildApi.summary(), stats = statsApi.list(), orphaned = orphaned }
end

M.methods["tree.path"] = function(params)
	params = params or { }
	if type(params.to) ~= "number" then
		util.invalid("tree.path needs a numeric `to`")
	end
	local node = util.node(math.floor(params.to), "to")
	local path = A{ }
	if node.alloc then
		return O{ path = path, cost = 0 }
	end
	if not node.path then
		util.invalid(string.format("node %d cannot be reached from the current tree", node.id))
	end
	-- PoB stores paths target-first; hand them back tree-first, which is the
	-- order a UI walks them in.
	for i = #node.path, 1, -1 do
		path[#path + 1] = node.path[i].id
	end
	return O{ path = path, cost = node.pathDist or #path }
end

--- The jewel radius overlays PoB draws on the tree.
---
--- `PassiveTreeView.lua:1206-1247` draws two different things, and a client
--- needs the data for both:
---
---   * **On an allocated socket holding a jewel**, the jewel's own radius, as
---     the decorative shaded ring. Timeless jewels each get their own art
---     (`:1179-1199`) — Elegant Hubris is the Eternal Empire ring, Lethal Pride
---     the Karui one, and so on — which is why `art` is reported rather than
---     left for the client to guess from the name.
---   * **On hover**, every radius a jewel *could* have, each in its own colour,
---     so you can see what would fit. Hence `options`.
---
--- Radii come from `data.jewelRadius` (Data.lua:597-623), which is per tree
--- version: 3.16+ has Small 960 through Massive 2880, plus the "Variable"
--- annuli that Thread of Hope uses, where `inner` is non-zero.
local ART_BY_JEWEL = {
	["Brutal Restraint"] = "maraketh",
	["Elegant Hubris"] = "eternal",
	["Glorious Vanity"] = "vaal",
	["Lethal Pride"] = "karui",
	["Militant Faith"] = "templar",
	["Heroic Tragedy"] = "kalguur",
}

--- The counter-rotations PoB gives each ring pair, so the two copies of one
--- image read as a single ornate ring (PassiveTreeView.lua:1174-1203).
---
--- Impossible Escape is the odd one out on every count: its own angles, a fixed
--- inner radius rather than one from the radius table, and — because its rings
--- mark the keystones it unlocks rather than an area around the socket — a
--- centre per keystone instead of the socket's own position.
local RING_ROTATION = { -0.7, 0.7 }
local ESCAPE_OUTER_ROTATION = { -0.8, 1.0 }
local ESCAPE_INNER_ROTATION = { -1.2, 1.0 }
local ESCAPE_INNER_RADIUS = 150

--- Every ring to draw for one socketed jewel, in draw order.
---
--- A list rather than a fixed pair of fields: the three cases genuinely differ
--- in count and placement — a timeless jewel draws one ring, an ordinary one
--- draws two concentric rings, and Impossible Escape draws two *per keystone*,
--- somewhere else entirely. Resolving that here keeps the renderer to a single
--- loop with no jewel names in it.
local function jewelRings(art, rad, jewel, spec)
	local outer = round(rad.outer or 0, 1)
	local rings = A{ }

	local function add(sprites, radius, rotation, x, y)
		if not sprites or not radius or radius <= 0 then return end
		rings[#rings + 1] = O{
			sprites = A{ sprites[1], sprites[2] },
			radius = round(radius, 1),
			rotation = A{ rotation[1], rotation[2] },
			x = x and round(x, 1) or nil,
			y = y and round(y, 1) or nil,
		}
	end

	-- Gated on the jewel's *name*, which is what PoB tests
	-- (PassiveTreeView.lua:1167). Testing for `jewelData.impossibleEscapeKeystones`
	-- instead looks more direct and is wrong: `ModStore:List` returns an empty
	-- table rather than nil when nothing matches, so `Item.lua:2428` sets that
	-- field on *every* jewel it parses. Reading it as a flag silently swallowed
	-- the rings for every other jewel.
	if (jewel.title or ""):match("Impossible Escape") then
		-- PoB keys these by keystone display name and looks each one up in the
		-- tree's own map (PassiveTreeView.lua:1169-1171). It draws at every
		-- keystone the jewel names, allocated or not — the comment there says
		-- "the allocated Keystone", but the code does not test for it.
		local names = { }
		for name in pairs(jewel.jewelData and jewel.jewelData.impossibleEscapeKeystones or { }) do
			names[#names + 1] = name
		end
		table.sort(names)
		for _, name in ipairs(names) do
			local keystone = spec.tree.keystoneMap[name]
			if keystone and keystone.x and keystone.y then
				add(RING_SPRITES.default, outer, ESCAPE_OUTER_ROTATION, keystone.x, keystone.y)
				add(INNER_RING_SPRITES.default, ESCAPE_INNER_RADIUS, ESCAPE_INNER_ROTATION, keystone.x, keystone.y)
			end
		end
		return rings
	end

	add(RING_SPRITES[art], outer, RING_ROTATION)
	-- The second, smaller ring only the generic art has. Sized off `inner`, so
	-- it vanishes on its own for the disc-shaped radii and shows up only for the
	-- annulus jewels — the same way PoB's zero-sized draw resolves.
	add(INNER_RING_SPRITES[art], (rad.inner or 0) * INNER_RING_SCALE, RING_ROTATION)
	return rings
end

--- Why a mod line is coloured the way it is, taken from the flags PoB tests
--- rather than from the colour it picks (ItemTools.lua:364-376). The client
--- gets the meaning and chooses its own palette; shipping `^xBB6600` escapes
--- would make it re-derive intent from a hex code.
local function modLineKind(modLine)
	if modLine.disabled then return "disabled" end
	if modLine.extra then return "unsupported" end
	for _, kind in ipairs({ "fractured", "crafted", "mutated", "scourge", "custom", "crucible", "vestigial" }) do
		if modLine[kind] then return kind end
	end
	return "normal"
end

--- The socketed item as PoB's own tooltip presents it
--- (`ItemsTab:AddItemTooltip`, ItemsTab.lua:4368-4660).
---
--- Only the parts a jewel actually uses. `AddItemTooltip` also covers armour,
--- weapons, requirements and influence, none of which a jewel has — copying the
--- whole thing would be inventing fields the data never fills.
---
--- The two subtleties, both of which produce wrong text if skipped:
---   * `formatModLine` applies the *rolled* value, so a line reads "+18% to
---     Fire Resistance" rather than the "(15-20)" the raw item text carries. It
---     also drops zero-value mods, returning nil for them.
---   * `GetModLineVariantCount` is 0 for a mod belonging to a variant this item
---     is not on. Impossible Escape ships one variant per keystone it can
---     unlock, so ignoring this lists every keystone in the game.
local function jewelItem(jewel, spec)
	local out = O{ rarity = jewel.rarity }

	-- Uniques carry a title and show it above the base; anything else builds its
	-- name from the affixes (ItemsTab.lua:4386-4391).
	local base = (jewel.baseName or ""):gsub(" %(.+%)", "")
	if jewel.title then
		out.name = jewel.title
		out.base = base
	else
		out.name = (jewel.namePrefix or "") .. base .. (jewel.nameSuffix or "")
	end
	out.limit = jewel.limit
	out.radiusLabel = jewel.jewelRadiusLabel

	local mods = A{ }
	local groups = {
		{ "enchant", jewel.enchantModLines },
		{ "scourge", jewel.scourgeModLines },
		{ "implicit", jewel.implicitModLines },
		{ "explicit", jewel.explicitModLines },
		{ "crucible", jewel.crucibleModLines },
	}
	for _, group in ipairs(groups) do
		for _, modLine in ipairs(group[2] or { }) do
			local ok, count = pcall(jewel.GetModLineVariantCount, jewel, modLine)
			if ok and count and count > 0 then
				local fine, text = pcall(itemLib.formatModLine, modLine, false)
				if fine and text then
					for _ = 1, count do
						mods[#mods + 1] = O{
							group = group[1],
							line = util.plain(text),
							kind = modLineKind(modLine),
						}
					end
				end
			end
		end
	end
	out.mods = mods

	-- A cluster jewel's tooltip lists the notables it will create, with their
	-- stats (ItemsTab.lua:4642-4664). Those nodes do not exist until the jewel
	-- is socketed, so the name alone is not enough to look them up client-side.
	local data = jewel.jewelData
	if jewel.clusterJewel and data then
		local nodes = A{ }
		local names = data.clusterJewelNotables or { }
		if #names == 0 and data.clusterJewelKeystone then names = { data.clusterJewelKeystone } end
		for _, name in ipairs(names) do
			local node = spec and spec.tree.clusterNodeMap and spec.tree.clusterNodeMap[name]
			local stats = A{ }
			for i, line in ipairs((node and node.sd) or { }) do stats[i] = util.plain(line) end
			nodes[#nodes + 1] = O{ name = (node and node.dn) or name, stats = stats }
		end
		out.clusterNodes = nodes
	end

	out.corrupted = jewel.corrupted and true or nil
	return out
end

--- PoB stores colours as its own draw escape, "^xBB6600".
local function plainColour(col)
	if type(col) ~= "string" then return nil end
	return (col:match("%^x(%x%x%x%x%x%x)"))
end

--- Abyss jewels show no radius in game, and PoB honours that
--- (PassiveTreeView.lua:23-26, 1159-1162).
local function isAbyssConquered(node)
	local conqueror = node and node.conqueredBy and node.conqueredBy.conqueror
	return conqueror and conqueror.type and conqueror.type:match("^abyss_") ~= nil
end

M.methods["tree.jewels"] = function()
	local b = util.build()
	local spec = b.spec

	local options = A{ }
	for _, rad in ipairs(b.data.jewelRadius or { }) do
		options[#options + 1] = O{
			inner = round(rad.inner or 0, 1),
			outer = round(rad.outer or 0, 1),
			colour = plainColour(rad.col),
			label = rad.label,
		}
	end

	local sockets = A{ }
	for nodeId in pairs(spec.tree.sockets or { }) do
		local node = spec.nodes[nodeId]
		if node then
			local entry = O{
				node = nodeId,
				allocated = node.alloc and true or false,
			}
			local ok, _, jewel = pcall(b.itemsTab.GetSocketAndJewelForNodeID, b.itemsTab, nodeId)
			if ok and jewel then
				-- Art and item apply to *every* socket. PoB swaps the overlay in
				-- its node draw loop (:840-846) and shows the item in the socket's
				-- tooltip (:1478-1484), and neither is filtered.
				entry.socketArt = socketOverlay(jewel, node.expansionJewel ~= nil)
				entry.jewel = jewel.title or jewel.name or jewel.baseName
				local fine, item = pcall(jewelItem, jewel, spec)
				if fine then entry.item = item end
			end

			-- The radius is the narrow one. PoB draws a ring only for sockets
			-- that pass this test (:1208) — a charm socket has no radius, and a
			-- cluster jewel's expansion sockets only get one at size 2, the Large
			-- Jewel Socket that holds the cluster jewel itself.
			--
			-- Applying that test to the whole entry, as this once did, silently
			-- dropped every Medium and Small Jewel Socket: a jewel in one had no
			-- art and no tooltip, so the socket read as empty. Eight of them in
			-- one ordinary build.
			local drawsRadius = node.name ~= "Charm Socket"
				and (not node.expansionJewel or node.expansionJewel.size == 2)
			if drawsRadius and ok and jewel and jewel.jewelRadiusIndex and not isAbyssConquered(jewel.jewelData) then
				local rad = (b.data.jewelRadius or { })[jewel.jewelRadiusIndex]
				if rad then
					entry.title = jewel.title or jewel.name
					entry.inner = round(rad.inner or 0, 1)
					entry.outer = round(rad.outer or 0, 1)
					entry.colour = plainColour(rad.col)
					entry.label = rad.label
					local base = (entry.title or ""):match("^([^,]+)") or ""
					for name, art in pairs(ART_BY_JEWEL) do
						if base:find(name, 1, true) then entry.art = art break end
					end
					entry.art = entry.art or "default"
					entry.rings = jewelRings(entry.art, rad, jewel, spec)
				end
			end
			sockets[#sockets + 1] = entry
		end
	end
	table.sort(sockets, function(x, y) return x.node < y.node end)

	return O{ sockets = sockets, options = options }
end

M.methods["tree.search"] = function(params)
	params = params or { }
	if type(params.query) ~= "string" then
		util.invalid("tree.search needs a string query")
	end
	local b = util.build()
	local viewer = b.treeTab.viewer
	local matches = A{ }
	if params.query:match("%S") then
		viewer.searchStr = params.query
		viewer.searchStrCached = params.query
		viewer.searchParams = prepSearch(params.query)
		for id, node in pairs(b.spec.nodes) do
			local ok, hit = pcall(viewer.DoesNodeMatchSearchParams, viewer, node)
			if ok and hit then
				matches[#matches + 1] = id
			end
		end
		table.sort(matches)
	end
	return O{ matches = matches }
end

return M
