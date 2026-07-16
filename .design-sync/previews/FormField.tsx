import { FormField, Input, Select } from "@portfolio/web";

export function PortfolioName() {
  return (
    <FormField id="portfolio-name" label="Portfolio name">
      <Input id="portfolio-name" placeholder="e.g. Retirement (Tagesgeld)" />
    </FormField>
  );
}

export function CurrencySelect() {
  return (
    <FormField id="portfolio-currency" label="Base currency">
      <Select id="portfolio-currency" defaultValue="EUR">
        <option value="EUR">EUR — Euro</option>
        <option value="USD">USD — US Dollar</option>
        <option value="IDR">IDR — Indonesian Rupiah</option>
      </Select>
    </FormField>
  );
}

export function AmountInput() {
  return (
    <FormField id="tx-amount" label="Amount (EUR)">
      <Input id="tx-amount" type="number" placeholder="0.00" defaultValue="1,250.00" />
    </FormField>
  );
}

export function FormLayout() {
  return (
    <div className="flex flex-col gap-4">
      <FormField id="holder-name" label="Account holder">
        <Input id="holder-name" placeholder="Full name" />
      </FormField>
      <FormField id="holder-allowance" label="Freistellungsauftrag (annual)">
        <Input id="holder-allowance" type="number" defaultValue="1000" />
      </FormField>
    </div>
  );
}
