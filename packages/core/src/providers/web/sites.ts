import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WebSiteConfig {
  id: string
  name: string
  url: string
  /** URL that opens a fresh conversation. */
  newChatUrl: string
  /** Present only when the visitor is signed out. */
  loggedOutSelector: string
  /** Prompt box: a textarea or contenteditable element. */
  input: string
  /** Optional send button; Enter is pressed when it is missing. */
  send?: string
  /** When true, always click `send` and never press Enter (needed for Gemini). */
  requireSendClick?: boolean
  /** Every assistant reply on the page; the last match is read. */
  reply: string
  /** Present while a reply is still streaming, e.g. a stop button. */
  generating?: string
  /** Shown when the site asks for a human check. */
  captcha?: string
  loginRequired: boolean
  /** Button that opens the site's model menu. Without it, a Model name cannot be applied. */
  modelPicker?: string
  /** The entries of the open model menu. Each entry's text is matched against the Model name. */
  modelOption?: string
}

export const WEB_SITES: WebSiteConfig[] = [
  {
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com/',
    newChatUrl: 'https://grok.com/',
    loggedOutSelector: 'a[href*="sign-in"], a[href*="accounts.x.ai"]',
    input: 'div[contenteditable="true"], textarea',
    send: 'button[type="submit"][aria-label], button[aria-label="Submit"]',
    reply: '[id^="response-"] .message-bubble, div.message-bubble .response-content-markdown',
    generating: 'button[aria-label="Stop model response"], button[aria-label*="Stop"]',
    captcha: 'iframe[src*="challenges.cloudflare.com"]',
    loginRequired: true,
    modelPicker: '#model-select-trigger, button[aria-label^="Model:"]',
    modelOption: '[role="menuitemradio"]'
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    newChatUrl: 'https://chatgpt.com/',
    loggedOutSelector: '[data-testid="login-button"], button:has-text("Log in")',
    // Current composer is a ProseMirror contenteditable; older builds used #prompt-textarea.
    input: '[data-composer-markdown], div.ProseMirror[contenteditable="true"], [aria-label="Ask ChatGPT"][contenteditable="true"], #prompt-textarea, #mobile-composer-prompt, textarea[name="prompt"]',
    send: 'button[aria-label="Send"], [data-testid="send-button"], #composer-submit-button, button[data-composer-submit]',
    reply: '[data-markdown-text-style="assistant-message"], [data-message-author-role="assistant"], [data-message-role="assistant"]',
    generating: '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]',
    captcha: 'iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], #challenge-form, .cf-turnstile',
    loginRequired: false,
    // Not checked against the live site (it sits behind a human check when signed out); adjust under Selectors if needed.
    modelPicker: '[data-testid="model-switcher-dropdown-button"], button[aria-label^="Model selector"]',
    modelOption: '[role="menuitem"], [role="menuitemradio"], [data-testid^="model-switcher-"]'
  },
  {
    id: 'gemini-web',
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    newChatUrl: 'https://gemini.google.com/app',
    loggedOutSelector: 'a[href*="accounts.google.com/ServiceLogin"], a[aria-label="Sign in"]',
    // Current UI uses a plain textarea; older builds used rich-textarea / Quill.
    input: 'textarea[placeholder="Ask Gemini"], textarea.gds-body-l, rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"]',
    send: '[data-test-id="send-button-container"] button[aria-label="Send message"], button[aria-label="Send message"], button.send-button',
    requireSendClick: true,
    reply: 'model-response message-content, message-content, message-content.model-response-text, model-response',
    generating: 'button[aria-label*="Stop"]',
    loginRequired: true,
    modelPicker: '[data-test-id="bard-mode-menu-button"], button[aria-label^="Open mode picker"]',
    modelOption: '[role="menuitemradio"]'
  },
  {
    id: 'pi',
    name: 'Pi',
    url: 'https://pi.ai/talk',
    newChatUrl: 'https://pi.ai/talk',
    loggedOutSelector: 'button:has-text("Log in"), button:has-text("Sign in")',
    input: 'textarea[enterkeyhint], textarea, [contenteditable="true"]',
    send: 'button[aria-label="Submit text"], button[type="submit"]',
    reply: 'div.break-anywhere:not(.bg-neutral-300) div.whitespace-pre-wrap, [data-testid="ai-message"]',
    loginRequired: true
  },
  {
    id: 'kimi',
    name: 'Kimi',
    url: 'https://www.kimi.ai/',
    newChatUrl: 'https://www.kimi.ai/',
    loggedOutSelector: '.login-button, button:has-text("Log in")',
    input: 'div.chat-input-editor[contenteditable="true"], div.chat-input-editor, div[contenteditable="true"]',
    send: 'div.send-button-container:not(.disabled), .send-button',
    reply: '.segment-assistant .markdown-container, .chat-content-item-assistant .markdown, .segment-assistant',
    generating: '.send-button-container.stop, .stop-message-btn',
    // Guest chat still shows Log in banners; the prompt box is enough.
    loginRequired: false,
    modelPicker: '[data-testid="model-select-trigger"]',
    modelOption: '[data-testid="model-option"]'
  },
  {
    id: 'zai',
    name: 'Z.ai',
    url: 'https://chat.z.ai/',
    newChatUrl: 'https://chat.z.ai/',
    loggedOutSelector: 'a[href*="/auth"]:has-text("Sign in"), button:has-text("Sign in")',
    input: '#chat-input, textarea',
    send: '#send-message-button, button[type="submit"]',
    reply: '.chat-assistant #response-content-container, .chat-assistant .markdown-prose',
    generating: 'button[aria-label="Stop"], #stop-response-button',
    loginRequired: false,
    modelPicker: 'button[aria-label="Select a model"], [id^="model-selector"][id$="-button"]',
    modelOption: '[role="menu"] button'
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai/new',
    newChatUrl: 'https://claude.ai/new',
    loggedOutSelector: 'a[href*="/login"]',
    // Composer is a ProseMirror contenteditable.
    input: '[data-testid="chat-input"], div.ProseMirror[contenteditable="true"]',
    send: 'button[aria-label="Send Message"], button[aria-label="Send message"], button[data-testid="send-button"]',
    // The markdown body only: the assistant-message wrapper also holds the "Claude responded:" heading, action buttons and promo lines.
    reply: '[data-testid="assistant-message"] .standard-markdown',
    generating: 'button[data-testid="chat-input-stop"], button[aria-label="Stop response"], button[aria-label="Stop Response"], [data-testid="assistant-message"][data-is-streaming="true"]',
    captcha: 'iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], #challenge-form, .cf-turnstile',
    loginRequired: true,
    // Not checked against the live site; adjust under Selectors if needed.
    modelPicker: '[data-testid="model-selector-dropdown"]',
    modelOption: '[role="menuitemradio"]'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    newChatUrl: 'https://chat.deepseek.com/',
    // The signed-out page redirects to /sign_in, which shows a password field.
    loggedOutSelector: 'input[type="password"]',
    // Not checked against a signed-in page; adjust under Selectors if needed.
    input: '#chat-input, textarea[placeholder*="DeepSeek"], textarea[placeholder*="Send a message"], textarea[data-testid="chat-input"]',
    send: 'button[aria-label="Send message"], [data-testid="send-button"], button[type="submit"]',
    reply: '[data-message-author-role="assistant"] .ds-markdown, .ds-markdown',
    generating: 'button[aria-label*="Stop"], [data-testid="stop-button"]',
    captcha: '[role="dialog"]:has-text("Abnormal usage environment")',
    loginRequired: true
  }
]

