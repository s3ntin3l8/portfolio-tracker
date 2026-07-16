import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
} from "@portfolio/web";

export function Default() {
  return (
    <Card className="w-80">
      <CardHeader>
        <CardTitle>Net worth</CardTitle>
        <CardDescription>Across all portfolios, incl. cash</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold tabular-nums">€128,940.55</p>
        <p className="text-sm text-success">+€2,410.12 (1.9%) this month</p>
      </CardContent>
    </Card>
  );
}

export function WithFooter() {
  return (
    <Card className="w-80">
      <CardHeader>
        <CardTitle>Freistellungsauftrag</CardTitle>
        <CardDescription>2026 allowance, this portfolio</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold tabular-nums">€740 / €1,000</p>
      </CardContent>
      <CardFooter>
        <Button variant="outline" size="sm">
          Adjust allocation
        </Button>
      </CardFooter>
    </Card>
  );
}
