import ReactMarkdown from "react-markdown";
import { safeHref } from "@/lib/safe-href";
import { cn } from "@/lib/utils";

/**
 * Markdown from reports (findings, the reviewer's summary). Rendered as React elements, never as raw
 * HTML, and links only if they're http or https.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
    return (
        <div className={cn("prose-md", className)}>
            <ReactMarkdown
                skipHtml
                urlTransform={(url) => safeHref(url) ?? ""}
                components={{
                    a: ({ href, children: text }) =>
                        href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                                {text}
                            </a>
                        ) : (
                            <span>{text}</span>
                        ),
                    img: ({ alt }) => <span>{alt}</span>,
                    // Headings inside content sit below the page's own headings.
                    h1: ({ children: t }) => <h3>{t}</h3>,
                    h2: ({ children: t }) => <h4>{t}</h4>,
                    h3: ({ children: t }) => <h5>{t}</h5>,
                }}
            >
                {children}
            </ReactMarkdown>
        </div>
    );
}

/** Inline Markdown (a title with `code`): only code spans are formatted. */
export function InlineCode({ text, className }: { text: string; className?: string }) {
    const parts = text.split(/(`[^`]+`)/g);
    return (
        <span className={className}>
            {parts.map((p, i) =>
                p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
                    <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.85em]">
                        {p.slice(1, -1)}
                    </code>
                ) : (
                    p
                ),
            )}
        </span>
    );
}
