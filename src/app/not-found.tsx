import Link from "next/link";

import { SecretaryAvatar } from "@/components/secretary-avatar";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-4 text-center">
      <SecretaryAvatar />
      <h1 className="mt-4 text-xl font-semibold">Sorry, Boss, I couldn’t find that.</h1>
      <p className="mt-1 text-muted-foreground">The page or task does not exist, or it is not yours.</p>
      <Link href="/tasks" className={buttonVariants({ size: "lg", className: "mt-6" })}>
        Back to my tasks
      </Link>
    </main>
  );
}
