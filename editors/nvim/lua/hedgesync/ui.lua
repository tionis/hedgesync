-- hedgesync.nvim: browsing notes, creating them, search and revisions.
--
-- Everything here goes through the CLI's --json output (`hedgesync list`,
-- `create`, `search`, `revisions`, ...), so it uses the same saved logins and
-- needs no HTTP code of its own. Live editing stays in init.lua.

local M = {}
local api = vim.api
local function hs()
  return require("hedgesync")
end

local function notify(msg, level)
  vim.notify("hedgesync: " .. msg, level or vim.log.levels.INFO)
end

---@type table<integer, table> state of browse/revisions buffers, by buffer
local views = {}
local ns = api.nvim_create_namespace("hedgesync_ui")

for name, link in pairs({
  HedgeSyncHeader = "Title",
  HedgeSyncPinned = "DiagnosticWarn",
  HedgeSyncTag = "Label",
  HedgeSyncTime = "Comment",
  HedgeSyncHint = "Comment",
  HedgeSyncAdded = "Added",
  HedgeSyncRemoved = "Removed",
}) do
  api.nvim_set_hl(0, name, { link = link, default = true })
end

--- Run `hedgesync <args> --json` and call on_ok(data) on the main loop.
--- Failures are reported (with the CLI's hint) and call opts.on_error.
---@param args string[]
---@param on_ok fun(data: table)
---@param opts? { stdin?: string, on_error?: fun() }
function M.cli(args, on_ok, opts)
  opts = opts or {}
  local cmd = vim.list_extend(vim.deepcopy(hs().config.cmd), args)
  table.insert(cmd, "--json")
  local ok, err = pcall(vim.system, cmd, { text = true, stdin = opts.stdin or false }, function(r)
    vim.schedule(function()
      local decoded, data = pcall(vim.json.decode, r.stdout or "")
      if decoded and type(data) == "table" and data.success ~= false then
        return on_ok(data)
      end
      local msg = decoded and type(data) == "table" and data.error or vim.trim(r.stderr or "")
      if msg == "" then
        msg = ("`hedgesync %s` failed (exit %d)"):format(args[1], r.code)
      end
      local hint = decoded and type(data) == "table" and data.hint
      notify(msg .. (hint and ("\n" .. hint) or ""), vim.log.levels.ERROR)
      if opts.on_error then
        opts.on_error()
      end
    end)
  end)
  if not ok then
    notify("could not run " .. cmd[1] .. ": " .. tostring(err), vim.log.levels.ERROR)
  end
end

--- https://host[/sub]/id -> https://host[/sub]
function M.server_of(url)
  return (url:gsub("[?#].*$", ""):gsub("/+$", ""):match("^(.-)/[^/]+$"))
end

local function normalize_server(s)
  s = hs().http_url(s)
  if not s:match("^https?://") then
    s = "https://" .. s
  end
  return (s:gsub("/+$", ""))
end

--- The server to work with: the argument, the note or view in the current
--- buffer, the last one used, the only saved login, else ask.
---@param arg string|nil
---@param cb fun(server: string)
function M.pick_server(arg, cb)
  arg = vim.trim(arg or "")
  if arg ~= "" then
    M.last_server = normalize_server(arg)
    return cb(M.last_server)
  end
  local s = hs().session(0)
  local view = views[api.nvim_get_current_buf()]
  local here = s and M.server_of(s.url) or view and view.server
  if here then
    M.last_server = here
    return cb(here)
  end
  if M.last_server then
    return cb(M.last_server)
  end
  -- The server of the notes open right now, if they share one.
  local open = {}
  for _, other in pairs(hs().sessions()) do
    open[M.server_of(other.url)] = true
  end
  if vim.tbl_count(open) == 1 then
    M.last_server = next(open)
    return cb(M.last_server)
  end
  M.cli({ "sessions" }, function(data)
    local list = data.sessions or {}
    if #list == 0 then
      notify("no saved login; run: hedgesync login <server> --save (or pass a server)", vim.log.levels.WARN)
    elseif #list == 1 then
      M.last_server = list[1].server
      cb(list[1].server)
    else
      vim.ui.select(list, {
        prompt = "HedgeDoc server",
        format_item = function(x)
          return x.server .. (x.user and x.user.name and ("  (" .. x.user.name .. ")") or "")
        end,
      }, function(choice)
        if choice then
          M.last_server = choice.server
          cb(choice.server)
        end
      end)
    end
  end)
end

local function relative(ms)
  local d = os.time() - math.floor((ms or 0) / 1000)
  if d < 60 then
    return "just now"
  elseif d < 3600 then
    return ("%d min ago"):format(d / 60)
  elseif d < 86400 then
    return ("%d h ago"):format(d / 3600)
  elseif d < 86400 * 30 then
    local days = math.floor(d / 86400)
    return days == 1 and "yesterday" or ("%d days ago"):format(days)
  end
  return os.date("%Y-%m-%d", math.floor(ms / 1000))
end

local function pad(text, width)
  local w = vim.fn.strdisplaywidth(text)
  if w > width then
    text = vim.fn.strcharpart(text, 0, width - 1) .. "…"
    w = vim.fn.strdisplaywidth(text)
  end
  return text .. string.rep(" ", width - w)
end

local function find_buf(name)
  for _, b in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_get_name(b) == name then
      return b
    end
  end
end

--- A scratch buffer for a view, reused by name, shown in the current window.
local function view_buf(name, filetype)
  local buf = find_buf(name)
  if not buf then
    buf = api.nvim_create_buf(true, true)
    api.nvim_buf_set_name(buf, name)
    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "hide"
    vim.bo[buf].swapfile = false
    vim.bo[buf].filetype = filetype
  end
  api.nvim_set_current_buf(buf)
  vim.wo.wrap = false
  vim.wo.cursorline = true
  return buf
end

--- Replace a view's lines; marks are {row, col_start, col_end, hl_group} (0-based bytes).
local function render(buf, lines, marks)
  vim.bo[buf].modifiable = true
  api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  vim.bo[buf].modified = false
  api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  for _, m in ipairs(marks or {}) do
    pcall(api.nvim_buf_set_extmark, buf, ns, m[1], m[2], { end_col = m[3], hl_group = m[4] })
  end
end

local function map(buf, lhs, fn, desc)
  vim.keymap.set("n", lhs, fn, { buffer = buf, nowait = true, silent = true, desc = "hedgesync: " .. desc })
end

local function copy(text)
  pcall(vim.fn.setreg, "+", text)
  vim.fn.setreg('"', text)
  notify("copied " .. text)
end

local function item_under_cursor(buf)
  local view = views[buf]
  if not view or not view.items then
    return
  end
  return view.items[api.nvim_win_get_cursor(0)[1] - view.first + 1]
end

--- The note a command is about: the live note in this buffer, or the note
--- under the cursor in a browse view.
local function current_note()
  local s = hs().session(0)
  if s then
    return { url = s.url, title = s.title }
  end
  local view = views[api.nvim_get_current_buf()]
  if view and view.kind == "browse" then
    local item = item_under_cursor(api.nvim_get_current_buf())
    return item and { url = item.url, title = item.text }
  elseif view and view.kind == "revisions" then
    return { url = view.url, title = view.title }
  end
end

local function help(lines)
  notify("keys\n" .. table.concat(lines, "\n"))
end

-- :Hedge browse ---------------------------------------------------------

local browse_help = {
  "<CR> open        <C-v> open in vsplit   <C-x> open in split",
  "n    new note    p     pin / unpin      r     revisions",
  "y    copy URL    D     remove from history",
  "s    search text (quickfix)             R     reload      q close",
}

local function draw_browse(buf)
  local view = views[buf]
  local lines = { "", "" }
  local marks = {}
  local count = view.items and #view.items or 0
  lines[1] = view.items and ("%s · %d note%s · ? for keys"):format(view.server, count, count == 1 and "" or "s")
    or (view.server .. " · loading…")
  marks[1] = { 0, 0, #view.server, "HedgeSyncHeader" }
  if view.items and count == 0 then
    table.insert(lines, "  (your history is empty: notes appear here once you have opened them while signed in)")
  end
  local width = 20
  for _, item in ipairs(view.items or {}) do
    width = math.max(width, math.min(50, vim.fn.strdisplaywidth(item.text or "")))
  end
  for _, item in ipairs(view.items or {}) do
    local pin = item.pinned and "★ " or "  "
    local title = pad(item.text ~= "" and item.text or "(untitled)", width)
    local time = pad(relative(item.time), 12)
    local tags = {}
    for _, t in ipairs(item.tags or {}) do
      table.insert(tags, "#" .. t)
    end
    local line = pin .. title .. "  " .. time .. "  " .. table.concat(tags, " ")
    local row = #lines
    table.insert(lines, line)
    if item.pinned then
      table.insert(marks, { row, 0, #pin, "HedgeSyncPinned" })
    end
    local t0 = #pin + #title + 2
    table.insert(marks, { row, t0, t0 + #time, "HedgeSyncTime" })
    table.insert(marks, { row, t0 + #time + 2, #line, "HedgeSyncTag" })
  end
  render(buf, lines, marks)
end

local function load_browse(buf, keep_cursor)
  local view = views[buf]
  local cursor = keep_cursor and api.nvim_win_get_cursor(0)
  M.cli({ "list", view.server }, function(data)
    if not api.nvim_buf_is_valid(buf) then
      return
    end
    view.items = data.notes or {}
    draw_browse(buf)
    for _, win in ipairs(vim.fn.win_findbuf(buf)) do
      local row = cursor and cursor[1] or view.first
      pcall(api.nvim_win_set_cursor, win, { math.min(row, api.nvim_buf_line_count(buf)), 0 })
    end
  end)
end

--- List the notes in your history on a server; open, pin, create, search.
function M.browse(server)
  M.pick_server(server, function(srv)
    local buf = view_buf("hedgesync://browse/" .. srv:gsub("^https?://", ""), "hedgesync_browse")
    local fresh = not views[buf]
    views[buf] = views[buf] or { kind = "browse", server = srv, first = 3 }
    if fresh then
      draw_browse(buf)
      local function open_with(cmd)
        return function()
          local item = item_under_cursor(buf)
          if item then
            if cmd then
              vim.cmd(cmd)
            end
            hs().open(item.url)
          end
        end
      end
      map(buf, "<CR>", open_with(nil), "open note")
      map(buf, "<C-v>", open_with("vsplit"), "open note in a vertical split")
      map(buf, "<C-x>", open_with("split"), "open note in a split")
      map(buf, "n", function()
        M.new({ server = srv })
      end, "new note")
      map(buf, "p", function()
        local item = item_under_cursor(buf)
        if item then
          M.cli({ item.pinned and "unpin" or "pin", item.url }, function()
            load_browse(buf, true)
          end)
        end
      end, "pin or unpin")
      map(buf, "r", function()
        local item = item_under_cursor(buf)
        if item then
          M.revisions(item.url, item.text)
        end
      end, "revisions")
      map(buf, "y", function()
        local item = item_under_cursor(buf)
        if item then
          copy(item.url)
        end
      end, "copy URL")
      map(buf, "D", function()
        local item = item_under_cursor(buf)
        if item and vim.fn.confirm(("Remove “%s” from your history? (The note itself stays.)"):format(item.text), "&Remove\n&Cancel", 2) == 1 then
          M.cli({ "history-delete", item.url }, function()
            load_browse(buf, true)
          end)
        end
      end, "remove from history")
      map(buf, "s", function()
        vim.ui.input({ prompt = "Search your notes for: " }, function(text)
          if text and vim.trim(text) ~= "" then
            M.search(text, srv)
          end
        end)
      end, "search note text")
      map(buf, "R", function()
        load_browse(buf, true)
      end, "reload")
      map(buf, "q", function()
        vim.cmd("bdelete")
      end, "close")
      map(buf, "?", function()
        help(browse_help)
      end, "help")
    end
    load_browse(buf, not fresh)
  end)
end

-- :Hedge find -----------------------------------------------------------

--- Pick a note from your history with vim.ui.select (your fuzzy finder, if it replaces it).
function M.find(server)
  M.pick_server(server, function(srv)
    M.cli({ "list", srv }, function(data)
      local notes = data.notes or {}
      if #notes == 0 then
        return notify("no notes in your history on " .. srv)
      end
      vim.ui.select(notes, {
        prompt = "Open note",
        format_item = function(n)
          local tags = {}
          for _, t in ipairs(n.tags or {}) do
            table.insert(tags, "#" .. t)
          end
          return (n.pinned and "★ " or "") .. (n.text ~= "" and n.text or n.id) .. "  " .. table.concat(tags, " ")
        end,
      }, function(choice)
        if choice then
          hs().open(choice.url)
        end
      end)
    end)
  end)
end

-- :Hedge new ------------------------------------------------------------

--- Create a note and open it. With lines, they become its content; with a
--- title, it starts with "# title".
---@param opts { server?: string, title?: string, lines?: string[] }
function M.new(opts)
  opts = opts or {}
  M.pick_server(opts.server, function(srv)
    local function create(title)
      local content, line = "", nil
      if opts.lines then
        content = table.concat(opts.lines, "\n") .. "\n"
      elseif title ~= "" then
        content, line = "# " .. title .. "\n\n", 3
      end
      M.cli({ "create", srv }, function(data)
        notify("created " .. data.url)
        hs().open(data.url, { line = line })
      end, { stdin = content })
    end
    if opts.title or opts.lines then
      create(opts.title or "")
    else
      vim.ui.input({ prompt = "Title of the new note (empty for none): " }, function(title)
        if title then
          create(vim.trim(title))
        end
      end)
    end
  end)
end

-- :Hedge search ---------------------------------------------------------

--- Search the text of your notes; matches go to the quickfix list, whose
--- entries open the notes live at the matching line.
function M.search(pattern, server)
  pattern = vim.trim(pattern or "")
  if pattern == "" then
    return notify("usage: :Hedge search <text>", vim.log.levels.ERROR)
  end
  M.pick_server(server, function(srv)
    notify("searching your notes on " .. srv .. "…")
    local args = { "search", srv, pattern }
    if pattern:lower() == pattern then
      table.insert(args, "--ignore-case") -- smartcase
    end
    M.cli(args, function(data)
      local items = {}
      for _, n in ipairs(data.notes or {}) do
        for _, l in ipairs(n.lines or {}) do
          table.insert(items, { filename = hs().buf_name(n.url), lnum = l.line, text = n.title .. " │ " .. l.text })
        end
      end
      vim.fn.setqflist({}, " ", { title = "hedgesync search: " .. pattern, items = items })
      if #items == 0 then
        notify(("no matches in %d notes"):format(data.searched or 0))
      else
        vim.cmd("botright copen")
      end
    end)
  end)
end

-- :Hedge revisions --------------------------------------------------------

local revisions_help = {
  "<CR> view revision    d diff with the note    R restore into the note",
  "y    copy timestamp   r reload                 q close",
}

--- A read-only buffer with one revision's content.
local function show_revision(view, rev, cb)
  local name = ("hedgesync://revision/%s@%d"):format(view.url:gsub("^https?://", ""), rev.time)
  local function done(buf)
    if cb then
      cb(buf)
    end
  end
  local existing = find_buf(name)
  if existing then
    return done(existing)
  end
  M.cli({ "revisions", view.url, tostring(rev.time) }, function(data)
    local buf = find_buf(name) or api.nvim_create_buf(true, true)
    api.nvim_buf_set_name(buf, name)
    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "wipe"
    vim.bo[buf].swapfile = false
    api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(data.content or "", "\n", { plain = true }))
    vim.bo[buf].modifiable = false
    vim.bo[buf].filetype = "markdown"
    map(buf, "q", function()
      local diffing = vim.wo.diff
      vim.cmd("close")
      if diffing then
        vim.cmd("diffoff!")
      end
    end, "close revision")
    done(buf)
  end)
end

local function revision_under_cursor(buf)
  local view = views[buf]
  local i = api.nvim_win_get_cursor(0)[1] - view.first + 1
  return view.items and view.items[i], i - 1
end

--- The window showing the live note, opening it in another window if needed.
local function note_window(url, list_win)
  local name = hs().buf_name(url)
  local buf = find_buf(name)
  if buf then
    local wins = vim.fn.win_findbuf(buf)
    if #wins > 0 then
      return wins[1]
    end
  end
  api.nvim_set_current_win(list_win)
  vim.cmd("aboveleft split")
  hs().open(url)
  return api.nvim_get_current_win()
end

local function draw_revisions(buf)
  local view = views[buf]
  local header = ("Revisions of %s"):format(view.title ~= nil and view.title ~= "" and view.title or view.url)
  local lines = { header .. " · ? for keys", "" }
  local marks = { { 0, 0, #header, "HedgeSyncHeader" } }
  if view.items and #view.items == 0 then
    table.insert(lines, "  (no revisions yet; HedgeDoc saves them periodically while a note is edited)")
  elseif not view.items then
    table.insert(lines, "  loading…")
  end
  for i, rev in ipairs(view.items or {}) do
    local older = view.items[i + 1]
    local delta = older and (rev.length - older.length) or nil
    local head = ("~%-3d %s  %s %7d chars"):format(
      i - 1,
      os.date("%Y-%m-%d %H:%M", math.floor(rev.time / 1000)),
      pad(relative(rev.time), 12),
      rev.length
    )
    local tail = delta == nil and "" or delta == 0 and "  ±0" or ("  %+d"):format(delta)
    local row = #lines
    table.insert(lines, head .. tail)
    table.insert(marks, { row, 23, 23 + 12, "HedgeSyncTime" })
    if delta and delta ~= 0 then
      table.insert(marks, { row, #head, #head + #tail, delta > 0 and "HedgeSyncAdded" or "HedgeSyncRemoved" })
    end
  end
  render(buf, lines, marks)
end

local function load_revisions(buf)
  local view = views[buf]
  M.cli({ "revisions", view.url }, function(data)
    if api.nvim_buf_is_valid(buf) then
      view.items = data.revisions or {}
      draw_revisions(buf)
      for _, win in ipairs(vim.fn.win_findbuf(buf)) do
        if api.nvim_win_get_cursor(win)[1] < view.first then
          pcall(api.nvim_win_set_cursor, win, { math.min(view.first, api.nvim_buf_line_count(buf)), 0 })
        end
      end
    end
  end)
end

local function restore(view, rev, index)
  local label = ("~%d (%s)"):format(index, os.date("%Y-%m-%d %H:%M", math.floor(rev.time / 1000)))
  if vim.fn.confirm("Make the note's content revision " .. label .. " again?", "&Restore\n&Cancel", 2) ~= 1 then
    return
  end
  local name = hs().buf_name(view.url)
  local live = find_buf(name)
  local s = live and hs().session(live)
  if s and s.loaded and s.editable then
    -- As an edit in the live buffer: synced like typing, and `u` undoes it.
    M.cli({ "revisions", view.url, tostring(rev.time) }, function(data)
      api.nvim_buf_set_lines(s.buf, 0, -1, false, vim.split(data.content or "", "\n", { plain = true }))
      notify("restored " .. label .. "; u in the note undoes it")
    end)
  else
    M.cli({ "revisions", view.url, tostring(rev.time), "--restore" }, function()
      notify("restored " .. label)
    end)
  end
end

--- List a note's revisions; view, diff against the note, or restore one.
---@param url? string the note (default: the current one)
---@param title? string
function M.revisions(url, title)
  if not url then
    local note = current_note()
    if not note then
      return notify("not on a note: open one, or use this from :Hedge browse", vim.log.levels.WARN)
    end
    url, title = note.url, note.title
  end
  if hs().session(0) then
    vim.cmd("botright 12split")
  end
  local list_win = api.nvim_get_current_win()
  local buf = view_buf("hedgesync://revisions/" .. url:gsub("^https?://", ""), "hedgesync_revisions")
  local fresh = not views[buf]
  views[buf] = views[buf] or { kind = "revisions", url = url, server = M.server_of(url), first = 3 }
  local view = views[buf]
  view.title = title or view.title
  if fresh then
    draw_revisions(buf)
    map(buf, "<CR>", function()
      local rev = revision_under_cursor(buf)
      if rev then
        show_revision(view, rev, function(rbuf)
          vim.cmd("aboveleft split")
          api.nvim_set_current_buf(rbuf)
        end)
      end
    end, "view revision")
    map(buf, "d", function()
      local rev = revision_under_cursor(buf)
      if not rev then
        return
      end
      show_revision(view, rev, function(rbuf)
        local win = note_window(view.url, list_win)
        api.nvim_set_current_win(win)
        vim.cmd("diffthis")
        vim.cmd("leftabove vsplit")
        api.nvim_set_current_buf(rbuf)
        vim.cmd("diffthis")
      end)
    end, "diff with the note")
    map(buf, "R", function()
      local rev, index = revision_under_cursor(buf)
      if rev then
        restore(view, rev, index)
      end
    end, "restore revision")
    map(buf, "y", function()
      local rev = revision_under_cursor(buf)
      if rev then
        copy(tostring(rev.time))
      end
    end, "copy timestamp")
    map(buf, "r", function()
      load_revisions(buf)
    end, "reload")
    map(buf, "q", function()
      if #api.nvim_list_wins() > 1 then
        vim.cmd("close")
      else
        vim.cmd("bdelete")
      end
    end, "close")
    map(buf, "?", function()
      help(revisions_help)
    end, "help")
  end
  load_revisions(buf)
end

-- :Hedge url --------------------------------------------------------------

--- Copy the note's URL: the editor (default), its published page or slides.
---@param kind? "edit"|"publish"|"slide"
function M.url(kind)
  local note = current_note()
  if not note then
    return notify("not on a note", vim.log.levels.WARN)
  end
  kind = vim.trim(kind or "")
  if kind == "" or kind == "edit" then
    return copy(note.url)
  end
  if kind ~= "publish" and kind ~= "slide" then
    return notify("usage: :Hedge url [edit|publish|slide]", vim.log.levels.ERROR)
  end
  M.cli({ "publish", note.url }, function(data)
    copy(data[kind])
  end)
end

M._views = views
return M
