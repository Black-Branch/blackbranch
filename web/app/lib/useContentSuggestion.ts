import { useCallback } from "react";
import { useMatrixIdentity } from "@/app/lib/MatrixClientContext";
import { requestSuggestion } from "@/app/lib/contentSuggest";
import type { RssItem } from "@/app/lib/rssServer";

// The feed "Suggest" button. Rather than posting directly, it hands the item off
// to the Matrix New Post modal (see contentSuggest) so the suggestion uses the
// site's forum-post format — title pre-filled, link in the body. `canSuggest` is
// true for any signed-in viewer.
export function useContentSuggestion() {
  const { matrixId } = useMatrixIdentity();
  const canSuggest = !!matrixId;

  const suggest = useCallback((item: RssItem) => {
    requestSuggestion({ title: item.title, link: item.link ?? "" });
  }, []);

  return { canSuggest, suggest };
}
