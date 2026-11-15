import { parse, HTMLElement, TextNode, type Node } from 'node-html-parser'

/**
 * Converts the HTML of a website chat reply into GitHub-flavored markdown so tables and code keep their structure.
 * The input is the sanitized clone produced by `REPLY_SNAPSHOT_SOURCE` (copy buttons, icons and scripts already removed).
 */

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'BUTTON', 'HEAD'])
const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'DT', 'DD', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'UL',
  'MESSAGE-CONTENT', 'MODEL-RESPONSE'
])

/**
 * Plain-JS source evaluated inside the page (kept as a string so bundlers cannot rewrite it).
 * `(root) => string`. Code editors (CodeMirror, Monaco, pre/code) are flattened with their rendered text,
 * because syntax highlighters split each line into spans and never put a newline character in the HTML.
 */
export const REPLY_SNAPSHOT_SOURCE = String.raw`(function (live) {
  function cls(el) {
    return typeof el.className === 'string' ? el.className : '';
  }
  function skip(el) {
    var tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return true;
    if (el.getAttribute('role') === 'button') return true;
    var label = (el.getAttribute('aria-label') || '').toLowerCase();
    if (label.indexOf('copy') === 0) return true;
    if (/(^|\s)(cm-announced|cm-cursorLayer|cm-selectionLayer|cm-gutters)(\s|$)/.test(cls(el))) return true;
    if (/(^|\s)(cdk-visually-hidden|sr-only|visually-hidden|screen-reader-only)(\s|$)/.test(cls(el))) return true;
    var hidden = getComputedStyle(el);
    if (hidden.display === 'none' || hidden.visibility === 'hidden') return true;
    return false;
  }
  function langOf(el) {
    var code = el.querySelector ? el.querySelector('code[class*="language-"], code[class*="lang-"], code[data-language]') : null;
    var cur = code || el;
    for (var i = 0; i < 8 && cur && cur !== live; i++) {
      var data = cur.getAttribute('data-language') || cur.getAttribute('data-lang') || '';
      if (/^[\w#+.-]{1,24}$/.test(data)) return data.toLowerCase();
      var m = cls(cur).match(/(?:^|\s)(?:language|lang)-([\w#+.-]+)/i);
      if (m && m[1].toLowerCase() !== 'plaintext') return m[1].toLowerCase();
      cur = cur.parentElement;
    }
    return '';
  }
  var LABELS = /^(bash|shell|sh|zsh|fish|console|terminal|powershell|pwsh|cmd|batch|python|py|javascript|js|typescript|ts|jsx|tsx|json|jsonc|yaml|yml|toml|ini|html|xml|css|scss|sql|c|cpp|csharp|cs|java|kotlin|swift|go|rust|ruby|php|lua|r|diff|dockerfile|makefile|markdown|md|text|plaintext)$/i;
  var CODE_CLASS = /hljs|shiki|prism|code-?block|md-code|highlight|syntax/i;
  function style(el) {
    return getComputedStyle(el);
  }
  function isMono(el) {
    return /mono|courier|consolas|menlo|monaco|code/i.test(style(el).fontFamily || '');
  }
  function keepsSpace(el) {
    var ws = style(el).whiteSpace;
    return ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
  }
  function isBlockBox(el) {
    var d = style(el).display;
    return d !== 'inline' && d !== 'contents' && d !== 'none' && d.indexOf('inline') !== 0;
  }
  /** Text of an element honoring skipped nodes (copy buttons, hidden labels) and one line per block child. */
  function textOf(node) {
    if (node.nodeType === 3) {
      var parent = node.parentElement || (node.parentNode && node.parentNode.host);
      if (parent && keepsSpace(parent)) return node.data;
      var collapsed = node.data.replace(/\s+/g, ' ');
      if (collapsed !== ' ') return collapsed;
      // Whitespace between blocks (source formatting) is not part of the code.
      var prev = node.previousElementSibling;
      var next = node.nextElementSibling;
      return (prev && isBlockBox(prev)) || (next && isBlockBox(next)) || !(prev || next) ? '' : ' ';
    }
    if (node.nodeType !== 1 || skip(node)) return '';
    if (node.tagName === 'BR') return '\n';
    var out = '';
    var sr = node.shadowRoot;
    var kids = sr && sr.mode === 'open' ? Array.prototype.slice.call(sr.childNodes).concat(Array.prototype.slice.call(node.childNodes)) : node.childNodes;
    for (var i = 0; i < kids.length; i++) out += textOf(kids[i]);
    if (isBlockBox(node) && out && out.charAt(out.length - 1) !== '\n') out += '\n';
    return out;
  }
  /** 0 = not code, 1 = code whose innerText is exact, 2 = code found by its look, read with textOf. */
  function sourceKind(el) {
    if (!el || el.nodeType !== 1 || el === live) return 0;
    if (el.matches('pre, .cm-content, .view-lines')) return 1;
    if (el.tagName === 'CODE' && !el.closest('pre, .cm-content, .view-lines')) {
      if ((el.innerText || '').indexOf('\n') >= 0) return 1;
      if (style(el).display === 'block') return 2;
      return 0;
    }
    var tag = el.tagName;
    if (tag === 'TABLE' || tag === 'UL' || tag === 'OL' || tag === 'P' || /^H[1-6]$/.test(tag)) return 0;
    if (!isMono(el)) return 0;
    var text = el.innerText || '';
    if (keepsSpace(el) && text.indexOf('\n') >= 0) return 2;
    if (CODE_CLASS.test(cls(el)) && isBlockBox(el) && text.trim()) return 2;
    return 0;
  }
  /** A language label shown in a header next to the code (e.g. Gemini's "Bash" above its pre). */
  function labelNear(node) {
    for (var cur = node, i = 0; cur && cur !== live && i < 4; cur = cur.parentElement, i++) {
      for (var sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        var t = (sib.innerText || '').trim().split('\n')[0].trim().toLowerCase();
        if (LABELS.test(t)) return t;
        if (t) break;
      }
    }
    return '';
  }
  /** Drops "Copy" buttons text and the language label, which the sites put around the code itself. */
  function clean(text, lang) {
    var lines = text.split('\n');
    var found = lang;
    while (lines.length) {
      var first = lines[0].trim().toLowerCase();
      if (first === '' || first === 'copy' || first === 'copy code' || first === 'copied' || first === 'copied!') {
        lines.shift();
      } else if (lang && first === lang) {
        lines.shift();
      } else if (!found && lines.length > 1 && LABELS.test(first)) {
        found = first;
        lines.shift();
      } else break;
    }
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return { text: lines.join('\n'), lang: found };
  }
  function isRaw(el) {
    if (!el || el.nodeType !== 1) return false;
    var ws = style(el).whiteSpace;
    if (ws !== 'pre-wrap' && ws !== 'pre-line') return false;
    if (el.querySelector('p, div, pre, ul, ol, table, blockquote, h1, h2, h3, h4, h5, h6')) return false;
    var text = el.innerText || '';
    return /^\s*\x60{3}/m.test(text) || /^(    |\t)\S/m.test(text);
  }
  function flatten(node) {
    if (node.nodeType === 3 || node.nodeType === 8) return node.cloneNode(true);
    if (node.nodeType !== 1) return live.ownerDocument.createTextNode('');
    if (skip(node)) return live.ownerDocument.createTextNode('');
    var kind = sourceKind(node);
    if (kind) {
      var lang = langOf(node) || labelNear(node);
      var pre = live.ownerDocument.createElement('pre');
      var cleaned = clean(kind === 2 ? textOf(node) : node.innerText || '', lang);
      if (cleaned.lang) pre.setAttribute('data-fa-lang', cleaned.lang);
      if (kind === 2) pre.setAttribute('data-fa-code', '1');
      pre.textContent = cleaned.text;
      return pre;
    }
    if (isRaw(node)) {
      var raw = live.ownerDocument.createElement('div');
      raw.setAttribute('data-fa-raw', '1');
      raw.textContent = node.innerText || '';
      return raw;
    }
    var el = node.cloneNode(false);
    var sr = node.shadowRoot;
    if (sr && sr.mode === 'open') {
      for (var i = 0; i < sr.childNodes.length; i++) el.appendChild(flatten(sr.childNodes[i]));
    }
    for (var j = 0; j < node.childNodes.length; j++) el.appendChild(flatten(node.childNodes[j]));
    return el;
  }
  var clone = flatten(live);
  if (!clone || clone.nodeType !== 1) return '';
  clone.querySelectorAll('pre[data-fa-lang]').forEach(function (pre) {
    var lang = (pre.getAttribute('data-fa-lang') || '').toLowerCase();
    var scope = pre.parentElement;
    while (scope && scope.parentElement && scope.parentElement !== clone) scope = scope.parentElement;
    if (!scope) return;
    scope.querySelectorAll('div, span, p').forEach(function (n) {
      if (n === pre || n.contains(pre) || pre.contains(n)) return;
      var t = (n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (t === lang || t === 'copy' || t === 'copy code' || t === 'copied') n.remove();
    });
  });
  return clone.outerHTML || '';
})`

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return ''
  const root = parse(html, { blockTextElements: { script: true, style: true, noscript: true } })
  return blocks(root)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isEl(n: Node): n is HTMLElement {
  return n instanceof HTMLElement
}

