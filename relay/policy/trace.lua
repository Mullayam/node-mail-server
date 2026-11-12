local M = {}

local TRACE_HEADERS = { 'X-Trace-Id', 'X-Campaign' }
local CAMPAIGN = '^[%w%._%-]+$'

M.LOG_HEADERS = { 'Message-ID', 'Subject', 'From', 'To' }
M.LOG_META = { 'authn_id', 'x_trace_id', 'campaign', 'received_from' }

function M.tag(msg, account_name)
  msg:import_x_headers(TRACE_HEADERS)
  msg:remove_x_headers(TRACE_HEADERS)

  local trace_id = msg:get_meta 'x_trace_id'
  if type(trace_id) ~= 'string' or trace_id == '' or #trace_id > 256 then
    trace_id = msg:id()
  end
  msg:set_meta('x_trace_id', trace_id)

  msg:set_meta('tenant', account_name)

  local campaign = msg:get_meta 'x_campaign'
  if type(campaign) == 'string' and #campaign <= 64 and campaign:match(CAMPAIGN) then
    msg:set_meta('campaign', campaign)
  end
end

return M
