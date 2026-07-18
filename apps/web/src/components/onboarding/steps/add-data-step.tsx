import { Icon, ICONS } from "../icon";
import type { OnboardingTheme } from "../theme";

export type AddDataCardKey = "connect" | "import" | "manual" | "skip";

const CARD_ICONS: Record<AddDataCardKey, string> = {
  connect: ICONS.addData.connect,
  import: ICONS.addData.import,
  manual: ICONS.addData.manual,
  skip: ICONS.addData.skip,
};

export interface AddDataCopy {
  connectTitle: string;
  connectDesc: string;
  importTitle: string;
  importDesc: string;
  manualTitle: string;
  manualDesc: string;
  skipTitle: string;
  skipDesc: string;
}

/** Step 4 — Add data: 4 cards, each routing to a real sub-flow (wired by the parent
 *  flow — connect/import/manual/skip are genuinely distinct destinations here, unlike
 *  the design's stub which jumps every card straight to Done). */
export function AddDataStep({
  th,
  copy,
  onSelect,
}: {
  th: OnboardingTheme;
  copy: AddDataCopy;
  onSelect: (key: AddDataCardKey) => void;
}) {
  const cards: { key: AddDataCardKey; title: string; desc: string }[] = [
    { key: "connect", title: copy.connectTitle, desc: copy.connectDesc },
    { key: "import", title: copy.importTitle, desc: copy.importDesc },
    { key: "manual", title: copy.manualTitle, desc: copy.manualDesc },
    { key: "skip", title: copy.skipTitle, desc: copy.skipDesc },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {cards.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onSelect(c.key)}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 13,
            textAlign: "left",
            width: "100%",
            border: `1px solid ${th.dividerLine}`,
            borderRadius: 14,
            padding: 16,
            background: th.cardBg,
            cursor: "pointer",
            transition: "border-color .15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#0E9F6E")}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = th.dividerLine)}
        >
          <span
            style={{
              width: 36,
              height: 36,
              flexShrink: 0,
              borderRadius: 10,
              background: th.chipBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon d={CARD_ICONS[c.key]} size={17} stroke={th.kicker} />
          </span>
          <span>
            <div style={{ font: "700 14px 'Plus Jakarta Sans'", color: th.headColor }}>
              {c.title}
            </div>
            <div
              style={{
                font: "500 12.5px/1.4 'Plus Jakarta Sans'",
                color: th.subColor,
                marginTop: 2,
              }}
            >
              {c.desc}
            </div>
          </span>
        </button>
      ))}
    </div>
  );
}
