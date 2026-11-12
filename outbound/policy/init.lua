-- ================================================================
-- KumoMTA — Relay + Delivery MTA
-- Role: Accept from trusted IPs → DKIM sign → Deliver outbound
-- ================================================================
local kumo = require 'kumo'
local listener_domains = require 'policy-extras.listener_domains'
-- local queue_module = require 'policy-extras.queue'
-- local queue_helper =  queue_module:setup { '/opt/kumomta/etc/policy/queues.toml' }
local webhook = require 'webhook'
require 'egress'

-- Webhook setup MUST appear before queue config (per KumoMTA docs)
webhook.setup_webhook()

require 'queue'

local use_relay = os.getenv("USE_RELAY") or "true"
local dkim = nil

if use_relay == "true" then
  dkim = require "dkim"
  print("[kumo] DKIM module loaded and active")
else
  print("[kumo] Relay mode — DKIM signing disabled")
end

-- ================= INIT =================
kumo.on('init', function()

  -- SMTP RELAY LISTENER (587 AUTH REQUIRED)
  kumo.start_esmtp_listener {
    listen = '0.0.0.0:587',
    hostname = os.getenv('KUMOMTA_HOSTNAME') or 'mail.enjoys.in',
    banner = "ESMTP Welcome to ENJOYS Mail Server",
    relay_hosts = {
      '127.0.0.1',
      '::1',
      '10.0.0.0/8',
      '172.16.0.0/12',   -- Docker bridge
      '192.168.0.0/16',
    }
  }

  -- HTTP (for metrics / API)
  kumo.start_http_listener {
    listen = '127.0.0.1:8000',
  }

  -- Spool definitions
  kumo.define_spool {
    name = 'data',
    path = '/var/spool/kumomta/data',
  }

  kumo.define_spool {
    name = 'meta',
    path = '/var/spool/kumomta/meta',
  }

  -- Logging
  kumo.configure_local_logs {
    log_dir = '/var/log/kumomta',
    max_segment_duration = '30s',
  }



end)

-- ================= AUTH =================
kumo.on('smtp_server_auth_plain', function(authzid, authcid, password, conn)
  local users = dofile('/opt/kumomta/etc/policy/users.lua')

  if users[authcid] and users[authcid] == password then
    conn:set_meta('authenticated', true)
    conn:set_meta('auth_user', authcid)
    return true
  end
  return false
end)

kumo.on('smtp_server_mail_from', function(sender, conn)

  if use_relay == "false" then
    return 
  end

  local allowed_domains = dofile('/opt/kumomta/etc/policy/domains.lua')

  -- Must be authenticated
  if not conn:get_meta('authenticated') then
    return kumo.reject(550, "5.7.1 Authentication required")
  end

  -- Extract domain
  local domain = (sender.domain or ""):lower()

  if not allowed_domains[domain] then
    return kumo.reject(550, "5.7.1 Sender domain not allowed")
  end

  return
end)

kumo.on('smtp_server_rcpt_to', function(rcpt, conn)

  -- Allow if authenticated
  if conn:get_meta('authenticated') then
    return
  end

  return kumo.reject(550, "5.7.1 Authentication required")
end)

-- Processing of incoming messages via SMTP
kumo.on('smtp_server_message_received', function(msg)
  if msg:recipient().domain == 'mailbounce.mail.enjoys.in' then
    -- Re-route the message to the intended destination
    msg:set_meta('routing_domain', '[192.168.1.100]')
 
  end
  if dkim then
    dkim.sign(msg)
  end
  -- queue_helper:apply(msg)


end)

-- Processing of incoming messages via HTTP
kumo.on('http_message_generated', function(msg)
  -- Call the queue helper to set up the queue for the message.
  -- queue_helper:apply(msg)
  -- SIGNING MUST COME LAST OR YOU COULD BREAK YOUR DKIM SIGNATURES
  if dkim then
    dkim.sign(msg)
  end
end)

kumo.on(
  'get_listener_domain',
  listener_domains:setup { '/opt/kumomta/etc/policy/listener_domains.toml' }
)