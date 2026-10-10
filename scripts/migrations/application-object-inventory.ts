export const applicationSchemas = ['audit', 'ledger', 'platform', 'sync'] as const;

export const applicationTables = [
  'audit.central_audit_logs',
  'ledger.accounting_periods',
  'ledger.app_settings',
  'ledger.attachments',
  'ledger.audit_logs',
  'ledger.backup_metadata',
  'ledger.customer_ledger_entries',
  'ledger.customer_payment_allocations',
  'ledger.customer_payments',
  'ledger.customers',
  'ledger.devices',
  'ledger.document_sequences',
  'ledger.expense_categories',
  'ledger.expense_payments',
  'ledger.expenses',
  'ledger.goods_receipt_items',
  'ledger.goods_receipts',
  'ledger.inventory_movements',
  'ledger.money_accounts',
  'ledger.money_movements',
  'ledger.money_transfers',
  'ledger.notifications',
  'ledger.owner_ledger_entries',
  'ledger.product_units',
  'ledger.products',
  'ledger.purchase_invoices',
  'ledger.purchase_items',
  'ledger.sale_items',
  'ledger.sale_payments',
  'ledger.sale_return_items',
  'ledger.sale_return_settlements',
  'ledger.sale_returns',
  'ledger.sales',
  'ledger.stock_balances',
  'ledger.stock_count_items',
  'ledger.stock_counts',
  'ledger.stores',
  'ledger.supplier_ledger_entries',
  'ledger.supplier_payment_allocations',
  'ledger.supplier_payments',
  'ledger.supplier_return_items',
  'ledger.supplier_return_settlements',
  'ledger.supplier_returns',
  'ledger.suppliers',
  'platform.admin_actions',
  'platform.auth_sessions',
  'platform.license_issuances',
  'platform.password_reset_tokens',
  'platform.refresh_tokens',
  'platform.server_backups',
  'platform.store_memberships',
  'platform.subscription_plans',
  'platform.subscriptions',
  'platform.users',
  'sync.bootstrap_snapshots',
  'sync.change_events',
  'sync.conflicts',
  'sync.dead_letters',
  'sync.device_cursors',
  'sync.processed_operations',
] as const;

export const applicationSequences = [
  'audit.central_audit_logs_id_seq',
  'platform.license_issuances_license_serial_seq',
  'sync.change_events_cursor_seq',
] as const;

export const applicationViews = [
  'ledger.v_customer_balances',
  'ledger.v_customer_invoice_outstanding',
  'ledger.v_expense_balances',
  'ledger.v_money_account_balances',
  'ledger.v_owner_position',
  'ledger.v_purchase_receipt_progress',
  'ledger.v_sale_profit_quality',
  'ledger.v_store_financial_position',
  'ledger.v_supplier_balances',
  'ledger.v_supplier_invoice_outstanding',
  'sync.v_device_sync_health',
] as const;

export const applicationRoutines = [
  'audit.capture_row_change()',
  'audit.prevent_central_audit_mutation()',
  'ledger.apply_inventory_movement()',
  'ledger.assert_period_open(p_store_id uuid, p_period_id uuid, p_occurred_at timestamp with time zone)',
  'ledger.enforce_period_open()',
  'ledger.ensure_parent_draft()',
  'ledger.guard_accounting_period()',
  'ledger.next_document_number(p_store_id uuid, p_device_id uuid, p_document_type text, p_year integer, p_prefix text)',
  'ledger.prevent_delete()',
  'ledger.prevent_mutation()',
  'ledger.protect_finalized_header()',
  'ledger.touch_mutable_row()',
  'ledger.validate_customer_payment_post()',
  'ledger.validate_expense_payment_post()',
  'ledger.validate_goods_receipt_item_details()',
  'ledger.validate_goods_receipt_post()',
  'ledger.validate_money_transfer_post()',
  'ledger.validate_purchase_status()',
  'ledger.validate_sale_post()',
  'ledger.validate_sale_return_post()',
  'ledger.validate_scaled_line_amount()',
  'ledger.validate_supplier_payment_post()',
  'ledger.validate_supplier_return_post()',
  'platform.current_device_id()',
  'platform.current_request_id()',
  'platform.current_store_id()',
  'platform.current_user_id()',
  'platform.setting_uuid(p_name text)',
  'sync.capture_change_event()',
  'sync.claim_operation(p_store_id uuid, p_operation_id uuid, p_device_id uuid, p_aggregate_type text, p_aggregate_id uuid, p_action text, p_request_hash text)',
] as const;

