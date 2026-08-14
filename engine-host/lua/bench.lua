-- Asset-dimension audit.
--
-- Headless, PoB's `ImageSize()` returns 1x1, so every asset dimension is a lie
-- unless our own header reader has filled it in. `BuildArc` sizes each orbit
-- arc from `art.width * 2 * 1.33` and `BuildConnector` sizes straight links
-- from `art.height * 1.33`, so a wrong dimension here silently produces
-- geometry the game would never draw.
--
-- Compares what PoB is working with against the real file on disk.

local function fileDims(path)
	local f = io.open(path, "rb")
	if not f then return nil end
	local head = f:read(32) or ""
	f:close()
	if head:sub(1, 8) == "\137PNG\r\n\26\n" then
		local function be32(s)
			local a, b, c, d = s:byte(1, 4)
			return ((a * 256 + b) * 256 + c) * 256 + d
		end
		return be32(head:sub(17, 20)), be32(head:sub(21, 24))
	end
	return nil
end

local version = build.spec.treeVersion
local tree = build.spec.tree

print("")
print(string.format("Asset dimensions PoB is using (tree %s)", tostring(version)))
print(string.rep("-", 74))
print(string.format("  %-26s %-16s %-16s %s", "asset", "tree.assets", "file on disk", ""))

local names = { }
for i = 1, 7 do
	for _, state in ipairs({ "Normal", "Active" }) do
		names[#names + 1] = "Orbit" .. i .. state
	end
end
names[#names + 1] = "LineConnectorNormal"
names[#names + 1] = "LineConnectorActive"

local mismatched = 0
for _, name in ipairs(names) do
	local art = tree.assets and tree.assets[name]
	if art then
		local fw, fh = fileDims("TreeData/" .. version .. "/" .. name .. ".png")
		if not fw then fw, fh = fileDims("TreeData/" .. name .. ".png") end

		local got = string.format("%sx%s", tostring(art.width), tostring(art.height))
		local want = fw and string.format("%dx%d", fw, fh) or "(not found)"
		local flag = ""
		if fw and (art.width ~= fw or art.height ~= fh) then
			flag = "  <-- MISMATCH"
			mismatched = mismatched + 1
		end
		print(string.format("  %-26s %-16s %-16s%s", name, got, want, flag))
	end
end

print(string.rep("-", 74))
print(string.format("  %d mismatched", mismatched))

-- What BuildArc would derive from those widths, against the orbit radii the
-- tree actually uses. These should be in the same ballpark; a wild difference
-- means the arc is drawn at the wrong radius.
print("")
print("  orbit   art.width   size = w*2*1.33   tree orbitRadii")
local radii = tree.orbitRadii or (tree.constants and tree.constants.orbitRadii)
for i = 1, 7 do
	local art = tree.assets and tree.assets["Orbit" .. i .. "Normal"]
	if art then
		print(string.format("  %-7d %-11s %-17.1f %s",
			i, tostring(art.width), (art.width or 0) * 2 * 1.33,
			radii and tostring(radii[i + 1] or radii[i]) or "?"))
	end
end
print("")
return true
