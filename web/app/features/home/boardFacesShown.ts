// Which Leaderboard faces this install shows. The four AI-score faces (the two karma faces and the
// two brain faces, SCORE_OF below) rank people by per-message scores that only the install's plugin
// computes — the plugin declares them (app/lib/plugins/installed.ts messageScores). Without that
// declaration the faces would be boards nobody can fill, so they are not offered. Every other face
// is the product's own. Pure.

import { FACES, type FaceDef, type FaceId } from "../../lib/boardFaces.ts";

/** The score each AI face is built from. */
const SCORE_OF: Partial<Record<FaceId, string>> = { wholesome: "karma", toxic: "karma", bigBrain: "intelligence", smallBrain: "intelligence" };

/** The faces to offer, in chip order, given the scores the plugin declares. */
export function facesShown(scores: readonly { key: string }[]): readonly FaceDef[] {
  const have = new Set(scores.map((s) => s.key));
  return FACES.filter((f) => {
    const needs = SCORE_OF[f.id];
    return !needs || have.has(needs);
  });
}

/** The face to show: the remembered one when it is offered here, else the vote score. */
export function faceShown(stored: FaceId, shown: readonly FaceDef[]): FaceId {
  return shown.some((f) => f.id === stored) ? stored : "credit";
}
