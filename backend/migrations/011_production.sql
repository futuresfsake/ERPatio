-- Up Migration

INSERT INTO accounts (tenant_id, code, name, type)
SELECT t.id, v.code, v.name, v.type FROM tenants t
  CROSS JOIN (VALUES ('1210', 'Work in Progress', 'asset'), ('5200', 'Conversion Cost Applied', 'expense'), ('5300', 'Production Variance', 'expense')) v(code, name, type)
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.code = v.code);

ALTER TABLE tenant_settings ADD COLUMN wip_account_id uuid, ADD COLUMN conversion_account_id uuid, ADD COLUMN variance_account_id uuid;
ALTER TABLE tenant_settings
  ADD FOREIGN KEY (tenant_id, wip_account_id) REFERENCES accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, conversion_account_id) REFERENCES accounts (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, variance_account_id) REFERENCES accounts (tenant_id, id);
UPDATE tenant_settings s SET
  wip_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '1210'),
  conversion_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '5200'),
  variance_account_id = (SELECT id FROM accounts a WHERE a.tenant_id = s.tenant_id AND a.code = '5300');

ALTER TABLE doc_counters DROP CONSTRAINT doc_counters_kind_check;
ALTER TABLE doc_counters ADD CONSTRAINT doc_counters_kind_check CHECK (kind IN ('invoice', 'bill', 'po', 'so', 'credit_note', 'debit_note', 'wo'));
INSERT INTO doc_counters (tenant_id, kind) SELECT t.id, 'wo' FROM tenants t ON CONFLICT DO NOTHING;

ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_source_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_source_type_check CHECK (source_type IN ('purchase_order', 'sales_order', 'adjustment', 'work_order'));

-- Bill of materials: a new version replaces the active one; running work orders keep their own snapshot.
CREATE TABLE boms (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  version int NOT NULL CHECK (version >= 1),
  output_qty numeric(19,4) NOT NULL CHECK (output_qty > 0),
  note varchar(300),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, item_id, version),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE UNIQUE INDEX uq_bom_active ON boms (tenant_id, item_id) WHERE is_active;
CREATE TABLE bom_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  bom_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(19,4) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (id), UNIQUE (bom_id, item_id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);
-- A BOM never changes once saved (a change is a new version); only is_active moves.
CREATE FUNCTION bom_lines_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bill of material lines are append-only; create a new version' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER bom_lines_append_only BEFORE UPDATE OR DELETE ON bom_lines FOR EACH ROW EXECUTE FUNCTION bom_lines_frozen();

CREATE TABLE work_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  wo_no bigint,
  item_id uuid NOT NULL,
  bom_id uuid NOT NULL,
  qty_planned numeric(19,4) NOT NULL CHECK (qty_planned > 0),
  qty_completed numeric(19,4) NOT NULL DEFAULT 0,
  planned_date date NOT NULL,
  reference varchar(100),
  status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released', 'completed', 'closed', 'cancelled')),
  -- Materials charged to the order, and what has moved on to finished goods or been written off. WIP = issued - to_goods - written_off.
  materials_issued numeric(19,4) NOT NULL DEFAULT 0,
  materials_to_goods numeric(19,4) NOT NULL DEFAULT 0,
  written_off numeric(19,4) NOT NULL DEFAULT 0,
  conversion_applied numeric(19,4) NOT NULL DEFAULT 0,
  close_entry_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id), UNIQUE (tenant_id, id), UNIQUE (tenant_id, wo_no),
  CHECK (status = 'draft' OR wo_no IS NOT NULL),
  CHECK (qty_completed >= 0 AND qty_completed <= qty_planned),
  CHECK (materials_issued >= 0 AND materials_to_goods >= 0 AND written_off >= 0 AND materials_to_goods + written_off <= materials_issued),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id),
  FOREIGN KEY (tenant_id, bom_id) REFERENCES boms (tenant_id, id),
  FOREIGN KEY (tenant_id, close_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE TABLE work_order_components (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL,
  item_id uuid NOT NULL,
  required_qty numeric(19,4) NOT NULL CHECK (required_qty > 0),
  issued_qty numeric(19,4) NOT NULL DEFAULT 0 CHECK (issued_qty >= 0),
  PRIMARY KEY (id), UNIQUE (order_id, item_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES work_orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id)
);

ALTER TABLE boms ENABLE ROW LEVEL SECURITY; ALTER TABLE boms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON boms USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE bom_lines ENABLE ROW LEVEL SECURITY; ALTER TABLE bom_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bom_lines USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY; ALTER TABLE work_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_orders USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
ALTER TABLE work_order_components ENABLE ROW LEVEL SECURITY; ALTER TABLE work_order_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_order_components USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT, UPDATE ON boms, work_orders, work_order_components TO erpatio_app;
GRANT SELECT, INSERT ON bom_lines TO erpatio_app;
GRANT DELETE ON work_orders TO erpatio_app; -- drafts only; the service refuses anything else

-- Down Migration

DROP TABLE IF EXISTS work_order_components, work_orders, bom_lines, boms CASCADE;
DROP FUNCTION IF EXISTS bom_lines_frozen();
DELETE FROM doc_counters WHERE kind = 'wo';
