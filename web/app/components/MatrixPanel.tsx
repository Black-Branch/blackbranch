"use client";

import MatrixView from "@/app/features/community";

export default function MatrixPanel({ hideUserMenu }: { hideUserMenu?: boolean }) {
  return <MatrixView layout="sidebar" hideUserMenu={hideUserMenu} />;
}
