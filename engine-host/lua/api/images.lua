-- Real image dimensions for a headless engine.
--
-- `HeadlessWrapper.lua` stubs `imageHandle:ImageSize()` to return 1x1, which is
-- harmless for a program that never draws — except that `PassiveTree:BuildArc`
-- and `BuildConnector` size their quads from the *connector artwork's* width.
-- With a 1px asset every orbit arc collapses to a ~2.6 unit sliver, so the
-- geometry we hand the frontend would be unusable.
--
-- Rather than patch PoB (which is read-only for us), we read the real width and
-- height out of the file headers, write them onto `tree.assets`, and re-run
-- PoB's own connector builder. Cluster-jewel subgraphs then come out right for
-- free, because they call the same builder after we have fixed the sizes.

local M = { }

local s_byte = string.byte

local function be(bytes, from, count)
	local n = 0
	for i = from, from + count - 1 do
		n = n * 256 + s_byte(bytes, i)
	end
	return n
end

local function le(bytes, from, count)
	local n = 0
	for i = from + count - 1, from, -1 do
		n = n * 256 + s_byte(bytes, i)
	end
	return n
end

--- Width and height from a PNG, JPEG, WebP or GIF header, or nil.
local function readSize(path)
	local file = io.open(path, "rb")
	if not file then return nil end
	local head = file:read(32) or ""

	if head:sub(1, 8) == "\137PNG\r\n\26\n" and #head >= 24 then
		file:close()
		return be(head, 17, 4), be(head, 21, 4)
	end

	if head:sub(1, 3) == "GIF" and #head >= 10 then
		file:close()
		return le(head, 7, 2), le(head, 9, 2)
	end

	if head:sub(1, 4) == "RIFF" and head:sub(9, 12) == "WEBP" then
		local chunk = head:sub(13, 16)
		if chunk == "VP8X" and #head >= 30 then
			file:close()
			return le(head, 25, 3) + 1, le(head, 28, 3) + 1
		end
		if chunk == "VP8L" and #head >= 25 then
			file:close()
			local bits = le(head, 22, 4)
			return bits % 16384 + 1, math.floor(bits / 16384) % 16384 + 1
		end
		if chunk == "VP8 " and #head >= 30 then
			file:close()
			return le(head, 27, 2) % 16384, le(head, 29, 2) % 16384
		end
		file:close()
		return nil
	end

	if head:sub(1, 2) == "\255\216" then
		-- JPEG: walk the marker chain to the frame header, which is the only
		-- segment that carries the dimensions.
		file:seek("set", 2)
		while true do
			local marker = file:read(2)
			if not marker or #marker < 2 or s_byte(marker, 1) ~= 0xFF then break end
			local code = s_byte(marker, 2)
			if code == 0xD8 or code == 0xD9 or (code >= 0xD0 and code <= 0xD7) then
				-- No payload.
			else
				local sizeBytes = file:read(2)
				if not sizeBytes or #sizeBytes < 2 then break end
				local length = be(sizeBytes, 1, 2)
				local isFrame = (code >= 0xC0 and code <= 0xCF)
					and code ~= 0xC4 and code ~= 0xC8 and code ~= 0xCC
				if isFrame then
					local body = file:read(5)
					file:close()
					if not body or #body < 5 then return nil end
					return be(body, 4, 2), be(body, 2, 2)
				end
				file:seek("cur", length - 2)
			end
		end
	end

	file:close()
	return nil
end

M.readSize = readSize

--- Where `PassiveTree:LoadImage` would have found an asset: the shared TreeData
--- directory first, then the per-version one.
function M.resolve(treeVersion, fileName)
	local shared = io.open("TreeData/" .. fileName, "rb")
	if shared then
		shared:close()
		return fileName
	end
	local versioned = io.open("TreeData/" .. treeVersion .. "/" .. fileName, "rb")
	if versioned then
		versioned:close()
		return treeVersion .. "/" .. fileName
	end
	return nil
end

--- Re-run PoB's connector builder over the whole tree. Mirrors the loop in the
--- `PassiveTree` constructor, minus the `linkedId` bookkeeping that has already
--- happened and must not be repeated.
local function rebuildConnectors(tree)
	local byId = { }
	for _, node in pairs(tree.nodes) do
		if node.id then byId[node.id] = node end
	end

	tree.connectors = { }
	for _, node in pairs(tree.nodes) do
		for _, otherId in pairs(node.out or { }) do
			if type(otherId) == "string" then otherId = tonumber(otherId) end
			local other = byId[otherId]
			if other
				and node.type ~= "ClassStart" and other.type ~= "ClassStart"
				and node.type ~= "Mastery" and other.type ~= "Mastery"
				and node.ascendancyName == other.ascendancyName
				and not node.isProxy and not other.isProxy
				and node.group and not node.group.isProxy then
				local connectors = tree:BuildConnector(node, other)
				tree.connectors[#tree.connectors + 1] = connectors[1]
				if connectors[2] then
					tree.connectors[#tree.connectors + 1] = connectors[2]
				end
			end
		end
	end
end

--- Give one tree honest asset dimensions and rebuild anything derived from
--- them. Idempotent.
function M.fixTree(tree)
	if not tree or tree.hostAssetSizesFixed then return tree end
	tree.hostAssetSizesFixed = true

	for name, asset in pairs(tree.assets or { }) do
		local path = M.resolve(tree.treeVersion, name .. ".png")
		if path then
			local w, h = readSize("TreeData/" .. path)
			if w and h then
				asset.width, asset.height = w, h
				if asset.handle then
					asset.handle.width, asset.handle.height = w, h
				end
			end
		end
	end

	rebuildConnectors(tree)
	return tree
end

--- Fix every tree already in memory, and every one loaded from here on. Trees
--- must be corrected *before* a spec is built on them, because cluster-jewel
--- subgraphs bake connector geometry at allocation time.
function M.install()
	for _, tree in pairs(main.tree or { }) do
		M.fixTree(tree)
	end
	if not main.hostLoadTreePatched then
		main.hostLoadTreePatched = true
		local util = require("api.util")
		local loadTree = main.LoadTree
		main.LoadTree = function(self, treeVersion)
			-- Already loaded: still go through PoB's own path, which resets the
			-- global jewel radii for the version being switched to.
			if self.tree[treeVersion] then
				return loadTree(self, treeVersion)
			end
			-- The first load of a tree version is the ~5 s wait the whole
			-- busy/idle contract exists for; announce it from where it happens
			-- rather than guessing at the method boundary.
			local scope = util.beginBusy("loading passive tree " .. tostring(treeVersion))
			local ok, tree = pcall(loadTree, self, treeVersion)
			util.endBusy(scope)
			if not ok then error(tree, 0) end
			return M.fixTree(tree)
		end
	end
end

return M
