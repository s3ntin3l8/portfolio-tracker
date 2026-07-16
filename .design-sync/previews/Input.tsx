import { Input } from "@portfolio/web";

export function Default() {
  return <Input placeholder="Search instruments (e.g. VWCE, gold, DKB)" />;
}

export function WithValue() {
  return <Input defaultValue="1,000.00" placeholder="Amount (EUR)" />;
}

export function Types() {
  return (
    <div className="flex flex-col gap-2">
      <Input type="text" placeholder="Portfolio name" />
      <Input type="number" placeholder="Quantity" defaultValue="12.5" />
      <Input type="date" defaultValue="2026-07-16" />
    </div>
  );
}

export function Disabled() {
  return <Input disabled placeholder="Cash balance (EUR)" defaultValue="4,250.00" />;
}
