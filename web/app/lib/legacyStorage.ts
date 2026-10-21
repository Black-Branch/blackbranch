import { legacyNativePlatform } from "./nativePlatform.ts";
// A returning visitor's browser storage, carried across the platform-key rename.
//
// The site's own storage names could begin with the install's old id (the install key
// site.legacyId) — `<old>_…`, `<old>.…`, `<old>:…` — and the site player's stored values were that
// id. The product's names begin with `bb_` and the player is "native". The first-paint script in
// app/layout.tsx runs carryLegacyStorageScript() before anything reads storage, so no reader needs
// to know an old name, and a fresh install (no old id) runs nothing at all.
//
// Only the names below move. Anything else under the old prefix (a site plugin's own keys) is
// left exactly where it is.

/** The product's storage names that had an old-id form, without the `bb_` prefix. A stem ending in
 *  "_" or ":" is a family (`preset_` covers preset_sel, preset_imported and preset_<n>).
 *  @test-only legacyStorage.test.ts checks every stem is still a product storage name, so the list
 *  cannot rot; production reads it in-module, inside carryLegacyStorageScript. */
export const CARRIED_STEMS: readonly string[] = [
  "behavior_lists", "chunk_reload", "enc-verdict:", "matrix_apps_hint", "members-open", "modpanel_geom",
  "pending-support", "preset_", "profilecard_geom", "pwa_nudge_dismissed", "recent_reactions",
  "secure_dismissed", "tipMethod", "tz_sent", "windock_",
];

/** Stored values that named the site's player by the old id (both storage scopes). */
const CARRIED_VALUES: readonly string[] = ["player_live_source", "chatStyle_platformPalette"];

/** The first-paint step that moves old names and values forward — "" when this install has no
 *  old id. A moved value is copied only when the new name is still empty (a newer write wins), and
 *  the old name is then removed, so the step does nothing on every later load. */
export function carryLegacyStorageScript(legacy: string | null = legacyNativePlatform()): string {
  if (!legacy) return "";
  return `(function(L,S,V){
    function mv(st){try{
      var ks=[],i,j;for(i=0;i<st.length;i++)ks.push(st.key(i));
      for(i=0;i<ks.length;i++){
        var k=ks[i],sc='',r=k,nk=null;
        if(r.indexOf('ov:')===0){sc='ov:';r=r.slice(3);}
        if(r.indexOf(L)===0&&'_.:'.indexOf(r.charAt(L.length))>=0&&r.length>L.length+1){
          var rest=r.slice(L.length+1);
          for(j=0;j<S.length;j++){var s=S[j],fam=/[_:]$/.test(s);if(fam?rest.indexOf(s)===0:rest===s){nk=sc+'bb_'+rest;break;}}
        }else if(r==='player_volume_'+L){nk=sc+'player_volume_native';}
        if(nk!==null){var v=st.getItem(k);if(st.getItem(nk)===null&&v!==null)st.setItem(nk,v);st.removeItem(k);}
      }
      for(i=0;i<V.length;i++)for(j=0;j<2;j++){var vk=(j?'ov:':'')+V[i];if(st.getItem(vk)===L)st.setItem(vk,'native');}
    }catch(e){}}
    try{mv(window.localStorage);}catch(e){}
    try{mv(window.sessionStorage);}catch(e){}
  })(${JSON.stringify(legacy)},${JSON.stringify(CARRIED_STEMS)},${JSON.stringify(CARRIED_VALUES)});`;
}
