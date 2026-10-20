import Link from "next/link";

// Where both sign-in callbacks send a deleted account (accountDeletedForSignIn). A deletion
// cannot be undone, so this page only says so — it offers no way back in.
export default function AccountDeletedPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-full flex items-center justify-center py-10">
        <div className="flex flex-col gap-4 w-full max-w-sm px-4 text-center">
          <h1 className="text-2xl font-bold">This account was deleted</h1>
          <p className="text-sm text-secondary">
            It can&apos;t be signed in to again — deleting an account can&apos;t be undone. To join
            again, sign up with a new account.
          </p>
          <Link href="/" className="text-sm text-secondary hover:text-strong underline transition-colors">
            Back to the home page
          </Link>
        </div>
      </div>
    </div>
  );
}
