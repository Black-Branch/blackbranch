"use client";

import { useRouter } from "next/navigation";
import { ChatHistoryWindow } from "@/app/features/moderation";
import { closePopoutPage } from "@/app/components/PopoutClose";

export default function ChatHistoryPopout() {
  const router = useRouter();
  return <ChatHistoryWindow onClose={() => closePopoutPage(() => router.push("/mod"))} />;
}
