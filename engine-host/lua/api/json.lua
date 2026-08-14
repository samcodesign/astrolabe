-- JSON for the RPC layer.
--
-- Decoding uses PoB's bundled dkjson: request payloads are small and dkjson is
-- already on package.path. Encoding is our own, for two reasons:
--
--   1. dkjson decides array-vs-object by inspecting the table, which makes
--      empty results ambiguous. `tree.powerCancel` must answer `{}` and an
--      empty match list must be `[]`; here that is stated, not guessed.
--   2. dkjson sorts every object's keys before writing it. Tree geometry is
--      ~10k connectors x 8 nested points, and paying for a table.sort per point
--      is the difference between a fast method and a visibly slow one.

local m_floor = math.floor
local m_huge = math.huge
local m_abs = math.abs
local s_format = string.format
local t_concat = table.concat

local M = { }

local ARRAY = { __jsonkind = "array" }
local OBJECT = { __jsonkind = "object" }

--- Mark a table as a JSON array, so an empty one encodes as `[]`.
function M.array(t) return setmetatable(t or { }, ARRAY) end
--- Mark a table as a JSON object, so an empty one encodes as `{}`.
function M.object(t) return setmetatable(t or { }, OBJECT) end

-- ---------------------------------------------------------------------------
-- encoding

local escapes = {
	['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
	['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}
for i = 0, 31 do
	local c = string.char(i)
	if not escapes[c] then escapes[c] = s_format("\\u%04x", i) end
end
escapes[string.char(127)] = "\\u007f"

local function quote(s)
	return '"' .. s:gsub('[%c"\\\127]', escapes) .. '"'
end

--- JSON has no infinity or NaN; both become null, as in dkjson and JS.
local function number(v)
	if v ~= v or v == m_huge or v == -m_huge then
		return "null"
	end
	if v == m_floor(v) and m_abs(v) < 1e15 then
		return s_format("%d", v)
	end
	return s_format("%.10g", v)
end

local encodeValue

local function encodeTable(v, out)
	local meta = getmetatable(v)
	local kind = meta and meta.__jsonkind
	local n = #v
	local isObject
	if kind == "object" then
		isObject = true
	elseif kind == "array" then
		isObject = false
	else
		-- Unmarked: a table with no array part but some keys is an object;
		-- anything else (including empty) is an array.
		isObject = n == 0 and next(v) ~= nil
	end
	if isObject then
		out[#out + 1] = "{"
		local first = true
		for key, value in pairs(v) do
			if not first then out[#out + 1] = "," end
			first = false
			out[#out + 1] = quote(tostring(key))
			out[#out + 1] = ":"
			encodeValue(value, out)
		end
		out[#out + 1] = "}"
	else
		out[#out + 1] = "["
		for i = 1, n do
			if i > 1 then out[#out + 1] = "," end
			encodeValue(v[i], out)
		end
		out[#out + 1] = "]"
	end
end

encodeValue = function(v, out)
	local t = type(v)
	if v == nil then
		out[#out + 1] = "null"
	elseif t == "number" then
		out[#out + 1] = number(v)
	elseif t == "boolean" then
		out[#out + 1] = v and "true" or "false"
	elseif t == "string" then
		out[#out + 1] = quote(v)
	elseif t == "table" then
		encodeTable(v, out)
	else
		-- Functions and userdata have no JSON form; drop them rather than
		-- emitting something that will not parse on the other side.
		out[#out + 1] = "null"
	end
end

function M.encode(value)
	local out = { }
	encodeValue(value, out)
	return t_concat(out)
end

-- ---------------------------------------------------------------------------
-- decoding

local dkjson = require("dkjson")

--- Returns the value, or nil plus a message.
function M.decode(text)
	local value, _, err = dkjson.decode(text, 1, nil)
	if err then
		return nil, err
	end
	return value
end

return M
