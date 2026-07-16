import { Sheet, SheetContent, SheetHeader, SheetTitle, Button } from "@portfolio/web";

export function TransactionDetailSheet() {
  return (
    <Sheet open>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Buy — VWCE</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 p-6 pt-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Quantity</span>
            <span className="font-medium">12 shares</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Price</span>
            <span className="font-medium">€102.40</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-medium">€1,228.80</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Source</span>
            <span className="font-medium">Trade Republic</span>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function ConfirmImportSheet() {
  return (
    <Sheet open>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Confirm import</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 p-6 pt-4">
          <p className="text-sm text-muted-foreground">
            3 transactions parsed from Trade_Republic_2026-07.csv
          </p>
          <div className="rounded-md border border-border p-3 text-sm">
            Buy 12 VWCE @ €102.40 — 2026-07-12
          </div>
          <div className="rounded-md border border-border p-3 text-sm">
            Dividend AAPL €4.12 — 2026-07-14
          </div>
          <div className="rounded-md border border-border p-3 text-sm">
            Buy 0.05 XAU (Gold) @ €68.20/g — 2026-07-15
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline">Discard</Button>
            <Button>Confirm all</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function EditHoldingSheet() {
  return (
    <Sheet open>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit cost basis — Antam Gold</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 p-6 pt-4 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Quantity (grams)</span>
            <input
              className="rounded-md border border-border bg-background px-3 py-2"
              defaultValue="25.0"
              readOnly
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Avg. cost per gram</span>
            <input
              className="rounded-md border border-border bg-background px-3 py-2"
              defaultValue="Rp 1,245,000"
              readOnly
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline">Cancel</Button>
            <Button>Save</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