/** Bundled selectors, overlaid with `<dataDir>/web-sites/<id>.json` when the user has edited them. */
export function loadSiteConfig(dataDir: string, siteId: string): WebSiteConfig {
  const base = WEB_SITES.find((s) => s.id === siteId)
  if (!base) throw new Error(`Unknown web site ${siteId}`)
  const file = siteOverridePath(dataDir, siteId)
  if (!existsSync(file)) return base
  try {
    return { ...base, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<WebSiteConfig>), id: base.id }
  } catch {
    return base
  }
}

export function siteOverridePath(dataDir: string, siteId: string): string {
  return join(dataDir, 'web-sites', `${siteId}.json`)
}

export function validateSiteConfig(cfg: Partial<WebSiteConfig>): string[] {
  const errors: string[] = []
  for (const key of ['url', 'newChatUrl', 'input', 'reply', 'modelPicker', 'modelOption'] as const) {
    if (cfg[key] !== undefined && (typeof cfg[key] !== 'string' || !String(cfg[key]).trim())) errors.push(`${key} must be a non-empty string`)
  }
  for (const key of ['url', 'newChatUrl'] as const) {
    const v = cfg[key]
    if (typeof v === 'string' && !/^https:\/\//.test(v)) errors.push(`${key} must start with https://`)
  }
  return errors
}
