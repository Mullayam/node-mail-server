local kumo = require 'kumo'

local BACKEND = os.getenv 'DKIM_BACKEND' or 'file'
local SELECTOR = os.getenv 'DKIM_SELECTOR' or 'default'
local DOMAIN = '^[%w%-]+[%w%.%-]*$'

local SIGNED_HEADERS = {
  'From', 'Reply-To', 'Subject', 'Date', 'To', 'Cc', 'Message-ID',
  'Resent-Date', 'Resent-From', 'Resent-To', 'Resent-Cc',
  'In-Reply-To', 'References', 'List-Id', 'List-Help',
  'List-Unsubscribe', 'List-Unsubscribe-Post', 'List-Subscribe',
  'List-Post', 'List-Owner', 'List-Archive',
}

local function key_from_http(domain, selector)
  local base_url = os.getenv 'DKIM_HTTP_URL'
  if not base_url or base_url == '' then
    return nil
  end
  local response = kumo.http
    .build_client({})
    :get(string.format('%s?domain=%s&selector=%s', base_url, domain, selector))
    :header('X-API-Key', os.getenv 'DKIM_API_KEY' or '')
    :header('Accept', 'text/plain')
    :timeout('5s')
    :send()
  if response:status_code() ~= 200 then
    return nil
  end
  return response:text()
end

local function key_from_redis(domain, selector)
  local redis = require 'redis'
  local conn = redis.open {
    node = string.format(
      'redis://%s:%s/',
      os.getenv 'REDIS_HOST' or '127.0.0.1',
      os.getenv 'REDIS_PORT' or '6379'
    ),
  }
  return conn:query('get', string.format('%s::pvt::key', domain))
end

local cached_lookup = {
  http = kumo.memoize(key_from_http, { name = 'relay_dkim_http', ttl = '5 minutes', capacity = 1024 }),
  redis = kumo.memoize(key_from_redis, { name = 'relay_dkim_redis', ttl = '5 minutes', capacity = 1024 }),
}

local function key_source(domain)
  if BACKEND == 'file' then
    local path = string.format('/opt/kumomta/etc/dkim/%s/%s.key', domain, SELECTOR)
    local f = io.open(path, 'r')
    if not f then
      return nil
    end
    f:close()
    return path
  end

  local lookup = cached_lookup[BACKEND]
  if lookup then
    local key = lookup(domain, SELECTOR)
    if type(key) == 'string' and key ~= '' then
      return { key_data = key }
    end
  end
  return nil
end

local M = {}

function M.sign(msg, domain)
  if BACKEND == 'none' then
    return
  end
  if type(domain) ~= 'string' or not domain:match(DOMAIN) or domain:find('..', 1, true) then
    kumo.log_warn('relay DKIM: invalid domain ' .. tostring(domain))
    return
  end

  local lookup_ok, key = pcall(key_source, domain)
  if not lookup_ok then
    kumo.log_error('relay DKIM: key lookup failed for ' .. domain .. ': ' .. tostring(key))
    return
  end
  if not key then
    kumo.log_warn('relay DKIM: no key for ' .. domain .. ' via ' .. BACKEND)
    return
  end

  local sign_ok, err = pcall(function()
    msg:dkim_sign(kumo.dkim.rsa_sha256_signer {
      domain = domain,
      selector = SELECTOR,
      headers = SIGNED_HEADERS,
      key = key,
    })
  end)
  if not sign_ok then
    kumo.log_error('relay DKIM: signing failed for ' .. domain .. ': ' .. tostring(err))
  end
end

return M
