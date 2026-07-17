import { loans, transactions } from "@portfolio/db";
import { toDateKey } from "@portfolio/core";
import type { ParsedGoldContract } from "@portfolio/schema";
import {
  buildContractLegs,
  goldInstrumentForContract,
} from "../../services/parsers/gold-contract.js";
import { findOrCreateInstrument } from "../../services/instruments.js";

export async function writeGoldContracts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  opts: {
    contracts: ParsedGoldContract[];
    targetPortfolioId: string;
    importId: string;
    source: string;
    requestLog?: { debug: (...args: unknown[]) => void };
  },
): Promise<{ written: (typeof transactions.$inferSelect)[]; attempted: number }> {
  const { contracts, targetPortfolioId, importId, source, requestLog } = opts;
  const written: (typeof transactions.$inferSelect)[] = [];
  let attempted = 0;
  const now = new Date();

  for (let ci = 0; ci < contracts.length; ci++) {
    const c = contracts[ci];
    const gold = goldInstrumentForContract(c);
    const instrument = await findOrCreateInstrument(tx, {
      symbol: gold.symbol,
      market: gold.market,
      assetClass: "gold",
      unit: "grams",
      currency: c.currency,
      name: gold.name,
      isin: null,
    });
    const [loan] = await tx
      .insert(loans)
      .values({
        portfolioId: targetPortfolioId,
        instrumentId: instrument.id,
        importId,
        contractNo: c.contractNo ?? null,
        provider: c.provider ?? "GALERI24",
        purchasePrice: c.purchasePrice,
        downPayment: c.downPayment,
        adminFee: c.adminFee,
        discount: c.discount,
        principal: c.principal,
        marginTotal: c.marginTotal,
        tenorMonths: c.tenorMonths,
        monthlyInstallment: c.monthlyInstallment,
        startDate: toDateKey(c.startDate),
        schedule: c.schedule.map(
          (r: {
            n: number;
            dueDate: Date;
            pokok: string;
            sewaModal: string;
            angsuran: string;
            sisaPokok: string;
          }) => ({
            n: r.n,
            dueDate: toDateKey(r.dueDate),
            pokok: r.pokok,
            sewaModal: r.sewaModal,
            angsuran: r.angsuran,
            sisaPokok: r.sisaPokok,
          }),
        ),
        costBasisMode: c.costBasisMode,
        currency: c.currency,
      })
      .returning();

    const legs = buildContractLegs(c, now);
    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li];
      attempted++;
      const externalId = `import:${importId}:loan:${ci}:${li}`;
      const [row] = await tx
        .insert(transactions)
        .values({
          portfolioId: targetPortfolioId,
          instrumentId: leg.role === "gold_buy" ? instrument.id : null,
          type: leg.type,
          quantity: leg.quantity,
          price: leg.price,
          fees: leg.fees,
          currency: leg.currency,
          executedAt: leg.executedAt,
          source,
          importId,
          loanId: loan.id,
          externalId,
        })
        .onConflictDoNothing()
        .returning();
      if (row) written.push(row);
      else requestLog?.debug({ externalId }, "duplicate skipped");
    }
  }

  return { written, attempted };
}
