-- hedgesync.nvim: live-edit HedgeDoc notes, keystroke by keystroke.
--
-- Each note buffer runs `hedgesync bridge <url>` and exchanges JSON lines with
-- it. The bridge does all operational transformation; this side only reports
-- buffer changes and applies remote edits whose `base` matches the
-- number of changes it has sent, dropping stale ones (the bridge resends them
-- rebased). See src/editor-bridge.ts for the protocol.

local M = {}

--- Editor protocol this plugin speaks (BRIDGE_PROTOCOL in src/editor-bridge.ts).
M.protocol = 1

--- Plugin root directory (holds .hedgesync-install.json when installed by
--- `hedgesync editor nvim install`).
M.root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h:h")

--- The CLI to run: $HEDGESYNC_CMD (a JSON list, set by `hedgesync edit` so the
--- bridge is the binary that started Neovim), else hedgesync on PATH.
local function default_cmd()
  local ok, cmd = pcall(vim.json.decode, vim.env.HEDGESYNC_CMD or "")
  if ok and type(cmd) == "table" and type(cmd[1]) == "string" then
    return cmd
  end
  return { "hedgesync" }
end

M.config = {
  -- Command that runs the hedgesync CLI.
  cmd = default_cmd(),
  -- Extra arguments for `hedgesync bridge` (e.g. { "--cookie", "..." }).
  args = {},
  -- Show other people's cursors.
  cursors = true,
  -- Delay before sending cursor moves (ms).
  cursor_debounce = 50,
}

local api = vim.api
local ns = api.nvim_create_namespace("hedgesync_cursors")
---@type table<integer, table>
local sessions = {}

local function notify(msg, level)
  vim.notify("hedgesync: " .. msg, level or vim.log.levels.INFO)
end

local function send(s, msg)
  if s.closed or not s.proc then
    return
  end
  local ok, err = pcall(function()
    s.proc:write(vim.json.encode(msg) .. "\n")
  end)
  if not ok then
    s.closed = true
    notify("bridge is gone: " .. tostring(err), vim.log.levels.ERROR)
  end
end

local function buf_size(buf)
  return api.nvim_buf_get_offset(buf, api.nvim_buf_line_count(buf))
end

local function is_cont(str, i)
  local b = str:byte(i)
  return b ~= nil and b >= 0x80 and b < 0xC0
end

--- Row and byte column of byte offset `off` in `text`.
local function rowcol(text, off)
  local row, start = 0, 1
  while true do
    local nl = text:find("\n", start, true)
    if not nl or nl > off then
      break
    end
    row, start = row + 1, nl + 1
  end
  return row, off - (start - 1)
end

