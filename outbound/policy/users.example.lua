-- SMTP AUTH accounts for the :587 submission listener.
-- Copy to users.lua (gitignored) and set real credentials.
-- init.lua re-reads this file on every AUTH, so edits apply without a restart.
--
-- WARNING: plaintext passwords. For production, move these to a
-- secrets store or hash them and compare hashes in init.lua.
return {
  ["user1"] = "change-me",
}
