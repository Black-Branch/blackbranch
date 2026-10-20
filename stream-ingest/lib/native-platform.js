// The platform id of the site's OWN chat — what a native message frame carries. The product's word
// is "native" in every install; the label people see is the site's name. Same as
// stream-api/native-platform.js.

export const NATIVE_PLATFORM = 'native';

/** Is `p` the site's own platform? */
export function isNativePlatform(p) {
  return p === NATIVE_PLATFORM;
}
