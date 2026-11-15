import { describe, expect, it } from 'vitest'
import { applyTextDelta, appendOnlyText } from '../src/util'
import { parseEmulatedToolCalls } from '../src/providers/emulated-tools'
import { htmlToMarkdown, REPLY_SNAPSHOT_SOURCE } from '../src/providers/web/reply-markdown'

describe('htmlToMarkdown', () => {
  it('turns a table into a pipe table', () => {
    const md = htmlToMarkdown(
      '<div><p>Compare:</p><table><thead><tr><th>Name</th><th>Use</th></tr></thead><tbody><tr><td>a|b</td><td><code>x</code></td></tr><tr><td>c</td></tr></tbody></table></div>'
    )
    expect(md).toBe('Compare:\n\n| Name | Use |\n| --- | --- |\n| a\\|b | `x` |\n| c |  |')
  })

  it('keeps fenced code, its language and indentation, and ignores the copy button and label', () => {
    const md = htmlToMarkdown(
      '<pre><div><span>python</span><button>Copy code</button></div><div><code class="language-python">def f(x):\n    return x &lt; 2\n</code></div></pre>'
    )
    expect(md).toBe('```python\ndef f(x):\n    return x < 2\n```')
  })

  it('uses a longer fence when the code contains backticks', () => {
    expect(htmlToMarkdown('<pre><code>```\nhi\n```</code></pre>')).toBe('````\n```\nhi\n```\n````')
  })

  it('renders inline code, emphasis, links, headings and lists', () => {
    const md = htmlToMarkdown(
      '<h2>Title</h2><p>Use <code>npm i</code> and <strong>read</strong> <a href="https://x.dev">docs</a>.</p><ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol start="3"><li>c</li></ol>'
    )
    expect(md).toBe('## Title\n\nUse `npm i` and **read** [docs](https://x.dev).\n\n- one\n  - nested\n- two\n\n3. c')
  })

  it('keeps a plain paragraph as a paragraph and escapes markdown-looking text', () => {
    expect(htmlToMarkdown('<p>a * b &lt;div&gt; c</p>')).toBe('a \\* b \\<div> c')
  })

  it('treats code-styled divs as code blocks', () => {
    expect(htmlToMarkdown('<div><p>See</p><div data-fa-code="1">line1\nline2</div></div>')).toBe('See\n\n```\nline1\nline2\n```')
  })

  it('treats custom elements that wrap blocks as blocks', () => {
    const md = htmlToMarkdown('<response-container><p>Hi</p><code-block><div><pre>ls -la</pre></div></code-block><h3>Next</h3></response-container>')
    expect(md).toBe('Hi\n\n```\nls -la\n```\n\n### Next')
  })

  it('returns an empty string for empty input', () => {
    expect(htmlToMarkdown('  ')).toBe('')
  })
})

describe('REPLY_SNAPSHOT_SOURCE', () => {
  it('is a self-contained function expression', () => {
    expect(() => new Function(`return ${REPLY_SNAPSHOT_SOURCE}`)).not.toThrow()
    expect(typeof new Function(`return ${REPLY_SNAPSHOT_SOURCE}`)()).toBe('function')
  })

  it('reads a fenced language from data-fa-lang', () => {
    expect(htmlToMarkdown('<pre data-fa-lang="python">def add(a, b):\n    return a + b</pre>')).toBe('```python\ndef add(a, b):\n    return a + b\n```')
  })

  it('turns a CodeMirror block and an HTML table into markdown', async () => {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ channel: 'chrome' })
    try {
      const page = await browser.newPage()
      await page.setContent(`<style>.cm-content, .cm-line { white-space: pre; }</style><div id="reply" class="markdown-prose">
        <p>Here:</p>
        <div class="relative">
          <table><thead><tr><th><div>Fruit</div></th><th>Color</th></tr></thead>
          <tbody><tr><td>Apple</td><td>Red</td></tr><tr><td>Banana</td><td>Yellow</td></tr></tbody></table>
        </div>
        <div class="card">
          <div class="absolute">python</div>
          <div aria-label="Copy"><button class="copy-code-button">Copy</button></div>
          <div class="language-python"><div class="cm-content" data-language="python"><div class="cm-line"><span>def</span> <span>add</span>(<span>a</span>, <span>b</span>):</div><div class="cm-line">    <span>return</span> <span>a</span> + <span>b</span></div></div></div>
        </div>
        <message-content id="shadow-host"></message-content>
      </div>`)
      await page.evaluate(() => {
        const host = document.querySelector('#shadow-host')!
        const root = host.attachShadow({ mode: 'open' })
        root.innerHTML = '<pre><code class="language-js">const x = 1;\nconst y = 2;</code></pre>'
      })
      const html = (await page.evaluate(`(() => { const snapshot = ${REPLY_SNAPSHOT_SOURCE}; return snapshot(document.querySelector('#reply')); })()`)) as string
      const md = htmlToMarkdown(html)
      expect(md).toContain('| Fruit | Color |')
      expect(md).toContain('| Apple | Red |')
      expect(md).toContain('| Banana | Yellow |')
      expect(md).toContain('```python\ndef add(a, b):\n    return a + b\n```')
      expect(md).not.toContain('Copy')
      expect(md).toContain('```js\nconst x = 1;\nconst y = 2;\n```')
    } finally {
      await browser.close()
    }
  })
})

