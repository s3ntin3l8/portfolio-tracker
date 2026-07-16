import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  SortableTableHead,
} from "@portfolio/web";

const HOLDINGS = [
  { name: "Vanguard FTSE All-World", qty: "184", value: "€20,663.20", gain: "+12.4%" },
  { name: "Antam Gold Bar 10g", qty: "3", value: "€1,838.40", gain: "+6.1%" },
  { name: "iShares Core € Corp Bond", qty: "40", value: "€3,924.00", gain: "-0.8%" },
];

export function SortedAscending() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead colKey="name" sortKey="name" sortDir="asc" onToggle={() => {}}>
            Instrument
          </SortableTableHead>
          <SortableTableHead
            colKey="qty"
            sortKey="name"
            sortDir="asc"
            onToggle={() => {}}
            align="right"
          >
            Qty
          </SortableTableHead>
          <SortableTableHead
            colKey="value"
            sortKey="name"
            sortDir="asc"
            onToggle={() => {}}
            align="right"
          >
            Value
          </SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {HOLDINGS.map((h) => (
          <TableRow key={h.name}>
            <TableCell className="font-medium">{h.name}</TableCell>
            <TableCell className="text-right">{h.qty}</TableCell>
            <TableCell className="text-right">{h.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function SortedDescendingByValue() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead colKey="name" sortKey="value" sortDir="desc" onToggle={() => {}}>
            Instrument
          </SortableTableHead>
          <SortableTableHead
            colKey="gain"
            sortKey="value"
            sortDir="desc"
            onToggle={() => {}}
            align="right"
          >
            Gain
          </SortableTableHead>
          <SortableTableHead
            colKey="value"
            sortKey="value"
            sortDir="desc"
            onToggle={() => {}}
            align="right"
          >
            Value
          </SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {HOLDINGS.map((h) => (
          <TableRow key={h.name}>
            <TableCell className="font-medium">{h.name}</TableCell>
            <TableCell className="text-right">{h.gain}</TableCell>
            <TableCell className="text-right">{h.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Unsorted() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead colKey="name" sortKey={null} sortDir={null} onToggle={() => {}}>
            Instrument
          </SortableTableHead>
          <SortableTableHead
            colKey="qty"
            sortKey={null}
            sortDir={null}
            onToggle={() => {}}
            align="right"
          >
            Qty
          </SortableTableHead>
          <SortableTableHead
            colKey="value"
            sortKey={null}
            sortDir={null}
            onToggle={() => {}}
            align="right"
          >
            Value
          </SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {HOLDINGS.map((h) => (
          <TableRow key={h.name}>
            <TableCell className="font-medium">{h.name}</TableCell>
            <TableCell className="text-right">{h.qty}</TableCell>
            <TableCell className="text-right">{h.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