function tag(n: HTMLElement): string {
  return (n.tagName ?? '').toUpperCase()
}

function isCodeDiv(n: HTMLElement): boolean {
  return n.getAttribute('data-fa-code') === '1'
}

/** The snapshot marks replies shown as the model's own raw markdown (pre-wrap text holding fences) so they stay verbatim. */
function isRawBlock(n: HTMLElement): boolean {
  return n.getAttribute('data-fa-raw') === '1'
}

function isBlock(n: Node): boolean {
  if (!isEl(n)) return false
  const t = tag(n)
  return BLOCK.has(t) || isCodeDiv(n) || isRawBlock(n) || hasBlockInside(n)
}

/** Sites wrap replies in custom elements (`<response-container>`, `<code-block>`); any element holding blocks is a block. */
function hasBlockInside(n: HTMLElement): boolean {
  for (const c of n.childNodes) {
    if (!isEl(c) || SKIP.has(tag(c))) continue
    if (BLOCK.has(tag(c)) || isCodeDiv(c) || isRawBlock(c) || hasBlockInside(c)) return true
  }
  return false
}

function escapeText(s: string): string {
  return s.replace(/([\\`*_<[\]])/g, '\\$1')
}

function collapse(s: string): string {
  return s.replace(/[ \t\r\n\f\u00a0]+/g, ' ')
}

/** Inline markdown for a run of nodes. */
function inline(nodes: Node[]): string {
  let out = ''
  for (const n of nodes) out += inlineNode(n)
  return out
}

function wrapInline(open: string, inner: string, close = open): string {
  const lead = inner.match(/^\s*/)![0]
  const trail = inner.match(/\s*$/)![0]
  const core = inner.trim()
  return core ? `${lead}${open}${core}${close}${trail}` : inner
}

function inlineNode(n: Node): string {
  if (n instanceof TextNode) return escapeText(collapse(n.text))
  if (!isEl(n)) return ''
  const t = tag(n)
  if (SKIP.has(t)) return ''
  const inner = (): string => inline(n.childNodes)
  switch (t) {
    case 'BR':
      return '  \n'
    case 'STRONG':
    case 'B':
      return wrapInline('**', inner())
    case 'EM':
    case 'I':
      return wrapInline('*', inner())
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return wrapInline('~~', inner())
    case 'CODE':
    case 'KBD':
    case 'SAMP': {
      const text = rawText(n).replace(/\n/g, ' ')
      if (!text.trim()) return ''
      const fence = '`'.repeat(longestRun(text, '`') + 1)
      const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
      return `${fence}${pad}${text}${pad}${fence}`
    }
    case 'A': {
      const href = n.getAttribute('href')
      const text = inner()
      if (!href || !text.trim() || /^javascript:/i.test(href)) return text
      return `[${text.trim()}](${href.replace(/\)/g, '%29').replace(/\s/g, '%20')})`
    }
    case 'IMG':
      return n.getAttribute('alt') ?? ''
    default:
      return inner()
  }
}

function longestRun(s: string, ch: string): number {
  let best = 0
  let cur = 0
  for (const c of s) {
    cur = c === ch ? cur + 1 : 0
    if (cur > best) best = cur
  }
  return best
}

/** Text of a node with `<br>` as newlines and block children on their own lines. */
function rawText(n: Node): string {
  if (n instanceof TextNode) return n.text
  if (!isEl(n)) return ''
  const t = tag(n)
  if (SKIP.has(t)) return ''
  if (t === 'BR') return '\n'
  let out = ''
  for (const c of n.childNodes) {
    const block = isEl(c) && BLOCK.has(tag(c))
    if (block && out && !out.endsWith('\n')) out += '\n'
    out += rawText(c)
    if (block && !out.endsWith('\n')) out += '\n'
  }
  return out
}

function codeBlock(el: HTMLElement): string {
  const codeEl = isEl(el) && tag(el) === 'PRE' ? el.querySelector('code') : null
  const source = codeEl ?? el
  const text = rawText(source).replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '')
  if (!text) return ''
  const lang = codeLanguage(codeEl, el)
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1))
  return `${fence}${lang}\n${text}\n${fence}`
}

function codeLanguage(codeEl: HTMLElement | null, pre: HTMLElement): string {
  const marked = pre.getAttribute('data-fa-lang')
  if (marked) return marked
  const candidates = [codeEl?.getAttribute('class'), pre.getAttribute('class'), codeEl?.getAttribute('data-language'), pre.getAttribute('data-language'), pre.getAttribute('lang')]
  for (const c of candidates) {
    if (!c) continue
    const m = c.match(/(?:language|lang)-([\w+#.-]+)/i)
    if (m) return m[1].toLowerCase()
    if (/^[\w+#.-]+$/.test(c.trim()) && c === codeEl?.getAttribute('data-language')) return c.trim().toLowerCase()
    if (/^[\w+#.-]+$/.test(c.trim()) && (c === pre.getAttribute('data-language') || c === pre.getAttribute('lang'))) return c.trim().toLowerCase()
  }
  return ''
}

function cellText(cell: HTMLElement): string {
  const parts = blocks(cell)
  return parts
    .join('<br>')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function tableBlock(table: HTMLElement): string {
  const rows = table.querySelectorAll('tr').filter((r) => r.closest('table') === table)
  const grid = rows.map((r) => r.childNodes.filter(isEl).filter((c) => ['TD', 'TH'].includes(tag(c))).map(cellText))
  const width = Math.max(0, ...grid.map((r) => r.length))
  if (!width) return ''
  const pad = (r: string[]): string[] => [...r, ...Array(width - r.length).fill('')]
  const line = (r: string[]): string => `| ${pad(r).join(' | ')} |`
  const [head, ...body] = grid
  return [line(head), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(line)].join('\n')
}

function listBlock(list: HTMLElement): string {
  const ordered = tag(list) === 'OL'
  const start = Number.parseInt(list.getAttribute('start') ?? '1', 10)
  let index = Number.isFinite(start) ? start : 1
  const items: string[] = []
  for (const li of list.childNodes) {
    if (!isEl(li) || tag(li) !== 'LI') continue
    const marker = ordered ? `${index++}. ` : '- '
    const body = blocks(li).join('\n')
    const indent = ' '.repeat(marker.length)
    const lines = body.split('\n')
    items.push(lines.map((l, i) => (i === 0 ? marker + l : l ? indent + l : l)).join('\n'))
  }
  return items.join('\n')
}

function blocks(parent: Node): string[] {
  const out: string[] = []
  let run: Node[] = []
  const flush = (): void => {
    if (!run.length) return
    const text = inline(run)
      .replace(/ *\n */g, '\n')
      .replace(/^[ \t]+|[ \t]+$/g, '')
      .replace(/^(\s*)([#>+-]|\d+[.)])(?=\s)/gm, '$1\\$2')
    run = []
    if (text.trim()) out.push(text.trim())
  }
  for (const n of parent.childNodes) {
    if (isEl(n) && SKIP.has(tag(n))) continue
    if (!isBlock(n)) {
      run.push(n)
      continue
    }
    flush()
    const el = n as HTMLElement
    const t = tag(el)
    if (isRawBlock(el)) {
      const raw = rawText(el).replace(/\r\n?/g, '\n').trim()
      if (raw) out.push(raw)
    } else if (t === 'PRE' || isCodeDiv(el)) {
      const code = codeBlock(el)
      if (code) out.push(code)
    } else if (t === 'TABLE') {
      const table = tableBlock(el)
      if (table) out.push(table)
    } else if (t === 'UL' || t === 'OL') {
      const list = listBlock(el)
      if (list) out.push(list)
    } else if (/^H[1-6]$/.test(t)) {
      const text = inline(el.childNodes).replace(/\s+/g, ' ').trim()
      if (text) out.push(`${'#'.repeat(Number(t[1]))} ${text}`)
    } else if (t === 'HR') {
      out.push('---')
    } else if (t === 'BLOCKQUOTE') {
      const inner = blocks(el).join('\n\n')
      if (inner) out.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'))
    } else {
      out.push(...blocks(el))
    }
  }
  flush()
  return out
}
