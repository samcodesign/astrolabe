-- tree.power / tree.powerCancel / tree.optimise: the streaming jobs.
--
-- A whole-tree heatmap is ~2200 node evaluations at ~9 ms each, so it cannot be
-- a request/response method. Instead the request is acknowledged immediately
-- and the work is done in chunks between reads on stdin, which is what lets a
-- `tree.powerCancel` arriving mid-pass actually stop it.
--
-- Ordering is by path distance, nearest first, because the nodes a point or two
-- away are the ones a player is choosing between; the far half of the tree is
-- the part they will never look at.

local util = require("api.util")
local A, O = util.array, util.object

local m_huge = math.huge

local M = { }

--- How many nodes to evaluate before yielding back to the read loop. At the
--- measured ~9 ms per node this is roughly a fifth of a second, which keeps
--- cancellation responsive without drowning the client in notifications.
local CHUNK = 24

local job = nil

-- ---------------------------------------------------------------------------
-- shared evaluation

local function finite(v)
	if type(v) ~= "number" or v ~= v or v == m_huge or v == -m_huge then return 0 end
	return v
end

--- Offensive and defensive gain, using PoB's own weighting of the two
--- (CalcsTab:CalculateCombinedOffDefStat).
local function offDef(b, output, base)
	local offence, defence = b.calcsTab:CalculateCombinedOffDefStat(output, base)
	return finite(offence), finite(defence)
end

--- Rank by whichever metric was asked for. Anything that is not "offence" or
--- "defence" is read as a key into the calculation output.
local function metricValue(metric, offence, defence, output, base)
	if metric == "defence" then return defence end
	if metric == "offence" then return offence end
	local after, before = output[metric], base[metric]
	if type(after) == "number" and type(before) == "number" then
		return finite(after - before)
	end
	return 0
end

