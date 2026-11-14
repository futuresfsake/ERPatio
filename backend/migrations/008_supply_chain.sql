-- Up Migration

-- Accounts the stock postings use. Existing workspaces get them here; new ones at provisioning.
INSERT INTO accounts (tenant_id, code, name, type)
SELECT t.id, v.code, v.name, v.type FROM tenants t
  CROSS JOIN (VALUES ('2050', 'Goods Received Not Invoiced', 'liability'), ('5100', 'Inventory Adjustments', 'expense')) v(code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = v.code);

ALTER TABLE tenant_settings ADD COLUMN inventory_account_id uuid, ADD COLUMN cogs_account_id uuid,
  ADD COLUMN grni_account_id uuid, ADD COLUMN adjustment_account_id uuid;
ALTER TABLE tenant_settings
  ADD FOREIGN KEY (tenant_id, inventory_account_id) REFERENCES accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, cogs_account_id) REFERENCES accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, grni_account_id) REFERENCES accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, adjustment_account_id) REFERENCES accounts (tenant_id, id);
UPDATE tenant_settings s SET
  inventory_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '1200'),
  cogs_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '5000'),
  grni_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '2050'),
  adjustment_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '5100');

-- Gapless order numbers share the document counter table.
ALTER TABLE doc_counters DROP CONSTRAINT doc_counters_kind_check;
ALTER TABLE doc_counters ADD CONSTRAINT doc_counters_kind_check CHECK (kind IN ('invoice', 'bill', 'po', 'so'));
INSERT INTO doc_counters (tenant_id, kind) SELECT t.id, k.kind FROM tenants t CROSS JOIN (VALUES ('po'), ('so')) k(kind)
  ON CONFLICT DO NOTHING;

CREATE TABLE items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sku varchar(40) NOT NULL CHECK (sku ~ '^[A-Za-z0-9._-]{1,40}$'),
  name varchar(200) NOT NULL,
  uom varchar(20) NOT NULL DEFAULT 'pc',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, sku)
);

-- Quantity and value on hand per item (moving average). Changes only together with a stock movement.
CREATE TABLE item_stock (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  qty numeric(19,4) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  value numeric(19,4) NOT NULL DEFAULT 0 CHECK (value >= 0),
  CHECK (qty > 0 OR value = 0),
  PRIMARY KEY (tenant_id, item_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

-- The stock ledger: append-only, one row per movement, always tied to the journal entry that values it.
CREATE TABLE stock_movements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  move_date date NOT NULL,
  kind varchar(12) NOT NULL CHECK (kind IN ('receipt', 'issue', 'adjust_in', 'adjust_out')),
  qty numeric(19,4) NOT NULL,
  unit_cost numeric(19,4) NOT NULL CHECK (unit_cost >= 0),
  value numeric(19,4) NOT NULL,
  source_type varchar(20) NOT NULL CHECK (source_type IN ('purchase_order', 'sales_order', 'adjustment')),
  source_id uuid,
  note varchar(300),
  journal_entry_id uuid, -- null only for a movement worth nothing, which has no ledger entry
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id),
  CHECK (journal_entry_id IS NOT NULL OR value = 0),
  CHECK ((kind IN ('receipt', 'adjust_in') AND qty > 0 AND value >= 0) OR (kind IN ('issue', 'adjust_out') AND qty < 0 AND value <= 0)),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX ix_movements_item ON stock_movements (tenant_id, item_id, move_date, created_at);
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION block_mutation();

CREATE TABLE purchase_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  po_no bigint,
  party_id uuid NOT NULL,
  order_date date NOT NULL,
  reference varchar(100),
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
  total numeric(19,4) NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, po_no),
  CHECK (status = 'draft' OR po_no IS NOT NULL),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE TABLE purchase_order_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  line_no smallint NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(19,4) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(19,4) NOT NULL CHECK (unit_cost >= 0),
  received_qty numeric(19,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (order_id, line_no),
  CHECK (received_qty >= 0 AND received_qty <= quantity),
  FOREIGN KEY (tenant_id, order_id) REFERENCES purchase_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

CREATE TABLE sales_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  so_no bigint,
  party_id uuid NOT NULL,
  order_date date NOT NULL,
  reference varchar(100),
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
  total numeric(19,4) NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, so_no),
  CHECK (status = 'draft' OR so_no IS NOT NULL),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE TABLE sales_order_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  line_no smallint NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(19,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(19,4) NOT NULL CHECK (unit_price >= 0),
  delivered_qty numeric(19,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (order_id, line_no),
  CHECK (delivered_qty >= 0 AND delivered_qty <= quantity),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

ALTER TABLE items ENABLE ROW LEVEL SECURITY; ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON items USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE item_stock ENABLE ROW LEVEL SECURITY; ALTER TABLE item_stock FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_stock USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY; ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_movements USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY; ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_orders USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_order_lines USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE sales_orders ENABLE ROW LEVEL SECURITY; ALTER TABLE sales_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_orders USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE sales_order_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE sales_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_order_lines USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT, UPDATE ON items, item_stock, purchase_orders, sales_orders TO erpatio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_lines, sales_order_lines TO erpatio_app;
GRANT DELETE ON purchase_orders, sales_orders TO erpatio_app; -- drafts only; the service refuses anything else
GRANT SELECT, INSERT ON stock_movements TO erpatio_app;

-- Down Migration

DROP TABLE IF EXISTS sales_order_lines, sales_orders, purchase_order_lines, purchase_orders, stock_movements, item_stock, items CASCADE;
DELETE FROM doc_counters WHERE kind IN ('po', 'so');
ALTER TABLE doc_counters DROP CONSTRAINT IF EXISTS doc_counters_kind_check;
ALTER TABLE doc_counters ADD CONSTRAINT doc_counters_kind_check CHECK (kind IN ('invoice', 'bill'));
ALTER TABLE tenant_settings DROP COLUMN IF EXISTS adjustment_account_id, DROP COLUMN IF EXISTS grni_account_id,
  DROP COLUMN IF EXISTS cogs_account_id, DROP COLUMN IF EXISTS inventory_account_id;
