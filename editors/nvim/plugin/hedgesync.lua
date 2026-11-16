if vim.g.loaded_hedgesync then
  return
end
vim.g.loaded_hedgesync = true

local function ui()
  return require("hedgesync.ui")
end

local subcommands = {
  open = function(args)
    require("hedgesync").open(args)
  end,
  browse = function(args)
    ui().browse(args)
  end,
  find = function(args)
    ui().find(args)
  end,
  new = function(args, opts)
    local lines
    if opts.range > 0 then
      lines = vim.api.nvim_buf_get_lines(0, opts.line1 - 1, opts.line2, false)
    end
    ui().new({ title = args ~= "" and args or nil, lines = lines })
  end,
  search = function(args)
    ui().search(args)
  end,
  revisions = function()
    ui().revisions()
  end,
  url = function(args)
    ui().url(args)
  end,
  share = function(args)
    ui().share(args)
  end,
  close = function()
    require("hedgesync").close(0)
  end,
  follow = function(args)
    require("hedgesync").follow(0, args)
  end,
  users = function()
    require("hedgesync").users(0)
  end,
  status = function()
    vim.notify(require("hedgesync").status(0))
  end,
}

local usage = table.concat({
  "usage: :Hedge <command>",
  "  open <url>        edit a note live (or :e hedgedoc://host/id)",
  "  browse [server]   your notes: open, pin, create, revisions",
  "  find [server]     pick a note with vim.ui.select",
  "  new [title]       create a note and open it (with a range: from those lines)",
  "  search <text>     search your notes' text into the quickfix list",
  "  revisions         this note's revisions: view, diff, restore",
  "  url [publish|slide]  copy this note's URL",
  "  share [permission]  share this file live: others join from the copied link",
  "  follow [name]     your view follows their cursor (any key stops; again to stop)",
  "  users | status | close",
}, "\n")

vim.api.nvim_create_user_command("Hedge", function(opts)
  local sub, rest = opts.args:match("^(%S+)%s*(.*)$")
  local fn = subcommands[sub or ""]
  if not fn then
    vim.notify(usage, sub and vim.log.levels.ERROR or vim.log.levels.INFO)
    return
  end
  fn(rest, opts)
end, {
  nargs = "*",
  range = true,
  complete = function(arglead, line)
    if line:match("^%S+%s+%S*$") then
      local names = vim.tbl_keys(subcommands)
      table.sort(names)
      return vim.tbl_filter(function(name)
        return name:find(arglead, 1, true) == 1
      end, names)
    end
    if line:match("^%S+%s+follow%s+%S*$") then
      return vim.tbl_filter(function(name)
        return name:lower():find(arglead:lower(), 1, true) == 1
      end, require("hedgesync").names(0))
    end
    if line:match("^%S+%s+share%s+%S*$") then
      return vim.tbl_filter(function(name)
        return name:find(arglead, 1, true) == 1
      end, { "freely", "editable", "limited", "locked", "protected", "private" })
    end
    if line:match("^%S+%s+url%s+%S*$") then
      return vim.tbl_filter(function(name)
        return name:find(arglead, 1, true) == 1
      end, { "edit", "publish", "slide" })
    end
    return {}
  end,
})

-- :e hedgedoc://md.example.com/abc123 (also `nvim hedgedoc://...`, quickfix
-- entries, jumps)
vim.api.nvim_create_autocmd("BufReadCmd", {
  pattern = "hedgedoc://*",
  callback = function(ev)
    local hs = require("hedgesync")
    if hs.session(ev.buf) then
      return
    end
    local name = vim.api.nvim_buf_get_name(ev.buf)
    if name == hs.buf_name(hs.http_url(name)) then
      -- Read it like a file: load into this buffer and wait for the text, so
      -- `+42`, quickfix line numbers and marks land where they should.
      hs.open(name, { buf = ev.buf, wait = 10000 })
      return
    end
    local buf = ev.buf
    vim.schedule(function()
      hs.open(name)
      -- open() created or reused its own buffer; drop the placeholder.
      if vim.api.nvim_buf_is_valid(buf) and not hs.session(buf) then
        pcall(vim.api.nvim_buf_delete, buf, { force = true })
      end
    end)
  end,
})

vim.api.nvim_create_autocmd("VimLeavePre", {
  callback = function()
    if package.loaded["hedgesync"] then
      require("hedgesync").close_all(3000)
    end
  end,
})
