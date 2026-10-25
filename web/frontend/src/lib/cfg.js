/**
 * Load config from /api/public-config (cached after the first success)
 */

let _cfg = null;

export async function loadConfig() {
  if (_cfg) return _cfg;
  try {
    const resp = await fetch('/api/public-config');
    if (resp.ok) {
      const data = await resp.json();
      // only cache a successful, complete response
      if (data.trusted_domains) {
        _cfg = data;
      }
      return data;
    }
  } catch {}
  return _cfg || { site_title: 'Treehole', trusted_domains: [], verify_address: 'verify@' };
}

export function getCfg() {
  return _cfg || { site_title: 'Treehole', trusted_domains: [], verify_address: 'verify@' };
}
