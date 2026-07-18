import { Icon, ICONS } from "../icon";
import { cardStyle, type OnboardingTheme } from "../theme";
import styles from "../onboarding.module.css";

// Verbatim from the design's `brokerageList` — kept as-is (not swapped for the app's
// real `KNOWN_BROKERAGES`) since the design's exact copy/list is authoritative here.
const BROKERAGE_LIST = [
  "Trade Republic",
  "Interactive Brokers",
  "DKB",
  "Coinbase",
  "Degiro",
  "Scalable Capital",
  "Bitpanda",
];

const CURRENCY_OPTIONS = ["IDR", "USD", "EUR", "SGD"];

export interface PortfolioCopy {
  nameLabel: string;
  namePlaceholder: string;
  brokerageLabel: string;
  brokerageOptional: string;
  brokeragePlaceholder: string;
  currencyLabel: string;
  cashLabel: string;
  cashInvestOnly: string;
  cashInvestOnlyDesc: string;
  cashSavings: string;
  cashSavingsDesc: string;
  cashHelper: string;
}

/** Step 3 — Create portfolio: name, brokerage autocomplete, base currency, cash-counting choice. */
export function PortfolioStep({
  th,
  isDark,
  copy,
  portfolioName,
  portfolioNameError,
  onPortfolioNameChange,
  brokerageValue,
  brokerageOpen,
  onBrokerageChange,
  onBrokerageFocus,
  onBrokerageToggle,
  onBrokerageBlur,
  onSelectBrokerage,
  currency,
  onCurrencyChange,
  cashCounted,
  onCashCountedChange,
}: {
  th: OnboardingTheme;
  isDark: boolean;
  copy: PortfolioCopy;
  portfolioName: string;
  portfolioNameError?: string;
  onPortfolioNameChange: (value: string) => void;
  brokerageValue: string;
  brokerageOpen: boolean;
  onBrokerageChange: (value: string) => void;
  onBrokerageFocus: () => void;
  onBrokerageToggle: () => void;
  onBrokerageBlur: () => void;
  onSelectBrokerage: (name: string) => void;
  currency: string;
  onCurrencyChange: (code: string) => void;
  cashCounted: boolean;
  onCashCountedChange: (value: boolean) => void;
}) {
  const cashOptions = [
    { key: false as const, title: copy.cashInvestOnly, desc: copy.cashInvestOnlyDesc },
    { key: true as const, title: copy.cashSavings, desc: copy.cashSavingsDesc },
  ];
  const q = brokerageValue.trim().toLowerCase();
  const matches = BROKERAGE_LIST.filter((name) => !q || name.toLowerCase().includes(q));

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <label
          style={{
            display: "block",
            font: "600 12px 'Plus Jakarta Sans'",
            color: th.labelColor,
            margin: "0 2px 6px",
          }}
        >
          {copy.nameLabel}
        </label>
        <input
          className={`${styles[th.inputClass]} ${portfolioNameError ? styles.inputError : ""}`}
          placeholder={copy.namePlaceholder}
          value={portfolioName}
          onChange={(e) => onPortfolioNameChange(e.target.value)}
        />
        {portfolioNameError && <p className={styles.errorText}>{portfolioNameError}</p>}
      </div>

      <div style={{ marginBottom: 18, position: "relative" }}>
        <label
          style={{
            display: "block",
            font: "600 12px 'Plus Jakarta Sans'",
            color: th.labelColor,
            margin: "0 2px 6px",
          }}
        >
          {copy.brokerageLabel}{" "}
          <span style={{ fontWeight: 500, color: th.dividerText }}>{copy.brokerageOptional}</span>
        </label>
        <div style={{ position: "relative" }}>
          <input
            className={styles[th.inputClass]}
            style={{ paddingRight: 40 }}
            placeholder={copy.brokeragePlaceholder}
            value={brokerageValue}
            onChange={(e) => onBrokerageChange(e.target.value)}
            onFocus={onBrokerageFocus}
            onBlur={onBrokerageBlur}
          />
          <span
            onClick={onBrokerageToggle}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              height: "100%",
              width: 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: th.dividerText,
            }}
          >
            <svg
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: brokerageOpen ? "rotate(180deg)" : "none",
                transition: "transform .15s",
              }}
              aria-hidden
            >
              <path d={ICONS.chevronDown} />
            </svg>
          </span>
        </div>
        {brokerageOpen && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: "calc(100% + 6px)",
              zIndex: 10,
              background: th.panelBg,
              border: `1px solid ${th.dividerLine}`,
              borderRadius: 12,
              padding: 6,
              boxShadow: isDark ? "0 16px 34px rgba(0,0,0,.5)" : "0 16px 34px rgba(17,33,26,.14)",
              maxHeight: 224,
              overflowY: "auto",
            }}
          >
            {matches.map((name) => (
              <button
                key={name}
                type="button"
                // preventDefault so the input's blur (and its close-dropdown timeout)
                // doesn't fire before this click is registered — matches the design's
                // onMouseDown + e.preventDefault() pattern.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectBrokerage(name);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  padding: "9px 10px",
                  borderRadius: 9,
                  cursor: "pointer",
                  transition: "background .12s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = th.chipBg)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    flexShrink: 0,
                    borderRadius: 7,
                    background: th.chipBg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon d={ICONS.building} size={14} stroke={th.kicker} />
                </span>
                <span style={{ font: "600 13.5px 'Plus Jakarta Sans'", color: th.headColor }}>
                  {name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 22 }}>
        <label
          style={{
            display: "block",
            font: "600 12px 'Plus Jakarta Sans'",
            color: th.labelColor,
            margin: "0 2px 8px",
          }}
        >
          {copy.currencyLabel}
        </label>
        <div style={{ display: "flex", gap: 7 }}>
          {CURRENCY_OPTIONS.map((code) => {
            const selected = code === currency;
            return (
              <button
                key={code}
                type="button"
                onClick={() => onCurrencyChange(code)}
                style={{
                  border: "none",
                  borderRadius: 9,
                  padding: "9px 14px",
                  font: "700 12.5px 'Plus Jakarta Sans'",
                  cursor: "pointer",
                  transition: "background .15s",
                  background: selected ? "#0E9F6E" : th.chipBg,
                  color: selected ? "#fff" : th.chipText,
                }}
              >
                {code}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: 8 }}>
        <label
          style={{
            display: "block",
            font: "600 12px 'Plus Jakarta Sans'",
            color: th.labelColor,
            margin: "0 2px 8px",
          }}
        >
          {copy.cashLabel}
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {cashOptions.map((o) => {
            const selected = o.key === cashCounted;
            return (
              <button
                key={String(o.key)}
                type="button"
                onClick={() => onCashCountedChange(o.key)}
                style={cardStyle(th, selected)}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ font: "700 14px 'Plus Jakarta Sans'", color: th.headColor }}>
                    {o.title}
                  </span>
                  {selected && (
                    <Icon d={ICONS.check} size={17} stroke="#0E9F6E" strokeWidth={2.4} />
                  )}
                </div>
                <p
                  style={{
                    font: "500 12.5px/1.5 'Plus Jakarta Sans'",
                    color: th.subColor,
                    margin: "6px 0 0",
                  }}
                >
                  {o.desc}
                </p>
              </button>
            );
          })}
        </div>
        <p
          style={{
            font: "500 11.5px 'Plus Jakarta Sans'",
            color: th.dividerText,
            margin: "10px 2px 0",
          }}
        >
          {copy.cashHelper}
        </p>
      </div>
    </>
  );
}
