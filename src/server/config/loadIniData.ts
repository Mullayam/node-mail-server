import { ParsedIniData, ResolveIniPath } from './functions';

export const AUTH_CONFIG = ParsedIniData(ResolveIniPath('./auth.ini'));
export const DB_CONFIG = ParsedIniData(ResolveIniPath('./database.ini'));
export const DNS_CONFIG = ParsedIniData(ResolveIniPath('./dns.ini'));
export const SMTP_CONFIG = ParsedIniData(ResolveIniPath('./smtp.ini'));
export const SETTINGS_CONFIG = ParsedIniData(ResolveIniPath('./settings.ini'));
export const TLS_CONFIG = ParsedIniData(ResolveIniPath('./tls.ini'));


