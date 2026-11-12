local kumo = require 'kumo'
local shaping = require 'policy-extras.shaping'

local POOL = 'relay-pool'
local EHLO_DOMAIN = os.getenv 'KUMOMTA_HOSTNAME' or 'relay.example.com'
local EXTRA_SHAPING = '/opt/kumomta/etc/policy/shaping.toml'

local SMARTHOST = os.getenv 'RELAY_SMARTHOST'
if SMARTHOST == '' then
  SMARTHOST = nil
end

local sources = {}
for ip in (os.getenv 'KUMOMTA_SOURCE_IPS' or ''):gmatch '[^,%s]+' do
  table.insert(sources, { name = 'relay-' .. (#sources + 1), ip = ip })
end
if #sources == 0 then
  print '[relay] KUMOMTA_SOURCE_IPS not set: sending from the default route'
  sources = { { name = 'relay-default' } }
end

kumo.on('get_egress_pool', function(pool_name)
  if pool_name ~= POOL then
    return nil
  end
  local entries = {}
  for _, src in ipairs(sources) do
    table.insert(entries, { name = src.name })
  end
  return kumo.make_egress_pool {
    name = POOL,
    entries = entries,
  }
end)

kumo.on('get_egress_source', function(source_name)
  for _, src in ipairs(sources) do
    if src.name == source_name then
      return kumo.make_egress_source {
        name = src.name,
        source_address = src.ip,
        ehlo_domain = EHLO_DOMAIN,
      }
    end
  end
end)

local function file_exists(path)
  local f = io.open(path, 'r')
  if f then
    f:close()
    return true
  end
  return false
end

local shaped_path = shaping:setup(file_exists(EXTRA_SHAPING) and { EXTRA_SHAPING } or {})

local smarthost_path = nil
if SMARTHOST then
  local user = os.getenv 'RELAY_SMARTHOST_USER'
  local tls = os.getenv 'RELAY_SMARTHOST_TLS' or 'Required'
  smarthost_path = {
    smtp_port = tonumber(os.getenv 'RELAY_SMARTHOST_PORT') or 587,
    enable_tls = tls,
    connection_limit = tonumber(os.getenv 'RELAY_SMARTHOST_CONNECTIONS') or 10,
  }
  if user and user ~= '' then
    smarthost_path.smtp_auth_plain_username = user
    smarthost_path.smtp_auth_plain_password = { key_data = os.getenv 'RELAY_SMARTHOST_PASS' or '' }
    if tls:match 'Insecure$' then
      smarthost_path.allow_smtp_auth_plain_without_valid_certificate = true
    end
  end
  print(string.format('[relay] delivering via smarthost %s:%d (tls=%s)', SMARTHOST, smarthost_path.smtp_port, tls))
end

kumo.on('get_egress_path_config', function(routing_domain, egress_source, site_name)
  if smarthost_path then
    return kumo.make_egress_path(smarthost_path)
  end
  return shaped_path(routing_domain, egress_source, site_name)
end)
