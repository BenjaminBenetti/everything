import { memo, useId, useMemo, useState, type ComponentProps } from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

import { workspaceImageReference } from "../model/workspace-image-reference.js";

const plugins = [remarkGfm, remarkBreaks];

// ===========================================
// Message content and navigation
// ===========================================

/** Open message links without leaving the conversation; footnotes stay within the message. */
function MarkdownLink({ href, children, ...props }: ComponentProps<"a">) {
  if (!href) return <span>{children}</span>;
  const localAnchor = href.startsWith("#");
  return (
    <a
      {...props}
      href={href}
      target={localAnchor ? undefined : "_blank"}
      rel={localAnchor ? undefined : "noopener noreferrer"}
    >
      {children}
    </a>
  );
}

/** Keep wide tables scrollable inside their message, including for keyboard users. */
function MarkdownTable({
  node: _node,
  ...props
}: ComponentProps<"table"> & ExtraProps) {
  return (
    <div
      className="chat-markdown-table"
      role="region"
      aria-label="Message table"
      tabIndex={0}
    >
      <table {...props} />
    </div>
  );
}

/** Preserve code whitespace and expose horizontal scrolling to keyboard users. */
function MarkdownCodeBlock({
  node: _node,
  ...props
}: ComponentProps<"pre"> & ExtraProps) {
  return <pre {...props} tabIndex={0} aria-label="Code block" />;
}

/** Load Markdown images without sending the conversation URL as a referrer. */
function MarkdownImage({
  node: _node,
  src,
  alt,
  ...props
}: ComponentProps<"img"> & ExtraProps) {
  const [missing, setMissing] = useState(false);
  if (!src || missing)
    return (
      <span className="chat-markdown-image-unavailable">
        {alt ? `${alt} (image unavailable)` : "Image unavailable"}
      </span>
    );
  return (
    <img
      {...props}
      src={src}
      alt={alt ?? ""}
      onError={() => setMissing(true)}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}

// ===========================================
// Markdown rendering
// ===========================================

/** Render stored text with GitHub-style formatting, literal HTML, and safe default URL handling. */
function MessageMarkdownContent({
  text,
  agentId,
}: {
  text: string;
  agentId?: string | undefined;
}) {
  const id = useId();
  const components = useMemo<Components>(
    () => ({
      /** Scope the parser's footnote accessibility label to this message. */
      a({ node: _node, "aria-describedby": describedBy, ...props }) {
        return (
          <MarkdownLink
            {...props}
            aria-describedby={
              describedBy === "footnote-label"
                ? `${id}-footnote-label`
                : describedBy
            }
          />
        );
      },
      /** Keep repeated footnote sections from sharing the same document ID. */
      h2({ node: _node, id: headingId, ...props }) {
        return (
          <h2
            {...props}
            id={
              headingId === "footnote-label"
                ? `${id}-footnote-label`
                : headingId
            }
          />
        );
      },
      table: MarkdownTable,
      pre: MarkdownCodeBlock,
      img: (props) => (
        <MarkdownImage
          {...props}
          key={props.src}
          src={workspaceImageReference(props.src, agentId)}
        />
      ),
    }),
    [id, agentId],
  );
  return (
    <div className="chat-markdown">
      <Markdown
        remarkPlugins={plugins}
        remarkRehypeOptions={{ clobberPrefix: `chat-${id}-` }}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
}

/** Avoid reparsing unchanged messages when runtime polling refreshes the conversation. */
export const MessageMarkdown = memo(MessageMarkdownContent);
