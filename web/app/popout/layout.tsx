import { MatrixClientProvider } from "@/app/lib/MatrixClientContext";

export default function PopoutLayout({ children }: { children: React.ReactNode }) {
  return (
    <MatrixClientProvider>
      <div className="h-full">{children}</div>
    </MatrixClientProvider>
  );
}
