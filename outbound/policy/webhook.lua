-- ================================================================
-- Webhook delivery for log events
-- Uses the recommended policy-extras.log_hooks helper
-- Docs: https://docs.kumomta.com/userguide/operation/webhooks/
-- ================================================================
local kumo = require 'kumo'
local log_hooks = require 'policy-extras.log_hooks'

local M = {}

function M.setup_webhook()
  local webhook_url = os.getenv("WEBHOOK_URL")
  local WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET") or '2025'
  if not webhook_url then
    print("[kumo] WEBHOOK_URL not set — skipping webhook setup")
    return M
  end

  -- Simple JSON webhook using the built-in helper
  -- This handles configure_log_hook, should_enqueue_log_record,
  -- queue config, and HTTP delivery automatically.
  log_hooks:new_json {
    name = 'webhook',
    url  = webhook_url,
    log_parameters = {
      headers =  { 'Subject', 'From', 'To', 'Message-ID' },
    },
   
  }

  print("[kumo] Webhook configured → " .. webhook_url)
end

return M

-- "Received" - 
-- "Enumerated"  
-- "ScheduledForLater" 
-- "ReadyQueueWasSuspended"
-- "MessageRateThrottle"
-- "ThrottledByThrottleInsertReadyQueue"
-- "ReadyQueueWasFull"
-- "FailedToInsertIntoReadyQueue"
-- "MessageGetQueueNameFailed"
-- "AdminRebind"
-- "DueTimeWasReached"
-- "MaxReadyWasReducedByConfigUpdate"
-- "ReadyQueueWasDelayedDueToLowMemory"
-- "FailedDueToNullMx"
-- "MxResolvedToZeroHosts"
-- "MxWasProhibited"
-- "MxWasSkipped"
-- "TooManyConnectionFailures"
-- "TooManyRecipients"
-- "ConnectionRateThrottle"
-- "LoggedTransientFailure"