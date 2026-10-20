import SignInForm from "./SignInForm";
import { signupState } from "./signInOptions";
import { federatedSignInMode } from "@/app/lib/federatedSignInSwitch";
import { instanceString } from "@/app/lib/instanceConfigServer";
import { hostRequestsAvailable } from "@/app/lib/hostRequests";

// Read per request: the federated sign-in mode and the sign-up switch are settings the Admin Panel
// changes at any time, and a page built once would keep saying what they were.
export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <SignInForm options={{
      federated: federatedSignInMode(),
      signup: signupState({
        bundle: hostRequestsAvailable(),
        registration: instanceString("matrix.registration"),
        setupDone: !!instanceString("setup.completedAt"),
      }),
    }} />
  );
}
