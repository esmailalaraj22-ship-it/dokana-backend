# Store Settings and Operational-Time Contract v1 — Addendum A

This addendum records two explicit backend-owner decisions made during the
Station 7 / Task 7.2 revision. It amends, and is read together with, the frozen
[store-settings-operational-time-v1](store-settings-operational-time-v1.md). It
does not rewrite the frozen contract's historical text and introduces no new
mutable settings behavior. Where this addendum and the frozen contract differ on
the two points below, this addendum is authoritative for Station 7 MVP.

Scope: Station 7 operational settings only. Nothing here weakens any accounting,
inventory, settlement, period, or audit invariant of any other domain or future
Station.

## A. Settings Audit Evidence (clarifies frozen Section 10)

The frozen contract Section 10 can be read as requiring a central audit effect
for settings stronger than the existing physical database can produce without a
database change. For the current MVP the backend owner decides:

- For Station 7 operational settings, the acceptable mutation evidence is the
  immutable `sync.change_events` feed plus `sync.processed_operations`, together
  with any permitted application-level audit evidence, all written inside the
  successful mutation transaction.
- This evidence is application/operational evidence. It is **not** claimed to be
  equivalent to the compromise-resistant `audit.central_audit_logs`.
- Station 7 settings therefore require **no** new PostgreSQL audit trigger,
  function, grant, or other audit infrastructure.
- Settings are configuration, not posted financial or inventory facts. This
  decision does not reduce audit requirements for posted accounting workflows and
  does not imply central audit is unnecessary elsewhere in Dokana.
- Stronger, compromise-resistant central settings audit remains deferred
  technical hardening (see `docs/technical-debt/Dokana_Deferred_Technical_Notes.md`,
  S7-DT-02).

## B. Device-Local URI Fields in the Generic Change Event (clarifies frozen Sections 4.2 and 10)

The frozen contract states the device-local directory URIs are "excluded from
... change-event payloads." The existing physical trigger
`sync.capture_change_event()` serializes the entire `app_settings` row with
`to_jsonb(NEW)`, so the payload physically contains the URI keys even when their
values are NULL. To describe reality accurately, the backend owner decides:

- `export_directory_uri` and `attachments_directory_uri` are device-local.
- Central application code must never write a non-NULL value into these columns.
- Station 7 public read models must not expose them, and Station 7 mutation
  commands must not accept them.
- Central PostgreSQL values are expected to remain NULL, so a generic change
  event that physically contains these keys with NULL values is acceptable for
  the MVP because no device-local path data is present.
- The accurate statement is: _URI values are prohibited from central application
  writes; current generic events may physically contain NULL URI keys._ It is
  not accurate to say the URI fields are physically absent from change events.
- Hard future application invariant: Station 7 and other central application
  paths must never populate these device-local PostgreSQL fields.
- Final shared-Sync payload filtering and sanitization belong to Station 19 (see
  S7-DT-03). This addendum changes no trigger and modifies no database object.

If live inspection ever finds a non-NULL central URI value, initialization/write
work must stop and report it rather than erasing it or altering the trigger. At
Task 7.2 revision time the live table held zero rows and zero non-NULL URI
values.
