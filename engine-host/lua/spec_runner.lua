-- Runs Path of Building's own regression specs inside our host.
--
-- This is the real gating experiment. PoB's CI runs these on every PR and keeps
-- them green, so if they pass here, our host is driving the engine exactly as
-- PoB does. (The golden *build* snapshots are a different thing — they were
-- last regenerated in 2022 against 3.13 and PoB excludes them from CI.)

local busted = dofile(HOST_LUA .. "/busted.lua")
busted.install()

local files = SPEC_FILES  -- absolute paths, enumerated by Rust

local perFile = {}

for _, path in ipairs(files) do
	local name = path:match("([^/\\]+)%.lua$") or path
	busted.currentFile = name

	local before = { passed = busted.passed, failed = busted.failed }

	local chunk, loadErr = loadfile(path)
	if not chunk then
		busted.failed = busted.failed + 1
		busted.failures[#busted.failures + 1] = {
			file = name, name = "(load)", message = tostring(loadErr),
		}
	else
		local ok, err = pcall(chunk)
		if not ok then
			busted.failed = busted.failed + 1
			busted.failures[#busted.failures + 1] = {
				file = name,
				name = "(top level)",
				message = type(err) == "table" and err.message or tostring(err),
			}
		end
	end

	perFile[#perFile + 1] = {
		name = name,
		passed = busted.passed - before.passed,
		failed = busted.failed - before.failed,
	}
end

-- ---------------------------------------------------------------------------
-- report

print("")
print("Path of Building regression specs, run inside our host")
print(string.rep("-", 76))

for _, f in ipairs(perFile) do
	local mark = f.failed == 0 and "ok  " or "FAIL"
	print(string.format("  %s  %-44s %4d passed  %3d failed",
		mark, f.name, f.passed, f.failed))
end

if #busted.failures > 0 then
	print("")
	print("Failures:")
	local shown = 0
	for _, f in ipairs(busted.failures) do
		if shown >= 25 then
			print(string.format("  ... and %d more", #busted.failures - shown))
			break
		end
		print(string.format("  [%s] %s", f.file, f.name))
		print(string.format("        %s", (f.message:gsub("\n", " "))))
		shown = shown + 1
	end
end

print(string.rep("-", 76))
print(string.format("  %d passed, %d failed, %d pending across %d spec files",
	busted.passed, busted.failed, busted.pending, #files))
print("")

RESULT_PASSED = busted.passed
RESULT_FAILED = busted.failed
return true