--- Unallocated nodes that carry modifiers, within `maxDepth` points, ordered by
--- path distance then id.
---
--- Masteries are skipped: their power depends on which effect you would pick,
--- which is a separate choice PoB models with its own per-effect report rather
--- than a single node score.
local function candidates(b, maxDepth)
	local spec = b.spec
	local granted = b.calcsTab.mainEnv and b.calcsTab.mainEnv.grantedPassives or { }
	local list = { }
	for id, node in pairs(spec.nodes) do
		if not node.alloc
			and node.modKey and node.modKey ~= ""
			and not granted[id]
			and node.type ~= "Mastery"
			and node.type ~= "ClassStart"
			and node.type ~= "AscendClassStart"
			and node.path
			and (node.pathDist or m_huge) <= maxDepth then
			list[#list + 1] = node
		end
	end
	table.sort(list, function(x, y)
		if x.pathDist ~= y.pathDist then return x.pathDist < y.pathDist end
		return x.id < y.id
	end)
	return list
end

--- Evaluate one node, memoised on its modifier key exactly as PoB's
--- PowerBuilder does — identical passives are common and each one costs a full
--- calculation pass.
local function evaluate(state, node)
	local output = state.cache[node.modKey]
	if not output then
		output = state.calc({ addNodes = { [node] = true } })
		state.cache[node.modKey] = output
	end
	local offence, defence = offDef(state.build, output, state.base)
	local cost = node.pathDist or 1
	if cost < 1 then cost = 1 end
	local value = metricValue(state.metric, offence, defence, output, state.base)
	return O{
		id = node.id,
		offence = util.round(offence, 6),
		defence = util.round(defence, 6),
		pathCost = cost,
		perPoint = util.round(value / cost, 6),
	}, value
end

--- The misc calculator, not `getNodeCalculator`. The latter wipes `env.modDB`
--- and leans on a `cachedPlayerDB` parent that is snapshotted *before* passive
--- and item mods are merged (CalcSetup.lua:585), so it evaluates a character
--- with none of the build's gear or tree. Nothing in PoB calls it any more.
--- The misc calculator costs the same ~9 ms per node and is what PoB's own
--- PowerBuilder uses.
local function newState(b, metric)
	local calc, base = b.calcsTab:GetMiscCalculator()
	return { build = b, calc = calc, base = base, metric = metric, cache = { } }
end

-- ---------------------------------------------------------------------------
-- tree.power

local function powerStep()
	local batch = A{ }
	local last = math.min(job.index + CHUNK - 1, #job.queue)
	for i = job.index, last do
		batch[#batch + 1] = (evaluate(job.state, job.queue[i]))
	end
	job.index = last + 1

	table.sort(batch, function(a, b) return a.perPoint > b.perPoint end)
	util.notify("tree.power.progress", O{
		id = job.id,
		done = job.index - 1,
		total = #job.queue,
		nodes = batch,
	})

	if job.index > #job.queue then
		util.notify("tree.power.done", O{
			id = job.id,
			total = #job.queue,
			elapsedMs = util.round(RPC_NOW_MS() - job.startedMs, 0),
		})
		job = nil
		return false
	end
	return true
end

-- ---------------------------------------------------------------------------
-- tree.optimise
--
-- Beam search over allocation states. Each round expands every state in the
-- beam, scores the reachable nodes against that state, and keeps the best
-- `beamWidth` successors; `beamWidth = 1` is plain greedy.
--
-- MEASURED, AND THE RESULT IS NEGATIVE SO FAR. On the 3.13 sample build a
-- width-4 beam over an 8-point budget ran 1,248 evaluations in 19.1 s against
-- greedy's 384 in 5.7 s — 3.4x the cost — and returned a byte-identical answer
-- (+0.0000%). Same at budget 4, width 3.
--
-- That is not a bug, it is the shape of the problem: `evaluate` scores the
-- marginal gain of one node against the current tree, and passive damage
-- modifiers are near-additive, so the objective is close to submodular and
-- greedy is already at or near optimal. A beam only pays where marginal value
-- is *non*-additive — a keystone that changes a mechanic, a conversion
-- threshold, a cluster whose first point buys nothing. None of those were
-- within 8 points of the test build.
--
-- So `beamWidth` defaults to 1 (greedy) and the width is a lever, not a
-- default. Before widening it in the UI, find a build where it demonstrably
-- wins; if none turns up, the honest ship is greedy plus the ranked
-- value-per-point list, which is what `tree.power` already streams.
--
-- Exploring a branch does mutate the live spec, which an earlier note here
-- called a blocker. It is not: `CreateUndoState` snapshots the allocation set,
-- class and mastery choices, and `RestoreUndoState` re-imports it wholesale
-- (PassiveSpec.lua:2273-2300), so a branch can be walked and wound back. The
-- cost is one `ImportFromNodeList` per state per round, which is why states are
-- materialised only after pruning: `beamWidth` restores a round, not one per
-- candidate.

--- Nodes evaluated per state per round. `candidates` is ordered nearest-first,
--- so the cut keeps the points a player would actually consider. Without a cap
--- the work is `beamWidth * |candidates| * budget` evaluations at ~9 ms each,
--- which at a full tree runs to minutes.
local EXPAND_LIMIT = 48

--- Stable identity for an allocation set, so two branches that converge on the
--- same nodes by different routes do not both occupy the beam.
local function signature(ids)
	local sorted = { }
	for i, id in ipairs(ids) do sorted[i] = id end
	table.sort(sorted)
	return table.concat(sorted, ",")
end

--- Record a state that cannot be expanded further. The answer is the best
--- *terminal* state, not whatever happens to survive in the beam: a branch that
--- spent its whole budget early is a complete suggestion, and a partially spent
--- one usually scores lower without being worse.
local function recordTerminal(entry)
	if not job.best or entry.gain > job.best.gain then
		job.best = entry
	end
end

--- Put the spec into `entry`'s state and work out what can be reached from it.
local function prepareEntry(entry)
	local b = job.build
	b.spec:RestoreUndoState(entry.undo, b.spec.treeVersion)
	b.buildFlag = true
	runCallback("OnFrame")

	local queue = candidates(b, entry.pointsLeft)
	for i = #queue, EXPAND_LIMIT + 1, -1 do queue[i] = nil end
	job.entryState = { state = newState(b, job.metric), queue = queue, index = 1 }
	return #queue > 0
end

--- Prune this round's successors to the beam width and make them real states.
local function advanceRound()
	if #job.successors == 0 then
		return M.finishOptimise()
	end
	table.sort(job.successors, function(x, y)
		if x.total ~= y.total then return x.total > y.total end
		-- Same payoff for fewer points is strictly better, and keeps the
		-- ordering deterministic for the tests.
		if x.pointsUsed ~= y.pointsUsed then return x.pointsUsed < y.pointsUsed end
		return x.node.id < y.node.id
	end)

	-- Cap how many children one parent may contribute. Without it the beam
	-- collapses: the leading branch's successors are all scored higher than any
	-- rival's first step, so they take every slot and the search degenerates
	-- into greedy with extra cost — measured at 2.5x the evaluations for a
	-- byte-identical answer. Rank 1 is always admitted, so keeping the greedy
	-- trajectory is unaffected.
	local perParent = math.max(1, math.ceil(job.beamWidth / 2))
	local fromParent = { }

	local beam, seen = { }, { }
	for _, s in ipairs(job.successors) do
		if #beam >= job.beamWidth then break end
		local used = fromParent[s.entry] or 0
		if used >= perParent then goto continue end
		fromParent[s.entry] = used + 1

		local chosen, chosenSet = { }, { }
		for i, id in ipairs(s.entry.chosen) do
			chosen[i] = id
			chosenSet[id] = true
		end
		for _, id in ipairs(s.path) do
			if not chosenSet[id] then
				chosenSet[id] = true
				chosen[#chosen + 1] = id
			end
		end

		local sig = signature(chosen)
		if not seen[sig] then
			seen[sig] = true
			-- Materialise: only now does the branch cost a restore.
			job.build.spec:RestoreUndoState(s.entry.undo, job.build.spec.treeVersion)
			job.build.spec:AllocNode(s.node)
			job.build.buildFlag = true
			runCallback("OnFrame")
			beam[#beam + 1] = {
				undo = job.build.spec:CreateUndoState(),
				chosen = chosen,
				gain = s.total,
				pointsLeft = s.entry.pointsLeft - s.cost,
			}
		end
		::continue::
	end

	job.beam = beam
	job.successors = { }
	job.entryIndex = 1
	job.entryState = nil

	local leader = job.best
	for _, entry in ipairs(beam) do
		if not leader or entry.gain > leader.gain then leader = entry end
	end
	util.notify("tree.optimise.progress", O{
		id = job.id,
		best = O{
			nodes = A(leader and leader.chosen or { }),
			gain = util.round(leader and leader.gain or 0, 6),
			pointsUsed = leader and #leader.chosen or 0,
		},
		explored = job.explored,
	})

	if #beam == 0 then return M.finishOptimise() end
	return true
end

local function optimiseStep()
	if job.entryIndex > #job.beam then
		return advanceRound()
	end

	local entry = job.beam[job.entryIndex]
	if entry.pointsLeft <= 0 then
		recordTerminal(entry)
		job.entryIndex = job.entryIndex + 1
		job.entryState = nil
		return true
	end
	if not job.entryState and not prepareEntry(entry) then
		-- Nothing reachable within the remaining budget: this branch is done.
		recordTerminal(entry)
		job.entryIndex = job.entryIndex + 1
		job.entryState = nil
		return true
	end

	local es = job.entryState
	local last = math.min(es.index + CHUNK - 1, #es.queue)
	for i = es.index, last do
		local node = es.queue[i]
		local scored, value = evaluate(es.state, node)
		job.explored = job.explored + 1
		if value > 0 and scored.pathCost <= entry.pointsLeft then
			local path = { }
			for _, pathNode in ipairs(node.path) do path[#path + 1] = pathNode.id end
			job.successors[#job.successors + 1] = {
				entry = entry,
				node = node,
				path = path,
				cost = scored.pathCost,
				value = value,
				total = entry.gain + value,
				pointsUsed = #entry.chosen + scored.pathCost,
			}
		end
	end
	es.index = last + 1

	if es.index > #es.queue then
		job.entryIndex = job.entryIndex + 1
		job.entryState = nil
	end
	return true
end

--- The best complete suggestion found, falling back to the strongest branch
--- still in the beam when the search was cut short.
local function bestResult()
	local leader = job.best
	for _, entry in ipairs(job.beam or { }) do
		if not leader or entry.gain > leader.gain then leader = entry end
	end
	return leader
end

M.bestResult = bestResult

function M.finishOptimise()
	local leader = bestResult()
	util.notify("tree.optimise.done", O{
		id = job.id,
		best = O{
			nodes = A(leader and leader.chosen or { }),
			gain = util.round(leader and leader.gain or 0, 6),
		},
	})
	-- Leave the build exactly as we found it; the client decides whether to
	-- apply the suggestion via tree.allocate.
	job.build.spec:RestoreUndoState(job.undo, job.build.spec.treeVersion)
	job.build.buildFlag = true
	runCallback("OnFrame")
	job = nil
	return false
end

-- ---------------------------------------------------------------------------
-- driver

--- Advance the running job by one chunk. Returns true while work remains.
function M.step()
	if not job then return false end
	local kind, id = job.kind, job.id
	local ok, more = pcall(kind == "power" and powerStep or optimiseStep)
	if not ok then
		-- A job that blows up must still be closed out, or the client waits
		-- forever for a `done` that never arrives.
		RPC_LOG("rpc: streaming job aborted: " .. tostring(more))
		job = nil
		if kind == "power" then
			util.notify("tree.power.done", O{ id = id, total = 0, elapsedMs = 0 })
		else
			util.notify("tree.optimise.done", O{ id = id, best = O{ nodes = A{ }, gain = 0 } })
		end
		return false
	end
	return more and true or false
end

function M.busy()
	return job ~= nil
end

-- ---------------------------------------------------------------------------
-- methods

M.methods = { }

M.methods["tree.power"] = function(params, id)
	params = params or { }
	local b = util.build()
	local metric = params.metric
	if metric ~= nil and type(metric) ~= "string" then
		util.invalid("metric must be a string")
	end
	metric = metric or "offence"
	local maxDepth = params.maxDepth
	if maxDepth ~= nil and type(maxDepth) ~= "number" then
		util.invalid("maxDepth must be a number")
	end
	maxDepth = math.floor(maxDepth or 3)
	if maxDepth < 1 then util.invalid("maxDepth must be at least 1") end

	local queue = candidates(b, maxDepth)
	job = {
		kind = "power",
		id = id,
		queue = queue,
		index = 1,
		state = newState(b, metric),
		startedMs = RPC_NOW_MS(),
	}
	if #queue == 0 then
		util.notify("tree.power.done", O{ id = id, total = 0, elapsedMs = 0 })
		job = nil
	end
	return O{ requested = #queue }
end

--- Stop the running job, if it is of `kind` and (when given) has request id
--- `id`. A cancel that names a job which already finished is a no-op, not an
--- error: the client cannot know the pass ended between its two writes.
local function cancel(kind, params)
	params = params or { }
	if params.id ~= nil and type(params.id) ~= "number" then
		util.invalid("id must be the request id of the job to cancel")
	end
	if not job or job.kind ~= kind then
		return O{ }
	end
	if params.id ~= nil and job.id ~= params.id then
		return O{ }
	end

	local cancelled = job
	job = nil
	if kind == "power" then
		util.notify("tree.power.done", O{
			id = cancelled.id,
			total = cancelled.index - 1,
			elapsedMs = util.round(RPC_NOW_MS() - cancelled.startedMs, 0),
		})
	else
		-- Cancelling still answers with the best branch found so far, which is
		-- the point of a streaming search: a partial answer is useful.
		job = cancelled
		local leader = M.bestResult()
		job = nil
		util.notify("tree.optimise.done", O{
			id = cancelled.id,
			best = O{
				nodes = A(leader and leader.chosen or { }),
				gain = util.round(leader and leader.gain or 0, 6),
			},
		})
		cancelled.build.spec:RestoreUndoState(cancelled.undo, cancelled.build.spec.treeVersion)
		cancelled.build.buildFlag = true
		runCallback("OnFrame")
	end
	return O{ }
end

M.methods["tree.powerCancel"] = function(params)
	return cancel("power", params)
end

M.methods["tree.optimiseCancel"] = function(params)
	return cancel("optimise", params)
end

M.methods["tree.optimise"] = function(params, id)
	params = params or { }
	local b = util.build()
	if type(params.budget) ~= "number" or params.budget < 1 then
		util.invalid("tree.optimise needs a budget of at least 1 point")
	end
	local budget = math.floor(params.budget)
	local metric = type(params.metric) == "string" and params.metric or "offence"

	-- Every extra beam entry multiplies the work by a full round of ~9 ms
	-- evaluations, so the ceiling is low on purpose. 1 is greedy.
	local beamWidth = params.beamWidth
	if beamWidth ~= nil and type(beamWidth) ~= "number" then
		util.invalid("beamWidth must be a number")
	end
	beamWidth = math.floor(beamWidth or 1)
	if beamWidth < 1 or beamWidth > 8 then
		util.invalid("beamWidth must be between 1 and 8")
	end

	local undo = b.spec:CreateUndoState()
	local queue = candidates(b, budget)
	job = {
		kind = "optimise",
		id = id,
		build = b,
		metric = metric,
		budget = budget,
		beamWidth = beamWidth,
		-- The search starts from a single state: the tree as it stands.
		beam = { { undo = undo, chosen = { }, gain = 0, pointsLeft = budget } },
		entryIndex = 1,
		entryState = nil,
		successors = { },
		best = nil,
		explored = 0,
		undo = undo,
		startedMs = RPC_NOW_MS(),
	}
	if #queue == 0 then
		M.finishOptimise()
	end
	return O{ requested = #queue }
end

return M
