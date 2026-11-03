// Which lane of a person's browser work a task runs in. One task at a time per lane, because a site's login and pages must stay
// consistent, but lanes run side by side so a long Naukri search or a slow form never holds up LinkedIn, or the other way round.
// A company-site apply opens with the login of the site it came from (browser/external.mjs), so it stays in that site's lane.
export function laneOf(task, job) {
  if (task === 'pdf') return 'pdf';                    // seconds long, and other lanes wait on it while tailoring a resume
  const site = task === 'apply_external' ? job?.apply_url || '' : task;
  return /naukri/.test(site) ? 'naukri' : /linkedin/.test(site) ? 'linkedin' : 'other';
}
