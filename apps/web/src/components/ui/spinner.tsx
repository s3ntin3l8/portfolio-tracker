import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  xs: "size-3.5",
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
  xl: "size-7",
} as const;
function Spinner({
  size = "md",
  className,
  ...props
}: React.ComponentProps<"svg"> & { size?: keyof typeof SIZES }) {
  return <Loader2 className={cn("animate-spin text-primary", SIZES[size], className)} {...props} />;
}

export { Spinner };
