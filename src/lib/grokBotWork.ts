/** A GitHub pull request page: https://github.com/<owner>/<repo>/pull/<n>. */
const pullRequestPattern = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})$/;
export const commitShaPattern = /^[0-9a-f]{40}$/;

export function pullRequest(url: string) {
  const match = pullRequestPattern.exec(url);
  return match ? { owner: match[1], repo: match[2], number: Number(match[3]), label: `${match[1]}/${match[2]}#${match[3]}` } : null;
}
