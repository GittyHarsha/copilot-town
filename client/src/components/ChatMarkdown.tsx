/**
 * Shared markdown rendering components for chat interfaces.
 * Used by HeadlessChatPanel (full panel) and MiniChat (Live Grid).
 */
import { useState, useRef, memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';

/* ─── Helpers ─────────────────────────────────────────────── */

export function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

/* ─── Code block with copy button ─────────────────────────── */

export function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const textRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = textRef.current?.textContent || '';
    copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group/code relative">
      <code ref={textRef} className={className}>{children}</code>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded bg-bg-3/80 text-fg-2/60 hover:text-fg border border-border/40 opacity-0 group-hover/code:opacity-100 transition-opacity"
      >{copied ? '✓' : 'Copy'}</button>
    </div>
  );
}

/* ─── Copy button (for messages) ──────────────────────────── */

export function CopyButton({ text, size = 'normal' }: { text: string; size?: 'normal' | 'small' }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={handleCopy}
      className={`rounded bg-bg-2/60 text-fg-2/40 hover:text-fg-2 border border-border/30 transition-all ${
        size === 'small' ? 'text-[9px] px-1 py-0.5' : 'text-[10px] px-1.5 py-0.5'
      }`}
      title="Copy message"
    >{copied ? '✓' : 'Copy'}</button>
  );
}

/* ─── Markdown renderer — full size ───────────────────────── */

export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre: ({ children }) => (
          <pre className="rounded-lg bg-bg/80 border border-border/40 overflow-x-auto text-[11.5px] leading-relaxed my-2">{children}</pre>
        ),
        code: ({ children, className, ...rest }) => {
          const isBlock = className?.startsWith('hljs') || className?.startsWith('language-');
          if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
          return <code className="text-[11px] px-1 py-0.5 rounded bg-bg-3/60 text-pink-400/90 border border-border/30 font-mono" {...rest}>{children}</code>;
        },
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">{children}</a>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2"><table className="text-[11px] border-collapse w-full">{children}</table></div>
        ),
        th: ({ children }) => <th className="border border-border/40 px-2 py-1 bg-bg-2/60 text-left text-fg-1 font-medium">{children}</th>,
        td: ({ children }) => <td className="border border-border/40 px-2 py-1 text-fg-2">{children}</td>,
        ul: ({ children }) => <ul className="list-disc pl-4 my-1.5 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-4 my-1.5 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-fg/90">{children}</li>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-blue-500/30 pl-3 my-2 text-fg-2 italic">{children}</blockquote>,
        h1: ({ children }) => <h1 className="text-base font-bold mt-3 mb-1 text-fg">{children}</h1>,
        h2: ({ children }) => <h2 className="text-sm font-semibold mt-2.5 mb-1 text-fg">{children}</h2>,
        h3: ({ children }) => <h3 className="text-xs font-semibold mt-2 mb-0.5 text-fg">{children}</h3>,
        p: ({ children }) => <p className="my-1">{children}</p>,
        hr: () => <hr className="border-border/30 my-3" />,
      }}
    >{content}</ReactMarkdown>
  );
});

/* ─── Markdown renderer — compact (for MiniChat grid cells) ── */

export const MiniMarkdownContent = memo(function MiniMarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre: ({ children }) => (
          <pre className="rounded bg-bg/80 border border-border/40 overflow-x-auto text-[10px] leading-snug my-1">{children}</pre>
        ),
        code: ({ children, className, ...rest }) => {
          const isBlock = className?.startsWith('hljs') || className?.startsWith('language-');
          if (isBlock) return <code className={className}>{children}</code>;
          return <code className="text-[10px] px-0.5 rounded bg-bg-3/60 text-pink-400/90 font-mono" {...rest}>{children}</code>;
        },
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{children}</a>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-1"><table className="text-[10px] border-collapse w-full">{children}</table></div>
        ),
        th: ({ children }) => <th className="border border-border/40 px-1.5 py-0.5 bg-bg-2/60 text-left text-fg-1 font-medium text-[10px]">{children}</th>,
        td: ({ children }) => <td className="border border-border/40 px-1.5 py-0.5 text-fg-2 text-[10px]">{children}</td>,
        ul: ({ children }) => <ul className="list-disc pl-3 my-0.5 space-y-0">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-3 my-0.5 space-y-0">{children}</ol>,
        li: ({ children }) => <li className="text-fg/90 text-[11px]">{children}</li>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-blue-500/30 pl-2 my-1 text-fg-2 italic text-[11px]">{children}</blockquote>,
        h1: ({ children }) => <h1 className="text-xs font-bold mt-1.5 mb-0.5 text-fg">{children}</h1>,
        h2: ({ children }) => <h2 className="text-[11px] font-semibold mt-1 mb-0.5 text-fg">{children}</h2>,
        h3: ({ children }) => <h3 className="text-[11px] font-medium mt-1 mb-0 text-fg">{children}</h3>,
        p: ({ children }) => <p className="my-0.5 text-[11px] leading-relaxed">{children}</p>,
        hr: () => <hr className="border-border/30 my-1.5" />,
      }}
    >{content}</ReactMarkdown>
  );
});
