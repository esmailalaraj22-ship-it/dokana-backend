-- Shop Ledger PostgreSQL v1.0.0 runtime/integration tests
-- Run after 01..05 as a PostgreSQL administrative test user.
-- The script rolls back all test data.

BEGIN;

CREATE SCHEMA IF NOT EXISTS test_shop_ledger;
DROP TABLE IF EXISTS test_shop_ledger.results;
CREATE TABLE test_shop_ledger.results (
    id bigint GENERATED ALWAYS AS IDENTITY,
    test_name text NOT NULL,
    passed boolean NOT NULL,
    details text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION test_shop_ledger.ok(p_name text, p_condition boolean, p_details text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO test_shop_ledger.results(test_name, passed, details)
    VALUES (p_name, COALESCE(p_condition,false), p_details);
END;
$$;

CREATE OR REPLACE FUNCTION test_shop_ledger.expect_error(
    p_name text,
    p_sql text,
    p_expected_state text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    got_state text;
    got_message text;
BEGIN
    BEGIN
        EXECUTE p_sql;
        PERFORM test_shop_ledger.ok(p_name, false, 'Expected an error but statement succeeded');
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS got_state = RETURNED_SQLSTATE, got_message = MESSAGE_TEXT;
        PERFORM test_shop_ledger.ok(
            p_name,
            p_expected_state IS NULL OR got_state = p_expected_state,
            concat('SQLSTATE=', got_state, '; ', got_message)
        );
    END;
END;
$$;

GRANT USAGE ON SCHEMA test_shop_ledger TO shop_app_runtime;
GRANT SELECT, INSERT ON test_shop_ledger.results TO shop_app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA test_shop_ledger TO shop_app_runtime;
GRANT EXECUTE ON FUNCTION test_shop_ledger.ok(text,boolean,text) TO shop_app_runtime;

-- Fixed IDs make the tests deterministic.
SELECT set_config('app.user_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
SELECT set_config('app.request_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaab', false);
SELECT set_config('app.audit_reason', 'automated runtime test', false);

-- Store 1 seed.
SELECT set_config('app.store_id', '10000000-0000-0000-0000-000000000001', false);
SELECT set_config('app.device_id', '10000000-0000-0000-0000-000000000002', false);

INSERT INTO ledger.stores(id,name,currency_code,status)
VALUES ('10000000-0000-0000-0000-000000000001','Test Store 1','ILS','active');

INSERT INTO ledger.devices(id,store_id,device_name,platform,installation_id,device_prefix,status)
VALUES (
 '10000000-0000-0000-0000-000000000002',
 '10000000-0000-0000-0000-000000000001',
 'Test Android','android','10000000-0000-0000-0000-000000000099','T1','active'
);

INSERT INTO ledger.app_settings(store_id, timezone_name, business_day_start_minutes, business_day_end_minutes, business_day_mode)
VALUES ('10000000-0000-0000-0000-000000000001','Asia/Hebron',720,720,'fixed_24h');

INSERT INTO ledger.accounting_periods(
 id,store_id,period_year,period_month,starts_at,ends_at,status,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000003',
 '10000000-0000-0000-0000-000000000001',
 2026,7,'2026-07-01T00:00:00Z','2026-08-01T00:00:00Z','open',
 '10000000-0000-0000-0000-000000000002',
 '10000000-0000-0000-0000-000000000004'
);

INSERT INTO ledger.customers(
 id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000030','10000000-0000-0000-0000-000000000001',
 'أحمد','احمد','0599000000','0599000000','active',
 '10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000031'
);

INSERT INTO ledger.suppliers(
 id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000032','10000000-0000-0000-0000-000000000001',
 'Supplier','supplier','0599111111','0599111111','active',
 '10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000033'
);

INSERT INTO ledger.products(
 id,store_id,name,normalized_name,sku,measurement_type,track_inventory,is_pinned,status,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000001',
 'Test Product','test product','SKU-1','count',true,true,'active',
 '10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000012'
);

INSERT INTO ledger.product_units(
 id,store_id,product_id,measurement_type,unit_name,unit_code,is_base,factor_num,factor_den,
 sale_price_minor,purchase_price_minor,status,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000011','10000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000010','count','قطعة','pc',true,1,1,1000,500,'active',
 '10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000013'
);

INSERT INTO ledger.money_accounts(
 id,store_id,name,normalized_name,account_type,availability,is_default,status,device_id,operation_id
) VALUES
 ('10000000-0000-0000-0000-000000000020','10000000-0000-0000-0000-000000000001','Cash','cash','cash','available',true,'active','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000022'),
 ('10000000-0000-0000-0000-000000000021','10000000-0000-0000-0000-000000000001','Bank','bank','transfer','available',false,'active','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000023');

-- Opening inventory: 100 pieces, cost 5.00 ILS each.
INSERT INTO ledger.inventory_movements(
 id,store_id,product_id,accounting_period_id,movement_type,
 quantity_before_milli,quantity_delta_milli,quantity_after_milli,
 inventory_value_before_minor,value_delta_minor,inventory_value_after_minor,
 average_unit_cost_after_minor,cost_status,has_pending_cost_after,
 reference_type,reference_id,transaction_group_id,occurred_at,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000050','10000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000003',
 'opening_balance',0,100000,100000,0,50000,50000,500,'known',false,
 'opening_balance','10000000-0000-0000-0000-000000000051','10000000-0000-0000-0000-000000000052',
 '2026-07-01T08:00:00Z','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000053'
);

SELECT test_shop_ledger.ok(
 'Opening stock cache updated',
 (SELECT quantity_milli = 100000 AND inventory_value_minor = 50000
  FROM ledger.stock_balances
  WHERE store_id='10000000-0000-0000-0000-000000000001'
    AND product_id='10000000-0000-0000-0000-000000000010'),
 NULL
);

-- Test stale stock snapshot.
SELECT test_shop_ledger.expect_error(
 'Stale inventory snapshot rejected',
 $q$INSERT INTO ledger.inventory_movements(
 id,store_id,product_id,accounting_period_id,movement_type,
 quantity_before_milli,quantity_delta_milli,quantity_after_milli,
 inventory_value_before_minor,value_delta_minor,inventory_value_after_minor,
 average_unit_cost_after_minor,cost_status,has_pending_cost_after,
 reference_type,reference_id,transaction_group_id,occurred_at,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000054','10000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000003',
 'adjustment_out',0,-1000,-1000,0,-500,-500,500,'known',false,
 'test','10000000-0000-0000-0000-000000000055','10000000-0000-0000-0000-000000000056',
 '2026-07-02T08:00:00Z','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000057'
)$q$,
 '40001'
);

-- A mixed-payment sale: 4.00 cash + 6.00 bank.
INSERT INTO ledger.sales(
 id,store_id,customer_id,accounting_period_id,display_number,sale_at,
 items_subtotal_minor,line_discount_total_minor,invoice_discount_minor,rounding_minor,
 total_minor,paid_total_minor,credit_total_minor,known_cost_total_minor,
 pending_cost_line_count,unknown_cost_line_count,payment_status,status,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000040','10000000-0000-0000-0000-000000000001',NULL,
 '10000000-0000-0000-0000-000000000003','S-2026-000001','2026-07-31T08:00:00Z',
 1000,0,0,0,1000,1000,0,500,0,0,'paid','draft',
 '10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000041'
);

INSERT INTO ledger.inventory_movements(
 id,store_id,product_id,accounting_period_id,movement_type,
 quantity_before_milli,quantity_delta_milli,quantity_after_milli,
 inventory_value_before_minor,value_delta_minor,inventory_value_after_minor,
 average_unit_cost_after_minor,cost_status,has_pending_cost_after,
 reference_type,reference_id,transaction_group_id,occurred_at,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000042','10000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000003',
 'sale',100000,-1000,99000,50000,-500,49500,500,'known',false,
 'sale','10000000-0000-0000-0000-000000000040','10000000-0000-0000-0000-000000000043',
 '2026-07-31T08:00:00Z','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000044'
);

INSERT INTO ledger.sale_items(
 id,store_id,sale_id,product_id,product_unit_id,is_manual_line,product_name_snapshot,unit_name_snapshot,
 quantity_milli,conversion_factor_num,conversion_factor_den,base_quantity_milli,
 unit_price_minor,line_gross_minor,line_discount_minor,rounding_minor,line_total_minor,
 cost_status,unit_cost_minor,line_cost_minor,inventory_movement_id
) VALUES (
 '10000000-0000-0000-0000-000000000045','10000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000040','10000000-0000-0000-0000-000000000010',
 '10000000-0000-0000-0000-000000000011',false,'Test Product','قطعة',
 1000,1,1,1000,1000,1000,0,0,1000,'known',500,500,
 '10000000-0000-0000-0000-000000000042'
);

INSERT INTO ledger.money_movements(
 id,store_id,account_id,accounting_period_id,movement_type,amount_delta_minor,
 reference_type,reference_id,transaction_group_id,occurred_at,device_id,operation_id
) VALUES
 ('10000000-0000-0000-0000-000000000046','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000020','10000000-0000-0000-0000-000000000003','sale_payment',400,'sale','10000000-0000-0000-0000-000000000040','10000000-0000-0000-0000-000000000043','2026-07-31T08:00:00Z','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000047'),
 ('10000000-0000-0000-0000-000000000048','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000021','10000000-0000-0000-0000-000000000003','sale_payment',600,'sale','10000000-0000-0000-0000-000000000040','10000000-0000-0000-0000-000000000043','2026-07-31T08:00:00Z','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000049');

INSERT INTO ledger.sale_payments(id,store_id,sale_id,money_account_id,amount_minor,payment_at,money_movement_id)
VALUES
 ('10000000-0000-0000-0000-000000000060','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000040','10000000-0000-0000-0000-000000000020',400,'2026-07-31T08:00:00Z','10000000-0000-0000-0000-000000000046'),
 ('10000000-0000-0000-0000-000000000061','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000040','10000000-0000-0000-0000-000000000021',600,'2026-07-31T08:00:00Z','10000000-0000-0000-0000-000000000048');

UPDATE ledger.sales SET status='posted' WHERE id='10000000-0000-0000-0000-000000000040';

SELECT test_shop_ledger.ok(
 'Mixed payment sale posted',
 (SELECT status='posted' FROM ledger.sales WHERE id='10000000-0000-0000-0000-000000000040'),
 NULL
);
SELECT test_shop_ledger.ok(
 'Cash account received mixed portion',
 (SELECT balance_minor=400 FROM ledger.v_money_account_balances WHERE account_id='10000000-0000-0000-0000-000000000020'),
 NULL
);
SELECT test_shop_ledger.ok(
 'Bank account received mixed portion',
 (SELECT balance_minor=600 FROM ledger.v_money_account_balances WHERE account_id='10000000-0000-0000-0000-000000000021'),
 NULL
);

-- Child rows become immutable after posting.
SELECT test_shop_ledger.expect_error(
 'Posted sale items cannot be changed',
 $$UPDATE ledger.sale_items SET quantity_milli=2000 WHERE id='10000000-0000-0000-0000-000000000045'$$,
 '55000'
);

-- Append-only money movement.
SELECT test_shop_ledger.expect_error(
 'Money movement is append-only',
 $$UPDATE ledger.money_movements SET amount_delta_minor=401 WHERE id='10000000-0000-0000-0000-000000000046'$$,
 '55000'
);

-- Negative stock rejection.
SELECT test_shop_ledger.expect_error(
 'Negative stock rejected',
 $q$INSERT INTO ledger.inventory_movements(
 id,store_id,product_id,accounting_period_id,movement_type,
 quantity_before_milli,quantity_delta_milli,quantity_after_milli,
 inventory_value_before_minor,value_delta_minor,inventory_value_after_minor,
 average_unit_cost_after_minor,cost_status,has_pending_cost_after,
 reference_type,reference_id,transaction_group_id,occurred_at,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000062','10000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000003',
 'adjustment_out',99000,-100000,-1000,49500,-50000,-500,500,'known',false,
 'test','10000000-0000-0000-0000-000000000063','10000000-0000-0000-0000-000000000064',
 '2026-07-31T09:00:00Z','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000065'
)$q$,
 '23514'
);

-- Unique active cash account.
SELECT test_shop_ledger.expect_error(
 'Only one active cash account per store',
 $q$INSERT INTO ledger.money_accounts(
 id,store_id,name,normalized_name,account_type,availability,is_default,status,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000066','10000000-0000-0000-0000-000000000001',
 'Cash 2','cash 2','cash','available',false,'active',
 '10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000067'
)$q$,
 '23505'
);

-- Overlapping periods.
SELECT test_shop_ledger.expect_error(
 'Overlapping accounting period rejected',
 $q$INSERT INTO ledger.accounting_periods(
 id,store_id,period_year,period_month,starts_at,ends_at,status,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000068','10000000-0000-0000-0000-000000000001',
 2026,8,'2026-07-15T00:00:00Z','2026-08-15T00:00:00Z','open',
 '10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000069'
)$q$,
 '23P01'
);

-- Idempotency claim.
SELECT test_shop_ledger.ok(
 'First operation claim succeeds',
 sync.claim_operation(
  '10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000070',
  '10000000-0000-0000-0000-000000000002','sale','10000000-0000-0000-0000-000000000040','post','hash-a'
 ), NULL
);
SELECT test_shop_ledger.ok(
 'Duplicate identical operation is idempotent',
 NOT sync.claim_operation(
  '10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000070',
  '10000000-0000-0000-0000-000000000002','sale','10000000-0000-0000-0000-000000000040','post','hash-a'
 ), NULL
);
SELECT test_shop_ledger.expect_error(
 'Operation ID reuse with different payload rejected',
 $$SELECT sync.claim_operation(
  '10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000070',
  '10000000-0000-0000-0000-000000000002','sale','10000000-0000-0000-0000-000000000040','post','hash-b'
 )$$,
 '23505'
);

-- Readable sequence allocation.
SELECT test_shop_ledger.ok(
 'Document sequence increments',
 ledger.next_document_number(
   '10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','sale',2026,'S'
 ) = 'S-2026-000001'
 AND ledger.next_document_number(
   '10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','sale',2026,'S'
 ) = 'S-2026-000002', NULL
);

-- Store 2 for tenant isolation tests.
SELECT set_config('app.store_id', '20000000-0000-0000-0000-000000000001', false);
SELECT set_config('app.device_id', '20000000-0000-0000-0000-000000000002', false);
INSERT INTO ledger.stores(id,name,currency_code,status)
VALUES ('20000000-0000-0000-0000-000000000001','Test Store 2','ILS','active');
INSERT INTO ledger.devices(id,store_id,device_name,platform,installation_id,device_prefix,status)
VALUES ('20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','Other Device','android','20000000-0000-0000-0000-000000000099','T2','active');
INSERT INTO ledger.customers(id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id)
VALUES ('20000000-0000-0000-0000-000000000030','20000000-0000-0000-0000-000000000001','Other','other','0599222222','0599222222','active','20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000031');

-- Composite FK prevents cross-store references independent of RLS.
SELECT set_config('app.store_id', '10000000-0000-0000-0000-000000000001', false);
SELECT set_config('app.device_id', '10000000-0000-0000-0000-000000000002', false);
SELECT test_shop_ledger.expect_error(
 'Cross-store device reference rejected',
 $q$INSERT INTO ledger.customers(id,store_id,name,normalized_name,phone,normalized_phone,status,device_id,operation_id)
 VALUES ('10000000-0000-0000-0000-000000000080','10000000-0000-0000-0000-000000000001','Bad','bad','0599333333','0599333333','active','20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000081')$q$,
 '23503'
);

-- RLS test under runtime role (superuser test runner may SET ROLE).
SET LOCAL ROLE shop_app_runtime;
SELECT set_config('app.store_id', '10000000-0000-0000-0000-000000000001', true);
SELECT test_shop_ledger.ok(
 'RLS hides another store customers',
 (SELECT count(*)=0 FROM ledger.customers WHERE store_id='20000000-0000-0000-0000-000000000001'),
 NULL
);
RESET ROLE;

-- Close the period and verify new movements are blocked.
SELECT set_config('app.store_id', '10000000-0000-0000-0000-000000000001', false);
UPDATE ledger.accounting_periods
SET status='closed'
WHERE id='10000000-0000-0000-0000-000000000003';

SELECT test_shop_ledger.expect_error(
 'Closed period blocks money movement',
 $q$INSERT INTO ledger.money_movements(
 id,store_id,account_id,accounting_period_id,movement_type,amount_delta_minor,
 reference_type,reference_id,transaction_group_id,occurred_at,device_id,operation_id
) VALUES (
 '10000000-0000-0000-0000-000000000090','10000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000020','10000000-0000-0000-0000-000000000003',
 'other',1,'test','10000000-0000-0000-0000-000000000091','10000000-0000-0000-0000-000000000092',
 '2026-07-31T10:00:00Z','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000093'
)$q$,
 '55000'
);

SELECT test_shop_ledger.expect_error(
 'Closed period cannot reopen',
 $$UPDATE ledger.accounting_periods SET status='open' WHERE id='10000000-0000-0000-0000-000000000003'$$,
 '55000'
);

-- Change events generated for synchronized aggregate roots.
SELECT test_shop_ledger.ok(
 'Central change feed has events',
 (SELECT count(*) > 0 FROM sync.change_events WHERE store_id='10000000-0000-0000-0000-000000000001'),
 NULL
);
SELECT test_shop_ledger.ok(
 'Change-event cursors are strictly positive',
 (SELECT min(cursor) > 0 FROM sync.change_events),
 NULL
);

TABLE test_shop_ledger.results ORDER BY id;

DO $$
DECLARE failed_count integer;
BEGIN
    SELECT count(*) INTO failed_count FROM test_shop_ledger.results WHERE passed = false;
    IF failed_count > 0 THEN
        RAISE EXCEPTION '% runtime tests failed', failed_count;
    END IF;
END;
$$;

ROLLBACK;
