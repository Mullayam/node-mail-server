-- ================= EGRESS CONFIG =================
-- Defines egress sources (IPs) and pools for outbound delivery
-- Docs: https://docs.kumomta.com/reference/kumo/make_egress_pool/
--       https://docs.kumomta.com/reference/kumo/make_egress_source/
-- ================================================================
local kumo = require 'kumo'

-- Parse comma-separated IPs from env into a table
local function parse_ips(env_val)
  local ips = {}
  for ip in (env_val or ''):gmatch('[^,]+') do
    local trimmed = ip:match('^%s*(.-)%s*$')
    if trimmed ~= '' then
      table.insert(ips, trimmed)
    end
  end
  return ips
end

local SOURCE_IPS = parse_ips(os.getenv('KUMOMTA_SOURCE_IPS'))
local EHLO_DOMAIN = os.getenv('KUMOMTA_HOSTNAME') or 'mail.enjoys.in'

-- Build source names from IPs
local source_entries = {}
for i, ip in ipairs(SOURCE_IPS) do
  local name = string.format('source-%d', i)
  table.insert(source_entries, { name = name, ip = ip })
end

-- Fallback if no IPs configured
if #source_entries == 0 then
  print('[kumo] KUMOMTA_SOURCE_IPS not set — using default egress (0.0.0.0)')
  source_entries = { { name = 'fallback', ip = '0.0.0.0' } }
end

-- Register egress pool handler
kumo.on('get_egress_pool', function(pool_name)
  if pool_name == 'main-pool' then
    local entries = {}
    for _, src in ipairs(source_entries) do
      table.insert(entries, { name = src.name })
    end
    return kumo.make_egress_pool {
      name = 'main-pool',
      entries = entries,
    }
  end
end)

-- Register egress source handler
kumo.on('get_egress_source', function(source_name)
  for _, src in ipairs(source_entries) do
    if source_name == src.name then
      return kumo.make_egress_source {
        name = src.name,
        source_address = src.ip,
        ehlo_domain = EHLO_DOMAIN,
      }
    end
  end
end)