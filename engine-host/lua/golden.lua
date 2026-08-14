-- Drives Path of Building's own golden test builds through our host and
-- compares every stat against PoB's committed snapshot.
--
-- This is the gating experiment for the whole project. Each file in
-- spec/TestBuilds/<ver>/ is a Lua module returning { xml = ..., output = {...} }
-- where `output` is a snapshot of the entire mainOutput table. PoB's own
-- TestBuilds_spec.lua compares to 4 decimal places; so do we.
--
-- If these match, driving the engine from outside is sound. If they cannot be
-- made to match, the project is not viable — and we know in days.

local files = GOLDEN_FILES  -- array of absolute paths, enumerated by Rust

local function round(v, places)
	local mult = 10 ^ places
	if v >= 0 then
		return math.floor(v * mult + 0.5) / mult
	end
	return -math.floor(-v * mult + 0.5) / mult
end

local function shortName(path)
	return path:match("([^/\\]+)%.lua$") or path
end

local report = {
	builds = {},
	totalKeys = 0,
	totalMismatched = 0,
	loadFailures = 0,
}

for _, path in ipairs(files) do
	local name = shortName(path)
	local chunk, loadErr = loadfile(path)

	if not chunk then
		report.loadFailures = report.loadFailures + 1
		table.insert(report.builds, {
			name = name, error = "could not load snapshot: " .. tostring(loadErr),
		})
	else
		local ok, testBuild = pcall(chunk)
		if not ok or type(testBuild) ~= "table" or not testBuild.xml then
			report.loadFailures = report.loadFailures + 1
			table.insert(report.builds, {
				name = name, error = "snapshot did not return {xml=..., output=...}",
			})
		else
			local built, buildErr = pcall(loadBuildFromXML, testBuild.xml, name)
			if not built then
				table.insert(report.builds, {
					name = name, error = "loadBuildFromXML failed: " .. tostring(buildErr),
				})
			else
				local out = build.calcsTab.mainOutput
				local checked, mismatched, samples = 0, 0, {}

				for key, expected in pairs(testBuild.output or {}) do
					local actual = out[key]
					checked = checked + 1

					local same
					if type(expected) == "number" and type(actual) == "number" then
						same = round(expected, 4) == round(actual, 4)
					else
						same = expected == actual
					end

					if not same then
						mismatched = mismatched + 1
						if #samples < 6 then
							table.insert(samples, {
								key = key,
								expected = tostring(expected),
								actual = tostring(actual),
							})
						end
					end
				end

				report.totalKeys = report.totalKeys + checked
				report.totalMismatched = report.totalMismatched + mismatched
				table.insert(report.builds, {
					name = name,
					checked = checked,
					mismatched = mismatched,
					samples = samples,
					dps = out.CombinedDPS or out.TotalDPS,
					life = out.Life,
				})
			end
		end
	end
end

-- ---------------------------------------------------------------------------
-- print a human report; Rust decides the exit code from report.totalMismatched

print("")
print("Golden build comparison — PoB snapshots vs our host")
print(string.rep("-", 72))

for _, b in ipairs(report.builds) do
	if b.error then
		print(string.format("  %-32s ERROR  %s", b.name, b.error))
	else
		local status = b.mismatched == 0 and "OK  " or "FAIL"
		print(string.format(
			"  %-32s %s  %5d keys, %d mismatched   DPS %s",
			b.name, status, b.checked, b.mismatched,
			b.dps and string.format("%.1f", b.dps) or "n/a"
		))
		for _, s in ipairs(b.samples) do
			print(string.format("        %-40s expected %s  got %s",
				s.key, s.expected, s.actual))
		end
	end
end

print(string.rep("-", 72))
print(string.format("  %d builds, %d stats compared, %d mismatched, %d failed to load",
	#report.builds, report.totalKeys, report.totalMismatched, report.loadFailures))
print("")

RESULT_MISMATCHED = report.totalMismatched
RESULT_CHECKED = report.totalKeys
RESULT_LOAD_FAILURES = report.loadFailures
return true
