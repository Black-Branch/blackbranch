export function stripReplyFallback(body: string): string {
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]?.startsWith("> ")) i++;
  if (i > 0 && lines[i] === "") i++;
  return i > 0 ? lines.slice(i).join("\n").trim() : body;
}
