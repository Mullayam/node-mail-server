local kumo = require 'kumo'
local accounts = require 'accounts'
local trace = require 'trace'

local M = {}

local HOOK_NAME = 'relay_webhook'
local QUEUE_DOMAIN = 'relay_webhook.log_hook'
local CONSTRUCTOR = 'make.relay_webhook'
local ACCOUNT_META = 'x_webhook_account'

local MAX_AGE = os.getenv 'WEBHOOK_MAX_AGE' or '3d'
local TIMEOUT = os.getenv 'WEBHOOK_TIMEOUT' or '10s'

local PERMANENT_STATUS = { [400] = true, [410] = true, [413] = true, [415] = true, [422] = true }

local function excerpt(text)
  text = text or ''
  if #text > 200 then
    return text:sub(1, 200) .. '...'
  end
  return text
end

local function account_webhook(name)
  local account = accounts.get(name)
  return account and account.webhook
end

local function post(client, hook, message)
  local body = message:get_data()
  local timestamp = tostring(os.time())
  local signature = kumo.digest.hmac_sha256({ key_data = hook.secret }, timestamp .. '.' .. body).hex

  local ok, response = pcall(function()
    return client
      :post(hook.url)
      :header('Content-Type', 'application/json')
      :header('X-Relay-Event-Id', message:id())
      :header('X-Relay-Timestamp', timestamp)
      :header('X-Relay-Signature', 'sha256=' .. signature)
      :body(body)
      :timeout(TIMEOUT)
      :send()
  end)
  if not ok then
    kumo.reject(421, 'webhook request failed: ' .. tostring(response))
  end

  local status = response:status_code()
  local disposition = string.format('%d %s', status, excerpt(response:text()))

  if (status >= 200 and status < 300) or status == 409 then
    return disposition
  end
  if PERMANENT_STATUS[status] then
    kumo.reject(500, disposition)
  end
  kumo.reject(421, disposition)
end

function M.setup()
  if not (kumo.digest and kumo.digest.hmac_sha256) then
    error '[relay] webhook signing needs KumoMTA 2025.12.02 or newer (kumo.digest.hmac_sha256)'
  end

  kumo.on('pre_init', function()
    kumo.configure_log_hook {
      name = HOOK_NAME,
      headers = trace.LOG_HEADERS,
      meta = trace.LOG_META,
    }
  end)

  kumo.on('should_enqueue_log_record', function(msg, hook_name)
    if hook_name ~= HOOK_NAME then
      return
    end
    local record = msg:get_meta 'log_record'
    if record.reception_protocol == 'LogRecord' then
      return false
    end

    local name = type(record.meta) == 'table' and record.meta.authn_id or nil
    local hook = account_webhook(name)
    if not hook or (hook.events and not hook.events[record.type]) then
      return false
    end

    msg:set_meta(ACCOUNT_META, name)
    msg:set_meta('queue', name .. '@' .. QUEUE_DOMAIN)
    return true
  end)

  -- bare return (not "return nil") lets the next get_queue_config handler run
  kumo.on('get_queue_config', function(domain, tenant, campaign, routing_domain)
    if domain ~= QUEUE_DOMAIN then
      return
    end
    return kumo.make_queue_config {
      retry_interval = '30s',
      max_retry_interval = '10m',
      max_age = MAX_AGE,
      protocol = {
        custom_lua = { constructor = CONSTRUCTOR },
      },
    }
  end)

  -- one dispatcher serves every account's queue, so resolve the account per event
  kumo.on(CONSTRUCTOR, function(domain, tenant, campaign)
    local client = kumo.http.build_client {}
    local connection = {}

    function connection:send(message)
      local name = message:get_meta(ACCOUNT_META)
      local hook = account_webhook(name)
      if not hook then
        kumo.reject(500, 'no webhook configured for account ' .. tostring(name))
      end
      return post(client, hook, message)
    end

    function connection:close()
      client:close()
    end

    return connection
  end)
end

return M
