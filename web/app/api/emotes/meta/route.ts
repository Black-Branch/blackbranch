import { instanceString } from "@/app/lib/instanceConfigServer";
export const dynamic = "force-dynamic";

// Public, non-user site facts the emote picker needs: the channel name that
// labels the channel-emote group. The instance key platform.twitch.channel, so
// the client never carries a hardcoded owner name; null when unconfigured — the
// picker falls back to a neutral label.
export async function GET() {
  return Response.json(
    { twitchChannel: instanceString("platform.twitch.channel") },
    { headers: { "Cache-Control": "public, max-age=3600" } }
  );
}
