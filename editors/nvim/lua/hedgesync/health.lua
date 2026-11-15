-- :checkhealth hedgesync
local M = {}

local function run(cmd, args)
  local ok, proc = pcall(vim.system, vim.list_extend(vim.deepcopy(cmd), args), { text = true })
  if not ok then
    return nil, tostring(proc)
  end
  local result = proc:wait(15000)
  if result.code ~= 0 then
    return nil, vim.trim((result.stderr or "") .. (result.stdout or ""))
  end
  return result.stdout
end

local function read_json(path)
  local f = io.open(path, "r")
  if not f then
    return nil
  end
  local ok, data = pcall(vim.json.decode, f:read("*a"))
  f:close()
  return ok and data or nil
end

function M.check()
  local h = vim.health
  local hs = require("hedgesync")
  local cmd = hs.config.cmd

  h.start("hedgesync.nvim")
  if vim.fn.has("nvim-0.11") == 1 then
    h.ok("Neovim " .. tostring(vim.version()))
  else
    h.error("Neovim 0.11 or newer is required, this is " .. tostring(vim.version()))
  end

  if vim.fn.executable(cmd[1]) ~= 1 then
    h.error(("`%s` is not on PATH"):format(cmd[1]), {
      "Install the hedgesync CLI from https://github.com/tionis/hedgesync/releases (or `npm i -g hedgesync`)",
      "or point `cmd` in require('hedgesync').setup() at it",
    })
    return
  end

  local out, err = run(cmd, { "bridge", "--info" })
  local info = out and pcall(vim.json.decode, out) and vim.json.decode(out) or nil
  if not info then
    h.error("`" .. table.concat(cmd, " ") .. "` has no editor bridge (too old?)", { "Update the hedgesync CLI", err })
    return
  end
  if info.protocol == hs.protocol then
    h.ok(("hedgesync %s (%s), editor protocol %d"):format(info.version, vim.fn.exepath(cmd[1]), info.protocol))
  else
    h.error(hs._protocol_problem(info.protocol, info.version))
  end

  local marker = read_json(hs.root .. "/.hedgesync-install.json")
  if not marker then
    h.info("Plugin loaded from " .. hs.root .. " (not installed by `hedgesync editor nvim install`)")
  elseif marker.version == info.version then
    h.ok("Plugin installed by hedgesync " .. marker.version .. " in " .. hs.root)
  else
    h.warn(
      ("Plugin was installed by hedgesync %s, the CLI is %s"):format(tostring(marker.version), info.version),
      { "Run `hedgesync editor nvim install` to update the plugin" }
    )
  end

  h.start("hedgesync logins")
  local sessions_out = run(cmd, { "sessions", "--json" })
  local ok, data = pcall(vim.json.decode, sessions_out or "")
  local sessions = ok and type(data) == "table" and data.sessions or nil
  if sessions == nil then
    h.warn("Could not list saved logins (`hedgesync sessions --json` failed)")
  elseif #sessions == 0 then
    h.warn("No saved logins; notes that need an account will be read-only or refused", {
      "Run `hedgesync login <server> --from-browser firefox --save` (or `-u <user>` for email/LDAP)",
    })
  else
    for _, s in ipairs(sessions) do
      local who = type(s.user) == "table" and s.user.name or s.user
      h.ok(("%s%s"):format(s.server, who and (" as " .. tostring(who)) or ""))
    end
  end

  h.start("hedgesync sessions in this Neovim")
  local any = false
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    local s = hs.session(buf)
    if s then
      any = true
      h.info(("%s: %s"):format(s.url, hs.status(buf)))
    end
  end
  if not any then
    h.info("No notes open")
  end
end

return M
