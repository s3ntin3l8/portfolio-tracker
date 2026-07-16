import { Switch } from "@portfolio/web";

export function Default() {
  return (
    <div className="flex items-center gap-2">
      <Switch id="cash-counted" />
      <label htmlFor="cash-counted" className="text-sm font-medium">
        Include cash in portfolio boundary
      </label>
    </div>
  );
}

export function States() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Switch defaultChecked />
        <span className="text-sm font-medium">Dividend reinvestment (saveback)</span>
      </div>
      <div className="flex items-center gap-2">
        <Switch defaultChecked={false} />
        <span className="text-sm font-medium">Auto-sync Interactive Brokers</span>
      </div>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Switch disabled />
        <span className="text-sm font-medium">Indonesian final-tax regime</span>
      </div>
      <div className="flex items-center gap-2">
        <Switch disabled defaultChecked />
        <span className="text-sm font-medium">Two-factor authentication</span>
      </div>
    </div>
  );
}
