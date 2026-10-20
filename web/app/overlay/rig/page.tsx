import RigOverlay from "@/app/components/RigOverlay";

// The rig page: the one OBS browser source for the bot's voice, the sound alerts, its avatar and
// scene switching. Its address carries the site's key; the page reads it in the browser, so nothing
// about the key is rendered on the server.
export default function RigOverlayPage() {
  return <RigOverlay />;
}
