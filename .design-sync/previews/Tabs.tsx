import { Tabs, TabsList, TabsTrigger, TabsContent } from "@portfolio/web";

export function PortfolioTabs() {
  return (
    <Tabs defaultValue="holdings">
      <TabsList>
        <TabsTrigger value="holdings">Holdings</TabsTrigger>
        <TabsTrigger value="transactions">Transactions</TabsTrigger>
        <TabsTrigger value="performance">Performance</TabsTrigger>
      </TabsList>
      <TabsContent value="holdings">
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between rounded-md border border-border p-3">
            <span>VWCE — 84 shares</span>
            <span className="font-medium">€8,601.60</span>
          </div>
          <div className="flex justify-between rounded-md border border-border p-3">
            <span>Antam Gold — 25.0 g</span>
            <span className="font-medium">Rp 31,125,000</span>
          </div>
        </div>
      </TabsContent>
      <TabsContent value="transactions">
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between rounded-md border border-border p-3">
            <span>Buy 12 VWCE</span>
            <span className="text-muted-foreground">2026-07-12</span>
          </div>
          <div className="flex justify-between rounded-md border border-border p-3">
            <span>Dividend AAPL €4.12</span>
            <span className="text-muted-foreground">2026-07-14</span>
          </div>
        </div>
      </TabsContent>
      <TabsContent value="performance">
        <div className="flex justify-between rounded-md border border-border p-3 text-sm">
          <span>XIRR (1Y)</span>
          <span className="font-medium">+9.4%</span>
        </div>
      </TabsContent>
    </Tabs>
  );
}

export function ImportReviewTabs() {
  return (
    <Tabs defaultValue="pending">
      <TabsList>
        <TabsTrigger value="pending">Pending</TabsTrigger>
        <TabsTrigger value="confirmed">Confirmed</TabsTrigger>
        <TabsTrigger value="errors">Errors</TabsTrigger>
      </TabsList>
      <TabsContent value="pending">
        <p className="text-sm text-muted-foreground">
          3 draft transactions from Trade_Republic_2026-07.csv awaiting confirmation.
        </p>
      </TabsContent>
      <TabsContent value="confirmed">
        <p className="text-sm text-muted-foreground">
          12 transactions confirmed and written to Retirement (EUR).
        </p>
      </TabsContent>
      <TabsContent value="errors">
        <p className="text-sm text-destructive">
          1 row could not be matched to an instrument — WKN A2N7YM.
        </p>
      </TabsContent>
    </Tabs>
  );
}

export function TaxTabs() {
  return (
    <Tabs defaultValue="realized">
      <TabsList>
        <TabsTrigger value="realized">Realized</TabsTrigger>
        <TabsTrigger value="unrealized">Unrealized</TabsTrigger>
      </TabsList>
      <TabsContent value="realized">
        <div className="flex justify-between rounded-md border border-border p-3 text-sm">
          <span>Realized gain (2026, DE)</span>
          <span className="font-medium">€612.30</span>
        </div>
      </TabsContent>
      <TabsContent value="unrealized">
        <div className="flex justify-between rounded-md border border-border p-3 text-sm">
          <span>Unrealized gain</span>
          <span className="font-medium">€1,904.12</span>
        </div>
      </TabsContent>
    </Tabs>
  );
}
