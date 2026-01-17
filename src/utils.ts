/**
 * Format timestamp to ISO string with local timezone (Asia/Ho_Chi_Minh, UTC+7)
 * @returns ISO 8601 formatted string with timezone offset +07:00
 */
export function formatLocalTimestamp(): string {
  const now = new Date();
  // Asia/Ho_Chi_Minh is UTC+7 (no daylight saving time)
  // Convert UTC time to UTC+7 by adding 7 hours
  const offsetMs = 7 * 60 * 60 * 1000; // UTC+7 in milliseconds
  const localTime = new Date(now.getTime() + offsetMs);
  
  // Format as ISO 8601 with timezone offset
  const year = localTime.getUTCFullYear();
  const month = String(localTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localTime.getUTCDate()).padStart(2, '0');
  const hours = String(localTime.getUTCHours()).padStart(2, '0');
  const minutes = String(localTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(localTime.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(localTime.getUTCMilliseconds()).padStart(3, '0');
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}+07:00`;
}
