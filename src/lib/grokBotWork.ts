/** A GitHub pull request page: https://github.com/<owner>/<repo>/pull/<n>. */
const pullRequestPattern = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})$/;
export const commitShaPattern = /^[0-9a-f]{40}$/;

export function pullRequest(url: string) {
  const match = pullRequestPattern.exec(url);
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]), label: `${match[1]}/${match[2]}#${match[3]}` } : null;
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A duration as a person would say it: 分 under an hour, 時間 under two days, then 日. */
export function formatDuration(ms: number) {
  if (ms < 60_000) return '1分未満';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}分`;
  const hours = ms / 3_600_000;
  if (hours < 10) {
    const whole = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${whole}時間${rest}分` : `${whole}時間`;
  }
  if (hours < 48) return `${Math.round(hours)}時間`;
  const days = Math.round(hours / 2.4) / 10;
  return `${Number.isInteger(days) ? days : days.toFixed(1)}日`;
}
