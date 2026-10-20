"use client";

import type { HomePayload } from "@/app/lib/homePayload";
import { useHomeData } from "./useHomeData";
import { HomeView, type HomeViewProps } from "./HomeView";

type HomeTabProps = Omit<HomeViewProps, "data" | "loading" | "error"> & {
  /** The host's "this pane is on screen" — polling runs only then. */
  active: boolean;
  /** The body the server rendered with, so the first frame is the page. */
  initial?: HomePayload | null;
};

/** The registry tab's content: the poll plus the page. Both hosts render this. */
export function HomeTab({ active, initial = null, ...view }: HomeTabProps) {
  const { data, loading, error } = useHomeData(active, initial);
  return <HomeView data={data} loading={loading} error={error} active={active} {...view} />;
}
