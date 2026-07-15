export interface IndexPoint {
  date: string;
  index: string;
}

export interface Streak {
  length: number;
  totalReturnPct: string;
  start: string;
  end: string;
}

export interface StreakResult {
  bestStreak: Streak | null;
  worstStreak: Streak | null;
  bestMonth: { date: string; returnPct: string } | null;
  worstMonth: { date: string; returnPct: string } | null;
  bestYear: { year: number; returnPct: string } | null;
  worstYear: { year: number; returnPct: string } | null;
  positiveMonths: number;
  negativeMonths: number;
  totalMonths: number;
}

function monthlyReturns(points: IndexPoint[]): { date: string; returnPct: number }[] {
  const result: { date: string; returnPct: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = Number(points[i - 1].index);
    const curr = Number(points[i].index);
    const ret = prev !== 0 ? curr / prev - 1 : 0;
    result.push({ date: points[i].date, returnPct: ret });
  }
  return result;
}

export function streakAnalysis(points: IndexPoint[]): StreakResult {
  const months = monthlyReturns(points);

  let bestStreak: Streak | null = null;
  let worstStreak: Streak | null = null;
  let positiveMonths = 0;
  let negativeMonths = 0;

  let i = 0;
  while (i < months.length) {
    const isPositive = months[i].returnPct >= 0;
    let j = i;
    let compoundReturn = 1;
    while (j < months.length && (months[j].returnPct >= 0) === isPositive) {
      compoundReturn *= 1 + months[j].returnPct;
      j++;
    }
    const length = j - i;
    const totalReturn = compoundReturn - 1;

    if (isPositive) {
      positiveMonths += length;
      if (!bestStreak || length > bestStreak.length) {
        bestStreak = {
          length,
          totalReturnPct: String(totalReturn),
          start: months[i].date,
          end: months[j - 1].date,
        };
      }
    } else {
      negativeMonths += length;
      if (!worstStreak || length > worstStreak.length) {
        worstStreak = {
          length,
          totalReturnPct: String(totalReturn),
          start: months[i].date,
          end: months[j - 1].date,
        };
      }
    }
    i = j;
  }

  let bestMonth: { date: string; returnPct: string } | null = null;
  let worstMonth: { date: string; returnPct: string } | null = null;
  for (const m of months) {
    if (!bestMonth || m.returnPct > Number(bestMonth.returnPct)) {
      bestMonth = { date: m.date.slice(0, 7), returnPct: String(m.returnPct) };
    }
    if (!worstMonth || m.returnPct < Number(worstMonth.returnPct)) {
      worstMonth = { date: m.date.slice(0, 7), returnPct: String(m.returnPct) };
    }
  }

  const years = new Map<number, { start: number; end: number }>();
  for (const p of points) {
    const year = Number(p.date.slice(0, 4));
    const value = Number(p.index);
    if (!years.has(year)) {
      years.set(year, { start: value, end: value });
    } else {
      const y = years.get(year)!;
      y.end = value;
    }
  }

  let bestYear: { year: number; returnPct: string } | null = null;
  let worstYear: { year: number; returnPct: string } | null = null;
  for (const [year, { start, end }] of years) {
    const ret = start !== 0 ? end / start - 1 : 0;
    if (!bestYear || ret > Number(bestYear.returnPct)) {
      bestYear = { year, returnPct: String(ret) };
    }
    if (!worstYear || ret < Number(worstYear.returnPct)) {
      worstYear = { year, returnPct: String(ret) };
    }
  }

  return {
    bestStreak,
    worstStreak,
    bestMonth,
    worstMonth,
    bestYear,
    worstYear,
    positiveMonths,
    negativeMonths,
    totalMonths: months.length,
  };
}
