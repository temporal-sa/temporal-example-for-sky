import { useEffect, useRef, useState } from 'react';
import { type OrderItem, PRODUCTS, type ProductCode, api, newAccountId } from './api';

interface Props {
  open: boolean;
  // Adds to this customer's portfolio; without one, the order is for a new customer.
  accountId: string | null;
  onClose: () => void;
  onPlaced: (accountId: string, firstLineId?: string) => void;
}

// One order can add several products; each becomes a product line with its own route.
export function NewOrderDialog({ open, accountId, onClose, onPlaced }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [broadband, setBroadband] = useState<ProductCode | ''>('BROADBAND_SUPERFAST');
  const [tv, setTv] = useState(true);
  const [netflix, setNetflix] = useState(true);
  const [placing, setPlacing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setRefusal(null);
      element.showModal();
    }
    if (!open && element.open) element.close();
  }, [open]);

  const items: OrderItem[] = [
    ...(broadband ? [{ type: 'ADD' as const, product: broadband }] : []),
    ...(tv ? [{ type: 'ADD' as const, product: 'SKY_TV' as const }] : []),
    ...(netflix ? [{ type: 'ADD' as const, product: 'NETFLIX' as const }] : []),
  ];

  const place = async (event: React.FormEvent) => {
    event.preventDefault();
    setPlacing(true);
    setRefusal(null);
    const account = accountId ?? newAccountId();
    try {
      const portfolio = await api.placeOrder(account, items);
      onPlaced(account, portfolio.orders.at(-1)?.lineIds[0]);
    } catch (err) {
      setRefusal((err as Error).message);
    } finally {
      setPlacing(false);
    }
  };

  return (
    <dialog ref={dialog} className="modal" aria-labelledby="new-order-heading" onClose={onClose} onCancel={onClose}>
      <form onSubmit={place} className="modal-body">
        <div>
          <p className="eyebrow">{accountId ? `Customer ${accountId}` : 'New customer'}</p>
          <h2 id="new-order-heading">{accountId ? 'Add products' : 'New order'}</h2>
        </div>
        <fieldset className="choices">
          <legend className="small">Broadband</legend>
          {(['', 'BROADBAND_SUPERFAST', 'BB_FIBRE_UNLIMITED_PRO'] as const).map((code) => (
            <label className="choice" key={code || 'none'}>
              <input type="radio" name="broadband" checked={broadband === code} onChange={() => setBroadband(code)} />
              <span>{code ? PRODUCTS[code].name : 'No broadband'}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="choices">
          <legend className="small">Add-ons</legend>
          <label className="choice">
            <input type="checkbox" checked={tv} onChange={(e) => setTv(e.target.checked)} />
            <span>Sky TV (Sky Stream box)</span>
          </label>
          <label className="choice">
            <input type="checkbox" checked={netflix} onChange={(e) => setNetflix(e.target.checked)} />
            <span>Netflix</span>
          </label>
        </fieldset>
        {refusal && (
          <p className="small field-error" role="alert">
            The portfolio refused the order: {refusal}
          </p>
        )}
        <div className="button-row">
          <button type="submit" className="button primary" disabled={placing || items.length === 0}>
            {placing ? 'Placing…' : `Place order (${items.length} ${items.length === 1 ? 'product' : 'products'})`}
          </button>
          <button type="button" className="button ghost" onClick={onClose} disabled={placing}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
