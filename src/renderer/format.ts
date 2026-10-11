const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

export function human(bytes: number, digits = 1): string {
  if (bytes >= GB) return (bytes / GB).toFixed(digits === 1 ? 1 : digits) + ' GB';
  if (bytes >= MB) return Math.round(bytes / MB) + ' MB';
  if (bytes >= KB) return Math.round(bytes / KB) + ' KB';
  return bytes + ' bytes';
}

export function gb2(bytes: number): string {
  return (bytes / GB).toFixed(2) + ' GB';
}

export function speed(bytesPerSec: number): string {
  if (bytesPerSec >= MB) return (bytesPerSec / MB).toFixed(1) + ' MB/sec';
  if (bytesPerSec >= KB) return Math.round(bytesPerSec / KB) + ' KB/sec';
  return bytesPerSec + ' bytes/sec';
}

export function ago(ms: number | null): string {
  if (ms === null) return 'never';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
