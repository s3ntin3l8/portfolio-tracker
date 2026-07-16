import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Locale-aware Link / navigation (auto-prefixes the active locale).
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
