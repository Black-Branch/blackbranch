"use client";

import React, { useState } from "react";
import { renderText } from "@/app/lib/renderText";
import { stripBidiControls } from "@/app/lib/bidi";
import { deceptiveLinkHost } from "@/app/lib/linkGuard";
import { linkLabelText, type MxNode, type MxAttrs } from "@/app/lib/matrixHtml";
import type { EmoteMap } from "@/app/lib/useEmotes";
import { senderLabel } from "@/app/lib/discordSender";

// Renders the allowlisted tree from app/lib/matrixHtml.ts.
//
// The security work happens in the sanitizer; this file's only job is to map an
// already-validated tree onto React elements. It NEVER builds a markup string and
// never uses dangerouslySetInnerHTML — every element below is written out by hand,
// so a tag the sanitizer failed to model simply cannot render.
//
// Text nodes go through the ordinary `renderText` pipeline, so emotes, Twemoji,
// bare-URL linkification and the link-spoof guard behave exactly as they do in
// normal chat — a bridged message is styled like the rest of the room, not like
// a foreign document.

/**
 * Text nodes carry their own inter-element whitespace ("</a> foo"), but renderText
 * tokenizes on " " and re-emits leading spaces itself, which doubles them at the
 * edges. Split the edge whitespace off and render it explicitly.
 */
function TextRun({ text, emotes }: { text: string; emotes: EmoteMap }) {
  if (!text) return null;
  if (!text.trim()) return <> </>;
  const lead = /^\s/.test(text);
  const trail = /\s$/.test(text);
  return (
    <>
      {lead && " "}
      {renderText(text.trim(), emotes)}
      {trail && " "}
    </>
  );
}

function EmbedImage({ attrs }: { attrs: MxAttrs }) {
  return (
    <img
      src={attrs.src}
      alt={attrs.alt ?? ""}
      title={attrs.title}
      loading="lazy"
      decoding="async"
      className="max-w-full h-auto rounded-md my-1"
      style={{ maxHeight: "18rem" }}
    />
  );
}

function InlineEmote({ attrs }: { attrs: MxAttrs }) {
  // Sized off the same custom property as chat emotes so it tracks the reader's
  // font-size slider instead of the sender's `height` attribute (which is the
  // SENDER's choice — honouring it would let a message set its own scale).
  return (
    <img
      src={attrs.src}
      alt={attrs.alt ?? ""}
      title={attrs.title ?? attrs.alt}
      loading="lazy"
      decoding="async"
      style={{
        height: "var(--chat-emote-size, 1.4em)",
        width: "auto",
        display: "inline-block",
        verticalAlign: "middle",
        margin: "0 var(--chat-emote-overlap, 2px)",
      }}
    />
  );
}

const USER_PILL = /^https:\/\/matrix\.to\/#\/(@[^/?#]+)$/;

