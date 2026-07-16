import { Button } from "@portfolio/web";

export function Primary() {
  return <Button>Confirm import</Button>;
}

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="default">Buy VWCE</Button>
      <Button variant="secondary">Sell</Button>
      <Button variant="outline">Edit portfolio</Button>
      <Button variant="ghost">Skip</Button>
      <Button variant="destructive">Delete transaction</Button>
      <Button variant="link">View details</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm">Add holding</Button>
      <Button size="default">Add holding</Button>
      <Button size="lg">Add holding</Button>
      <Button size="icon" aria-label="Refresh prices">
        ↻
      </Button>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled>Confirm import</Button>
      <Button variant="outline" disabled>
        Sync Trade Republic
      </Button>
    </div>
  );
}