--- Report what changed since the last snapshot as one change message.
---
--- on_bytes only marks the buffer dirty: for some commands (J, for one) it
--- fires before the buffer holds the new text, so the text is read here, once
--- the command is done, by diffing against a snapshot of the lines. Lua
--- interns strings, so unchanged lines compare in O(1).
local function flush(s)
  if not s.dirty then
    return
  end
  s.dirty = false
  local buf = s.buf
  if s.closed or not api.nvim_buf_is_valid(buf) then
    return
  end
  local old = s.lines
  local new = api.nvim_buf_get_lines(buf, 0, -1, false)
  local n_old, n_new = #old, #new
  -- Compare from the top: on_bytes rows are not trustworthy either (undo).
  local i = 0 -- 0-based first changed line
  while i < n_old and i < n_new and old[i + 1] == new[i + 1] do
    i = i + 1
  end
  local k = 0 -- unchanged lines at the end
  while k < n_old - i and k < n_new - i and old[n_old - k] == new[n_new - k] do
    k = k + 1
  end
  s.lines = new
  if i == n_old - k and i == n_new - k then
    return -- changed and changed back
  end
  -- The changed blocks, every line ending in "\n" (the on_bytes model).
  local o = table.concat(old, "\n", i + 1, n_old - k) .. (n_old - k > i and "\n" or "")
  local n = table.concat(new, "\n", i + 1, n_new - k) .. (n_new - k > i and "\n" or "")
  -- Narrow to the changed bytes, on UTF-8 character boundaries.
  local p, max = 0, math.min(#o, #n)
  while p < max and o:byte(p + 1) == n:byte(p + 1) do
    p = p + 1
  end
  while p > 0 and (is_cont(o, p + 1) or is_cont(n, p + 1)) do
    p = p - 1
  end
  local q = 0
  while q < max - p and o:byte(#o - q) == n:byte(#n - q) do
    q = q + 1
  end
  while q > 0 and is_cont(o, #o - q + 1) do
    q = q - 1
  end
  local srow, scol = rowcol(o, p)
  local erow, ecol = rowcol(o, #o - q)
  s.E = s.E + 1
  send(s, {
    t = "change",
    epoch = s.epoch,
    seen = s.R,
    sr = i + srow,
    sc = scol,
    oer = erow - srow,
    oec = erow == srow and ecol - scol or ecol,
    text = n:sub(p + 1, #n - q),
    size = buf_size(buf),
  })
  if not s.shared then
    vim.bo[buf].modified = false
  end
end

--- Apply text without reporting it back to the bridge.
local function apply(s, fn)
  local buf = s.buf
  local modifiable, readonly = vim.bo[buf].modifiable, vim.bo[buf].readonly
  s.applying = true
  -- Lift both, or Neovim warns "W10: Changing a readonly file" about our own write.
  vim.bo[buf].modifiable, vim.bo[buf].readonly = true, false
  local ok, err = pcall(fn)
  vim.bo[buf].modifiable, vim.bo[buf].readonly = modifiable, readonly
  s.applying = false
  if not s.shared then
    vim.bo[buf].modified = false -- nothing to save: the note is the file
  end
  s.lines = api.nvim_buf_get_lines(buf, 0, -1, false)
  return ok, err
end

local function set_modifiable(s)
  if s.shared and s.closed then
    -- Back to a plain file buffer.
    vim.bo[s.buf].modifiable, vim.bo[s.buf].readonly = true, false
    return
  end
  vim.bo[s.buf].modifiable = s.editable and not s.closed
  vim.bo[s.buf].readonly = not s.editable
end

local function update_status(s, state)
  s.state = state
  vim.b[s.buf].hedgesync_state = state
  vim.cmd.redrawstatus()
end

-- Remote cursors -----------------------------------------------------------

local hl_cache = {}

--- "#rgb" / "#rrggbb" (HedgeDoc sends both) as "#rrggbb", or nil.
local function normalize_color(color)
  local hex = type(color) == "string" and color:match("^#?(%x+)$")
  if hex and #hex == 3 then
    hex = hex:gsub(".", "%0%0")
  end
  return hex and #hex == 6 and ("#" .. hex:lower()) or nil
end

local function cursor_hl(color)
  color = normalize_color(color) or "#888888"
  local name = "HedgesyncCursor_" .. color:sub(2)
  if not hl_cache[name] then
    local r, g, b = tonumber(color:sub(2, 3), 16), tonumber(color:sub(4, 5), 16), tonumber(color:sub(6, 7), 16)
    local fg = (0.299 * r + 0.587 * g + 0.114 * b) > 140 and "#000000" or "#ffffff"
    api.nvim_set_hl(0, name, { bg = color, fg = fg })
    api.nvim_set_hl(0, name .. "Label", { fg = color, italic = true })
    hl_cache[name] = true
  end
  return name
end

local function draw_cursors(s, cursors)
  local buf = s.buf
  api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  if not M.config.cursors then
    return
  end
  local line_count = api.nvim_buf_line_count(buf)
  for _, c in ipairs(cursors) do
    if c.row and c.row < line_count then
      local line = api.nvim_buf_get_lines(buf, c.row, c.row + 1, false)[1] or ""
      local col = math.min(c.col, #line)
      local hl = cursor_hl(c.color or "#888888")
      local opts = {
        virt_text = { { " " .. c.name, hl .. "Label" } },
        virt_text_pos = "eol",
        priority = 200,
      }
      if col < #line then
        -- Highlight the character under the cursor (one UTF-8 character).
        local char_end = vim.str_byteindex(line, "utf-32", vim.str_utfindex(line, "utf-32", col) + 1, false)
        opts.end_col = char_end
        opts.hl_group = hl
      else
        opts.virt_text = { { " ", hl }, { " " .. c.name, hl .. "Label" } }
        opts.virt_text_pos = "overlay"
      end
      pcall(api.nvim_buf_set_extmark, buf, ns, c.row, col, opts)
    end
  end
end

-- Messages from the bridge -------------------------------------------------

-- Follow mode ------------------------------------------------------------

local follow_ns = api.nvim_create_namespace("hedgesync_follow")

local function stop_following(s, why)
  if not s.follow then
    return
  end
  local name = s.follow.name
  s.follow = nil
  vim.on_key(nil, follow_ns)
  if why then
    notify(("stopped following %s (%s)"):format(name, why))
  end
  if api.nvim_get_current_buf() == s.buf and s.send_cursor then
    s.send_cursor() -- visible again
  end
end

--- Move to the followed person's cursor (current window only), centring it
--- when it left the screen.
local function follow_update(s)
  local f = s.follow
  if not f then
    return
  end
  local who
  for _, c in ipairs(s.cursors or {}) do
    if c.id == f.id then
      who = c
    end
  end
  if not who then
    return stop_following(s, "they left")
  end
  if not who.row or api.nvim_get_current_buf() ~= s.buf then
    return
  end
  local win = api.nvim_get_current_win()
  local row = math.min(who.row + 1, api.nvim_buf_line_count(s.buf))
  pcall(api.nvim_win_set_cursor, win, { row, who.col or 0 })
  api.nvim_win_call(win, function()
    if row < vim.fn.line("w0") or row > vim.fn.line("w$") then
      vim.cmd("normal! zz")
    end
  end)
end

--- Follow someone's cursor: your view moves with it until you press a key.
---@param buf? integer
---@param name? string a name (or the start of one); nil: the only other person, else ask
function M.follow(buf, name)
  local s = M.session(buf)
  if not s then
    return notify("not a hedgesync buffer", vim.log.levels.WARN)
  end
  name = vim.trim(name or "")
  if s.follow and name == "" then
    return stop_following(s, "as asked")
  end
  local candidates = vim.tbl_filter(function(c)
    return name == "" or c.name:lower():find(name:lower(), 1, true) == 1
  end, s.cursors or {})
  local function start(c)
    s.follow = { id = c.id, name = c.name }
    -- While following, stay invisible: your cursor is theirs anyway.
    send(s, { t = "cursor", row = vim.NIL })
    vim.on_key(function(key)
      if api.nvim_get_mode().mode:sub(1, 1) == "c" or key == ":" then
        return -- running a command (:Hedge users) keeps following
      end
      vim.schedule(function()
        stop_following(s, "you moved")
      end)
    end, follow_ns)
    notify(("following %s; any key stops"):format(c.name))
    follow_update(s)
  end
  if #candidates == 0 then
    notify(name == "" and "nobody else is in this note" or ("nobody called " .. name .. " is here"), vim.log.levels.WARN)
  elseif #candidates == 1 then
    start(candidates[1])
  else
    vim.ui.select(candidates, {
      prompt = "Follow",
      format_item = function(c)
        return c.name .. (c.row and (" (line " .. (c.row + 1) .. ")") or "")
      end,
    }, function(c)
      if c then
        start(c)
      end
    end)
  end
end

--- Names of the others in the note, for completion.
function M.names(buf)
  local s = M.session(buf)
  return vim.tbl_map(function(c)
    return c.name
  end, s and s.cursors or {})
end

local function on_reset(s, msg)
  flush(s) -- dropped anyway (new epoch), but keeps the snapshot honest
  local buf = s.buf
  local first = not s.loaded
  if first and s.shared and table.concat(api.nvim_buf_get_lines(buf, 0, -1, false), "\n") == msg.text then
    -- Sharing a file buffer: the note was made from it, so leave the buffer
    -- (and its undo history and modified flag) alone.
    apply(s, function() end)
    s.epoch, s.E, s.R, s.loaded = msg.epoch, 0, msg.seq, true
    return
  end
  if first and s.shared then
    first = false -- an ordinary, undoable change to the user's file
  end
  local view = vim.fn.bufwinid(buf) ~= -1 and vim.fn.winsaveview() or nil
  local undolevels = vim.bo[buf].undolevels
  if first then
    vim.bo[buf].undolevels = -1 -- loading the note is not an undoable change
  end
  apply(s, function()
    local text = vim.split(msg.text, "\n", { plain = true })
    if first then
      -- Like reading a file: do not shift marks and quickfix entries that
      -- already point into the note (`:cfirst`, `+42`) by the inserted lines.
      vim.g._hedgesync_load = text
      api.nvim_buf_call(buf, function()
        vim.cmd("lockmarks call nvim_buf_set_lines(0, 0, -1, v:false, g:_hedgesync_load)")
      end)
      vim.g._hedgesync_load = nil
    else
      api.nvim_buf_set_lines(buf, 0, -1, false, text)
    end
  end)
  if first then
    vim.bo[buf].undolevels = undolevels
  end
  s.epoch, s.E, s.R, s.loaded = msg.epoch, 0, msg.seq, true
  if view and not first and api.nvim_get_current_buf() == buf then
    pcall(vim.fn.winrestview, view)
  end
  if first and s.goto_line then
    for _, win in ipairs(vim.fn.win_findbuf(buf)) do
      pcall(api.nvim_win_set_cursor, win, { math.min(s.goto_line, api.nvim_buf_line_count(buf)), 0 })
    end
    s.goto_line = nil
  end
end

local function on_edit(s, msg)
  flush(s) -- unreported local changes make this edit stale
  if msg.base ~= s.E then
    return -- typed something since; the bridge will resend this rebased
  end
  local ok, err = apply(s, function()
    for _, e in ipairs(msg.edits) do
      api.nvim_buf_set_text(s.buf, e.sr, e.sc, e.er, e.ec, vim.split(e.text, "\n", { plain = true }))
    end
  end)
  if not ok then
    notify("could not apply a remote edit (" .. tostring(err) .. "); resyncing", vim.log.levels.WARN)
    send(s, { t = "desync" })
    return
  end
  s.R = msg.seq
end

--- Why a bridge with protocol `theirs` cannot be used, and what to do.
local function protocol_problem(theirs, version)
  local fix = (theirs or 0) < M.protocol and "update the hedgesync CLI"
    or "run `hedgesync editor nvim install` to update this plugin"
  return ("hedgesync %s speaks editor protocol %s, this plugin speaks %d: %s"):format(
    version or "(unknown version)",
    tostring(theirs or "none"),
    M.protocol,
    fix
  )
end
M._protocol_problem = protocol_problem

local handlers = {
  ready = function(s, msg)
    if msg.protocol ~= M.protocol then
      notify(protocol_problem(msg.protocol, msg.version), vim.log.levels.ERROR)
      M.close(s.buf)
      return
    end
    s.editable = msg.editable
    s.title = msg.title
    vim.b[s.buf].hedgesync_title = msg.title
    set_modifiable(s)
    update_status(s, "connected")
    if not msg.editable then
      notify("read-only, " .. (msg.reason or "you cannot edit this note"), vim.log.levels.WARN)
    end
  end,
  note = function(s, msg)
    s.title = msg.title
    vim.b[s.buf].hedgesync_title = msg.title
    if msg.editable ~= s.editable then
      s.editable = msg.editable
      set_modifiable(s)
      notify(
        msg.editable and "note is editable again" or ("now read-only, " .. (msg.reason or "you cannot edit this note")),
        vim.log.levels.WARN
      )
    end
  end,
  reset = on_reset,
  edit = on_edit,
  cursors = function(s, msg)
    s.cursors = msg.cursors
    draw_cursors(s, msg.cursors)
    follow_update(s)
  end,
  status = function(s, msg)
    if msg.state == "desync" then
      notify(msg.message or "buffer resynchronised", vim.log.levels.WARN)
    else
      if msg.state == "disconnected" then
        notify("offline; edits sync when reconnected", vim.log.levels.WARN)
      elseif msg.state == "connected" and s.state ~= "connected" then
        notify("reconnected")
      end
      update_status(s, msg.state)
    end
  end,
  error = function(s, msg)
    notify(msg.message, vim.log.levels.ERROR)
  end,
}

local function dispatch(s, line)
  local ok, msg = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
  if not ok or type(msg) ~= "table" then
    return
  end
  local handler = handlers[msg.t]
  if handler and api.nvim_buf_is_valid(s.buf) then
    handler(s, msg)
  end
end

-- Buffer events ------------------------------------------------------------

local function attach(s)
  api.nvim_buf_attach(s.buf, false, {
    on_bytes = function()
      if s.closed then
        return true -- detach
      end
      if s.applying or not s.loaded then
        return
      end
      if not s.dirty then
        s.dirty = true
        vim.schedule(function()
          flush(s)
        end)
      end
    end,
    on_detach = function()
      s.closed = true
    end,
  })

  local group = api.nvim_create_augroup("hedgesync_buf_" .. s.buf, { clear = true })
  local timer = vim.uv.new_timer()
  s.cursor_timer = timer
  local function send_cursor()
    if not s.loaded or api.nvim_get_current_buf() ~= s.buf or s.follow then
      return
    end
    flush(s)
    local pos = api.nvim_win_get_cursor(0)
    send(s, { t = "cursor", epoch = s.epoch, seen = s.R, row = pos[1] - 1, col = pos[2] })
  end
  api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
    group = group,
    buffer = s.buf,
    callback = function()
      timer:stop()
      timer:start(M.config.cursor_debounce, 0, vim.schedule_wrap(send_cursor))
    end,
  })
  s.send_cursor = send_cursor
  api.nvim_create_autocmd("BufEnter", { group = group, buffer = s.buf, callback = send_cursor })
  api.nvim_create_autocmd("BufLeave", {
    group = group,
    buffer = s.buf,
    callback = function()
      stop_following(s, "you left the buffer")
      send(s, { t = "cursor", row = vim.NIL })
    end,
  })
  if not s.shared then -- a shared file saves to disk as usual
    api.nvim_create_autocmd("BufWriteCmd", {
      group = group,
      buffer = s.buf,
      callback = function()
        vim.bo[s.buf].modified = false
        notify(s.state == "connected" and "changes are synced live" or ("not connected (" .. tostring(s.state) .. ")"))
      end,
    })
  end
  api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
    group = group,
    buffer = s.buf,
    callback = function()
      M.close(s.buf)
    end,
  })
end

-- Public API ---------------------------------------------------------------

--- hedgedoc://host/id -> https://host/id (http for localhost)
function M.http_url(url)
  url = vim.trim(url or "")
  if url:match("^hedgedoc://") then
    local rest = url:gsub("^hedgedoc://", "")
    local scheme = (rest:match("^localhost") or rest:match("^127%.")) and "http://" or "https://"
    return scheme .. rest
  end
  return url
end

--- The buffer name for a note: https://host/id -> hedgedoc://host/id
local function buf_name(url)
  return "hedgedoc://" .. url:gsub("^https?://", "")
end
M.buf_name = buf_name

--- Open a note for live editing in the current window. Returns the buffer.
--- Open a note for live editing in a buffer.
---@param url string note URL (https://... or hedgedoc://...)
---@param opts? { line?: integer, buf?: integer, wait?: integer }
---  line: put the cursor there once the note is loaded
---  buf: load into this buffer in place (BufReadCmd); no window changes
---  wait: block up to this many ms until the note is loaded, like reading a file
function M.open(url, opts)
  opts = opts or {}
  url = M.http_url(url)
  -- https://host/id?edit#ft=lua: a shared file's link; the filetype is a hint.
  local filetype = url:match("#.*ft=([%w_.-]+)")
  url = url:gsub("#.*$", ""):gsub("%?.*$", "")
  if url == "" then
    notify("usage: :Hedge open <note url>", vim.log.levels.ERROR)
    return
  end
  for buf, s in pairs(sessions) do
    if s.url == url and api.nvim_buf_is_valid(buf) then
      api.nvim_set_current_buf(buf)
      if opts.line then
        pcall(api.nvim_win_set_cursor, 0, { opts.line, 0 })
      end
      return buf
    end
  end

  local prev = api.nvim_get_current_buf()
  local name = buf_name(url)
  if opts.share then
    return M._start(url, opts.share, { shared = true })
  end
  local buf = opts.buf
  if not buf then
    for _, b in ipairs(api.nvim_list_bufs()) do
      if api.nvim_buf_get_name(b) == name then
        buf = b
      end
    end
  end
  if not buf or not api.nvim_buf_is_valid(buf) then
    buf = api.nvim_create_buf(true, false)
    api.nvim_buf_set_name(buf, name)
  end
  vim.bo[buf].buftype = "acwrite"
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = filetype or "markdown"
  if not opts.buf then
    api.nvim_set_current_buf(buf)
  end
  -- Replace the empty buffer Neovim starts with (`hedgesync edit`, a fresh :Hedge open).
  if
    not opts.buf
    and prev ~= buf
    and api.nvim_buf_get_name(prev) == ""
    and vim.bo[prev].buftype == ""
    and not vim.bo[prev].modified
    and api.nvim_buf_line_count(prev) == 1
    and api.nvim_buf_get_lines(prev, 0, 1, false)[1] == ""
  then
    pcall(api.nvim_buf_delete, prev, {})
  end

  return M._start(url, buf, { goto_line = opts.line, wait = opts.wait })
end

--- Start syncing `buf` with the note at `url`.
---@param extra { goto_line?: integer, wait?: integer, shared?: boolean }
function M._start(url, buf, extra)
  local s = {
    shared = extra.shared,
    buf = buf,
    url = url,
    E = 0,
    R = 0,
    epoch = 0,
    loaded = false,
    editable = false,
    state = "connecting",
    lines = {},
    goto_line = extra.goto_line,
  }
  sessions[buf] = s
  update_status(s, "connecting")
  attach(s)

  local cmd = vim.list_extend(vim.list_extend(vim.deepcopy(M.config.cmd), { "bridge", url }), M.config.args)
  local pending = ""
  local stderr = {}
  local ok, proc = pcall(vim.system, cmd, {
    stdin = true,
    stdout = function(_, data)
      if not data then
        return
      end
      pending = pending .. data
      local lines = vim.split(pending, "\n", { plain = true })
      pending = table.remove(lines)
      for _, line in ipairs(lines) do
        if line ~= "" then
          vim.schedule(function()
            dispatch(s, line)
          end)
        end
      end
    end,
    stderr = function(_, data)
      if data then
        table.insert(stderr, data)
      end
    end,
  }, function(result)
    vim.schedule(function()
      local was_closed = s.closed
      s.closed = true
      s.proc = nil
      if api.nvim_buf_is_valid(buf) then
        set_modifiable(s)
        update_status(s, "closed")
        api.nvim_buf_clear_namespace(buf, ns, 0, -1)
      end
      if not was_closed and result.code ~= 0 then
        local err = vim.trim(table.concat(stderr))
        if err:find("Unknown command: bridge", 1, true) then
          notify("your hedgesync CLI is too old for this plugin (no `bridge` command); update it", vim.log.levels.ERROR)
          return
        end
        notify("bridge exited (" .. result.code .. ")" .. (err ~= "" and (":\n" .. err) or ""), vim.log.levels.ERROR)
      end
    end)
  end)
  if not ok then
    sessions[buf] = nil
    notify("could not start " .. table.concat(cmd, " ") .. ": " .. tostring(proc), vim.log.levels.ERROR)
    return
  end
  s.proc = proc
  if extra.wait then
    vim.wait(extra.wait, function()
      return s.loaded or s.closed
    end, 10)
  end
  return buf
end

--- Stop syncing a buffer (edits made so far are flushed by the bridge).
function M.close(buf)
  buf = (buf == nil or buf == 0) and api.nvim_get_current_buf() or buf
  local s = sessions[buf]
  if not s then
    return
  end
  stop_following(s)
  sessions[buf] = nil
  if s.cursor_timer then
    s.cursor_timer:stop()
    s.cursor_timer:close()
  end
  if s.proc and not s.closed then
    flush(s)
    send(s, { t = "close" })
    pcall(function()
      s.proc:write(nil)
    end)
  end
  s.closed = true
  if api.nvim_buf_is_valid(buf) then
    pcall(api.nvim_buf_clear_namespace, buf, ns, 0, -1)
    pcall(api.nvim_del_augroup_by_name, "hedgesync_buf_" .. buf)
    if s.shared then
      vim.bo[buf].modifiable, vim.bo[buf].readonly = true, false
      notify("stopped sharing")
    else
      vim.bo[buf].modifiable = false
    end
  end
end

--- Close all sessions and wait (briefly) for the bridges to flush.
function M.close_all(timeout)
  local procs = {}
  for buf, s in pairs(sessions) do
    if s.proc then
      table.insert(procs, s.proc)
    end
    M.close(buf)
  end
  for _, proc in ipairs(procs) do
    pcall(function()
      proc:wait(timeout or 3000)
    end)
  end
end

--- Session for a buffer (for statuslines and tests).
--- Every open note session, by buffer.
function M.sessions()
  return sessions
end

function M.session(buf)
  return sessions[(buf == nil or buf == 0) and api.nvim_get_current_buf() or buf]
end

--- Short status for statuslines, e.g. "● connected".
function M.status(buf)
  local s = M.session(buf)
  if not s then
    return ""
  end
  local icon = ({ connected = "●", connecting = "◌", reconnecting = "◌", disconnected = "○", closed = "×" })[s.state]
    or "?"
  return icon .. " " .. tostring(s.state) .. (s.follow and (" · following " .. s.follow.name) or "")
end

function M.users(buf)
  local s = M.session(buf)
  if not s then
    notify("not a hedgesync buffer", vim.log.levels.WARN)
    return
  end
  local names = {}
  for _, c in ipairs(s.cursors or {}) do
    table.insert(names, c.row and ("%s (line %d)"):format(c.name, c.row + 1) or c.name)
  end
  notify(#names > 0 and ("also here: " .. table.concat(names, ", ")) or "nobody else is in this note")
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
end

return M