function Anchor({ attrs, nodes, emotes }: { attrs: MxAttrs; nodes: MxNode[]; emotes: EmoteMap }) {
  // A user pill: `<a href="https://matrix.to/#/@user:server">Name</a>` is how
  // every client (and the Discord bridge) writes a mention. Draw it as a pill,
  // not a link. The label is attacker-controllable like every other
  // formatted_body text, but the pill is inert — a span, no navigation — and
  // carries the real mxid in `title`, so there is no link target for the
  // guard to check.
  const pillUser = attrs.href ? USER_PILL.exec(attrs.href) : null;
  if (pillUser) {
    // decodeURIComponent throws on a lone "%" — and this mxid comes from a
    // formatted_body an authenticated attacker fully controls (any logged-in
    // user can PUT one, per matrixHtml.test.ts's header), so a malformed one
    // must not take the render down.
    let title = pillUser[1]!;
    try {
      title = decodeURIComponent(title);
    } catch {
      /* keep the raw (still-safe) mxid as the title */
    }
    // A bridged Discord mention's anchor text is a single text node carrying
    // the ghost's own "(Discord)" suffix — the same thing every other name
    // renderer strips via senderLabel, so this one must too. Anything richer
    // than one text node (nested formatting) renders as before.
    const onlyChild = nodes.length === 1 ? nodes[0] : undefined;
    const label = onlyChild?.t === "text" ? senderLabel(onlyChild.text, title).label : null;
    return (
      <span className="rounded-md bg-accent/20 px-1 text-heading" title={title}>
        @{label !== null ? label : renderNodes(nodes, emotes)}
      </span>
    );
  }

  // The link-spoof guard on the HTML path. An <a> is a STRONGER spoof primitive
  // than the markdown link the guard was written for, so the same check runs
  // here — on the label as the reader sees it (bidi controls stripped FIRST, or
  // an override could split the domain match and walk past the check).
  // linkLabelText, NOT treeText: alt text is invisible to the reader, and feeding
  // it to the guard would let an invisible image inject the "@" that suppresses
  // the handle carve-out. Judge the label the human actually sees.
  const label = stripBidiControls(linkLabelText(nodes));
  const realHost = attrs.href ? deceptiveLinkHost(label, attrs.href) : null;
  return (
    <>
      <a
        href={attrs.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        title={attrs.href}
        className="text-blue-400 hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {renderNodes(nodes, emotes)}
      </a>
      {realHost && (
        <span
          className="text-amber-400/90 break-all"
          style={{ fontSize: "0.85em" }}
          title={`This link actually goes to ${attrs.href}`}
        >
          {" "}
          (↗ {realHost})
        </span>
      )}
    </>
  );
}

function Quote({ attrs, nodes, emotes }: { attrs: MxAttrs; nodes: MxNode[]; emotes: EmoteMap }) {
  const isEmbed = attrs.role === "embed";
  return (
    <blockquote
      className={
        isEmbed
          ? "my-1 pl-2.5 pr-2 py-1.5 border-l-[3px] rounded-r bg-surface-2/60 text-body-dim"
          : "my-1 pl-2.5 border-l-2 border-edge text-body-dim"
      }
      // The embed's accent is the only sender-supplied colour we honour, and it is
      // validated to #rgb/#rrggbb by the sanitizer. It can only tint a 3px rule.
      style={isEmbed ? { borderLeftColor: attrs.accent ?? "var(--color-edge-strong)" } : undefined}
    >
      {renderNodes(nodes, emotes)}
    </blockquote>
  );
}

// Discord's ||spoiler||, bridged as <span data-mx-spoiler>. Hidden until the
// reader clicks (or presses Enter/Space); the children stay in the layout,
// just invisible, so an emote or image inside is hidden too. Reveal is per
// mount — scrolling away and back hides it again, as Discord does.
function Spoiler({ reason, children }: { reason?: string; children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  // The reason (if any) stays visible before AND after reveal — it is a label
  // for what's hidden, not part of the hidden content.
  if (shown) {
    return (
      <>
        {reason && <span className="text-muted">({reason}) </span>}
        <span className="rounded bg-surface-2/60 px-0.5">{children}</span>
      </>
    );
  }
  return (
    <>
      {reason && <span className="text-muted">({reason}) </span>}
      <span
        role="button"
        tabIndex={0}
        aria-label="Spoiler"
        title="Click to reveal"
        className="rounded bg-surface-4 px-0.5 cursor-pointer"
        onClick={(e) => { e.stopPropagation(); setShown(true); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShown(true); } }}
      >
        <span className="invisible">{children}</span>
      </span>
    </>
  );
}

function renderNodes(nodes: MxNode[], emotes: EmoteMap): React.ReactNode[] {
  return nodes.map((n, i) => {
    if (n.t === "text") return <TextRun key={i} text={n.text} emotes={emotes} />;

    const { tag, attrs, children } = n;
    const kids = () => renderNodes(children, emotes);

    switch (tag) {
      case "br": return <br key={i} />;
      case "hr": return <hr key={i} className="my-1.5 border-edge" />;
      case "img":
        return attrs.emote
          ? <InlineEmote key={i} attrs={attrs} />
          : <EmbedImage key={i} attrs={attrs} />;
      case "a": return <Anchor key={i} attrs={attrs} nodes={children} emotes={emotes} />;
      case "blockquote": return <Quote key={i} attrs={attrs} nodes={children} emotes={emotes} />;

      // Discord wraps nearly everything in <p>. Rendering those as real block
      // paragraphs with margins would make one bridged line taller than a whole
      // burst of native chat, so they are tight blocks instead.
      case "p": return <div key={i} className="my-0.5 first:mt-0 last:mb-0">{kids()}</div>;
      case "span": return attrs.spoiler ? <Spoiler key={i} reason={attrs.spoilerReason}>{kids()}</Spoiler> : <span key={i}>{kids()}</span>;

      case "em": return <em key={i}>{kids()}</em>;
      case "strong": return <strong key={i} className="font-semibold">{kids()}</strong>;
      case "u": return <u key={i}>{kids()}</u>;
      case "s":
      case "del": return <del key={i} className="text-muted">{kids()}</del>;
      case "sub": return <sub key={i} className="text-muted" style={{ fontSize: "0.8em" }}>{kids()}</sub>;
      case "sup": return <sup key={i} style={{ fontSize: "0.8em" }}>{kids()}</sup>;

      case "ul": return <ul key={i} className="list-disc pl-5 my-0.5">{kids()}</ul>;
      case "ol": return <ol key={i} className="list-decimal pl-5 my-0.5">{kids()}</ol>;
      case "li": return <li key={i}>{kids()}</li>;

      case "pre":
        return (
          <pre key={i} className="my-1 p-2 rounded bg-surface-2 overflow-x-auto text-body-dim"
               style={{ fontSize: "0.9em" }}>
            {kids()}
          </pre>
        );
      case "code":
        return (
          <code key={i} className="px-1 py-0.5 rounded bg-surface-2 font-mono"
                style={{ fontSize: "0.9em" }} data-lang={attrs.lang}>
            {kids()}
          </code>
        );

      // Bridged headings are just emphasis inside a chat line — rendering real
      // h1 sizing next to a chat message looks broken.
      case "h1": case "h2": case "h3":
      case "h4": case "h5": case "h6":
        return <div key={i} className="font-semibold text-heading my-0.5">{kids()}</div>;

      case "table":
        return (
          <div key={i} className="my-1 overflow-x-auto">
            <table className="border-collapse text-left">{kids()}</table>
          </div>
        );
      case "thead": return <thead key={i}>{kids()}</thead>;
      case "tbody": return <tbody key={i}>{kids()}</tbody>;
      case "tr": return <tr key={i}>{kids()}</tr>;
      case "th": return <th key={i} className="border border-edge px-1.5 py-0.5 font-semibold">{kids()}</th>;
      case "td": return <td key={i} className="border border-edge px-1.5 py-0.5">{kids()}</td>;
    }
  });
}

export function MatrixHtml({
  nodes, truncated, emotes,
}: {
  nodes: MxNode[];
  truncated: boolean;
  emotes: EmoteMap;
}) {
  return (
    <>
      {renderNodes(nodes, emotes)}
      {/* Never truncate silently — a message cut off by the depth/size caps must
          say so, or it reads as the sender's own words ending there. */}
      {truncated && (
        <span className="text-muted italic" title="This message was too deeply nested to render in full">
          {" "}…
        </span>
      )}
    </>
  );
}
