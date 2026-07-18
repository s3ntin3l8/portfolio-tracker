import { Icon, ICONS } from "../icon";
import { cardStyle, type OnboardingTheme } from "../theme";

export interface TaxOptionCopy {
  code: "DE" | "ID";
  name: string;
  desc: string;
}

/** Step 2 — Tax regime: DE / ID selectable cards. */
export function TaxStep({
  th,
  options,
  taxRegime,
  onSelect,
}: {
  th: OnboardingTheme;
  options: TaxOptionCopy[];
  taxRegime: "DE" | "ID";
  onSelect: (regime: "DE" | "ID") => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 26 }}>
      {options.map((o) => {
        const selected = o.code === taxRegime;
        return (
          <button
            key={o.code}
            type="button"
            onClick={() => onSelect(o.code)}
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
              <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    font: "700 12px 'DM Mono',ui-monospace,monospace",
                    color: th.kicker,
                    background: th.chipBg,
                    borderRadius: 7,
                    padding: "4px 8px",
                  }}
                >
                  {o.code}
                </span>
                <span style={{ font: "700 14.5px 'Plus Jakarta Sans'", color: th.headColor }}>
                  {o.name}
                </span>
              </span>
              {selected && <Icon d={ICONS.check} size={18} stroke="#0E9F6E" strokeWidth={2.4} />}
            </div>
            <p
              style={{
                font: "500 12.5px/1.5 'Plus Jakarta Sans'",
                color: th.subColor,
                margin: "8px 0 0",
              }}
            >
              {o.desc}
            </p>
          </button>
        );
      })}
    </div>
  );
}
