local kumo = require 'kumo'

local USERS_FILE = '/opt/kumomta/etc/policy/users.lua'
local ACCOUNT_NAME = '^[%w%._%-]+$'

local function lowercase_list(list)
  local out = {}
  if type(list) == 'table' then
    for _, item in ipairs(list) do
      if type(item) == 'string' and item ~= '' then
        table.insert(out, item:lower())
      end
    end
  end
  return out
end

local function to_set(list)
  if type(list) ~= 'table' or #list == 0 then
    return nil
  end
  local set = {}
  for _, item in ipairs(list) do
    set[item] = true
  end
  return set
end

local function parse_webhook(webhook)
  if webhook == nil then
    return nil, nil
  end
  if type(webhook) ~= 'table' or type(webhook.url) ~= 'string' or webhook.url == '' then
    return nil, 'webhook.url is missing'
  end
  if type(webhook.secret) ~= 'string' or webhook.secret == '' then
    return nil, 'webhook.secret is missing'
  end
  return {
    url = webhook.url,
    secret = webhook.secret,
    events = to_set(webhook.events),
  }
end

local function load_accounts(path)
  local ok, raw = pcall(dofile, path)
  if not ok or type(raw) ~= 'table' then
    kumo.log_error('relay: cannot load ' .. path .. ': ' .. tostring(raw))
    return {}
  end

  local accounts = {}
  for name, entry in pairs(raw) do
    local webhook, problem = nil, nil
    local domains = type(entry) == 'table' and lowercase_list(entry.domains) or {}

    if type(name) ~= 'string' or not name:match(ACCOUNT_NAME) then
      problem = 'name may only use letters, digits, ".", "_" and "-"'
    elseif type(entry) ~= 'table' or type(entry.password) ~= 'string' or entry.password == '' then
      problem = 'password is missing'
    elseif #domains == 0 then
      problem = 'domains is empty'
    else
      webhook, problem = parse_webhook(entry.webhook)
    end

    if problem then
      kumo.log_error(string.format('relay: account %s disabled: %s', tostring(name), problem))
    else
      accounts[name] = {
        password = entry.password,
        domains = domains,
        webhook = webhook,
      }
    end
  end
  return accounts
end

local cached_accounts = kumo.memoize(load_accounts, {
  name = 'relay_accounts',
  ttl = '1 minute',
  capacity = 1,
})

local M = {}

function M.get(name)
  if type(name) ~= 'string' then
    return nil
  end
  return cached_accounts(USERS_FILE)[name]
end

function M.verify(name, password)
  local account = M.get(name)
  return account ~= nil and password ~= '' and account.password == password
end

function M.allows_domain(account, domain)
  if not account or type(domain) ~= 'string' or domain == '' then
    return false
  end
  domain = domain:lower()
  for _, allowed in ipairs(account.domains) do
    if domain == allowed or domain:sub(-(#allowed + 1)) == '.' .. allowed then
      return true
    end
  end
  return false
end

return M
