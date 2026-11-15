import { memo, type ReactNode } from 'react'
import hljs from 'highlight.js/lib/common'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** highlight.js escapes the source, so the spans it returns are safe to render. */
function colorize(code: string, lang: string | undefined): string {
  if (lang && lang !== 'text' && lang !== 'plaintext' && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  }
  return hljs.highlightAuto(code).value
}

function Code({ className, children }: { className?: string; children?: ReactNode }): React.JSX.Element {
  const raw = String(children ?? '').replace(/\n$/, '')
  const lang = /language-([\w#+.-]+)/.exec(className ?? '')?.[1]?.toLowerCase()
  const block = Boolean(lang) || raw.includes('\n')
  if (!block) {
    return <code className={className}>{children}</code>
  }
  return (
    <>
      {lang && lang !== 'text' && lang !== 'plaintext' && <span className="code-lang">{lang}</span>}
      <code className={className} dangerouslySetInnerHTML={{ __html: colorize(raw, lang) }} />
    </>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="prose-table-scroll">
              <table>{children}</table>
            </div>
          ),
          code: Code
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