export const station2MigrationChecksum =
  '35599c1e9c98d9486b83cf19de6925710c0dfbe815c11bf7abfd07a445a10f4e';

export const station2ContextFunctions = [
  'platform.current_store_id()',
  'platform.current_user_id()',
  'platform.current_device_id()',
  'platform.current_request_id()',
] as const;

export const ownershipFoundationAdditions = ['platform.schema_migrations'] as const;

export const platformAuthorityFoundationTables = ['platform.platform_admin_assignments'] as const;

export const platformAuthorityFoundationRoutines = [
  'ledger.current_actor_is_platform_admin()',
  'ledger.lock_effective_entitlement(p_store_id uuid)',
] as const;

export const subscriptionLifecycleProvisioningRoutines = [
  'ledger.manage_subscription_lifecycle(p_store_id uuid, p_action text, p_operation_id uuid, p_request_hash text, p_reason text)',
  'ledger.provision_store_identity(p_store_id uuid, p_owner_user_id uuid, p_store_name text, p_store_phone text, p_operation_id uuid, p_request_hash text, p_reason text, p_activate_subscription boolean)',
  'ledger.read_store_provisioning_state(p_store_id uuid)',
  'ledger.read_subscription_history(p_store_id uuid)',
  'ledger.read_subscription_lifecycle(p_store_id uuid)',
] as const;

export const platformAdminStoreLifecycleRoutines = [
  'ledger.list_platform_stores(p_after_created_at timestamp with time zone, p_after_store_id uuid, p_limit integer)',
  'ledger.manage_store_lifecycle(p_store_id uuid, p_action text, p_expected_version bigint, p_operation_id uuid, p_request_hash text, p_reason text)',
  'ledger.read_store_admin_history(p_store_id uuid, p_after_occurred_at timestamp with time zone, p_after_action_id uuid, p_limit integer)',
] as const;

export const offlineLicenseAuthorityRoutines = [
  'ledger.complete_offline_license(p_store_id uuid, p_license_id uuid, p_operation_id uuid, p_request_hash text, p_signature text)',
  'ledger.list_offline_licenses(p_store_id uuid, p_limit integer)',
  'ledger.prepare_offline_license(p_store_id uuid, p_device_id uuid, p_license_id uuid, p_operation_id uuid, p_request_hash text, p_key_id text)',
  'ledger.read_offline_license_for_validation(p_store_id uuid, p_device_id uuid, p_license_id uuid)',
  'ledger.revoke_offline_license(p_store_id uuid, p_license_id uuid, p_operation_id uuid, p_request_hash text, p_reason text)',
] as const;

export const commitOrderedSyncFoundationTables = [
  'sync.store_change_events_v1',
  'sync.store_change_watermarks_v1',
] as const;

export const commitOrderedSyncFoundationRoutines = [
  'sync.allocate_store_change_sequence_v1(p_store_id uuid)',
  'sync.capture_store_change_v1()',
  'sync.read_bootstrap_boundary_v1(p_store_id uuid, p_device_id uuid)',
  'sync.read_store_change_page_v1(p_store_id uuid, p_after_sequence bigint, p_limit integer)',
  'sync.sanitize_bootstrap_record_v1(p_value jsonb)',
] as const;

export const offlineOperationPushTables = ['sync.offline_operation_provenance_v1'] as const;

export const offlineOperationPushRoutines = [
  'ledger.lock_business_write_authority_v1(p_store_id uuid, p_operation_id uuid, p_operation_type text)',
  'sync.begin_offline_operation_v1(p_store_id uuid, p_device_id uuid, p_operation_id uuid, p_operation_type text, p_local_sequence bigint, p_provenance_hash text, p_license_id uuid, p_subscription_id uuid, p_subscription_version bigint, p_client_recorded_at timestamp with time zone, p_trusted_server_time timestamp with time zone, p_observed_device_time timestamp with time zone, p_clock_state text, p_known_store_status text, p_known_store_status_at timestamp with time zone, p_dependency_operation_ids uuid[])',
  'sync.finish_offline_operation_v1(p_store_id uuid, p_operation_id uuid, p_disposition text, p_response_body jsonb)',
  'sync.offline_operation_finished_at_commit_v1()',
] as const;
