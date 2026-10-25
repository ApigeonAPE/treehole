/**
 * Shared time formatting for all pages
 *
 * The database stores UTC timestamps without a zone; the UI parses them as UTC and shows local time.
 *
 * < 1 day -> relative time (just now / N minutes ago / N hours ago)
 * >= 1 day -> absolute time (Jul 28, 22:30)
 */
export function formatDate(dateStr) {
  if (!dateStr) return '';

  // SQLite CURRENT_TIMESTAMP format: "YYYY-MM-DD HH:MM:SS" (UTC)
  // append Z so JS parses it as UTC and renders device-local time
  const d = new Date(dateStr.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return '';

  const now = new Date();

  const diff = now.getTime() - d.getTime();

  if (diff < 60 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} h ago`;

  return d.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
