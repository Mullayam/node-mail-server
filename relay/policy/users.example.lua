-- Copy to users.lua (gitignored). Edits apply within a minute, no restart needed.
return {
  ["app1"] = {
    password = "change-me",
    domains = { "example.com" },
    webhook = {
      url = "https://app1.example.com/webhooks/mail",
      secret = "change-me",
      events = { "Reception", "Delivery", "TransientFailure", "Bounce", "Expiration" },
    },
  },
}
