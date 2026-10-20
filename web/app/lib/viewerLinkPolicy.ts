// Which platform links a VIEWER may make. Pure.
//
// Every YouTube Data scope that identifies a channel is sensitive: a viewer link would bring
// Google's "unverified app" screen and count toward an unverified app's lifetime cap of 100
// accounts. So the viewer "link YouTube" button exists only on a site built WITH the owner
// plugin, and only while YouTube is switched on. A public install reads YouTube chat without any
// Google sign-in.

export function viewerLinkAllowed(platform: string, install: { ownerPlugin: boolean; youtubeOn: boolean }): boolean {
  if (platform !== "youtube") return true;
  return install.ownerPlugin && install.youtubeOn;
}
