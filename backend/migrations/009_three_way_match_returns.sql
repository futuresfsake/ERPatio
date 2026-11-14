-- Up Migration

ALTER TABLE items ADD COLUMN reorder_level numeric(19,4) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0);

ALTER TABLE tenant_settings ADD COLUMN sales_account_id uuid;
ALTER TABLE tenant_settings ADD FOREIGN KEY (tenant_id, sales_account_id) REFERENCES accounts (tenant_id, id);
UPDATE tenant_settings s SET sales_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '4000');

-- How much of each order line has been billed (purchases) or invoiced (sales). Counted at posting, released on void.
ALTER TABLE purchase_order_lines ADD COLUMN billed_qty numeric(19,4) NOT NULL DEFAULT 0;
ALTER TABLE purchase_order_lines ADD CONSTRAINT po_billed_within_received CHECK (billed_qty >= 0 AND billed_qty <= received_qty);
ALTER TABLE sales_order_lines ADD COLUMN invoiced_qty numeric(19,4) NOT NULL DEFAULT 0;
ALTER TABLE sales_order_lines ADD CONSTRAINT so_invoiced_within_delivered CHECK (invoiced_qty >= 0 AND invoiced_qty <= delivered_qty);

-- A document line can point at the order line it was made from.
ALTER TABLE document_lines ADD COLUMN po_line_id uuid, ADD COLUMN so_line_id uuid;
ALTER TABLE document_lines
  ADD FOREIGN KEY (tenant_id, po_line_id) REFERENCES purchase_order_lines (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, so_line_id) REFERENCES sales_order_lines (tenant_id, id),
  ADD CHECK (po_line_id IS NULL OR so_line_id IS NULL);

-- Returns are stock movements too.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
            AND (pg_get_constraintdef(oid) LIKE '%adjust_in%') LOOP
    EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN ('receipt', 'issue', 'adjust_in', 'adjust_out', 'return_in', 'return_out'));
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_sign_check CHECK (
  (kind IN ('receipt', 'adjust_in', 'return_in') AND qty > 0 AND value >= 0) OR (kind IN ('issue', 'adjust_out', 'return_out') AND qty < 0 AND value <= 0));

-- Down Migration

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_sign_check;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_kind_check;
ALTER TABLE stock_movements DISABLE TRIGGER USER;
DELETE FROM stock_movements WHERE kind IN ('return_in', 'return_out');
ALTER TABLE stock_movements ENABLE TRIGGER USER;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check CHECK (kind IN ('receipt', 'issue', 'adjust_in', 'adjust_out'));
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_sign_check CHECK (
  (kind IN ('receipt', 'adjust_in') AND qty > 0 AND value >= 0) OR (kind IN ('issue', 'adjust_out') AND qty < 0 AND value <= 0));
ALTER TABLE document_lines DROP COLUMN IF EXISTS so_line_id, DROP COLUMN IF EXISTS po_line_id;
ALTER TABLE sales_order_lines DROP COLUMN IF EXISTS invoiced_qty;
ALTER TABLE purchase_order_lines DROP COLUMN IF EXISTS billed_qty;
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS sales_account_id;
ALTER TABLE items DROP COLUMN IF EXISTS reorder_level;
