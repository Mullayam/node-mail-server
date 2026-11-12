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
    local response = kumo.http.build_client({})
      :get(string.format("%s?domain=%s&selector=%s", base_url, domain, selector))
      :header("X-API-Key", os.getenv("DKIM_API_KEY") or "")
      :header("Accept", "text/plain")
      :timeout("5s")
      :send()

    if response:status_code() == 200 then
      return response:text()
    end

    return nil
  end

  -- ================= REDIS BACKEND =================
  if dkim_backend == "redis" then
    local redis = require("redis").open {
      node = string.format(
        "redis://%s:%s/",
        os.getenv("REDIS_HOST") or "127.0.0.1",
        os.getenv("REDIS_PORT") or "6379"
      ),
    }

    local key_name = string.format("%s::pvt::key", domain)
    local key = redis:query("get", key_name)

    return key
  end

  return nil
end

local cached_dkim_private_key = kumo.memoize(get_dkim_private_key, {
  name = "outbound_dkim_keys",
  ttl = "5 minutes",
  capacity = 1024,
})

-- ================================================================
-- DKIM sign a message — auto-detects domain from From header
-- ================================================================
local function sign_with_dkim(msg)

  local parsed, domain = pcall(function()
    return msg:from_header().domain:lower()
  end)

  if not parsed or not domain:match("^[%w%-]+[%w%.%-]*$") or domain:find("..", 1, true) then
    kumo.log_warn("DKIM: could not parse domain")
    return
  end

  local fetched, private_key = pcall(cached_dkim_private_key, domain, dkim_selector)

  if not fetched or type(private_key) ~= "string" or private_key == "" then
    kumo.log_warn("DKIM: key not found for " .. domain)
    return
  end

  local ok, err = pcall(function()
    msg:dkim_sign(kumo.dkim.rsa_sha256_signer {
      domain   = domain,
      selector = dkim_selector,
      headers  = {
        "From", "Reply-To", "Subject", "Date", "To", "Cc", "Message-ID",
        "Resent-Date", "Resent-From", "Resent-To", "Resent-Cc",
        "In-Reply-To", "References", "List-Id", "List-Help",
        "List-Unsubscribe", "List-Subscribe", "List-Post",
        "List-Owner", "List-Archive"
      },
      key = { key_data = private_key },
    })
  end)

  if ok then
    kumo.log_info("DKIM signed via " .. dkim_backend .. " backend for " .. domain)
  else
    kumo.log_error("DKIM sign failed: " .. tostring(err))
  end
end

local M = {}

M.sign = sign_with_dkim

return M