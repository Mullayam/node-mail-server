-- ================================================================
-- QUEUE CONFIG — per-domain retry and pool settings
-- Note: connection_limit, max_deliveries_per_connection, enable_tls,
-- smtp_port belong in traffic shaping (get_egress_path_config), NOT here.
-- Valid fields: retry_interval, max_retry_interval, max_age, egress_pool,
-- max_message_rate, protocol, strategy, provider_name
-- ================================================================
local kumo = require 'kumo'

kumo.on('get_queue_config', function(domain, tenant, campaign, routing_domain)
    local limits = {
    ['gmail.com']      = { rate = '200/min', conns = 10, per_conn = 25 },
    ['googlemail.com'] = { rate = '200/min', conns = 10, per_conn = 25 },
    ['yahoo.com']      = { rate = '100/min', conns =  5, per_conn = 10 },
    ['ymail.com']      = { rate = '100/min', conns =  5, per_conn = 10 },
    ['outlook.com']    = { rate =  '60/min', conns =  3, per_conn = 10 },
    ['hotmail.com']    = { rate =  '60/min', conns =  3, per_conn = 10 },
    ['live.com']       = { rate =  '60/min', conns =  3, per_conn = 10 },
    ['msn.com']        = { rate =  '60/min', conns =  3, per_conn = 10 },
  }

  local cfg = limits[domain] or { rate = '300/min', conns = 15, per_conn = 50 }
  return kumo.make_queue_config {
    egress_pool        = 'main-pool',
    max_message_rate   = cfg.rate,
    retry_interval     = '1 min',
    max_retry_interval = '4 hours',
    max_age            = '24 hours',
  }
end)