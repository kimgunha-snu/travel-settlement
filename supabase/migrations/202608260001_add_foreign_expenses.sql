alter table public.settlement_expenses
  add column original_amount numeric,
  add column original_currency text,
  add column exchange_rate numeric,
  add column conversion_method text;

alter table public.settlement_expenses
  add constraint settlement_expenses_original_amount_positive
    check (original_amount is null or original_amount > 0),
  add constraint settlement_expenses_exchange_rate_positive
    check (exchange_rate is null or exchange_rate > 0),
  add constraint settlement_expenses_original_currency_format
    check (original_currency is null or original_currency ~ '^[A-Z]{3}$'),
  add constraint settlement_expenses_conversion_method_valid
    check (conversion_method is null or conversion_method in ('rate', 'actual')),
  add constraint settlement_expenses_foreign_metadata_complete
    check (
      (original_amount is null and original_currency is null and exchange_rate is null and conversion_method is null)
      or
      (original_amount is not null and original_currency is not null and exchange_rate is not null and conversion_method is not null)
    );

create or replace function public.replace_settlement_content_atomic(
  p_settlement_id uuid,
  p_encoded_title text,
  p_members jsonb,
  p_expenses jsonb,
  p_transfers jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $function$
begin
  update public.settlements
  set title = p_encoded_title
  where id = p_settlement_id;

  if not found then
    raise exception 'Settlement % was not found or is not writable', p_settlement_id;
  end if;

  delete from public.settlement_expenses where settlement_id = p_settlement_id;
  delete from public.settlement_transfers where settlement_id = p_settlement_id;
  delete from public.settlement_members where settlement_id = p_settlement_id;

  insert into public.settlement_members (id, settlement_id, name)
  select member_row.id, p_settlement_id, member_row.name
  from jsonb_populate_recordset(
    null::public.settlement_members,
    coalesce(p_members, '[]'::jsonb)
  ) as member_row;

  insert into public.settlement_expenses (
    id,
    settlement_id,
    title,
    amount,
    payer_member_id,
    participant_member_ids,
    original_amount,
    original_currency,
    exchange_rate,
    conversion_method
  )
  select
    expense_row.id,
    p_settlement_id,
    expense_row.title,
    expense_row.amount,
    expense_row.payer_member_id,
    expense_row.participant_member_ids,
    expense_row.original_amount,
    expense_row.original_currency,
    expense_row.exchange_rate,
    expense_row.conversion_method
  from jsonb_populate_recordset(
    null::public.settlement_expenses,
    coalesce(p_expenses, '[]'::jsonb)
  ) as expense_row;

  insert into public.settlement_transfers (
    id,
    settlement_id,
    amount,
    from_member_id,
    to_member_id
  )
  select
    transfer_row.id,
    p_settlement_id,
    transfer_row.amount,
    transfer_row.from_member_id,
    transfer_row.to_member_id
  from jsonb_populate_recordset(
    null::public.settlement_transfers,
    coalesce(p_transfers, '[]'::jsonb)
  ) as transfer_row;
end;
$function$;

revoke all on function public.replace_settlement_content_atomic(uuid, text, jsonb, jsonb, jsonb) from public;
grant execute on function public.replace_settlement_content_atomic(uuid, text, jsonb, jsonb, jsonb) to anon, authenticated;
