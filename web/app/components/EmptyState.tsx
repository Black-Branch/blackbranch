import type { ReactNode } from "react";

// Shared empty-state line: the one standard look for "nothing here yet" text.
// Callers pass positioning/spacing via className and the message as children.
export default function EmptyState({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={`text-xs text-muted ${className}`}>{children}</p>;
}
