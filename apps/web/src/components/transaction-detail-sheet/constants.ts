import type { LucideIcon } from "lucide-react";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Coins,
  Receipt,
  Scale,
  Split,
} from "lucide-react";

export const TYPE_BADGE: Record<string, { icon: LucideIcon; bg: string; fg: string }> = {
  buy: { icon: ArrowRight, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  savings_plan: { icon: ArrowRight, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  sell: { icon: ArrowLeft, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  dividend: { icon: Coins, bg: "rgba(224,165,58,.16)", fg: "var(--gold-fg)" },
  coupon: { icon: Coins, bg: "rgba(224,165,58,.16)", fg: "var(--gold-fg)" },
  interest: { icon: ArrowDownLeft, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  deposit: { icon: ArrowDownLeft, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  bonus_cash: { icon: ArrowDownLeft, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  loan_drawdown: { icon: ArrowDownLeft, bg: "rgba(16,163,114,.14)", fg: "#0E9F6E" },
  withdrawal: { icon: ArrowUpRight, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  fee: { icon: ArrowUpRight, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  tax: { icon: ArrowUpRight, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  loan_repayment: { icon: ArrowUpRight, bg: "rgba(229,72,77,.15)", fg: "#E5484D" },
  split: { icon: Split, bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  bonus: { icon: Split, bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  rights: { icon: Split, bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  transfer_in: { icon: ArrowLeftRight, bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  transfer_out: { icon: ArrowLeftRight, bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  adjustment: { icon: Scale, bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
};

export const DEFAULT_BADGE = { icon: Receipt, bg: "var(--border)", fg: "var(--text-mute)" };

export const SOURCE_PILL: Record<string, { bg: string; fg: string }> = {
  screenshot: { bg: "rgba(124,92,252,.16)", fg: "#7C5CFC" },
  csv: { bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  pytr: { bg: "rgba(13,148,136,.16)", fg: "#0D9488" },
  pdf: { bg: "rgba(229,72,77,.13)", fg: "#E5484D" },
};

export const DEFAULT_PILL = { bg: "var(--border)", fg: "var(--text-mute)" };
