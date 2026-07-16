import { Select } from "@portfolio/web";

export function Currency() {
  return (
    <Select defaultValue="EUR" aria-label="Currency">
      <option value="EUR">EUR — Euro</option>
      <option value="USD">USD — US Dollar</option>
      <option value="IDR">IDR — Indonesian Rupiah</option>
    </Select>
  );
}

export function AssetClass() {
  return (
    <Select defaultValue="equity" aria-label="Asset class">
      <option value="equity">Equities</option>
      <option value="gold">Gold</option>
      <option value="bond">Bonds</option>
      <option value="mutual_fund">Mutual Funds (Reksa Dana)</option>
      <option value="cash">Cash</option>
    </Select>
  );
}

export function TransactionType() {
  return (
    <Select defaultValue="buy" aria-label="Transaction type">
      <option value="buy">Buy</option>
      <option value="sell">Sell</option>
      <option value="dividend">Dividend</option>
      <option value="transfer_in">Transfer in</option>
      <option value="transfer_out">Transfer out</option>
    </Select>
  );
}

export function Disabled() {
  return (
    <Select disabled defaultValue="DE" aria-label="Tax regime">
      <option value="DE">Germany (Abgeltungsteuer)</option>
      <option value="ID">Indonesia (Final Tax)</option>
    </Select>
  );
}
