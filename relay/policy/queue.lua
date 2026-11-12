local kumo = require 'kumo'

local SMARTHOST = os.getenv 'RELAY_SMARTHOST'
if SMARTHOST == '' then
  SMARTHOST = nil
end

local RETRY_INTERVAL = os.getenv 'RELAY_RETRY_INTERVAL' or '1m'
local MAX_RETRY_INTERVAL = os.getenv 'RELAY_MAX_RETRY_INTERVAL' or '4h'
local MAX_AGE = os.getenv 'RELAY_MAX_AGE' or '24h'

kumo.on('get_queue_config', function(domain, tenant, campaign, routing_domain)
  if domain:match '%.log_hook$' then
    return
  end

  local params = {
    egress_pool = 'relay-pool',
    retry_interval = RETRY_INTERVAL,
    max_retry_interval = MAX_RETRY_INTERVAL,
    max_age = MAX_AGE,
  }
  if SMARTHOST then
    params.protocol = { smtp = { mx_list = { SMARTHOST } } }
  end

  return kumo.make_queue_config(params)
end)
