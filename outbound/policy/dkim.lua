local kumo = require 'kumo'
local dkim_backend = os.getenv("DKIM_BACKEND") or "file"
local dkim_selector = os.getenv("DKIM_SELECTOR") or "default"

-- ================================================================
-- DKIM key retrieval — supports file, http, redis backends
-- ================================================================
local function get_dkim_private_key(domain, selector)

  -- ================= FILE BACKEND =================
  if dkim_backend == "file" then
    local key_path = string.format(
      "/opt/kumomta/etc/dkim/%s/%s.key",
      domain,
      selector
    )

    local f = io.open(key_path, "r")
    if not f then return nil end
    local key = f:read("*all")
    f:close()
    return key
  end

  -- ================= HTTP BACKEND =================
  if dkim_backend == "http" then
    local base_url = os.getenv("DKIM_HTTP_URL")
    if not base_url then return nil end
    local response = kumo.http_request {
    url = string.format(
        "%s?domain=%s&selector=%s",
        base_url,
        domain,
        selector
    ),
    method = "GET",
    timeout = "5s",
    headers = {        
        ["X-API-Key"] = os.getenv("DKIM_API_KEY"),
        ["Accept"] = "text/plain",
    },
    }

    if response and response.status == 200 then
      return response.body
    end

    return nil
  end

  -- ================= REDIS BACKEND =================
  if dkim_backend == "redis" then
    local redis = kumo.redis_connect {
      host = os.getenv("REDIS_HOST") or "127.0.0.1",
      port = tonumber(os.getenv("REDIS_PORT")) or 6379,
    }

    local key_name = string.format("%s::pvt::key", domain)
    local key = redis:get(key_name)

    return key
  end

  return nil
end

-- ================================================================
-- DKIM sign a message — auto-detects domain from From header
-- ================================================================
local function sign_with_dkim(msg)

  local from = msg:from_header()
  local domain = from and from:match('@([%w%.%-]+)%s*>?%s*$')

  if not domain then
    kumo.log("warn", "DKIM: could not parse domain")
    return
  end

  local private_key = get_dkim_private_key(domain, dkim_selector)

  if not private_key then
    kumo.log("warn", "DKIM: key not found for " .. domain)
    return
  end

  local ok, err = pcall(function()
    msg:dkim_sign {
      domain   = domain,
      selector = dkim_selector,
      headers  = {
        "From", "Reply-To", "Subject", "Date", "To", "Cc",
        "Resent-Date", "Resent-From", "Resent-To", "Resent-Cc",
        "In-Reply-To", "References", "List-Id", "List-Help",
        "List-Unsubscribe", "List-Subscribe", "List-Post",
        "List-Owner", "List-Archive"
      },
      key = private_key,
    }
  end)

  if ok then
    kumo.log("info", "DKIM signed via " .. dkim_backend .. " backend for " .. domain)
  else
    kumo.log("error", "DKIM sign failed: " .. tostring(err))
  end
end

local M = {}

M.sign = sign_with_dkim

return M