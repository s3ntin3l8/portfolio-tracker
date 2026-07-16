import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TABLE_VALUE,
  TABLE_VALUE_STRONG,
  Badge,
} from "@portfolio/web";

const HOLDINGS = [
  {
    name: "Vanguard FTSE All-World",
    ticker: "VWCE",
    qty: "184",
    price: "€112.30",
    value: "€20,663.20",
    gain: "+12.4%",
    cls: "Equities",
  },
  {
    name: "Antam Gold Bar 10g",
    ticker: "XAU",
    qty: "3",
    price: "€612.80",
    value: "€1,838.40",
    gain: "+6.1%",
    cls: "Gold",
  },
  {
    name: "iShares Core € Corp Bond",
    ticker: "IEAC",
    qty: "40",
    price: "€98.10",
    value: "€3,924.00",
    gain: "-0.8%",
    cls: "Bonds",
  },
];

export function Holdings() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Instrument</TableHead>
          <TableHead>Class</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead className="text-right">Gain</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {HOLDINGS.map((h) => (
          <TableRow key={h.ticker}>
            <TableCell className="font-medium">
              {h.name}
              <div className="text-xs text-text-2">{h.ticker}</div>
            </TableCell>
            <TableCell>
              <Badge variant="outline">{h.cls}</Badge>
            </TableCell>
            <TableCell className={TABLE_VALUE}>{h.qty}</TableCell>
            <TableCell className={TABLE_VALUE}>{h.price}</TableCell>
            <TableCell className={TABLE_VALUE_STRONG}>{h.value}</TableCell>
            <TableCell
              className={
                h.gain.startsWith("-")
                  ? "tabular text-right text-[13px] font-medium text-destructive"
                  : "tabular text-right text-[13px] font-medium text-success"
              }
            >
              {h.gain}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
