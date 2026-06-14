"use client";

import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/** Signs the user out and returns to the landing page. */
export function SignOutButton() {
  const t = useTranslations("Settings");
  return (
    <Button variant="outline" onClick={() => signOut({ callbackUrl: "/" })}>
      <LogOut className="size-4" />
      {t("signOut")}
    </Button>
  );
}
