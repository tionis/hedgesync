-- Driven by nvim.test.ts: open a note with the plugin, make random edits,
-- wait for the test to finish its remote edits, then dump the buffer.
local env = vim.env
vim.opt.rtp:prepend(env.PLUGIN)
vim.o.shortmess = vim.o.shortmess .. "F"
local notes = {}
vim.notify = function(msg, level) table.insert(notes, msg) end

local hs = require("hedgesync")
hs.setup({ cmd = { "bun", env.CLI }, args = { "--quiet" } })
local buf = hs.open(env.URL)
local ok = vim.wait(20000, function() local s = hs.session(buf); return s and s.loaded end, 10)
if not ok then
  io.open(env.OUT, "w"):write("NOT LOADED\n" .. table.concat(notes, "\n")):close()
  vim.cmd("qa!")
end
io.open(env.READY, "w"):close()

math.randomseed(tonumber(env.SEED))
local function keys(k)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(k, true, false, true), "xt", false)
end
local actions = {
  function() keys("i" .. ({ "a", "bc", "é", "中", "🙂", "x y" })[math.random(6)] .. "<Esc>") end,
  function() keys("A!<Esc>") end,
  function() keys("x") end,
  function() keys("dd") end,
  function() keys("onew line<Esc>") end,
  function() keys("Oabove<Esc>") end,
  function() keys("u") end,
  function() keys("<C-r>") end,
  function() keys("J") end,
  function() keys("yyp") end,
  function() keys(":silent! %s/a/A/ge<CR>") end,
  function() keys("G") end,
  function() keys("gg") end,
  function() keys(math.random(3) .. "j") end,
  function() keys("w") end,
  function() keys("ciwword<Esc>") end,
  function()
    local n = vim.api.nvim_buf_line_count(buf)
    local row = math.random(0, n - 1)
    local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1]
    local col = vim.str_byteindex(line, "utf-32", math.random(0, vim.str_utfindex(line, "utf-32")), false)
    vim.api.nvim_buf_set_text(buf, row, col, row, col, { "ins", "ert" })
  end,
}
for _ = 1, tonumber(env.STEPS) do
  actions[math.random(#actions)]()
  vim.wait(math.random(0, 8))
end
vim.wait(60000, function() return vim.uv.fs_stat(env.DONE) ~= nil end, 20)
vim.wait(1500)
local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
local f = io.open(env.OUT, "w"); f:write(text); f:close()
local log = io.open(env.LOG, "w"); log:write(table.concat(notes, "\n")); log:close()
hs.close_all(10000)
vim.cmd("qa!")
