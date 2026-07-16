export interface IndexPoint {
  date: string;
  index: string;
}

export function dailyReturns(points: IndexPoint[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = Number(points[i - 1].index);
    const curr = Number(points[i].index);
    if (prev === 0) {
      result.push(0);
    } else {
      result.push(curr / prev - 1);
    }
  }
  return result;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  const mu = mean(values);
  const sqDiffs = values.map((v) => (v - mu) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / (values.length - 1));
}

function annualizedReturn(dailyRets: number[], periodsPerYear: number): number {
  const totalReturn = dailyRets.reduce((acc, r) => acc * (1 + r), 1);
  const n = dailyRets.length;
  return Math.pow(totalReturn, periodsPerYear / n) - 1;
}

export function annualizedVolatility(returns: number[], periodsPerYear = 252): number | null {
  if (returns.length < 2) return null;
  return stddev(returns) * Math.sqrt(periodsPerYear);
}

export function sharpeRatio(
  returns: number[],
  riskFreeRate: number,
  periodsPerYear = 252,
): number | null {
  if (returns.length < 2) return null;
  const annVol = annualizedVolatility(returns, periodsPerYear);
  if (annVol === null || annVol === 0) return null;
  const annRet = annualizedReturn(returns, periodsPerYear);
  return (annRet - riskFreeRate) / annVol;
}

function downsideDeviation(returns: number[], periodsPerYear: number): number {
  const negative = returns.filter((r) => r < 0);
  if (negative.length < 2) return 0;
  const sqDiffs = negative.map((v) => v ** 2);
  return (
    Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / (negative.length - 1)) *
    Math.sqrt(periodsPerYear)
  );
}

export function sortinoRatio(
  returns: number[],
  riskFreeRate: number,
  periodsPerYear = 252,
): number | null {
  if (returns.length < 2) return null;
  const annRet = annualizedReturn(returns, periodsPerYear);
  const dd = downsideDeviation(returns, periodsPerYear);
  if (dd === 0) return null;
  return (annRet - riskFreeRate) / dd;
}
