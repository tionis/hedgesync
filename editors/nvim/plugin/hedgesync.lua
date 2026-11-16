if vim.g.loaded_hedgesync then
  return
end
vim.g.loaded_hedgesync = true

local subcommands = {
  open = function(args)
    require("hedgesync").open(args)
  end,
  close = function()
    require("hedgesync").close(0)
  end,
  users = function()
    require("hedgesync").users(0)
  end,
  status = function()
    vim.notify(require("hedgesync").status(0))
  end,
}

vim.api.nvim_create_user_command("Hedge", function(opts)
  local sub, rest = opts.args:match("^(%S+)%s*(.*)$")
  local fn = subcommands[sub or ""]
  if not fn then
    vim.notify("usage: :Hedge open <url> | close | users | status", vim.log.levels.ERROR)
    return
  end
  fn(rest)
end, {
  nargs = "*",
  complete = function(arglead, line)
    if line:match("^%S+%s+%S*$") then
      return vim.tbl_filter(function(name)
        return name:find(arglead, 1, true) == 1
      end, vim.tbl_keys(subcommands))
    end
    return {}
  end,
})

-- :e hedgedoc://md.example.com/abc123
vim.api.nvim_create_autocmd("BufReadCmd", {
  pattern = "hedgedoc://*",
  callback = function(ev)
    local hs = require("hedgesync")
    if hs.session(ev.buf) then
      return
    end
    local name = vim.api.nvim_buf_get_name(ev.buf)
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
