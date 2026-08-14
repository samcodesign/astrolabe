-- Boots Path of Building's calculation engine inside our embedded LuaJIT.
--
-- Two things have to be in place before HeadlessWrapper.lua runs:
--   1. `lua-utf8`, which PoB hard-requires with no fallback (Common.lua:29).
--      We ship a pure-Lua stand-in rather than a native module, because the
--      whole codebase uses only six of its functions across 16 call sites.
--   2. package.path pointing at PoB's bundled pure-Lua libraries (xml, dkjson,
--      base64, sha1/sha2), which the engine loads by name.
--
-- The current working directory must already be PoB's `src/`, because
-- HeadlessWrapper.lua does a relative `dofile("Launch.lua")`.

local POB = ...  -- absolute path to the PoB checkout, passed from Rust

-- ---------------------------------------------------------------------------
-- lua-utf8 stand-in

local utf8shim = {}

local function charLen(b)
	if b < 0x80 then return 1
	elseif b < 0xE0 then return 2
	elseif b < 0xF0 then return 3
	else return 4 end
end

-- PoB's data is effectively ASCII, where these are byte-for-byte identical to
-- their string.* equivalents. Only `next` needs real UTF-8 awareness.
utf8shim.reverse = string.reverse
utf8shim.match   = string.match
utf8shim.gmatch  = string.gmatch
utf8shim.gsub    = string.gsub
utf8shim.sub     = string.sub
utf8shim.find    = string.find
utf8shim.len     = string.len
utf8shim.byte    = string.byte
utf8shim.upper   = string.upper
utf8shim.lower   = string.lower
utf8shim.format  = string.format
utf8shim.rep     = string.rep

function utf8shim.char(...)
	local out = {}
	for i, cp in ipairs({...}) do
		if cp < 0x80 then
			out[i] = string.char(cp)
		elseif cp < 0x800 then
			out[i] = string.char(0xC0 + math.floor(cp / 64), 0x80 + cp % 64)
		else
			out[i] = string.char(
				0xE0 + math.floor(cp / 4096),
				0x80 + math.floor(cp / 64) % 64,
				0x80 + cp % 64
			)
		end
	end
	return table.concat(out)
end

--- Position and codepoint of the character after byte index `i`.
function utf8shim.next(s, i)
	i = i or 0
	local pos
	if i <= 0 then
		pos = 1
	else
		local b = s:byte(i)
		if not b then return nil end
		pos = i + charLen(b)
	end
	if pos > #s then return nil end

	local b = s:byte(pos)
	local len = charLen(b)
	local cp
	if len == 1 then
		cp = b
	else
		cp = b % (2 ^ (7 - len))
		for k = 1, len - 1 do
			local cont = s:byte(pos + k)
			if not cont then break end
			cp = cp * 64 + cont % 64
		end
	end
	return pos, cp
end

function utf8shim.codepoint(s, i)
	local _, cp = utf8shim.next(s, (i or 1) - 1)
	return cp
end

function utf8shim.offset(s, n, i)
	local pos = i or 1
	for _ = 1, n - 1 do
		local nextPos = utf8shim.next(s, pos)
		if not nextPos then return nil end
		pos = nextPos
	end
	return pos
end

package.preload["lua-utf8"] = function() return utf8shim end

-- ---------------------------------------------------------------------------
-- module search paths

local runtime = POB .. "/runtime/lua"
package.path = table.concat({
	"./?.lua",
	runtime .. "/?.lua",
	runtime .. "/?/init.lua",
	package.path,
}, ";")

-- ---------------------------------------------------------------------------
-- boot the engine

-- A standalone `lua` binary sets this; an embedded interpreter does not.
-- Main.lua:68 reads arg[1] as a build URL to auto-import, so an empty table is
-- exactly the "nothing was passed on the command line" case.
arg = arg or {}

dofile(POB .. "/src/HeadlessWrapper.lua")

if not build then
	error("HeadlessWrapper booted but did not expose a `build` object")
end

return true