describe('REPLY_SNAPSHOT_SOURCE code detection', () => {
  const MONO = 'font-family: ui-monospace, Menlo, monospace;'

  async function snapshotMarkdown(body: string, rootStyle = ''): Promise<string> {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ channel: 'chrome' })
    try {
      const page = await browser.newPage()
      await page.setContent(`<div id="reply" style="${rootStyle}">${body}</div>`)
      const html = (await page.evaluate(`(() => { const snapshot = ${REPLY_SNAPSHOT_SOURCE}; return snapshot(document.querySelector('#reply')); })()`)) as string
      return htmlToMarkdown(html)
    } finally {
      await browser.close()
    }
  }

  it('keeps a div-per-line code block, dropping its label and Copy button', async () => {
    const md = await snapshotMarkdown(
      `<p>Run this:</p><div class="code-block" style="${MONO} white-space: pre">` +
        '<div style="font-family: sans-serif; white-space: normal">bash</div><button>Copy</button>' +
        '<div>cd app</div><div>  npm install</div><div>npm run dev</div></div>'
    )
    expect(md).toBe('Run this:\n\n```bash\ncd app\n  npm install\nnpm run dev\n```')
  })

  it('keeps a shiki-style block and a monospace pre-wrap div without a pre tag', async () => {
    const md = await snapshotMarkdown(`
      <pre class="shiki"><code><span class="line">const a = 1</span>
<span class="line">const b = 2</span></code></pre>
      <div style="${MONO} white-space: pre-wrap">line one
    line two</div>`)
    expect(md).toContain('```\nconst a = 1\nconst b = 2\n```')
    expect(md).toContain('```\nline one\n    line two\n```')
  })

  it('turns a one-line block-level code element into a fenced block', async () => {
    const md = await snapshotMarkdown('<p>Install:</p><code style="display:block">npm install</code>')
    expect(md).toBe('Install:\n\n```\nnpm install\n```')
  })

  it('keeps raw markdown fences from a pre-wrap reply verbatim', async () => {
    const md = await snapshotMarkdown('Here you go:\n```python\nprint(1)\n    x = 2\n```\nDone.', 'white-space: pre-wrap')
    expect(md).toBe('Here you go:\n```python\nprint(1)\n    x = 2\n```\nDone.')
  })

  it('keeps a tool_call fence parseable', async () => {
    const md = await snapshotMarkdown('```tool_call\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```', 'white-space: pre-wrap')
    const { calls } = parseEmulatedToolCalls(md, [{ name: 'read_file', description: '', parameters: {} }])
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_file')
  })

  it('reads a Gemini reply: custom wrappers, header label, hidden screen-reader heading', async () => {
    const md = await snapshotMarkdown(
      '<model-response><response-container><div class="response-content">' +
        '<h6 class="cdk-visually-hidden">Gemini said</h6>' +
        '<message-content><div class="markdown"><p><span>Install it:</span></p>' +
        '<response-element><code-block><div class="code-block"><div class="formatted-code-block-internal-container">' +
        '<div class="code-block-decoration"><span>Bash</span><div class="buttons"><gem-icon-button aria-label="Copy code"></gem-icon-button></div></div>' +
        '<pre>pip install Pillow</pre></div></div></code-block></response-element>' +
        '<h3>Script</h3></div></message-content></div></response-container></model-response>'
    )
    expect(md).toBe('Install it:\n\n```bash\npip install Pillow\n```\n\n### Script')
  })

  it('does not turn prose or inline code into code blocks', async () => {
    const md = await snapshotMarkdown(`<p>Use <code>npm i</code> to install.</p><p class="highlight">Highlighted note in normal text.</p>`)
    expect(md).toBe('Use `npm i` to install.\n\nHighlighted note in normal text.')
  })
})

describe('text deltas', () => {
  it('replaces or appends the reply so far', () => {
    expect(applyTextDelta('ab', { text: 'c' })).toBe('abc')
    expect(applyTextDelta('ab', { text: 'xyz', replace: true })).toBe('xyz')
  })

  it('turns replacements into append-only chunks', () => {
    const s = appendOnlyText()
    expect(s.next({ text: 'ab' })).toBe('ab')
    expect(s.next({ text: 'abcd', replace: true })).toBe('cd')
    expect(s.next({ text: 'abXd!', replace: true })).toBe('')
    expect(s.end()).toBe('Xd!')
    expect(s.end()).toBe('')
  })
})
