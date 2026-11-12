local kumo = require 'kumo'
local utils = require 'policy-extras.policy_utils'
local accounts = require 'accounts'
local webhook = require 'webhook'
local trace = require 'trace'
local dkim = require 'dkim'

-- webhook must register its get_queue_config handler before queue.lua's catch-all
webhook.setup()
require 'egress'
require 'queue'

local HOSTNAME = os.getenv 'KUMOMTA_HOSTNAME' or 'relay.example.com'
local LISTEN = os.getenv 'RELAY_LISTEN' or '0.0.0.0:2587'
local TLS_CERT = os.getenv 'RELAY_TLS_CERT'
local TLS_KEY = os.getenv 'RELAY_TLS_KEY'

local REPLY = {
  AUTH_REQUIRED = '5.7.0 Authentication required',
  SENDER_NOT_ALLOWED = '5.7.1 Sender domain is not allowed for this account',
  FROM_NOT_ALLOWED = '5.7.1 From must be a single address in a domain allowed for this account',
}

kumo.on('init', function()
  local listener = {
    listen = LISTEN,
    hostname = HOSTNAME,
  }
  if TLS_CERT and TLS_KEY then
    listener.tls_certificate = TLS_CERT
    listener.tls_private_key = TLS_KEY
  end
  kumo.start_esmtp_listener(listener)

  kumo.start_http_listener {
    listen = '127.0.0.1:8000',
  }

  kumo.define_spool {
    name = 'data',
    path = '/var/spool/kumomta/data',
  }

  kumo.define_spool {
    name = 'meta',
    path = '/var/spool/kumomta/meta',
  }

  kumo.configure_local_logs {
    log_dir = '/var/log/kumomta',
    max_segment_duration = '30s',
    headers = trace.LOG_HEADERS,
    meta = trace.LOG_META,
  }
end)

kumo.on('smtp_server_auth_plain', function(authz, authc, password, conn_meta)
  return authz == authc and accounts.verify(authc, password)
end)

kumo.on('smtp_server_mail_from', function(sender, conn_meta)
  local account = accounts.get(conn_meta:get_meta 'authn_id')
  if not account then
    kumo.reject(530, REPLY.AUTH_REQUIRED)
  end
  if not accounts.allows_domain(account, sender.domain) then
    kumo.reject(550, REPLY.SENDER_NOT_ALLOWED)
  end
end)

kumo.on('get_listener_domain', function(domain, listener, conn_meta)
  local account = accounts.get(conn_meta:get_meta 'authn_id')
  if not accounts.allows_domain(account, domain) then
    return nil
  end
  local peer_ip = utils.split_ip_port(conn_meta:get_meta 'received_from')
  return kumo.make_listener_domain {
    relay_from = { peer_ip },
    relay_to = true,
  }
end)

local function accept(msg)
  local name = msg:get_meta 'authn_id'
  local account = accounts.get(name)
  local ok, from_domain = pcall(function()
    return msg:from_header().domain:lower()
  end)
  if not account or not ok or not accounts.allows_domain(account, from_domain) then
    kumo.reject(550, REPLY.FROM_NOT_ALLOWED)
  end

  trace.tag(msg, name)
  dkim.sign(msg, from_domain)
end

kumo.on('smtp_server_message_received', function(msg, conn_meta)
  accept(msg)
end)

kumo.on('http_message_generated', function(msg)
  accept(msg)
end)
