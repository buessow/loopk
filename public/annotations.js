// The chart marks of a review by Claude (analysis): Claude ends its answer
// with a ```annotations block, a JSON array of { at, until?, kind, text },
// times written as in the records ("Thu 22 Oct 18:40", local time).

export const KINDS = ['over', 'under', 'ok', 'note'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BLOCK = /```annotations[^\n]*\n?([\s\S]*?)(```|$)/;

/**
 * Epoch ms of "Thu 22 Oct 18:40" in this browser's time zone (the one the
 * review was asked in), in the year that puts it nearest `near` (ms); null
 * if it is not such a time.
 */
export function parseTime (text, near) {
  const m = /(\d{1,2}) ([A-Z][a-z]{2})\w* (\d{1,2}):(\d{2})/.exec(String(text ?? ''));
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  if (month < 0) return null;
  const y = new Date(near).getFullYear();
  const options = [y - 1, y, y + 1].map((year) => new Date(year, month, Number(m[1]), Number(m[3]), Number(m[4])).getTime());
  return options.reduce((a, b) => (Math.abs(b - near) < Math.abs(a - near) ? b : a));
}

/**
 * Splits a review into its text (without the annotations block, also while
 * the block is still streaming) and its marks: [{ n, from, to, kind, text }],
 * numbered from 1 in the order given; marks that cannot be read are left out.
 */
export function extractAnnotations (review, near) {
  const m = BLOCK.exec(review);
  if (!m) return { markdown: review, annotations: [] };
  const markdown = (review.slice(0, m.index) + review.slice(m.index + m[0].length)).trimEnd();
  if (!m[2]) return { markdown, annotations: [] }; // not finished yet
  let list;
  try {
    list = JSON.parse(m[1]);
  } catch {
    return { markdown, annotations: [] };
  }
  const annotations = (Array.isArray(list) ? list : []).map((a, i) => {
    const from = parseTime(a?.at, near);
    const until = a?.until ? parseTime(a.until, near) : null;
    return {
      n: i + 1,
      from,
      to: until != null && until > from ? until : from,
      kind: KINDS.includes(a?.kind) ? a.kind : 'note',
      text: String(a?.text ?? '').slice(0, 120),
    };
  }).filter((a) => a.from != null);
  return { markdown, annotations };
}
