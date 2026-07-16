import { Badge } from "@portfolio/web";

export function Variants() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>Equities</Badge>
      <Badge variant="outline">Bonds</Badge>
      <Badge variant="success">Confirmed</Badge>
      <Badge variant="warning">Pending</Badge>
      <Badge variant="destructive">Failed</Badge>
    </div>
  );
}

export function AssetClasses() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>Equities</Badge>
      <Badge>Gold</Badge>
      <Badge>Bonds</Badge>
      <Badge>Mutual Funds</Badge>
      <Badge>Cash</Badge>
    </div>
  );
}
