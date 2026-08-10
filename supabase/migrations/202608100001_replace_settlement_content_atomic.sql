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
    participant_member_ids
  )
  select
    expense_row.id,
    p_settlement_id,
    expense_row.title,
    expense_row.amount,
    expense_row.payer_member_id,
    expense_row.participant_member_ids
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
