// Mock data for the design-system screens. Replaced by the typed api-client later.

export type AssetClass = "equity" | "etf" | "gold" | "bond" | "mutual_fund" | "cash";

export interface Holding {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  quantity: number;
  unit: "shares" | "grams" | "units" | "";
  avgCost: number;
  price: number;
  currency: string;
}

export const holdings: Holding[] = [
  { id: "h1", symbol: "BBCA", name: "Bank Central Asia", assetClass: "equity", quantity: 200, unit: "shares", avgCost: 9000, price: 9500, currency: "IDR" },
  { id: "h2", symbol: "TLKM", name: "Telkom Indonesia", assetClass: "equity", quantity: 1000, unit: "shares", avgCost: 3500, price: 3800, currency: "IDR" },
  { id: "h3", symbol: "GOLD", name: "Antam Gold (Tabungan Emas)", assetClass: "gold", quantity: 25, unit: "grams", avgCost: 1000000, price: 1150000, currency: "IDR" },
  { id: "h4", symbol: "ORI023", name: "Obligasi Negara Ritel 023", assetClass: "bond", quantity: 50, unit: "units", avgCost: 100000, price: 100000, currency: "IDR" },
  { id: "h5", symbol: "RDPU", name: "Reksa Dana Pasar Uang", assetClass: "mutual_fund", quantity: 1500, unit: "units", avgCost: 1100, price: 1200, currency: "IDR" },
];

export const cashBalance = { currency: "IDR", amount: 3250000 };

export const marketValue = (h: Holding) => h.quantity * h.price;
export const costBasis = (h: Holding) => h.quantity * h.avgCost;
export const unrealizedPnL = (h: Holding) => marketValue(h) - costBasis(h);

export interface AllocationSlice {
  key: AssetClass;
  label: string;
  value: number;
}

export function getAllocation(): AllocationSlice[] {
  const byClass = new Map<AssetClass, number>();
  for (const h of holdings) {
    byClass.set(h.assetClass, (byClass.get(h.assetClass) ?? 0) + marketValue(h));
  }
  byClass.set("cash", (byClass.get("cash") ?? 0) + cashBalance.amount);
  const labels: Record<AssetClass, string> = {
    equity: "Equities",
    etf: "ETFs",
    gold: "Gold",
    bond: "Bonds",
    mutual_fund: "Mutual funds",
    cash: "Cash",
  };
  return (Object.keys(labels) as AssetClass[])
    .filter((k) => byClass.has(k))
    .map((key) => ({ key, label: labels[key], value: byClass.get(key) ?? 0 }));
}

export const netWorth =
  holdings.reduce((sum, h) => sum + marketValue(h), 0) + cashBalance.amount;

export const summary = {
  netWorth,
  currency: "IDR",
  dayChange: 412000,
  dayChangePct: 0.0094,
  totalPnL: holdings.reduce((sum, h) => sum + unrealizedPnL(h), 0),
  get totalPnLPct() {
    const cost = holdings.reduce((sum, h) => sum + costBasis(h), 0);
    return this.totalPnL / cost;
  },
};

export interface ValuePoint {
  month: string;
  value: number;
}

export const valueOverTime: ValuePoint[] = [
  { month: "Jul", value: 36800000 },
  { month: "Aug", value: 37500000 },
  { month: "Sep", value: 39100000 },
  { month: "Oct", value: 38600000 },
  { month: "Nov", value: 40900000 },
  { month: "Dec", value: 41700000 },
  { month: "Jan", value: 43200000 },
  { month: "Feb", value: 44500000 },
];

export interface Mover {
  symbol: string;
  name: string;
  changePct: number;
}

export const topMovers: Mover[] = [
  { symbol: "GOLD", name: "Antam Gold", changePct: 0.021 },
  { symbol: "TLKM", name: "Telkom Indonesia", changePct: 0.013 },
  { symbol: "BBCA", name: "Bank Central Asia", changePct: 0.004 },
  { symbol: "RDPU", name: "Reksa Dana Pasar Uang", changePct: -0.002 },
];

export interface MockTransaction {
  id: string;
  date: string;
  type: "buy" | "sell" | "dividend" | "deposit";
  symbol: string;
  name: string;
  assetClass: AssetClass;
  quantity: number;
  price: number;
  currency: string;
  source: "screenshot" | "csv" | "manual";
}

export const transactions: MockTransaction[] = [
  { id: "t1", date: "2026-02-08", type: "buy", symbol: "GOLD", name: "Antam Gold", assetClass: "gold", quantity: 5, price: 1140000, currency: "IDR", source: "screenshot" },
  { id: "t2", date: "2026-02-03", type: "buy", symbol: "BBCA", name: "Bank Central Asia", assetClass: "equity", quantity: 100, price: 9450, currency: "IDR", source: "screenshot" },
  { id: "t3", date: "2026-01-28", type: "dividend", symbol: "TLKM", name: "Telkom Indonesia", assetClass: "equity", quantity: 0, price: 95000, currency: "IDR", source: "manual" },
  { id: "t4", date: "2026-01-20", type: "buy", symbol: "RDPU", name: "Reksa Dana Pasar Uang", assetClass: "mutual_fund", quantity: 500, price: 1180, currency: "IDR", source: "csv" },
  { id: "t5", date: "2026-01-15", type: "deposit", symbol: "—", name: "Cash deposit", assetClass: "cash", quantity: 0, price: 5000000, currency: "IDR", source: "manual" },
];
