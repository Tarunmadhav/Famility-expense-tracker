// Deadline maths, shared by the banner, the task form and the tests.
//
// A task stores three things: `due` (the calendar day, unchanged since the first
// version), `dueTime` (the local clock time the person typed, optional) and
// `dueAt` (that same moment as an ISO 8601 UTC instant). `dueAt` is what the
// banner and the reminders compare against, so a task due at 18:00 is late at
// 18:01 regardless of where the server runs. Rows written before this existed
// have only `due`, so they stay all-day and are due at the end of their day.

export const SOON_MS = 24 * 60 * 60 * 1000;

/** True when the task still needs doing. */
export function isOpenTask(task) {
  return Boolean(task) && task.status !== 'Completed';
}

/**
 * The moment a task is due, in milliseconds, or null when it has no date.
 * All-day tasks are due at 23:59 local so they never read as overdue before the
 * day is over.
 */
export function dueMoment(task) {
  const iso = String((task && task.dueAt) || '');
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  const day = String((task && (task.due || task.date)) || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [year, month, date] = day.split('-').map(Number);
  // Local construction, not Date.UTC: "today" means the device's today.
  const end = new Date(year, month - 1, date, 23, 59, 0, 0).getTime();
  return Number.isFinite(end) ? end : null;
}

function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** "6:00 PM" — the format the rest of the app uses, in the device's local time. */
export function clockLabel(at) {
  const d = new Date(at);
  const hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${hours >= 12 ? 'PM' : 'AM'}`;
}

/**
 * The banner's contents: overdue, then due within the next 24 hours, then due
 * later today — sorted overdue first, then by due moment. Completed tasks and
 * tasks with no date never appear.
 */
export function deadlineItems(tasks, now = Date.now()) {
  const items = [];
  for (const task of tasks || []) {
    if (!isOpenTask(task)) continue;
    const at = dueMoment(task);
    if (at === null) continue;
    const overdue = at < now;
    const soon = !overdue && at - now <= SOON_MS;
    const today = sameLocalDay(at, now);
    if (!overdue && !soon && !today) continue;
    items.push({
      id: String((task && task.id) || ''),
      title: String((task && task.title) || 'Task'),
      at,
      overdue,
      soon,
      today,
      allDay: !task.dueAt,
      clock: clockLabel(at),
    });
  }
  // Overdue first, then everything else by the moment it is due.
  items.sort((a, b) => (a.overdue === b.overdue ? a.at - b.at : a.overdue ? -1 : 1));
  return items;
}

/**
 * The instant a form's date + time mean, as an ISO 8601 UTC string.
 * An empty time means all-day, which stores no instant at all.
 */
export function momentFromLocal(dateStr, timeStr) {
  const day = String(dateStr || '').slice(0, 10);
  const time = String(timeStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return '';
  const [year, month, date] = day.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  const local = new Date(year, month - 1, date, hours, minutes, 0, 0);
  return Number.isFinite(local.getTime()) ? local.toISOString() : '';
}
