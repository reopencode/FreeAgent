export const TELEGRAM_LIMIT = 4096

/** Splits text into pieces of at most `limit` characters, preferring to break at a newline, then a space. */
export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n')
    if (cut < limit / 2) cut = window.lastIndexOf(' ')
    if (cut < limit / 2) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^[ \n]/, '')
  }
  out.push(rest)
  return out
}
